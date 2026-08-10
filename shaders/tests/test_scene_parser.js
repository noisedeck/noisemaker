import assert from 'assert'
import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'

function parseSource(src) {
  return parse(lex(src))
}

// Basic scene with camera
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 2, -5], target: [0, 0, 0])
    ).write(o0)
  `)
  assert.ok(ast, 'parses without error')
  const plan = ast.plans[0]
  assert.ok(plan, 'has a plan')
}

// Scene with mesh and material
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      mesh("sphere", radius: 1)
        .material(solid(color: [1, 0, 0]))
    ).write(o0)
  `)
  assert.ok(ast, 'parses scene with mesh')
}

// Scene with light
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      light(type: "directional", dir: [1, -1, 0], intensity: 1)
    ).write(o0)
  `)
  assert.ok(ast, 'parses scene with light')
}

// Scene with group hierarchy
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      group(pos: [0, 0, 0], id: "player",
        mesh("sphere", radius: 0.5)
          .material(solid(color: [1, 0, 0])),
        group(pos: [0, -1, 0],
          mesh("cylinder", radius: 0.1, height: 1)
        )
      )
    ).write(o0)
  `)
  assert.ok(ast, 'parses nested groups')
}

// Scene with SDF
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      sdf(op: "union", smooth: 0.2,
        sphere(radius: 1),
        box(size: [0.8, 0.8, 0.8])
      ).material(solid(color: [1, 1, 1]))
    ).write(o0)
  `)
  assert.ok(ast, 'parses SDF')
}

// Scene with post-processing
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      mesh("sphere", radius: 1),
      post(
        bloom(threshold: 0.8)
      )
    ).write(o0)
  `)
  assert.ok(ast, 'parses post-processing')
}

// Scene with procedural geometry
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      procedural("marchingCubes", threshold: 0.5, resolution: 32)
    ).write(o0)
  `)
  assert.ok(ast, 'parses procedural geometry')
}

// Scene with mesh file loading
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      mesh("file", src: "model.glb")
    ).write(o0)
  `)
  assert.ok(ast, 'parses mesh file loading')
}

// Scene with PBR material
{
  const ast = parseSource(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 0, 5], target: [0, 0, 0]),
      mesh("sphere", radius: 1)
        .material(
          noise(scale: 10)
            .grade(palette: "magma")
            .pbr(metallic: 0.8, roughness: 0.2)
        )
    ).write(o0)
  `)
  assert.ok(ast, 'parses PBR material')
}

// Existing DSL still works (CRITICAL - must not break existing functionality)
{
  const ast = parseSource(`
    search synth
    noise(xScale: 75, yScale: 75, octaves: 2)
      .blur(radius: 3)
      .grade(colorMode: 1)
      .write(o0)
  `)
  assert.ok(ast, 'existing DSL still parses')
}

// Array literal parsing
{
  const ast = parseSource(`
    search synth
    scene(
      camera(pos: [1, 2, 3])
    ).write(o0)
  `)
  assert.ok(ast, 'parses array literals')
  // Verify the array was parsed correctly
  const plan = ast.plans[0]
  const chain = plan.chain
  // scene() is the first call
  const sceneCall = chain[0]
  assert.strictEqual(sceneCall.name, 'scene', 'first call is scene')
  // camera() is the first positional arg to scene
  const cameraCall = sceneCall.args[0]
  assert.strictEqual(cameraCall.name, 'camera', 'camera is arg to scene')
  // pos should be an ArrayLiteral node
  const posArg = cameraCall.kwargs.pos
  assert.strictEqual(posArg.type, 'ArrayLiteral', 'pos is ArrayLiteral node')
  assert.strictEqual(posArg.elements.length, 3, 'array has 3 elements')
  assert.strictEqual(posArg.elements[0].value, 1, 'first element is 1')
  assert.strictEqual(posArg.elements[1].value, 2, 'second element is 2')
  assert.strictEqual(posArg.elements[2].value, 3, 'third element is 3')
}

// Mixed positional + keyword args
{
  const ast = parseSource(`
    search synth
    mesh("sphere", radius: 1).write(o0)
  `)
  assert.ok(ast, 'parses mixed positional + keyword args')
  const call = ast.plans[0].chain[0]
  assert.strictEqual(call.name, 'mesh', 'call is mesh')
  assert.strictEqual(call.args.length, 1, 'has 1 positional arg')
  assert.strictEqual(call.args[0].value, 'sphere', 'positional arg is sphere')
  assert.ok(call.kwargs, 'has kwargs')
  assert.strictEqual(call.kwargs.radius.value, 1, 'radius kwarg is 1')
}

// Object literals remain general data, but they are not an automation syntax.
{
  const ast = parseSource(`
    search synth
    scene(
      group(rot: [0, { mode: "preview", amount: 0.5 }, 0],
        mesh("sphere", radius: 1)
      )
    ).write(o0)
  `)
  assert.ok(ast, 'parses object literal in array')
  const sceneCall = ast.plans[0].chain[0]
  const groupCall = sceneCall.args[0]
  assert.strictEqual(groupCall.name, 'group', 'group call parsed')
  const rotArg = groupCall.kwargs.rot
  assert.strictEqual(rotArg.type, 'ArrayLiteral', 'rot is ArrayLiteral node')
  assert.strictEqual(rotArg.elements.length, 3, 'rot has 3 elements')
  assert.strictEqual(rotArg.elements[0].value, 0, 'first element is 0')
  const objNode = rotArg.elements[1]
  assert.strictEqual(objNode.type, 'Object', 'second element is Object node')
  assert.strictEqual(objNode.properties.mode.value, 'preview', 'string property')
  assert.strictEqual(objNode.properties.amount.value, 0.5, 'number property')
  assert.strictEqual(rotArg.elements[2].value, 0, 'third element is 0')
}

// Standalone object literal as kwarg value
{
  const ast = parseSource(`
    search synth
    scene(
      mesh("sphere", anim: { speed: 2, loop: true })
    ).write(o0)
  `)
  assert.ok(ast, 'parses object literal as kwarg')
  const meshCall = ast.plans[0].chain[0].args[0]
  const animArg = meshCall.kwargs.anim
  assert.strictEqual(animArg.type, 'Object', 'anim is Object node')
  assert.strictEqual(animArg.properties.speed.value, 2, 'speed property')
  assert.strictEqual(animArg.properties.loop.value, true, 'loop property')
}

console.log('Scene parser tests passed')
