/**
 * The scene must finish drawing into SCENE_COLOR_TEXTURE before the pipeline
 * runs, because the pipeline's blit is what carries that texture into a
 * surface. SceneRenderer.render() is async — it awaits shader compilation when
 * the light count changes, and GPU backpressure — so firing it without
 * awaiting leaves the pipeline blitting the *previous* frame's colour, a
 * permanent one-frame lag. On frame 1 it blits an uninitialized texture.
 *
 * Run: node shaders/tests/test_scene_integration.js
 */

import assert from 'node:assert'
import { CanvasRenderer } from '../src/renderer/canvas.js'
import { compileGraph, createRuntime, recompile } from '../src/runtime/compiler.js'

let passed = 0
let failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err && (err.message || JSON.stringify(err)))
        failed++
    }
}

/** Let queued microtasks and timers drain. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * A CanvasRenderer wired to fakes that record the order of operations.
 * `gate`, when supplied, is a promise the scene render waits on, so a render
 * can be held across several frames. `sceneError` makes the render reject.
 */
function harness({ sceneTicks = 1, gate = null, sceneError = null } = {}) {
    const order = []
    const errors = []
    const renderer = new CanvasRenderer({ width: 8, height: 8 })
    renderer._isScene = true
    renderer._sceneBindings = []
    renderer._clock = null
    renderer._onError = err => errors.push(err)
    renderer._sceneTree = { updateWorldMatrices() { order.push('tree') } }
    renderer._sceneRenderer = {
        async render() {
            order.push('scene-start')
            for (let i = 0; i < sceneTicks; i++) await Promise.resolve()
            if (gate) await gate
            if (sceneError) {
                order.push('scene-throw')
                throw sceneError
            }
            order.push('scene-end')
        }
    }
    renderer._pipeline = {
        lastPassCount: 0,
        render() { order.push('pipeline') }
    }
    return { renderer, order, errors }
}

const count = (order, entry) => order.filter(o => o === entry).length

await test('render() completes the scene before running the pipeline', async () => {
    const { renderer, order } = harness({ sceneTicks: 3 })
    await renderer.render(0.5)
    assert.deepStrictEqual(order, ['tree', 'scene-start', 'scene-end', 'pipeline'],
        `pipeline must run after the scene finishes, got: ${order.join(' -> ')}`)
})

await test('render() returns a promise that settles after the frame', async () => {
    const { renderer } = harness()
    const result = renderer.render(0.5)
    assert.ok(result && typeof result.then === 'function',
        'render() must be awaitable so single-shot capture sees the scene')
    await result
})

await test('overlapping scene renders do not queue unbounded work', async () => {
    const { renderer, order } = harness({ sceneTicks: 5 })
    // Fire three frames without awaiting; the in-flight render must be reused
    // rather than starting a second and third pass over the same textures.
    const a = renderer.render(0.1)
    const b = renderer.render(0.2)
    const c = renderer.render(0.3)
    await Promise.all([a, b, c])
    const starts = order.filter(o => o === 'scene-start').length
    assert.strictEqual(starts, 1,
        `expected the in-flight scene render to be reused, got ${starts} concurrent starts`)
})

await test('a failing scene render is reported once and never rejects its callers', async () => {
    // The in-flight promise is handed to every frame that reuses it. If the
    // stored promise is the raw one, a reusing frame gets an unguarded
    // rejection: an unhandled rejection that skips the pipeline and never
    // reaches _onError.
    const boom = new Error('scene exploded')
    const { renderer, order, errors } = harness({ sceneTicks: 4, sceneError: boom })
    const originating = renderer.render(0.1)
    const reusing = renderer.render(0.2)
    await assert.doesNotReject(() => originating,
        'the originating frame must absorb the scene failure')
    await assert.doesNotReject(() => reusing,
        'a frame reusing the in-flight render must absorb it too')
    assert.strictEqual(errors.length, 1,
        `_onError must fire exactly once per failed scene render, got ${errors.length}`)
    assert.strictEqual(errors[0], boom, 'the original error must be reported')
    assert.strictEqual(count(order, 'pipeline'), 2,
        `the pipeline must still present on both frames, got ${count(order, 'pipeline')}`)
})

await test('the render loop keeps presenting while a scene render is in flight', async () => {
    // A light-count change recompiles shaders inside SceneRenderer.render().
    // Blocking every rAF frame on that promise freezes the canvas for its whole
    // duration; the pipeline can keep blitting the last completed scene texture.
    let release = null
    const gate = new Promise(resolve => { release = resolve })
    const { renderer, order } = harness({ gate })
    const previousRAF = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = () => 0
    renderer._isRunning = true
    renderer._loopStartTime = 0
    try {
        const frames = [renderer._renderLoop(0)]
        await tick()
        frames.push(renderer._renderLoop(16))
        await tick()
        frames.push(renderer._renderLoop(32))
        await tick()

        assert.strictEqual(count(order, 'scene-start'), 1,
            `only one scene render may be in flight, got ${count(order, 'scene-start')}`)
        assert.strictEqual(count(order, 'pipeline'), 2,
            `frames 2 and 3 must present while frame 1's scene render is in flight, got ${count(order, 'pipeline')}`)

        release()
        await Promise.all(frames)
        assert.strictEqual(count(order, 'pipeline'), 3,
            'the frame that owns the scene render still presents when it lands')
        assert.strictEqual(count(order, 'scene-start'), 1,
            'the completed render must not have been restarted')
    } finally {
        renderer._isRunning = false
        globalThis.requestAnimationFrame = previousRAF
    }
})

await test('dispose() drops the in-flight scene render', async () => {
    // A disposed scene's promise must not be handed to the first frame of a
    // newly compiled scene: that tree was never ticked or bound for it.
    const { renderer } = harness()
    renderer._pipeline = null
    renderer._sceneRenderPending = Promise.resolve()
    await renderer.dispose()
    assert.strictEqual(renderer._sceneRenderPending, null,
        'teardown must clear the in-flight scene render')
})

/**
 * A CanvasRenderer whose scene renderer records the tile region argument, and
 * whose pipeline records the region it was handed. Tiled export drives both.
 */
function tileHarness() {
    const sceneRegions = []
    const pipelineRegions = []
    const renderer = new CanvasRenderer({ width: 8, height: 8 })
    renderer._isScene = true
    renderer._sceneBindings = []
    renderer._clock = null
    renderer._sceneTree = { updateWorldMatrices() {} }
    renderer._sceneRenderer = {
        async render(tree, clock, target, region) { sceneRegions.push(region) }
    }
    renderer._pipeline = {
        lastPassCount: 0,
        render() {},
        setTileRegion(region) { pipelineRegions.push(region) },
        clearTileRegion() { pipelineRegions.push(null) }
    }
    return { renderer, sceneRegions, pipelineRegions }
}

await test('a tile region set on the canvas reaches the scene renderer', async () => {
    // Tiled hi-res export sets one region and renders each tile. The 2D path
    // learns of it through Pipeline.setTileRegion; the scene path has no
    // fragment coordinate to shift, so it needs the region itself in order to
    // build the tile's sub-frustum.
    const { renderer, sceneRegions, pipelineRegions } = tileHarness()
    const region = { offset: [64, 0], fullResolution: [128, 128] }
    renderer.setTileRegion(region)
    await renderer.render(0.5)
    assert.deepStrictEqual(sceneRegions, [region],
        'the scene renderer must receive the same region object the pipeline got')
    assert.deepStrictEqual(pipelineRegions, [region],
        'the 2D pipeline still receives it unchanged')
})

await test('clearing the tile region returns the scene to full-frame rendering', async () => {
    const { renderer, sceneRegions } = tileHarness()
    renderer.setTileRegion({ offset: [64, 0], fullResolution: [128, 128] })
    await renderer.render(0.5)
    renderer.clearTileRegion()
    await renderer.render(0.5)
    assert.strictEqual(sceneRegions.length, 2)
    assert.strictEqual(sceneRegions[1], null,
        'a cleared region must reach the scene renderer as null, not linger')
})

await test('an untiled canvas hands the scene renderer no region', async () => {
    const { renderer, sceneRegions } = tileHarness()
    await renderer.render(0.5)
    assert.deepStrictEqual(sceneRegions, [null],
        'the default is untiled')
})

await test('createRuntime reuses an already-compiled graph', async () => {
    // A scene program needs no registered effect definitions, which do not
    // load under node — only scene syntax and pipeline builtins.
    const graph = compileGraph('search synth\nscene(camera(fov: 60), mesh("sphere")).write(o0)\nrender(o0)')

    // compile() already builds a graph to detect scene programs. Handing it to
    // createRuntime avoids parsing, validating, expanding and allocating the
    // whole program a second time on every interactive edit.
    let err = null
    try {
        await createRuntime('!!! not valid dsl !!!', { graph, width: 8, height: 8 })
    } catch (e) { err = e }
    assert.ok(err, 'no backend here, so pipeline creation is still expected to fail')
    // Not every throw on this path is an Error instance.
    const text = (err && (err.message || err.code)) || JSON.stringify(err)
    assert.ok(!/Unexpected character/.test(text),
        `the provided graph should have been used, but the source was recompiled: ${text}`)
})

/**
 * A pipeline stand-in exposing only what recompile() touches, recording the
 * post-swap sequence so a graph handoff can't quietly skip it.
 */
function recompileTarget() {
    const calls = []
    return {
        calls,
        width: 8,
        height: 8,
        graph: null,
        createSurfaces() { calls.push('createSurfaces') },
        collectDefaultUniforms() { calls.push('collectDefaultUniforms'); return {} },
        recreateTextures() { calls.push('recreateTextures') },
        initAsyncEffects() { calls.push('initAsyncEffects') }
    }
}

/** Run `fn` with console.error captured — recompile() logs its failures. */
function quietErrors(fn) {
    const logged = []
    const original = console.error
    console.error = (...args) => logged.push(args.join(' '))
    try {
        return { result: fn(), logged }
    } finally {
        console.error = original
    }
}

await test('recompile reuses an already-compiled graph', async () => {
    const graph = compileGraph('search synth\nscene(camera(fov: 60), mesh("sphere")).write(o0)\nrender(o0)')

    // The live-edit path in compile() has already compiled this graph to detect
    // the scene program. Re-parsing the source inside recompile() is the
    // per-keystroke cost the graph handoff exists to avoid.
    const pipeline = recompileTarget()
    const { result, logged } = quietErrors(() =>
        recompile(pipeline, '!!! not valid dsl !!!', { graph }))

    assert.strictEqual(result, graph, `the provided graph must be used: ${logged.join(' ')}`)
    assert.strictEqual(pipeline.graph, graph, 'the graph must be swapped onto the pipeline')
    assert.deepStrictEqual(pipeline.calls,
        ['createSurfaces', 'collectDefaultUniforms', 'recreateTextures', 'initAsyncEffects'],
        'the post-swap sequence must be unchanged')
})

await test('recompile without a graph still compiles the source', async () => {
    const pipeline = recompileTarget()
    const { result, logged } = quietErrors(() =>
        recompile(pipeline, '!!! not valid dsl !!!', {}))

    assert.strictEqual(result, null, 'an unparseable source must still fail')
    assert.strictEqual(pipeline.graph, null, 'nothing may be swapped onto the pipeline')
    assert.deepStrictEqual(pipeline.calls, [], 'no surfaces may be recreated for a failed compile')
    assert.ok(/Recompilation failed/.test(logged.join(' ')), `the failure is reported: ${logged.join(' ')}`)
})

console.log(`\nScene integration: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
