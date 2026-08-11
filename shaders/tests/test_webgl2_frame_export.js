import assert from 'node:assert/strict'
import test from 'node:test'

import { FrameExportQueue } from '../src/runtime/frame-export.js'
import { WebGL2FrameExportAdapter } from '../src/runtime/backends/webgl2-frame-export.js'
import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'

class FakeWebGL2 {
    constructor() {
        Object.assign(this, {
            TEXTURE_2D: 0x0DE1,
            TEXTURE0: 0x84C0,
            TEXTURE_MIN_FILTER: 0x2801,
            TEXTURE_MAG_FILTER: 0x2800,
            TEXTURE_WRAP_S: 0x2802,
            TEXTURE_WRAP_T: 0x2803,
            NEAREST: 0x2600,
            CLAMP_TO_EDGE: 0x812F,
            RGBA8: 0x8058,
            RGBA: 0x1908,
            UNSIGNED_BYTE: 0x1401,
            FRAMEBUFFER: 0x8D40,
            COLOR_ATTACHMENT0: 0x8CE0,
            FRAMEBUFFER_COMPLETE: 0x8CD5,
            PIXEL_PACK_BUFFER: 0x88EB,
            STREAM_READ: 0x88E1,
            VERTEX_SHADER: 0x8B31,
            FRAGMENT_SHADER: 0x8B30,
            COMPILE_STATUS: 0x8B81,
            LINK_STATUS: 0x8B82,
            TRIANGLES: 0x0004,
            BLEND: 0x0BE2,
            DEPTH_TEST: 0x0B71,
            SCISSOR_TEST: 0x0C11,
            CULL_FACE: 0x0B44,
            SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
            TIMEOUT_EXPIRED: 0x911B,
            CONDITION_SATISFIED: 0x911C,
            WAIT_FAILED: 0x911D,
            ALREADY_SIGNALED: 0x911A
        })
        this.calls = []
        this.created = { texture: [], framebuffer: [], buffer: [], shader: [], program: [], fence: [] }
        this.deleted = { texture: [], framebuffer: [], buffer: [], shader: [], program: [], fence: [] }
        this.shaderSources = []
        this.framebufferStatus = this.FRAMEBUFFER_COMPLETE
        this.waitStatus = this.TIMEOUT_EXPIRED
        this.failMethod = null
        this._nextId = 1
    }

    _object(kind) {
        const value = { kind, id: this._nextId++ }
        this.created[kind].push(value)
        return value
    }

    _call(method, ...args) {
        this.calls.push([method, ...args])
        if (this.failMethod === method) {
            this.failMethod = null
            throw new Error(`${method} failed`)
        }
    }

    createTexture() { this._call('createTexture'); return this._object('texture') }
    bindTexture(...args) { this._call('bindTexture', ...args) }
    texImage2D(...args) { this._call('texImage2D', ...args) }
    texParameteri(...args) { this._call('texParameteri', ...args) }
    deleteTexture(value) { this._call('deleteTexture', value); this.deleted.texture.push(value) }
    createFramebuffer() { this._call('createFramebuffer'); return this._object('framebuffer') }
    bindFramebuffer(...args) { this._call('bindFramebuffer', ...args) }
    framebufferTexture2D(...args) { this._call('framebufferTexture2D', ...args) }
    checkFramebufferStatus(...args) { this._call('checkFramebufferStatus', ...args); return this.framebufferStatus }
    deleteFramebuffer(value) { this._call('deleteFramebuffer', value); this.deleted.framebuffer.push(value) }
    createBuffer() { this._call('createBuffer'); return this._object('buffer') }
    bindBuffer(...args) { this._call('bindBuffer', ...args) }
    bufferData(...args) { this._call('bufferData', ...args) }
    deleteBuffer(value) { this._call('deleteBuffer', value); this.deleted.buffer.push(value) }
    createShader(type) { this._call('createShader', type); return this._object('shader') }
    shaderSource(shader, source) { this._call('shaderSource', shader, source); this.shaderSources.push({ shader, source }) }
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
    readPixels(...args) { this._call('readPixels', ...args) }
    fenceSync(...args) { this._call('fenceSync', ...args); return this._object('fence') }
    flush(...args) { this._call('flush', ...args) }
    clientWaitSync(...args) { this._call('clientWaitSync', ...args); return this.waitStatus }
    deleteSync(value) { this._call('deleteSync', value); this.deleted.fence.push(value) }
    getBufferSubData(_target, _offset, destination) {
        this._call('getBufferSubData', _target, _offset, destination)
        for (let i = 0; i < destination.length; i++) destination[i] = (i * 17) & 0xff
    }
    finish(...args) { this._call('finish', ...args) }
    getError(...args) { this._call('getError', ...args); return 0 }
    getParameter(...args) { this._call('getParameter', ...args); return null }
}

const DESCRIPTOR = Object.freeze({
    width: 4,
    height: 3,
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    alphaMode: 'straight',
    fps: 60
})

function makeHarness() {
    const gl = new FakeWebGL2()
    const backend = {
        gl,
        textures: new Map([
            ['source', { handle: { kind: 'source-texture' }, width: 4, height: 3 }]
        ]),
        fullscreenVAO: { kind: 'fullscreen-vao' }
    }
    return { gl, backend, adapter: new WebGL2FrameExportAdapter(backend) }
}

function callsNamed(gl, name) {
    return gl.calls.filter(call => call[0] === name)
}

test('the public descriptor accepts only the canonical rgba8unorm format name', () => {
    const { gl, adapter } = makeHarness()
    const legacy = { ...DESCRIPTOR, format: 'rgba8' }

    assert.doesNotThrow(() => adapter.createSlot(0, DESCRIPTOR))
    assert.throws(() => adapter.createSlot(1, legacy), /format/i)
    assert.equal(gl.created.texture.length, 1)
})

test('descriptor validation is exact and occurs before GL allocation', () => {
    const invalid = [
        {},
        { ...DESCRIPTOR, width: 0 },
        { ...DESCRIPTOR, width: 1.5 },
        { ...DESCRIPTOR, height: -1 },
        { ...DESCRIPTOR, height: Number.MAX_SAFE_INTEGER },
        { ...DESCRIPTOR, format: 'rgba16f' },
        { ...DESCRIPTOR, colorSpace: 'rec2020' },
        { ...DESCRIPTOR, alphaMode: 'unpremultiplied' },
        { ...DESCRIPTOR, fps: 0 },
        { ...DESCRIPTOR, fps: Infinity }
    ]

    for (const descriptor of invalid) {
        const { gl, adapter } = makeHarness()
        assert.throws(() => adapter.createSlot(0, descriptor), { name: /TypeError|RangeError/ })
        assert.equal(gl.created.texture.length, 0)
        assert.equal(gl.created.framebuffer.length, 0)
        assert.equal(gl.created.buffer.length, 0)
        assert.equal(gl.created.program.length, 0)
    }
})

test('three slots own fixed resources, exact packed storage, and one bounded shared program', () => {
    const { gl, adapter } = makeHarness()
    const slots = [0, 1, 2].map(index => adapter.createSlot(index, DESCRIPTOR))

    assert.equal(gl.created.texture.length, 3)
    assert.equal(gl.created.framebuffer.length, 3)
    assert.equal(gl.created.buffer.length, 3)
    assert.equal(gl.created.program.length, 1)
    assert.equal(gl.created.shader.length, 2)
    assert.equal(new Set(slots.map(slot => slot.data)).size, 3)
    assert.equal(new Set(slots.map(slot => slot.frame)).size, 3)
    for (const slot of slots) {
        assert.equal(slot.data.length, DESCRIPTOR.width * DESCRIPTOR.height * 4)
        assert.equal(slot.frame.width, DESCRIPTOR.width)
        assert.equal(slot.frame.height, DESCRIPTOR.height)
        assert.equal(slot.frame.rowStride, DESCRIPTOR.width * 4)
        assert.equal(slot.frame.data, slot.data)
    }

    const imageCalls = callsNamed(gl, 'texImage2D')
    assert.equal(imageCalls.length, 3)
    for (const call of imageCalls) {
        assert.deepEqual(call.slice(1), [
            gl.TEXTURE_2D, 0, gl.RGBA8, DESCRIPTOR.width, DESCRIPTOR.height,
            0, gl.RGBA, gl.UNSIGNED_BYTE, null
        ])
    }
    const allocations = callsNamed(gl, 'bufferData')
    assert.equal(allocations.length, 3)
    for (const call of allocations) {
        assert.deepEqual(call.slice(1), [gl.PIXEL_PACK_BUFFER, DESCRIPTOR.width * DESCRIPTOR.height * 4, gl.STREAM_READ])
    }
})

test('failed framebuffer validation cleans up every partially created resource', () => {
    const { gl, adapter } = makeHarness()
    gl.framebufferStatus = 0x8CD6

    assert.throws(() => adapter.createSlot(0, DESCRIPTOR), /framebuffer/i)
    assert.deepEqual(gl.deleted.texture, gl.created.texture)
    assert.deepEqual(gl.deleted.framebuffer, gl.created.framebuffer)
    assert.deepEqual(gl.deleted.buffer, gl.created.buffer)
    assert.deepEqual(gl.deleted.program, gl.created.program)
})

test('resolve shader uses texelFetch and shader-side vertical inversion for all alpha modes', () => {
    const { gl, adapter } = makeHarness()
    const descriptors = [
        { ...DESCRIPTOR, alphaMode: 'straight' },
        { ...DESCRIPTOR, alphaMode: 'opaque' },
        { ...DESCRIPTOR, alphaMode: 'premultiplied' }
    ]
    const slots = descriptors.map((descriptor, index) => adapter.createSlot(index, descriptor))
    const fragment = gl.shaderSources.find(entry => entry.source.includes('out vec4 fragColor'))?.source

    assert.match(fragment, /texelFetch\s*\(/)
    assert.match(fragment, /gl_FragCoord/)
    assert.match(fragment, /sourceSize\.y\s*-\s*1\s*-\s*int\s*\(gl_FragCoord\.y\)/)
    assert.match(fragment, /color\.a\s*=\s*1\.0/)
    assert.match(fragment, /color\.rgb\s*\*=\s*color\.a/)

    gl.calls.length = 0
    for (const slot of slots) {
        adapter.begin(slot, 'source', 1)
        gl.waitStatus = gl.ALREADY_SIGNALED
        assert.equal(adapter.poll(slot), true)
        adapter.read(slot)
    }
    const alphaSelections = callsNamed(gl, 'uniform1i')
        .filter(call => call[1]?.name === 'u_alphaMode')
        .map(call => call[2])
    assert.deepEqual(alphaSelections, [0, 1, 2])
})

test('begin resolves, reads into the PBO, fences, and flushes in order without synchronous calls or replacement storage', () => {
    const { gl, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    const data = slot.data
    const frame = slot.frame
    gl.calls.length = 0

    adapter.begin(slot, 'source', 999)

    const names = gl.calls.map(call => call[0])
    const drawIndex = names.indexOf('drawArrays')
    const readIndex = names.indexOf('readPixels')
    const fenceIndex = names.indexOf('fenceSync')
    const flushIndex = names.indexOf('flush')
    assert.ok(drawIndex >= 0 && drawIndex < readIndex)
    assert.ok(readIndex < fenceIndex && fenceIndex < flushIndex)
    assert.deepEqual(callsNamed(gl, 'readPixels')[0].slice(1), [
        0, 0, DESCRIPTOR.width, DESCRIPTOR.height, gl.RGBA, gl.UNSIGNED_BYTE, 0
    ])
    assert.deepEqual(callsNamed(gl, 'fenceSync')[0].slice(1), [gl.SYNC_GPU_COMMANDS_COMPLETE, 0])
    for (const name of ['getBufferSubData', 'finish', 'getError', 'getParameter', 'clientWaitSync']) {
        assert.equal(names.includes(name), false)
    }
    for (const capability of [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.CULL_FACE]) {
        assert.ok(gl.calls.some(call => call[0] === 'disable' && call[1] === capability))
    }
    assert.equal(slot.data, data)
    assert.equal(slot.frame, frame)
    assert.equal(gl.created.texture.length, 1)
    assert.equal(gl.created.buffer.length, 1)
})

test('poll uses a zero-timeout readiness check and handles every WebGL2 status', () => {
    for (const [statusName, expected] of [
        ['TIMEOUT_EXPIRED', false],
        ['ALREADY_SIGNALED', true],
        ['CONDITION_SATISFIED', true]
    ]) {
        const { gl, adapter } = makeHarness()
        const slot = adapter.createSlot(0, DESCRIPTOR)
        adapter.begin(slot, 'source', 1)
        gl.calls.length = 0
        gl.waitStatus = gl[statusName]

        assert.equal(adapter.poll(slot), expected)
        assert.deepEqual(callsNamed(gl, 'clientWaitSync')[0].slice(2), [0, 0])
    }

    for (const status of [0x911D, 0xdead]) {
        const { gl, adapter } = makeHarness()
        const slot = adapter.createSlot(0, DESCRIPTOR)
        adapter.begin(slot, 'source', 1)
        gl.waitStatus = status
        assert.throws(() => adapter.poll(slot), /wait|status/i)
    }
})

test('read is allowed only after a signaled poll and fills stable packed storage', () => {
    const { gl, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    const stableData = slot.data
    const stableFrame = slot.frame
    adapter.begin(slot, 'source', 1)

    assert.throws(() => adapter.read(slot), /ready|signal/i)
    assert.equal(callsNamed(gl, 'getBufferSubData').length, 0)
    gl.waitStatus = gl.TIMEOUT_EXPIRED
    assert.equal(adapter.poll(slot), false)
    assert.throws(() => adapter.read(slot), /ready|signal/i)
    assert.equal(callsNamed(gl, 'getBufferSubData').length, 0)
    gl.waitStatus = gl.CONDITION_SATISFIED
    assert.equal(adapter.poll(slot), true)

    assert.equal(adapter.read(slot), stableFrame)
    assert.equal(slot.data, stableData)
    assert.deepEqual([...stableData.slice(0, 5)], [0, 17, 34, 51, 68])
    assert.equal(callsNamed(gl, 'getBufferSubData').length, 1)
    assert.equal(gl.deleted.fence.length, 1)
    assert.equal(slot.fence, null)
    assert.equal(slot.ready, false)
})

test('missing textures and injected begin failures leave a slot reusable without a fence leak', () => {
    const { gl, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)

    assert.throws(() => adapter.begin(slot, 'missing', 1), /texture.*not found/i)
    assert.equal(slot.fence, null)

    gl.failMethod = 'flush'
    assert.throws(() => adapter.begin(slot, 'source', 2), /flush failed/)
    assert.equal(slot.fence, null)
    assert.equal(gl.created.fence.length, 1)
    assert.equal(gl.deleted.fence.length, 1)

    assert.doesNotThrow(() => adapter.begin(slot, 'source', 3))
    gl.waitStatus = gl.ALREADY_SIGNALED
    assert.equal(adapter.poll(slot), true)
    assert.doesNotThrow(() => adapter.read(slot))
})

test('begin rejects source extent mismatch before GPU work and keeps the slot reusable', () => {
    const { gl, backend, adapter } = makeHarness()
    const slot = adapter.createSlot(0, DESCRIPTOR)
    backend.textures.set('wrong-width', {
        handle: { kind: 'wrong-width-texture' },
        width: DESCRIPTOR.width + 1,
        height: DESCRIPTOR.height
    })
    gl.calls.length = 0

    assert.throws(() => adapter.begin(slot, 'wrong-width', 1), /extent|dimension|size/i)
    for (const name of ['drawArrays', 'readPixels', 'fenceSync', 'flush']) {
        assert.equal(callsNamed(gl, name).length, 0)
    }
    assert.equal(slot.fence, null)

    assert.doesNotThrow(() => adapter.begin(slot, 'source', 2))
    gl.waitStatus = gl.ALREADY_SIGNALED
    assert.equal(adapter.poll(slot), true)
    assert.doesNotThrow(() => adapter.read(slot))
})

test('destroySlot is complete and idempotent, including a pending fence and shared program lifetime', () => {
    const { gl, adapter } = makeHarness()
    const first = adapter.createSlot(0, DESCRIPTOR)
    const second = adapter.createSlot(1, DESCRIPTOR)
    adapter.begin(first, 'source', 1)

    adapter.destroySlot(first)
    adapter.destroySlot(first)
    assert.equal(gl.deleted.fence.length, 1)
    assert.equal(gl.deleted.texture.length, 1)
    assert.equal(gl.deleted.framebuffer.length, 1)
    assert.equal(gl.deleted.buffer.length, 1)
    assert.equal(gl.deleted.program.length, 0)

    adapter.destroySlot(second)
    adapter.destroySlot(second)
    assert.equal(gl.deleted.texture.length, 2)
    assert.equal(gl.deleted.framebuffer.length, 2)
    assert.equal(gl.deleted.buffer.length, 2)
    assert.equal(gl.deleted.program.length, 1)
})

test('backend factory returns a queue with three default slots and preserves bounded overrides', () => {
    const gl = new FakeWebGL2()
    const backend = Object.create(WebGL2Backend.prototype)
    backend.gl = gl
    backend.textures = new Map()
    backend.fullscreenVAO = { kind: 'fullscreen-vao' }

    const defaultQueue = backend.createFrameExportQueue()
    const overrideQueue = backend.createFrameExportQueue({ slots: 2 })

    assert.ok(defaultQueue instanceof FrameExportQueue)
    assert.ok(defaultQueue.adapter instanceof WebGL2FrameExportAdapter)
    assert.equal(defaultQueue._slots.length, 3)
    assert.equal(overrideQueue._slots.length, 2)
    assert.throws(() => backend.createFrameExportQueue({ slots: 1 }), RangeError)
    assert.throws(() => backend.createFrameExportQueue({ slots: 9 }), RangeError)
})
