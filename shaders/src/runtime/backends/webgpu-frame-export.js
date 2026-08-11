const ALPHA_MODES = Object.freeze([
    'straight',
    'opaque',
    'premultiplied'
])

const RESOLVE_SHADER = `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    return output;
}

fn loadColor(position: vec4<f32>) -> vec4<f32> {
    let sourceCoord = vec2<i32>(i32(position.x), i32(position.y));
    return textureLoad(sourceTexture, sourceCoord, 0);
}

@fragment
fn straight_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return loadColor(input.position);
}

@fragment
fn opaque_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let color = loadColor(input.position);
    return vec4<f32>(color.rgb, 1.0);
}

@fragment
fn premultiplied_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let color = loadColor(input.position);
    return vec4<f32>(color.rgb * color.a, color.a);
}
`

function checkedProduct(left, right, message) {
    const value = left * right
    if (!Number.isSafeInteger(value)) throw new RangeError(message)
    return value
}

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
        throw new TypeError("WebGPU frame export format must be 'rgba8unorm'")
    }
    if (descriptor.colorSpace !== 'srgb' && descriptor.colorSpace !== 'display-p3') {
        throw new TypeError("WebGPU frame export colorSpace must be 'srgb' or 'display-p3'")
    }
    if (!ALPHA_MODES.includes(descriptor.alphaMode)) {
        throw new TypeError("WebGPU frame export alphaMode must be 'opaque', 'straight', or 'premultiplied'")
    }
    if (!Number.isFinite(descriptor.fps) || descriptor.fps <= 0) {
        throw new RangeError('Frame export fps must be finite and positive')
    }

    const rowStride = checkedProduct(
        descriptor.width,
        4,
        'Frame export dimensions are too large'
    )
    const alignedRows = Math.ceil(rowStride / 256)
    const bytesPerRow = checkedProduct(
        alignedRows,
        256,
        'Frame export aligned row size is too large'
    )
    const bufferSize = checkedProduct(
        bytesPerRow,
        descriptor.height,
        'Frame export dimensions are too large'
    )
    const packedSize = checkedProduct(
        rowStride,
        descriptor.height,
        'Frame export dimensions are too large'
    )

    return { rowStride, bytesPerRow, bufferSize, packedSize }
}

function firstError(current, error) {
    return current || error
}

export class WebGPUFrameExportAdapter {
    constructor(backend, gpuConstants = globalThis) {
        if (!backend?.device || !backend?.queue || !(backend.textures instanceof Map)) {
            throw new TypeError('WebGPU frame export requires a backend with device, queue, and textures')
        }
        this.backend = backend
        this.device = backend.device
        this.queue = backend.queue
        this.gpuConstants = gpuConstants
        this._shared = null
        this._bindGroups = new WeakMap()
        this._slotCount = 0
    }

    createSlot(index, descriptor) {
        const layout = validateDescriptor(descriptor)
        const constants = this._getConstants()
        const data = new Uint8Array(layout.packedSize)
        const slot = {
            index,
            width: descriptor.width,
            height: descriptor.height,
            alphaMode: descriptor.alphaMode,
            rowStride: layout.rowStride,
            bytesPerRow: layout.bytesPerRow,
            bufferSize: layout.bufferSize,
            data,
            frame: {
                width: descriptor.width,
                height: descriptor.height,
                rowStride: layout.rowStride,
                data
            },
            resolveTexture: null,
            resolveView: null,
            buffer: null,
            state: 'idle',
            error: null,
            mapPromise: null,
            generation: 0,
            destroyed: false,
            registered: false
        }

        try {
            this._ensureShared(constants)
            slot.resolveTexture = this.device.createTexture({
                size: {
                    width: slot.width,
                    height: slot.height,
                    depthOrArrayLayers: 1
                },
                format: 'rgba8unorm',
                usage: constants.GPUTextureUsage.RENDER_ATTACHMENT |
                    constants.GPUTextureUsage.COPY_SRC
            })
            if (!slot.resolveTexture) {
                throw new Error('Failed to create WebGPU frame export resolve texture')
            }
            slot.resolveView = slot.resolveTexture.createView()
            if (!slot.resolveView) {
                throw new Error('Failed to create WebGPU frame export resolve texture view')
            }
            slot.buffer = this.device.createBuffer({
                size: slot.bufferSize,
                usage: constants.GPUBufferUsage.COPY_DST |
                    constants.GPUBufferUsage.MAP_READ
            })
            if (!slot.buffer) {
                throw new Error('Failed to create WebGPU frame export staging buffer')
            }

            slot.registered = true
            this._slotCount++
            return slot
        } catch (error) {
            try {
                slot.buffer?.destroy()
            } catch {
                // Preserve the original allocation failure.
            }
            try {
                slot.resolveTexture?.destroy()
            } catch {
                // Preserve the original allocation failure.
            }
            if (this._slotCount === 0) this._destroyShared()
            throw error
        }
    }

    begin(slot, textureId) {
        this._assertUsableSlot(slot)
        if (slot.state !== 'idle') {
            throw new Error('WebGPU frame export slot already has a pending map')
        }

        const source = this.backend.textures.get(textureId)
        if (!source?.handle || !source?.view) {
            throw new Error(`WebGPU frame export texture ${String(textureId)} not found`)
        }
        if (source.width !== slot.width || source.height !== slot.height) {
            throw new Error(
                `WebGPU frame export source extent ${String(source.width)}x${String(source.height)} ` +
                `does not match configured extent ${slot.width}x${slot.height}`
            )
        }
        if ((typeof source.handle !== 'object' || source.handle === null) &&
            typeof source.handle !== 'function') {
            throw new TypeError('WebGPU frame export source texture identity must be an object')
        }

        const bindGroup = this._getBindGroup(source)
        const encoder = this.device.createCommandEncoder()
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: slot.resolveView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        })
        renderPass.setPipeline(this._shared.pipelines[slot.alphaMode])
        renderPass.setBindGroup(0, bindGroup)
        renderPass.draw(3, 1, 0, 0)
        renderPass.end()
        encoder.copyTextureToBuffer(
            { texture: slot.resolveTexture },
            {
                buffer: slot.buffer,
                bytesPerRow: slot.bytesPerRow,
                rowsPerImage: slot.height
            },
            {
                width: slot.width,
                height: slot.height,
                depthOrArrayLayers: 1
            }
        )
        const commandBuffer = encoder.finish()
        this.queue.submit([commandBuffer])

        const token = ++slot.generation
        slot.state = 'pending'
        slot.error = null
        let mapPromise
        try {
            mapPromise = slot.buffer.mapAsync(this._getConstants().GPUMapMode.READ)
            if (!mapPromise || typeof mapPromise.then !== 'function') {
                throw new TypeError('WebGPU frame export mapAsync must return a promise')
            }
            slot.mapPromise = mapPromise
            mapPromise.then(
                () => {
                    if (slot.destroyed || slot.generation !== token || slot.state !== 'pending') return
                    slot.mapPromise = null
                    slot.state = 'ready'
                },
                error => {
                    if (slot.destroyed || slot.generation !== token || slot.state !== 'pending') return
                    slot.mapPromise = null
                    slot.error = error instanceof Error ? error : new Error(String(error))
                    slot.state = 'failed'
                }
            )
        } catch (error) {
            slot.generation++
            slot.state = 'idle'
            slot.error = null
            slot.mapPromise = null
            throw error
        }
    }

    poll(slot) {
        this._assertUsableSlot(slot)
        if (slot.state === 'pending') return false
        if (slot.state === 'ready') return true
        if (slot.state === 'failed') {
            const error = slot.error || new Error('WebGPU frame export mapping failed')
            slot.error = null
            slot.mapPromise = null
            slot.state = 'idle'
            throw error
        }
        throw new Error('WebGPU frame export slot has no pending map')
    }

    read(slot) {
        this._assertUsableSlot(slot)
        if (slot.state !== 'ready') {
            throw new Error('WebGPU frame export slot is not ready after a completed map')
        }

        try {
            const mappedRange = slot.buffer.getMappedRange()
            const source = new Uint8Array(mappedRange)
            if (slot.bytesPerRow === slot.rowStride) {
                slot.data.set(source)
            } else {
                for (let row = 1; row < slot.height; row++) {
                    const sourceOffset = row * slot.bytesPerRow
                    const destinationOffset = row * slot.rowStride
                    source.copyWithin(
                        destinationOffset,
                        sourceOffset,
                        sourceOffset + slot.rowStride
                    )
                }
                slot.data.set(source.subarray(0, slot.data.length))
            }
            return slot.frame
        } finally {
            try {
                slot.buffer.unmap()
            } finally {
                slot.generation++
                slot.mapPromise = null
                slot.error = null
                slot.state = 'idle'
            }
        }
    }

    destroySlot(slot) {
        if (!slot || slot.destroyed) return

        slot.destroyed = true
        slot.generation++
        const previousState = slot.state
        slot.state = 'destroyed'
        slot.error = null
        slot.mapPromise = null
        let error = null

        if (previousState === 'pending' || previousState === 'ready') {
            try {
                slot.buffer?.unmap()
            } catch (unmapError) {
                error = firstError(error, unmapError)
            }
        }
        try {
            slot.resolveTexture?.destroy()
        } catch (textureError) {
            error = firstError(error, textureError)
        }
        try {
            slot.buffer?.destroy()
        } catch (bufferError) {
            error = firstError(error, bufferError)
        }

        if (slot.registered) {
            slot.registered = false
            this._slotCount--
        }
        if (this._slotCount === 0) this._destroyShared()
        if (error) throw error
    }

    _assertUsableSlot(slot) {
        if (!slot || slot.destroyed || !slot.registered) {
            throw new Error('WebGPU frame export slot is not usable')
        }
    }

    _getConstants() {
        const constants = this.gpuConstants
        if (!constants?.GPUTextureUsage ||
            !constants?.GPUBufferUsage ||
            !constants?.GPUMapMode ||
            !constants?.GPUShaderStage) {
            throw new Error('WebGPU frame export constants are unavailable')
        }
        return constants
    }

    _ensureShared(constants) {
        if (this._shared) return

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: constants.GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                    viewDimension: '2d',
                    multisampled: false
                }
            }]
        })
        const shaderModule = this.device.createShaderModule({ code: RESOLVE_SHADER })
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        })
        const pipelines = {}
        for (const alphaMode of ALPHA_MODES) {
            pipelines[alphaMode] = this.device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: shaderModule,
                    entryPoint: 'vs_main'
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: `${alphaMode}_main`,
                    targets: [{ format: 'rgba8unorm' }]
                },
                primitive: { topology: 'triangle-list' }
            })
        }
        this._shared = { bindGroupLayout, shaderModule, pipelineLayout, pipelines }
    }

    _getBindGroup(source) {
        let bindGroup = this._bindGroups.get(source.handle)
        if (!bindGroup) {
            bindGroup = this.device.createBindGroup({
                layout: this._shared.bindGroupLayout,
                entries: [{ binding: 0, resource: source.view }]
            })
            this._bindGroups.set(source.handle, bindGroup)
        }
        return bindGroup
    }

    _destroyShared() {
        this._shared = null
        this._bindGroups = new WeakMap()
    }
}
