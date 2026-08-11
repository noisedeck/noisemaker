/**
 * WebGL 2 Backend Implementation
 */

import { Backend } from '../backend.js'
import { FrameExportQueue } from '../frame-export.js'
import {
    DEFAULT_VERTEX_SHADER,
    FULLSCREEN_TRIANGLE_POSITIONS,
    FULLSCREEN_TRIANGLE_VERTEX_COUNT
} from '../default-shaders.js'
import { WebGL2FrameExportAdapter } from './webgl2-frame-export.js'

// How many frames after a program compile or render-target (re)allocation
// keep per-pass gl.getError() checks enabled. gl.getError() forces a
// synchronous CPU/GPU round trip, so calling it per pass on every frame turns
// GPU load into main-thread stalls (hundreds of ms of event-loop lag under
// heavy shaders). Real GL errors surface on the first frames after new GLSL
// or new allocations hit the driver, so checking is armed only for a short
// window after each compile/allocation and skipped in steady state.
const GL_ERROR_CHECK_FRAMES = 3

export class WebGL2Backend extends Backend {
    constructor(context, canvas) {
        super(context)
        this.gl = context
        this.canvas = canvas || context.canvas || null
        this.isContextLost = false
        this.fbos = new Map() // texture_id -> framebuffer
        this.depthBuffers = new Map() // fbo -> depth renderbuffer (for mesh rendering)
        this.fullscreenVAO = null
        this.presentProgram = null
        this.maxTextureUnits = 16
        // Frames remaining with per-pass GL error checking armed (see
        // GL_ERROR_CHECK_FRAMES). Re-armed by compileProgram() and
        // createTexture(), decremented once per frame in endFrame().
        this.glErrorCheckFrames = 0
        // Per-frame snapshot of the armed state, latched in beginFrame() so
        // executePass() and present() agree within a frame — present() runs
        // after endFrame()'s decrement in Pipeline.render(), and reading the
        // live counter there would silently skip the last armed frame.
        this._glCheckThisFrame = false

        // Pre-allocated typed arrays for uniform setting (avoids per-frame allocations)
        this._vec2Buf = new Float32Array(2)
        this._vec3Buf = new Float32Array(3)
        this._vec4Buf = new Float32Array(4)
        this._mergedUniforms = {}
        this._mergedUniformKeys = []
        this._packedUniformBuffer = new ArrayBuffer(512)
        this._packedUniformView = new DataView(this._packedUniformBuffer)
        this._packedUniformBytes = new Uint8Array(this._packedUniformBuffer)
    }

    createFrameExportQueue(options = {}) {
        return new FrameExportQueue(new WebGL2FrameExportAdapter(this), options)
    }

    /**
     * Detect if running on a mobile device.
     * Uses user agent and touch capability as heuristics.
     * @returns {boolean}
     */
    static detectMobile() {
        if (typeof navigator === 'undefined') return false
        const ua = navigator.userAgent || ''
        // Check for mobile user agents
        if (/iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
            return true
        }
        // Also check for touch-primary devices with small screens
        if (typeof window !== 'undefined' && 'ontouchstart' in window) {
            // Touch device with screen width suggesting mobile/tablet
            return window.screen.width <= 1024
        }
        return false
    }

    /**
     * Parse a texture ID to extract the global surface name.
     * Supports both "global_name" and "globalName" patterns.
     * Returns null if not a global, otherwise returns the surface name.
     */
    parseGlobalName(texId) {
        if (typeof texId !== 'string') return null

        // Pattern 1: "global_name" (underscore separator)
        if (texId.startsWith('global_')) {
            return texId.replace('global_', '')
        }

        // Pattern 2: "globalName" (camelCase)
        if (texId.startsWith('global') && texId.length > 6) {
            const suffix = texId.slice(6)
            // Check it's actually camelCase (next char is uppercase or digit)
            if (/^[A-Z0-9]/.test(suffix)) {
                // Convert to surface name: "FlowState" → "flowState"
                return suffix.charAt(0).toLowerCase() + suffix.slice(1)
            }
        }

        return null
    }

    async init() {
        const gl = this.gl

        // Detect mobile device
        const isMobile = WebGL2Backend.detectMobile()

        // Enable and track extensions for floating point textures
        const colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float')
        const floatLinear = !!gl.getExtension('OES_texture_float_linear')
        const floatBlend = !!gl.getExtension('EXT_float_blend')

        if (!colorBufferFloat) {
            console.warn('[WebGL2] EXT_color_buffer_float not supported - float texture rendering may fail')
        }
        if (!floatLinear) {
            console.warn('[WebGL2] OES_texture_float_linear not supported - use texelFetch for float textures')
        }
        if (!floatBlend) {
            console.warn('[WebGL2] EXT_float_blend not supported - blending on float textures may fail')
        }

        // Query hardware limits
        this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
        const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS)
        const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)

        // Populate capabilities for graceful degradation
        this.capabilities = {
            isMobile,
            floatBlend,
            floatLinear,
            colorBufferFloat,
            maxDrawBuffers,
            maxTextureSize,
            // Cap particle state texture size on mobile to prevent OOM
            // 512x512 = 262k particles, uses ~48MB for state textures
            maxStateSize: isMobile ? 512 : 2048
        }

        // Create full-screen quad VAO
        this.fullscreenVAO = this.createFullscreenVAO()
        this.emptyVAO = gl.createVertexArray()
        this.presentProgram = this.createPresentProgram()
        this.defaultTexture = this.createDefaultTexture()

        return Promise.resolve()
    }

    createDefaultTexture() {
        const gl = this.gl
        const texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, texture)
        // 1x1 transparent black texture
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return texture
    }

    createPresentProgram() {
        const gl = this.gl
        const vs = DEFAULT_VERTEX_SHADER
        const fs = `#version 300 es
        precision highp float;
        in vec2 v_texCoord;
        uniform sampler2D u_texture;
        out vec4 fragColor;
        void main() {
            fragColor = texture(u_texture, v_texCoord);
        }`

        const vertShader = this.compileShader(gl.VERTEX_SHADER, vs)
        const fragShader = this.compileShader(gl.FRAGMENT_SHADER, fs)

        const program = gl.createProgram()
        gl.attachShader(program, vertShader)
        gl.attachShader(program, fragShader)

        // Ensure a_position is at location 0 to match VAO
        gl.bindAttribLocation(program, 0, 'a_position')

        gl.linkProgram(program)

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Failed to link present program')
            return null
        }

        gl.deleteShader(vertShader)
        gl.deleteShader(fragShader)

        return {
            handle: program,
            uniforms: {
                texture: gl.getUniformLocation(program, 'u_texture')
            }
        }
    }

    createFullscreenVAO() {
        const gl = this.gl

        // Create vertex buffer with full-screen triangle
        const positions = FULLSCREEN_TRIANGLE_POSITIONS

        const buffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

        // Create VAO
        const vao = gl.createVertexArray()
        gl.bindVertexArray(vao)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
        gl.bindVertexArray(null)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)

        return vao
    }

    createTexture(id, spec) {
        const gl = this.gl
        const texture = gl.createTexture()

        gl.bindTexture(gl.TEXTURE_2D, texture)

        // Resolve format
        const glFormat = this.resolveFormat(spec.format)

        // Allocate texture storage
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            glFormat.internalFormat,
            spec.width,
            spec.height,
            0,
            glFormat.format,
            glFormat.type,
            null
        )

        // Set texture parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

        gl.bindTexture(gl.TEXTURE_2D, null)

        this.textures.set(id, {
            handle: texture,
            width: spec.width,
            height: spec.height,
            format: spec.format,
            glFormat
        })

        // Create FBO if this will be a render target
        if (spec.usage && spec.usage.includes('render')) {
            this.createFBO(id, texture)
        }

        // Fresh allocations (initial build, resize, graph changes) are the
        // other place real GL errors surface (e.g. out-of-memory FBOs), so
        // they arm the same post-change error-check window as compiles.
        // Cold path only: per-frame texture updates go through
        // updateTextureFromSource()/texSubImage2D, never here.
        this.glErrorCheckFrames = GL_ERROR_CHECK_FRAMES
        this._glCheckThisFrame = true

        return texture
    }

    createFBO(id, texture) {
        const gl = this.gl
        const fbo = gl.createFramebuffer()

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0
        )

        // Check FBO status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error(`FBO incomplete for texture ${id}: ${status}`)
        }

        // Clear FBO to transparent black to initialize it
        // This prevents GL_INVALID_VALUE errors on some implementations
        // that don't like rendering to uninitialized framebuffers
        const tex = this.textures.get(id)
        if (tex) {
            gl.viewport(0, 0, tex.width, tex.height)
            gl.clearColor(0, 0, 0, 0)
            gl.clear(gl.COLOR_BUFFER_BIT)
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        this.fbos.set(id, fbo)
    }

    /**
     * Ensure a depth buffer is attached to an FBO for 3D rendering.
     * Creates and caches depth renderbuffers as needed.
     * @param {WebGLFramebuffer} fbo - The framebuffer to attach depth to
     * @param {number} width - Viewport width
     * @param {number} height - Viewport height
     */
    ensureDepthBuffer(fbo, width, height) {
        const gl = this.gl

        // Check if this FBO already has a depth buffer
        if (this.depthBuffers.has(fbo)) {
            const existing = this.depthBuffers.get(fbo)
            // Resize if dimensions changed
            if (existing.width !== width || existing.height !== height) {
                gl.bindRenderbuffer(gl.RENDERBUFFER, existing.buffer)
                gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height)
                existing.width = width
                existing.height = height
            }
            return
        }

        // Create new depth renderbuffer
        const depthBuffer = gl.createRenderbuffer()
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer)
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height)

        // Attach to FBO
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer)

        // Verify FBO is still complete
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn(`[ensureDepthBuffer] FBO incomplete after adding depth: ${status}`)
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.bindRenderbuffer(gl.RENDERBUFFER, null)

        this.depthBuffers.set(fbo, { buffer: depthBuffer, width, height })
    }

    /**
     * Create or retrieve an MRT FBO for multiple render targets
     * @param {string} id - Unique identifier for this MRT configuration
     * @param {Array<WebGLTexture>} textures - Array of texture handles to attach
     * @returns {WebGLFramebuffer}
     */
    createMRTFBO(id, textures) {
        const gl = this.gl

        // Check if already cached
        if (this.fbos.has(id)) {
            return this.fbos.get(id)
        }

        const fbo = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)

        const drawBuffers = []
        for (let i = 0; i < textures.length; i++) {
            const attachment = gl.COLOR_ATTACHMENT0 + i
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                attachment,
                gl.TEXTURE_2D,
                textures[i],
                0
            )
            drawBuffers.push(attachment)
        }

        // Enable all color attachments for writing
        gl.drawBuffers(drawBuffers)

        // Check FBO status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error(`MRT FBO incomplete for ${id}: ${status}`)
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        this.fbos.set(id, fbo)
        return fbo
    }

    /**
     * Create a 3D texture for volume data.
     * Note: WebGL2 supports sampling from 3D textures but cannot render to them directly.
     * 3D textures are used for volumetric caching and lookup.
     */
    createTexture3D(id, spec) {
        const gl = this.gl
        const texture = gl.createTexture()

        gl.bindTexture(gl.TEXTURE_3D, texture)

        // Resolve format
        const glFormat = this.resolveFormat(spec.format)

        // Allocate 3D texture storage
        gl.texImage3D(
            gl.TEXTURE_3D,
            0,
            glFormat.internalFormat,
            spec.width,
            spec.height,
            spec.depth,
            0,
            glFormat.format,
            glFormat.type,
            null
        )

        // Set texture parameters - use LINEAR for trilinear filtering support
        const filterMode = spec.filter === 'nearest' ? gl.NEAREST : gl.LINEAR
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filterMode)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filterMode)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)

        gl.bindTexture(gl.TEXTURE_3D, null)

        this.textures.set(id, {
            handle: texture,
            width: spec.width,
            height: spec.height,
            depth: spec.depth,
            format: spec.format,
            glFormat,
            is3D: true
        })

        return texture
    }

    /**
     * Allocate a cube-map texture (6 faces, all same size).
     * @param {string} id - Texture identifier
     * @param {{ size: number }} options - Cube face edge length in pixels
     */
    createCubeTexture(id, { size }) {
        const gl = this.gl
        const handle = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, handle)
        for (let f = 0; f < 6; f++) {
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        }
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        this.textures.set(id, { handle, width: size, height: size, cube: true })
        return this.textures.get(id)
    }

    /**
     * Upload RGBA8 pixel data to one face of a cube-map texture.
     * @param {string} id - Texture identifier (must have been created with createCubeTexture)
     * @param {number} face - Face index 0..5 (added to TEXTURE_CUBE_MAP_POSITIVE_X)
     * @param {{ width: number, height: number, data: Uint8Array }} faceData
     */
    uploadCubeFace(id, face, { width, height, data }) {
        const gl = this.gl
        const tex = this.textures.get(id)
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex.handle)
        gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    }

    /**
     * Update a texture from an external source (video, image, canvas).
     * This is used for media input effects that need to display camera/video content.
     * @param {string} id - Texture ID
     * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap} source - Media source
     * @param {object} [options] - Update options
     * @param {boolean} [options.flipY=true] - Whether to flip the Y axis
     */
    updateTextureFromSource(id, source, options = {}) {
        const gl = this.gl
        if (!gl) return { width: 0, height: 0 }
        let tex = this.textures.get(id)

        const flipY = options.flipY !== false

        // Get source dimensions
        let width, height
        if (source instanceof HTMLVideoElement) {
            width = source.videoWidth
            height = source.videoHeight
        } else if (source instanceof HTMLImageElement) {
            width = source.naturalWidth || source.width
            height = source.naturalHeight || source.height
        } else if (source instanceof HTMLCanvasElement || source instanceof ImageBitmap) {
            width = source.width
            height = source.height
        } else {
            console.warn(`[updateTextureFromSource] Unknown source type for ${id}`)
            return { width: 0, height: 0 }
        }

        if (width === 0 || height === 0) {
            return { width: 0, height: 0 }
        }

        // Create texture if it doesn't exist or if dimensions changed
        if (!tex || tex.width !== width || tex.height !== height) {
            if (tex) {
                gl.deleteTexture(tex.handle)
            }

            const texture = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, texture)

            // Set texture parameters for video/image sampling
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

            tex = {
                handle: texture,
                width,
                height,
                format: 'rgba8',
                glFormat: this.resolveFormat('rgba8'),
                isExternal: true
            }
            this.textures.set(id, tex)
        }

        gl.bindTexture(gl.TEXTURE_2D, tex.handle)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY)

        // Upload the source to the texture
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source
        )

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.bindTexture(gl.TEXTURE_2D, null)

        return { width, height }
    }

    /**
     * Upload mesh data (positions/normals/uvs) to a mesh surface's textures.
     * Used by meshLoader effect when loading OBJ files.
     * @param {string} meshId - Mesh surface ID (e.g., "mesh0")
     * @param {Float32Array} positionData - RGBA32F position data (xyz, w=valid flag)
     * @param {Float32Array} normalData - RGBA32F normal data (xyz, w=0)
     * @param {Float32Array} uvData - RGBA16F UV data (uv, zw=0)
     * @param {number} width - Texture width
     * @param {number} height - Texture height
     * @param {number} vertexCount - Number of valid vertices
     * @returns {{ success: boolean, vertexCount: number }}
     */
    _uploadMeshTexture(texId, data, width, height, internalFormat, formatName) {
        const gl = this.gl
        let tex = this.textures.get(texId)
        if (!tex || tex.width !== width || tex.height !== height) {
            if (tex) gl.deleteTexture(tex.handle)
            const handle = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, handle)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, gl.FLOAT, data)
            this.textures.set(texId, {
                handle, width, height, format: formatName,
                glFormat: { internal: internalFormat, format: gl.RGBA, type: gl.FLOAT }
            })
        } else {
            gl.bindTexture(gl.TEXTURE_2D, tex.handle)
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data)
        }
    }

    /**
     * Upload a CPU-side Float32Array as a 2D RGBA32F texture.
     * Creates the texture on first call, updates via texSubImage2D on subsequent calls.
     * @param {string} id - Texture identifier
     * @param {Float32Array} data - RGBA float data (width * height * 4 elements)
     * @param {number} width - Texture width
     * @param {number} height - Texture height
     */
    uploadDataTexture(id, data, width, height) {
        const gl = this.gl
        let tex = this.textures.get(id)
        if (!tex || tex.width !== width || tex.height !== height) {
            if (tex) gl.deleteTexture(tex.handle)
            const handle = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, handle)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data)
            this.textures.set(id, {
                handle, width, height, format: 'rgba32f',
                glFormat: { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT }
            })
        } else {
            gl.bindTexture(gl.TEXTURE_2D, tex.handle)
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data)
        }
    }

    uploadMeshData(meshId, positionData, normalData, uvData, width, height, vertexCount) {
        const gl = this.gl

        // Get or create the mesh textures
        const posId = `global_${meshId}_positions`
        const normId = `global_${meshId}_normals`
        const uvId = `global_${meshId}_uvs`

        this._uploadMeshTexture(posId, positionData, width, height, gl.RGBA32F, 'rgba32f')
        this._uploadMeshTexture(normId, normalData, width, height, gl.RGBA32F, 'rgba32f')
        this._uploadMeshTexture(uvId, uvData, width, height, gl.RGBA16F, 'rgba16f')

        gl.bindTexture(gl.TEXTURE_2D, null)

        return { success: true, vertexCount }
    }

    /**
     * Read pixels from a texture for testing/parity diffing. Mirrors
     * WebGPUBackend.readPixels(): returns top-down RGBA8 (0-255) regardless of the
     * texture's internal format. gl.readPixels is bottom-up, so the rows are flipped
     * to top-down to match the WebGPU backend's readback orientation.
     * @param {string} textureId
     * @returns {{width:number, height:number, data:Uint8Array}}
     */
    readPixels(textureId) {
        const gl = this.gl
        const tex = this.textures.get(textureId)
        if (!tex) throw new Error(`Texture ${textureId} not found`)
        const { handle, width, height, glFormat } = tex

        const fbo = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle, 0)

        const out = new Uint8Array(width * height * 4)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
            const isFloat = glFormat && (glFormat.type === gl.HALF_FLOAT || glFormat.type === gl.FLOAT)
            if (isFloat) {
                const buf = new Float32Array(width * height * 4)
                gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, buf)
                for (let i = 0; i < out.length; i++) {
                    out[i] = Math.max(0, Math.min(255, Math.round(buf[i] * 255)))
                }
            } else {
                gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
            }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.deleteFramebuffer(fbo)

        const flipped = new Uint8Array(width * height * 4)
        const rowBytes = width * 4
        for (let y = 0; y < height; y++) {
            flipped.set(out.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes), y * rowBytes)
        }
        return { width, height, data: flipped }
    }

    destroyTexture(id) {
        const gl = this.gl
        const tex = this.textures.get(id)

        if (tex) {
            gl.deleteTexture(tex.handle)
            this.textures.delete(id)
        }

        // Delete single-texture FBO for this texture
        const fbo = this.fbos.get(id)
        if (fbo) {
            gl.deleteFramebuffer(fbo)
            this.fbos.delete(id)
        }

        // Also invalidate any MRT FBOs that reference this texture
        // MRT FBO IDs contain the texture IDs in their name (e.g., "mrt_node_0_pass_0_texA_texB")
        const mrtToDelete = []
        for (const fboId of this.fbos.keys()) {
            if (fboId.startsWith('mrt_') && fboId.includes(id)) {
                mrtToDelete.push(fboId)
            }
        }
        for (const mrtId of mrtToDelete) {
            gl.deleteFramebuffer(this.fbos.get(mrtId))
            this.fbos.delete(mrtId)
        }
    }

    /**
     * Clear a texture to transparent black.
     * Used to clear surfaces when chains are deleted.
     * @param {string} id - Texture ID
     */
    clearTexture(id) {
        const gl = this.gl
        const tex = this.textures.get(id)

        if (!tex) {
            return
        }

        // Get or create FBO for this texture
        let fbo = this.fbos.get(id)
        if (!fbo) {
            fbo = gl.createFramebuffer()
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.handle, 0)
            this.fbos.set(id, fbo)
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        }

        // Clear to transparent black
        gl.viewport(0, 0, tex.width, tex.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    /**
     * Copy one texture to another (blit operation).
     * Used for surface copy operations.
     * @param {string} srcId - Source texture ID
     * @param {string} dstId - Destination texture ID
     */
    copyTexture(srcId, dstId) {
        const gl = this.gl
        const srcTex = this.textures.get(srcId)
        const dstTex = this.textures.get(dstId)

        if (!srcTex || !dstTex) {
            console.warn(`[copyTexture] Missing texture: src=${srcId} (${!!srcTex}), dst=${dstId} (${!!dstTex})`)
            return
        }

        // Use blitFramebuffer for efficient texture copy
        // Create temporary FBOs if needed
        let readFbo = this.fbos.get(srcId)
        if (!readFbo) {
            readFbo = gl.createFramebuffer()
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo)
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTex.handle, 0)
        } else {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo)
        }

        let drawFbo = this.fbos.get(dstId)
        if (!drawFbo) {
            drawFbo = gl.createFramebuffer()
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo)
            gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex.handle, 0)
            // Store for future use
            this.fbos.set(dstId, drawFbo)
        } else {
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo)
        }

        // Blit the texture
        gl.blitFramebuffer(
            0, 0, srcTex.width, srcTex.height,
            0, 0, dstTex.width, dstTex.height,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST
        )

        // Unbind
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    }

    async compileProgram(id, spec) {
        const gl = this.gl

        // Check for missing shader source
        const rawSource = spec.source || spec.glsl || spec.fragment
        if (!rawSource) {
            throw new Error(`Shader source missing for program '${id}'. You may need to regenerate the shader manifest.`)
        }

        // Inject defines
        const source = this.injectDefines(rawSource, spec.defines || {})

        // Compile vertex shader
        const vsSource = spec.vertex || DEFAULT_VERTEX_SHADER
        const usingDefaultVertex = !spec.vertex
        const vertShader = this.compileShader(gl.VERTEX_SHADER, vsSource)

        // Compile fragment shader
        const fragShader = this.compileShader(gl.FRAGMENT_SHADER, source)

        // Link program
        const program = gl.createProgram()
        gl.attachShader(program, vertShader)
        gl.attachShader(program, fragShader)

        if (usingDefaultVertex) {
            gl.bindAttribLocation(program, 0, 'a_position')
        }

        gl.linkProgram(program)

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program)
            throw {
                code: 'ERR_SHADER_LINK',
                detail: log,
                program: id
            }
        }

        // Clean up shaders
        gl.deleteShader(vertShader)
        gl.deleteShader(fragShader)

        // Extract uniforms and attribute locations
        const uniforms = this.extractUniforms(program)
        const uniformBlocks = this.extractUniformBlocks(program, spec)
        const attributes = {
            a_position: gl.getAttribLocation(program, 'a_position'),
            aPosition: gl.getAttribLocation(program, 'aPosition')
        }

        const compiledProgram = {
            handle: program,
            uniforms,
            uniformBlocks,
            attributes
        }

        this.programs.set(id, compiledProgram)

        // Freshly compiled programs get their first frames error-checked;
        // steady-state frames skip the per-pass gl.getError() sync entirely.
        // The per-frame flag is latched too so draws before the next
        // beginFrame() (e.g. an immediate post-compile render) are covered.
        this.glErrorCheckFrames = GL_ERROR_CHECK_FRAMES
        this._glCheckThisFrame = true

        return compiledProgram
    }

    compileShader(type, source) {
        const gl = this.gl
        const shader = gl.createShader(type)

        gl.shaderSource(shader, source)
        gl.compileShader(shader)

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader)
            console.error('[GLSL compile error]', log)
            console.error('[GLSL source]', source)
            gl.deleteShader(shader)
            throw {
                code: 'ERR_SHADER_COMPILE',
                detail: log,
                source
            }
        }

        return shader
    }

    injectDefines(source, defines) {
        if (!source) {
            throw new Error('Shader source is missing. You may need to regenerate the shader manifest.')
        }

        let injected = '#version 300 es\nprecision highp float;\nprecision highp int;\n'

        for (const [key, value] of Object.entries(defines)) {
            injected += `#define ${key} ${value}\n`
        }

        // Remove any existing version directive from source
        const cleaned = source.replace(/^\s*#version.*$/m, '')

        return injected + cleaned
    }

    extractUniforms(program) {
        const gl = this.gl
        const uniforms = {}
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)

        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i)
            const location = gl.getUniformLocation(program, info.name)

            uniforms[info.name] = {
                location,
                type: info.type,
                size: info.size
            }

            // For array uniforms (e.g., "audioWaveform[0]"), also register without the [0] suffix
            if (info.name.endsWith('[0]')) {
                const baseName = info.name.slice(0, -3)
                uniforms[baseName] = uniforms[info.name]
            }
        }

        return uniforms
    }

    extractUniformBlocks(program, spec) {
        const gl = this.gl
        const blocks = []
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORM_BLOCKS)
        if (!count || !spec.uniformLayout) return blocks

        const maxBlockSize = gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE)
        for (let i = 0; i < count; i++) {
            const name = gl.getActiveUniformBlockName(program, i)
            if (!name) continue

            const declaredSize = gl.getActiveUniformBlockParameter(program, i, gl.UNIFORM_BLOCK_DATA_SIZE)
            const layoutSize = this.getPackedUniformLayoutSize(spec.uniformLayout)
            const size = Math.max(declaredSize, layoutSize)
            if (size > maxBlockSize) {
                throw {
                    code: 'ERR_UNIFORM_BLOCK_TOO_LARGE',
                    detail: `Uniform block ${name} requires ${size} bytes; device limit is ${maxBlockSize}`,
                    program
                }
            }

            const bindingPoint = blocks.length
            const buffer = gl.createBuffer()
            gl.bindBuffer(gl.UNIFORM_BUFFER, buffer)
            gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.UNIFORM_BUFFER, null)
            gl.uniformBlockBinding(program, i, bindingPoint)

            blocks.push({
                name,
                index: i,
                bindingPoint,
                buffer,
                size,
                layout: spec.uniformLayout
            })
        }

        return blocks
    }

    getPackedUniformLayoutSize(layout) {
        const layoutArray = this.normalizePackedUniformLayout(layout)
        let maxSlot = 0
        for (const entry of layoutArray) {
            maxSlot = Math.max(maxSlot, entry.slot)
        }
        return (maxSlot + 1) * 16
    }

    normalizePackedUniformLayout(layout) {
        if (Array.isArray(layout)) return layout

        const layoutArray = []
        for (const [name, spec] of Object.entries(layout || {})) {
            layoutArray.push({ name, slot: spec.slot, components: spec.components })
        }
        return layoutArray
    }

    executePass(pass, state) {
        const gl = this.gl

        // Error checking is armed only for the first frames after a compile
        // or allocation — gl.getError() is a synchronous pipeline flush, far
        // too expensive to run per pass in steady state (see
        // GL_ERROR_CHECK_FRAMES). Reads the frame-latched flag so the whole
        // frame (including present(), which runs after endFrame()) agrees.
        const checkGLErrors = this._glCheckThisFrame

        if (checkGLErrors) {
            // Clear any pending WebGL errors from previous operations
            // This ensures we only report errors from THIS pass
            let maxErrorDrain = 100
            while (gl.getError() !== gl.NO_ERROR && maxErrorDrain-- > 0) { /* drain */ }
        }

        // WebGL2 GPGPU: Convert passes with compute-style conventions to render passes
        // Compute shaders don't exist in WebGL2, so we use fragment shaders
        // with fullscreen triangles as a GPGPU fallback
        const needsConversion = pass.storageTextures || (pass.outputs && pass.outputs.outputBuffer)
        const effectivePass = needsConversion ? this.convertComputeToRender(pass) : pass

        const program = this.programs.get(effectivePass.program)

        if (!program) {
            console.error(`Program ${effectivePass.program} not found for pass ${effectivePass.id}`)
            throw {
                code: 'ERR_PROGRAM_NOT_FOUND',
                pass: effectivePass.id,
                program: effectivePass.program
            }
        }

        // Use program
        gl.useProgram(program.handle)

        // Check for MRT (Multiple Render Targets)
        const outputKeys = Object.keys(effectivePass.outputs || {})
        const isMRT = effectivePass.drawBuffers > 1 || outputKeys.length > 1

        let fbo = null
        let viewportTex = null
        let outputId = null  // Track primary output for reference (used by points draw mode)

        // Track actual number of MRT attachments for drawBuffers call
        let mrtAttachmentCount = 0

        if (isMRT) {
            // MRT pass - bind multiple outputs
            const textures = []
            const resolvedOutputIds = []

            for (const outputKey of outputKeys) {
                let currentOutputId = effectivePass.outputs[outputKey]

                // Resolve global surface to current write buffer
                const globalName = this.parseGlobalName(currentOutputId)
                if (globalName) {
                    if (state.writeSurfaces && state.writeSurfaces[globalName]) {
                        currentOutputId = state.writeSurfaces[globalName]
                    }
                }

                // Track first output as primary reference
                if (!outputId) outputId = currentOutputId

                resolvedOutputIds.push(currentOutputId)
                const tex = this.textures.get(currentOutputId)
                if (tex) {
                    textures.push(tex.handle)
                    if (!viewportTex) viewportTex = tex
                } else {
                    console.warn(`[executePass MRT] Texture not found for ${currentOutputId} in pass ${effectivePass.id}`)
                }
            }

            if (textures.length > 0) {
                // Create unique ID for this MRT configuration
                const mrtId = `mrt_${effectivePass.id}_${resolvedOutputIds.join('_')}`
                fbo = this.createMRTFBO(mrtId, textures)
                mrtAttachmentCount = textures.length
            }
        } else {
            // Single output pass
            outputId = effectivePass.outputs?.color || Object.values(effectivePass.outputs || {})[0]

            // Resolve global surface to current write buffer
            const globalName = this.parseGlobalName(outputId)
            if (globalName) {
                if (state.writeSurfaces && state.writeSurfaces[globalName]) {
                    outputId = state.writeSurfaces[globalName]
                }
            }

            fbo = this.fbos.get(outputId)
            if (!fbo && outputId !== 'screen') {
                console.warn(`[executePass] FBO not found for ${outputId} in pass ${effectivePass.id}`)
            }

            viewportTex = this.textures.get(outputId)
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo || null)

        // For MRT, we need to call drawBuffers again after binding the FBO
        // Use actual attachment count, not outputKeys.length, in case some textures weren't found
        if (isMRT && fbo && mrtAttachmentCount > 0) {
            const drawBuffers = []
            for (let i = 0; i < mrtAttachmentCount; i++) {
                drawBuffers.push(gl.COLOR_ATTACHMENT0 + i)
            }
            gl.drawBuffers(drawBuffers)
        }

        // Set viewport
        if (viewportTex) {
            gl.viewport(0, 0, viewportTex.width, viewportTex.height)
        } else if (effectivePass.viewport) {
            gl.viewport(effectivePass.viewport.x, effectivePass.viewport.y, effectivePass.viewport.w, effectivePass.viewport.h)
        } else {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
        }

        // DEBUG: Clear to random color to verify FBO write
        // gl.clearColor(Math.random(), Math.random(), Math.random(), 1.0)
        // gl.clear(gl.COLOR_BUFFER_BIT)

        // Bind input textures
        this.bindTextures(effectivePass, program, state)

        // Bind uniforms
        this.bindUniforms(effectivePass, program, state)
        this.bindUniformBlocks(effectivePass, program, state)

        // Handle Blending
        if (effectivePass.blend) {
            gl.enable(gl.BLEND)
            if (Array.isArray(effectivePass.blend)) {
                const srcFactor = this.resolveBlendFactor(effectivePass.blend[0])
                const dstFactor = this.resolveBlendFactor(effectivePass.blend[1])
                gl.blendFunc(srcFactor, dstFactor)
            } else {
                // Default to additive
                gl.blendFunc(gl.ONE, gl.ONE)
            }
        } else {
            gl.disable(gl.BLEND)
        }

        // Draw
        if (effectivePass.drawMode === 'points') {
            let count = effectivePass.count || 1000
            if (count === 'auto' || count === 'screen' || count === 'input') {
                // Determine count based on mode
                let refTex = null

                if (count === 'input' && effectivePass.inputs) {
                    // For particle systems, prefer xyzTex (state texture) over inputTex
                    const stateInputId = effectivePass.inputs.xyzTex || effectivePass.inputs.inputTex
                    if (stateInputId) {
                        const inputGlobalName = this.parseGlobalName(stateInputId)
                        if (inputGlobalName) {
                            const surfaceTex = state.surfaces?.[inputGlobalName]
                            if (surfaceTex) {
                                refTex = surfaceTex
                            }
                        } else {
                            refTex = this.textures.get(stateInputId)
                        }
                    }
                } else {
                    // Use output texture dimensions (auto) or screen
                    const tex = this.textures.get(outputId)
                    refTex = tex
                }

                if (refTex && refTex.width && refTex.height) {
                    count = refTex.width * refTex.height
                } else {
                    count = gl.drawingBufferWidth * gl.drawingBufferHeight
                }
            }

            gl.bindVertexArray(this.emptyVAO)
            gl.drawArrays(gl.POINTS, 0, count)
            gl.bindVertexArray(null)
        } else if (effectivePass.drawMode === 'billboards') {
            // Billboard mode: 6 vertices per particle (2 triangles = 1 quad)
            let count = effectivePass.count || 1000
            if (count === 'auto' || count === 'screen' || count === 'input') {
                // Determine particle count based on mode
                let refTex = null

                if (count === 'input' && effectivePass.inputs && effectivePass.inputs.xyzTex) {
                    // Use xyz state texture dimensions
                    const inputId = effectivePass.inputs.xyzTex
                    const inputGlobalName = this.parseGlobalName(inputId)
                    if (inputGlobalName) {
                        const surfaceTex = state.surfaces?.[inputGlobalName]
                        if (surfaceTex) {
                            refTex = surfaceTex
                        }
                    } else {
                        refTex = this.textures.get(inputId)
                    }
                } else {
                    // Use output texture dimensions (auto) or screen
                    const tex = this.textures.get(outputId)
                    refTex = tex
                }

                if (refTex && refTex.width && refTex.height) {
                    count = refTex.width * refTex.height
                } else {
                    count = gl.drawingBufferWidth * gl.drawingBufferHeight
                }
            }

            // 6 vertices per particle for billboard quads
            gl.bindVertexArray(this.emptyVAO)
            gl.drawArrays(gl.TRIANGLES, 0, count * 6)
            gl.bindVertexArray(null)
        } else if (effectivePass.drawMode === 'triangles') {
            // Triangle mesh mode: vertices read from mesh textures
            // Enable proper 3D rendering state: depth test + back-face culling

            // Get viewport dimensions for depth buffer
            const vpWidth = viewportTex?.width || gl.drawingBufferWidth
            const vpHeight = viewportTex?.height || gl.drawingBufferHeight

            // Ensure FBO has depth buffer (null = default framebuffer, already has depth)
            if (fbo) {
                this.ensureDepthBuffer(fbo, vpWidth, vpHeight)
            }

            // Enable depth testing (closer fragments win)
            gl.enable(gl.DEPTH_TEST)
            gl.depthFunc(gl.LESS)
            gl.depthMask(true)

            // Enable back-face culling (CCW = front, cull back faces)
            gl.enable(gl.CULL_FACE)
            gl.frontFace(gl.CCW)
            gl.cullFace(gl.BACK)

            // Clear depth buffer for this pass
            gl.clear(gl.DEPTH_BUFFER_BIT)

            let count = effectivePass.count || 3  // Default to 1 triangle

            // Check if countUniform is specified - read count from uniforms at runtime
            if (effectivePass.countUniform) {
                const uniformName = effectivePass.countUniform
                // Look up in pass uniforms, then state globalUniforms
                let uniformValue = effectivePass.uniforms?.[uniformName]
                if (uniformValue === undefined) {
                    uniformValue = state.globalUniforms?.[uniformName]
                }
                if (typeof uniformValue === 'number' && uniformValue > 0) {
                    count = uniformValue
                }
            } else if (count === 'auto' || count === 'input') {
                // Derive vertex count from mesh position texture
                let refTex = null
                if (effectivePass.inputs) {
                    const meshInputId = effectivePass.inputs.meshPositions || effectivePass.inputs.inputTex
                    if (meshInputId) {
                        refTex = this.textures.get(meshInputId)
                        if (!refTex) {
                            // Try unscoped name (strip chain scope suffix)
                            const unscopedId = meshInputId.replace(/_chain_\d+$/, '')
                            if (unscopedId !== meshInputId) {
                                refTex = this.textures.get(unscopedId)
                            }
                        }
                        if (!refTex) {
                            const inputGlobalName = this.parseGlobalName(meshInputId)
                            if (inputGlobalName) {
                                refTex = state.surfaces?.[inputGlobalName]
                            }
                        }
                    }
                }
                if (refTex && refTex.width && refTex.height) {
                    count = refTex.width * refTex.height
                } else {
                    count = 3  // Fallback to 1 triangle
                }
            }
            gl.bindVertexArray(this.emptyVAO)
            gl.drawArrays(gl.TRIANGLES, 0, count)
            gl.bindVertexArray(null)

            // Restore GL state for subsequent 2D passes
            gl.disable(gl.DEPTH_TEST)
            gl.disable(gl.CULL_FACE)
        } else {
            // Default to fullscreen triangle
            gl.bindVertexArray(this.fullscreenVAO)
            gl.drawArrays(gl.TRIANGLES, 0, FULLSCREEN_TRIANGLE_VERTEX_COUNT)
            gl.bindVertexArray(null)
        }

        if (checkGLErrors) {
            // Check for errors - drain all errors from the queue
            let error = gl.getError()
            let maxErrorLog = 100
            while (error !== gl.NO_ERROR && maxErrorLog-- > 0) {
                // Build detailed error context
                const outputId = effectivePass.outputs?.color || Object.values(effectivePass.outputs || {})[0] || 'unknown'
                const inputIds = effectivePass.inputs ? Object.entries(effectivePass.inputs).map(([k,v]) => `${k}=${v}`).join(', ') : 'none'
                console.error(`WebGL Error ${error} in pass ${effectivePass.id} (effect: ${effectivePass.effectKey || 'unknown'}, program: ${effectivePass.program}, output: ${outputId}, inputs: ${inputIds})`)
                error = gl.getError()
            }
        }

        // Unbind
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.useProgram(null)
        gl.disable(gl.BLEND)
    }

    /**
     * Convert a compute pass to a GPGPU render pass for WebGL2 fallback
     * WebGL2 doesn't support compute shaders, so we use fragment shaders
     * with fullscreen triangles to achieve similar functionality.
     */
    convertComputeToRender(pass) {
        // Create a render-equivalent pass
        const renderPass = {
            ...pass,
            type: 'render',
            _originalType: 'compute'
        }

        // Map compute outputs to render outputs
        // Compute shaders typically write to storage buffers/textures
        // For GPGPU, we write to framebuffer color attachments
        if (pass.storageTextures) {
            renderPass.outputs = {}
            for (const [key, texId] of Object.entries(pass.storageTextures)) {
                // Map storage texture to render output
                renderPass.outputs[key] = texId
            }
        }

        // If outputs exist but use compute conventions (outputBuffer -> fragColor)
        if (pass.outputs) {
            renderPass.outputs = {}
            for (const [key, texId] of Object.entries(pass.outputs)) {
                // Normalize output names
                const normalizedKey = key === 'outputBuffer' ? 'color' : key
                renderPass.outputs[normalizedKey] = texId
            }
        }

        // Ensure we have at least one output
        if (!renderPass.outputs || Object.keys(renderPass.outputs).length === 0) {
            renderPass.outputs = { color: 'outputTex' }
        }

        return renderPass
    }

    bindTextures(pass, program, state) {
        const gl = this.gl
        let unit = 0

        if (!pass.inputs) return

        for (const [samplerName, texId] of Object.entries(pass.inputs)) {
            if (unit >= this.maxTextureUnits) {
                throw {
                    code: 'ERR_TOO_MANY_TEXTURES',
                    pass: pass.id,
                    limit: this.maxTextureUnits
                }
            }

            // Get texture from state or textures map
            let texture
            let texInfo
            const globalName = this.parseGlobalName(texId)
            if (globalName) {
                // Check scoped name first (e.g., "global_mesh0_positions_chain_0")
                texInfo = this.textures.get(texId)
                texture = texInfo?.handle

                // Fall back to unscoped name for externally uploaded textures (mesh data).
                // The expander adds chain scope suffixes (_chain_N) but mesh uploads use
                // the base name (global_mesh0_positions). Strip the scope suffix to find them.
                if (!texture) {
                    const unscopedId = texId.replace(/_chain_\d+$/, '')
                    if (unscopedId !== texId) {
                        texInfo = this.textures.get(unscopedId)
                        texture = texInfo?.handle
                    }
                }

                // If not found, check surfaces (ping-pong render targets)
                if (!texture) {
                    texture = state.surfaces?.[globalName]?.handle
                }
            } else {
                texInfo = this.textures.get(texId)
                texture = texInfo?.handle
            }

            // If texture is missing, use default texture (transparent black)
            // This handles cases where a pipeline reads from an uninitialized surface
            // (e.g. reading o0 before writing to it) without crashing or warning.
            if (!texture) {
                texture = this.defaultTexture
            }

            // Check if this is a 3D texture
            const is3D = texInfo?.is3D

            gl.activeTexture(gl.TEXTURE0 + unit)
            gl.bindTexture(is3D ? gl.TEXTURE_3D : gl.TEXTURE_2D, texture || null)

            // Bind sampler uniform
            const uniform = program.uniforms[samplerName]
            if (uniform) {
                gl.uniform1i(uniform.location, unit)
            }

            unit++
        }
    }

    bindUniforms(pass, program, state) {
        const gl = this.gl
        const programUniforms = program.uniforms

        // Bind pass uniforms first (from DSL/effect defaults, includes resolved oscillators)
        if (pass.uniforms) {
            for (const name in pass.uniforms) {
                const uniform = programUniforms[name]
                if (!uniform) continue
                const value = pass.uniforms[name]
                if (value === undefined || value === null) continue
                this._setUniform(gl, uniform, value)
            }
        }

        // Then bind globalUniforms (time, resolution, etc.) but SKIP any already in pass.uniforms
        // Pass uniforms take precedence because they contain resolved automation values (oscillators, midi, audio)
        if (state.globalUniforms) {
            for (const name in state.globalUniforms) {
                // Skip if pass.uniforms already set this - pass.uniforms has the resolved oscillator value
                if (pass.uniforms && name in pass.uniforms) continue
                const uniform = programUniforms[name]
                if (!uniform) continue
                const value = state.globalUniforms[name]
                if (value === undefined || value === null) continue
                this._setUniform(gl, uniform, value)
            }
        }
    }

    bindUniformBlocks(pass, program, state) {
        if (!program.uniformBlocks || program.uniformBlocks.length === 0) return

        const gl = this.gl
        const merged = this._mergedUniforms
        const mergedKeys = this._mergedUniformKeys

        for (let i = 0; i < mergedKeys.length; i++) {
            merged[mergedKeys[i]] = undefined
        }
        mergedKeys.length = 0

        if (pass.uniforms) {
            for (const key in pass.uniforms) {
                const val = pass.uniforms[key]
                if (val !== undefined) {
                    merged[key] = val
                    mergedKeys.push(key)
                }
            }
        }

        if (state.globalUniforms) {
            for (const key in state.globalUniforms) {
                if (pass.uniforms && key in pass.uniforms) continue
                const val = state.globalUniforms[key]
                if (val !== undefined) {
                    if (merged[key] === undefined) {
                        mergedKeys.push(key)
                    }
                    merged[key] = val
                }
            }
        }

        for (const block of program.uniformBlocks) {
            const data = this.packUniformsWithLayout(merged, block.layout, block.size)
            gl.bindBuffer(gl.UNIFORM_BUFFER, block.buffer)
            gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data)
            gl.bindBufferBase(gl.UNIFORM_BUFFER, block.bindingPoint, block.buffer)
        }
        gl.bindBuffer(gl.UNIFORM_BUFFER, null)
    }

    _resolveUniformAlias(name, uniforms) {
        if (uniforms[name] !== undefined) return uniforms[name]
        if (name === 'width' && uniforms.resolution) return uniforms.resolution[0]
        if (name === 'height' && uniforms.resolution) return uniforms.resolution[1]
        if (name === 'channels') return 4.0
        return undefined
    }

    packUniformsWithLayout(uniforms, layout, minSize = 0) {
        const layoutArray = this.normalizePackedUniformLayout(layout)
        let maxSlot = 0
        for (const entry of layoutArray) {
            maxSlot = Math.max(maxSlot, entry.slot)
        }

        const bufferSize = Math.max(minSize, (maxSlot + 1) * 16)
        if (bufferSize > this._packedUniformBuffer.byteLength) {
            this._packedUniformBuffer = new ArrayBuffer(bufferSize)
            this._packedUniformView = new DataView(this._packedUniformBuffer)
            this._packedUniformBytes = new Uint8Array(this._packedUniformBuffer)
        }

        const bytes = this._packedUniformBytes
        const view = this._packedUniformView
        bytes.fill(0, 0, bufferSize)

        const componentOffset = { x: 0, y: 4, z: 8, w: 12 }

        for (const entry of layoutArray) {
            const value = this._resolveUniformAlias(entry.name, uniforms)
            if (value === undefined || value === null) continue

            const slotOffset = entry.slot * 16
            if (entry.components.length === 1) {
                const offset = slotOffset + componentOffset[entry.components]
                if (typeof value === 'boolean') {
                    view.setFloat32(offset, value ? 1.0 : 0.0, true)
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            } else if (entry.components.length === 2) {
                const offset = slotOffset + componentOffset[entry.components[0]]
                if (Array.isArray(value)) {
                    for (let i = 0; i < Math.min(value.length, 2); i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            } else if (entry.components.length === 3) {
                const offset = slotOffset + componentOffset[entry.components[0]]
                if (Array.isArray(value)) {
                    for (let i = 0; i < Math.min(value.length, 3); i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            } else if (entry.components.length === 4) {
                const offset = slotOffset
                if (Array.isArray(value)) {
                    for (let i = 0; i < Math.min(value.length, 4); i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            }
        }

        return bytes.subarray(0, bufferSize)
    }

    /** @private Helper to set a single uniform value */
    _setUniform(gl, uniform, value) {
        const loc = uniform.location
        switch (uniform.type) {
            case gl.FLOAT:
                if (value instanceof Float32Array || Array.isArray(value)) {
                    gl.uniform1fv(loc, value)
                } else {
                    gl.uniform1f(loc, value)
                }
                break
            case gl.INT:
            case gl.BOOL:
                gl.uniform1i(loc, typeof value === 'boolean' ? (value ? 1 : 0) : value)
                break
            case gl.FLOAT_VEC2: {
                const v2 = Array.isArray(value) ? value : [value, value]
                const arr2 = this._vec2Buf
                arr2[0] = v2[0] ?? 0
                arr2[1] = v2[1] ?? 0
                gl.uniform2fv(loc, arr2)
                break
            }
            case gl.FLOAT_VEC3: {
                const v3 = Array.isArray(value) ? value : [value, value, value]
                const arr3 = this._vec3Buf
                arr3[0] = v3[0] ?? 0
                arr3[1] = v3[1] ?? 0
                arr3[2] = v3[2] ?? 0
                gl.uniform3fv(loc, arr3)
                break
            }
            case gl.FLOAT_VEC4: {
                const v4 = Array.isArray(value) ? value : [value, value, value, value]
                const arr4 = this._vec4Buf
                arr4[0] = v4[0] ?? 0
                arr4[1] = v4[1] ?? 0
                arr4[2] = v4[2] ?? 0
                arr4[3] = v4[3] ?? 1
                gl.uniform4fv(loc, arr4)
                break
            }
            case gl.FLOAT_MAT3:
                gl.uniformMatrix3fv(loc, false, value)
                break
            case gl.FLOAT_MAT4:
                gl.uniformMatrix4fv(loc, false, value)
                break
        }
    }

    beginFrame() {
        const gl = this.gl
        gl.clearColor(0, 0, 0, 0)

        // Latch the error-check state for this whole frame (see constructor)
        this._glCheckThisFrame = this.glErrorCheckFrames > 0
    }

    endFrame() {
        const gl = this.gl
        gl.flush()

        // Burn down the post-compile/allocation error-check window one frame
        // at a time. The latched _glCheckThisFrame stays valid until the next
        // beginFrame(), so present() still checks on the last armed frame.
        if (this.glErrorCheckFrames > 0) {
            this.glErrorCheckFrames--
        }
    }

    present(textureId) {
        const gl = this.gl
        const tex = this.textures.get(textureId)
        if (!tex || !this.presentProgram || !this.fullscreenVAO) {
            console.warn('Present skipped: missing texture or program', { textureId, tex, prog: !!this.presentProgram })
            return
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)

        // Clear the screen first
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)

        gl.useProgram(this.presentProgram.handle)

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex.handle)
        gl.uniform1i(this.presentProgram.uniforms.texture, 0)

        gl.bindVertexArray(this.fullscreenVAO)
        gl.drawArrays(gl.TRIANGLES, 0, FULLSCREEN_TRIANGLE_VERTEX_COUNT)

        // Same frame-latched policy as executePass: gl.getError() is a
        // synchronous pipeline flush, unaffordable per frame in steady state.
        if (this._glCheckThisFrame) {
            const error = gl.getError()
            if (error !== gl.NO_ERROR) {
                console.error(`WebGL Error in present: ${error}`)
            }
        }

        gl.bindVertexArray(null)

        gl.useProgram(null)
    }

    destroy(options = {}) {
        const gl = this.gl
        if (!gl) {
            return
        }

        if (!options?.skipTextures) {
            // Delete textures and associated framebuffers
            for (const id of Array.from(this.textures.keys())) {
                this.destroyTexture(id)
            }

            this.textures.clear()
        }

        // Delete compiled programs
        for (const program of this.programs.values()) {
            if (program?.handle) {
                gl.deleteProgram(program.handle)
            }
        }
        this.programs.clear()

        if (this.presentProgram?.handle) {
            gl.deleteProgram(this.presentProgram.handle)
        }
        this.presentProgram = null

        if (this.fullscreenVAO) {
            gl.deleteVertexArray(this.fullscreenVAO)
            this.fullscreenVAO = null
        }

        if (this.emptyVAO) {
            gl.deleteVertexArray(this.emptyVAO)
            this.emptyVAO = null
        }

        // Depth renderbuffers live outside this.textures, so free them
        // explicitly — destroyTexture only releases per-texture FBOs.
        for (const entry of this.depthBuffers.values()) {
            if (entry?.buffer) {
                gl.deleteRenderbuffer(entry.buffer)
            }
        }
        this.depthBuffers.clear()

        this.fbos.clear()

        if (options?.loseContext) {
            const loseCtx = gl.getExtension('WEBGL_lose_context')
            if (loseCtx) {
                loseCtx.loseContext()
            }
        }

        this.gl = null
        this.context = null
    }

    resolveFormat(format) {
        const gl = this.gl

        const formats = {
            'rgba8': {
                internalFormat: gl.RGBA8,
                format: gl.RGBA,
                type: gl.UNSIGNED_BYTE
            },
            'rgba16f': {
                internalFormat: gl.RGBA16F,
                format: gl.RGBA,
                type: gl.HALF_FLOAT
            },
            'rgba32f': {
                internalFormat: gl.RGBA32F,
                format: gl.RGBA,
                type: gl.FLOAT
            },
            'r8': {
                internalFormat: gl.R8,
                format: gl.RED,
                type: gl.UNSIGNED_BYTE
            },
            'r16f': {
                internalFormat: gl.R16F,
                format: gl.RED,
                type: gl.HALF_FLOAT
            },
            'r32f': {
                internalFormat: gl.R32F,
                format: gl.RED,
                type: gl.FLOAT
            }
        }

        return formats[format] || formats['rgba8']
    }

    /**
     * Convert blend factor string to GL constant
     * @param {string|number} factor - Blend factor string (e.g., "ONE", "SRC_ALPHA") or GL constant
     * @returns {number} GL blend factor constant
     */
    resolveBlendFactor(factor) {
        const gl = this.gl
        if (typeof factor === 'number') return factor

        const factors = {
            'ZERO': gl.ZERO,
            'ONE': gl.ONE,
            'SRC_COLOR': gl.SRC_COLOR,
            'ONE_MINUS_SRC_COLOR': gl.ONE_MINUS_SRC_COLOR,
            'DST_COLOR': gl.DST_COLOR,
            'ONE_MINUS_DST_COLOR': gl.ONE_MINUS_DST_COLOR,
            'SRC_ALPHA': gl.SRC_ALPHA,
            'ONE_MINUS_SRC_ALPHA': gl.ONE_MINUS_SRC_ALPHA,
            'DST_ALPHA': gl.DST_ALPHA,
            'ONE_MINUS_DST_ALPHA': gl.ONE_MINUS_DST_ALPHA,
            'CONSTANT_COLOR': gl.CONSTANT_COLOR,
            'ONE_MINUS_CONSTANT_COLOR': gl.ONE_MINUS_CONSTANT_COLOR,
            'CONSTANT_ALPHA': gl.CONSTANT_ALPHA,
            'ONE_MINUS_CONSTANT_ALPHA': gl.ONE_MINUS_CONSTANT_ALPHA,
            'SRC_ALPHA_SATURATE': gl.SRC_ALPHA_SATURATE,
            // WebGPU-style lowercase
            'zero': gl.ZERO,
            'one': gl.ONE,
            'src': gl.SRC_COLOR,
            'one-minus-src': gl.ONE_MINUS_SRC_COLOR,
            'dst': gl.DST_COLOR,
            'one-minus-dst': gl.ONE_MINUS_DST_COLOR,
            'src-alpha': gl.SRC_ALPHA,
            'one-minus-src-alpha': gl.ONE_MINUS_SRC_ALPHA,
            'dst-alpha': gl.DST_ALPHA,
            'one-minus-dst-alpha': gl.ONE_MINUS_DST_ALPHA
        }

        return factors[factor] || gl.ONE
    }

    getName() {
        return 'WebGL2'
    }

    static isAvailable() {
        try {
            const canvas = document.createElement('canvas')
            const gl = canvas.getContext('webgl2')
            return !!gl
        } catch {
            return false
        }
    }
}
