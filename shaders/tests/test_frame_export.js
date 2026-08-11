import assert from 'node:assert/strict'
import test from 'node:test'

import { Backend } from '../src/runtime/backend.js'
import { FrameExportQueue } from '../src/runtime/frame-export.js'

class FakeAdapter {
    constructor() {
        this.slots = []
        this.beginErrorForTexture = null
        this.pollErrorForIndex = null
        this.pollResultIndex = null
        this.pollResult = undefined
        this.readErrorForIndex = null
        this.destroyErrorForIndex = null
        this.createErrorForIndex = null
        this.createError = null
        this.beginCalls = 0
    }

    createSlot(index, descriptor) {
        if (index === this.createErrorForIndex) {
            throw this.createError || new Error(`create ${index} failed`)
        }
        const slot = {
            index,
            descriptor,
            textureId: null,
            timestamp: null,
            ready: false,
            frame: null,
            reads: 0,
            destroys: 0
        }
        this.slots.push(slot)
        return slot
    }

    begin(slot, textureId, timestamp) {
        this.beginCalls++
        slot.ready = false
        slot.frame = null
        if (textureId === this.beginErrorForTexture) {
            throw new Error('begin failed')
        }
        slot.textureId = textureId
        slot.timestamp = timestamp
    }

    poll(slot) {
        if (slot.index === this.pollErrorForIndex) {
            throw new Error('poll failed')
        }
        if (slot.index === this.pollResultIndex) {
            return this.pollResult
        }
        return slot.ready
    }

    read(slot) {
        if (slot.index === this.readErrorForIndex) {
            throw new Error('read failed')
        }
        slot.reads++
        return slot.frame
    }

    destroySlot(slot) {
        slot.destroys++
        if (slot.index === this.destroyErrorForIndex) {
            throw new Error(`destroy ${slot.index} failed`)
        }
    }

    complete(index, frame) {
        const slot = this.slots[index]
        slot.frame = frame
        slot.ready = true
    }
}

test('FrameExportQueue validates its adapter and bounded slot count', () => {
    const adapter = new FakeAdapter()

    assert.throws(() => new FrameExportQueue({}, {}), TypeError)
    for (const method of ['createSlot', 'begin', 'poll', 'read', 'destroySlot']) {
        const malformed = new FakeAdapter()
        malformed[method] = null
        assert.throws(() => new FrameExportQueue(malformed), TypeError)
    }
    assert.throws(() => new FrameExportQueue(adapter, { slots: 1 }), RangeError)
    assert.throws(() => new FrameExportQueue(adapter, { slots: 9 }), RangeError)
    assert.throws(() => new FrameExportQueue(adapter, { slots: 2.5 }), RangeError)
    assert.doesNotThrow(() => new FrameExportQueue(adapter, { slots: 2 }))
})

test('Backend exposes an absent frame export capability by default', () => {
    assert.equal(new Backend().createFrameExportQueue(), null)
})

test('FrameExportQueue configures reusable slots with one descriptor and preserves stats identity', () => {
    const adapter = new FakeAdapter()
    const queue = new FrameExportQueue(adapter, { slots: 2 })
    const stats = queue.stats
    const firstDescriptor = { width: 640, height: 480, format: 'rgba8unorm' }
    const secondDescriptor = { width: 1280, height: 720, format: 'rgba16float' }

    assert.equal(queue.available, false)
    queue.configure(firstDescriptor)
    assert.equal(queue.available, true)
    assert.equal(adapter.slots.length, 2)
    assert.equal(adapter.slots[0].descriptor, firstDescriptor)
    assert.equal(adapter.slots[1].descriptor, firstDescriptor)

    queue.configure(secondDescriptor)

    assert.equal(queue.stats, stats)
    assert.equal(adapter.slots[0].destroys, 1)
    assert.equal(adapter.slots[1].destroys, 1)
    assert.equal(adapter.slots.length, 4)
    assert.equal(adapter.slots[2].descriptor, secondDescriptor)
    assert.equal(adapter.slots[3].descriptor, secondDescriptor)
    assert.equal(queue.available, true)
})

test('FrameExportQueue rolls back a partially created ring and preserves the primary configure error', () => {
    const adapter = new FakeAdapter()
    const cleanupErrors = []
    const queue = new FrameExportQueue(adapter, {
        slots: 3,
        onError(error) { cleanupErrors.push(error) }
    })
    const primaryError = new Error('slot one creation failed')
    adapter.createErrorForIndex = 1
    adapter.createError = primaryError
    adapter.destroyErrorForIndex = 0

    assert.throws(() => queue.configure({ width: 4, height: 4 }), error => error === primaryError)
    assert.equal(adapter.slots.length, 1)
    assert.equal(adapter.slots[0].destroys, 1)
    assert.deepEqual(cleanupErrors.map(error => error.message), ['destroy 0 failed'])
    assert.equal(queue.available, false)
    assert.equal(queue._configured, false)
    for (const record of queue._slots) {
        assert.equal(record.created, false)
        assert.equal(record.adapterSlot, null)
    }

    adapter.createErrorForIndex = null
    adapter.createError = null
    adapter.destroyErrorForIndex = null
    assert.doesNotThrow(() => queue.configure({ width: 8, height: 8 }))
    assert.equal(queue.available, true)
    assert.equal(adapter.slots.length, 4)
    assert.equal(queue._slots.filter(record => record.created).length, 3)
})

test('FrameExportQueue drops without a slot and immediately reuses a completed default slot', () => {
    const adapter = new FakeAdapter()
    const queue = new FrameExportQueue(adapter)
    const frames = []

    assert.equal(queue.enqueue('not-configured', 1, () => {}), false)
    queue.configure({ width: 4, height: 4 })
    assert.equal(queue.enqueue('first', 10, (frame, timestamp) => frames.push([frame, timestamp])), true)
    assert.equal(queue.enqueue('second', 20, () => {}), true)
    assert.equal(queue.enqueue('third', 30, () => {}), true)
    assert.equal(queue.available, false)
    assert.equal(queue.enqueue('fourth', 40, () => {}), false)

    adapter.complete(0, 'frame-one')
    queue.poll()

    assert.deepEqual(frames, [['frame-one', 10]])
    assert.equal(queue.available, true)
    assert.equal(queue.enqueue('replacement', 50, () => {}), true)
    assert.deepEqual(queue.stats, { accepted: 4, dropped: 2, completed: 1, failed: 0 })
})

test('FrameExportQueue preserves opaque context until frame completion', () => {
    const adapter = new FakeAdapter()
    const queue = new FrameExportQueue(adapter, { slots: 2 })
    const context = { sequence: 42 }
    let completedContext
    queue.configure({ width: 4, height: 4 })

    assert.equal(queue.enqueue('texture', 10, (_frame, _timestamp, value) => {
        completedContext = value
    }, context), true)
    adapter.complete(0, 'frame')
    queue.poll()

    assert.equal(completedContext, context)
})

test('FrameExportQueue rejects a non-function callback before claiming adapter state', () => {
    const adapter = new FakeAdapter()
    const queue = new FrameExportQueue(adapter, { slots: 2 })
    queue.configure({ width: 4, height: 4 })

    assert.throws(() => queue.enqueue('invalid', 10, null), TypeError)
    assert.equal(adapter.beginCalls, 0)
    assert.equal(adapter.slots[0].textureId, null)
    assert.equal(adapter.slots[1].textureId, null)
    assert.equal(queue.available, true)
    assert.deepEqual(queue.stats, { accepted: 0, dropped: 0, completed: 0, failed: 0 })

    assert.equal(queue.enqueue('valid', 20, () => {}), true)
    assert.equal(adapter.beginCalls, 1)
    assert.equal(adapter.slots[0].textureId, 'valid')
})

test('FrameExportQueue releases a begin failure, reports it in isolation, and remains reusable', () => {
    const adapter = new FakeAdapter()
    const errors = []
    const queue = new FrameExportQueue(adapter, {
        slots: 2,
        onError(error) {
            errors.push(error.message)
            throw new Error('reporter failed')
        }
    })
    queue.configure({ width: 4, height: 4 })
    adapter.beginErrorForTexture = 'bad'

    assert.equal(queue.enqueue('bad', 10, () => {}), false)
    assert.equal(queue.available, true)
    assert.equal(queue.enqueue('good', 20, () => {}), true)
    assert.deepEqual(errors, ['begin failed'])
    assert.deepEqual(queue.stats, { accepted: 1, dropped: 0, completed: 0, failed: 1 })
})

test('FrameExportQueue keeps pending slots, isolates polling failures, and continues later slots', () => {
    const adapter = new FakeAdapter()
    const errors = []
    const frames = []
    const queue = new FrameExportQueue(adapter, {
        slots: 2,
        onError(error) { errors.push(error.message) }
    })
    queue.configure({ width: 4, height: 4 })
    queue.enqueue('first', 10, () => frames.push('first'))
    queue.enqueue('second', 20, (frame, timestamp) => frames.push([frame, timestamp]))

    queue.poll()
    assert.equal(queue.available, false)
    assert.deepEqual(frames, [])

    adapter.pollErrorForIndex = 0
    adapter.complete(1, 'frame-two')
    queue.poll()

    assert.deepEqual(errors, ['poll failed'])
    assert.deepEqual(frames, [['frame-two', 20]])
    assert.equal(queue.available, true)
    assert.deepEqual(queue.stats, { accepted: 2, dropped: 0, completed: 1, failed: 1 })
})

test('FrameExportQueue keeps a callback-enqueued replacement pending after the callback throws', () => {
    const adapter = new FakeAdapter()
    const errors = []
    const frames = []
    const queue = new FrameExportQueue(adapter, {
        slots: 2,
        onError(error) { errors.push(error.message) }
    })
    queue.configure({ width: 4, height: 4 })
    queue.enqueue('first', 10, () => {
        assert.equal(queue.enqueue('replacement', 20, (frame, timestamp) => frames.push([frame, timestamp])), true)
        throw new Error('callback failed')
    })
    adapter.complete(0, 'frame-one')

    queue.poll()
    queue.poll()

    assert.deepEqual(errors, ['callback failed'])
    assert.deepEqual(frames, [])
    assert.deepEqual(queue.stats, { accepted: 2, dropped: 0, completed: 0, failed: 1 })

    adapter.complete(0, 'replacement-frame')
    queue.poll()

    assert.deepEqual(frames, [['replacement-frame', 20]])
    assert.deepEqual(queue.stats, { accepted: 2, dropped: 0, completed: 1, failed: 1 })
    assert.equal(queue.available, true)
})

test('FrameExportQueue contains non-boolean readiness and continues later slots', () => {
    const adapter = new FakeAdapter()
    const errors = []
    const frames = []
    const queue = new FrameExportQueue(adapter, {
        slots: 2,
        onError(error) { errors.push(error.message) }
    })
    queue.configure({ width: 4, height: 4 })
    queue.enqueue('invalid-ready', 10, () => frames.push('invalid'))
    queue.enqueue('valid-ready', 20, (frame, timestamp) => frames.push([frame, timestamp]))
    adapter.pollResultIndex = 0
    adapter.pollResult = 'ready'
    adapter.complete(1, 'frame-two')

    queue.poll()

    assert.deepEqual(errors, ['Frame export adapter poll must return a boolean'])
    assert.deepEqual(frames, [['frame-two', 20]])
    assert.deepEqual(queue.stats, { accepted: 2, dropped: 0, completed: 1, failed: 1 })
    assert.equal(queue.available, true)
})

test('FrameExportQueue releases read failures and continues polling later slots', () => {
    const adapter = new FakeAdapter()
    const errors = []
    const frames = []
    const queue = new FrameExportQueue(adapter, {
        slots: 2,
        onError(error) { errors.push(error.message) }
    })
    queue.configure({ width: 4, height: 4 })
    queue.enqueue('first', 10, () => frames.push('first'))
    queue.enqueue('second', 20, frame => frames.push(frame))
    adapter.readErrorForIndex = 0
    adapter.complete(0, 'lost')
    adapter.complete(1, 'kept')

    queue.poll()

    assert.deepEqual(errors, ['read failed'])
    assert.deepEqual(frames, ['kept'])
    assert.equal(queue.available, true)
    assert.deepEqual(queue.stats, { accepted: 2, dropped: 0, completed: 1, failed: 1 })
})

test('FrameExportQueue closes pending slots exactly once, attempts every destroy, and is terminal', () => {
    const adapter = new FakeAdapter()
    const queue = new FrameExportQueue(adapter, { slots: 2 })
    queue.configure({ width: 4, height: 4 })
    queue.enqueue('first', 10, () => assert.fail('closed queue delivered a callback'))
    queue.enqueue('second', 20, () => assert.fail('closed queue delivered a callback'))
    adapter.destroyErrorForIndex = 0

    assert.throws(() => queue.close(), /destroy 0 failed/)
    adapter.complete(0, 'stale')
    adapter.complete(1, 'stale')
    queue.poll()
    queue.close()

    assert.equal(adapter.slots[0].destroys, 1)
    assert.equal(adapter.slots[1].destroys, 1)
    assert.equal(queue.adapter, null)
    assert.equal(queue.available, false)
    assert.equal(queue.enqueue('later', 30, () => {}), false)
    assert.deepEqual(queue.stats, { accepted: 2, dropped: 1, completed: 0, failed: 0 })
})

test('FrameExportQueue backendLost close abandons every slot and adapter reference without GPU destruction', () => {
    const adapter = new FakeAdapter()
    const queue = new FrameExportQueue(adapter, { slots: 2 })
    let callbacks = 0
    queue.configure({ width: 4, height: 4 })
    queue.enqueue('pending', 10, () => { callbacks++ }, { sequence: 1 })

    queue.close({ backendLost: true })
    queue.close()

    assert.equal(adapter.slots.length, 2)
    assert.deepEqual(adapter.slots.map(slot => slot.destroys), [0, 0])
    assert.equal(queue.adapter, null)
    assert.equal(queue.available, false)
    for (const record of queue._slots) {
        assert.equal(record.created, false)
        assert.equal(record.adapterSlot, null)
        assert.equal(record.pending, false)
        assert.equal(record.textureId, null)
        assert.equal(record.onFrame, null)
        assert.equal(record.context, undefined)
    }
    adapter.complete(0, 'late')
    queue.poll()
    assert.equal(callbacks, 0)
})
