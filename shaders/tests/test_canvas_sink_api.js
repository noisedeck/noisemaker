/**
 * CanvasRenderer public sink/export seam and pipeline lifecycle tests.
 */

import assert from 'node:assert/strict'

import {
    CanvasRenderer,
    CanvasSink,
    SinkManager,
    FrameExportQueue
} from '../src/index.js'
import { CanvasSink as DirectCanvasSink, SinkManager as DirectSinkManager } from '../src/runtime/sink.js'
import { FrameExportQueue as DirectFrameExportQueue } from '../src/runtime/frame-export.js'
import { Pipeline } from '../src/runtime/pipeline.js'

const tests = []

function test(name, fn) {
    tests.push({ name, fn })
}

function bareRenderer(pipeline = null) {
    const renderer = Object.create(CanvasRenderer.prototype)
    renderer._pipeline = pipeline
    renderer._uniformBindings = new Map()
    renderer._preferWebGPU = false
    renderer._meshCache = new Map()
    renderer._midiState = null
    renderer._audioState = null
    renderer._frameCount = 0
    renderer._isRunning = false
    renderer._isContextLost = false
    renderer._wasRunningBeforeContextLoss = false
    renderer._lifecycleGeneration = 0
    renderer._lastBackendInvalidationGeneration = -1
    return renderer
}

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

async function flushMicrotasks(turns = 3) {
    for (let turn = 0; turn < turns; turn++) await Promise.resolve()
}

function stalePipeline(events, name) {
    return {
        backend: {},
        setMidiState() {},
        setAudioState() {},
        dispose(options) { events.push([`${name} dispose`, options]) }
    }
}

function closeCountingPipeline(events = []) {
    const backend = {
        textures: new Map(),
        destroy(options) {
            events.push(['backend destroy', options])
        }
    }
    const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
    let closes = 0
    const sink = {
        configure() {},
        submit() { return true },
        close() {
            closes++
            events.push(['sink close'])
        }
    }
    pipeline.addSink(sink)
    return { pipeline, sink, get closes() { return closes } }
}

test('main module exports the generic sink and frame-export types', () => {
    assert.equal(CanvasSink, DirectCanvasSink)
    assert.equal(SinkManager, DirectSinkManager)
    assert.equal(FrameExportQueue, DirectFrameExportQueue)
})

test('renderer sink/export APIs reject use before compilation with stable guidance', () => {
    const renderer = bareRenderer()
    const sink = { configure() {}, submit() {}, close() {} }

    assert.throws(
        () => renderer.addSink(sink),
        { message: 'CanvasRenderer has no active pipeline; compile before adding a sink' }
    )
    assert.throws(
        () => renderer.createFrameExportQueue({ slots: 3 }),
        { message: 'CanvasRenderer has no active pipeline; compile before creating a frame export queue' }
    )
})

test('renderer addSink delegates with the active pipeline receiver and returns its exact lifecycle handle', () => {
    const sink = { configure() {}, submit() {}, close() {} }
    const removal = () => {}
    const pipeline = {
        addSink(candidate) {
            assert.equal(this, pipeline)
            assert.equal(candidate, sink)
            return removal
        }
    }
    const renderer = bareRenderer(pipeline)

    assert.equal(renderer.addSink(sink), removal)
})

test('renderer addSink reports an unsupported active pipeline clearly', () => {
    const renderer = bareRenderer({})

    assert.throws(
        () => renderer.addSink({ configure() {}, submit() {}, close() {} }),
        { message: 'Active Noisemaker pipeline does not support output sinks' }
    )
})

test('renderer sink removal remains idempotent and closes the sink exactly once', () => {
    const { pipeline, getCloses } = (() => {
        const fixture = closeCountingPipeline()
        return { pipeline: fixture.pipeline, getCloses: () => fixture.closes }
    })()
    const renderer = bareRenderer(pipeline)
    let closes = 0
    const remove = renderer.addSink({
        configure() {},
        submit() { return true },
        close() { closes++ }
    })

    remove()
    remove()

    assert.equal(closes, 1)
    assert.equal(getCloses(), 0)
})

test('renderer createFrameExportQueue delegates with the backend receiver and preserves option identity', () => {
    const options = { slots: 2, onError() {} }
    const queue = { close() {} }
    const backend = {
        createFrameExportQueue(candidate) {
            assert.equal(this, backend)
            assert.equal(candidate, options)
            return queue
        }
    }
    const renderer = bareRenderer({ backend })

    assert.equal(renderer.createFrameExportQueue(options), queue)
})

test('renderer createFrameExportQueue returns null when the active backend does not support export', () => {
    assert.equal(bareRenderer({ backend: {} }).createFrameExportQueue({ slots: 3 }), null)
    assert.equal(
        bareRenderer({ backend: { createFrameExportQueue() { return null } } })
            .createFrameExportQueue({ slots: 3 }),
        null
    )
})

test('explicit renderer disposal closes an external sink once through Pipeline.dispose', async () => {
    const events = []
    const fixture = closeCountingPipeline(events)
    const renderer = bareRenderer(fixture.pipeline)

    await renderer.dispose({ loseContext: true })
    await renderer.dispose({ loseContext: true })

    assert.equal(fixture.closes, 1)
    assert.deepEqual(events, [
        ['sink close'],
        ['backend destroy', { skipTextures: true, loseContext: true }]
    ])
    assert.equal(renderer.pipeline, null)
})

test('backend switching closes the old pipeline sink once and resets the canvas', async () => {
    const fixture = closeCountingPipeline()
    const renderer = bareRenderer(fixture.pipeline)
    let resets = 0
    renderer.resetCanvas = () => { resets++ }

    await renderer.switchBackend('wgsl')
    await renderer.switchBackend('wgsl')

    assert.equal(fixture.closes, 1)
    assert.equal(resets, 1)
    assert.equal(renderer.pipeline, null)
})

test('successful fallback recreation installs a fresh pipeline then disposes the terminal old pipeline', async () => {
    const events = []
    const previousPipeline = {
        width: 16,
        height: 16,
        graph: { id: 'old graph' },
        isCompiling: false,
        createSurfaces() {
            throw new Error('force full recreation')
        },
        dispose() {
            events.push('old pipeline dispose')
        }
    }
    const replacement = { backend: {}, setMidiState() {}, setAudioState() {} }
    const renderer = bareRenderer(previousPipeline)
    renderer._currentDsl = ''
    renderer._createRuntime = async (dsl, options) => {
        assert.equal(dsl, 'search synth\nrender(o0)')
        assert.equal(options.canvas, undefined)
        events.push('replacement created')
        return replacement
    }

    const originalError = console.error
    console.error = () => {}
    try {
        const result = await renderer.compile('search synth\nrender(o0)')
        assert.equal(result, replacement)
    } finally {
        console.error = originalError
    }

    assert.equal(renderer.pipeline, replacement)
    assert.deepEqual(events, ['replacement created', 'old pipeline dispose'])
})

test('failed fallback recreation retains the active old pipeline without closing its sink', async () => {
    let disposals = 0
    const previousPipeline = {
        width: 16,
        height: 16,
        graph: { id: 'old graph' },
        isCompiling: false,
        createSurfaces() {
            throw new Error('force full recreation')
        },
        dispose() {
            disposals++
        }
    }
    const renderer = bareRenderer(previousPipeline)
    renderer._createRuntime = async () => {
        throw new Error('replacement failed')
    }

    const originalError = console.error
    console.error = () => {}
    try {
        await assert.rejects(
            renderer.compile('search synth\nrender(o0)'),
            { message: 'replacement failed' }
        )
    } finally {
        console.error = originalError
    }

    assert.equal(renderer.pipeline, previousPipeline)
    assert.equal(previousPipeline.isCompiling, false)
    assert.equal(disposals, 0)
})

test('context restoration disposes the dead pipeline in backendLost mode before rebuilding', async () => {
    const listeners = new Map()
    const canvas = {
        addEventListener(name, listener) { listeners.set(name, listener) },
        removeEventListener() {}
    }
    const events = []
    const oldPipeline = {
        backend: {},
        dispose(options) {
            events.push(['old pipeline dispose', options])
        }
    }
    const replacement = { backend: {} }
    const renderer = bareRenderer(oldPipeline)
    renderer._canvas = canvas
    renderer._currentDsl = 'search synth\nrender(o0)'
    renderer._onContextLost = null
    renderer._onContextRestored = null
    renderer._onError = null
    renderer.stop = () => {}
    renderer.start = () => {}
    renderer.compile = async () => {
        events.push(['compile replacement'])
        renderer._pipeline = replacement
        return replacement
    }
    renderer._reuploadCachedMeshes = async () => {}
    renderer._setupContextLossHandlers()

    const originalLog = console.log
    console.log = () => {}
    try {
        await listeners.get('webglcontextrestored')()
    } finally {
        console.log = originalLog
    }

    assert.deepEqual(events, [
        ['old pipeline dispose', { backendLost: true }],
        ['compile replacement']
    ])
    assert.equal(renderer.pipeline, replacement)
})

test('dispose during awaited initial creation invalidates and normally disposes the stale result', async () => {
    const creation = deferred()
    const events = []
    const renderer = bareRenderer()
    renderer._createRuntime = () => creation.promise
    const pending = renderer.compile('search synth\nrender(o0)')
    await flushMicrotasks()

    await renderer.dispose()
    creation.resolve(stalePipeline(events, 'stale'))

    assert.equal(await pending, null)
    assert.equal(renderer.pipeline, null)
    assert.deepEqual(events, [['stale dispose', {}]])
})

test('backend switch during awaited initial creation abandons the stale result without backend calls', async () => {
    const creation = deferred()
    const events = []
    const renderer = bareRenderer()
    renderer._createRuntime = () => creation.promise
    let resets = 0
    renderer.resetCanvas = () => { resets++ }
    const pending = renderer.compile('search synth\nrender(o0)')
    await flushMicrotasks()

    await renderer.switchBackend('wgsl')
    creation.resolve(stalePipeline(events, 'stale'))

    assert.equal(await pending, null)
    assert.equal(renderer.pipeline, null)
    assert.equal(resets, 1)
    assert.deepEqual(events, [['stale dispose', { backendLost: true }]])
})

function pendingFallbackFixture() {
    const creation = deferred()
    const events = []
    const previousPipeline = {
        width: 16,
        height: 16,
        graph: { id: 'old graph' },
        isCompiling: false,
        createSurfaces() { throw new Error('force full recreation') },
        dispose(options) { events.push(['old dispose', options]) }
    }
    const renderer = bareRenderer(previousPipeline)
    renderer._createRuntime = () => creation.promise
    return { renderer, creation, events }
}

test('dispose during awaited fallback creation retains no pipeline and disposes the stale result once', async () => {
    const fixture = pendingFallbackFixture()
    const originalError = console.error
    console.error = () => {}
    try {
        const pending = fixture.renderer.compile('search synth\nrender(o0)')
        await flushMicrotasks()
        await fixture.renderer.dispose()
        fixture.creation.resolve(stalePipeline(fixture.events, 'stale'))
        assert.equal(await pending, null)
    } finally {
        console.error = originalError
    }

    assert.equal(fixture.renderer.pipeline, null)
    assert.deepEqual(fixture.events, [
        ['old dispose', { loseContext: false }],
        ['stale dispose', {}]
    ])
})

test('backend switch during awaited fallback creation loss-safely disposes both old and stale pipelines', async () => {
    const fixture = pendingFallbackFixture()
    let resets = 0
    fixture.renderer.resetCanvas = () => { resets++ }
    const originalError = console.error
    console.error = () => {}
    try {
        const pending = fixture.renderer.compile('search synth\nrender(o0)')
        await flushMicrotasks()
        await fixture.renderer.switchBackend('wgsl')
        fixture.creation.resolve(stalePipeline(fixture.events, 'stale'))
        assert.equal(await pending, null)
    } finally {
        console.error = originalError
    }

    assert.equal(fixture.renderer.pipeline, null)
    assert.equal(resets, 1)
    assert.deepEqual(fixture.events, [
        ['old dispose', { loseContext: true }],
        ['stale dispose', { backendLost: true }]
    ])
})

function restorationFixture() {
    const listeners = new Map()
    const creation = deferred()
    const events = []
    const renderer = bareRenderer({
        backend: {},
        dispose(options) { events.push(['dead dispose', options]) }
    })
    renderer._canvas = {
        addEventListener(name, listener) { listeners.set(name, listener) },
        removeEventListener() {}
    }
    renderer._currentDsl = 'search synth\nrender(o0)'
    renderer._onContextLost = null
    renderer._onContextRestored = () => { events.push(['restored callback']) }
    renderer._onError = error => { events.push(['error', error]) }
    renderer.stop = () => { renderer._isRunning = false }
    renderer.start = () => {
        if (!renderer._isRunning) {
            renderer._isRunning = true
            events.push(['start'])
        }
    }
    renderer._wasRunningBeforeContextLoss = true
    renderer._createRuntime = () => creation.promise
    renderer._reuploadCachedMeshes = async () => {}
    renderer._setupContextLossHandlers()
    return { renderer, listeners, creation, events }
}

test('dispose during restoration cancels stale completion without an error or render-loop resurrection', async () => {
    const fixture = restorationFixture()
    const originalLog = console.log
    console.log = () => {}
    try {
        const restoring = fixture.listeners.get('webglcontextrestored')()
        await flushMicrotasks()
        await fixture.renderer.dispose()
        fixture.creation.resolve(stalePipeline(fixture.events, 'stale'))
        await restoring
    } finally {
        console.log = originalLog
    }

    assert.equal(fixture.renderer.pipeline, null)
    assert.equal(fixture.renderer._isRunning, false)
    assert.deepEqual(fixture.events, [
        ['dead dispose', { backendLost: true }],
        ['stale dispose', {}]
    ])
})

test('backend switch during restoration loss-safely cancels the stale result without resurrection', async () => {
    const fixture = restorationFixture()
    let resets = 0
    fixture.renderer.resetCanvas = () => { resets++ }
    const originalLog = console.log
    console.log = () => {}
    try {
        const restoring = fixture.listeners.get('webglcontextrestored')()
        await flushMicrotasks()
        await fixture.renderer.switchBackend('wgsl')
        fixture.creation.resolve(stalePipeline(fixture.events, 'stale'))
        await restoring
    } finally {
        console.log = originalLog
    }

    assert.equal(fixture.renderer.pipeline, null)
    assert.equal(fixture.renderer._isRunning, false)
    assert.equal(resets, 1)
    assert.deepEqual(fixture.events, [
        ['dead dispose', { backendLost: true }],
        ['stale dispose', { backendLost: true }]
    ])
})

for (const { name, fn } of tests) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
    } catch (error) {
        console.error(`FAIL: ${name}`)
        console.error(error)
        process.exit(1)
    }
}

console.log(`\n${tests.length}/${tests.length} CanvasRenderer sink API tests passed`)
