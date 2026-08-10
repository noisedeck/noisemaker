// shaders/tests/test_scene_bindings.js
import assert from 'node:assert'
import { compile } from '../src/lang/index.js'
import { compileScene } from '../src/rendering/scene-compiler.js'
import { SceneTree } from '../src/scene/tree.js'
import { collectBindings, evaluateBindings } from '../src/scene/bindings.js'

function build(src) {
  const ir = compileScene(compile(src))
  const tree = SceneTree.fromIR(ir)
  const bindings = collectBindings(tree)
  return { ir, tree, bindings }
}

// A static scene yields no bindings and untouched transforms
{
  const { tree, bindings } = build(`
    search synth
    scene(mesh("box", pos: [1, 2, 3])).write(o0)
  `)
  assert.deepStrictEqual(bindings, [], 'no bindings in static scene')
  assert.deepStrictEqual(tree.getMeshNodes()[0].position, [1, 2, 3], 'static position intact')
}

// Canonical osc() rotation consumes the built-in percentage automation over
// the scene rotation range (0..360 degrees).
{
  const { tree, bindings } = build(`
    search synth
    scene(
      group(id: "spin", rot: [0, osc(type: oscKind.saw), 0],
        mesh("box")
      )
    ).write(o0)
  `)
  assert.strictEqual(bindings.length, 1, 'one binding collected')
  const b = bindings[0]
  assert.strictEqual(b.channel, 'rotation', 'rotation channel')
  assert.strictEqual(b.index, 1, 'component index')

  const spin = tree.getById('spin')
  assert.strictEqual(spin.rotation[1], 0, 'saw starts at zero degrees')
  assert.ok(Number.isFinite(spin.rotation[1]), 'no NaN in transforms')

  evaluateBindings(bindings, 0.25)
  assert.strictEqual(spin.rotation[1], 90, 'quarter loop maps to 90 degrees')
  evaluateBindings(bindings, 0.75)
  assert.strictEqual(spin.rotation[1], 270, 'three-quarter loop maps to 270 degrees')
}

// Evaluation dirties the node so world matrices recompute
{
  const { tree, bindings } = build(`
    search synth
    scene(
      mesh("box", pos: [osc(type: oscKind.saw), 0, 0])
    ).write(o0)
  `)
  const node = tree.getMeshNodes()[0]
  node.getWorldMatrix() // clean
  evaluateBindings(bindings, 0.25)
  assert.strictEqual(node._dirty, true, 'dirty after evaluation')
  assert.strictEqual(node.position[0], 0.25, 'unbounded position consumes raw oscillator percentage')
}

// Light intensity uses the same canonical evaluator without a second waveform.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      light(type: "point", pos: [0, 4, 0], intensity: osc(type: oscKind.saw)),
      mesh("box")
    ).write(o0)
  `)
  assert.strictEqual(bindings.length, 1, 'light binding collected')
  assert.strictEqual(bindings[0].channel, 'intensity', 'intensity channel')
  assert.strictEqual(tree.lights[0].intensity, 0, 'saw starts at zero')
  evaluateBindings(bindings, 0.5)
  assert.strictEqual(tree.lights[0].intensity, 0.5, 'light follows canonical saw waveform')
}

// Built-in offset semantics are preserved for scene bindings.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      mesh("box", pos: [0, osc(type: oscKind.sine, offset: 0.25), 0])
    ).write(o0)
  `)
  assert.ok(
    Math.abs(tree.getMeshNodes()[0].position[1] - 0.5) < 1e-12,
    'sine starts at midpoint with quarter-loop offset'
  )
  evaluateBindings(bindings, 0.25)
  assert.strictEqual(tree.getMeshNodes()[0].position[1], 1, 'offset advances to the sine peak')
  evaluateBindings(bindings, 0.5)
  assert.ok(
    Math.abs(tree.getMeshNodes()[0].position[1] - 0.5) < 1e-12,
    'half loop returns to midpoint'
  )
}

console.log('Scene bindings tests passed')
