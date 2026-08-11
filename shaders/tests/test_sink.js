import assert from 'node:assert/strict'
import test from 'node:test'

import { CanvasSink, SinkManager } from '../src/runtime/sink.js'

test('CanvasSink presents each submitted texture once and closes idempotently', () => {
    const presented = []
    const sink = new CanvasSink({
        present(textureId) {
            presented.push(textureId)
        }
    })
    const descriptor = { width: 1920, height: 1080, format: 'rgba8unorm' }

    assert.doesNotThrow(() => sink.configure(descriptor))
    assert.equal(sink.submit(17, 1234), true)
    sink.close()
    sink.close()

    assert.deepEqual(presented, [17])
})

test('SinkManager rejects malformed sinks during registration', () => {
    const manager = new SinkManager()

    assert.throws(() => manager.add({}), TypeError)
    assert.throws(() => manager.add({ configure() {}, submit() {} }), TypeError)
    assert.throws(() => manager.add({ configure() {}, close() {} }), TypeError)
})

test('SinkManager configures current and later sinks with one descriptor', () => {
    const configured = []
    const first = {
        configure(descriptor) { configured.push(descriptor) },
        submit() { return true },
        close() {}
    }
    const later = {
        configure(descriptor) { configured.push(descriptor) },
        submit() { return true },
        close() {}
    }
    const descriptor = { width: 640, height: 480, format: 'rgba16float' }
    const manager = new SinkManager()

    manager.add(first)
    manager.configure(descriptor)
    manager.add(later)

    assert.equal(configured.length, 2)
    assert.equal(configured[0], configured[1])
    assert.deepEqual(configured[0], descriptor)
})

test('SinkManager isolates configure failures and retries the failed sink later', () => {
    const canvas = new CanvasSink({ present() {} })
    const configureError = new Error('configure failed')
    const reported = []
    const attempts = []
    let shouldThrow = true
    const failed = {
        configure(descriptor) {
            attempts.push(['failed', descriptor])
            if (shouldThrow) throw configureError
        },
        submit() { return true },
        close() {}
    }
    const later = {
        configure(descriptor) { attempts.push(['later', descriptor]) },
        submit() { return true },
        close() {}
    }
    const manager = new SinkManager({
        onError(error, sink) {
            reported.push([error, sink])
            throw new Error('reporter failed')
        }
    })
    const descriptor = { width: 640, height: 480, format: 'rgba8unorm' }

    manager.add(canvas)
    manager.add(failed)
    manager.add(later)

    assert.doesNotThrow(() => manager.configure(descriptor))
    assert.equal(canvas.descriptor, descriptor)
    assert.deepEqual(attempts, [
        ['failed', descriptor],
        ['later', descriptor]
    ])
    assert.deepEqual(reported, [[configureError, failed]])
    assert.deepEqual(manager.stats.get(failed), { accepted: 0, dropped: 0, failed: 1 })

    const retryDescriptor = { width: 1280, height: 720, format: 'rgba8unorm' }
    shouldThrow = false
    manager.configure(retryDescriptor)

    assert.equal(canvas.descriptor, retryDescriptor)
    assert.deepEqual(attempts.slice(2), [
        ['failed', retryDescriptor],
        ['later', retryDescriptor]
    ])
    assert.deepEqual(manager.stats.get(failed), { accepted: 0, dropped: 0, failed: 1 })
})

test('SinkManager sends identical frame arguments to every active sink', () => {
    const frames = []
    const first = {
        configure() {},
        submit(textureId, timestamp) { frames.push(['first', textureId, timestamp]); return true },
        close() {}
    }
    const second = {
        configure() {},
        submit(textureId, timestamp) { frames.push(['second', textureId, timestamp]); return true },
        close() {}
    }
    const manager = new SinkManager()

    manager.add(first)
    manager.add(second)
    manager.submit(29, 4567)

    assert.deepEqual(frames, [
        ['first', 29, 4567],
        ['second', 29, 4567]
    ])
    assert.deepEqual(manager.stats.get(first), { accepted: 1, dropped: 0, failed: 0 })
    assert.deepEqual(manager.stats.get(second), { accepted: 1, dropped: 0, failed: 0 })
})

test('SinkManager counts outcomes and continues after a sink throws', () => {
    const errors = []
    let laterCalls = 0
    const accepted = {
        configure() {},
        submit() { return true },
        close() {}
    }
    const dropped = {
        configure() {},
        submit() { return false },
        close() {}
    }
    const failed = {
        configure() {},
        submit() { throw new Error('sink failed') },
        close() {}
    }
    const later = {
        configure() {},
        submit() { laterCalls++; return true },
        close() {}
    }
    const manager = new SinkManager({
        onError(error, sink) { errors.push([error.message, sink]) }
    })

    manager.add(accepted)
    manager.add(dropped)
    manager.add(failed)
    manager.add(later)
    manager.submit(5, 10)

    assert.deepEqual(manager.stats.get(accepted), { accepted: 1, dropped: 0, failed: 0 })
    assert.deepEqual(manager.stats.get(dropped), { accepted: 0, dropped: 1, failed: 0 })
    assert.deepEqual(manager.stats.get(failed), { accepted: 0, dropped: 0, failed: 1 })
    assert.equal(laterCalls, 1)
    assert.deepEqual(errors, [['sink failed', failed]])
})

test('SinkManager removal closes once and removes active stats idempotently', () => {
    let closes = 0
    let submissions = 0
    const sink = {
        configure() {},
        submit() { submissions++; return true },
        close() { closes++ }
    }
    const manager = new SinkManager()
    const remove = manager.add(sink)

    manager.remove(sink)
    remove()
    manager.remove(sink)
    manager.submit(1, 2)

    assert.equal(closes, 1)
    assert.equal(submissions, 0)
    assert.equal(manager.stats.has(sink), false)
})

test('SinkManager continues to later sinks when a sink removes itself during submission', () => {
    let laterCalls = 0
    const manager = new SinkManager()
    const selfRemoving = {
        configure() {},
        submit() { manager.remove(selfRemoving); return true },
        close() {}
    }
    const later = {
        configure() {},
        submit() { laterCalls++; return true },
        close() {}
    }

    manager.add(selfRemoving)
    manager.add(later)
    manager.submit(1, 2)

    assert.equal(laterCalls, 1)
    assert.deepEqual(manager.stats.get(later), { accepted: 1, dropped: 0, failed: 0 })
})

test('SinkManager ignores reporter errors and continues to later sinks', () => {
    let laterCalls = 0
    const failed = {
        configure() {},
        submit() { throw new Error('sink failed') },
        close() {}
    }
    const later = {
        configure() {},
        submit() { laterCalls++; return true },
        close() {}
    }
    const manager = new SinkManager({
        onError() { throw new Error('reporter failed') }
    })

    manager.add(failed)
    manager.add(later)

    assert.doesNotThrow(() => manager.submit(1, 2))
    assert.equal(laterCalls, 1)
})

test('SinkManager removal handles are bound to their registration', () => {
    let closes = 0
    let submissions = 0
    const sink = {
        configure() {},
        submit() { submissions++; return true },
        close() { closes++ }
    }
    const manager = new SinkManager()
    const oldRemove = manager.add(sink)

    manager.remove(sink)
    const currentRemove = manager.add(sink)
    oldRemove()
    manager.submit(1, 2)

    assert.equal(closes, 1)
    assert.equal(submissions, 1)
    assert.equal(manager.stats.has(sink), true)
    currentRemove()
})

test('SinkManager reclaims tombstones after direct and submission-time removal', () => {
    const directManager = new SinkManager()
    for (let i = 0; i < 4; i++) {
        const sink = {
            configure() {},
            submit() { return true },
            close() {}
        }
        directManager.add(sink)
        directManager.remove(sink)
    }

    const submitManager = new SinkManager()
    const selfRemoving = {
        configure() {},
        submit() { submitManager.remove(selfRemoving); return true },
        close() {}
    }
    submitManager.add(selfRemoving)
    submitManager.submit(1, 2)

    assert.deepEqual(
        [directManager._registrations.length, submitManager._registrations.length],
        [0, 0]
    )
})

test('SinkManager close is terminal and inert after closing active sinks once', () => {
    let closes = 0
    let configurations = 0
    let submissions = 0
    const sink = {
        configure() { configurations++ },
        submit() { submissions++; return true },
        close() { closes++ }
    }
    const manager = new SinkManager()

    manager.add(sink)
    manager.configure({ width: 320, height: 240 })
    manager.close()
    manager.close()
    manager.configure({ width: 640, height: 480 })
    manager.submit(1, 2)

    assert.equal(closes, 1)
    assert.equal(configurations, 1)
    assert.equal(submissions, 0)
    assert.equal(manager.stats.size, 0)
    assert.throws(() => manager.add({ configure() {}, submit() { return true }, close() {} }), Error)
})

test('SinkManager terminal close forwards one loss descriptor to every sink', () => {
    const options = { backendLost: true }
    const received = []
    const manager = new SinkManager()
    for (let index = 0; index < 2; index++) {
        manager.add({
            configure() {},
            submit() { return true },
            close(candidate) { received.push(candidate) }
        })
    }

    manager.close(options)
    manager.close({ backendLost: false })

    assert.deepEqual(received, [options, options])
})
