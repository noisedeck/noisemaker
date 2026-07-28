/**
 * WebGPU Backend Implementation
 *
 * Implements the Noisemaker Rendering Pipeline specification for WebGPU.
 * Handles render and compute passes, texture management, and uniform buffers.
 *
 * [MODIFIED 2024-01-XX] Added GPGPU fallback and entry point detection
 */

import { Backend } from '../backend.js'
import {
    DEFAULT_FRAGMENT_ENTRY_POINT,
    DEFAULT_VERTEX_ENTRY_POINT,
    DEFAULT_VERTEX_SHADER_WGSL
} from '../default-shaders.js'

/**
 * Convert a float16 value (stored as uint16) to float32
 */
function float16ToFloat32(h) {
    const sign = (h >> 15) & 0x1
    const exponent = (h >> 10) & 0x1f
    const mantissa = h & 0x3ff

    if (exponent === 0) {
        // Denormalized number or zero
        if (mantissa === 0) {
            return sign ? -0 : 0
        }
        // Denormalized
        const f = mantissa / 1024
        return (sign ? -1 : 1) * f * Math.pow(2, -14)
    } else if (exponent === 31) {
        // Infinity or NaN
        if (mantissa === 0) {
            return sign ? -Infinity : Infinity
        }
        return NaN
    }

    // Normalized number
    const f = 1 + mantissa / 1024
    return (sign ? -1 : 1) * f * Math.pow(2, exponent - 15)
}

export class WebGPUBackend extends Backend {
    constructor(device, context) {
        super(device)
        this.device = device
        this.context = context
        this.queue = device.queue
        this.pipelines = new Map() // programId -> render or compute pipeline
        this.bindGroups = new Map() // passId -> bind group
        this.samplers = new Map() // config -> sampler
        this.storageBuffers = new Map() // bufferId -> GPUBuffer
        this.commandEncoder = null
        this.defaultVertexModule = null
        this.canvasFormat = (typeof navigator !== 'undefined' && navigator.gpu?.getPreferredCanvasFormat)
            ? navigator.gpu.getPreferredCanvasFormat()
            : null

        // Depth texture for 3D mesh rendering (created lazily)
        this.depthTexture = null
        this.depthTextureSize = { width: 0, height: 0 }

        // Uniform buffer pool for efficient buffer reuse
        this.uniformBufferPool = []
        this.activeUniformBuffers = []

        // Pre-allocated objects for hot path to avoid per-frame GC pressure
        this._mergedUniforms = {}  // Reused in createUniformBuffer
        this._mergedUniformKeys = []  // Track keys to clear efficiently
        // Pre-allocated typed arrays for single uniform buffers (common sizes)
        this._singleUniformFloat32 = new Float32Array(4)  // Up to vec4
        this._singleUniformInt32 = new Int32Array(4)  // Up to vec4
        this._singleUniformMat3Float32 = new Float32Array(12)  // mat3x3<f32>: 3 cols padded to vec4
        // Pre-allocated uniform buffer data (reuse for packUniforms)
        this._uniformBufferData = new ArrayBuffer(512)  // Large enough for most cases
        this._uniformDataView = new DataView(this._uniformBufferData)
        this._uniformBufferSize = 512

        // Listen for uncaptured errors
        this.device.addEventListener('uncapturederror', (event) => {
            console.error('WebGPU uncaptured error:', event.error?.message || event.error)
        })
    }

    /**
     * Parse a global texture reference and extract the surface name.
     * Supports both "global_name" (underscore) and "globalName" (camelCase) patterns.
     * Returns null if not a global reference.
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
            if (/^[A-Z0-9]/.test(suffix)) {
                return suffix.charAt(0).toLowerCase() + suffix.slice(1)
            }
        }

        return null
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

    async init() {
        // Detect mobile device and populate capabilities
        const isMobile = WebGPUBackend.detectMobile()

        // WebGPU has good float support, but we still cap state size on mobile for memory
        this.capabilities = {
            isMobile,
            floatBlend: true,  // WebGPU always supports blending on float textures
            floatLinear: true, // WebGPU always supports linear filtering on float textures
            colorBufferFloat: true,  // WebGPU always supports float render targets
            maxDrawBuffers: 8,  // WebGPU supports many color attachments
            maxTextureSize: this.device.limits.maxTextureDimension2D || 8192,
            // Cap particle state texture size on mobile to prevent OOM
            maxStateSize: isMobile ? 512 : 2048
        }

        // Create default sampler (linear filtering)
        this.samplers.set('default', this.device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }))

        // Create nearest sampler for pixel-perfect sampling
        this.samplers.set('nearest', this.device.createSampler({
            minFilter: 'nearest',
            magFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }))

        // Create repeat sampler for tiling textures
        this.samplers.set('repeat', this.device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat'
        }))

        // Create a 1x1 black dummy texture for shaders that declare optional inputs
        const dummyTexture = this.device.createTexture({
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        })
        // Initialize to transparent black
        this.device.queue.writeTexture(
            { texture: dummyTexture },
            new Uint8Array([0, 0, 0, 0]),
            { bytesPerRow: 4 },
            { width: 1, height: 1, depthOrArrayLayers: 1 }
        )
        this.dummyTextureView = dummyTexture.createView()

        return Promise.resolve()
    }

    createTexture(id, spec) {
        const format = this.resolveFormat(spec.format)
        // Include copySrc + copyDst in default usage so the texture can serve as
        // both the source and destination of copyTextureToTexture (used by the
        // chain-handoff path at line ~480). Without copyDst Dawn rejects the
        // copy with "Destination texture needs to have CopyDst and RenderAttachment
        // usage", which surfaces as a soft validation error per affected effect.
        const usage = this.resolveUsage(spec.usage || ['render', 'sample', 'copySrc', 'copyDst'])

        const texture = this.device.createTexture({
            size: {
                width: spec.width,
                height: spec.height,
                depthOrArrayLayers: 1
            },
            format,
            usage
        })

        const view = texture.createView()

        this.textures.set(id, {
            handle: texture,
            view,
            width: spec.width,
            height: spec.height,
            format: spec.format,
            gpuFormat: format,
            usage  // Store the usage flags for later checks
        })

        return texture
    }

    /**
     * Create a 3D texture for volumetric data.
     * WebGPU has full 3D texture support including storage textures for compute shaders.
     */
    createTexture3D(id, spec) {
        const format = this.resolveFormat(spec.format)
        // Include storage usage for compute shader write access. copyDst lets
        // the chain-handoff path target this texture without Dawn rejecting.
        const usage = this.resolveUsage(spec.usage || ['storage', 'sample', 'copySrc', 'copyDst'])

        const texture = this.device.createTexture({
            size: {
                width: spec.width,
                height: spec.height,
                depthOrArrayLayers: spec.depth
            },
            dimension: '3d',
            format,
            usage
        })

        const view = texture.createView({ dimension: '3d' })

        this.textures.set(id, {
            handle: texture,
            view,
            width: spec.width,
            height: spec.height,
            depth: spec.depth,
            format: spec.format,
            gpuFormat: format,
            usage,
            is3D: true
        })

        return texture
    }

    destroyTexture(id) {
        const tex = this.textures.get(id)
        if (tex) {
            tex.handle.destroy()
            this.textures.delete(id)
        }
    }

    /**
     * Allocate a cube-map texture (6 faces, all same size).
     * @param {string} id - Texture identifier
     * @param {{ size: number }} options - Cube face edge length in pixels
     */
    createCubeTexture(id, { size }) {
        const device = this.device
        const handle = device.createTexture({
            size: [size, size, 6],
            format: 'rgba8unorm',
            dimension: '2d',
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT
        })
        const view = handle.createView({ dimension: 'cube' })
        this.textures.set(id, { handle, view, width: size, height: size, cube: true })
        return this.textures.get(id)
    }

    /**
     * Upload RGBA8 pixel data to one face of a cube-map texture.
     * Mirrors uploadDataTexture's writeTexture + 256-byte row-alignment pattern.
     * @param {string} id - Texture identifier (must have been created with createCubeTexture)
     * @param {number} face - Face index 0..5 (array layer)
     * @param {{ width: number, height: number, data: Uint8Array }} faceData
     */
    uploadCubeFace(id, face, { width, height, data }) {
        const device = this.device
        const tex = this.textures.get(id)
        // RGBA8: 4 bytes per pixel; rows must be aligned to 256 bytes for WebGPU
        const unalignedBytesPerRow = width * 4
        const bytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256

        let uploadData = data
        if (bytesPerRow !== unalignedBytesPerRow) {
            const paddedData = new Uint8Array(bytesPerRow * height)
            for (let y = 0; y < height; y++) {
                paddedData.set(data.subarray(y * unalignedBytesPerRow, (y + 1) * unalignedBytesPerRow), y * bytesPerRow)
            }
            uploadData = paddedData
        }

        device.queue.writeTexture(
            { texture: tex.handle, origin: [0, 0, face] },
            uploadData,
            { bytesPerRow, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
        )
    }

    /**
     * Upload mesh data (positions/normals/uvs) to a mesh surface's textures.
     * Used by meshLoader effect when loading OBJ files.
     * @param {string} meshId - Mesh surface ID (e.g., "mesh0")
     * @param {Float32Array} positionData - RGBA32F position data (xyz, w=valid flag)
     * @param {Float32Array} normalData - RGBA16F normal data (xyz, w=0)
     * @param {Float32Array} uvData - RGBA16F UV data (uv, zw=0)
     * @param {number} width - Texture width
     * @param {number} height - Texture height
     * @param {number} vertexCount - Number of valid vertices
     * @returns {{ success: boolean, vertexCount: number }}
     */
    uploadMeshData(meshId, positionData, normalData, uvData, width, height, vertexCount) {
        const device = this.device

        // Texture IDs
        const posId = `global_${meshId}_positions`
        const normId = `global_${meshId}_normals`
        const uvId = `global_${meshId}_uvs`

        // Helper to create/update a mesh texture
        const uploadTexture = (id, data, format, gpuFormat) => {
            let tex = this.textures.get(id)
            if (!tex || tex.width !== width || tex.height !== height) {
                if (tex) tex.handle.destroy()

                const handle = device.createTexture({
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: gpuFormat,
                    usage: GPUTextureUsage.TEXTURE_BINDING |
                           GPUTextureUsage.COPY_DST |
                           GPUTextureUsage.RENDER_ATTACHMENT |
                           GPUTextureUsage.STORAGE_BINDING
                })

                tex = {
                    handle,
                    view: handle.createView(),
                    width,
                    height,
                    format,
                    gpuFormat
                }
                this.textures.set(id, tex)
            }

            // Calculate bytes per row (must be aligned to 256 bytes for WebGPU)
            const bytesPerPixel = gpuFormat === 'rgba32float' ? 16 : 8
            const unalignedBytesPerRow = width * bytesPerPixel
            const bytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256

            // If alignment padding is needed, create padded buffer
            let uploadData = data
            if (bytesPerRow !== unalignedBytesPerRow) {
                const paddedData = new Float32Array((bytesPerRow / 4) * height)
                const srcRowFloats = width * 4
                const dstRowFloats = bytesPerRow / 4
                for (let y = 0; y < height; y++) {
                    paddedData.set(data.subarray(y * srcRowFloats, (y + 1) * srcRowFloats), y * dstRowFloats)
                }
                uploadData = paddedData
            }

            device.queue.writeTexture(
                { texture: tex.handle },
                uploadData,
                { bytesPerRow, rowsPerImage: height },
                { width, height }
            )
        }

        // Upload all three textures
        // Note: All use rgba32float because we're uploading Float32Array data.
        // WebGPU doesn't auto-convert Float32 -> Float16 like WebGL2's gl.FLOAT type does.
        uploadTexture(posId, positionData, 'rgba32f', 'rgba32float')
        uploadTexture(normId, normalData, 'rgba32f', 'rgba32float')
        uploadTexture(uvId, uvData, 'rgba32f', 'rgba32float')

        return { success: true, vertexCount }
    }

    /**
     * Upload a CPU-side Float32Array as a 2D RGBA32F texture.
     * @param {string} id - Texture identifier
     * @param {Float32Array} data - RGBA float data (width * height * 4 elements)
     * @param {number} width - Texture width
     * @param {number} height - Texture height
     */
    uploadDataTexture(id, data, width, height) {
        const device = this.device
        let tex = this.textures.get(id)
        if (!tex || tex.width !== width || tex.height !== height) {
            if (tex) tex.handle.destroy()
            const handle = device.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
            })
            this.textures.set(id, {
                handle, width, height, format: 'rgba32float',
                view: handle.createView()
            })
            tex = this.textures.get(id)
        }

        const bytesPerRow = width * 4 * 4  // 4 channels * 4 bytes per float
        const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256

        let uploadData = data
        if (alignedBytesPerRow !== bytesPerRow) {
            const srcRowFloats = width * 4
            const dstRowFloats = alignedBytesPerRow / 4
            const paddedData = new Float32Array(dstRowFloats * height)
            for (let y = 0; y < height; y++) {
                paddedData.set(data.subarray(y * srcRowFloats, (y + 1) * srcRowFloats), y * dstRowFloats)
            }
            uploadData = paddedData
        }

        device.queue.writeTexture(
            { texture: tex.handle },
            uploadData,
            { bytesPerRow: alignedBytesPerRow, rowsPerImage: height },
            { width, height }
        )
    }

    /**
     * Update a texture from an external source (video, image, canvas).
     * This is used for media input effects that need to display camera/video content.
     * @param {string} id - Texture ID
     * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap} source - Media source
     * @param {object} [options] - Update options
     * @param {boolean} [options.flipY=true] - Whether to flip the Y axis
     * @returns {{ width: number, height: number }} Source dimensions
     *
     * Must stay synchronous to match WebGL2Backend and the documented
     * CanvasRenderer contract: callers read `.width`/`.height` off the return
     * value to publish the source's intrinsic size (e.g. synth/media's
     * imageSize uniform). Declaring this `async` returned a Promise instead,
     * so those reads silently yielded undefined on WebGPU. Every write below
     * is a queue submission, so there is nothing to await.
     */
    updateTextureFromSource(id, source, options = {}) {
        let tex = this.textures.get(id)

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

        const flipY = options.flipY !== false

        // Create texture if it doesn't exist or if dimensions changed
        if (!tex || tex.width !== width || tex.height !== height) {
            if (tex) {
                tex.handle.destroy()
            }

            const texture = this.device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING |
                       GPUTextureUsage.COPY_DST |
                       GPUTextureUsage.RENDER_ATTACHMENT
            })

            const view = texture.createView()

            tex = {
                handle: texture,
                view,
                width,
                height,
                format: 'rgba8',
                gpuFormat: 'rgba8unorm',
                isExternal: true
            }
            this.textures.set(id, tex)
        }

        // Use copyExternalImageToTexture for efficient video/image upload
        this.device.queue.copyExternalImageToTexture(
            { source, flipY },
            { texture: tex.handle },
            { width, height }
        )

        return { width, height }
    }

    /**
     * Copy one texture to another (blit operation).
     * Used for surface copy operations.
     * @param {string} srcId - Source texture ID
     * @param {string} dstId - Destination texture ID
     */
    copyTexture(srcId, dstId) {
        const srcTex = this.textures.get(srcId)
        const dstTex = this.textures.get(dstId)

        if (!srcTex || !dstTex) {
            console.warn(`[copyTexture] Missing texture: src=${srcId} (${!!srcTex}), dst=${dstId} (${!!dstTex})`)
            return
        }

        // Create a command encoder for the copy operation
        const commandEncoder = this.device.createCommandEncoder()

        commandEncoder.copyTextureToTexture(
            { texture: srcTex.handle },
            { texture: dstTex.handle },
            [srcTex.width, srcTex.height, 1]
        )

        // Submit immediately
        this.device.queue.submit([commandEncoder.finish()])
    }

    /**
     * Clear a texture to transparent black.
     * Used to clear surfaces when chains are deleted.
     * @param {string} id - Texture ID
     */
    clearTexture(id) {
        const tex = this.textures.get(id)

        if (!tex) {
            return
        }

        // Create a command encoder for the clear operation
        const commandEncoder = this.device.createCommandEncoder()

        // Begin a render pass that clears to transparent black
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: tex.view,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        })

        renderPass.end()

        // Submit immediately
        this.device.queue.submit([commandEncoder.finish()])
    }

    /**
     * Resolve the WGSL shader source from a program spec.
     * Looks for sources in order: wgsl, source, fragment (for render shaders)
     */
    resolveWGSLSource(spec) {
        // Prefer explicit WGSL source
        if (spec.wgsl) return spec.wgsl

        // Fall back to generic source field
        if (spec.source) return spec.source

        // For fragment shaders, might be under 'fragment' key
        if (spec.fragment && !spec.fragment.includes('#version')) {
            return spec.fragment
        }

        return null
    }

    async compileProgram(id, spec) {
        const source = this.resolveWGSLSource(spec)

        if (!source) {
            throw {
                code: 'ERR_NO_WGSL_SOURCE',
                detail: `No WGSL shader source found for program '${id}'. Available keys: ${Object.keys(spec).join(', ')}`,
                program: id
            }
        }

        // Inject defines
        const processedSource = this.injectDefines(source, spec.defines || {})

        // Detect shader type from source - @compute vs @fragment
        const hasComputeEntry = /@compute\s/.test(processedSource)
        const hasFragmentEntry = /@fragment\s/.test(processedSource)

        // Detect entry point names from source
        const detectedEntryPoints = this.detectEntryPoints(processedSource)
        const enhancedSpec = {
            ...spec,
            fragmentEntryPoint: detectedEntryPoints.fragment || spec.fragmentEntryPoint,
            vertexEntryPoint: detectedEntryPoints.vertex || spec.vertexEntryPoint,
            computeEntryPoint: detectedEntryPoints.compute || spec.computeEntryPoint
        }

        // IMPORTANT: If shader has @compute but no @fragment, ALWAYS compile as compute
        // This handles cases where definition says "render" but WGSL is a compute shader
        if (hasComputeEntry && !hasFragmentEntry) {
            return this.compileComputeProgram(id, processedSource, enhancedSpec)
        }

        // If shader has @fragment, compile as render (even if it also has @compute)
        if (hasFragmentEntry) {
            return this.compileRenderProgram(id, processedSource, enhancedSpec)
        }

        // Fallback: compile as render
        return this.compileRenderProgram(id, processedSource, enhancedSpec)
    }

    /**
     * Detect entry point names from WGSL source.
     * Looks for @vertex fn name and @fragment fn name patterns.
     */
    detectEntryPoints(source) {
        const result = { vertex: null, fragment: null, compute: null }

        // Match @vertex fn name
        const vertexMatch = /@vertex\s*\n?\s*fn\s+(\w+)/.exec(source)
        if (vertexMatch) {
            result.vertex = vertexMatch[1]
        }

        // Match @fragment fn name
        const fragmentMatch = /@fragment\s*\n?\s*fn\s+(\w+)/.exec(source)
        if (fragmentMatch) {
            result.fragment = fragmentMatch[1]
        }

        // Match @compute fn name
        const computeMatch = /@compute[^f]*fn\s+(\w+)/.exec(source)
        if (computeMatch) {
            result.compute = computeMatch[1]
        }

        return result
    }

    /**
     * Parse which bindings are used by each entry point in a multi-entry-point shader.
     * Returns a Map of entryPoint -> Set of binding indices.
     */
    parseEntryPointBindings(source, bindings) {
        const entryPointBindings = new Map()

        // Find all entry points with their function bodies
        const entryPointRegex = /@(?:compute|vertex|fragment)[^f]*fn\s+(\w+)\s*\([^)]*\)[^{]*\{/g
        let match

        while ((match = entryPointRegex.exec(source)) !== null) {
            const entryPoint = match[1]
            const startIdx = match.index + match[0].length

            // Find the matching closing brace (simple brace counting)
            let braceCount = 1
            let endIdx = startIdx
            for (let i = startIdx; i < source.length && braceCount > 0; i++) {
                if (source[i] === '{') braceCount++
                else if (source[i] === '}') braceCount--
                endIdx = i
            }

            const functionBody = source.slice(startIdx, endIdx)
            const usedBindings = new Set()

            // Check which binding names are referenced in this function body
            for (const binding of bindings) {
                // Look for the binding name as a word (not part of another identifier)
                const nameRegex = new RegExp(`\\b${binding.name}\\b`)
                if (nameRegex.test(functionBody)) {
                    usedBindings.add(binding.binding)
                }
            }

            entryPointBindings.set(entryPoint, usedBindings)
        }

        return entryPointBindings
    }

    async compileComputeProgram(id, source, spec) {
        //const _t0 = performance.now()
        const module = this.device.createShaderModule({ code: source })
        //const _tModule = performance.now()
        const compilationInfo = await module.getCompilationInfo()
        //const _tInfo = performance.now()
        const errors = compilationInfo.messages.filter(m => m.type === 'error')

        if (errors.length > 0) {
            throw {
                code: 'ERR_SHADER_COMPILE',
                detail: errors.map(e => `Line ${e.lineNum}: ${e.message}`).join('\n'),
                program: id
            }
        }

        // Parse binding declarations from the shader
        const bindings = this.parseShaderBindings(source)

        // Detect all compute entry points in the shader
        const entryPoints = []
        const entryPointRegex = /@compute[^f]*fn\s+(\w+)/g
        let match
        while ((match = entryPointRegex.exec(source)) !== null) {
            entryPoints.push(match[1])
        }

        // Parse which bindings each entry point uses (for multi-entry-point shaders)
        const entryPointBindings = this.parseEntryPointBindings(source, bindings)

        // Create pipelines map for multi-entry-point support
        const pipelines = new Map()

        // Create default pipeline for the first/specified entry point
        const defaultEntryPoint = spec.computeEntryPoint || entryPoints[0] || 'main'
        //const _tBeforePipeline = performance.now()
        const defaultPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module,
                entryPoint: defaultEntryPoint
            }
        })
        //const _tPipeline = performance.now()
        pipelines.set(defaultEntryPoint, defaultPipeline)

        // Knob 1: per-phase compile timings (logging only — see HANDOFF-shader-compile.md)
        //console.log(`[compile-wgsl-compute ${id}] module=${(_tModule - _t0).toFixed(1)}ms info=${(_tInfo - _tModule).toFixed(1)}ms pipeline=${(_tPipeline - _tBeforePipeline).toFixed(1)}ms total=${(_tPipeline - _t0).toFixed(1)}ms src=${source.length}b`)

        const programInfo = {
            module,
            pipeline: defaultPipeline,  // Keep for backward compatibility
            pipelines,  // Map of entry point -> pipeline
            isCompute: true,
            entryPoint: defaultEntryPoint,
            entryPoints,  // All available entry points
            entryPointBindings,  // Map of entry point -> Set of used binding indices
            bindings,  // Store parsed bindings for bind group creation
            // True if the source contains any `@binding` declarations at all,
            // even ones we filtered out as dead. Used by createBindGroup to
            // distinguish "modern shader, all bindings filtered as dead" (use
            // empty bind group) from "legacy shader, no bindings declared"
            // (fall back to legacy entry builder).
            _sourceHasBindings: this.hasShaderBindings(source),
            // Use definition-provided uniformLayout if available, fall back to shader parsing
            packedUniformLayout: spec.uniformLayout || this.parsePackedUniformLayout(source),
            // Minimum size of any var<uniform> struct in the shader (computed from
            // the source). The bind-group buffer must be at least this big or
            // Dawn rejects with "Binding size (X) is smaller than the minimum
            // binding size (Y)". Catches cases where the packed-layout parser
            // under-estimates because the shader only references a subset of slots.
            declaredUniformBufferSize: this.parseDeclaredUniformBufferSize(source)
        }

        this.programs.set(id, programInfo)
        return programInfo
    }

    async compileRenderProgram(id, source, spec) {
        //const _t0 = performance.now()
        // Parse binding declarations from the shader
        let bindings = this.parseShaderBindings(source)
        let sourceHasBindings = this.hasShaderBindings(source)

        // Check if source contains @vertex (combined shader)
        const hasVertex = /@vertex\s/.test(source)

        // Compile module (will be used for both vertex and fragment if combined)
        const mainModule = this.device.createShaderModule({ code: source })
        //const _tModule = performance.now()
        const moduleInfo = await mainModule.getCompilationInfo()
        //const _tInfo = performance.now()
        const moduleErrors = moduleInfo.messages.filter(m => m.type === 'error')

        if (moduleErrors.length > 0) {
            throw {
                code: 'ERR_SHADER_COMPILE',
                detail: moduleErrors.map(e => `Line ${e.lineNum}: ${e.message}`).join('\n'),
                program: id
            }
        }

        // Handle vertex module
        let vertexModule
        let vertexEntryPoint
        let fragmentModule = mainModule

        if (spec.vertexWGSL || spec.vertexWgsl) {
            // Separate vertex shader source provided
            const vertexSource = spec.vertexWGSL || spec.vertexWgsl
            vertexModule = this.device.createShaderModule({ code: vertexSource })
            const vertexInfo = await vertexModule.getCompilationInfo()
            const vertexErrors = vertexInfo.messages.filter(m => m.type === 'error')

            if (vertexErrors.length > 0) {
                throw {
                    code: 'ERR_SHADER_COMPILE',
                    detail: vertexErrors.map(e => `Line ${e.lineNum}: ${e.message}`).join('\n'),
                    program: id
                }
            }

            vertexEntryPoint = spec.vertexEntryPoint || DEFAULT_VERTEX_ENTRY_POINT

            // Parse vertex shader bindings and merge with fragment bindings
            const vertexBindings = this.parseShaderBindings(vertexSource)
            sourceHasBindings = sourceHasBindings || this.hasShaderBindings(vertexSource)
            if (vertexBindings.length > 0) {
                // Merge, preferring vertex bindings for conflicts (same group/binding)
                const bindingKey = b => `${b.group}:${b.binding}`
                const existingKeys = new Set(bindings.map(bindingKey))
                for (const vb of vertexBindings) {
                    if (!existingKeys.has(bindingKey(vb))) {
                        bindings.push(vb)
                    }
                }
                // Re-sort by group then binding
                bindings.sort((a, b) => {
                    if (a.group !== b.group) return a.group - b.group
                    return a.binding - b.binding
                })
            }
        } else if (hasVertex) {
            // Combined shader - same module for vertex and fragment
            vertexModule = mainModule
            vertexEntryPoint = spec.vertexEntryPoint || DEFAULT_VERTEX_ENTRY_POINT
        } else {
            // No vertex in source, use default fullscreen triangle
            vertexModule = this.getDefaultVertexModule()
            vertexEntryPoint = DEFAULT_VERTEX_ENTRY_POINT
        }

        const fragmentEntryPoint = spec.fragmentEntryPoint || spec.entryPoint || DEFAULT_FRAGMENT_ENTRY_POINT
        const outputFormat = this.resolveFormat(spec?.outputFormat || 'rgba16float')

        // Create initial pipeline
        //const _tBeforePipeline = performance.now()
        const pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: vertexEntryPoint
            },
            fragment: {
                module: fragmentModule,
                entryPoint: fragmentEntryPoint,
                targets: [{
                    format: outputFormat,
                    blend: this.resolveBlendState(spec?.blend)
                }]
            },
            primitive: {
                topology: spec?.topology || 'triangle-list'
            }
        })
        //const _tPipeline = performance.now()

        // Knob 1: per-phase compile timings (logging only — see HANDOFF-shader-compile.md)
        //console.log(`[compile-wgsl-render ${id}] module=${(_tModule - _t0).toFixed(1)}ms info=${(_tInfo - _tModule).toFixed(1)}ms pipeline=${(_tPipeline - _tBeforePipeline).toFixed(1)}ms total=${(_tPipeline - _t0).toFixed(1)}ms src=${source.length}b`)

        // Create pipeline cache for different output formats/blend modes
        const pipelineCache = new Map()
        const initialKey = this.getPipelineKey({
            topology: spec?.topology,
            blend: spec?.blend,
            format: outputFormat
        })
        pipelineCache.set(initialKey, pipeline)

        const programInfo = {
            module: fragmentModule,
            pipeline,
            isCompute: false,
            vertexModule,
            fragmentModule,
            vertexEntryPoint,
            fragmentEntryPoint,
            outputFormat,
            pipelineCache,
            bindings, // Store parsed bindings for bind group creation
            // See compileComputeProgram for what this flag is for.
            _sourceHasBindings: sourceHasBindings,
            // Use definition-provided uniformLayout if available, fall back to shader parsing
            packedUniformLayout: spec.uniformLayout || this.parsePackedUniformLayout(source),
            // Minimum size of any var<uniform> struct in the shader (computed from
            // the source). The bind-group buffer must be at least this big or
            // Dawn rejects with "Binding size (X) is smaller than the minimum
            // binding size (Y)". Catches cases where the packed-layout parser
            // under-estimates because the shader only references a subset of slots.
            declaredUniformBufferSize: this.parseDeclaredUniformBufferSize(source)
        }

        this.programs.set(id, programInfo)
        return programInfo
    }

    /**
     * Parse the source for `var<uniform> name: StructName;` and return the
     * minimum byte size of the referenced struct, computed from its field
     * declarations. Handles `array<vec4<f32>, N>`, `array<f32, N>`, scalar
     * fields, and vector fields. Returns 0 if no struct is found.
     *
     * Used as a buffer-size floor in createUniformBuffer so the runtime never
     * allocates a uniform buffer smaller than the shader's declared struct,
     * which Dawn rejects.
     */
    parseDeclaredUniformBufferSize(source) {
        // Find any struct used as a uniform binding.
        const bindingRegex = /var<uniform>\s+\w+\s*:\s*(\w+)\s*;/g
        let largestSize = 0
        let bindingMatch
        while ((bindingMatch = bindingRegex.exec(source)) !== null) {
            const structName = bindingMatch[1]
            // Find the matching struct declaration.
            const structRegex = new RegExp(`struct\\s+${structName}\\s*\\{([^}]+)\\}`, 'g')
            const structMatch = structRegex.exec(source)
            if (!structMatch) continue
            const body = structMatch[1]
            // Compute the byte size of the struct body.
            const size = this.computeWgslStructSize(body)
            if (size > largestSize) largestSize = size
        }
        return largestSize
    }

    /**
     * Given the body of a WGSL struct (the contents inside the braces),
     * compute its minimum byte size following std140-compatible alignment
     * rules used by WebGPU uniform buffers.
     *
     * This is a defensive estimator — it errs toward larger sizes when in
     * doubt, since over-allocation is harmless but under-allocation causes
     * Dawn to reject the bind group.
     */
    computeWgslStructSize(body) {
        // Strip line comments so they don't interfere with field parsing.
        const cleaned = body.replace(/\/\/[^\n]*/g, '')

        // Split the struct body into fields at top-level commas only —
        // commas inside `<>` (generic args like `array<vec4<f32>, 2>`) must
        // not split a field. A naive `[^,]+` regex would break on the inner
        // comma and miss the second half of the type expression.
        const fields = []
        let depth = 0
        let start = 0
        for (let i = 0; i < cleaned.length; i++) {
            const c = cleaned[i]
            if (c === '<') depth++
            else if (c === '>') depth--
            else if ((c === ',' || c === ';') && depth === 0) {
                const piece = cleaned.slice(start, i).trim()
                if (piece) fields.push(piece)
                start = i + 1
            }
        }
        const tail = cleaned.slice(start).trim()
        if (tail) fields.push(tail)

        let offset = 0
        let maxAlign = 4
        for (const field of fields) {
            // Each field is `name: type` (possibly with @align/@size attrs).
            // We don't honor those attrs — over-allocation is harmless, under
            // is what we're trying to avoid — so just split on the first colon.
            const colonIdx = field.indexOf(':')
            if (colonIdx < 0) continue
            const typeExpr = field.slice(colonIdx + 1).trim()
            const { size, align } = this.computeWgslTypeSize(typeExpr)
            if (size === 0) continue
            offset = Math.ceil(offset / align) * align
            offset += size
            if (align > maxAlign) maxAlign = align
        }
        // WGSL struct size is rounded up to the largest member alignment.
        return Math.ceil(offset / maxAlign) * maxAlign
    }

    /**
     * Compute size + alignment for a WGSL type expression. Returns
     * { size: 0, align: 4 } for unrecognized types.
     */
    computeWgslTypeSize(typeExpr) {
        // array<T, N> — N is required for uniform-buffer use
        const arrayMatch = /^array\s*<\s*(.+?)\s*,\s*(\d+)\s*>$/.exec(typeExpr)
        if (arrayMatch) {
            const elemType = arrayMatch[1]
            const count = parseInt(arrayMatch[2], 10)
            const elem = this.computeWgslTypeSize(elemType)
            // For uniform buffers, the array stride is rounded up to 16.
            const stride = Math.max(elem.size, 16)
            return { size: stride * count, align: Math.max(elem.align, 16) }
        }
        // Scalars and vectors
        const t = typeExpr.replace(/\s+/g, '')
        const map = {
            'f32': { size: 4, align: 4 },
            'i32': { size: 4, align: 4 },
            'u32': { size: 4, align: 4 },
            'f16': { size: 2, align: 2 },
            'bool': { size: 4, align: 4 },
            'vec2<f32>': { size: 8, align: 8 },
            'vec2f': { size: 8, align: 8 },
            'vec2<i32>': { size: 8, align: 8 },
            'vec2i': { size: 8, align: 8 },
            'vec2<u32>': { size: 8, align: 8 },
            'vec2u': { size: 8, align: 8 },
            'vec3<f32>': { size: 12, align: 16 },
            'vec3f': { size: 12, align: 16 },
            'vec3<i32>': { size: 12, align: 16 },
            'vec3i': { size: 12, align: 16 },
            'vec3<u32>': { size: 12, align: 16 },
            'vec3u': { size: 12, align: 16 },
            'vec4<f32>': { size: 16, align: 16 },
            'vec4f': { size: 16, align: 16 },
            'vec4<i32>': { size: 16, align: 16 },
            'vec4i': { size: 16, align: 16 },
            'vec4<u32>': { size: 16, align: 16 },
            'vec4u': { size: 16, align: 16 },
            'mat3x3<f32>': { size: 48, align: 16 },
            'mat3x3f': { size: 48, align: 16 },
            'mat4x4<f32>': { size: 64, align: 16 },
            'mat4x4f': { size: 64, align: 16 },
        }
        return map[t] || { size: 0, align: 4 }
    }

    /**
     * Parse WGSL shader to extract packed uniform layout.
     *
     * Supports multiple patterns:
     * 1. Array-based: uniforms.data[N].xyz unpacking statements
     * 2. Named struct with comments: struct FooParams { field : vec4<f32>, // (name1, name2, name3, name4) }
     * 3. Named struct with params. prefix: let x = params.field.x; patterns
     *
     * Returns an array of {name, slot, components} sorted by slot then component offset.
     *
     * @param {string} source - WGSL shader source
     * @returns {Array<{name: string, slot: number, components: string}>|null}
     */
    parsePackedUniformLayout(source) {
        // Try byte-based struct layout for direct field access (u.field pattern)
        const byteLayout = this.parseWgslStructByteLayout(source)
        if (byteLayout && byteLayout.length > 0) {
            return { type: 'byte', layout: byteLayout }
        }

        // Try to parse named struct with comment annotations
        const namedStructLayout = this.parseNamedStructLayout(source)
        if (namedStructLayout && namedStructLayout.length > 0) {
            return namedStructLayout
        }

        // Try to parse params.field.component access patterns
        const paramsAccessLayout = this.parseParamsAccessLayout(source)
        if (paramsAccessLayout && paramsAccessLayout.length > 0) {
            return paramsAccessLayout
        }

        // Fall back to array-based pattern (uniforms.data[N])
        if (!source.includes('uniforms.data[')) {
            return null
        }

        const layout = []
        // Match various unpacking patterns:
        // - varName = uniforms.data[N].xyz;
        // - let varName: type = uniforms.data[N].xyz;
        // - varName = i32(uniforms.data[N].x);
        // - varName = uniforms.data[N].xyz > 0.5; (for booleans)
        // - varName = max(1, i32(uniforms.data[N].w)); (for clamped values)
        // The regex captures the variable name (which may follow 'let' and have a type annotation)
        // IMPORTANT: [^\n=]+ prevents matching across newlines/equals, avoiding greedy struct field capture
        const unpackRegex = /(?:let\s+)?(\w+)(?:\s*:\s*[^\n=]+)?\s*=\s*(?:max\s*\([^,]+,\s*)?(?:i32\s*\(\s*)?uniforms\.data\[(\d+)\]\.([xyzw]+)/g

        let match
        while ((match = unpackRegex.exec(source)) !== null) {
            const name = match[1]
            const slot = parseInt(match[2], 10)
            const components = match[3]

            layout.push({ name, slot, components })
        }

        if (layout.length === 0) {
            return null
        }

        // Sort by slot, then by component offset (x=0, y=1, z=2, w=3)
        const componentOrder = { x: 0, y: 1, z: 2, w: 3 }
        layout.sort((a, b) => {
            if (a.slot !== b.slot) return a.slot - b.slot
            return componentOrder[a.components[0]] - componentOrder[b.components[0]]
        })

        return layout
    }

    /**
     * Parse WGSL struct layout with byte offsets for direct field access patterns.
     * Handles structs where fields are accessed as u.fieldName (not u.field.component).
     * Calculates proper WGSL alignment for each field.
     *
     * NOTE: This function skips structs that have comment annotations with component names
     * like `// (width, height, channels, frequency)` - those should be handled by
     * parseNamedStructLayout instead which maps individual uniform names to struct components.
     *
     * @param {string} source - WGSL shader source
     * @returns {Array<{name: string, offset: number, size: number, type: string}>|null}
     */
    parseWgslStructByteLayout(source) {
        // Find struct definitions named Uniforms, Params, etc.
        const structRegex = /struct\s+(\w*(?:Params|Uniforms|Config|Settings))\s*\{([^}]+)\}/gi
        const structMatch = structRegex.exec(source)

        if (!structMatch) {
            return null
        }

        const structBody = structMatch[2]

        // Skip structs that contain array fields - they use different packing
        if (/\barray\s*</.test(structBody)) {
            return null
        }

        // Skip structs that have comment annotations with component names
        // These should be handled by parseNamedStructLayout which properly maps
        // individual uniform names (width, height, time, etc.) to struct field components
        // Pattern: // (name1, name2, name3, name4) — a comma-separated identifier list.
        // Require the comma-separated list of identifiers so prose comments that merely
        // contain parentheses (e.g. "// (metric was here — now a compile-time define)")
        // don't false-trigger the slot-based parser, which would mispack a struct of
        // plain named fields and leave the shader reading garbage uniforms.
        if (/\/\/\s*\(\s*\w+(?:\s*,\s*\w+)+\s*\)/.test(structBody)) {
            return null
        }

        // Check if this struct is used as a uniform binding with a simple variable name
        // Pattern: var<uniform> u: Uniforms; or var<uniform> params: SomeParams;
        const structName = structMatch[1]
        const bindingRegex = new RegExp(`var<uniform>\\s+(\\w+)\\s*:\\s*${structName}\\s*;`)
        const bindingMatch = bindingRegex.exec(source)

        if (!bindingMatch) {
            return null
        }

        const uniformVarName = bindingMatch[1]

        // Parse fields with WGSL type syntax
        // Handles: fieldName: f32, fieldName: vec2f, fieldName: vec3<f32>, etc.
        const fieldRegex = /(\w+)\s*:\s*(f32|i32|u32|vec2f|vec3f|vec4f|vec2<f32>|vec3<f32>|vec4<f32>|vec2i|vec3i|vec4i|vec2<i32>|vec3<i32>|vec4<i32>|vec2u|vec3u|vec4u|vec2<u32>|vec3<u32>|vec4<u32>)/gi

        const layout = []
        let offset = 0
        let maxAlign = 4  // Track max alignment for struct size rounding

        let fieldMatch
        while ((fieldMatch = fieldRegex.exec(structBody)) !== null) {
            const fieldName = fieldMatch[1]
            const fieldType = fieldMatch[2].toLowerCase()

            const { size, align, baseType, components } = this.getWgslTypeInfo(fieldType)
            maxAlign = Math.max(maxAlign, align)

            // Apply alignment
            offset = Math.ceil(offset / align) * align

            // Skip padding/internal fields from the layout, but still advance offset
            if (fieldName.startsWith('_') || fieldName.toLowerCase().startsWith('pad')) {
                offset += size
                continue
            }

            layout.push({
                name: fieldName,
                offset,
                size,
                type: baseType,
                components
            })

            offset += size
        }

        // WGSL struct size must be multiple of largest member alignment
        const structSize = Math.ceil(offset / maxAlign) * maxAlign

        // Verify that the struct variable is used in shader code
        // Check for patterns like: u.fieldName
        const usageRegex = new RegExp(`${uniformVarName}\\.(\\w+)`)
        if (!usageRegex.test(source)) {
            return null
        }

        // Return layout with structSize metadata
        if (layout.length > 0) {
            layout.structSize = structSize
            return layout
        }
        return null
    }

    /**
     * Get size, alignment, and type info for WGSL types.
     */
    getWgslTypeInfo(type) {
        const typeMap = {
            'f32': { size: 4, align: 4, baseType: 'float', components: 1 },
            'i32': { size: 4, align: 4, baseType: 'int', components: 1 },
            'u32': { size: 4, align: 4, baseType: 'uint', components: 1 },
            'vec2f': { size: 8, align: 8, baseType: 'float', components: 2 },
            'vec2<f32>': { size: 8, align: 8, baseType: 'float', components: 2 },
            'vec3f': { size: 12, align: 16, baseType: 'float', components: 3 },
            'vec3<f32>': { size: 12, align: 16, baseType: 'float', components: 3 },
            'vec4f': { size: 16, align: 16, baseType: 'float', components: 4 },
            'vec4<f32>': { size: 16, align: 16, baseType: 'float', components: 4 },
            'vec2i': { size: 8, align: 8, baseType: 'int', components: 2 },
            'vec2<i32>': { size: 8, align: 8, baseType: 'int', components: 2 },
            'vec3i': { size: 12, align: 16, baseType: 'int', components: 3 },
            'vec3<i32>': { size: 12, align: 16, baseType: 'int', components: 3 },
            'vec4i': { size: 16, align: 16, baseType: 'int', components: 4 },
            'vec4<i32>': { size: 16, align: 16, baseType: 'int', components: 4 },
            'vec2u': { size: 8, align: 8, baseType: 'uint', components: 2 },
            'vec2<u32>': { size: 8, align: 8, baseType: 'uint', components: 2 },
            'vec3u': { size: 12, align: 16, baseType: 'uint', components: 3 },
            'vec3<u32>': { size: 12, align: 16, baseType: 'uint', components: 3 },
            'vec4u': { size: 16, align: 16, baseType: 'uint', components: 4 },
            'vec4<u32>': { size: 16, align: 16, baseType: 'uint', components: 4 },
        }
        return typeMap[type.toLowerCase()] || { size: 4, align: 4, baseType: 'float', components: 1 }
    }

    /**
     * Parse WGSL struct definition with comment annotations to extract uniform layout.
     * Looks for patterns like:
     *   struct FooParams {
     *       dims_freq : vec4<f32>,  // (width, height, channels, frequency)
     *       settings : vec4<f32>,   // (octaves, displacement, splineOrder, _)
     *   }
     *
     * @param {string} source - WGSL shader source
     * @returns {Array<{name: string, slot: number, components: string}>|null}
     */
    parseNamedStructLayout(source) {
        const layout = []
        const componentNames = ['x', 'y', 'z', 'w']

        // Find struct definitions that look like param structs (name ends with Params, Uniforms, etc.)
        const structRegex = /struct\s+(\w*(?:Params|Uniforms|Config|Settings))\s*\{([^}]+)\}/gi

        let structMatch
        while ((structMatch = structRegex.exec(source)) !== null) {
            const structBody = structMatch[2]
            let slot = 0

            // Parse each field in the struct
            // Pattern: fieldName : type, // (name1, name2, name3, name4)
            // Also handles fields without comments
            const fieldRegex = /(\w+)\s*:\s*(vec[234]<f32>|f32|i32|u32|array<[^>]+>)[^,;\n]*(?:,|;)?\s*(?:\/\/\s*\(([^)]+)\))?/gi

            let fieldMatch
            while ((fieldMatch = fieldRegex.exec(structBody)) !== null) {
                const fieldName = fieldMatch[1]
                const fieldType = fieldMatch[2]
                const commentNames = fieldMatch[3]

                // Determine field size in vec4 slots
                let numComponents = 4 // Default to vec4
                if (fieldType === 'f32' || fieldType === 'i32' || fieldType === 'u32') {
                    numComponents = 1
                } else if (fieldType.startsWith('vec2')) {
                    numComponents = 2
                } else if (fieldType.startsWith('vec3')) {
                    numComponents = 3
                } else if (fieldType.startsWith('vec4')) {
                    numComponents = 4
                }

                if (commentNames) {
                    // Parse comment: (name1, name2, name3, name4) or (name1, name2, _, _)
                    const names = commentNames.split(',').map(n => n.trim())

                    for (let i = 0; i < Math.min(names.length, numComponents); i++) {
                        const name = names[i]
                        // Skip placeholders like '_', 'pad', 'unused', 'padding', '_pad0', etc.
                        if (name && name !== '_' && !name.toLowerCase().startsWith('pad') &&
                            !name.toLowerCase().startsWith('unused') && !name.startsWith('_')) {
                            layout.push({
                                name,
                                slot,
                                components: componentNames[i]
                            })
                        }
                    }
                } else {
                    // No comment - use the field name as the uniform name for single-component fields
                    // or skip for vec4 fields (they're typically packed internal storage)
                    if (numComponents === 1) {
                        layout.push({
                            name: fieldName,
                            slot,
                            components: 'x'
                        })
                    }
                }

                // Advance slot counter (each vec4 is one slot, smaller types also take one slot due to WGSL padding)
                slot++
            }
        }

        return layout.length > 0 ? layout : null
    }

    /**
     * Parse WGSL shader for params.field.component access patterns.
     * Looks for patterns like:
     *   let frequency = params.dims_freq.w;
     *   let time = params.settings.y;
     *
     * This works with named structs by analyzing how fields are accessed.
     *
     * @param {string} source - WGSL shader source
     * @returns {Array<{name: string, slot: number, components: string}>|null}
     */
    parseParamsAccessLayout(source) {
        const layout = []
        const fieldSlots = new Map() // Map field name to slot index

        // First, parse the struct to get field order
        const structRegex = /struct\s+\w*(?:Params|Uniforms|Config|Settings)\s*\{([^}]+)\}/gi
        const structMatch = structRegex.exec(source)

        if (!structMatch) {
            return null
        }

        const structBody = structMatch[1]
        const fieldOrderRegex = /(\w+)\s*:\s*(?:vec[234]<f32>|f32|i32|u32|array<[^>]+>)/gi

        let slot = 0
        let fieldMatch
        while ((fieldMatch = fieldOrderRegex.exec(structBody)) !== null) {
            fieldSlots.set(fieldMatch[1], slot)
            slot++
        }

        // Now parse access patterns: let varName = params.fieldName.component;
        // or: varName = params.fieldName.component;
        const accessRegex = /(?:let\s+)?(\w+)(?:\s*:\s*[^=\n]+)?\s*=\s*(?:i32\s*\(\s*)?params\.(\w+)\.([xyzw]+)/g

        let accessMatch
        while ((accessMatch = accessRegex.exec(source)) !== null) {
            const varName = accessMatch[1]
            const fieldName = accessMatch[2]
            const components = accessMatch[3]

            const fieldSlot = fieldSlots.get(fieldName)
            if (fieldSlot !== undefined) {
                layout.push({
                    name: varName,
                    slot: fieldSlot,
                    components
                })
            }
        }

        // Sort by slot, then by component offset
        const componentOrder = { x: 0, y: 1, z: 2, w: 3 }
        layout.sort((a, b) => {
            if (a.slot !== b.slot) return a.slot - b.slot
            return componentOrder[a.components[0]] - componentOrder[b.components[0]]
        })

        return layout.length > 0 ? layout : null
    }

    /**
     * Parse WGSL shader source to extract binding declarations.
     * Returns an array of binding info objects sorted by binding index.
     *
     * @param {string} source - WGSL shader source
     * @returns {Array<{binding: number, group: number, type: string, name: string}>}
     */
    parseShaderBindings(source) {
        const bindings = []
        const sourceNoComments = this.stripWGSLComments(source)

        // Match @group(N) @binding(M) var<...> name or @group(N) @binding(M) var name
        // Patterns:
        // @group(0) @binding(0) var<uniform> name: type;
        // @group(0) @binding(0) var name: texture_2d<f32>;
        // @group(0) @binding(0) var name: sampler;
        // @group(0) @binding(0) var name: texture_storage_2d<rgba16float, write>;
        const bindingRegex = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+)/g

        let match
        while ((match = bindingRegex.exec(sourceNoComments)) !== null) {
            const group = parseInt(match[1], 10)
            const binding = parseInt(match[2], 10)
            const storage = match[3] || '' // e.g., 'uniform', 'storage, read_write'
            const name = match[4]
            const typeDecl = match[5].trim()

            // Determine binding type
            let bindingType = 'unknown'
            if (typeDecl.includes('texture_storage_2d')) {
                bindingType = 'storage_texture'
            } else if (typeDecl.includes('texture_2d') || typeDecl.includes('texture_3d')) {
                bindingType = 'texture'
            } else if (typeDecl === 'sampler') {
                bindingType = 'sampler'
            } else if (storage.includes('uniform')) {
                bindingType = 'uniform'
            } else if (storage.includes('storage')) {
                bindingType = 'storage'
            }

            bindings.push({
                group,
                binding,
                type: bindingType,
                name,
                storage,
                typeDecl
            })
        }

        // Drop bindings that are declared but never referenced anywhere in the
        // shader body. Dawn's auto-generated bind group layout DCEs unused
        // bindings, so if we still hand them to createBindGroup we get a
        // "binding index N not present in the bind group layout" error from
        // the asynchronous validation path (which the synchronous try/catch
        // around createBindGroup can't see, since WebGPU validation errors
        // surface via the uncaptured error event, not as thrown exceptions).
        //
        // Strategy: strip comments, then count word-boundary occurrences
        // of each binding name. A count of 1 means only the declaration line
        // mentions it, so the binding is dead. Storage textures are never
        // dropped — they're typically MRT outputs whose name only appears in
        // textureStore() calls that the regex would match anyway, but we
        // exclude them defensively to avoid corrupting compute pipelines.
        const filtered = bindings.filter(b => {
            if (b.type === 'storage_texture' || b.type === 'storage') return true
            // Match `name` as a whole word (so `inputTex` doesn't match `inputTex2`).
            const re = new RegExp(`\\b${b.name}\\b`, 'g')
            const count = (sourceNoComments.match(re) || []).length
            return count > 1
        })

        // Sort by group then binding
        filtered.sort((a, b) => {
            if (a.group !== b.group) return a.group - b.group
            return a.binding - b.binding
        })

        return filtered
    }

    hasShaderBindings(source) {
        return /@binding\s*\(/.test(this.stripWGSLComments(source))
    }

    stripWGSLComments(source) {
        let stripped = ''
        let blockDepth = 0

        for (let i = 0; i < source.length;) {
            const char = source[i]
            const next = source[i + 1]

            if (blockDepth > 0) {
                if (char === '/' && next === '*') {
                    stripped += '  '
                    blockDepth++
                    i += 2
                } else if (char === '*' && next === '/') {
                    stripped += '  '
                    blockDepth--
                    i += 2
                } else {
                    stripped += char === '\n' ? '\n' : ' '
                    i++
                }
            } else if (char === '/' && next === '/') {
                stripped += '  '
                i += 2
                while (i < source.length && source[i] !== '\n') {
                    stripped += ' '
                    i++
                }
            } else if (char === '/' && next === '*') {
                stripped += '  '
                blockDepth = 1
                i += 2
            } else {
                stripped += char
                i++
            }
        }

        return stripped
    }

    getDefaultVertexModule() {
        if (!this.defaultVertexModule) {
            this.defaultVertexModule = this.device.createShaderModule({
                code: DEFAULT_VERTEX_SHADER_WGSL
            })
        }
        return this.defaultVertexModule
    }

    injectDefines(source, defines) {
        if (!defines || Object.keys(defines).length === 0) {
            return source
        }

        let injected = ''

        for (const [key, value] of Object.entries(defines)) {
            // WGSL uses const declarations instead of #define
            if (typeof value === 'boolean') {
                injected += `const ${key}: bool = ${value};\n`
            } else if (typeof value === 'number') {
                if (Number.isInteger(value)) {
                    injected += `const ${key}: i32 = ${value};\n`
                } else {
                    injected += `const ${key}: f32 = ${value};\n`
                }
            } else {
                injected += `const ${key} = ${value};\n`
            }
        }

        return injected + source
    }

    executePass(pass, state) {
        const program = this.programs.get(pass.program)


        if (!program) {
            throw {
                code: 'ERR_PROGRAM_NOT_FOUND',
                pass: pass.id,
                program: pass.program
            }
        }

        if (program.isCompute) {
            this.executeComputePass(pass, program, state)
        } else {
            this.executeRenderPass(pass, program, state)
        }
    }

    executeRenderPass(pass, program, state) {
        // Check for MRT (Multiple Render Targets)
        const outputKeys = Object.keys(pass.outputs || {})
        const isMRT = pass.drawBuffers > 1 || outputKeys.length > 1

        if (isMRT) {
            this.executeMRTRenderPass(pass, program, state, outputKeys)
            return
        }

        // Single output pass (original logic)
        let outputId = pass.outputs.color || Object.values(pass.outputs)[0]

        // Resolve global output to current write buffer
        const outputSurfaceName = this.parseGlobalName(outputId)
        if (outputSurfaceName) {
            if (state.writeSurfaces && state.writeSurfaces[outputSurfaceName]) {
                outputId = state.writeSurfaces[outputSurfaceName]
            }
        }

        let outputTex = this.textures.get(outputId) || state.surfaces?.[outputId]
        let targetView = outputTex?.view

        // Handle screen output (direct to canvas)
        if (!outputTex && outputId === 'screen' && this.context) {
            const currentTexture = this.context.getCurrentTexture()
            outputTex = {
                handle: currentTexture,
                view: currentTexture.createView(),
                width: this.context.canvas?.width,
                height: this.context.canvas?.height,
                format: this.canvasFormat,
                gpuFormat: this.canvasFormat
            }
            targetView = outputTex.view
        }

        if (!outputTex) {
            throw {
                code: 'ERR_TEXTURE_NOT_FOUND',
                pass: pass.id,
                texture: outputId
            }
        }

        // Resolve viewport
        const viewport = this.resolveViewport(pass, outputTex)

        // Configure color attachment
        const colorAttachment = {
            view: targetView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: pass.clear ? 'clear' : 'load',
            storeOp: 'store'
        }

        // Get or create pipeline for this output format - do this BEFORE creating bind group
        const resolvedFormat = outputTex.gpuFormat || outputTex.format || program.outputFormat

        // Check if this is a 3D triangles pass - needs depth buffer and back-face culling
        const is3DPass = pass.drawMode === 'triangles'

        let pipeline
        let renderPassDescriptor

        if (is3DPass) {
            // 3D mesh rendering: use depth buffer and back-face culling
            const depthTex = this.getDepthTexture(outputTex.width, outputTex.height)

            renderPassDescriptor = {
                colorAttachments: [colorAttachment],
                depthStencilAttachment: {
                    view: depthTex.createView(),
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store'
                }
            }

            pipeline = this.resolve3DRenderPipeline(program, {
                blend: pass.blend,
                format: resolvedFormat
            })
        } else {
            // Standard 2D rendering
            renderPassDescriptor = { colorAttachments: [colorAttachment] }

            pipeline = this.resolveRenderPipeline(program, {
                blend: pass.blend,
                topology: (pass.drawMode === 'points') ? 'point-list' : 'triangle-list',
                format: resolvedFormat
            })
        }

        // Begin render pass
        const passEncoder = this.commandEncoder.beginRenderPass(renderPassDescriptor)

        // Create bind group for this pass using the ACTUAL pipeline's layout
        const bindGroup = this.createBindGroup(pass, program, state, pipeline)

        passEncoder.setPipeline(pipeline)
        passEncoder.setBindGroup(0, bindGroup)

        if (viewport) {
            passEncoder.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1)
        }

        // Draw
        if (pass.drawMode === 'points') {
            const count = this.resolvePointCount(pass, state, outputId, outputTex)
            passEncoder.draw(count, 1, 0, 0)
        } else if (pass.drawMode === 'billboards') {
            // Billboard mode: 6 vertices per particle (2 triangles = 1 quad)
            const count = this.resolvePointCount(pass, state, outputId, outputTex)
            passEncoder.draw(count * 6, 1, 0, 0)
        } else if (pass.drawMode === 'triangles') {
            // Triangle mesh mode: vertices read from mesh textures
            const count = this.resolveMeshVertexCount(pass, state, outputTex)
            passEncoder.draw(count, 1, 0, 0)
        } else {
            passEncoder.draw(3, 1, 0, 0) // Full-screen triangle
        }

        passEncoder.end()
    }

    /**
     * Execute a render pass with Multiple Render Targets (MRT)
     * Used for agent simulation passes that output to multiple state textures
     */
    executeMRTRenderPass(pass, program, state, outputKeys) {
        const colorAttachments = []
        const formats = []
        let viewportTex = null

        // Resolve each output texture
        for (const outputKey of outputKeys) {
            let outputId = pass.outputs[outputKey]

            // Resolve global output to current write buffer
            const outputSurfaceName = this.parseGlobalName(outputId)
            if (outputSurfaceName) {
                if (state.writeSurfaces && state.writeSurfaces[outputSurfaceName]) {
                    outputId = state.writeSurfaces[outputSurfaceName]
                }
            }

            const tex = this.textures.get(outputId) || state.surfaces?.[outputId]
            if (!tex) {
                console.warn(`[executeMRTRenderPass] Texture not found for ${outputId} in pass ${pass.id}`)
                continue
            }

            if (!viewportTex) viewportTex = tex

            const resolvedFormat = tex.gpuFormat || this.resolveFormat(tex.format || 'rgba16float')
            formats.push(resolvedFormat)

            colorAttachments.push({
                view: tex.view,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: pass.clear ? 'clear' : 'load',
                storeOp: 'store'
            })
        }

        if (colorAttachments.length === 0) {
            throw {
                code: 'ERR_NO_MRT_OUTPUTS',
                pass: pass.id
            }
        }

        // Get or create MRT pipeline
        const pipeline = this.resolveMRTRenderPipeline(program, {
            blend: pass.blend,
            topology: (pass.drawMode === 'points') ? 'point-list' : 'triangle-list',
            formats
        })

        // Begin render pass with multiple color attachments
        const passEncoder = this.commandEncoder.beginRenderPass({
            colorAttachments
        })

        // Set viewport from first output texture
        if (viewportTex) {
            passEncoder.setViewport(0, 0, viewportTex.width, viewportTex.height, 0, 1)
        }

        // Create bind group for this pass
        const bindGroup = this.createBindGroup(pass, program, state, pipeline)

        passEncoder.setPipeline(pipeline)
        passEncoder.setBindGroup(0, bindGroup)

        // Draw
        if (pass.drawMode === 'points') {
            const count = this.resolvePointCount(pass, state, null, viewportTex)
            passEncoder.draw(count, 1, 0, 0)
        } else if (pass.drawMode === 'billboards') {
            // Billboard mode: 6 vertices per particle (2 triangles = 1 quad)
            const count = this.resolvePointCount(pass, state, null, viewportTex)
            passEncoder.draw(count * 6, 1, 0, 0)
        } else if (pass.drawMode === 'triangles') {
            // Triangle mesh mode: vertices read from mesh textures
            const count = this.resolveMeshVertexCount(pass, state, viewportTex)
            passEncoder.draw(count, 1, 0, 0)
        } else {
            passEncoder.draw(3, 1, 0, 0) // Full-screen triangle
        }

        passEncoder.end()
    }

    /**
     * Get or create a render pipeline with multiple render targets
     */
    resolveMRTRenderPipeline(program, { blend, topology, formats }) {
        const key = `mrt_${topology || 'triangle-list'}_${formats.join('_')}_${blend ? JSON.stringify(blend) : 'noblend'}`

        if (!program.pipelineCache.has(key)) {
            // Build targets array for all outputs
            const targets = formats.map(format => ({
                format,
                blend: this.resolveBlendState(blend)
            }))

            const pipeline = this.device.createRenderPipeline({
                layout: 'auto',
                vertex: {
                    module: program.vertexModule || this.getDefaultVertexModule(),
                    entryPoint: program.vertexEntryPoint || DEFAULT_VERTEX_ENTRY_POINT
                },
                fragment: {
                    module: program.fragmentModule || program.module,
                    entryPoint: program.fragmentEntryPoint || DEFAULT_FRAGMENT_ENTRY_POINT,
                    targets
                },
                primitive: {
                    topology: topology || 'triangle-list'
                }
            })

            program.pipelineCache.set(key, pipeline)
        }

        return program.pipelineCache.get(key)
    }

    /**
     * Get or create a depth texture for 3D mesh rendering.
     * @param {number} width - Required width
     * @param {number} height - Required height
     * @returns {GPUTexture} - Depth texture for mesh rendering
     */
    getDepthTexture(width, height) {
        // Create or resize depth texture if needed
        if (!this.depthTexture ||
            this.depthTextureSize.width !== width ||
            this.depthTextureSize.height !== height) {

            if (this.depthTexture) {
                this.depthTexture.destroy()
            }

            this.depthTexture = this.device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT
            })
            this.depthTextureSize = { width, height }
        }

        return this.depthTexture
    }

    /**
     * Get or create a render pipeline for 3D mesh rendering with depth test and back-face culling.
     */
    resolve3DRenderPipeline(program, { blend, format }) {
        const key = `3d|${format || 'rgba16float'}|${blend ? JSON.stringify(blend) : 'noblend'}`

        if (!program.pipelineCache.has(key)) {
            const pipeline = this.device.createRenderPipeline({
                layout: 'auto',
                vertex: {
                    module: program.vertexModule || this.getDefaultVertexModule(),
                    entryPoint: program.vertexEntryPoint || DEFAULT_VERTEX_ENTRY_POINT
                },
                fragment: {
                    module: program.fragmentModule || program.module,
                    entryPoint: program.fragmentEntryPoint || DEFAULT_FRAGMENT_ENTRY_POINT,
                    targets: [{
                        format: format || program.outputFormat || 'rgba16float',
                        blend: this.resolveBlendState(blend)
                    }]
                },
                primitive: {
                    topology: 'triangle-list',
                    cullMode: 'back',
                    // 'cw' because WGSL shader flips Y which reverses winding order
                    frontFace: 'cw'
                },
                depthStencil: {
                    format: 'depth24plus',
                    depthWriteEnabled: true,
                    depthCompare: 'less'
                }
            })

            program.pipelineCache.set(key, pipeline)
        }

        return program.pipelineCache.get(key)
    }

    resolveRenderPipeline(program, { blend, topology, format }) {
        const key = this.getPipelineKey({ blend, topology, format })

        if (!program.pipelineCache.has(key)) {
            const pipeline = this.device.createRenderPipeline({
                layout: 'auto',
                vertex: {
                    module: program.vertexModule || this.getDefaultVertexModule(),
                    entryPoint: program.vertexEntryPoint || DEFAULT_VERTEX_ENTRY_POINT
                },
                fragment: {
                    module: program.fragmentModule || program.module,
                    entryPoint: program.fragmentEntryPoint || DEFAULT_FRAGMENT_ENTRY_POINT,
                    targets: [{
                        format: format || program.outputFormat || 'rgba16float',
                        blend: this.resolveBlendState(blend)
                    }]
                },
                primitive: {
                    topology: topology || 'triangle-list'
                }
            })

            program.pipelineCache.set(key, pipeline)
        }

        return program.pipelineCache.get(key)
    }

    getPipelineKey({ blend, topology, format }) {
        const blendKey = blend ? JSON.stringify(blend) : 'noblend'
        const topoKey = topology || 'triangle-list'
        return `${topoKey}|${blendKey}|${format || 'rgba16float'}`
    }

    resolveBlendState(blend) {
        if (!blend) return undefined

        const defaultBlend = {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
        }

        if (Array.isArray(blend)) {
            const [srcFactor, dstFactor] = blend
            const toFactor = (factor) => {
                // Convert uppercase WebGL-style constants to lowercase WebGPU-style
                if (typeof factor === 'string') return factor.toLowerCase().replace(/_/g, '-')
                return null
            }

            const resolvedSrc = toFactor(srcFactor) || defaultBlend.color.srcFactor
            const resolvedDst = toFactor(dstFactor) || defaultBlend.color.dstFactor

            return {
                color: { srcFactor: resolvedSrc, dstFactor: resolvedDst, operation: 'add' },
                alpha: { srcFactor: resolvedSrc, dstFactor: resolvedDst, operation: 'add' }
            }
        }

        return defaultBlend
    }

    resolveViewport(pass, tex) {
        if (tex?.width && tex?.height) {
            return { x: 0, y: 0, w: tex.width, h: tex.height }
        }

        if (pass.viewport) {
            return { x: pass.viewport.x, y: pass.viewport.y, w: pass.viewport.w, h: pass.viewport.h }
        }

        if (this.context?.canvas) {
            return { x: 0, y: 0, w: this.context.canvas.width, h: this.context.canvas.height }
        }

        return null
    }

    resolvePointCount(pass, state, outputId, outputTex) {
        let count = pass.count || 1000

        if (count === 'auto' || count === 'screen' || count === 'input') {
            let refTex = null

            if (count === 'input' && pass.inputs) {
                // For particle systems, prefer xyzTex (state texture) over inputTex
                const stateInputId = pass.inputs.xyzTex || pass.inputs.inputTex
                if (stateInputId) {
                    const surfaceName = this.parseGlobalName(stateInputId)
                    if (surfaceName) {
                        refTex = state.surfaces?.[surfaceName]
                    } else {
                        refTex = this.textures.get(stateInputId)
                    }
                }
            } else {
                refTex = outputTex || this.textures.get(outputId)
            }

            if (refTex && refTex.width && refTex.height) {
                count = refTex.width * refTex.height
            } else if (this.context?.canvas) {
                count = this.context.canvas.width * this.context.canvas.height
            }
        }

        return count
    }

    /**
     * Resolve vertex count for mesh triangle draw mode.
     * Derives count from mesh position texture dimensions or explicit count.
     */
    resolveMeshVertexCount(pass, state) {
        let count = pass.count || 3  // Default to 1 triangle

        // Check if countUniform is specified - read count from uniforms at runtime
        // If uniform value is 0 or undefined, fall through to auto-detection
        if (pass.countUniform) {
            const uniformName = pass.countUniform
            // Look up in pass uniforms, then state globalUniforms
            let uniformValue = pass.uniforms?.[uniformName]
            if (uniformValue === undefined) {
                uniformValue = state.globalUniforms?.[uniformName]
            }
            if (typeof uniformValue === 'number' && uniformValue > 0) {
                count = uniformValue
                return count  // Explicit count set, use it
            }
        }

        // Auto-detect from mesh texture dimensions
        if (count === 'auto' || count === 'input' || count <= 0) {
            let refTex = null

            if (pass.inputs) {
                // For mesh rendering, prefer meshPositions texture
                const meshInputId = pass.inputs.meshPositions || pass.inputs.inputTex
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
                        const surfaceName = this.parseGlobalName(meshInputId)
                        if (surfaceName) {
                            refTex = state.surfaces?.[surfaceName]
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

        return count
    }

    /**
     * Get or create a compute pipeline for a specific entry point.
     * Supports multi-entry-point shaders like blur (downsample_main, upsample_main).
     */
    getComputePipeline(program, entryPoint) {
        const targetEntryPoint = entryPoint || program.entryPoint || 'main'

        // Check if pipeline already exists for this entry point
        if (program.pipelines?.has(targetEntryPoint)) {
            return program.pipelines.get(targetEntryPoint)
        }

        // Create new pipeline for this entry point
        const pipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: program.module,
                entryPoint: targetEntryPoint
            }
        })

        // Cache it
        if (program.pipelines) {
            program.pipelines.set(targetEntryPoint, pipeline)
        }

        return pipeline
    }

    executeComputePass(pass, program, state) {
        // Get the pipeline for this pass's entry point (supports multi-entry-point shaders)
        const pipeline = this.getComputePipeline(program, pass.entryPoint)

        // Create bind group for this pass using the specific pipeline
        const bindGroup = this.createBindGroup(pass, program, state, pipeline)

        // Determine workgroup dispatch size
        const workgroups = this.resolveWorkgroups(pass, state)

        // Begin compute pass
        const passEncoder = this.commandEncoder.beginComputePass()
        passEncoder.setPipeline(pipeline)
        passEncoder.setBindGroup(0, bindGroup)
        passEncoder.dispatchWorkgroups(workgroups[0], workgroups[1], workgroups[2])
        passEncoder.end()

        // Check if this compute pass writes to an output buffer and needs a buffer-to-texture copy
        // Support both naming conventions: output_buffer (snake_case) and outputBuffer (camelCase)
        const outputBufferBinding = program.bindings?.find(b =>
            (b.name === 'output_buffer' || b.name === 'outputBuffer') && b.type === 'storage'
        )
        if (outputBufferBinding && pass.outputs) {
            // Get the output texture to copy to
            const outputId = pass.outputs.color || pass.outputs.fragColor || Object.values(pass.outputs)[0]
            if (outputId) {
                this.copyBufferToTexture(state, outputId, outputBufferBinding.name)
            }
        }
    }

    resolveWorkgroups(pass, state) {
        if (pass.workgroups) {
            return pass.workgroups
        }

        if (pass.size) {
            const { x = pass.size.width, y = pass.size.height, z = pass.size.depth || 1 } = pass.size
            if (x && y) {
                return [x, y, z]
            }
        }

        // Try to get output dimensions
        const outputId = pass.outputs?.color || Object.values(pass.outputs || {})[0]
        const output = outputId ? this.textures.get(outputId) : null

        if (output) {
            return [
                Math.ceil(output.width / 8),
                Math.ceil(output.height / 8),
                1
            ]
        }

        // Fall back to screen dimensions from state
        const width = state?.screenWidth
        const height = state?.screenHeight

        if (width && height) {
            return [
                Math.ceil(width / 8),
                Math.ceil(height / 8),
                1
            ]
        }

        throw {
            code: 'ERR_COMPUTE_DISPATCH_UNRESOLVED',
            pass: pass.id,
            detail: 'Compute dispatch dimensions could not be inferred'
        }
    }

    /**
     * Create a bind group for a pass.
     *
     * Uses the parsed shader bindings to create entries that match what the shader expects.
     * This handles the various binding conventions used in existing WGSL shaders:
     * - Individual uniform bindings (one per uniform variable)
     * - Texture + sampler pairs
     * - Uniform buffer structs
     * @param {Object} pipeline - Optional resolved pipeline to use for layout (for topology variants)
     */
    createBindGroup(pass, program, state, pipeline = null) {
        const entries = []
        let bindings = program.bindings || []

        // Use the passed pipeline or fall back to program's default pipeline
        const targetPipeline = pipeline || program.pipeline


        // For multi-entry-point compute shaders, filter bindings based on pass inputs/outputs
        // This prevents including bindings that are optimized out by WebGPU for this entry point
        if (pass.entryPoint && program.isCompute) {
            const neededBindingNames = new Set()

            // Add all input names
            if (pass.inputs) {
                for (const inputName of Object.keys(pass.inputs)) {
                    neededBindingNames.add(inputName)
                }
            }

            // Add all output names
            if (pass.outputs) {
                for (const outputName of Object.keys(pass.outputs)) {
                    neededBindingNames.add(outputName)
                }
            }

            // Always include uniform buffer (params) - it's always needed
            neededBindingNames.add('params')

            // Always include storage buffers - they're used for compute output
            for (const binding of bindings) {
                if (binding.type === 'storage') {
                    neededBindingNames.add(binding.name)
                }
            }

            // Filter bindings to only those explicitly used by this pass
            bindings = bindings.filter(b => neededBindingNames.has(b.name))
        }

        // Helper to get uniform value with proper precedence
        // Pass uniforms take precedence because they contain resolved automation values (oscillators, midi, audio)
        // Global uniforms (time, resolution, etc.) are used as fallback
        const getUniform = (name) => {
            if (pass.uniforms && name in pass.uniforms) {
                return pass.uniforms[name]
            }
            if (state.globalUniforms && name in state.globalUniforms) {
                return state.globalUniforms[name]
            }
            return undefined
        }

        // Map input names to texture views
        const textureMap = new Map()
        if (pass.inputs) {
            for (const [inputName, texId] of Object.entries(pass.inputs)) {
                let textureView

                // Parse global texture reference
                const surfaceName = this.parseGlobalName(texId)

                // Mesh data textures (global_meshN_positions/normals/uvs) are static
                // uploads from loadOBJ, not ping-pong surfaces. Chain scoping can create
                // a same-named ping-pong surface in state.surfaces; binding that empty
                // surface instead of the uploaded mesh texture makes the vertex shader
                // read zeroed positions and the mesh renders degenerate (blank). Resolve
                // these to the uploaded texture by its chain-stripped name first.
                const unscopedMeshId = typeof texId === 'string' ? texId.replace(/_chain_\d+$/, '') : texId
                const isMeshData = typeof unscopedMeshId === 'string' &&
                    /^global_mesh\d+_(?:positions|normals|uvs)$/.test(unscopedMeshId)

                if (isMeshData) {
                    const meshTex = this.textures.get(texId) || this.textures.get(unscopedMeshId)
                    textureView = meshTex?.view
                } else if (surfaceName) {
                    // Check if it's a ping-pong global surface (o0-o7, geo0-geo7, vol0-vol7)
                    const surfaceObj = state.surfaces?.[surfaceName]
                    if (surfaceObj?.view) {
                        // Ping-pong surface - use current read texture from state
                        textureView = surfaceObj.view
                    } else {
                        // Not a ping-pong surface - check textures map directly
                        // This handles mesh textures (global_mesh0_positions etc.) which are
                        // static data textures uploaded by loadOBJ, not double-buffered surfaces.
                        // Try scoped name first, then unscoped (strip chain scope suffix)
                        let tex = this.textures.get(texId)
                        if (!tex) {
                            const unscopedId = texId.replace(/_chain_\d+$/, '')
                            if (unscopedId !== texId) {
                                tex = this.textures.get(unscopedId)
                            }
                        }
                        textureView = tex?.view
                    }
                } else {
                    const tex = this.textures.get(texId)
                    textureView = tex?.view
                }

                if (textureView) {
                    textureMap.set(inputName, textureView)
                    // Also map by common alias patterns
                    if (inputName === 'inputTex') {
                        textureMap.set('tex0', textureView)
                        textureMap.set('inputColor', textureView)
                    }
                }
            }
        }

        // WebGL2 createTexture sets NEAREST min/mag on every surface render target;
        // WebGPU historically bound the LINEAR 'default' sampler for all inputs
        // (pass.samplerTypes is never populated), so filter effects sampled their
        // intermediate surface input LINEAR on WebGPU vs NEAREST on WebGL2 — a parity
        // gap. Mirror WebGL2: surface inputs sample NEAREST. External (video/image)
        // uploads are LINEAR in WebGL2, so a pass sampling one of those (isExternal)
        // keeps LINEAR here too.
        const inputSamplerDefault = (pass.inputs && Object.values(pass.inputs).some(texId => {
            const t = this.textures.get(texId) ||
                (typeof texId === 'string' ? this.textures.get(texId.replace(/_chain_\d+$/, '')) : null)
            return t?.isExternal === true
        })) ? 'default' : 'nearest'

        // Create entries based on parsed shader bindings
        for (const binding of bindings) {
            if (binding.group !== 0) continue // Only support group 0 for now

            const entry = { binding: binding.binding }

            if (binding.type === 'texture') {
                // Find the texture view for this binding
                let view = textureMap.get(binding.name)
                if (!view) {
                    // Try to find by common patterns
                    if (binding.name.startsWith('tex')) {
                        const idx = parseInt(binding.name.slice(3), 10)
                        const inputKeys = Object.keys(pass.inputs || {})
                        if (!isNaN(idx) && idx < inputKeys.length) {
                            view = textureMap.get(inputKeys[idx])
                        }
                    }
                    // Removed aggressive fallback to first available texture
                    // This allows falling through to dummyTextureView (transparent black)
                    // which is correct for optional/unbound textures.
                }

                // Use dummy texture if no view found - ensures bind group completeness
                if (!view) {
                    view = this.dummyTextureView
                }

                if (view) {
                    entry.resource = view
                    entries.push(entry)
                }
            } else if (binding.type === 'sampler') {
                const samplerType = pass.samplerTypes?.[binding.name] || inputSamplerDefault
                entry.resource = this.samplers.get(samplerType) || this.samplers.get('default')
                entries.push(entry)
            } else if (binding.type === 'uniform') {
                // Check if this is a struct or individual uniform
                const isStruct = binding.typeDecl && !binding.typeDecl.includes('<') &&
                    binding.typeDecl !== 'f32' && binding.typeDecl !== 'i32' &&
                    binding.typeDecl !== 'u32' && binding.typeDecl !== 'bool' &&
                    !binding.typeDecl.startsWith('vec') && !binding.typeDecl.startsWith('mat')


                if (isStruct) {
                    // This looks like a struct - create full uniform buffer
                    // Pass program to access packedUniformLayout
                    const uniformBuffer = this.createUniformBuffer(pass, state, program)
                    if (uniformBuffer) {
                        entry.resource = { buffer: uniformBuffer }
                        entries.push(entry)
                    }
                } else {
                    // Individual uniform - create small buffer for this value
                    // Use 0 as default for missing/invalid uniforms to ensure bind group completeness
                    let value = getUniform(binding.name)

                    // Handle missing, null, or invalid values by providing sensible defaults
                    if (value === undefined || value === null ||
                        (typeof value !== 'number' && typeof value !== 'boolean' && !Array.isArray(value))) {
                        // Provide sensible defaults based on type
                        if (binding.typeDecl === 'i32' || binding.typeDecl === 'u32') {
                            value = 0
                        } else if (binding.typeDecl.startsWith('vec2')) {
                            value = [0, 0]
                        } else if (binding.typeDecl.startsWith('vec3')) {
                            value = [0, 0, 0]
                        } else if (binding.typeDecl.startsWith('vec4')) {
                            value = [0, 0, 0, 0]
                        } else if (binding.typeDecl.startsWith('array<')) {
                            // array<vec4<f32>, N> / array<f32, N> / etc.
                            // Default to a zero-filled flat float buffer sized for the array,
                            // so the bind group buffer matches the shader's expected size.
                            const m = binding.typeDecl.match(/^array<\s*([^,>]+(?:<[^>]+>)?)\s*,\s*(\d+)\s*>/)
                            if (m) {
                                const elemType = m[1].trim()
                                const count = parseInt(m[2], 10)
                                let stride = 16 // vec4 stride
                                if (elemType === 'f32' || elemType === 'i32' || elemType === 'u32') stride = 4
                                else if (elemType.startsWith('vec2')) stride = 8
                                else if (elemType.startsWith('vec3') || elemType.startsWith('vec4')) stride = 16
                                value = new Array((count * stride) / 4).fill(0)
                            } else {
                                value = 0
                            }
                        } else if (binding.typeDecl.startsWith('mat3')) {
                            // mat3x3<f32>: identity is the neutral transform default, and
                            // yields a correct 48-byte buffer instead of a 4-byte scalar.
                            value = [1, 0, 0, 0, 1, 0, 0, 0, 1]
                        } else {
                            value = 0 // Default for f32 and others
                        }
                    }
                    const buffer = this.createSingleUniformBuffer(value, binding.typeDecl)
                    if (buffer) {
                        entry.resource = { buffer }
                        this.activeUniformBuffers.push(buffer)
                        entries.push(entry)
                    }
                }
            } else if (binding.type === 'storage') {
                // Storage buffers - create or get storage buffer
                const storage = this.createStorageBuffer(binding, pass, state)
                if (storage) {
                    entry.resource = { buffer: storage }
                    entries.push(entry)
                }
            } else if (binding.type === 'storage_texture') {
                // Storage textures for compute shader output
                const storageView = this.createStorageTextureView(binding, pass, state)
                if (storageView) {
                    entry.resource = storageView
                    entries.push(entry)
                }
            }
        }

        // If no bindings were parsed AND the shader source has zero `@binding`
        // declarations at all, the shader uses the older format — fall back to
        // the legacy entry builder. But if the shader DOES declare bindings and
        // the parsed list is just empty (because parseShaderBindings filtered
        // all of them out as dead), we want an empty bind group, NOT the
        // legacy fallback. The legacy fallback would blindly add entries from
        // pass.inputs + a uniform buffer, which would mismatch the empty
        // auto-generated layout.
        if (bindings.length === 0) {
            const sourceHasBindings = program.module && program._sourceHasBindings
            if (!sourceHasBindings) {
                return this.createLegacyBindGroup(pass, program, state)
            }
            // Shader declared bindings but they're all dead — empty bind group is correct.
            return this.device.createBindGroup({
                layout: targetPipeline.getBindGroupLayout(0),
                entries: []
            })
        }


        // Create bind group using the target pipeline's layout
        // Handle multi-entry-point shaders where some bindings may be optimized out
        // Try direct creation first (most common case - no optimized-out bindings)
        try {
            return this.device.createBindGroup({
                layout: targetPipeline.getBindGroupLayout(0),
                entries
            })
        } catch (err) {
            // Fall back to retry loop only on binding errors
            const errStr = err.message || String(err)
            if (!errStr.includes('binding index')) {
                throw err
            }

            // Use retry loop with filtered entries (rare case)
            let currentEntries = entries
            const maxRetries = 10

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                const bindingMatch = /binding index (\d+) not present/.exec(errStr)
                if (bindingMatch) {
                    const problemBinding = parseInt(bindingMatch[1], 10)
                    // Filter in place to avoid allocation on subsequent retries
                    currentEntries = currentEntries.filter(e => e.binding !== problemBinding)

                    try {
                        return this.device.createBindGroup({
                            layout: targetPipeline.getBindGroupLayout(0),
                            entries: currentEntries
                        })
                    } catch (retryErr) {
                        const retryErrStr = retryErr.message || String(retryErr)
                        if (!retryErrStr.includes('binding index')) {
                            throw retryErr
                        }
                        continue
                    }
                }
                break
            }

            throw err
        }
    }

    /**
     * Create a buffer for a single uniform value.
     * Reuses pre-allocated typed arrays to minimize per-frame allocations.
     */
    createSingleUniformBuffer(value, typeDecl) {
        let data
        let byteLength

        if (typeof value === 'boolean') {
            // Reuse pre-allocated int32 array
            this._singleUniformInt32[0] = value ? 1 : 0
            data = this._singleUniformInt32
            byteLength = 4
        } else if (typeof value === 'number') {
            if (typeDecl === 'i32' || typeDecl === 'u32') {
                this._singleUniformInt32[0] = Math.round(value)
                data = this._singleUniformInt32
                byteLength = 4
            } else {
                this._singleUniformFloat32[0] = value
                data = this._singleUniformFloat32
                byteLength = 4
            }
        } else if (Array.isArray(value)) {
            // Reuse pre-allocated float32 array for vectors
            const arr = this._singleUniformFloat32
            if (value.length === 2) {
                arr[0] = value[0]
                arr[1] = value[1]
                byteLength = 8
            } else if (value.length === 3) {
                arr[0] = value[0]
                arr[1] = value[1]
                arr[2] = value[2]
                arr[3] = 0  // Pad vec3 to vec4
                byteLength = 16
            } else if (value.length === 4) {
                arr[0] = value[0]
                arr[1] = value[1]
                arr[2] = value[2]
                arr[3] = value[3]
                byteLength = 16
            } else if (value.length === 9) {
                // mat3x3<f32>: 3 columns, each padded to vec4 (16 bytes) = 48 bytes total.
                // Reuse the pre-allocated buffer to honor this function's no-per-frame-alloc contract.
                const mat3buf = this._singleUniformMat3Float32
                for (let col = 0; col < 3; col++) {
                    mat3buf[col * 4 + 0] = value[col * 3 + 0]
                    mat3buf[col * 4 + 1] = value[col * 3 + 1]
                    mat3buf[col * 4 + 2] = value[col * 3 + 2]
                    mat3buf[col * 4 + 3] = 0  // column padding
                }
                data = mat3buf
                byteLength = 48
            } else {
                // Fallback for other sizes — handle large arrays (e.g. audio waveform
                // declared as array<vec4<f32>, 32> in WGSL, which needs a 512-byte
                // buffer). When the typeDecl indicates a vec4 array, pad each input
                // entry up to 16-byte stride so the buffer size matches the shader's
                // expected minimum binding size.
                if (typeof typeDecl === 'string' && /^array<\s*vec4/.test(typeDecl)) {
                    const m = typeDecl.match(/^array<[^,>]+(?:<[^>]+>)?\s*,\s*(\d+)\s*>/)
                    const count = m ? parseInt(m[1], 10) : Math.ceil(value.length / 4)
                    // Build a flat buffer of count * 4 floats. Treat the input as a
                    // flat sequence — every 4 input values become one vec4 entry.
                    const flat = new Float32Array(count * 4)
                    const copyLen = Math.min(value.length, flat.length)
                    for (let i = 0; i < copyLen; i++) flat[i] = value[i]
                    data = flat
                    byteLength = flat.byteLength
                } else {
                    data = new Float32Array(value)
                    byteLength = data.byteLength
                }
            }
            if (!data) data = arr
        }

        if (!data) return null

        // Get buffer from pool or create new one
        const bufferSize = Math.max(byteLength, 16)
        let buffer = this.getBufferFromPool(bufferSize)

        if (!buffer) {
            buffer = this.device.createBuffer({
                size: bufferSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            })
        }

        // Write only the needed bytes (use subarray to avoid allocation)
        this.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, byteLength)
        return buffer
    }

    /**
     * Create or get a storage buffer for compute shaders.
     * Storage buffers persist across passes within an effect.
     *
     * @param {object} binding - Parsed binding info from shader
     * @param {object} pass - Pass definition
     * @param {object} state - Current render state (includes screenWidth, screenHeight)
     * @returns {GPUBuffer|null}
     */
    createStorageBuffer(binding, pass, state) {
        const bufferName = binding.name

        // Check if buffer already exists
        if (this.storageBuffers.has(bufferName)) {
            return this.storageBuffers.get(bufferName)
        }

        // Determine buffer size based on binding type and context
        let byteSize = 0

        // For output buffers (both naming conventions): 4 floats per pixel (RGBA) * width * height
        if (bufferName === 'output_buffer' || bufferName === 'outputBuffer') {
            const width = state?.screenWidth || 1280
            const height = state?.screenHeight || 720
            byteSize = width * height * 4 * 4 // 4 channels * 4 bytes per float
        }
        // For stats_buffer: enough for all workgroups + 2 for final result
        // Max workgroups = ceil(width/8) * ceil(height/8)
        else if (bufferName === 'stats_buffer') {
            const width = state?.screenWidth || 1280
            const height = state?.screenHeight || 720
            const workgroupsX = Math.ceil(width / 8)
            const workgroupsY = Math.ceil(height / 8)
            const numWorkgroups = workgroupsX * workgroupsY
            // Layout: [global_min, global_max, wg0_min, wg0_max, ...]
            // 2 floats for final + 2 floats per workgroup
            byteSize = (2 + numWorkgroups * 2) * 4 // floats * 4 bytes
        }
        // For downsample buffers and others, estimate based on typical usage
        else if (bufferName.includes('downsample')) {
            const width = state?.screenWidth || 1280
            const height = state?.screenHeight || 720
            // Assume 1/16 of original size
            byteSize = Math.ceil(width / 4) * Math.ceil(height / 4) * 4 * 4
        }
        else {
            // Default to screen-sized RGBA buffer
            const width = state?.screenWidth || 1280
            const height = state?.screenHeight || 720
            byteSize = width * height * 4 * 4
        }

        // Ensure minimum size and alignment
        byteSize = Math.max(256, byteSize)
        byteSize = Math.ceil(byteSize / 256) * 256 // Align to 256 bytes

        const buffer = this.device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        })

        this.storageBuffers.set(bufferName, buffer)
        return buffer
    }

    /**
     * Create a storage texture view for compute shader output.
     * Storage textures allow direct writes from compute shaders via textureStore().
     *
     * @param {object} binding - Parsed binding info from shader
     * @param {object} pass - Pass definition
     * @param {object} state - Current render state
     * @returns {GPUTextureView|null}
     */
    createStorageTextureView(binding, pass, state) {
        // Determine which texture to use
        // Look in pass.storageTextures for mapping: shader_name -> texture_id
        const storageTextures = pass.storageTextures || {}
        const textureId = storageTextures[binding.name]


        if (!textureId) {
            // Default to outputTex if no explicit mapping
            if (binding.name === 'output_texture') {
                return this.getOutputStorageView(state)
            }
            console.warn(`No storage texture mapping for ${binding.name}`)
            return null
        }

        // Map textureId to actual texture via state.writeSurfaces
        if (textureId === 'outputTex') {
            return this.getOutputStorageView(state)
        }

        // Check if it's a surface reference (o0-o7)
        const surfacePattern = /^o[0-7]$/
        if (surfacePattern.test(textureId)) {
            const writeTex = state?.writeSurfaces?.[textureId]
            if (writeTex) {
                const texture = this.textures.get(writeTex)
                if (texture) {
                    return texture.view
                }
            }
        }

        // Check if it's a global surface reference
        const surfaceName = this.parseGlobalName(textureId)
        if (surfaceName) {
            const writeTex = state?.writeSurfaces?.[surfaceName]
            if (writeTex) {
                const texture = this.textures.get(writeTex)
                if (texture) {
                    return texture.view
                }
            }
        }

        // Look up in textures map
        const texture = this.textures.get(textureId)
        if (texture) {
            return texture.view
        }

        console.warn(`Storage texture ${textureId} not found`)
        return null
    }

    /**
     * Get the storage texture view for compute output.
     * Uses the render surface's write texture which has STORAGE_BINDING usage.
     */
    getOutputStorageView(state) {
        // Use the graph's render surface, not a hardcoded default
        const renderSurfaceName = state?.graph?.renderSurface
        if (renderSurfaceName) {
            const writeTex = state?.writeSurfaces?.[renderSurfaceName]
            if (writeTex) {
                const texture = this.textures.get(writeTex)
                if (texture) {
                    return texture.view
                }
            }
        }

        // Fallback: create a temporary storage texture if surface not available
        console.warn('Render surface write texture not found, using fallback storage texture')
        const width = state?.screenWidth || 1280
        const height = state?.screenHeight || 720
        const key = `outputStorage_${width}x${height}`

        if (!this.storageTextures) {
            this.storageTextures = new Map()
        }

        if (this.storageTextures.has(key)) {
            return this.storageTextures.get(key).view
        }

        const texture = this.device.createTexture({
            size: { width, height },
            format: 'rgba16float',
            // Include COPY_DST so copyTextureToTexture can target this texture
            // (used by the chain-handoff path). Without it Dawn rejects with
            // "Destination texture needs to have CopyDst and RenderAttachment
            // usage" — this storage texture has RENDER_ATTACHMENT but was
            // missing COPY_DST.
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        })

        const view = texture.createView()
        this.storageTextures.set(key, { texture, view, width, height })

        return view
    }

    /**
     * Legacy bind group creation for shaders that don't have parsed bindings.
     */
    createLegacyBindGroup(pass, program, state) {
        const entries = []
        let binding = 0

        // Bind input textures (alternating texture/sampler)
        if (pass.inputs) {
            for (const [samplerName, texId] of Object.entries(pass.inputs)) {
                let textureView

                // "none" means bind the dummy/blank texture
                if (texId === 'none') {
                    textureView = this.dummyTextureView
                } else {
                    const surfaceName = this.parseGlobalName(texId)
                    if (surfaceName) {
                        // Global surface - use the current read texture from state
                        // The pipeline handles ping-pong via updateFrameSurfaceBindings
                        textureView = state.surfaces?.[surfaceName]?.view
                    } else {
                        textureView = this.textures.get(texId)?.view
                    }
                }

                // Fall back to dummy texture if texture not found
                if (!textureView) {
                    textureView = this.dummyTextureView
                }

                if (textureView) {
                    entries.push({
                        binding: binding++,
                        resource: textureView
                    })

                    // Match WebGL2 surface filtering (NEAREST) for surface inputs;
                    // external (video/image) uploads are LINEAR on WebGL2, keep LINEAR.
                    const texRec = this.textures.get(texId) ||
                        (typeof texId === 'string' ? this.textures.get(texId.replace(/_chain_\d+$/, '')) : null)
                    const legacyDefault = texRec?.isExternal ? 'default' : 'nearest'
                    const samplerType = pass.samplerTypes?.[samplerName] || legacyDefault
                    entries.push({
                        binding: binding++,
                        resource: this.samplers.get(samplerType) || this.samplers.get('default')
                    })
                }
            }
        }

        // Create uniform buffer if needed
        if (pass.uniforms || state.globalUniforms) {
            const uniformBuffer = this.createUniformBuffer(pass, state)
            if (uniformBuffer) {
                entries.push({
                    binding: binding++,
                    resource: {
                        buffer: uniformBuffer
                    }
                })
            }
        }

        const bindGroup = this.device.createBindGroup({
            layout: program.pipeline.getBindGroupLayout(0),
            entries
        })

        return bindGroup
    }

    /**
     * Create a uniform buffer with proper std140 alignment.
     *
     * Alignment rules (simplified for common types):
     * - float, int, uint, bool: 4-byte align
     * - vec2: 8-byte align
     * - vec3, vec4: 16-byte align
     * - mat3: 48 bytes (3 x vec4 with 16-byte align)
     * - mat4: 64 bytes (4 x vec4)
     */
    createUniformBuffer(pass, state, program = null) {
        // Merge uniforms into pre-allocated object to avoid per-frame allocation
        // Pass uniforms first (from DSL/effect defaults), then globalUniforms on top
        const merged = this._mergedUniforms
        const mergedKeys = this._mergedUniformKeys

        // Clear previous keys (set to undefined to avoid delete deopt)
        for (let i = 0; i < mergedKeys.length; i++) {
            merged[mergedKeys[i]] = undefined
        }
        mergedKeys.length = 0

        // Copy pass uniforms (these include resolved oscillators, midi, audio values)
        if (pass.uniforms) {
            for (const key in pass.uniforms) {
                const val = pass.uniforms[key]
                if (val !== undefined) {
                    merged[key] = val
                    mergedKeys.push(key)
                }
            }
        }

        // Copy global uniforms (time, resolution, etc.) but SKIP keys already in pass.uniforms
        // Pass uniforms take precedence because they contain resolved automation values
        if (state.globalUniforms) {
            for (const key in state.globalUniforms) {
                // Skip if pass.uniforms already has this key - pass.uniforms has resolved automation values
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

        if (mergedKeys.length === 0) {
            return null
        }

        // Check if program has a packed uniform layout
        const packedLayout = program?.packedUniformLayout

        // Pack uniforms into buffer using layout if available
        const data = packedLayout
            ? this.packUniformsWithLayout(merged, packedLayout)
            : this.packUniforms(merged)

        // Determine the buffer size we actually need. Some shaders declare a
        // Uniforms struct whose minimum binding size exceeds what the packed
        // layout parser inferred (e.g. `data: array<vec4<f32>, 2>` is 32 bytes
        // but if the parser only matched references to data[0] the inferred
        // size collapses to 16). Use the program's `declaredUniformBufferSize`
        // if known so the buffer matches the shader's actual struct.
        const declaredMin = program?.declaredUniformBufferSize || 0
        const bufferSize = Math.max(data.byteLength, declaredMin, 16)

        // Get or create buffer from pool. Note: pool entries are sized large
        // enough for any prior request, so the pool is fine for the larger
        // declared size too.
        let buffer = this.getBufferFromPool(bufferSize)

        if (!buffer) {
            buffer = this.device.createBuffer({
                size: bufferSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            })
        }

        this.queue.writeBuffer(buffer, 0, data.buffer || data, data.byteOffset || 0, data.byteLength)
        this.activeUniformBuffers.push(buffer)

        return buffer
    }

    /**
     * Get a buffer from the pool or return null if none available.
     */
    getBufferFromPool(requiredSize) {
        for (let i = 0; i < this.uniformBufferPool.length; i++) {
            const buffer = this.uniformBufferPool[i]
            if (buffer.size >= requiredSize) {
                this.uniformBufferPool.splice(i, 1)
                return buffer
            }
        }
        return null
    }

    /**
     * Pack uniforms into an ArrayBuffer following std140 alignment rules.
     * Reuses pre-allocated buffer when possible to minimize per-frame allocations.
     */
    packUniforms(uniforms) {
        // Calculate required size (rough estimate)
        let estimatedSize = 0
        for (const key in uniforms) {
            const value = uniforms[key]
            if (value === undefined) continue
            if (typeof value === 'number') {
                estimatedSize += 4
            } else if (Array.isArray(value)) {
                estimatedSize += value.length * 4 + 12 // Add padding for alignment
            } else if (typeof value === 'boolean') {
                estimatedSize += 4
            }
        }

        // Round up to next 16 bytes and add padding for struct compatibility
        // Many compute shaders use vec4-packed structs up to 256 bytes
        const bufferSize = Math.max(256, Math.ceil((estimatedSize + 64) / 16) * 16)

        // Reuse pre-allocated buffer if large enough, otherwise allocate new one
        let buffer, view
        if (bufferSize <= this._uniformBufferSize) {
            buffer = this._uniformBufferData
            view = this._uniformDataView
        } else {
            // Need larger buffer - allocate and cache for future reuse
            this._uniformBufferData = new ArrayBuffer(bufferSize)
            this._uniformDataView = new DataView(this._uniformBufferData)
            this._uniformBufferSize = bufferSize
            buffer = this._uniformBufferData
            view = this._uniformDataView
        }

        let offset = 0

        const alignTo = (currentOffset, alignment) => {
            return Math.ceil(currentOffset / alignment) * alignment
        }

        for (const name in uniforms) {
            const value = uniforms[name]
            if (value === undefined || value === null) continue

            if (typeof value === 'boolean') {
                // bool -> i32
                offset = alignTo(offset, 4)
                view.setInt32(offset, value ? 1 : 0, true)
                offset += 4
            } else if (typeof value === 'number') {
                // Determine if int or float based on whether it's an integer
                offset = alignTo(offset, 4)
                if (Number.isInteger(value) && name !== 'time' && name !== 'deltaTime' && name !== 'aspect') {
                    view.setInt32(offset, value, true)
                } else {
                    view.setFloat32(offset, value, true)
                }
                offset += 4
            } else if (Array.isArray(value)) {
                // Handle vectors
                if (value.length === 2) {
                    // vec2: 8-byte align
                    offset = alignTo(offset, 8)
                    view.setFloat32(offset, value[0], true)
                    view.setFloat32(offset + 4, value[1], true)
                    offset += 8
                } else if (value.length === 3) {
                    // vec3: 16-byte align (stored as vec4 in std140)
                    offset = alignTo(offset, 16)
                    view.setFloat32(offset, value[0], true)
                    view.setFloat32(offset + 4, value[1], true)
                    view.setFloat32(offset + 8, value[2], true)
                    // padding
                    offset += 16
                } else if (value.length === 4) {
                    // vec4: 16-byte align
                    offset = alignTo(offset, 16)
                    for (let i = 0; i < 4; i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                    offset += 16
                } else if (value.length === 9) {
                    // mat3: 3 vec4s (each vec3 padded to vec4)
                    offset = alignTo(offset, 16)
                    for (let col = 0; col < 3; col++) {
                        for (let row = 0; row < 3; row++) {
                            view.setFloat32(offset + row * 4, value[col * 3 + row], true)
                        }
                        offset += 16
                    }
                } else if (value.length === 16) {
                    // mat4: 4 vec4s
                    offset = alignTo(offset, 16)
                    for (let i = 0; i < 16; i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                    offset += 64
                } else {
                    // Generic array
                    for (let i = 0; i < value.length; i++) {
                        offset = alignTo(offset, 4)
                        view.setFloat32(offset, value[i], true)
                        offset += 4
                    }
                }
            }
        }

        // Return the buffer - ensure minimum size for struct compatibility
        // Many compute shaders expect larger uniform buffers for their structs
        const usedSize = Math.max(256, alignTo(offset, 16))
        return new Uint8Array(buffer, 0, usedSize)
    }

    /**
     * Pack uniforms into an ArrayBuffer according to a parsed layout.
     * The layout specifies where each uniform should be placed in the array<vec4<f32>, N> struct.
     *
     * Supports three layout formats:
     * 1. Byte layout (from parseWgslStructByteLayout): { type: 'byte', layout: [...] }
     * 2. Array format (from shader parsing): [{ name: 'time', slot: 0, components: 'z' }, ...]
     * 3. Object format (from effect definition): { time: { slot: 0, components: 'z' }, ... }
     *
     * @param {Object} uniforms - Map of uniform names to values
     * @param {Array|Object} layout - Layout specification
     * @returns {Uint8Array}
     */
    _resolveUniformAlias(name, uniforms, { includeChannelCount = false } = {}) {
        if (uniforms[name] !== undefined) return uniforms[name]
        if (name === 'width' && uniforms.resolution) return uniforms.resolution[0]
        if (name === 'height' && uniforms.resolution) return uniforms.resolution[1]
        if (name === 'channels') return 4.0
        if (includeChannelCount && name === 'channelCount') return 4.0
        return undefined
    }

    packUniformsWithLayout(uniforms, layout) {
        // Check for byte-based layout format
        if (layout && layout.type === 'byte' && Array.isArray(layout.layout)) {
            return this.packUniformsWithByteLayout(uniforms, layout.layout)
        }

        // Normalize layout to array format
        let layoutArray = layout
        if (!Array.isArray(layout)) {
            // Convert object format to array format
            layoutArray = []
            for (const [name, spec] of Object.entries(layout)) {
                layoutArray.push({ name, slot: spec.slot, components: spec.components })
            }
        }

        // Find the maximum slot index to determine buffer size
        let maxSlot = 0
        for (const entry of layoutArray) {
            maxSlot = Math.max(maxSlot, entry.slot)
        }

        // Each slot is a vec4 (16 bytes)
        const bufferSize = (maxSlot + 1) * 16
        const buffer = new ArrayBuffer(bufferSize)
        const view = new DataView(buffer)

        // Component offset mapping
        const componentOffset = { x: 0, y: 4, z: 8, w: 12 }

        for (const entry of layoutArray) {
            const value = this._resolveUniformAlias(entry.name, uniforms)
            if (value === undefined || value === null) {
                continue
            }

            const slotOffset = entry.slot * 16

            if (entry.components.length === 1) {
                // Single component (x, y, z, or w)
                const compOff = componentOffset[entry.components]
                const offset = slotOffset + compOff

                if (typeof value === 'boolean') {
                    view.setFloat32(offset, value ? 1.0 : 0.0, true)
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            } else if (entry.components.length === 2) {
                // Two components (xy, yz, etc.)
                const startComp = entry.components[0]
                const offset = slotOffset + componentOffset[startComp]

                if (Array.isArray(value)) {
                    for (let i = 0; i < Math.min(value.length, 2); i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            } else if (entry.components.length === 3) {
                // Three components (xyz)
                const startComp = entry.components[0]
                const offset = slotOffset + componentOffset[startComp]

                if (Array.isArray(value)) {
                    for (let i = 0; i < Math.min(value.length, 3); i++) {
                        view.setFloat32(offset + i * 4, value[i], true)
                    }
                } else if (typeof value === 'number') {
                    view.setFloat32(offset, value, true)
                }
            } else if (entry.components.length === 4) {
                // Four components (xyzw)
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

        return new Uint8Array(buffer)
    }

    /**
     * Pack uniforms into an ArrayBuffer using byte-based layout.
     * Each entry specifies exact byte offset and type for the uniform.
     *
     * @param {Object} uniforms - Map of uniform names to values
     * @param {Array<{name: string, offset: number, size: number, type: string, components: number}>} layout
     * @returns {Uint8Array}
     */
    packUniformsWithByteLayout(uniforms, layout) {
        // Use structSize if available, otherwise calculate from entries
        let totalSize = layout.structSize || 0
        if (!totalSize) {
            for (const entry of layout) {
                totalSize = Math.max(totalSize, entry.offset + entry.size)
            }
        }

        // Round up to 16-byte alignment for uniform buffer
        const bufferSize = Math.ceil(totalSize / 16) * 16
        const buffer = new ArrayBuffer(Math.max(bufferSize, 16))
        const view = new DataView(buffer)

        for (const entry of layout) {
            const value = this._resolveUniformAlias(entry.name, uniforms, { includeChannelCount: true })
            if (value === undefined || value === null) {
                continue
            }

            const { offset, type, components } = entry

            if (components === 1) {
                // Scalar value
                if (typeof value === 'boolean') {
                    if (type === 'int' || type === 'uint') {
                        view.setInt32(offset, value ? 1 : 0, true)
                    } else {
                        view.setFloat32(offset, value ? 1.0 : 0.0, true)
                    }
                } else if (typeof value === 'number') {
                    if (type === 'int') {
                        view.setInt32(offset, Math.round(value), true)
                    } else if (type === 'uint') {
                        view.setUint32(offset, Math.round(value), true)
                    } else {
                        view.setFloat32(offset, value, true)
                    }
                }
            } else if (Array.isArray(value)) {
                // Vector value
                for (let i = 0; i < Math.min(value.length, components); i++) {
                    const compOffset = offset + i * 4
                    if (type === 'int') {
                        view.setInt32(compOffset, Math.round(value[i]), true)
                    } else if (type === 'uint') {
                        view.setUint32(compOffset, Math.round(value[i]), true)
                    } else {
                        view.setFloat32(compOffset, value[i], true)
                    }
                }
            } else if (typeof value === 'number') {
                // Scalar assigned to vector - fill first component
                if (type === 'int') {
                    view.setInt32(offset, Math.round(value), true)
                } else if (type === 'uint') {
                    view.setUint32(offset, Math.round(value), true)
                } else {
                    view.setFloat32(offset, value, true)
                }
            }
        }

        return new Uint8Array(buffer)
    }

    beginFrame() {
        // Return active buffers to pool
        while (this.activeUniformBuffers.length > 0) {
            const buffer = this.activeUniformBuffers.pop()
            this.uniformBufferPool.push(buffer)
        }

        // Create command encoder for this frame
        this.commandEncoder = this.device.createCommandEncoder()
    }

    endFrame() {
        // Submit commands
        if (this.commandEncoder) {
            const commandBuffer = this.commandEncoder.finish()
            this.queue.submit([commandBuffer])
            this.commandEncoder = null
        }
    }

    present(textureId) {
        if (!this.context) return

        const tex = this.textures.get(textureId)
        if (!tex) return

        // Use a render pass to blit the texture to the canvas
        // This handles format conversion (e.g., rgba16float -> bgra8unorm)
        const pipeline = this.getBlitPipeline()
        const bindGroup = this.createBlitBindGroup(tex)

        const commandEncoder = this.device.createCommandEncoder()
        const canvasTexture = this.context.getCurrentTexture()
        const canvasView = canvasTexture.createView()

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: canvasView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        })

        renderPass.setPipeline(pipeline)
        renderPass.setBindGroup(0, bindGroup)
        renderPass.draw(3, 1, 0, 0) // Full-screen triangle
        renderPass.end()

        this.queue.submit([commandEncoder.finish()])
    }

    destroy(options = {}) {
        if (!options?.skipTextures) {
            for (const id of Array.from(this.textures.keys())) {
                this.destroyTexture(id)
            }

            this.textures.clear()
        }

        // The depth texture is owned by the backend but lives outside
        // this.textures, so free it explicitly regardless of skipTextures —
        // neither teardown path reaches it through the texture registry.
        if (this.depthTexture) {
            this.depthTexture.destroy()
            this.depthTexture = null
            this.depthTextureSize = { width: 0, height: 0 }
        }

        this.programs.clear()
        this.pipelines.clear()
        this.bindGroups.clear()
        this.samplers.clear()

        for (const buffer of this.uniformBufferPool) {
            buffer?.destroy?.()
        }
        this.uniformBufferPool = []

        for (const buffer of this.activeUniformBuffers) {
            buffer?.destroy?.()
        }
        this.activeUniformBuffers = []

        if (this.context?.unconfigure) {
            try {
                this.context.unconfigure()
            } catch (err) {
                console.warn('Failed to unconfigure WebGPU canvas context', err)
            }
        }

        this.context = null
        this.queue = null
    }

    /**
     * Get or create the blit pipeline for presenting to canvas
     */
    getBlitPipeline() {
        if (this._blitPipeline) return this._blitPipeline

        const blitShaderSource = `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }
            
            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(3.0, -1.0),
                    vec2<f32>(-1.0, 3.0)
                );
                // Standard UVs - internal blits now handle Y-flip
                var uv = array<vec2<f32>, 3>(
                    vec2<f32>(0.0, 0.0),
                    vec2<f32>(2.0, 0.0),
                    vec2<f32>(0.0, 2.0)
                );
                var output: VertexOutput;
                output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
                output.uv = uv[vertexIndex];
                return output;
            }
            
            @group(0) @binding(0) var srcTex: texture_2d<f32>;
            @group(0) @binding(1) var srcSampler: sampler;
            
            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                return textureSample(srcTex, srcSampler, input.uv);
            }
        `

        const module = this.device.createShaderModule({ code: blitShaderSource })

        this._blitPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_main'
            },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.canvasFormat || 'bgra8unorm'
                }]
            },
            primitive: {
                topology: 'triangle-list'
            }
        })

        return this._blitPipeline
    }

    /**
     * Create a bind group for blitting a texture to the canvas
     */
    createBlitBindGroup(tex) {
        const pipeline = this.getBlitPipeline()
        const sampler = this.samplers.get('default')

        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: tex.view },
                { binding: 1, resource: sampler }
            ]
        })
    }

    /**
     * Get or create the buffer-to-texture compute pipeline.
     * This copies data from a storage buffer (output_buffer) to a storage texture.
     */
    /**
     * Get the render pipeline for copying storage buffer data to a texture.
     * Uses a fullscreen quad with a fragment shader that reads from the buffer.
     * @param {string} format - The target texture format
     */
    getBufferToTextureRenderPipeline(format) {
        const cacheKey = `bufferToTexture_${format}`
        if (this._bufferToTextureRenderPipelines?.has(cacheKey)) {
            return this._bufferToTextureRenderPipelines.get(cacheKey)
        }

        if (!this._bufferToTextureRenderPipelines) {
            this._bufferToTextureRenderPipelines = new Map()
        }

        const shaderSource = `
            struct BufferToTextureParams {
                width: u32,
                height: u32,
                _pad0: u32,
                _pad1: u32,
            }
            
            @group(0) @binding(0) var<storage, read> input_buffer: array<f32>;
            @group(0) @binding(1) var<uniform> params: BufferToTextureParams;
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
            }
            
            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                // Fullscreen triangle
                var pos = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(3.0, -1.0),
                    vec2<f32>(-1.0, 3.0)
                );
                
                var output: VertexOutput;
                output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
                return output;
            }
            
            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                // Use fragment position directly (in pixels)
                let x = u32(input.position.x);
                let y = u32(input.position.y);
                
                if (x >= params.width || y >= params.height) {
                    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
                }
                
                let pixel_idx = y * params.width + x;
                let base = pixel_idx * 4u;
                
                return vec4<f32>(
                    input_buffer[base + 0u],
                    input_buffer[base + 1u],
                    input_buffer[base + 2u],
                    input_buffer[base + 3u]
                );
            }
        `

        const module = this.device.createShaderModule({ code: shaderSource })

        const pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_main'
            },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{ format }]
            },
            primitive: {
                topology: 'triangle-list'
            }
        })

        this._bufferToTextureRenderPipelines.set(cacheKey, pipeline)
        return pipeline
    }

    /**
     * Copy data from output_buffer storage buffer to a texture.
     * Uses a render pass with a fullscreen triangle to read from the buffer
     * and write to the texture via fragment shader output.
     */
    copyBufferToTexture(state, outputId, bufferName = 'output_buffer') {
        // Get the output storage buffer by name
        const outputBuffer = this.storageBuffers.get(bufferName)
        if (!outputBuffer) {
            console.warn(`[copyBufferToTexture] ${bufferName} not found`)
            return
        }

        // Resolve the output texture
        let outputTex = null
        const surfaceName = this.parseGlobalName(outputId)
        if (surfaceName) {
            const writeTexId = state.writeSurfaces?.[surfaceName]
            if (writeTexId) {
                outputTex = this.textures.get(writeTexId)
            }
        }
        if (!outputTex && outputId === 'outputTex') {
            // Try to get the render surface's write texture
            const renderSurfaceName = state?.graph?.renderSurface
            if (renderSurfaceName) {
                const writeTexId = state.writeSurfaces?.[renderSurfaceName]
                if (writeTexId) {
                    outputTex = this.textures.get(writeTexId)
                }
            }
        }
        if (!outputTex) {
            outputTex = this.textures.get(outputId)
        }

        if (!outputTex) {
            console.warn(`[copyBufferToTexture] Output texture not found: ${outputId}`)
            return
        }

        const width = state.screenWidth || outputTex.width
        const height = state.screenHeight || outputTex.height

        // Create params uniform buffer
        const paramsData = new Uint32Array([width, height, 0, 0])
        const paramsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
        this.queue.writeBuffer(paramsBuffer, 0, paramsData)

        // Get the pipeline for this texture format
        const format = outputTex.gpuFormat || 'rgba8unorm'
        const pipeline = this.getBufferToTextureRenderPipeline(format)

        // Create bind group
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: outputBuffer } },
                { binding: 1, resource: { buffer: paramsBuffer } }
            ]
        })

        // Execute the render pass
        const passEncoder = this.commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: outputTex.view,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }]
        })
        passEncoder.setPipeline(pipeline)
        passEncoder.setBindGroup(0, bindGroup)
        passEncoder.draw(3, 1, 0, 0)  // Fullscreen triangle
        passEncoder.end()

        // Clean up params buffer
        this.activeUniformBuffers.push(paramsBuffer)
    }

    resolveFormat(format) {
        const formats = {
            'rgba8': 'rgba8unorm',
            'rgba16f': 'rgba16float',
            'rgba32f': 'rgba32float',
            'r8': 'r8unorm',
            'r16f': 'r16float',
            'r32f': 'r32float',
            'rg8': 'rg8unorm',
            'rg16f': 'rg16float',
            'rg32f': 'rg32float',
            // Pass-through for already-resolved formats
            'rgba8unorm': 'rgba8unorm',
            'rgba16float': 'rgba16float',
            'rgba32float': 'rgba32float',
            'r8unorm': 'r8unorm',
            'r16float': 'r16float',
            'r32float': 'r32float',
            'bgra8unorm': 'bgra8unorm'
        }

        return formats[format] || format || 'rgba8unorm'
    }

    resolveUsage(usageArray) {
        let usage = 0

        for (const u of usageArray) {
            switch (u) {
                case 'render':
                    usage |= GPUTextureUsage.RENDER_ATTACHMENT
                    break
                case 'sample':
                    usage |= GPUTextureUsage.TEXTURE_BINDING
                    break
                case 'storage':
                    usage |= GPUTextureUsage.STORAGE_BINDING
                    break
                case 'copySrc':
                    usage |= GPUTextureUsage.COPY_SRC
                    break
                case 'copyDst':
                    usage |= GPUTextureUsage.COPY_DST
                    break
            }
        }

        return usage
    }

    getName() {
        return 'WebGPU'
    }

    /**
     * Read pixels from a texture for testing purposes.
     * Note: This is async due to WebGPU's buffer mapping requirements.
     * @param {string} textureId - The texture ID to read from
     * @returns {Promise<{width: number, height: number, data: Uint8Array}>}
     */
    async readPixels(textureId) {
        const tex = this.textures.get(textureId)
        if (!tex) {
            throw new Error(`Texture ${textureId} not found`)
        }

        const { handle, width, height, gpuFormat } = tex

        // Determine bytes per pixel based on format
        let bytesPerPixel = 4 // Default for rgba8unorm
        if (gpuFormat === 'rgba16float') {
            bytesPerPixel = 8 // 2 bytes per channel * 4 channels
        } else if (gpuFormat === 'rgba32float') {
            bytesPerPixel = 16 // 4 bytes per channel * 4 channels
        }

        const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256 // Align to 256 bytes
        const bufferSize = bytesPerRow * height

        // Create staging buffer for reading
        const stagingBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        })

        // Copy texture to staging buffer
        const commandEncoder = this.device.createCommandEncoder()
        commandEncoder.copyTextureToBuffer(
            { texture: handle },
            { buffer: stagingBuffer, bytesPerRow },
            { width, height, depthOrArrayLayers: 1 }
        )
        this.queue.submit([commandEncoder.finish()])

        // Map and read the buffer
        await stagingBuffer.mapAsync(GPUMapMode.READ)
        const mappedRange = stagingBuffer.getMappedRange()

        // Convert to Uint8Array output (0-255 per channel)
        const data = new Uint8Array(width * height * 4)

        if (gpuFormat === 'rgba16float') {
            // Read as float16 and convert to uint8
            const srcData = new Uint16Array(mappedRange)
            for (let row = 0; row < height; row++) {
                const srcRowOffset = (row * bytesPerRow) / 2 // Uint16Array offset
                for (let col = 0; col < width; col++) {
                    const srcPixel = srcRowOffset + col * 4
                    const dstPixel = (row * width + col) * 4
                    // Convert float16 to float32 then to uint8
                    for (let c = 0; c < 4; c++) {
                        const f16 = srcData[srcPixel + c]
                        const f32 = float16ToFloat32(f16)
                        data[dstPixel + c] = Math.max(0, Math.min(255, Math.round(f32 * 255)))
                    }
                }
            }
        } else if (gpuFormat === 'rgba32float') {
            // Read as float32 and convert to uint8
            const srcData = new Float32Array(mappedRange)
            for (let row = 0; row < height; row++) {
                const srcRowOffset = (row * bytesPerRow) / 4 // Float32Array offset
                for (let col = 0; col < width; col++) {
                    const srcPixel = srcRowOffset + col * 4
                    const dstPixel = (row * width + col) * 4
                    for (let c = 0; c < 4; c++) {
                        const f32 = srcData[srcPixel + c]
                        data[dstPixel + c] = Math.max(0, Math.min(255, Math.round(f32 * 255)))
                    }
                }
            }
        } else {
            // Assume rgba8unorm - direct copy (removing row padding)
            const srcData = new Uint8Array(mappedRange)
            for (let row = 0; row < height; row++) {
                const srcOffset = row * bytesPerRow
                const dstOffset = row * width * 4
                data.set(srcData.subarray(srcOffset, srcOffset + width * 4), dstOffset)
            }
        }

        stagingBuffer.unmap()
        stagingBuffer.destroy()

        return { width, height, data }
    }

    static async isAvailable() {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            return false
        }

        try {
            const adapter = await navigator.gpu.requestAdapter()
            return !!adapter
        } catch {
            return false
        }
    }
}
