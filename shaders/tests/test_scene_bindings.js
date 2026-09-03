// shaders/tests/test_scene_bindings.js
import assert from 'node:assert'
import { compile } from '../src/lang/index.js'
import { compileScene } from '../src/rendering/scene-compiler.js'
import { SceneTree } from '../src/scene/tree.js'
import { collectBindings, evaluateBindings } from '../src/scene/bindings.js'
import { MidiState, AudioState } from '../src/runtime/external-input.js'
import { Pipeline } from '../src/runtime/pipeline.js'

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

// A volume node animates exactly like a mesh: collectBindings walks every
// node in the tree, so the vol atlas placement is driven by the same clock.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      volume(vol0, threshold: 0.4, rot: [0, osc(type: oscKind.saw), 0])
    ).write(o0)
  `)
  assert.strictEqual(bindings.length, 1, 'one volume binding collected')
  assert.strictEqual(bindings[0].channel, 'rotation', 'rotation channel')
  const volume = tree.getVolumeNodes()[0]
  assert.strictEqual(volume.rotation[1], 0, 'saw starts at zero degrees')
  volume.getWorldMatrix()
  evaluateBindings(bindings, 0.25)
  assert.strictEqual(volume.rotation[1], 90, 'quarter loop maps to 90 degrees')
  assert.strictEqual(volume._dirty, true, 'dirty after evaluation')
  assert.strictEqual(volume.threshold, 0.4, 'threshold is untouched by bindings')
}

// ---------------------------------------------------------------------------
// midi() and audio() bindings. They are collected and sanitized exactly like
// osc() ones, and evaluated through the same evaluators the pipeline uses for
// effect uniforms, against the same external state object the pipeline reads.
// ---------------------------------------------------------------------------

// A MIDI-driven rotation is collected, starts at its min, and follows the
// channel state once external state is threaded in.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      group(id: "spin", rot: [0, midi(channel: 1, mode: midiMode.gateVelocity), 0],
        mesh("box")
      )
    ).write(o0)
  `)
  assert.strictEqual(bindings.length, 1, 'one midi binding collected')
  assert.strictEqual(bindings[0].channel, 'rotation', 'rotation channel')
  const spin = tree.getById('spin')
  assert.strictEqual(spin.rotation[1], 0, 'no external state yet: sits at the descriptor minimum')
  assert.ok(Number.isFinite(spin.rotation[1]), 'no NaN in transforms')

  const midi = new MidiState()
  const external = { midi, audio: null }
  midi.getChannel(1).noteOn(60, 127)
  evaluateBindings(bindings, 0, external)
  assert.ok(Math.abs(spin.rotation[1] - 360) < 1e-9, 'full velocity maps to the full rotation range')

  midi.getChannel(1).noteOff(60)
  evaluateBindings(bindings, 0, external)
  assert.strictEqual(spin.rotation[1], 0, 'gate off returns to zero degrees')
    assert.strictEqual(spin._dirty, true, 'dirty after evaluation')
}

// Scene bindings must route through the same selected-port registry as 2D
// uniforms. Two identical controller names must not collapse back into the
// aggregate state when an exact id is present.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      group(id: "spin", rot: [0, midi(channel: 1, mode: midiMode.gateVelocity, name: "Launch Control XL", id: "left-id"), 0],
        mesh("box")
      )
    ).write(o0)
  `)
  const midi = new MidiState()
  midi.handleMessage(new Uint8Array([0x90, 60, 32]), { id: 'left-id', name: 'Launch Control XL' })
  midi.handleMessage(new Uint8Array([0x90, 72, 127]), { id: 'right-id', name: 'Launch Control XL' })

  evaluateBindings(bindings, 0, { midi, audio: null })
  assert.ok(
    Math.abs(tree.getById('spin').rotation[1] - (32 / 127) * 360) < 1e-9,
    'scene binding should read only the exact selected port'
  )
}

// A readable name remains a compatibility selector only while it identifies
// exactly one connected port. Ambiguity must hold the descriptor at its min.
{
  const { tree, bindings } = build(`
    search synth
    scene(mesh("box", pos: [midi(channel: 1, mode: midiMode.gateVelocity, min: 0.25, name: "Launch Control XL"), 0, 0])).write(o0)
  `)
  const midi = new MidiState()
  midi.handleMessage(new Uint8Array([0x90, 60, 64]), { id: 'left-id', name: 'Launch Control XL' })
  evaluateBindings(bindings, 0, { midi, audio: null })
  assert.ok(
    Math.abs(tree.getMeshNodes()[0].position[0] - (0.25 + (64 / 127) * 0.75)) < 1e-9,
    'one exact readable-name match should drive the scene'
  )

  midi.handleMessage(new Uint8Array([0x90, 72, 127]), { id: 'right-id', name: 'Launch Control XL' })
  evaluateBindings(bindings, 0, { midi, audio: null })
  assert.strictEqual(tree.getMeshNodes()[0].position[0], 0.25,
    'duplicate readable names should make the scene binding inert at min')
}

// The id remains authoritative across a port rename, then becomes unavailable
// immediately when that exact port disconnects.
{
  const { tree, bindings } = build(`
    search synth
    scene(mesh("box", pos: [midi(channel: 1, mode: midiMode.gateVelocity, min: 0.1, name: "Old Name", id: "port-id"), 0, 0])).write(o0)
  `)
  const midi = new MidiState()
  midi.handleMessage(new Uint8Array([0x90, 60, 127]), { id: 'port-id', name: 'New Name' })
  evaluateBindings(bindings, 0, { midi, audio: null })
  assert.strictEqual(tree.getMeshNodes()[0].position[0], 1,
    'exact id should drive the scene despite readable-name drift')

  midi.disconnectPort('port-id')
  evaluateBindings(bindings, 0, { midi, audio: null })
  assert.strictEqual(tree.getMeshNodes()[0].position[0], 0.1,
    'disconnected exact id should hold the scene binding at min')
}

// An audio-driven scale reads the same AudioState the pipeline reads.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      mesh("box", scale: [audio(band: audioBand.low), 1, 1])
    ).write(o0)
  `)
  const node = tree.getMeshNodes()[0]
  assert.strictEqual(node.scale[0], 0, 'no external state yet: sits at the descriptor minimum')

  const audio = new AudioState()
  const external = { midi: null, audio }
  audio.low = 0.5
  evaluateBindings(bindings, 0, external)
  assert.ok(Math.abs(node.scale[0] - 0.5) < 1e-9, 'unbounded scale consumes the raw audio percentage')
  audio.low = 1
  evaluateBindings(bindings, 0.75, external)
  assert.strictEqual(node.scale[0], 1, 'audio is time-independent: loop position does not change it')
}

// Light intensity animates from midi() and audio() too.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      light(type: "point", pos: [0, 4, 0], intensity: audio(audioBand.vol, min: 0.25, max: 1)),
      mesh("box")
    ).write(o0)
  `)
  assert.strictEqual(bindings.length, 1, 'light binding collected')
  assert.strictEqual(bindings[0].channel, 'intensity', 'intensity channel')
  assert.strictEqual(tree.lights[0].intensity, 0.25, 'starts at the descriptor minimum')

  const audio = new AudioState()
  audio.vol = 1
  evaluateBindings(bindings, 0, { midi: null, audio })
  assert.strictEqual(tree.lights[0].intensity, 1, 'light follows the audio band')
}

// All three kinds coexist on one node and advance together.
{
  const { tree, bindings } = build(`
    search synth
    scene(
      mesh("box", pos: [osc(type: oscKind.saw), midi(channel: 2), audio(audioBand.high)])
    ).write(o0)
  `)
  assert.strictEqual(bindings.length, 3, 'one binding per animated component')
  const node = tree.getMeshNodes()[0]
  assert.deepStrictEqual(node.position, [0, 0, 0], 'every kind sanitizes to a finite loop-start value')

  const midi = new MidiState()
  const audio = new AudioState()
  midi.getChannel(2).noteOn(60, 127)
  audio.high = 0.25
  evaluateBindings(bindings, 0.5, { midi, audio })
  assert.strictEqual(node.position[0], 0.5, 'oscillator still follows normalized loop time')
  assert.ok(Math.abs(node.position[1] - 1) < 1e-9, 'midi component follows the channel')
  assert.ok(Math.abs(node.position[2] - 0.25) < 1e-9, 'audio component follows the band')
}

// Omitting the external state leaves midi/audio bindings at their minimum
// rather than producing NaN — the same contract the pipeline honours when no
// MidiState or AudioState has been set.
{
  const { tree, bindings } = build(`
    search synth
    scene(mesh("box", pos: [midi(1, min: 0.5), audio(audioBand.low, min: 0.25), 0])).write(o0)
  `)
  evaluateBindings(bindings, 0.5)
  const node = tree.getMeshNodes()[0]
  assert.strictEqual(node.position[0], 0.5, 'midi falls back to its minimum without state')
  assert.strictEqual(node.position[1], 0.25, 'audio falls back to its minimum without state')
}

// ---------------------------------------------------------------------------
// The state a scene binding reads is the pipeline's own externalState record —
// not a copy, not a parallel one. A scene and the 2D effects around it must
// answer to the same keyboard and the same track, so this hands
// evaluateBindings the very object resolveUniformValue reads and checks that
// setMidiState()/setAudioState() reach the scene through it.
// ---------------------------------------------------------------------------
{
  const { tree, bindings } = build(`
    search synth
    scene(
      mesh("box", pos: [midi(channel: 1), audio(audioBand.vol), 0])
    ).write(o0)
  `)
  const node = tree.getMeshNodes()[0]
  const pipeline = new Pipeline(null, null)
  const midi = new MidiState()
  const audio = new AudioState()
  pipeline.setMidiState(midi)
  pipeline.setAudioState(audio)

  midi.getChannel(1).noteOn(60, 127)
  audio.vol = 0.5
  evaluateBindings(bindings, 0, pipeline.externalState)
  assert.ok(Math.abs(node.position[0] - 1) < 1e-9, 'the pipeline MidiState drives the scene')
  assert.ok(Math.abs(node.position[1] - 0.5) < 1e-9, 'the pipeline AudioState drives the scene')

  // Replacing the host state on the pipeline replaces it for the scene too:
  // the binding holds no reference of its own.
  const replacement = new AudioState()
  replacement.vol = 0.25
  pipeline.setAudioState(replacement)
  evaluateBindings(bindings, 0, pipeline.externalState)
  assert.ok(Math.abs(node.position[1] - 0.25) < 1e-9, 'a replaced AudioState reaches the scene')
}

console.log('Scene bindings tests passed')
