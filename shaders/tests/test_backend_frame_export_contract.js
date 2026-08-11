import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'

const GPU = Object.freeze({
    GPUTextureUsage: Object.freeze({ COPY_SRC: 0x01, RENDER_ATTACHMENT: 0x02 }),
    GPUBufferUsage: Object.freeze({ MAP_READ: 0x04, COPY_DST: 0x08 }),
    GPUMapMode: Object.freeze({ READ: 0x10 }),
    GPUShaderStage: Object.freeze({ FRAGMENT: 0x20 })
})

function descriptor(width, alphaMode = 'straight') {
    return {
        width,
        height: 2,
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        alphaMode,
        fps: 60
    }
}

function packedPattern(width, height) {
    const bytes = new Uint8Array(width * height * 4)
    const rowStride = width * 4
    for (let row = 0; row < height; row++) {
        for (let offset = 0; offset < rowStride; offset++) {
            bytes[row * rowStride + offset] = (row * 71 + offset * 13) & 0xff
        }
    }
    return bytes
}

class ContractWebGL2 {
    constructor() {
        Object.assign(this, {
            TEXTURE_2D: 0x0de1,
            TEXTURE0: 0x84c0,
            TEXTURE_MIN_FILTER: 0x2801,
            TEXTURE_MAG_FILTER: 0x2800,
            TEXTURE_WRAP_S: 0x2802,
            TEXTURE_WRAP_T: 0x2803,
            NEAREST: 0x2600,
            CLAMP_TO_EDGE: 0x812f,
            RGBA8: 0x8058,
            RGBA: 0x1908,
            UNSIGNED_BYTE: 0x1401,
            FRAMEBUFFER: 0x8d40,
            COLOR_ATTACHMENT0: 0x8ce0,
            FRAMEBUFFER_COMPLETE: 0x8cd5,
            PIXEL_PACK_BUFFER: 0x88eb,
            STREAM_READ: 0x88e1,
            VERTEX_SHADER: 0x8b31,
            FRAGMENT_SHADER: 0x8b30,
            COMPILE_STATUS: 0x8b81,
            LINK_STATUS: 0x8b82,
            TRIANGLES: 0x0004,
            BLEND: 0x0be2,
            DEPTH_TEST: 0x0b71,
            SCISSOR_TEST: 0x0c11,
            CULL_FACE: 0x0b44,
            SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
            TIMEOUT_EXPIRED: 0x911b,
            CONDITION_SATISFIED: 0x911c,
            WAIT_FAILED: 0x911d,
            ALREADY_SIGNALED: 0x911a
        })
        this.calls = []
        this.shaderSources = []
        this.created = { texture: [], framebuffer: [], buffer: [], shader: [], program: [], fence: [] }
        this.deleted = { texture: [], framebuffer: [], buffer: [], shader: [], program: [], fence: [] }
        this._boundPbo = null
        this._nextId = 1
    }

    _object(kind) {
        const value = { kind, id: this._nextId++ }
        this.created[kind].push(value)
        return value
    }

    _call(name, ...args) { this.calls.push([name, ...args]) }
    createTexture() { this._call('createTexture'); return this._object('texture') }
    bindTexture(...args) { this._call('bindTexture', ...args) }
    texImage2D(...args) { this._call('texImage2D', ...args) }
    texParameteri(...args) { this._call('texParameteri', ...args) }
    deleteTexture(value) { this._call('deleteTexture', value); this.deleted.texture.push(value) }
    createFramebuffer() { this._call('createFramebuffer'); return this._object('framebuffer') }
    bindFramebuffer(...args) { this._call('bindFramebuffer', ...args) }
    framebufferTexture2D(...args) { this._call('framebufferTexture2D', ...args) }
    checkFramebufferStatus(...args) { this._call('checkFramebufferStatus', ...args); return this.FRAMEBUFFER_COMPLETE }
    deleteFramebuffer(value) { this._call('deleteFramebuffer', value); this.deleted.framebuffer.push(value) }
    createBuffer() { this._call('createBuffer'); return this._object('buffer') }
    bindBuffer(target, value) {
        this._call('bindBuffer', target, value)
        if (target === this.PIXEL_PACK_BUFFER) this._boundPbo = value
    }
    bufferData(target, size, usage) {
        this._call('bufferData', target, size, usage)
        this._boundPbo.bytes = new Uint8Array(size)
    }
    deleteBuffer(value) { this._call('deleteBuffer', value); this.deleted.buffer.push(value) }
    createShader(type) { this._call('createShader', type); return this._object('shader') }
    shaderSource(shader, source) { this._call('shaderSource', shader, source); this.shaderSources.push(source) }
    compileShader(...args) { this._call('compileShader', ...args) }
    getShaderParameter(...args) { this._call('getShaderParameter', ...args); return true }
    getShaderInfoLog(...args) { this._call('getShaderInfoLog', ...args); return '' }
    deleteShader(value) { this._call('deleteShader', value); this.deleted.shader.push(value) }
    createProgram() { this._call('createProgram'); return this._object('program') }
    attachShader(...args) { this._call('attachShader', ...args) }
    bindAttribLocation(...args) { this._call('bindAttribLocation', ...args) }
    linkProgram(...args) { this._call('linkProgram', ...args) }
    getProgramParameter(...args) { this._call('getProgramParameter', ...args); return true }
    getProgramInfoLog(...args) { this._call('getProgramInfoLog', ...args); return '' }
    getUniformLocation(_program, name) { this._call('getUniformLocation', _program, name); return { name } }
    deleteProgram(value) { this._call('deleteProgram', value); this.deleted.program.push(value) }
    viewport(...args) { this._call('viewport', ...args) }
    disable(...args) { this._call('disable', ...args) }
    activeTexture(...args) { this._call('activeTexture', ...args) }
    useProgram(...args) { this._call('useProgram', ...args) }
    uniform1i(...args) { this._call('uniform1i', ...args) }
    bindVertexArray(...args) { this._call('bindVertexArray', ...args) }
    drawArrays(...args) { this._call('drawArrays', ...args) }
    readPixels(x, y, width, height, format, type, offset) {
        this._call('readPixels', x, y, width, height, format, type, offset)
        this._boundPbo.bytes.set(packedPattern(width, height))
    }
    fenceSync(...args) {
        this._call('fenceSync', ...args)
        const fence = this._object('fence')
        fence.status = this.TIMEOUT_EXPIRED
        return fence
    }
    flush(...args) { this._call('flush', ...args) }
    clientWaitSync(fence, flags, timeout) {
        this._call('clientWaitSync', fence, flags, timeout)
        return fence.status
    }
    deleteSync(value) { this._call('deleteSync', value); this.deleted.fence.push(value) }
    getBufferSubData(target, offset, destination) {
        this._call('getBufferSubData', target, offset, destination)
        if (this._boundPbo.failRead) throw new Error('contract WebGL2 read failure')
        destination.set(this._boundPbo.bytes)
    }
}

class ContractGPUTexture {
    constructor(device, descriptor, kind = 'resolve') {
        this.device = device
        this.descriptor = descriptor
        this.kind = kind
        this.destroyCount = 0
    }

    createView() { return { texture: this } }
    destroy() { this.destroyCount++ }
}

class ContractGPUBuffer {
    constructor(device, descriptor) {
        this.device = device
        this.descriptor = descriptor
        this.bytes = new Uint8Array(descriptor.size)
        this.mapRequests = []
        this.unmapCount = 0
        this.destroyCount = 0
        this.failRead = false
    }

    mapAsync(mode) {
        this.device._call('mapAsync', this, mode)
        let resolve
        let reject
        const promise = new Promise((onResolve, onReject) => {
            resolve = onResolve
            reject = onReject
        })
        this.mapRequests.push({ promise, resolve, reject })
        return promise
    }

    getMappedRange() {
        this.device._call('getMappedRange', this)
        if (this.failRead) throw new Error('contract WebGPU read failure')
        return this.bytes.buffer
    }

    unmap() { this.device._call('unmap', this); this.unmapCount++ }
    destroy() { this.destroyCount++ }
}

class ContractGPURenderPass {
    constructor(device) { this.device = device }
    setPipeline(value) { this.device._call('setPipeline', value) }
    setBindGroup(index, value) { this.device._call('setBindGroup', index, value) }
    draw(...args) { this.device._call('draw', ...args) }
    end() { this.device._call('endRenderPass') }
}

class ContractGPUEncoder {
    constructor(device) { this.device = device }
    beginRenderPass(descriptor) {
        this.device._call('beginRenderPass', descriptor)
        return new ContractGPURenderPass(this.device)
    }
    copyTextureToBuffer(source, destination, size) {
        this.device._call('copyTextureToBuffer', source, destination, size)
        const packed = packedPattern(size.width, size.height)
        const rowStride = size.width * 4
        destination.buffer.bytes.fill(0xee)
        for (let row = 0; row < size.height; row++) {
            destination.buffer.bytes.set(
                packed.subarray(row * rowStride, (row + 1) * rowStride),
                row * destination.bytesPerRow
            )
        }
    }
    finish() { this.device._call('finish'); return { kind: 'command-buffer' } }
}

class ContractGPUDevice {
    constructor() {
        this.calls = []
        this.created = {
            bindGroupLayouts: [], shaderModules: [], pipelineLayouts: [],
            renderPipelines: [], textures: [], buffers: [], bindGroups: [], encoders: []
        }
        this.queue = { submit: value => this._call('submit', value) }
    }

    _call(name, ...args) { this.calls.push([name, ...args]) }
    createBindGroupLayout(descriptor) {
        const value = { descriptor }
        this.created.bindGroupLayouts.push(value)
        return value
    }
    createShaderModule(descriptor) {
        const value = { descriptor }
        this.created.shaderModules.push(value)
        return value
    }
    createPipelineLayout(descriptor) {
        const value = { descriptor }
        this.created.pipelineLayouts.push(value)
        return value
    }
    createRenderPipeline(descriptor) {
        const value = { descriptor }
        this.created.renderPipelines.push(value)
        return value
    }
    createTexture(descriptor) {
        const value = new ContractGPUTexture(this, descriptor)
        this.created.textures.push(value)
        return value
    }
    createBuffer(descriptor) {
        const value = new ContractGPUBuffer(this, descriptor)
        this.created.buffers.push(value)
        return value
    }
    createBindGroup(descriptor) {
        const value = { descriptor }
        this.created.bindGroups.push(value)
        return value
    }
    createCommandEncoder() {
        const value = new ContractGPUEncoder(this)
        this.created.encoders.push(value)
        return value
    }
}

function makeWebGL2Backend(width, height) {
    const gl = new ContractWebGL2()
    const backend = Object.create(WebGL2Backend.prototype)
    backend.gl = gl
    backend.textures = new Map([['source', {
        handle: { kind: 'source-texture' }, width, height
    }]])
    backend.fullscreenVAO = { kind: 'fullscreen-vao' }
    return { backend, gpu: gl }
}

function makeWebGPUBackend(width, height) {
    const device = new ContractGPUDevice()
    const sourceTexture = new ContractGPUTexture(device, {}, 'source')
    const backend = Object.create(WebGPUBackend.prototype)
    backend.device = device
    backend.queue = device.queue
    backend.textures = new Map([['source', {
        handle: sourceTexture,
        view: sourceTexture.createView(),
        width,
        height
    }]])
    return { backend, gpu: device }
}

async function settlePromiseHandlers() {
    await Promise.resolve()
    await Promise.resolve()
}

const DRIVERS = [{
    name: 'WebGL2',
    make: makeWebGL2Backend,
    createQueue(harness, options = {}) {
        return harness.backend.createFrameExportQueue(options)
    },
    workCount(harness) {
        return harness.gpu.calls.filter(call => call[0] === 'readPixels').length
    },
    resourceCounts(harness) {
        return {
            textures: harness.gpu.created.texture.length,
            buffers: harness.gpu.created.buffer.length,
            framebuffers: harness.gpu.created.framebuffer.length
        }
    },
    slotResources(slot) { return [slot.texture, slot.framebuffer, slot.pbo] },
    destroyCount(harness, resource) {
        return Object.values(harness.gpu.deleted).flat().filter(value => value === resource).length
    },
    async ready(_harness, record) { record.adapterSlot.fence.status = 0x911a },
    async readinessFailure(_harness, record) { record.adapterSlot.fence.status = 0x911d },
    readFailure(_harness, record) { record.adapterSlot.pbo.failRead = true },
    pendingToken() { return null },
    async resolveLate() {},
    assertLateIgnored() {}
}, {
    name: 'WebGPU',
    make: makeWebGPUBackend,
    createQueue(harness, options = {}) {
        return harness.backend.createFrameExportQueue({ ...options, gpuConstants: GPU })
    },
    workCount(harness) {
        return harness.gpu.calls.filter(call => call[0] === 'mapAsync').length
    },
    resourceCounts(harness) {
        return {
            textures: harness.gpu.created.textures.length,
            buffers: harness.gpu.created.buffers.length
        }
    },
    slotResources(slot) { return [slot.resolveTexture, slot.buffer] },
    destroyCount(_harness, resource) { return resource.destroyCount },
    async ready(_harness, record) {
        record.adapterSlot.buffer.mapRequests.at(-1).resolve()
        await settlePromiseHandlers()
    },
    async readinessFailure(_harness, record) {
        record.adapterSlot.buffer.mapRequests.at(-1).reject(new Error('contract WebGPU readiness failure'))
        await settlePromiseHandlers()
    },
    readFailure(_harness, record) { record.adapterSlot.buffer.failRead = true },
    pendingToken(_harness, record) { return record.adapterSlot.buffer.mapRequests.at(-1) },
    async resolveLate(token) {
        token.resolve()
        await settlePromiseHandlers()
    },
    assertLateIgnored(slot) { assert.equal(slot.state, 'destroyed') }
}]

for (const driver of DRIVERS) {
    test(`${driver.name} factory exposes the shared three-slot default and 2-8 overrides`, () => {
        const harness = driver.make(64, 2)
        assert.equal(driver.createQueue(harness)._slots.length, 3)
        assert.equal(driver.createQueue(harness, { slots: 2 })._slots.length, 2)
        assert.equal(driver.createQueue(harness, { slots: 8 })._slots.length, 8)
        assert.throws(() => driver.createQueue(harness, { slots: 1 }), RangeError)
        assert.throws(() => driver.createQueue(harness, { slots: 9 }), RangeError)

        const legacy = driver.createQueue(harness)
        assert.throws(() => legacy.configure({ ...descriptor(64), format: 'rgba8' }), /format/i)
        assert.deepEqual(driver.resourceCounts(harness), driver.name === 'WebGL2'
            ? { textures: 0, buffers: 0, framebuffers: 0 }
            : { textures: 0, buffers: 0 })
    })
}

async function runPackedContract(driver, frameDescriptor) {
    const harness = driver.make(frameDescriptor.width, frameDescriptor.height)
    const errors = []
    const queue = driver.createQueue(harness, {
        onError(error) { errors.push(error) }
    })
    const stats = queue.stats
    const callbacks = []

    queue.configure(frameDescriptor)
    assert.equal(queue.stats, stats)
    assert.equal(driver.workCount(harness), 0)
    assert.deepEqual(driver.resourceCounts(harness), driver.name === 'WebGL2'
        ? { textures: 3, buffers: 3, framebuffers: 3 }
        : { textures: 3, buffers: 3 })

    const initialSlots = queue._slots.map(record => record.adapterSlot)
    const stableStorage = initialSlots.map(slot => ({ frame: slot.frame, data: slot.data }))
    const contexts = Array.from({ length: 3 }, (_, index) => ({ index, marker: Symbol(index) }))
    for (let index = 0; index < 3; index++) {
        assert.equal(queue.enqueue('source', 1000 + index, (frame, timestamp, context) => {
            callbacks.push({ frame, timestamp, context })
        }, contexts[index]), true)
    }
    const workAfterThree = driver.workCount(harness)
    assert.equal(queue.enqueue('source', 1003, () => assert.fail('dropped frame callback ran')), false)
    assert.equal(driver.workCount(harness), workAfterThree)
    assert.equal(queue.stats, stats)
    assert.deepEqual(queue.stats, { accepted: 3, dropped: 1, completed: 0, failed: 0 })

    queue.poll()
    assert.equal(callbacks.length, 0)
    assert.equal(queue.stats, stats)
    assert.deepEqual(queue.stats, { accepted: 3, dropped: 1, completed: 0, failed: 0 })

    for (const record of queue._slots) await driver.ready(harness, record)
    queue.poll()
    assert.equal(callbacks.length, 3)
    assert.equal(errors.length, 0)
    for (let index = 0; index < callbacks.length; index++) {
        const { frame, timestamp, context } = callbacks[index]
        assert.deepEqual(Object.keys(frame), ['width', 'height', 'rowStride', 'data'])
        assert.equal(frame.width, frameDescriptor.width)
        assert.equal(frame.height, frameDescriptor.height)
        assert.equal(frame.rowStride, frameDescriptor.width * 4)
        assert.ok(frame.data instanceof Uint8Array)
        assert.equal(frame.data.byteLength, frameDescriptor.width * frameDescriptor.height * 4)
        assert.deepEqual(frame.data, packedPattern(frameDescriptor.width, frameDescriptor.height))
        assert.equal(timestamp, 1000 + index)
        assert.equal(context, contexts[index])
        assert.equal(frame, stableStorage[index].frame)
        assert.equal(frame.data, stableStorage[index].data)
    }

    const resourceCounts = driver.resourceCounts(harness)
    assert.equal(queue.enqueue('source', 2000, (frame, timestamp) => {
        callbacks.push({ frame, timestamp })
    }), true)
    assert.equal(queue._slots[0].adapterSlot, initialSlots[0])
    assert.equal(queue._slots[0].adapterSlot.frame, stableStorage[0].frame)
    assert.equal(queue._slots[0].adapterSlot.data, stableStorage[0].data)
    assert.deepEqual(driver.resourceCounts(harness), resourceCounts)
    await driver.ready(harness, queue._slots[0])
    queue.poll()
    assert.deepEqual(driver.resourceCounts(harness), resourceCounts)
    assert.equal(callbacks.at(-1).timestamp, 2000)
    assert.deepEqual(queue.stats, { accepted: 4, dropped: 1, completed: 4, failed: 0 })
    queue.close()
}

for (const width of [64, 65]) {
    for (const alphaMode of ['straight', 'opaque', 'premultiplied']) {
        for (const driver of DRIVERS) {
            test(`${driver.name} packed contract: width ${width}, alpha ${alphaMode}`, async () => {
                await runPackedContract(driver, descriptor(width, alphaMode))
            })
        }
    }
}

async function runFailureContract(driver) {
    const harness = driver.make(65, 2)
    const errors = []
    const delivered = []
    const queue = driver.createQueue(harness, {
        onError(error) { errors.push(error.message) }
    })
    queue.configure(descriptor(65))
    const resources = driver.resourceCounts(harness)
    const slots = queue._slots.map(record => record.adapterSlot)
    const storage = slots.map(slot => [slot.frame, slot.data])

    queue.enqueue('source', 10, () => delivered.push('bad-ready'))
    queue.enqueue('source', 20, () => delivered.push('after-ready-failure'))
    await driver.readinessFailure(harness, queue._slots[0])
    await driver.ready(harness, queue._slots[1])
    queue.poll()
    assert.deepEqual(delivered, ['after-ready-failure'])
    assert.equal(errors.length, 1)
    assert.equal(queue.stats.failed, 1)

    queue.enqueue('source', 30, () => { throw new Error('contract callback failure') })
    await driver.ready(harness, queue._slots[0])
    queue.poll()
    assert.equal(errors.at(-1), 'contract callback failure')
    assert.equal(queue.stats.failed, 2)

    queue.enqueue('source', 40, () => delivered.push('bad-read'))
    queue.enqueue('source', 50, () => delivered.push('after-read-failure'))
    driver.readFailure(harness, queue._slots[0])
    await driver.ready(harness, queue._slots[0])
    await driver.ready(harness, queue._slots[1])
    queue.poll()
    assert.deepEqual(delivered, ['after-ready-failure', 'after-read-failure'])
    assert.equal(errors.length, 3)
    assert.match(errors.at(-1), /read failure/i)
    assert.equal(queue.stats.failed, 3)
    assert.equal(queue.available, true)

    queue.enqueue('source', 60, () => delivered.push('reused-after-failure'))
    queue._slots[0].adapterSlot.pbo && (queue._slots[0].adapterSlot.pbo.failRead = false)
    queue._slots[0].adapterSlot.buffer && (queue._slots[0].adapterSlot.buffer.failRead = false)
    await driver.ready(harness, queue._slots[0])
    queue.poll()
    assert.equal(delivered.at(-1), 'reused-after-failure')
    assert.deepEqual(driver.resourceCounts(harness), resources)
    for (let index = 0; index < slots.length; index++) {
        assert.equal(queue._slots[index].adapterSlot, slots[index])
        assert.equal(slots[index].frame, storage[index][0])
        assert.equal(slots[index].data, storage[index][1])
    }
    queue.close()
}

for (const driver of DRIVERS) {
    test(`${driver.name} queue isolates readiness, callback, and read failures`, async () => {
        await runFailureContract(driver)
    })
}

async function runLifecycleContract(driver) {
    const harness = driver.make(65, 2)
    const queue = driver.createQueue(harness)
    const stats = queue.stats
    queue.configure(descriptor(65))
    const oldSlots = queue._slots.map(record => record.adapterSlot)
    const oldResources = oldSlots.map(slot => driver.slotResources(slot))
    assert.equal(queue.enqueue('source', 1, () => assert.fail('old callback ran')), true)
    const lateToken = driver.pendingToken(harness, queue._slots[0])

    harness.backend.textures.get('source').width = 64
    queue.configure(descriptor(64, 'opaque'))
    const newSlots = queue._slots.map(record => record.adapterSlot)
    const newResources = newSlots.map(slot => driver.slotResources(slot))
    assert.equal(queue.stats, stats)
    for (const resources of oldResources) {
        for (const resource of resources) assert.equal(driver.destroyCount(harness, resource), 1)
    }
    assert.deepEqual(driver.resourceCounts(harness), driver.name === 'WebGL2'
        ? { textures: 6, buffers: 6, framebuffers: 6 }
        : { textures: 6, buffers: 6 })
    await driver.resolveLate(lateToken)
    driver.assertLateIgnored(oldSlots[0])

    let delivered = false
    assert.equal(queue.enqueue('source', 2, () => { delivered = true }), true)
    await driver.ready(harness, queue._slots[0])
    queue.poll()
    assert.equal(delivered, true)

    queue.enqueue('source', 3, () => assert.fail('closed callback ran'))
    const workBeforeClose = driver.workCount(harness)
    queue.close()
    queue.close()
    for (const resources of newResources) {
        for (const resource of resources) assert.equal(driver.destroyCount(harness, resource), 1)
    }
    assert.equal(queue.available, false)
    queue.configure(descriptor(64))
    assert.equal(queue.enqueue('source', 4, () => assert.fail('terminal callback ran')), false)
    queue.poll()
    assert.equal(driver.workCount(harness), workBeforeClose)
    assert.equal(queue.stats, stats)
}

for (const driver of DRIVERS) {
    test(`${driver.name} reconfigure and close obey the shared terminal lifecycle`, async () => {
        await runLifecycleContract(driver)
    })
}

function methodSource(source, startName, nextName) {
    const start = source.indexOf(`    ${startName}(`)
    const end = source.indexOf(`\n    ${nextName}(`, start)
    assert.ok(start >= 0 && end > start, `could not isolate ${startName}`)
    return source.slice(start, end)
}

test('adapter source preserves the non-blocking, top-down, product-neutral boundary', () => {
    const glSource = readFileSync(
        new URL('../src/runtime/backends/webgl2-frame-export.js', import.meta.url),
        'utf8'
    )
    const gpuSource = readFileSync(
        new URL('../src/runtime/backends/webgpu-frame-export.js', import.meta.url),
        'utf8'
    )
    const glBegin = methodSource(glSource, 'begin', 'poll')
    const glPoll = methodSource(glSource, 'poll', 'read')
    const glRead = methodSource(glSource, 'read', 'destroySlot')
    const gpuBegin = methodSource(gpuSource, 'begin', 'poll')
    const gpuRead = methodSource(gpuSource, 'read', 'destroySlot')

    assert.doesNotMatch(glBegin, /finish|getBufferSubData|getError|getParameter|clientWaitSync|createTexture|createFramebuffer|createBuffer|new Uint8Array/)
    assert.match(glPoll, /clientWaitSync\(slot\.fence, 0, 0\)/)
    assert.doesNotMatch(glPoll, /getBufferSubData/)
    assert.match(glRead, /getBufferSubData/)
    assert.match(glSource, /sourceSize\.y\s*-\s*1\s*-\s*int\(gl_FragCoord\.y\)/)
    assert.doesNotMatch(glRead, /for\s*\(|\.reverse\s*\(|sourceOffset|destinationOffset|subarray/)

    assert.doesNotMatch(gpuBegin, /\basync\b|\bawait\b|getMappedRange|new Uint8Array|createTexture|createBuffer/)
    assert.match(gpuBegin, /mapAsync/)
    assert.match(gpuBegin, /mapPromise\.then\s*\(/)
    assert.match(gpuSource, /new WeakMap\s*\(\s*\)/)
    assert.match(gpuSource, /this\._bindGroups\s*=\s*new WeakMap\s*\(\s*\)/)
    assert.match(gpuRead, /for\s*\(let row = 1; row < slot\.height; row\+\+\)/)
    assert.match(gpuRead, /source\.copyWithin\s*\(/)
    assert.doesNotMatch(gpuRead, /for\s*\(let row = 0; row < slot\.height; row\+\+\)/)

    const productPolicy = /https?:|localhost|127\.0\.0\.1|loopback|WebSocket|pairing|authToken|senderToken|allowedOrigin|Noisedeck|Spout|Syphon|\bNDI\b/
    assert.doesNotMatch(glSource, productPolicy)
    assert.doesNotMatch(gpuSource, productPolicy)
    assert.doesNotMatch(glSource, /\.push\s*\(/)
    assert.doesNotMatch(gpuSource, /\.push\s*\(/)
})
