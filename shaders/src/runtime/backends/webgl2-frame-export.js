import {
    DEFAULT_VERTEX_SHADER,
    FULLSCREEN_TRIANGLE_VERTEX_COUNT
} from '../default-shaders.js'

const ALPHA_MODE = Object.freeze({
    straight: 0,
    opaque: 1,
    premultiplied: 2
})

const RESOLVE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform int u_alphaMode;
out vec4 fragColor;

void main() {
    ivec2 sourceSize = textureSize(u_texture, 0);
    ivec2 sourceCoord = ivec2(
        int(gl_FragCoord.x),
        sourceSize.y - 1 - int(gl_FragCoord.y)
    );
    vec4 color = texelFetch(u_texture, sourceCoord, 0);
    if (u_alphaMode == 1) {
        color.a = 1.0;
    } else if (u_alphaMode == 2) {
        color.rgb *= color.a;
    }
    fragColor = color;
}
`

function validateDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError('Frame export descriptor must be an object')
    }
    if (!Number.isSafeInteger(descriptor.width) || descriptor.width <= 0) {
        throw new RangeError('Frame export width must be a positive integer')
    }
    if (!Number.isSafeInteger(descriptor.height) || descriptor.height <= 0) {
        throw new RangeError('Frame export height must be a positive integer')
    }
    if (descriptor.format !== 'rgba8unorm') {
        throw new TypeError("WebGL2 frame export format must be 'rgba8unorm'")
    }
    if (descriptor.colorSpace !== 'srgb' && descriptor.colorSpace !== 'display-p3') {
        throw new TypeError("WebGL2 frame export colorSpace must be 'srgb' or 'display-p3'")
    }
    if (!Object.hasOwn(ALPHA_MODE, descriptor.alphaMode)) {
        throw new TypeError("WebGL2 frame export alphaMode must be 'opaque', 'straight', or 'premultiplied'")
    }
    if (!Number.isFinite(descriptor.fps) || descriptor.fps <= 0) {
        throw new RangeError('Frame export fps must be finite and positive')
    }

    const byteLength = descriptor.width * descriptor.height * 4
    if (!Number.isSafeInteger(byteLength)) {
        throw new RangeError('Frame export dimensions are too large')
    }
    return byteLength
}

function deleteIfPresent(gl, method, value) {
    if (value) gl[method](value)
}

export class WebGL2FrameExportAdapter {
    constructor(backend) {
        if (!backend?.gl || !(backend.textures instanceof Map)) {
            throw new TypeError('WebGL2 frame export requires a backend with gl and textures')
        }
        this.backend = backend
        this.gl = backend.gl
        this._program = null
        this._slotCount = 0
    }

    createSlot(index, descriptor) {
        const byteLength = validateDescriptor(descriptor)
        const gl = this.gl
        const slot = {
            index,
            width: descriptor.width,
            height: descriptor.height,
            alphaMode: ALPHA_MODE[descriptor.alphaMode],
            texture: null,
            framebuffer: null,
            pbo: null,
            fence: null,
            ready: false,
            destroyed: false,
            registered: false,
            data: new Uint8Array(byteLength),
            frame: null
        }
        slot.frame = {
            width: descriptor.width,
            height: descriptor.height,
            rowStride: descriptor.width * 4,
            data: slot.data
        }

        try {
            this._ensureProgram()

            slot.texture = gl.createTexture()
            if (!slot.texture) throw new Error('Failed to create WebGL2 frame export resolve texture')
            gl.bindTexture(gl.TEXTURE_2D, slot.texture)
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA8,
                slot.width,
                slot.height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                null
            )
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

            slot.framebuffer = gl.createFramebuffer()
            if (!slot.framebuffer) throw new Error('Failed to create WebGL2 frame export framebuffer')
            gl.bindFramebuffer(gl.FRAMEBUFFER, slot.framebuffer)
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D,
                slot.texture,
                0
            )
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                throw new Error('WebGL2 frame export framebuffer is incomplete')
            }

            slot.pbo = gl.createBuffer()
            if (!slot.pbo) throw new Error('Failed to create WebGL2 frame export pixel pack buffer')
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo)
            gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ)

            slot.registered = true
            this._slotCount++
            return slot
        } catch (error) {
            this._destroyResources(slot)
            if (this._slotCount === 0) this._destroyProgram()
            throw error
        } finally {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.bindTexture(gl.TEXTURE_2D, null)
        }
    }

    begin(slot, textureId) {
        this._assertUsableSlot(slot)
        if (slot.fence) throw new Error('WebGL2 frame export slot is already pending')

        const source = this.backend.textures.get(textureId)
        if (!source?.handle) {
            throw new Error(`WebGL2 frame export texture ${String(textureId)} not found`)
        }
        if (source.width !== slot.width || source.height !== slot.height) {
            throw new Error(
                `WebGL2 frame export source extent ${String(source.width)}x${String(source.height)} ` +
                `does not match configured extent ${slot.width}x${slot.height}`
            )
        }
        if (!this.backend.fullscreenVAO) {
            throw new Error('WebGL2 frame export fullscreen geometry is unavailable')
        }

        const gl = this.gl
        slot.ready = false
        try {
            gl.bindFramebuffer(gl.FRAMEBUFFER, slot.framebuffer)
            gl.viewport(0, 0, slot.width, slot.height)
            gl.disable(gl.BLEND)
            gl.disable(gl.DEPTH_TEST)
            gl.disable(gl.SCISSOR_TEST)
            gl.disable(gl.CULL_FACE)
            gl.useProgram(this._program.handle)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, source.handle)
            gl.uniform1i(this._program.textureLocation, 0)
            gl.uniform1i(this._program.alphaModeLocation, slot.alphaMode)
            gl.bindVertexArray(this.backend.fullscreenVAO)
            gl.drawArrays(gl.TRIANGLES, 0, FULLSCREEN_TRIANGLE_VERTEX_COUNT)

            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo)
            gl.readPixels(0, 0, slot.width, slot.height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
            slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
            if (!slot.fence) throw new Error('Failed to create WebGL2 frame export fence')
            gl.flush()
            this._resetState()
        } catch (error) {
            this._deleteFence(slot)
            try {
                this._resetState()
            } catch {
                // Preserve the original GPU operation failure.
            }
            throw error
        }
    }

    poll(slot) {
        this._assertUsableSlot(slot)
        if (!slot.fence) throw new Error('WebGL2 frame export slot has no pending fence')
        if (slot.ready) return true

        const gl = this.gl
        let status
        try {
            status = gl.clientWaitSync(slot.fence, 0, 0)
        } catch (error) {
            this._deleteFence(slot)
            throw error
        }
        if (status === gl.TIMEOUT_EXPIRED) return false
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
            slot.ready = true
            return true
        }

        this._deleteFence(slot)
        if (status === gl.WAIT_FAILED) {
            throw new Error('WebGL2 frame export fence wait failed')
        }
        throw new Error(`Unexpected WebGL2 frame export fence status: ${String(status)}`)
    }

    read(slot) {
        this._assertUsableSlot(slot)
        if (!slot.fence || !slot.ready) {
            throw new Error('WebGL2 frame export slot is not ready after a signaled poll')
        }

        const gl = this.gl
        try {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo)
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, slot.data)
            return slot.frame
        } finally {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
            this._deleteFence(slot)
        }
    }

    destroySlot(slot) {
        if (!slot || slot.destroyed) return
        slot.destroyed = true
        this._destroyResources(slot)
        if (slot.registered) {
            slot.registered = false
            this._slotCount--
        }
        if (this._slotCount === 0) this._destroyProgram()
    }

    _assertUsableSlot(slot) {
        if (!slot || slot.destroyed || !slot.registered) {
            throw new Error('WebGL2 frame export slot is not usable')
        }
    }

    _compileShader(type, source) {
        const gl = this.gl
        const shader = gl.createShader(type)
        if (!shader) throw new Error('Failed to create WebGL2 frame export shader')
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(shader) || 'unknown compile error'
            gl.deleteShader(shader)
            throw new Error(`Failed to compile WebGL2 frame export shader: ${message}`)
        }
        return shader
    }

    _ensureProgram() {
        if (this._program) return

        const gl = this.gl
        let vertexShader = null
        let fragmentShader = null
        let handle = null
        try {
            vertexShader = this._compileShader(gl.VERTEX_SHADER, DEFAULT_VERTEX_SHADER)
            fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, RESOLVE_FRAGMENT_SHADER)
            handle = gl.createProgram()
            if (!handle) throw new Error('Failed to create WebGL2 frame export program')
            gl.attachShader(handle, vertexShader)
            gl.attachShader(handle, fragmentShader)
            gl.bindAttribLocation(handle, 0, 'a_position')
            gl.linkProgram(handle)
            if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
                const message = gl.getProgramInfoLog(handle) || 'unknown link error'
                throw new Error(`Failed to link WebGL2 frame export program: ${message}`)
            }
            this._program = {
                handle,
                textureLocation: gl.getUniformLocation(handle, 'u_texture'),
                alphaModeLocation: gl.getUniformLocation(handle, 'u_alphaMode')
            }
        } catch (error) {
            deleteIfPresent(gl, 'deleteProgram', handle)
            throw error
        } finally {
            deleteIfPresent(gl, 'deleteShader', vertexShader)
            deleteIfPresent(gl, 'deleteShader', fragmentShader)
        }
    }

    _resetState() {
        const gl = this.gl
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
        gl.bindVertexArray(null)
        gl.bindTexture(gl.TEXTURE_2D, null)
        gl.useProgram(null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    _deleteFence(slot) {
        if (slot.fence) {
            this.gl.deleteSync(slot.fence)
            slot.fence = null
        }
        slot.ready = false
    }

    _destroyResources(slot) {
        this._deleteFence(slot)
        deleteIfPresent(this.gl, 'deleteBuffer', slot.pbo)
        deleteIfPresent(this.gl, 'deleteFramebuffer', slot.framebuffer)
        deleteIfPresent(this.gl, 'deleteTexture', slot.texture)
        slot.pbo = null
        slot.framebuffer = null
        slot.texture = null
    }

    _destroyProgram() {
        if (!this._program) return
        this.gl.deleteProgram(this._program.handle)
        this._program = null
    }
}
