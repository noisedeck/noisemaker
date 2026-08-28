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

// Scene errors carry a real source location.
//
// substitute() rebuilds Call nodes when it resolves variables and used to drop
// `loc`, so every scene diagnostic reported "line 0 col 0" while language.rst
// promised a line and column.
{
  let err = null
  try {
    irFor('search synth\nscene(camera(fov: 60), banana(x: 1)).write(o0)')
  } catch (e) { err = e }
  assert.ok(err, 'expected an error for an unknown scene child')
  assert.match(err.message, /banana/, 'names the offending child')
  const m = err.message.match(/line (\d+) col (\d+)/)
  assert.ok(m, `expected a line/col in: ${err.message}`)
  assert.notStrictEqual(m[1], '0', `expected a real line number, got: ${err.message}`)
}

// Unknown keywords on scene nodes are errors, not silent drops.
//
// assertKnownKeywords was wired only to the material terms, so a typo on
// scene/camera/light/mesh/group/environment compiled clean and was discarded.
{
  const cases = [
    ['camera', 'scene(camera(fov: 60, wobble: 3)).write(o0)'],
    ['light',  'scene(camera(fov: 60), light(type: "directional", intesity: 2)).write(o0)'],
    ['mesh',   'scene(camera(fov: 60), mesh("sphere", raduis: 2)).write(o0)'],
    ['scene',  'scene(ambeint: 0.2, camera(fov: 60)).write(o0)'],
  ]
  for (const [label, body] of cases) {
    assert.throws(() => irFor('search synth\n' + body),
      /Unknown keyword/,
      `${label}(): expected an unknown-keyword error`)
  }
}

// A scene without camera() gets the documented default camera.
//
// Every camera keyword has a default, so an absent camera() is not an error —
// but leaving ir.camera null made mesh-renderer dereference it once per frame,
// producing a black canvas and a console.error in the render loop.
{
  const ir = irFor('search synth\nscene(mesh("sphere")).write(o0)')
  assert.ok(ir, 'scene without camera still compiles')
  assert.ok(ir.camera, 'a default camera is synthesized')
  assert.strictEqual(ir.camera.fov, 60, 'documented default fov')
  assert.deepStrictEqual(ir.camera.position, [0, 0, 5], 'documented default position')
  assert.deepStrictEqual(ir.camera.target, [0, 0, 0], 'documented default target')
}

// osc() is rejected where it is not supported, instead of reaching the GPU.
//
// buildCamera/buildLight read vectors with a bare kw(), so an oscillator
// descriptor object flowed through to uniform3fv and the light position or
// view matrix became NaN with no error anywhere.
{
  const cases = [
    ['camera pos',  'scene(camera(pos: [osc(), 0, 5])).write(o0)'],
    ['camera target', 'scene(camera(target: [0, osc(), 0])).write(o0)'],
    ['light pos',   'scene(camera(fov: 60), light(type: "point", pos: [osc(), 2, 0])).write(o0)'],
    ['light dir',   'scene(camera(fov: 60), light(type: "directional", dir: [osc(), -1, 0])).write(o0)'],
  ]
  for (const [label, body] of cases) {
    assert.throws(() => irFor('search synth\n' + body),
      /must contain finite numbers|osc/i,
      `${label}: expected a compile error rather than NaN at runtime`)
  }
}

// Mesh shape parameters are validated before they reach the geometry builders.
{
  const bad = [
    ['torus tube 0',      'mesh("torus", tube: 0)'],
    ['sphere segments 0', 'mesh("sphere", segments: 0)'],
    ['sphere radius osc', 'mesh("sphere", radius: osc())'],
    ['huge segments',     'mesh("sphere", segments: 100000)'],
    ['negative radius',   'mesh("sphere", radius: -1)'],
  ]
  for (const [label, meshCall] of bad) {
    assert.throws(() => irFor(`search synth\nscene(camera(fov: 60), ${meshCall}).write(o0)`),
      /must be|out of range|between/i,
      `${label}: expected a compile error`)
  }
  // The ordinary forms still compile.
  const ok = irFor('search synth\nscene(camera(fov: 60), mesh("torus", radius: 2, tube: 0.5, segments: 48)).write(o0)')
  assert.strictEqual(ok.nodes.find(n => n.type === 'mesh').meshParams.tube, 0.5, 'valid params pass through')
}

// ---------------------------------------------------------------------------
// Scene diagnostics must point at real source positions.
//
// sceneError reads `node.loc`, but the parser attached one only to calls and
// array literals — so every error anchored to a literal value (a keyword's
// argument, a mesh type string) reported "line 0 col 0" and told the author
// nothing about where to look.
// ---------------------------------------------------------------------------
{
  const located = [
    ['unknown camera keyword', 'scene(camera(fov: 60, fow: 1)).write(o0)', /Unknown keyword 'fow'/],
    ['mesh param out of range', 'scene(camera(fov: 60), mesh("sphere", segments: 100000)).write(o0)', /segments must be/],
    ['unknown mesh type', 'scene(camera(fov: 60), mesh("blob")).write(o0)', /Unknown mesh type/],
    ['unknown light type', 'scene(camera(fov: 60), light(type: "laser")).write(o0)', /Unknown light type/],
    ['far behind near', 'scene(camera(near: 10, far: 5)).write(o0)', /far must be greater than near/],
    ['unknown scene keyword', 'scene(ambiant: 0.2, camera(fov: 60)).write(o0)', /Unknown keyword 'ambiant'/],
  ]
  for (const [label, body, messagePattern] of located) {
    let thrown = null
    try {
      irFor(`search synth\n${body}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `${label}: expected a compile error`)
    assert.match(thrown.message, messagePattern, `${label}: unexpected message`)
    assert.match(thrown.message, /line [1-9]\d* col \d+/,
      `${label}: expected a real source position, got "${thrown.message}"`)
  }
}

// An aliased call keeps its call-site location. resolveCall rebuilt the merged
// call from scratch and dropped `loc`, so anything the scene compiler reported
// about a `let`-aliased node landed at line 0.
{
  let thrown = null
  try {
    irFor('search synth\nlet w = widget()\nscene(camera(fov: 60), w()).write(o0)')
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, 'aliased unknown scene child: expected a compile error')
  assert.match(thrown.message, /line [1-9]\d* col \d+/,
    `aliased call: expected a real source position, got "${thrown.message}"`)
}

// ---------------------------------------------------------------------------
// group() keywords are checked, and mesh() takes exactly one positional.
//
// group() went through buildTransform without a keyword check, so `idd:` was
// dropped in silence; mesh() read args[0] and ignored everything after it, so
// `mesh("box", "sphere")` rendered a box with no complaint.
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => irFor('search synth\nscene(camera(fov: 60), group(idd: "x", mesh("box"))).write(o0)'),
    /Unknown keyword 'idd' for group\(\)/,
    'a mistyped group keyword is an error')

  assert.throws(
    () => irFor('search synth\nscene(camera(fov: 60), mesh("box", "sphere")).write(o0)'),
    /mesh/,
    'a second positional argument to mesh() is an error')

  // The legitimate forms still compile: group() positionals are its children,
  // and its transform keywords are unaffected.
  const ok = irFor('search synth\nscene(camera(fov: 60), group(id: "g", pos: [0, 1, 0], mesh("box"))).write(o0)')
  const group = ok.nodes.find(n => n.type === 'group')
  assert.ok(group, 'group node built')
  assert.strictEqual(group.id, 'g', 'group id kept')
  assert.deepStrictEqual(group.transform.position, [0, 1, 0], 'group transform kept')
  assert.strictEqual(group.children.length, 1, 'group child kept')
}

// ---------------------------------------------------------------------------
// volume() — a scene child whose positional is a vol surface.
//
// The volumetric path used to live entirely outside the scene graph: a
// fullscreen render3d() marcher with its own hardwired camera and lights. A
// volume node puts a vol atlas into the same tree as the meshes, so it takes
// the same transform keywords, the same material chain, and the same
// diagnostics.
// ---------------------------------------------------------------------------
{
  const ir = irFor(`
    search synth
    scene(
      camera(fov: 60, pos: [0, 2, -6]),
      volume(vol3, threshold: 0.25, id: "cloud", pos: [0, 1, 0], rot: [0, 45, 0], scale: [2, 2, 2])
        .material(solid(color: [0.9, 0.4, 0.2]).pbr(roughness: 0.7))
    ).write(o0)
  `)
  assert.strictEqual(ir.nodes.length, 1, 'one volume node')
  const node = ir.nodes[0]
  assert.strictEqual(node.type, 'volume', 'node type')
  assert.strictEqual(node.surface, 'vol3', 'vol surface name')
  assert.strictEqual(node.threshold, 0.25, 'threshold keyword')
  assert.strictEqual(node.id, 'cloud', 'id keyword')
  assert.deepStrictEqual(node.transform.position, [0, 1, 0], 'pos keyword')
  assert.deepStrictEqual(node.transform.rotation, [0, 45, 0], 'rot keyword')
  assert.deepStrictEqual(node.transform.scale, [2, 2, 2], 'scale keyword')
  assert.strictEqual(node.parent, null, 'root-level volume')
  assert.deepStrictEqual(node.children, [], 'volumes have no children')
  assert.strictEqual(typeof node.material, 'string', 'material interned by key')
  const mat = ir.materials[node.material]
  assert.deepStrictEqual(mat.baseColor, [0.9, 0.4, 0.2], 'solid() colour')
  assert.strictEqual(mat.pbr.roughness, 0.7, 'pbr() roughness')
}

// threshold defaults to 0.5 — the iso level render3d uses — and a volume
// without a material leaves the key unset, exactly as a mesh does.
{
  const ir = irFor('search synth\nscene(camera(fov: 60), volume(vol0)).write(o0)')
  assert.strictEqual(ir.nodes[0].threshold, 0.5, 'default iso level')
  assert.strictEqual(ir.nodes[0].material, undefined, 'no material key')
  assert.deepStrictEqual(ir.nodes[0].transform, {}, 'no transform keywords')
}

// mode picks the marching algorithm. "smooth" is the trilinear isosurface every
// volume() has rendered since the node existed; "voxel" is render3d's other
// branch — a 3D-DDA walk of the atlas grid that stops at the first cell over
// the threshold and shades its face. The default is the old behaviour, so no
// existing program changes meaning.
{
  const implicit = irFor('search synth\nscene(camera(fov: 60), volume(vol0)).write(o0)')
  assert.strictEqual(implicit.nodes[0].mode, 'smooth', 'mode defaults to the isosurface')

  const explicit = irFor('search synth\nscene(camera(fov: 60), volume(vol0, mode: "smooth")).write(o0)')
  assert.strictEqual(explicit.nodes[0].mode, 'smooth', 'mode: "smooth" is spelled out and accepted')

  const voxel = irFor('search synth\nscene(camera(fov: 60), volume(vol0, mode: "voxel")).write(o0)')
  assert.strictEqual(voxel.nodes[0].mode, 'voxel', 'mode: "voxel" reaches the IR')
  assert.strictEqual(voxel.nodes[0].threshold, 0.5, 'voxel mode still carries the threshold')
}

// A volume nests in a group and inherits the group's material, like a mesh.
{
  const ir = irFor(`
    search synth
    scene(
      camera(fov: 60),
      group(id: "rig", pos: [1, 0, 0],
        volume(vol1, threshold: 0.75)
      ).material(solid(color: [0, 1, 0]))
    ).write(o0)
  `)
  const group = ir.nodes.find(n => n.type === 'group')
  const volume = ir.nodes.find(n => n.type === 'volume')
  assert.ok(group && volume, 'both nodes present')
  assert.strictEqual(volume.parent, ir.nodes.indexOf(group), 'volume parented to the group')
  assert.deepStrictEqual(group.children, [ir.nodes.indexOf(volume)], 'group lists the volume')
  assert.strictEqual(volume.material, group.material, 'material inherited from the group')
}

// osc() in a volume transform is canonicalized the same way as on a mesh, so
// the bindings walker finds it.
{
  const ir = irFor(`
    search synth
    scene(camera(fov: 60), volume(vol0, rot: [0, osc(type: oscKind.saw), 0])).write(o0)
  `)
  const rot = ir.nodes[0].transform.rotation
  assert.strictEqual(rot[1].type, 'Oscillator', 'osc() descriptor preserved')
  assert.strictEqual(rot[0], 0, 'literal components untouched')
}

// Diagnostics: every rejection names volume() and carries a real position.
{
  const cases = [
    ['missing positional', 'scene(camera(fov: 60), volume()).write(o0)',
      /volume\(\) expects a volume reference \(vol0..vol7\)/],
    ['surface positional', 'scene(camera(fov: 60), volume(o2)).write(o0)',
      /volume\(\) expects a volume reference \(vol0..vol7\)/],
    ['string positional', 'scene(camera(fov: 60), volume("vol0")).write(o0)',
      /volume\(\) expects a volume reference \(vol0..vol7\)/],
    // The lexer accepts any vol<digits>; only vol0..vol7 are allocated.
    ['out of range', 'scene(camera(fov: 60), volume(vol9)).write(o0)',
      /volume\(\) expects a volume reference \(vol0..vol7\)/],
    ['second positional', 'scene(camera(fov: 60), volume(vol0, vol1)).write(o0)',
      /volume\(\) takes one positional argument, the volume reference/],
    ['unknown keyword', 'scene(camera(fov: 60), volume(vol0, thresholdd: 0.5)).write(o0)',
      /Unknown keyword 'thresholdd' for volume\(\)/],
    ['threshold type', 'scene(camera(fov: 60), volume(vol0, threshold: "half")).write(o0)',
      /threshold must be a finite number/],
    ['threshold range', 'scene(camera(fov: 60), volume(vol0, threshold: 1.5)).write(o0)',
      /threshold must be between 0 and 1/],
    // mode is a closed set, named in the message. Without the check a typo
    // fell through to the default and the node rendered smooth in silence.
    ['unknown mode', 'scene(camera(fov: 60), volume(vol0, mode: "blocky")).write(o0)',
      /Unknown volume mode 'blocky' \(expected: smooth, voxel\)/],
    ['mode is not a string', 'scene(camera(fov: 60), volume(vol0, mode: 1)).write(o0)',
      /Unknown volume mode '1' \(expected: smooth, voxel\)/],
    ['bad transform', 'scene(camera(fov: 60), volume(vol0, pos: [0, 1])).write(o0)',
      /pos must contain exactly 3 values/],
    ['surface material', 'scene(camera(fov: 60), volume(vol0).material(surface(o2))).write(o0)',
      /volume\(\) cannot take a surface\(\) material/],
    // Inheriting one is the same mistake, reported at the volume that would
    // have been textured rather than at the group that declares the material.
    ['inherited surface material',
      'scene(camera(fov: 60), group(volume(vol0)).material(surface(o2))).write(o0)',
      /volume\(\) cannot take a surface\(\) material/]
  ]
  for (const [label, body, messagePattern] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${body}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `${label}: expected a compile error`)
    assert.match(thrown.message, messagePattern, `${label}: unexpected message`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `${label}: expected a real source position, got "${thrown.message}"`)
  }
}

// ---------------------------------------------------------------------------
// A reference-valued keyword still anchors to a real source position.
//
// VolRef/OutputRef/GeoRef/MeshRef carry no `loc` of their own, so every error
// that anchored to a keyword's VALUE — rather than to the call containing it —
// reported "line 0 col 0". `volume(vol0, geo: geo0)` and its siblings across
// mesh(), camera(), group(), scene(), environment() and surface() all landed
// there, telling the author nothing about where to look.
// ---------------------------------------------------------------------------
{
  const cases = [
    // volume()
    ['volume unknown ref keyword', 'scene(camera(fov: 60), volume(vol0, geo: geo0)).write(o0)'],
    ['volume threshold is a ref', 'scene(camera(fov: 60), volume(vol0, threshold: o2)).write(o0)'],
    ['volume pos is a ref', 'scene(camera(fov: 60), volume(vol0, pos: o2)).write(o0)'],
    ['volume pos holds a ref', 'scene(camera(fov: 60), volume(vol0, pos: [o2, 0, 0])).write(o0)'],
    ['volume id is a ref', 'scene(camera(fov: 60), volume(vol0, id: o2)).write(o0)'],
    ['volume mode is a ref', 'scene(camera(fov: 60), volume(vol0, mode: o2)).write(o0)'],
    // The same class at the sibling scene nodes.
    ['mesh unknown ref keyword', 'scene(camera(fov: 60), mesh("box", geo: geo0)).write(o0)'],
    ['camera unknown ref keyword', 'scene(camera(fov: 60, geo: geo0)).write(o0)'],
    ['group unknown ref keyword', 'scene(camera(fov: 60), group(geo: geo0, mesh("box"))).write(o0)'],
    ['scene unknown ref keyword', 'scene(geo: geo0, camera(fov: 60)).write(o0)'],
    ['environment takes a vol ref', 'scene(camera(fov: 60), environment(vol0)).write(o0)'],
    ['surface takes a vol ref', 'scene(camera(fov: 60), mesh("box").material(surface(vol0))).write(o0)'],
    ['mesh type is a ref', 'scene(camera(fov: 60), mesh(o2)).write(o0)'],
  ]
  for (const [label, body] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${body}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `${label}: expected a compile error`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `${label}: expected a real source position, got "${thrown.message}"`)
  }
}

// ---------------------------------------------------------------------------
// reflector() names the constraint it actually enforces.
//
// A volume or a group is not "not a plane mesh" — it is a node kind reflector()
// does not apply to at all, and saying "requires a plane mesh" sent authors off
// hunting for a mesh type keyword that was never the problem.
// ---------------------------------------------------------------------------
{
  const cases = [
    ['volume', 'scene(camera(fov: 60), volume(vol0).reflector()).write(o0)'],
    ['group', 'scene(camera(fov: 60), group(mesh("box")).reflector()).write(o0)'],
  ]
  for (const [kind, body] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${body}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `${kind} reflector: expected a compile error`)
    assert.match(thrown.message, new RegExp(`reflector\\(\\) is not supported on ${kind}\\(\\)`),
      `${kind} reflector: expected the node kind to be named, got "${thrown.message}"`)
    assert.doesNotMatch(thrown.message, /requires a plane mesh/,
      `${kind} reflector: names a constraint that is not the one being enforced`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `${kind} reflector: expected a real source position, got "${thrown.message}"`)
  }
  // A non-plane mesh is still the plane constraint, unchanged.
  assert.throws(() => irFor('search synth\nscene(mesh("sphere").reflector()).write(o0)'),
    /reflector\(\) requires a plane mesh.*line/s, 'non-plane mesh keeps the plane diagnostic')
}

// ---------------------------------------------------------------------------
// An unrecognized chain link is an error, not a silent no-op.
//
// walkNode filtered links down to material() and reflector() and dropped the
// rest, so `mesh("sphere").pos([0, 0, -4])` compiled clean and did nothing —
// the mesh sat at the origin with no diagnostic to explain it.
// ---------------------------------------------------------------------------
{
  const cases = [
    ['volume', 'scene(camera(fov: 60), volume(vol0).frobnicate()).write(o0)', /frobnicate/],
    ['mesh', 'scene(camera(fov: 60), mesh("sphere").pos([0, 0, -4])).write(o0)', /pos/],
    ['group', 'scene(camera(fov: 60), group(mesh("box")).scale([2, 2, 2])).write(o0)', /scale/],
  ]
  for (const [kind, body, namePattern] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${body}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `${kind} unknown link: expected a compile error`)
    assert.match(thrown.message, namePattern, `${kind} unknown link: names the link`)
    assert.match(thrown.message, new RegExp(`${kind}\\(\\)`),
      `${kind} unknown link: names the node kind, got "${thrown.message}"`)
    assert.match(thrown.message, /material\(\).*reflector\(\)/,
      `${kind} unknown link: states which links are allowed, got "${thrown.message}"`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `${kind} unknown link: expected a real source position, got "${thrown.message}"`)
  }

  // Control: the two supported links still compile.
  const ok = irFor(`
    search synth
    scene(
      camera(fov: 60),
      volume(vol0).material(solid(color: [1, 0, 0])),
      mesh("plane", id: "floor").material(solid(color: [0, 1, 0])).reflector()
    ).write(o0)
  `)
  const volume = ok.nodes.find(n => n.type === 'volume')
  const floor = ok.nodes.find(n => n.id === 'floor')
  assert.deepStrictEqual(ok.materials[volume.material].baseColor, [1, 0, 0], 'volume material still chains')
  assert.deepStrictEqual(ok.materials[floor.material].baseColor, [0, 1, 0], 'mesh material still chains')
  assert.strictEqual(floor.planarReflection, true, 'reflector() still chains alongside material()')
}

console.log('Scene compiler tests passed')
