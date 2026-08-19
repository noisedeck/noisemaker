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
import { compileGraph, createRuntime } from '../src/runtime/compiler.js'

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

/** A CanvasRenderer wired to fakes that record the order of operations. */
function harness({ sceneTicks = 1 } = {}) {
    const order = []
    const renderer = new CanvasRenderer({ width: 8, height: 8 })
    renderer._isScene = true
    renderer._sceneBindings = []
    renderer._clock = null
    renderer._sceneTree = { updateWorldMatrices() { order.push('tree') } }
    renderer._sceneRenderer = {
        async render() {
            order.push('scene-start')
            for (let i = 0; i < sceneTicks; i++) await Promise.resolve()
            order.push('scene-end')
        }
    }
    renderer._pipeline = {
        lastPassCount: 0,
        render() { order.push('pipeline') }
    }
    return { renderer, order }
}

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

console.log(`\nScene integration: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
