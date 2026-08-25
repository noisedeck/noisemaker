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

// ---------------------------------------------------------------------------
// Numbers must be emitted as plain decimals.
//
// formatNumber leaned on String(), which switches to exponent notation outside
// [1e-6, 1e21) — and the number lexer reads only digits[.digits]. A camera
// position of 1e-7 therefore round-tripped into source that does not parse.
// ---------------------------------------------------------------------------

test('tiny and huge numbers round-trip as plain decimals', () => {
    const out = assertStable(
        'search synth\nscene(camera(fov: 60, pos: [0, 0.0000001, 0])).write(o0)\nrender(o0)',
        'tiny number')
    assert.ok(!/[eE][-+]?\d/.test(out), `emitted exponent notation:\n${out}`)
    assert.match(out, /0\.0000001/, 'keeps the tiny value as a decimal')

    const big = assertStable(
        'search synth\nscene(camera(fov: 60, pos: [0, 1000000000000000000000, 0])).write(o0)\nrender(o0)',
        'huge number')
    assert.ok(!/[eE][-+]?\d/.test(big), `emitted exponent notation:\n${big}`)

    const neg = assertStable(
        'search synth\nscene(camera(fov: 60, pos: [0, -0.0000001, 0])).write(o0)\nrender(o0)',
        'negative tiny number')
    assert.ok(!/[eE][-+]?\d/.test(neg), `emitted exponent notation:\n${neg}`)
    assert.match(neg, /-0\.0000001/, 'keeps the sign and the magnitude')
})

test('formatted numbers reparse to the same value', () => {
    for (const literal of ['0.0000001', '1000000000000000000000', '0.000000000123', '1.5', '0']) {
        const src = `search synth\nscene(camera(fov: 60, pos: [0, ${literal}, 0])).write(o0)\nrender(o0)`
        const out = unparse(compile(src))
        const emitted = /pos: \[0, ([^,\]]+),/.exec(out)
        assert.ok(emitted, `no pos vector in:\n${out}`)
        assert.match(emitted[1], /^-?\d+(\.\d+)?$/,
            `${literal} emitted as '${emitted[1]}', which the number lexer cannot read`)
        assert.strictEqual(parseFloat(emitted[1]), parseFloat(literal),
            `${literal} reparses to a different value (${emitted[1]})`)
    }
})

// ---------------------------------------------------------------------------
// Every AST node the parser can put inside a scene arg must have an emitter.
//
// The default case returned '' — so `intensity: audio(...)` unparsed to
// `intensity: )`, corrupting the user's source with no diagnostic at all.
// ---------------------------------------------------------------------------

test('audio() inside a scene argument round-trips', () => {
    const out = assertStable(`search synth
scene(
  camera(fov: 60),
  light(type: "directional", intensity: audio(audioBand.low))
).write(o0)
render(o0)`, 'audio binding')
    assert.match(out, /audio\(/, 'keeps the audio() call')
})

test('midi() inside a scene argument round-trips', () => {
    const out = assertStable(`search synth
scene(
  camera(fov: 60),
  light(type: "point", intensity: midi(1))
).write(o0)
render(o0)`, 'midi binding')
    assert.match(out, /midi\(/, 'keeps the midi() call')
})

test('an unhandled scene node type fails loudly instead of deleting itself', () => {
    const result = compile('search synth\nscene(camera(fov: 60)).write(o0)\nrender(o0)')
    const step = result.plans[0].chain.find(s => s.op === '_scene.scene')
    assert.ok(step, 'expected a _scene.scene step')
    step.args._ast.kwargs = { ambient: { type: 'NoSuchNodeType', value: 1 } }
    assert.throws(() => unparse(result), /NoSuchNodeType/,
        'expected a descriptive unparse error naming the node type')
})

// ---------------------------------------------------------------------------
// let bindings survive into scene arguments.
//
// substitute() tags the inlined value with _varRef so the unparser can put the
// name back; formatSceneAst ignored the tag and inlined the literal, silently
// dissolving the binding the user wrote.
// ---------------------------------------------------------------------------

test('a let binding used in a scene argument is preserved by name', () => {
    const out = assertStable(
        'search synth\nlet f = 60\nscene(camera(fov: f)).write(o0)\nrender(o0)',
        'let binding')
    assert.match(out, /fov: f\b/, `expected the binding name to survive:\n${out}`)
})

// ---------------------------------------------------------------------------
// Strings are stored raw by the lexer, so they must be emitted raw.
//
// JSON.stringify re-escaped what was never decoded, doubling every backslash
// on each pass through the unparser.
// ---------------------------------------------------------------------------

test('backslashes in strings do not grow across round-trips', () => {
    const src = 'search synth\nscene(camera(fov: 60), mesh("a\\\\b")).write(o0)\nrender(o0)'
    const once = unparse(compile(src))
    const twice = unparse(compile(once))
    const thrice = unparse(compile(twice))
    assert.strictEqual(twice, once, `first round-trip changed the string:\n${once}\n---\n${twice}`)
    assert.strictEqual(thrice, twice, `second round-trip changed the string:\n${twice}\n---\n${thrice}`)
    assert.match(once, /mesh\("a\\\\b"\)/, `expected the original escape to be preserved:\n${once}`)
})

// ---------------------------------------------------------------------------
// let bindings must be emittable too.
//
// Preserving a binding by name (above) is only worth anything if the binding
// line itself reparses. formatLetExpr had no ArrayLiteral case, so an array
// binding emitted `let p = [object Object]`, and its Number case used String(),
// carrying the same exponent-notation defect as formatNumber.
// ---------------------------------------------------------------------------

test('an array let binding used by a scene round-trips', () => {
    const out = assertStable(
        'search synth\nlet p = [0, 1, 0]\nscene(camera(fov: 60, pos: p)).write(o0)\nrender(o0)',
        'array binding')
    assert.match(out, /let p = \[0, 1, 0\]/, `expected the array binding to survive:\n${out}`)
    assert.match(out, /pos: p\b/, `expected the binding name to survive:\n${out}`)
})

test('a tiny number let binding round-trips as a plain decimal', () => {
    const out = assertStable(
        'search synth\nlet t = 0.0000001\nscene(camera(fov: 60, near: t)).write(o0)\nrender(o0)',
        'tiny binding')
    assert.ok(!/[eE][-+]?\d/.test(out), `emitted exponent notation:\n${out}`)
})

console.log(`\nScene round-trip: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
