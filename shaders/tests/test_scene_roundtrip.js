/**
 * Scene programs must survive parse -> unparse -> parse.
 *
 * unparse() is a public export, and every tool that reads a program back out
 * goes through it: replaceEffect, parameter-override save paths, editors. Scene
 * steps are emitted with `scene: true` and carry their original AST in
 * args._ast, and the unparser had no case for them — so they fell through to
 * the generic path and stringified as `_scene.scene(_ast: [object Object])`,
 * which does not reparse. Object literals had no case either.
 *
 * Run: node shaders/tests/test_scene_roundtrip.js
 */

import assert from 'node:assert'
import { compile } from '../src/lang/index.js'
import { unparse } from '../src/lang/unparser.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err.message)
        failed++
    }
}

/** parse -> unparse -> parse -> unparse; the two texts must agree. */
function assertStable(src, label) {
    const once = unparse(compile(src))
    assert.ok(!/\[object Object\]/.test(once), `${label}: unparsed to [object Object]:\n${once}`)
    let twice
    try {
        twice = unparse(compile(once))
    } catch (err) {
        throw new Error(`${label}: unparsed text does not reparse: ${err.message}\n--- emitted ---\n${once}`)
    }
    assert.strictEqual(twice, once, `${label}: round-trip is not stable`)
    return once
}

test('a minimal scene round-trips', () => {
    assertStable('search synth\nscene(camera(fov: 60)).write(o0)\nrender(o0)', 'minimal')
})

test('scene settings, lights and meshes round-trip', () => {
    const out = assertStable(`search synth
scene(
  ambient: 0.15,
  background: [0.05, 0.05, 0.1],
  camera(fov: 60, pos: [0, 3, -8], target: [0, 0, 0]),
  light(type: "directional", dir: [1, -1, 1], intensity: 2),
  mesh("sphere", radius: 1.5, pos: [0, 1, 0])
).write(o0)
render(o0)`, 'full scene')
    assert.match(out, /scene\(/, 'emits a scene() call')
    assert.match(out, /camera\(/, 'keeps the camera child')
    assert.match(out, /mesh\("sphere"/, 'keeps the mesh child and its string argument')
})

test('a mesh with a chained material round-trips', () => {
    assertStable(`search synth
scene(
  camera(fov: 60),
  mesh("box").material(solid(color: [0.9, 0.9, 0.95]).pbr(metallic: 0.1, roughness: 0.6))
).write(o0)
render(o0)`, 'material chain')
})

test('osc() inside a scene transform round-trips', () => {
    assertStable(`search synth
scene(
  camera(fov: 60),
  mesh("torus", rot: [0, osc(oscKind.saw, min: 0, max: 360), 0])
).write(o0)
render(o0)`, 'oscillator')
})

test('an object literal in a let binding round-trips', () => {
    assertStable(`search synth
let cfg = {x: 1, y: 2}
scene(camera(fov: 60)).write(o0)
render(o0)`, 'object literal')
})

console.log(`\nScene round-trip: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
