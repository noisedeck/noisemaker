import assert from 'node:assert/strict'
import test from 'node:test'

import { FrameExportQueue } from '../src/runtime/frame-export.js'
import { WebGPUFrameExportAdapter } from '../src/runtime/backends/webgpu-frame-export.js'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'

const GPU = Object.freeze({
    GPUTextureUsage: Object.freeze({
        COPY_SRC: 0x01,
        RENDER_ATTACHMENT: 0x02
    }),
    GPUBufferUsage: Object.freeze({
        MAP_READ: 0x04,
        COPY_DST: 0x08
    }),
    GPUMapMode: Object.freeze({ READ: 0x10 }),
    GPUShaderStage: Object.freeze({ FRAGMENT: 0x20 })
})

const DESCRIPTOR = Object.freeze({
    width: 65,
    height: 2,
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    alphaMode: 'straight',
    fps: 60
})

class FakeTexture {
    constructor(device, descriptor, kind = 'resolve') {
        this.device = device
        this.descriptor = descriptor
        this.kind = kind
        this.destroyCount = 0
        this.view = null
    }

    createView(descriptor = undefined) {
        this.device._call('createTextureView', this, descriptor)
        this.view = { texture: this, descriptor }
        return this.view
    }

    destroy() {
        this.device._call('destroyTexture', this)
        this.destroyCount++
    }
}

class FakeBuffer {
    constructor(device, descriptor) {
        this.device = device
        this.descriptor = descriptor
        this.bytes = new Uint8Array(descriptor.size)
        this.mapRequests = []
        this.getMappedRangeCount = 0
        this.unmapCount = 0
        this.destroyCount = 0
    }

    mapAsync(mode) {
        this.device._call('mapAsync', this, mode)
        let resolve
        let reject
        const promise = new Promise((onResolve, onReject) => {
            resolve = onResolve
            reject = onReject
        })
        const request = { promise, resolve, reject }
        this.mapRequests.push(request)
        return promise
    }

    getMappedRange() {
        this.device._call('getMappedRange', this)
        this.getMappedRangeCount++
        return this.bytes.buffer
    }

    unmap() {
        this.device._call('unmap', this)
        this.unmapCount++
    }

    destroy() {
        this.device._call('destroyBuffer', this)
        this.destroyCount++
    }
}

class FakeRenderPass {
    constructor(device, descriptor) {
        this.device = device
        this.descriptor = descriptor
    }

    setPipeline(pipeline) { this.device._call('setPipeline', this, pipeline) }
    setBindGroup(index, bindGroup) { this.device._call('setBindGroup', this, index, bindGroup) }
    draw(...args) { this.device._call('draw', this, ...args) }
    end() { this.device._call('endRenderPass', this) }
}

class FakeCommandEncoder {
    constructor(device) {
        this.device = device
    }

    beginRenderPass(descriptor) {
        this.device._call('beginRenderPass', this, descriptor)
        const pass = new FakeRenderPass(this.device, descriptor)
        this.device.created.renderPasses.push(pass)
        return pass
    }

    copyTextureToBuffer(source, destination, size) {
        this.device._call('copyTextureToBuffer', this, source, destination, size)
    }

    finish() {
        this.device._call('finish', this)
        return { encoder: this }
    }
}

class FakeDevice {
    constructor() {
        this.calls = []
        this.failMethod = null
        this.created = {
            bindGroupLayouts: [],
            shaderModules: [],
            pipelineLayouts: [],
            renderPipelines: [],
            textures: [],
            buffers: [],
            bindGroups: [],
            encoders: [],
            renderPasses: []
        }
        this.queue = {
            submit: commandBuffers => {
                this._call('submit', commandBuffers)
            }
        }
    }

    _call(name, ...args) {
        this.calls.push([name, ...args])
        if (this.failMethod === name) {
            this.failMethod = null
            throw new Error(`${name} failed`)
        }
    }

    createBindGroupLayout(descriptor) {
        this._call('createBindGroupLayout', descriptor)
        const value = { descriptor, kind: 'bind-group-layout' }
        this.created.bindGroupLayouts.push(value)
        return value
    }

    createShaderModule(descriptor) {
        this._call('createShaderModule', descriptor)
        const value = { descriptor, kind: 'shader-module' }
        this.created.shaderModules.push(value)
        return value
    }

    createPipelineLayout(descriptor) {
        this._call('createPipelineLayout', descriptor)
        const value = { descriptor, kind: 'pipeline-layout' }
        this.created.pipelineLayouts.push(value)
        return value
    }

    createRenderPipeline(descriptor) {
        this._call('createRenderPipeline', descriptor)
        const value = { descriptor, kind: 'render-pipeline' }
        this.created.renderPipelines.push(value)
        return value
    }

    createTexture(descriptor) {
        this._call('createTexture', descriptor)
        const value = new FakeTexture(this, descriptor)
        this.created.textures.push(value)
        return value
    }

    createBuffer(descriptor) {
        this._call('createBuffer', descriptor)
        const value = new FakeBuffer(this, descriptor)
        this.created.buffers.push(value)
        return value
    }

    createBindGroup(descriptor) {
        this._call('createBindGroup', descriptor)
        const value = { descriptor, kind: 'bind-group' }
        this.created.bindGroups.push(value)
        return value
    }

    createCommandEncoder() {
        this._call('createCommandEncoder')
        const value = new FakeCommandEncoder(this)
        this.created.encoders.push(value)
        return value
    }
}

function makeSource(device, width = DESCRIPTOR.width, height = DESCRIPTOR.height) {
    const handle = new FakeTexture(device, {
        size: { width, height, depthOrArrayLayers: 1 },
        format: 'rgba16float',
        usage: 0
    }, 'source')
    return {
        handle,
        view: handle.createView(),
        width,
        height,
        gpuFormat: 'rgba16float'
    }
}

function makeHarness(descriptor = DESCRIPTOR) {
    const device = new FakeDevice()
    const source = makeSource(device, descriptor.width, descriptor.height)
    device.calls.length = 0
    const backend = {
        device,
        queue: device.queue,
        textures: new Map([['source', source]])
    }
    return {
        device,
        source,
        backend,
        adapter: new WebGPUFrameExportAdapter(backend, GPU)
    }
}

function callsNamed(device, name) {
    return device.calls.filter(call => call[0] === name)
}

async function fulfillLastMap(slot) {
    slot.buffer.mapRequests.at(-1).resolve()
    await Promise.resolve()
    await Promise.resolve()
}

async function rejectLastMap(slot, error) {
    slot.buffer.mapRequests.at(-1).reject(error)
    await Promise.resolve()
    await Promise.resolve()
}

test('descriptor validation is exact and happens before WebGPU allocation', () => {
    const invalid = [
        null,
        {},
        { ...DESCRIPTOR, width: 0 },
        { ...DESCRIPTOR, width: 1.5 },
        { ...DESCRIPTOR, height: -1 },
        { ...DESCRIPTOR, height: Number.MAX_SAFE_INTEGER },
        { ...DESCRIPTOR, format: 'rgba8' },
        { ...DESCRIPTOR, format: 'rgba16float' },
        { ...DESCRIPTOR, colorSpace: 'rec2020' },
        { ...DESCRIPTOR, alphaMode: 'unpremultiplied' },
        { ...DESCRIPTOR, fps: 0 },
        { ...DESCRIPTOR, fps: Infinity }
    ]

    for (const descriptor of invalid) {
        const { device, adapter } = makeHarness()
        assert.throws(() => adapter.createSlot(0, descriptor), { name: /TypeError|RangeError/ })
        assert.equal(device.created.textures.length, 0)
        assert.equal(device.created.buffers.length, 0)
        assert.equal(device.created.renderPipelines.length, 0)
    }
})

test('three slots allocate exact fixed resolve and aligned staging resources', () => {
    const { device, adapter } = makeHarness()
    const slots = [0, 1, 2].map(index => adapter.createSlot(index, DESCRIPTOR))

    assert.equal(device.created.textures.length, 3)
    assert.equal(device.created.buffers.length, 3)
    assert.equal(device.created.renderPipelines.length, 3)
    assert.equal(device.created.shaderModules.length, 1)
    assert.equal(device.created.bindGroupLayouts.length, 1)
    assert.equal(device.created.pipelineLayouts.length, 1)
    assert.equal(new Set(slots.map(slot => slot.data)).size, 3)
    assert.equal(new Set(slots.map(slot => slot.frame)).size, 3)

    for (const [index, slot] of slots.entries()) {
        assert.equal(slot.rowStride, 260)
        assert.equal(slot.bytesPerRow, 512)
        assert.equal(slot.bufferSize, 1024)
        assert.deepEqual(device.created.textures[index].descriptor, {
            size: { width: 65, height: 2, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: GPU.GPUTextureUsage.RENDER_ATTACHMENT | GPU.GPUTextureUsage.COPY_SRC
        })
        assert.deepEqual(device.created.buffers[index].descriptor, {
            size: 1024,
            usage: GPU.GPUBufferUsage.COPY_DST | GPU.GPUBufferUsage.MAP_READ
        })
        assert.equal(slot.data.length, 520)
        assert.deepEqual(slot.frame, {
            width: 65,
            height: 2,
            rowStride: 260,
            data: slot.data
        })
    }

    const aligned = { ...DESCRIPTOR, width: 64 }
    const alignedHarness = makeHarness(aligned)
    const alignedSlot = alignedHarness.adapter.createSlot(0, aligned)
    assert.equal(alignedSlot.rowStride, 256)
    assert.equal(alignedSlot.bytesPerRow, 256)
    assert.equal(alignedSlot.bufferSize, 512)
})

test('the resolve shader uses textureLoad, explicit unfilterable-float layout, top-down coordinates, and three alpha variants', () => {
    const { device, adapter } = makeHarness()
    const slots = [
        adapter.createSlot(0, { ...DESCRIPTOR, alphaMode: 'straight' }),
        adapter.createSlot(1, { ...DESCRIPTOR, alphaMode: 'opaque' }),
        adapter.createSlot(2, { ...DESCRIPTOR, alphaMode: 'premultiplied' })
    ]
    const code = device.created.shaderModules[0].descriptor.code

    assert.match(code, /textureLoad\s*\(/)
    assert.match(code, /vec2<i32>\s*\(\s*i32\s*\(\s*position\.x\s*\)\s*,\s*i32\s*\(\s*position\.y\s*\)\s*\)/)
    assert.doesNotMatch(code, /sampler/)
    assert.doesNotMatch(code, /height\s*-/)
    assert.match(code, /vec4<f32>\s*\(\s*color\.rgb\s*,\s*1\.0\s*\)/)
    assert.match(code, /color\.rgb\s*\*\s*color\.a/)

    assert.deepEqual(device.created.bindGroupLayouts[0].descriptor.entries, [{
        binding: 0,
        visibility: GPU.GPUShaderStage.FRAGMENT,
        texture: {
            sampleType: 'unfilterable-float',
            viewDimension: '2d',
            multisampled: false
        }
    }])
    assert.deepEqual(
        device.created.renderPipelines.map(pipeline => pipeline.descriptor.fragment.entryPoint),
        ['straight_main', 'opaque_main', 'premultiplied_main']
    )
    for (const pipeline of device.created.renderPipelines) {
        assert.equal(pipeline.descriptor.fragment.targets[0].format, 'rgba8unorm')
    }
    assert.deepEqual(slots.map(slot => slot.alphaMode), ['straight', 'opaque', 'premultiplied'])
})

test('partial slot allocation failure destroys the resolve texture and leaves shared resources bounded', () => {
    for (const method of ['createTextureView', 'createBuffer']) {
        const { device, adapter } = makeHarness()
        device.failMethod = method

        assert.throws(() => adapter.createSlot(0, DESCRIPTOR), new RegExp(`${method} failed`))
        assert.equal(device.created.textures.length, 1)
        assert.equal(device.created.textures[0].destroyCount, 1)
        assert.equal(device.created.buffers.length, 0)
        assert.equal(device.created.renderPipelines.length, 3)
    }
})

test('begin records resolve then copy then submit then map without awaiting or reading output', () => {
    const { device, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    const data = slot.data
    const frame = slot.frame
    device.calls.length = 0

    const result = adapter.begin(slot, 'source', 1234)

    assert.equal(result, undefined)
    const names = device.calls.map(call => call[0])
    const beginPass = names.indexOf('beginRenderPass')
    const endPass = names.indexOf('endRenderPass')
    const copy = names.indexOf('copyTextureToBuffer')
    const finish = names.indexOf('finish')
    const submit = names.indexOf('submit')
    const map = names.indexOf('mapAsync')
    assert.ok(beginPass >= 0 && beginPass < endPass)
    assert.ok(endPass < copy && copy < finish && finish < submit && submit < map)
    assert.deepEqual(callsNamed(device, 'draw')[0].slice(2), [3, 1, 0, 0])
    assert.deepEqual(callsNamed(device, 'copyTextureToBuffer')[0].slice(2), [
        { texture: slot.resolveTexture },
        { buffer: slot.buffer, bytesPerRow: 512, rowsPerImage: 2 },
        { width: 65, height: 2, depthOrArrayLayers: 1 }
    ])
    assert.equal(slot.buffer.mapRequests.length, 1)
    assert.equal(slot.buffer.getMappedRangeCount, 0)
    assert.equal(slot.data, data)
    assert.equal(slot.frame, frame)
    assert.equal(slot.state, 'pending')
})

test('source bind groups are cached by texture identity and reset at adapter lifecycle end', async () => {
    const { device, backend, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)

    adapter.begin(slot, 'source', 1)
    await fulfillLastMap(slot)
    adapter.read(slot)
    adapter.begin(slot, 'source', 2)
    await fulfillLastMap(slot)
    adapter.read(slot)
    assert.equal(device.created.bindGroups.length, 1)

    const other = makeSource(device)
    backend.textures.set('other', other)
    adapter.begin(slot, 'other', 3)
    await fulfillLastMap(slot)
    adapter.read(slot)
    assert.equal(device.created.bindGroups.length, 2)

    adapter.destroySlot(slot)
    const replacement = adapter.createSlot(0, DESCRIPTOR)
    adapter.begin(replacement, 'source', 4)
    assert.equal(device.created.bindGroups.length, 3)
})

test('poll is synchronously false while pending and true only after map fulfillment', async () => {
    const { adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)

    adapter.begin(slot, 'source', 1)
    assert.equal(adapter.poll(slot), false)
    await fulfillLastMap(slot)
    assert.equal(adapter.poll(slot), true)
    assert.equal(adapter.poll(slot), true)
})

test('a map rejection is reported exactly once and leaves the slot reusable', async () => {
    const { adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    const rejection = new Error('mapping rejected')

    adapter.begin(slot, 'source', 1)
    await rejectLastMap(slot, rejection)
    assert.throws(() => adapter.poll(slot), error => error === rejection)
    assert.throws(() => adapter.poll(slot), /pending/i)

    assert.doesNotThrow(() => adapter.begin(slot, 'source', 2))
    await fulfillLastMap(slot)
    assert.equal(adapter.poll(slot), true)
})

test('read copies an aligned mapped frame without creating row subarray views', async () => {
    const descriptor = { ...DESCRIPTOR, width: 64, height: 3 }
    const { adapter } = makeHarness(descriptor)
    const slot = adapter.createSlot(0, descriptor)
    const stableData = slot.data
    const stableFrame = slot.frame

    adapter.begin(slot, 'source', 1)
    for (let index = 0; index < slot.buffer.bytes.length; index++) {
        slot.buffer.bytes[index] = (index * 19 + 7) & 0xff
    }
    const expected = Uint8Array.from(slot.buffer.bytes)
    await fulfillLastMap(slot)

    const originalSubarray = Uint8Array.prototype.subarray
    let subarrayCalls = 0
    let frame
    Uint8Array.prototype.subarray = function (...args) {
        subarrayCalls++
        return originalSubarray.apply(this, args)
    }
    try {
        frame = adapter.read(slot)
    } finally {
        Uint8Array.prototype.subarray = originalSubarray
    }

    assert.equal(subarrayCalls, 0)
    assert.equal(frame, stableFrame)
    assert.equal(frame.data, stableData)
    assert.deepEqual(frame.data, expected)
    assert.equal(slot.buffer.unmapCount, 1)
    assert.equal(slot.state, 'idle')
})

test('read compacts padded rows with at most one whole-frame subarray view and preserves top-down output', async () => {
    const descriptor = { ...DESCRIPTOR, width: 2, height: 4 }
    const { adapter } = makeHarness(descriptor)
    const slot = adapter.createSlot(0, descriptor)
    const stableData = slot.data
    const stableFrame = slot.frame

    adapter.begin(slot, 'source', 1)
    slot.buffer.bytes.fill(0xee)
    slot.buffer.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0)
    slot.buffer.bytes.set([11, 12, 13, 14, 15, 16, 17, 18], 256)
    slot.buffer.bytes.set([21, 22, 23, 24, 25, 26, 27, 28], 512)
    slot.buffer.bytes.set([31, 32, 33, 34, 35, 36, 37, 38], 768)
    await fulfillLastMap(slot)
    assert.equal(adapter.poll(slot), true)

    const originalSubarray = Uint8Array.prototype.subarray
    let subarrayCalls = 0
    let frame
    Uint8Array.prototype.subarray = function (...args) {
        subarrayCalls++
        return originalSubarray.apply(this, args)
    }
    try {
        frame = adapter.read(slot)
    } finally {
        Uint8Array.prototype.subarray = originalSubarray
    }

    assert.ok(subarrayCalls <= 1, `expected at most one subarray view, got ${subarrayCalls}`)
    assert.equal(frame, stableFrame)
    assert.equal(frame.data, stableData)
    assert.deepEqual([...frame.data], [
        1, 2, 3, 4, 5, 6, 7, 8,
        11, 12, 13, 14, 15, 16, 17, 18,
        21, 22, 23, 24, 25, 26, 27, 28,
        31, 32, 33, 34, 35, 36, 37, 38
    ])
    assert.equal(frame.rowStride, 8)
    assert.equal(slot.buffer.unmapCount, 1)
    assert.equal(slot.state, 'idle')
})

test('a completed slot reuses all GPU and CPU resources for the next submission', async () => {
    const { device, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    const resources = [slot.resolveTexture, slot.resolveView, slot.buffer, slot.data, slot.frame]

    for (let sequence = 0; sequence < 2; sequence++) {
        adapter.begin(slot, 'source', sequence)
        await fulfillLastMap(slot)
        adapter.read(slot)
    }

    assert.deepEqual(
        [slot.resolveTexture, slot.resolveView, slot.buffer, slot.data, slot.frame],
        resources
    )
    assert.equal(device.created.textures.length, 1)
    assert.equal(device.created.buffers.length, 1)
    assert.equal(slot.buffer.mapRequests.length, 2)
    assert.equal(slot.buffer.unmapCount, 2)
})

test('missing or mismatched source textures fail before command encoding and remain reusable', () => {
    const { device, backend, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    const wrongSize = makeSource(device, DESCRIPTOR.width - 1, DESCRIPTOR.height)
    backend.textures.set('wrong-size', wrongSize)
    device.calls.length = 0

    assert.throws(() => adapter.begin(slot, 'missing', 1), /not found/i)
    assert.throws(() => adapter.begin(slot, 'wrong-size', 2), /extent/i)
    assert.equal(callsNamed(device, 'createCommandEncoder').length, 0)
    assert.doesNotThrow(() => adapter.begin(slot, 'source', 3))
})

test('encoder, pass, copy, submit, and map initiation failures leave the slot reusable', () => {
    for (const method of [
        'createCommandEncoder',
        'beginRenderPass',
        'setPipeline',
        'copyTextureToBuffer',
        'finish',
        'submit',
        'mapAsync'
    ]) {
        const { device, adapter } = makeHarness()
        const slot = adapter.createSlot(0, DESCRIPTOR)
        device.failMethod = method

        assert.throws(() => adapter.begin(slot, 'source', 1), new RegExp(`${method} failed`))
        assert.equal(slot.state, 'idle')
        assert.doesNotThrow(() => adapter.begin(slot, 'source', 2))
    }
})

test('read failure unmaps and returns the slot to idle for failure isolation', async () => {
    const { device, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    adapter.begin(slot, 'source', 1)
    await fulfillLastMap(slot)
    device.failMethod = 'getMappedRange'

    assert.throws(() => adapter.read(slot), /getMappedRange failed/)
    assert.equal(slot.buffer.unmapCount, 1)
    assert.equal(slot.state, 'idle')
    assert.doesNotThrow(() => adapter.begin(slot, 'source', 2))
})

test('destroySlot is idempotent while idle, pending, or ready and ignores late map callbacks', async () => {
    for (const state of ['idle', 'pending', 'ready']) {
        const { adapter } = makeHarness()
        const slot = adapter.createSlot(0, DESCRIPTOR)

        if (state !== 'idle') adapter.begin(slot, 'source', 1)
        if (state === 'ready') await fulfillLastMap(slot)
        const request = slot.buffer.mapRequests.at(-1)

        adapter.destroySlot(slot)
        adapter.destroySlot(slot)
        assert.equal(slot.resolveTexture.destroyCount, 1)
        assert.equal(slot.buffer.destroyCount, 1)
        assert.equal(slot.destroyed, true)

        if (state === 'pending') {
            request.resolve()
            await Promise.resolve()
            await Promise.resolve()
            assert.equal(slot.state, 'destroyed')
        }
        assert.throws(() => adapter.poll(slot), /usable/i)
        assert.throws(() => adapter.begin(slot, 'source', 2), /usable/i)
    }
})

test('backend factory returns FrameExportQueue with three slots and preserves the shared 2-8 validation', () => {
    const device = new FakeDevice()
    const backend = Object.create(WebGPUBackend.prototype)
    backend.device = device
    backend.queue = device.queue
    backend.textures = new Map()

    const defaultQueue = backend.createFrameExportQueue({ gpuConstants: GPU })
    const overrideQueue = backend.createFrameExportQueue({ slots: 2, gpuConstants: GPU })

    assert.ok(defaultQueue instanceof FrameExportQueue)
    assert.ok(defaultQueue.adapter instanceof WebGPUFrameExportAdapter)
    assert.equal(defaultQueue._slots.length, 3)
    assert.equal(overrideQueue._slots.length, 2)
    assert.throws(() => backend.createFrameExportQueue({ slots: 1, gpuConstants: GPU }), RangeError)
    assert.throws(() => backend.createFrameExportQueue({ slots: 9, gpuConstants: GPU }), RangeError)
})
