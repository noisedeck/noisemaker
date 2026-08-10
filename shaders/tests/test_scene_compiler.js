// shaders/tests/test_scene_compiler.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { compile } from '../src/lang/index.js'
import { compileScene } from '../src/rendering/scene-compiler.js'

function irFor(src) {
  return compileScene(compile(src))
}

// Returns null for a non-scene program
{
  assert.strictEqual(irFor('search synth\nnoise().write(o0)'), null,
    'non-scene program yields null IR')
}

// Camera, lights and settings
{
  const ir = irFor(`
    search synth
    scene(
      ambient: 0.15,
      background: [0.05, 0.05, 0.1],
      camera(fov: 60, pos: [0, 3, -8], target: [0, 0, 0]),
      light(type: "directional", dir: [1, -1, 1], color: [1, 0.95, 0.9], intensity: 2),
      light(type: "point", pos: [-3, 4, -2], intensity: 3, falloff: 1)
    ).write(o0)
  `)
  assert.ok(ir, 'scene program yields IR')
  assert.strictEqual(ir.settings.ambient, 0.15, 'ambient setting')
  assert.deepStrictEqual(ir.settings.background, [0.05, 0.05, 0.1], 'background setting')
  assert.strictEqual(ir.camera.fov, 60, 'camera fov')
  assert.deepStrictEqual(ir.camera.position, [0, 3, -8], 'camera position')
  assert.deepStrictEqual(ir.camera.target, [0, 0, 0], 'camera target')
  assert.strictEqual(ir.camera.near, 0.1, 'camera near default')
  assert.strictEqual(ir.camera.far, 1000, 'camera far default')
  assert.strictEqual(ir.lights.length, 2, 'two lights')
  assert.strictEqual(ir.lights[0].type, 'directional', 'first light type')
  assert.deepStrictEqual(ir.lights[0].direction, [1, -1, 1], 'directional dir')
  assert.strictEqual(ir.lights[0].intensity, 2, 'directional intensity')
  assert.strictEqual(ir.lights[1].type, 'point', 'second light type')
  assert.deepStrictEqual(ir.lights[1].position, [-3, 4, -2], 'point position')
  assert.strictEqual(ir.lights[1].falloff, 1, 'point falloff')
}

// Defaults when the scene omits things
{
  const ir = irFor('search synth\nscene(camera()).write(o0)')
  assert.strictEqual(ir.camera.fov, 60, 'default fov')
  assert.deepStrictEqual(ir.camera.position, [0, 0, 5], 'default camera position')
  assert.deepStrictEqual(ir.camera.target, [0, 0, 0], 'default camera target')
  assert.strictEqual(ir.lights.length, 0, 'no lights')
  assert.deepStrictEqual(ir.nodes, [], 'no nodes')
  assert.deepStrictEqual(ir.materials, {}, 'no materials')
}

// Reflection probes use one explicit scene-level control surface. Position is
// a finite vec3 and size is an integer in the renderer's supported range.
{
  const ir = irFor(`
    search synth
    scene(
      reflectionProbe: [0, 2.5, -3.5],
      reflectionProbeSize: 128,
      camera()
    ).write(o0)
  `)
  assert.deepStrictEqual(ir.settings.reflectionProbe, [0, 2.5, -3.5])
  assert.strictEqual(ir.settings.reflectionProbeSize, 128)

  assert.throws(() => irFor(`
    search synth
    scene(reflectionProbe: [0, 1], camera()).write(o0)
  `), /reflectionProbe must be a finite vec3.*line/s, 'malformed probe position rejected')
  assert.throws(() => irFor(`
    search synth
    scene(reflectionProbe: [0, 2, -3], reflectionProbeSize: 12, camera()).write(o0)
  `), /reflectionProbeSize must be an integer between 16 and 512.*line/s, 'unsupported probe size rejected')
  assert.throws(() => irFor(`
    search synth
    scene(reflectionProbeSize: 64, camera()).write(o0)
  `), /reflectionProbeSize requires reflectionProbe.*line/s, 'orphan probe size rejected')
}

// Unknown light type is a compile error with location
{
  assert.throws(() => irFor(`
    search synth
    scene(light(type: "area")).write(o0)
  `), /Unknown light type 'area'.*line/s, 'unknown light type rejected')
}

// Mesh and group hierarchy flattens to indexed nodes
{
  const ir = irFor(`
    search synth
    scene(
      group(id: "main", pos: [1, 0, 0],
        mesh("sphere", radius: 1.5, pos: [0, 1, 0]),
        mesh("box", pos: [2, 0, 0])
      ),
      mesh("torus")
    ).write(o0)
  `)
  assert.strictEqual(ir.nodes.length, 4, 'group + 2 children + 1 root mesh')

  const group = ir.nodes.find(n => n.id === 'main')
  assert.strictEqual(group.type, 'group', 'group node type')
  assert.deepStrictEqual(group.transform.position, [1, 0, 0], 'group position')
  assert.strictEqual(group.children.length, 2, 'group has 2 children')
  assert.strictEqual(group.parent, null, 'group is a root')

  const sphere = ir.nodes[group.children[0]]
  assert.strictEqual(sphere.type, 'mesh', 'child is mesh')
  assert.strictEqual(sphere.meshType, 'sphere', 'mesh type from positional arg')
  assert.strictEqual(sphere.meshParams.radius, 1.5, 'mesh params carry geometry kwargs')
  assert.strictEqual(sphere.meshParams.pos, undefined, 'pos is not a mesh param')
  assert.deepStrictEqual(sphere.transform.position, [0, 1, 0], 'mesh position')
  assert.strictEqual(sphere.parent, ir.nodes.indexOf(group), 'child parent index')

  const torus = ir.nodes.find(n => n.meshType === 'torus')
  assert.strictEqual(torus.parent, null, 'root mesh has null parent')
}

// Unknown mesh type is a compile error
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("teapot")).write(o0)
  `), /Unknown mesh type 'teapot'.*line/s, 'unknown mesh type rejected')
}

// A plane can explicitly opt into the one planar-reflection receiver
{
  const ir = irFor(`
    search synth
    scene(
      mesh("plane", id: "floor").reflector()
    ).write(o0)
  `)
  assert.strictEqual(ir.nodes[0].planarReflection, true, 'reflector flag reaches scene IR')
}

// Planar reflection is explicit, plane-only, argument-free, and unique
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("sphere").reflector()).write(o0)
  `), /reflector\(\) requires a plane mesh.*line/s, 'non-plane reflector rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("plane").reflector(strength: 1)).write(o0)
  `), /reflector\(\) takes no arguments.*line/s, 'reflector kwargs rejected')
  assert.throws(() => irFor(`
    search synth
    scene(
      mesh("plane", id: "a").reflector(),
      mesh("plane", id: "b", pos: [0, 2, 0]).reflector()
    ).write(o0)
  `), /Only one reflector\(\).*line/s, 'multiple planar reflectors rejected')
}

// Materials Lab keeps its torus in contact with the reflector so the
// reflection specimen does not appear to hover.
{
  const source = readFileSync(
    new URL('../../demo/shaders/scenes/materials-lab.dsl', import.meta.url),
    'utf8'
  )
  const ir = irFor(source)
  const reflector = ir.nodes.find(node => node.planarReflection)
  const torus = ir.nodes.find(node => node.meshType === 'torus')
  const reflectorY = reflector.transform.position[1]
  const torusBottom = torus.transform.position[1] - torus.meshParams.tube

  assert.ok(
    Math.abs(torusBottom - reflectorY) < 1e-6,
    `Materials Lab torus clears reflector by ${torusBottom - reflectorY}`
  )
}

// Inline .material(solid(...).pbr(...)) interns into ir.materials
{
  const ir = irFor(`
    search synth
    scene(
      mesh("sphere", radius: 1)
        .material(solid(color: [0.9, 0.8, 0.7]).pbr(metallic: 0.3, roughness: 0.4))
    ).write(o0)
  `)
  const node = ir.nodes[0]
  assert.strictEqual(typeof node.material, 'string', 'node references material by name')
  const mat = ir.materials[node.material]
  assert.ok(mat, 'material interned into ir.materials')
  assert.deepStrictEqual(mat.baseColor, [0.9, 0.8, 0.7], 'baseColor from solid()')
  assert.strictEqual(mat.pbr.metallic, 0.3, 'metallic from pbr()')
  assert.strictEqual(mat.pbr.roughness, 0.4, 'roughness from pbr()')
}

// Two inline materials intern to distinct keys
{
  const ir = irFor(`
    search synth
    scene(
      mesh("box").material(solid(color: [1, 0, 0])),
      mesh("box").material(solid(color: [0, 1, 0]))
    ).write(o0)
  `)
  assert.strictEqual(Object.keys(ir.materials).length, 2, 'two materials interned')
  assert.notStrictEqual(ir.nodes[0].material, ir.nodes[1].material, 'distinct keys')
  assert.deepStrictEqual(ir.materials[ir.nodes[0].material].baseColor, [1, 0, 0], 'first colour')
  assert.deepStrictEqual(ir.materials[ir.nodes[1].material].baseColor, [0, 1, 0], 'second colour')
}

// A mesh without .material() leaves material unset
{
  const ir = irFor('search synth\nscene(mesh("box")).write(o0)')
  assert.strictEqual(ir.nodes[0].material, undefined, 'no material key')
  assert.deepStrictEqual(ir.materials, {}, 'nothing interned')
}

// Scene transforms consume the canonical Polymorphic osc() descriptor.
{
  const ir = irFor(`
    search synth
    scene(
      group(rot: [0, osc(type: oscKind.saw, min: 0.25, max: 0.75, speed: 2), 0])
    ).write(o0)
  `)
  const rot = ir.nodes[0].transform.rotation
  assert.strictEqual(rot[0], 0, 'plain number preserved')
  assert.deepStrictEqual(rot[1], {
    type: 'Oscillator',
    oscType: 2,
    min: 0.25,
    max: 0.75,
    speed: 2,
    offset: 0,
    seed: 1
  }, 'osc() compiles to the canonical automation descriptor')
}

// Hand-authored oscillator-shaped objects are not a second automation DSL.
{
  assert.throws(
    () => irFor(`
      search synth
      scene(
        group(rot: [0, { type: "Oscillator", min: 0, max: 360, speed: 0.5 }, 0])
      ).write(o0)
    `),
    /use osc\(\)/i,
    'hallucinated oscillator object syntax is rejected'
  )
}

// Existing let-bound automation remains usable inside scene transform arrays.
{
  const ir = irFor(`
    search synth
    let spin = osc(type: oscKind.saw, speed: 2)
    scene(
      group(rot: [0, spin, 0])
    ).write(o0)
  `)
  assert.strictEqual(ir.nodes[0].transform.rotation[1].type, 'Oscillator', 'let-bound osc() is resolved')
  assert.strictEqual(ir.nodes[0].transform.rotation[1].oscType, 2, 'oscKind.saw is retained')
  assert.strictEqual(ir.nodes[0].transform.rotation[1].speed, 2, 'osc speed is retained')
}

// --- Materials v2 ---

// surface(oN) as albedo source
{
  const ir = irFor(`
    search synth
    scene(
      mesh("sphere").material(surface(o2).pbr(metallic: 0.3, roughness: 0.4))
    ).write(o0)
  `)
  const mat = ir.materials[ir.nodes[0].material]
  assert.strictEqual(mat.albedoSurface, 'o2', 'surface source recorded')
  assert.deepStrictEqual(mat.baseColor, [1, 1, 1], 'baseColor defaults white under surface')
  assert.strictEqual(mat.pbr.metallic, 0.3, 'pbr composes with surface')
}

// Surface materials expose one tint/UV control contract with stable defaults
{
  const defaults = irFor(`
    search synth
    scene(mesh("sphere").material(surface(o2))).write(o0)
  `)
  const defaultMat = defaults.materials[defaults.nodes[0].material]
  assert.deepStrictEqual(defaultMat.baseColor, [1, 1, 1], 'surface tint defaults white')
  assert.deepStrictEqual(defaultMat.uvScale, [1, 1], 'surface uvScale defaults one')
  assert.deepStrictEqual(defaultMat.uvOffset, [0, 0], 'surface uvOffset defaults zero')

  const custom = irFor(`
    search synth
    scene(
      mesh("sphere").material(
        surface(o2, tint: [0.8, 0.6, 0.4], uvScale: [3, -2], uvOffset: [0.25, 0.5])
      )
    ).write(o0)
  `)
  const customMat = custom.materials[custom.nodes[0].material]
  assert.deepStrictEqual(customMat.baseColor, [0.8, 0.6, 0.4], 'surface tint recorded')
  assert.deepStrictEqual(customMat.uvScale, [3, -2], 'surface uvScale recorded')
  assert.deepStrictEqual(customMat.uvOffset, [0.25, 0.5], 'surface uvOffset recorded')
}

// Group materials inherit through nested groups; a child material overrides
{
  const ir = irFor(`
    search synth
    scene(
      group(
        mesh("sphere"),
        group(
          mesh("box"),
          mesh("torus").material(solid(color: [0, 1, 0]))
        )
      ).material(solid(color: [1, 0, 0]))
    ).write(o0)
  `)
  const [group, sphere, nested, box, torus] = ir.nodes
  assert.ok(group.material, 'group material interned')
  assert.strictEqual(sphere.material, group.material, 'direct child inherits group material')
  assert.strictEqual(nested.material, group.material, 'nested group records inherited material')
  assert.strictEqual(box.material, group.material, 'nested mesh inherits ancestor material')
  assert.notStrictEqual(torus.material, group.material, 'child material overrides inheritance')
  assert.deepStrictEqual(ir.materials[torus.material].baseColor, [0, 1, 0], 'override material retained')
}

// solid and surface are mutually exclusive
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(solid(color: [1, 0, 0]).surface(o2))).write(o0)
  `), /one material source.*line/s, 'two sources rejected')
}

// surface() requires an output ref
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(surface(0.5))).write(o0)
  `), /surface\(\) expects a surface reference.*line/s, 'non-ref surface arg rejected')
}

// A material must contain exactly one valid source
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(pbr(metallic: 0.5))).write(o0)
  `), /material source.*line/s, 'modifier-only material rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(42)).write(o0)
  `), /material source.*line/s, 'non-call material rejected')
}

// Material keyword typos and invalid ranges are hard diagnostics
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(surface(o2, tile: [2, 2]))).write(o0)
  `), /Unknown keyword 'tile' for surface\(\).*line/s, 'unknown surface keyword rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(solid(colour: [1, 0, 0]))).write(o0)
  `), /Unknown keyword 'colour' for solid\(\).*line/s, 'unknown solid keyword rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(solid(color: [1, 0, 0]).pbr(metallic: 1.1))).write(o0)
  `), /metallic.*between 0 and 1.*line/s, 'metallic over one rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(solid(color: [1, 0, 0]).pbr(roughness: -0.1))).write(o0)
  `), /roughness.*between 0 and 1.*line/s, 'negative roughness rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(solid(color: [1, -0.1, 0]))).write(o0)
  `), /color.*non-negative.*line/s, 'negative color rejected')
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(surface(o2, uvScale: [1, 2, 3]))).write(o0)
  `), /uvScale.*2 values.*line/s, 'invalid uvScale shape rejected')
}

// emit(strength:) is a scalar emission
{
  const ir = irFor(`
    search synth
    scene(mesh("box").material(solid(color: [1, 1, 1]).emit(strength: 2.5))).write(o0)
  `)
  const mat = ir.materials[ir.nodes[0].material]
  assert.strictEqual(mat.emission, 2.5, 'emission strength recorded')
}

// emission defaults to 0
{
  const ir = irFor('search synth\nscene(mesh("box").material(solid(color: [1, 0, 0]))).write(o0)')
  assert.strictEqual(ir.materials[ir.nodes[0].material].emission, 0, 'no emit -> 0')
}

// Emission must be finite and non-negative
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box").material(solid(color: [1, 1, 1]).emit(strength: -1))).write(o0)
  `), /strength.*non-negative.*line/s, 'negative emission rejected')
}

// --- Lights v2 ---

// spot light extraction with defaults
{
  const ir = irFor(`
    search synth
    scene(
      light(type: "spot", pos: [0, 5, 0], dir: [0, -1, 0], intensity: 4, angle: 30, penumbra: 0.2, falloff: 1)
    ).write(o0)
  `)
  const l = ir.lights[0]
  assert.strictEqual(l.type, 'spot', 'spot type')
  assert.deepStrictEqual(l.position, [0, 5, 0], 'spot position')
  assert.deepStrictEqual(l.direction, [0, -1, 0], 'spot direction')
  assert.strictEqual(l.angle, 30, 'spot angle')
  assert.strictEqual(l.penumbra, 0.2, 'spot penumbra')

  const d = irFor('search synth\nscene(light(type: "spot", pos: [0, 5, 0])).write(o0)').lights[0]
  assert.strictEqual(d.angle, 45, 'default angle')
  assert.strictEqual(d.penumbra, 0.1, 'default penumbra')
  assert.deepStrictEqual(d.direction, [0, -1, 0], 'default direction')
  assert.strictEqual(d.falloff, 1, 'default falloff preserves current inverse-square behavior')
}

// Point/spot falloff is a non-negative coefficient
{
  assert.throws(() => irFor(`
    search synth
    scene(light(type: "point", falloff: -1)).write(o0)
  `), /falloff.*non-negative.*line/s, 'negative falloff rejected')
}

// --- Environment ---
{
  const ir = irFor(`
    search synth
    scene(environment(o3, intensity: 0.5), mesh("box")).write(o0)
  `)
  assert.deepStrictEqual(ir.environment, { surface: 'o3', intensity: 0.5 }, 'environment extracted')
  const none = irFor('search synth\nscene(mesh("box")).write(o0)')
  assert.strictEqual(none.environment, null, 'no environment -> null')
}

// --- Settings pass-through ---
{
  const ir = irFor(`
    search synth
    scene(
      sky: [0.4, 0.6, 1.0], ground: [0.3, 0.25, 0.2],
      exposure: 1.5, ssao: 0.8, ssaoRadius: 0.5, reflections: 0.7,
      mesh("box")
    ).write(o0)
  `)
  assert.deepStrictEqual(ir.settings.sky, [0.4, 0.6, 1.0], 'sky')
  assert.deepStrictEqual(ir.settings.ground, [0.3, 0.25, 0.2], 'ground')
  assert.strictEqual(ir.settings.exposure, 1.5, 'exposure')
  assert.strictEqual(ir.settings.ssao, 0.8, 'ssao')
  assert.strictEqual(ir.settings.ssaoRadius, 0.5, 'ssaoRadius')
  assert.strictEqual(ir.settings.reflections, 0.7, 'reflections')
}

// --- Diagnostics ---

// A second scene() is a compile error
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box")).write(o0)
    scene(mesh("sphere")).write(o1)
    render(o0)
  `), /one scene\(\) per program.*line/s, 'second scene rejected')
}

// Unknown scene children are compile errors, not silent drops
{
  assert.throws(() => irFor(`
    search synth
    scene(sphere(radius: 2)).write(o0)
  `), /Unknown scene child 'sphere'.*line/s, 'unknown child rejected')
}

console.log('Scene compiler tests passed')
