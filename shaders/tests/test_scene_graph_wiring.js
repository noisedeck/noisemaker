// shaders/tests/test_scene_graph_wiring.js
//
// Effect definitions load lazily from the manifest in the browser and are not
// registered under node, so these cases use only scene syntax and pipeline
// builtins (read/write/render) — no named effects.
import assert from 'node:assert'
import { compileGraph } from '../src/runtime/compiler.js'
import { SCENE_COLOR_TEXTURE } from '../src/rendering/scene-compiler.js'

// A scene program compiles to IR, a scene_color texture, and a blit into o0
{
  const graph = compileGraph(`
search synth
scene(
  camera(fov: 60, pos: [0, 3, -8], target: [0, 0, 0]),
  light(type: "directional", dir: [1, -1, 1]),
  mesh("sphere", radius: 1)
).write(o0)
render(o0)
`)

  assert.strictEqual(graph._isScene, true, 'graph flagged as scene')
  assert.ok(graph.sceneIR, 'graph carries scene IR')
  assert.strictEqual(graph.sceneIR.camera.fov, 60, 'scene IR camera survived')
  assert.strictEqual(graph.sceneIR.nodes.length, 1, 'scene IR has one node')
  assert.strictEqual(graph.sceneIR.lights.length, 1, 'scene IR has one light')

  assert.ok(graph.textures.has(SCENE_COLOR_TEXTURE), 'scene_color texture allocated')

  const blit = graph.passes.find(p => p.inputs?.src === SCENE_COLOR_TEXTURE)
  assert.ok(blit, 'a pass blits scene_color')
  assert.strictEqual(blit.outputs.color, 'global_o0', 'blit targets o0')

  assert.strictEqual(graph.renderSurface, 'o0', 'render directive resolved to o0')
}

// The scene output composes downstream: o0 can be read into another surface
{
  const graph = compileGraph(`
search synth
scene(camera(), mesh("box")).write(o0)
read(o0).write(o1)
render(o1)
`)
  assert.strictEqual(graph._isScene, true, 'composed program is a scene')

  const sceneBlit = graph.passes.find(p => p.inputs?.src === SCENE_COLOR_TEXTURE)
  assert.strictEqual(sceneBlit.outputs.color, 'global_o0', 'scene lands in o0')

  const downstream = graph.passes.find(p => p.inputs?.src === 'global_o0')
  assert.ok(downstream, 'a downstream pass reads o0')
  assert.strictEqual(downstream.outputs.color, 'global_o1', 'downstream writes o1')
  assert.strictEqual(graph.renderSurface, 'o1', 'presents the composed surface')
}

// A program without scene() is untouched
{
  const graph = compileGraph('search synth\nrender(o0)')
  assert.strictEqual(graph._isScene, false, 'plain program not flagged as scene')
  assert.strictEqual(graph.sceneIR, null, 'plain program has null scene IR')
  assert.ok(!graph.textures.has(SCENE_COLOR_TEXTURE), 'no scene_color allocated')
}

console.log('Scene graph wiring tests passed')
