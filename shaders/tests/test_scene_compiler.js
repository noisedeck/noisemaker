// shaders/tests/test_scene_compiler.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { compile } from '../src/lang/index.js'
import { registerStarterOps } from '../src/lang/validator.js'
import { registerOp } from '../src/lang/ops.js'
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

// ---------------------------------------------------------------------------
// midi() and audio() are accepted exactly where osc() is, and canonicalize to
// the same descriptors the 2D uniform path produces. A scene that could only
// be driven by a built-in waveform could not be played; the three descriptor
// kinds are one feature, not three.
// ---------------------------------------------------------------------------

// midi() in a transform compiles to the canonical MIDI descriptor.
{
  const ir = irFor(`
    search synth
    scene(
      group(rot: [0, midi(channel: 3, mode: midiMode.gateVelocity, min: 0.25, max: 0.75, sensitivity: 2), 0])
    ).write(o0)
  `)
  assert.deepStrictEqual(ir.nodes[0].transform.rotation[1], {
    type: 'Midi',
    channel: 3,
    mode: 2,
    min: 0.25,
    max: 0.75,
    sensitivity: 2
  }, 'midi() compiles to the canonical automation descriptor')
}

// midi() defaults match the 2D path: velocity mode, full [0, 1] range,
// sensitivity 1. A descriptor that meant something different in a scene than
// in an effect would make the same call two different features.
{
  const ir = irFor(`
    search synth
    scene(group(pos: [midi(1), 0, 0])).write(o0)
  `)
  assert.deepStrictEqual(ir.nodes[0].transform.position[0], {
    type: 'Midi', channel: 1, mode: 4, min: 0, max: 1, sensitivity: 1
  }, 'midi() defaults match the effect-uniform defaults')
}

// audio() in a transform compiles to the canonical audio descriptor.
//
// min/max are a normalized [0, 1] sub-range. This used to write `max: 2` and
// pin the silent clamp to 1; a scene now rejects the out-of-range value
// instead (see the sub-range block near the end of this file), so the shape is
// pinned with an in-range sub-range.
{
  const ir = irFor(`
    search synth
    scene(
      mesh("box", scale: [audio(band: audioBand.low, min: 0.5, max: 0.9), 1, 1])
    ).write(o0)
  `)
  assert.deepStrictEqual(ir.nodes[0].transform.scale[0], {
    type: 'Audio', band: 0, min: 0.5, max: 0.9
  }, 'audio() compiles to the canonical descriptor with its [0, 1] sub-range')
}

// audio() defaults match the 2D path.
{
  const ir = irFor(`
    search synth
    scene(mesh("box", pos: [0, audio(audioBand.vol), 0])).write(o0)
  `)
  assert.deepStrictEqual(ir.nodes[0].transform.position[1], {
    type: 'Audio', band: 3, min: 0, max: 1
  }, 'audio() defaults match the effect-uniform defaults')
}

// Light intensity takes all three descriptor kinds, not just osc().
{
  const ir = irFor(`
    search synth
    scene(
      light(type: "point", pos: [0, 4, 0], intensity: midi(channel: 2)),
      light(type: "directional", dir: [1, -1, 0], intensity: audio(audioBand.high)),
      mesh("box")
    ).write(o0)
  `)
  assert.strictEqual(ir.lights[0].intensity.type, 'Midi', 'midi() reaches light intensity')
  assert.strictEqual(ir.lights[0].intensity.channel, 2, 'midi channel retained on light intensity')
  assert.strictEqual(ir.lights[1].intensity.type, 'Audio', 'audio() reaches light intensity')
  assert.strictEqual(ir.lights[1].intensity.band, 2, 'audio band retained on light intensity')
}

// A volume transform takes them too — a volume node animates like a mesh.
{
  const ir = irFor(`
    search synth
    scene(camera(fov: 60), volume(vol0, rot: [0, midi(4), 0], scale: [audio(audioBand.mid), 1, 1])).write(o0)
  `)
  const node = ir.nodes[0]
  assert.strictEqual(node.transform.rotation[1].type, 'Midi', 'midi() descriptor preserved on a volume')
  assert.strictEqual(node.transform.scale[0].type, 'Audio', 'audio() descriptor preserved on a volume')
}

// Hand-authored descriptor-shaped objects are rejected for all three kinds.
{
  for (const [label, literal, expected] of [
    ['Midi', '{ type: "Midi", channel: 1 }', /use midi\(\)/i],
    ['Audio', '{ type: "Audio", band: 0 }', /use audio\(\)/i]
  ]) {
    assert.throws(
      () => irFor(`search synth\nscene(group(rot: [0, ${literal}, 0])).write(o0)`),
      expected,
      `hallucinated ${label} object syntax is rejected`
    )
  }
}

// Symmetry: wherever osc() is rejected, midi() and audio() are rejected the
// same way. Accepting one descriptor kind on a channel that cannot animate
// would put a descriptor object where a number is read.
{
  const cases = [
    ['camera pos',    'scene(camera(pos: [midi(1), 0, 5])).write(o0)'],
    ['camera target', 'scene(camera(target: [0, audio(audioBand.low), 0])).write(o0)'],
    ['light pos',     'scene(camera(fov: 60), light(type: "point", pos: [midi(1), 2, 0])).write(o0)'],
    ['light dir',     'scene(camera(fov: 60), light(type: "directional", dir: [audio(audioBand.low), -1, 0])).write(o0)'],
    ['light color',   'scene(camera(fov: 60), light(type: "point", color: [midi(1), 1, 1])).write(o0)'],
    ['mesh param',    'scene(camera(fov: 60), mesh("sphere", radius: midi(1))).write(o0)'],
    ['mesh param a',  'scene(camera(fov: 60), mesh("sphere", radius: audio(audioBand.low))).write(o0)'],
    ['volume threshold', 'scene(camera(fov: 60), volume(vol0, threshold: midi(1))).write(o0)'],
    ['volume thresh a',  'scene(camera(fov: 60), volume(vol0, threshold: audio(audioBand.low))).write(o0)']
  ]
  for (const [label, body] of cases) {
    assert.throws(() => irFor('search synth\n' + body),
      /must contain finite numbers|must be|midi|audio/i,
      `${label}: expected a compile error rather than a descriptor reaching the GPU`)
  }
}

// Symmetry stated as an invariant rather than as a list: on any channel, the
// three descriptor kinds are accepted together or rejected together. Written
// this way it stays true if a channel's verdict later changes — what it forbids
// is one kind diverging from the others.
{
  const channels = [
    ['camera pos',       'scene(camera(pos: [DESC, 0, 5])).write(o0)'],
    ['light dir',        'scene(camera(fov: 60), light(type: "directional", dir: [DESC, -1, 0])).write(o0)'],
    ['light intensity',  'scene(camera(fov: 60), light(type: "point", intensity: DESC), mesh("box")).write(o0)'],
    ['mesh pos',         'scene(camera(fov: 60), mesh("box", pos: [DESC, 0, 0])).write(o0)'],
    ['group rot',        'scene(camera(fov: 60), group(rot: [0, DESC, 0], mesh("box"))).write(o0)'],
    ['volume scale',     'scene(camera(fov: 60), volume(vol0, scale: [DESC, 1, 1])).write(o0)'],
    ['volume threshold', 'scene(camera(fov: 60), volume(vol0, threshold: DESC)).write(o0)'],
    ['mesh radius',      'scene(camera(fov: 60), mesh("sphere", radius: DESC)).write(o0)'],
    ['scene setting',    'scene(ambient: DESC, mesh("box")).write(o0)']
  ]
  const kinds = ['osc(oscKind.saw)', 'midi(1)', 'audio(audioBand.low)']
  const rejects = (body, desc) => {
    try {
      irFor('search synth\n' + body.replace('DESC', desc))
      return false
    } catch {
      return true
    }
  }
  for (const [label, body] of channels) {
    const verdicts = kinds.map(kind => rejects(body, kind))
    assert.ok(
      verdicts.every(v => v === verdicts[0]),
      `${label}: osc/midi/audio must be accepted or rejected together, got ` +
      kinds.map((k, i) => `${k}=${verdicts[i] ? 'rejected' : 'accepted'}`).join(', ')
    )
  }
}

// A let-bound midi()/audio() resolves inside a scene transform just as a
// let-bound osc() does.
{
  const ir = irFor(`
    search synth
    let pulse = midi(channel: 5, mode: midiMode.triggerNote)
    let bass = audio(audioBand.low)
    scene(
      group(rot: [0, pulse, 0], scale: [bass, 1, 1])
    ).write(o0)
  `)
  assert.strictEqual(ir.nodes[0].transform.rotation[1].type, 'Midi', 'let-bound midi() is resolved')
  assert.strictEqual(ir.nodes[0].transform.rotation[1].channel, 5, 'midi channel is retained')
  assert.strictEqual(ir.nodes[0].transform.rotation[1].mode, 3, 'midiMode.triggerNote is retained')
  assert.strictEqual(ir.nodes[0].transform.scale[0].type, 'Audio', 'let-bound audio() is resolved')
  assert.strictEqual(ir.nodes[0].transform.scale[0].band, 0, 'audioBand.low is retained')
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

// ---------------------------------------------------------------------------
// Cross-system oracle: one descriptor, one meaning.
//
// osc()/midi()/audio() are read twice by two different modules — lang/validator
// canonicalizes them for effect uniforms, rendering/scene-compiler for scene
// transforms. Every assertion above pins ONE of those readings, so the two
// drifted apart in both directions without a single test going red: the scene
// side accepted a bare number for an enum argument and the 2D side silently
// dropped it (audio(2) rendered band 0), while the 2D side resolved a bare
// identifier and the scene side threw.
//
// This compiles the SAME descriptor text down both paths and compares the
// canonical objects field by field. It is the invariant the two readings owe
// each other, not a restatement of either one's rules.
// ---------------------------------------------------------------------------
{
  // A minimal float parameter to hang a descriptor off, so the effect side of
  // the oracle does not depend on any real effect's argument spec.
  registerOp('synth.descprobe', {
    name: 'descprobe',
    args: [{ name: 'scale', type: 'float', default: 1, min: 0, max: 1000 }]
  })
  registerStarterOps(['synth.descprobe'])

  // The canonical descriptor fields each kind is compared on. `_ast` and
  // `_varRef` are unparser bookkeeping the 2D path carries and the scene path
  // does not; they are not part of what the descriptor MEANS.
  const DESCRIPTOR_FIELDS = {
    Oscillator: ['type', 'oscType', 'min', 'max', 'speed', 'offset', 'seed'],
    Midi: ['type', 'channel', 'mode', 'min', 'max', 'sensitivity'],
    Audio: ['type', 'band', 'min', 'max']
  }

  const canonical = (value) => {
    if (!value || typeof value !== 'object') return value
    const fields = DESCRIPTOR_FIELDS[value.type]
    if (!fields) return value
    const out = {}
    for (const field of fields) out[field] = value[field]
    return out
  }

  // The descriptor as an effect uniform, through lang/validator.
  const asEffectUniform = (desc) => {
    const result = compile(`search synth\ndescprobe(scale: ${desc}).write(o0)`)
    const errors = (result.diagnostics || []).filter(d => d.severity === 'error')
    assert.strictEqual(errors.length, 0,
      `${desc}: effect-uniform path reported ${errors.map(e => e.message).join('; ')}`)
    return canonical(result.plans[0].chain[0].args.scale)
  }

  // The same descriptor in a scene transform, through rendering/scene-compiler.
  const asSceneTransform = (desc) => {
    const ir = irFor(`search synth\nscene(camera(fov: 60), group(rot: [0, ${desc}, 0])).write(o0)`)
    return canonical(ir.nodes[0].transform.rotation[1])
  }

  // number x member x ident, over the enum argument of each descriptor kind.
  // `osc(2)` and `osc(saw)` are deliberately absent: the parser only treats an
  // osc() call as a value oscillator when its first argument is an oscKind
  // member or `type:` is written as a keyword, so those two spellings are the
  // synth.osc GENERATOR and never reach either canonicalizer.
  const matrix = [
    ['osc type number',   'osc(type: 2)',                   { type: 'Oscillator', oscType: 2 }],
    ['osc type member',   'osc(type: oscKind.saw)',         { type: 'Oscillator', oscType: 2 }],
    ['osc type ident',    'osc(type: saw)',                 { type: 'Oscillator', oscType: 2 }],
    ['midi mode number',  'midi(1, 2)',                     { type: 'Midi', mode: 2 }],
    ['midi mode member',  'midi(1, midiMode.gateVelocity)', { type: 'Midi', mode: 2 }],
    ['midi mode ident',   'midi(1, gateVelocity)',          { type: 'Midi', mode: 2 }],
    ['midi mode kwarg n', 'midi(channel: 1, mode: 2)',      { type: 'Midi', mode: 2 }],
    ['audio band number', 'audio(2)',                       { type: 'Audio', band: 2 }],
    ['audio band member', 'audio(audioBand.high)',          { type: 'Audio', band: 2 }],
    ['audio band ident',  'audio(high)',                    { type: 'Audio', band: 2 }],
    ['audio band kwarg n', 'audio(band: 2)',                { type: 'Audio', band: 2 }]
  ]

  for (const [label, desc, expected] of matrix) {
    const effect = asEffectUniform(desc)
    const scene = asSceneTransform(desc)
    assert.deepStrictEqual(scene, effect,
      `${label}: '${desc}' must canonicalize identically in a scene transform and an ` +
      `effect uniform; effect=${JSON.stringify(effect)} scene=${JSON.stringify(scene)}`)
    // Both agreeing on the WRONG value would still be a silent drop, so the
    // intended enum value is pinned too.
    for (const [field, want] of Object.entries(expected)) {
      assert.strictEqual(effect[field], want,
        `${label}: '${desc}' must honour the written enum (${field})`)
    }
  }

  // Defaults still apply when the enum argument is omitted, on both paths.
  assert.strictEqual(asEffectUniform('midi(1)').mode, 4, 'midi() default mode, effect path')
  assert.strictEqual(asSceneTransform('midi(1)').mode, 4, 'midi() default mode, scene path')
}


// A positional that is not a node chain is a compile error, not a silent drop.
//
// scene() and group() take their children positionally, so anything else
// written there names no node. Dropping it in silence is the same failure mode
// the keyword whitelists above exist to prevent: `scene(0.15, camera())` is a
// setting the author forgot to name, and it compiled clean and did nothing.
{
  assert.throws(() => irFor(`
    search synth
    scene(0.15, camera()).write(o0)
  `), /Unknown scene child '0\.15'.*node chains as positional arguments.*line/s,
    'bare positional in scene() rejected')

  assert.throws(() => irFor(`
    search synth
    scene("ambient", mesh("box")).write(o0)
  `), /Unknown scene child '"ambient"'.*settings as keyword arguments.*line/s,
    'string positional in scene() rejected')

  // A scene child written inside a group() is not one of the three node kinds a
  // group nests, so it named nothing and vanished: the light simply never lit.
  assert.throws(() => irFor(`
    search synth
    scene(group(light(type: "point", pos: [1, 1, 1]), mesh("box"))).write(o0)
  `), /Unknown group\(\) child 'light\(\)'.*belongs at scene\(\) level.*line/s, 'light inside a group rejected')

  assert.throws(() => irFor(`
    search synth
    scene(group(camera(fov: 30), mesh("box"))).write(o0)
  `), /Unknown group\(\) child 'camera\(\)'.*belongs at scene\(\) level.*line/s, 'camera inside a group rejected')

  assert.throws(() => irFor(`
    search synth
    scene(group("oops", mesh("box"))).write(o0)
  `), /Unknown group\(\) child '"oops"'.*accepts only mesh\(\), volume\(\), group\(\) children.*line/s,
    'bare positional in group() rejected')

  // A loc-less positional (a surface reference) anchors to the group instead
  // of reporting line 0 col 0.
  assert.throws(() => irFor(`
    search synth
    scene(group(o1, mesh("box"))).write(o0)
  `), /Unknown group\(\) child 'o1'.*at line 3 col (?!0\b)\d+/s, 'loc-less group positional is located')

  // The shapes that were always legal stay legal.
  const ir = irFor(`
    search synth
    scene(
      ambient: 0.2,
      camera(fov: 50),
      light(type: "point"),
      environment(o1),
      group(id: "g", mesh("box"), group(mesh("sphere")), volume(vol0)),
      mesh("plane")
    ).write(o0)
  `)
  assert.strictEqual(ir.nodes.length, 6, 'every legal child still compiles')
  assert.strictEqual(ir.lights.length, 1, 'top-level light still compiles')
  assert.strictEqual(ir.environment.surface, 'o1', 'environment still compiles')
}


// A descriptor's min/max is a NORMALIZED sub-range, and a scene says so.
//
// clampPercentage folded anything outside [0, 1] onto the edge in silence, so
// `rot: [0, osc(min: 90, max: 270), 0]` became min 1 / max 1 and the node sat
// frozen at 360 degrees with nothing reported. The effect-uniform path keeps
// clamping — that is its documented leniency; a scene is strict, as it is about
// every other out-of-range value.
{
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box", rot: [0, osc(type: oscKind.saw, min: 90, max: 270), 0])).write(o0)
  `), /osc\(\) min must be between 0 and 1.*normalized.*line/s, 'osc() min above 1 rejected')

  assert.throws(() => irFor(`
    search synth
    scene(mesh("box", rot: [0, osc(type: oscKind.saw, min: -1), 0])).write(o0)
  `), /osc\(\) min must be between 0 and 1.*line/s, 'osc() min below 0 rejected')

  assert.throws(() => irFor(`
    search synth
    scene(mesh("box", scale: [audio(band: audioBand.low, min: 1, max: 3), 1, 1])).write(o0)
  `), /audio\(\) max must be between 0 and 1.*line/s, 'audio() max above 1 rejected')

  assert.throws(() => irFor(`
    search synth
    scene(light(type: "point", intensity: midi(channel: 1, min: 0, max: 2))).write(o0)
  `), /midi\(\) max must be between 0 and 1.*line/s, 'midi() max above 1 rejected')

  // In range is untouched, edges included.
  const ir = irFor(`
    search synth
    scene(mesh("box", rot: [0, osc(type: oscKind.saw, min: 0, max: 1), 0])).write(o0)
  `)
  assert.strictEqual(ir.nodes[0].transform.rotation[1].min, 0, 'min 0 accepted')
  assert.strictEqual(ir.nodes[0].transform.rotation[1].max, 1, 'max 1 accepted')

  // The effect-uniform path is untouched: it still clamps rather than throwing.
  const uniform = compile(`
    search synth
    descprobe(scale: osc(type: oscKind.saw, min: 90, max: 270)).write(o0)
  `).plans[0].chain.find(step => step.op === 'synth.descprobe').args.scale
  assert.strictEqual(uniform.min, 1, 'effect uniform still clamps min')
  assert.strictEqual(uniform.max, 1, 'effect uniform still clamps max')
}

// A descriptor written where only a plain number is read names that fact.
//
// Camera and light vectors are read by vectorKw, whose "must contain finite
// numbers" sent authors looking for a typo in a perfectly well-formed osc().
// Only a node's pos/rot/scale and a light's intensity animate.
{
  assert.throws(() => irFor(`
    search synth
    scene(camera(pos: [osc(type: oscKind.sine), 0, 5])).write(o0)
  `), /camera\(\) pos does not accept osc\(\), midi\(\) or audio\(\).*line/s,
    'camera pos descriptor names the real problem')

  assert.throws(() => irFor(`
    search synth
    scene(camera(target: [audio(band: audioBand.low), 0, 0])).write(o0)
  `), /camera\(\) target does not accept osc\(\), midi\(\) or audio\(\).*line/s,
    'camera target descriptor names the real problem')

  assert.throws(() => irFor(`
    search synth
    scene(light(type: "directional", dir: [osc(type: oscKind.sine), -1, 0])).write(o0)
  `), /light\(\) dir does not accept osc\(\), midi\(\) or audio\(\).*line/s,
    'light dir descriptor names the real problem')

  assert.throws(() => irFor(`
    search synth
    scene(light(type: "point", pos: [midi(channel: 1), 0, 0])).write(o0)
  `), /light\(\) pos does not accept osc\(\), midi\(\) or audio\(\).*line/s,
    'light pos descriptor names the real problem')

  // A genuinely malformed vector still gets the arity/finiteness message.
  assert.throws(() => irFor(`
    search synth
    scene(camera(pos: [0, "x", 5])).write(o0)
  `), /pos must contain finite numbers.*line/s, 'non-descriptor junk keeps its own message')

  // buildTransform's message, which lists the descriptors as ACCEPTED, is
  // unchanged.
  assert.throws(() => irFor(`
    search synth
    scene(mesh("box", pos: [0, "x", 0])).write(o0)
  `), /pos values must be finite numbers or osc\(\), midi\(\) or audio\(\).*line/s,
    'node transform message is unchanged')
}

// Every "Unknown X" names the legal values.
//
// volume()'s messages listed their sets — `(vol0..vol7)`, `(expected: smooth,
// voxel)` — while the light type, the mesh type and every unknown-keyword
// error named only the thing that was wrong. A newcomer typo is the exact case
// these fire on, and the set is what the author needs to see.
{
  const cases = [
    ['light type', 'scene(light(type: "sun")).write(o0)',
      /Unknown light type 'sun' \(expected: directional, point, spot\).*line/s],
    ['mesh type', 'scene(mesh("cone")).write(o0)',
      /Unknown mesh type 'cone' \(expected: sphere, box, plane, cylinder, torus\).*line/s],
    ['camera keyword', 'scene(camera(fow: 60)).write(o0)',
      /Unknown keyword 'fow' for camera\(\) \(expected: fov, near, far, pos, target\).*line/s],
    ['scene setting', 'scene(ambiant: 0.2, mesh("box")).write(o0)',
      /Unknown keyword 'ambiant' for scene\(\) \(expected: ambient, background, exposure, ground, sky, reflections, reflectionProbe, reflectionProbeSize, ssao, ssaoRadius\).*line/s],
    ['group keyword', 'scene(group(position: [0,1,0], mesh("box"))).write(o0)',
      /Unknown keyword 'position' for group\(\) \(expected: id, pos, rot, scale\).*line/s],
    ['volume keyword', 'scene(volume(vol0, thresholdd: 0.5)).write(o0)',
      /Unknown keyword 'thresholdd' for volume\(\) \(expected: id, pos, rot, scale, threshold, mode\).*line/s],
    ['directional light keyword', 'scene(light(pos: [0,1,0])).write(o0)',
      /Unknown keyword 'pos' for light\(\) \(expected: type, color, intensity, dir\).*line/s],
    ['spot light keyword', 'scene(light(type: "spot", falof: 1)).write(o0)',
      /Unknown keyword 'falof' for light\(\) \(expected: type, color, intensity, pos, falloff, dir, angle, penumbra\).*line/s],
    ['environment keyword', 'scene(environment(o1, strength: 1)).write(o0)',
      /Unknown keyword 'strength' for environment\(\) \(expected: intensity\).*line/s],
    ['mesh shape keyword', 'scene(mesh("sphere", tube: 1)).write(o0)',
      /Unknown keyword 'tube' for mesh\("sphere"\) \(expected: id, pos, rot, scale, radius, segments\).*line/s],
    ['solid keyword', 'scene(mesh("box").material(solid(colour: [1,0,0]))).write(o0)',
      /Unknown keyword 'colour' for solid\(\) \(expected: color\).*line/s],
    ['surface keyword', 'scene(mesh("box").material(surface(o1, tile: 2))).write(o0)',
      /Unknown keyword 'tile' for surface\(\) \(expected: tint, uvScale, uvOffset\).*line/s],
    ['pbr keyword', 'scene(mesh("box").material(solid().pbr(rough: 1))).write(o0)',
      /Unknown keyword 'rough' for pbr\(\) \(expected: metallic, roughness\).*line/s],
    ['emit keyword', 'scene(mesh("box").material(solid().emit(power: 1))).write(o0)',
      /Unknown keyword 'power' for emit\(\) \(expected: strength\).*line/s]
  ]
  for (const [label, program, pattern] of cases) {
    assert.throws(() => irFor(`search synth\n${program}`), pattern,
      `${label}: the diagnostic must enumerate the legal values`)
  }
}

// ---------------------------------------------------------------------------
// Every scene() setting is validated before it is stored.
//
// The settings loop called litValue and assigned, so whatever the author wrote
// travelled straight into the IR and out to the renderer's uniforms:
// `exposure: "bright"` was handed to u_exposure as a string, `ssaoRadius: 0`
// collapsed the sampling kernel onto the shaded point so nothing ever occluded,
// and a negative `ambient` drove the hemisphere terms below zero. scene.rst has
// always said these take "plain numbers or vectors".
// ---------------------------------------------------------------------------
{
  const cases = [
    ['ambient type', 'scene(ambient: "dim", mesh("box")).write(o0)',
      /ambient must be a finite number/],
    ['ambient range', 'scene(ambient: -0.5, mesh("box")).write(o0)',
      /ambient must be non-negative/],
    ['exposure type', 'scene(exposure: [1, 2, 3], mesh("box")).write(o0)',
      /exposure must be a finite number/],
    ['exposure range', 'scene(exposure: -1, mesh("box")).write(o0)',
      /exposure must be non-negative/],
    ['ssao type', 'scene(ssao: "on", mesh("box")).write(o0)',
      /ssao must be a finite number/],
    ['ssao range', 'scene(ssao: -1, mesh("box")).write(o0)',
      /ssao must be non-negative/],
    // Zero is not "off" here the way it is for ssao: it is a kernel with no
    // extent, which reads the shaded point itself for every sample.
    ['ssaoRadius zero', 'scene(ssaoRadius: 0, mesh("box")).write(o0)',
      /ssaoRadius must be greater than zero/],
    ['ssaoRadius range', 'scene(ssaoRadius: -0.5, mesh("box")).write(o0)',
      /ssaoRadius must be greater than zero/],
    ['reflections type', 'scene(reflections: "yes", mesh("box")).write(o0)',
      /reflections must be a finite number/],
    ['reflections range', 'scene(reflections: -1, mesh("box")).write(o0)',
      /reflections must be non-negative/],
    ['sky arity', 'scene(sky: [0.4, 0.6], mesh("box")).write(o0)',
      /sky must contain exactly 3 values/],
    ['sky components', 'scene(sky: [0.4, "blue", 1], mesh("box")).write(o0)',
      /sky must contain finite numbers/],
    ['sky range', 'scene(sky: [-0.4, 0.6, 1], mesh("box")).write(o0)',
      /sky values must be non-negative/],
    ['ground arity', 'scene(ground: [0.3], mesh("box")).write(o0)',
      /ground must contain exactly 3 values/],
    ['ground range', 'scene(ground: [0.3, -0.25, 0.2], mesh("box")).write(o0)',
      /ground values must be non-negative/],
    ['background arity', 'scene(background: [0, 0, 0, 1], mesh("box")).write(o0)',
      /background must contain exactly 3 values/],
    ['background range', 'scene(background: [0, 0, -0.1], mesh("box")).write(o0)',
      /background values must be non-negative/]
  ]
  for (const [label, program, pattern] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${program}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `${label}: expected a compile error rather than a silent store`)
    assert.match(thrown.message, pattern, `${label}: unexpected message`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `${label}: expected a real source position, got "${thrown.message}"`)
  }

  // Zero is a legal value for every setting that gates on it, and the compiler
  // stores only what the author wrote — the renderer owns the defaults.
  const ir = irFor(`
    search synth
    scene(
      ambient: 0, exposure: 0, ssao: 0, reflections: 0, ssaoRadius: 0.0001,
      sky: [0, 0, 0], ground: [0, 0, 0], background: [0, 0, 0],
      mesh("box")
    ).write(o0)
  `)
  assert.deepStrictEqual(ir.settings, {
    ambient: 0, exposure: 0, ssao: 0, reflections: 0, ssaoRadius: 0.0001,
    sky: [0, 0, 0], ground: [0, 0, 0], background: [0, 0, 0]
  }, 'zero-valued settings are stored, and nothing else is')
}

// A descriptor in a scene() setting is named for what it is.
//
// None of the settings animates — scene.rst says so — but litValue canonicalized
// osc()/midi()/audio() and the settings loop stored the descriptor object,
// which reached the uniform upload as NaN with nothing reported.
{
  const scalars = ['ambient', 'exposure', 'ssao', 'ssaoRadius', 'reflections']
  const vectors = ['sky', 'ground', 'background']
  const kinds = ['osc(oscKind.saw)', 'midi(1)', 'audio(audioBand.low)']
  for (const kind of kinds) {
    for (const name of scalars) {
      assert.throws(
        () => irFor(`search synth\nscene(${name}: ${kind}, mesh("box")).write(o0)`),
        new RegExp(`scene\\(\\) ${name} does not accept osc\\(\\), midi\\(\\) or audio\\(\\).*line [1-9]`, 's'),
        `scene() ${name}: ${kind} must be rejected by name`)
    }
    for (const name of vectors) {
      // Written as one component of the vector...
      assert.throws(
        () => irFor(`search synth\nscene(${name}: [${kind}, 0, 0], mesh("box")).write(o0)`),
        new RegExp(`scene\\(\\) ${name} does not accept osc\\(\\), midi\\(\\) or audio\\(\\).*line [1-9]`, 's'),
        `scene() ${name}: ${kind} in a component must be rejected by name`)
      // ...and written in place of the whole vector, where "must contain
      // exactly 3 values" would have sent the author hunting for an arity.
      assert.throws(
        () => irFor(`search synth\nscene(${name}: ${kind}, mesh("box")).write(o0)`),
        new RegExp(`scene\\(\\) ${name} does not accept osc\\(\\), midi\\(\\) or audio\\(\\).*line [1-9]`, 's'),
        `scene() ${name}: a bare ${kind} must be rejected by name`)
    }
  }
}

// ---------------------------------------------------------------------------
// A light's intensity is a number or a descriptor, and nothing else.
//
// It was read bare — `kw(call, 'intensity') ?? 1` — because it is the one light
// channel bindings animate. A string or an array is not a descriptor, so
// collectBindings left it alone and _buildLightingUniforms uploaded it to a
// float uniform.
// ---------------------------------------------------------------------------
{
  const cases = [
    ['string', 'scene(light(type: "point", intensity: "bright")).write(o0)',
      /intensity must be a finite number or osc\(\), midi\(\) or audio\(\)/],
    ['array', 'scene(light(type: "directional", intensity: [1, 2, 3])).write(o0)',
      /intensity must be a finite number or osc\(\), midi\(\) or audio\(\)/],
    ['negative', 'scene(light(type: "point", intensity: -2)).write(o0)',
      /intensity must be non-negative/]
  ]
  for (const [label, program, pattern] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${program}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `light intensity ${label}: expected a compile error`)
    assert.match(thrown.message, pattern, `light intensity ${label}: unexpected message`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `light intensity ${label}: expected a real source position, got "${thrown.message}"`)
  }

  // Descriptors stay legal on this one channel: bindings.js hoists them.
  const ir = irFor(`
    search synth
    scene(
      light(type: "point", intensity: osc(type: oscKind.saw)),
      light(type: "directional", intensity: 0),
      mesh("box")
    ).write(o0)
  `)
  assert.strictEqual(ir.lights[0].intensity.type, 'Oscillator', 'osc() still reaches light intensity')
  assert.strictEqual(ir.lights[1].intensity, 0, 'an unlit light is a legal light')
}

// An environment's intensity is a plain number: nothing hoists it.
//
// It was read bare like a light's, but no binding is ever collected for it, so
// a descriptor written here sat in the IR as an object and reached
// u_envIntensity as NaN.
{
  const cases = [
    ['string', 'scene(environment(o1, intensity: "hot")).write(o0)',
      /intensity must be a finite number/],
    ['negative', 'scene(environment(o1, intensity: -1)).write(o0)',
      /intensity must be non-negative/],
    ['osc', 'scene(environment(o1, intensity: osc(oscKind.saw))).write(o0)',
      /environment\(\) intensity does not accept osc\(\), midi\(\) or audio\(\)/],
    ['midi', 'scene(environment(o1, intensity: midi(1))).write(o0)',
      /environment\(\) intensity does not accept osc\(\), midi\(\) or audio\(\)/],
    ['audio', 'scene(environment(o1, intensity: audio(audioBand.low))).write(o0)',
      /environment\(\) intensity does not accept osc\(\), midi\(\) or audio\(\)/]
  ]
  for (const [label, program, pattern] of cases) {
    let thrown = null
    try {
      irFor(`search synth\n${program}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `environment intensity ${label}: expected a compile error`)
    assert.match(thrown.message, pattern, `environment intensity ${label}: unexpected message`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `environment intensity ${label}: expected a real source position, got "${thrown.message}"`)
  }

  const ir = irFor('search synth\nscene(environment(o1, intensity: 0), mesh("box")).write(o0)')
  assert.strictEqual(ir.environment.intensity, 0, 'a dark environment is a legal environment')
}

// A second environment() is an error, anchored to the second one.
//
// The switch assigned ir.environment unconditionally, so the later call
// replaced the earlier without a word: the surface lighting the frame was not
// the one the author had wired last.
{
  let thrown = null
  try {
    irFor(`search synth
scene(
  environment(o1),
  environment(o2),
  mesh("box")
).write(o0)`)
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, 'expected a compile error for a second environment()')
  assert.match(thrown.message, /Only one environment\(\) per scene is supported/,
    `unexpected message: ${thrown.message}`)
  const at = thrown.message.match(/line (\d+) col (\d+)/)
  assert.ok(at, `expected a line/col in: ${thrown.message}`)
  assert.strictEqual(at[1], '4',
    `the diagnostic must anchor to the SECOND environment(), got "${thrown.message}"`)

  // One is still one, wherever it sits among the children.
  const ir = irFor('search synth\nscene(mesh("box"), environment(o1)).write(o0)')
  assert.strictEqual(ir.environment.surface, 'o1', 'a single environment still compiles')
}

// mesh() with no positional names the argument that is missing.
//
// The count check only fired above one, so zero fell through to litValue and
// the author was told `Unknown mesh type 'undefined'` — a type they never
// wrote, instead of the argument they left out.
{
  for (const [label, program] of [
    ['bare', 'scene(mesh()).write(o0)'],
    ['keywords only', 'scene(mesh(pos: [0, 1, 0], radius: 2)).write(o0)'],
    ['inside a group', 'scene(group(mesh())).write(o0)']
  ]) {
    let thrown = null
    try {
      irFor(`search synth\n${program}`)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, `mesh() ${label}: expected a compile error`)
    assert.match(thrown.message, /mesh\(\) takes one positional argument, the mesh type/,
      `mesh() ${label}: unexpected message`)
    assert.doesNotMatch(thrown.message, /Unknown mesh type/,
      `mesh() ${label}: names a type the author never wrote`)
    assert.match(thrown.message, /line [1-9]\d* col [1-9]\d*/,
      `mesh() ${label}: expected a real source position, got "${thrown.message}"`)
  }

  // A second positional keeps the same message, and one still compiles.
  assert.throws(() => irFor('search synth\nscene(mesh("box", "sphere")).write(o0)'),
    /mesh\(\) takes one positional argument, the mesh type/,
    'a second positional keeps the count message')
  assert.strictEqual(irFor('search synth\nscene(mesh("box")).write(o0)').nodes[0].meshType, 'box',
    'exactly one positional still compiles')
}

console.log('Scene compiler tests passed')
