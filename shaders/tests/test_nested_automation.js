/**
 * Tests for automation descriptors driving numeric fields on other automation
 * descriptors. The runtime contract stays seekable: every value is a pure
 * function of normalized time and the current external-input snapshot.
 */

import { compile, unparse } from '../src/lang/index.js'
import { registerOp } from '../src/lang/ops.js'
import { registerStarterOps } from '../src/lang/validator.js'
import { Pipeline } from '../src/runtime/pipeline.js'
import { AudioState, MidiState } from '../src/runtime/external-input.js'

registerOp('synth.nestedAutomationProbe', {
    name: 'nestedAutomationProbe',
    args: [
        { name: 'amount', type: 'float', default: 0, min: 0, max: 1 }
    ]
})
registerStarterOps(['synth.nestedAutomationProbe'])

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (error) {
        console.error(`FAIL: ${name}`)
        console.error(error.stack || error.message)
        failed++
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

function assertApprox(actual, expected, tolerance, message) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message}: expected ${expected} +/- ${tolerance}, got ${actual}`)
    }
}

function compiledAmount(source) {
    const result = compile(source)
    return { result, value: result.plans[0].chain[0].args.amount }
}

test('validator preserves a referenced oscillator in another oscillator speed', () => {
    const { result, value } = compiledAmount(`search synth
let rate = osc(type: oscKind.sine, min: 0.25, max: 0.75)
let carrier = osc(type: oscKind.saw, speed: rate)
nestedAutomationProbe(amount: carrier).write(o0)`)

    assertEqual(result.diagnostics.length, 0, 'nested automation should compile without diagnostics')
    assertEqual(value.type, 'Oscillator', 'consumer should receive the carrier oscillator')
    assertEqual(value.speed.type, 'Oscillator', 'carrier speed should remain an oscillator')
    assertEqual(value.speed._varRef, 'rate', 'nested source reference should be retained')
})

test('validator accepts automation only on numeric descriptor fields', () => {
    const valid = compiledAmount(`search synth
let movement = midi(channel: 1)
let gate = audio(band: audioBand.vol, min: movement)
nestedAutomationProbe(amount: gate).write(o0)`).result
    assertEqual(valid.diagnostics.length, 0, 'audio min should accept an automation source')

    const invalid = compiledAmount(`search synth
let movement = midi(channel: 1)
let gate = audio(band: movement)
nestedAutomationProbe(amount: gate).write(o0)`).result
    assert(invalid.diagnostics.some(diagnostic => diagnostic.message.includes('audio() band')),
        'audio band should remain literal-only')
})

test('invalid audio numeric fields remain invalid and strings stay outside the allowlist', () => {
    const invalidMin = compiledAmount(`search synth
let gate = audio(band: audioBand.vol, min: "not-a-number")
nestedAutomationProbe(amount: gate).write(o0)`)
    assert(invalidMin.result.diagnostics.some(diagnostic => diagnostic.code === 'S001'),
        'audio min string should produce a string-allowlist diagnostic')
    assertEqual(invalidMin.value._invalid, true,
        'an invalid audio min should keep the descriptor invalid')

    const invalidChannel = compiledAmount(`search synth
    let gate = audio(band: audioBand.vol, channel: "not-a-channel", name: "Input")
nestedAutomationProbe(amount: gate).write(o0)`)
    assert(invalidChannel.result.diagnostics.some(diagnostic => diagnostic.code === 'S001'),
        'audio channel string should produce a string-allowlist diagnostic')
    assertEqual(invalidChannel.value._invalid, true,
        'an invalid audio channel should keep the descriptor invalid')
})

test('validator reports a cycle instead of recursing or silently defaulting', () => {
    const { result } = compiledAmount(`search synth
let first = osc(type: oscKind.sine, speed: second)
let second = osc(type: oscKind.tri, speed: first)
nestedAutomationProbe(amount: first).write(o0)`)

    assert(result.diagnostics.some(diagnostic => /cycle/i.test(diagnostic.message)),
        `expected an automation cycle diagnostic, got ${JSON.stringify(result.diagnostics)}`)
})

test('nested automation survives compile and unparse', () => {
    const source = `search synth

let rate = audio(band: audioBand.raw, min: 0.25, max: 0.75)
let carrier = osc(type: oscKind.sine, min: rate, speed: rate)

nestedAutomationProbe(amount: carrier).write(o0)
render(o0)`
    const once = unparse(compile(source))
    const twice = unparse(compile(once))

    assert(once.includes('let carrier = osc(type: oscKind.sine, min: rate, speed: rate)'),
        `nested references should be unparsed, got ${once}`)
    assertEqual(twice, once, 'nested automation round-trip should be stable')
})

test('inline automation preserves named nested references when unparsed', () => {
    const source = `search synth
let rate = audio(band: audioBand.raw)
nestedAutomationProbe(
  amount: osc(type: oscKind.saw, speed: rate)
).write(o0)`
    const once = unparse(compile(source))

    assert(once.includes('speed: rate'),
        `inline descriptor should retain the named dependency, got ${once}`)
    assert(!once.includes('speed: audio('),
        `inline descriptor must not replace the named dependency with its definition, got ${once}`)
    assertEqual(unparse(compile(once)), once,
        'inline descriptor with a named dependency should round-trip stably')
})

test('numeric oscillator kinds unparse to their equivalent enum member', () => {
    const source = `search synth
let carrier = osc(type: 2)
nestedAutomationProbe(amount: carrier).write(o0)`
    const once = unparse(compile(source))

    assert(once.includes('let carrier = osc(type: oscKind.saw)'),
        `numeric saw kind should preserve its meaning, got ${once}`)
    assertEqual(unparse(compile(once)), once,
        'numeric oscillator kind should normalize to a stable enum form')
})

test('nested selected audio sources remain visible to capture requirements', () => {
    const { result, value } = compiledAmount(`search synth
let inner = audio(
  band: audioBand.raw,
  channel: 2,
  name: "Inner Interface",
  id: "inner-id"
)
let outer = audio(
  band: audioBand.low,
  min: inner,
  channel: 1,
  name: "Outer Interface",
  id: "outer-id"
)
nestedAutomationProbe(amount: outer).write(o0)`)
    assertEqual(result.diagnostics.length, 0, 'nested selected audio should compile')

    const requirements = new Pipeline({ passes: [{ uniforms: { amount: value } }] }, null)
        .getAudioInputRequirements()
    assertEqual(JSON.stringify(requirements.selected.map(item => item.id).sort()),
        JSON.stringify(['inner-id', 'outer-id']),
        'capture requirements should include both outer and nested selected devices')
})

test('invalid outer audio never evaluates or requests its nested inputs', () => {
    const inner = {
        type: 'Audio', band: 0, min: 0, max: 1,
        channel: 1, name: 'Inner Interface', id: 'inner-id'
    }
    const invalidOuter = {
        type: 'Audio', band: 0, min: inner, max: 1,
        _invalid: true
    }
    const pipeline = new Pipeline({ passes: [{ uniforms: { amount: invalidOuter } }] }, null)
    const audio = new AudioState()
    audio.registerDevice({ id: 'inner-id', name: 'Inner Interface', channelCount: 1 })
    audio.setChannelValues('inner-id', 1, { low: 0.8 })
    pipeline.setAudioState(audio)

    assertEqual(pipeline.getAudioInputRequirements().selected.length, 0,
        'invalid outer audio must not request a nested selected device')
    assertEqual(pipeline.resolveUniformValue(invalidOuter, 0.5), 0,
        'invalid outer audio with a nonliteral min must fail closed at zero')
})

test('oscillator rate modulation is seekable and supports through-zero motion', () => {
    const { value } = compiledAmount(`search synth
let rate = osc(type: oscKind.sine)
let carrier = osc(type: oscKind.saw, speed: rate)
nestedAutomationProbe(amount: carrier).write(o0)`)
    const pipeline = new Pipeline(null, null)

    // A default 0..1 rate source maps across the oscillator speed domain
    // (-20..20). Its integral is -20*sin(2*pi*t)/(2*pi).
    const quarter = pipeline.resolveUniformValue(value, 0.25)
    const threeQuarter = pipeline.resolveUniformValue(value, 0.75)
    const repeated = pipeline.resolveUniformValue(value, 0.75)
    const expectedQuarter = ((-20 / (Math.PI * 2)) % 1 + 1) % 1
    const expectedThreeQuarter = ((20 / (Math.PI * 2)) % 1 + 1) % 1

    assertApprox(quarter, expectedQuarter, 1e-9, 'quarter-cycle phase should integrate negative speed')
    assertApprox(threeQuarter, expectedThreeQuarter, 1e-9, 'three-quarter phase should integrate positive speed')
    assertApprox(repeated, threeQuarter, 0, 'evaluation should not depend on frame history')
})

test('noise can drive oscillator rate without sacrificing deterministic seeking', () => {
    const { value } = compiledAmount(`search synth
let rate = osc(type: oscKind.noise, seed: 37)
let carrier = osc(type: oscKind.sine, speed: rate)
nestedAutomationProbe(amount: carrier).write(o0)`)
    const pipeline = new Pipeline(null, null)

    const later = pipeline.resolveUniformValue(value, 0.83)
    pipeline.resolveUniformValue(value, 0.12)
    const repeated = pipeline.resolveUniformValue(value, 0.83)

    assert(Number.isFinite(later), 'noise-modulated rate should resolve to a finite value')
    assertEqual(repeated, later, 'noise-modulated rate should be frame-order independent')
})

test('current MIDI and audio snapshots can drive oscillator rate', () => {
    const midiProgram = compiledAmount(`search synth
let rate = midi(channel: 1, mode: midiMode.gateVelocity)
let carrier = osc(type: oscKind.saw, speed: rate)
nestedAutomationProbe(amount: carrier).write(o0)`).value
    const audioProgram = compiledAmount(`search synth
let rate = audio(band: audioBand.raw)
let carrier = osc(type: oscKind.saw, speed: rate)
nestedAutomationProbe(amount: carrier).write(o0)`).value
    const pipeline = new Pipeline(null, null)
    const midi = new MidiState()
    const audio = new AudioState()
    pipeline.setMidiState(midi)
    pipeline.setAudioState(audio)

    midi.getChannel(1).gate = 1
    midi.getChannel(1).velocity = 127
    audio.setRaw(1)
    assertApprox(pipeline.resolveUniformValue(midiProgram, 0.0125), 0.25, 1e-9,
        'full-scale MIDI should drive the carrier forward at +20 cycles')
    assertApprox(pipeline.resolveUniformValue(audioProgram, 0.0125), 0.25, 1e-9,
        'positive raw audio should drive the carrier forward at +20 cycles')

    midi.getChannel(1).velocity = 0
    audio.setRaw(-1)
    assertApprox(pipeline.resolveUniformValue(midiProgram, 0.0125), 0.75, 1e-9,
        'zero MIDI should map to -20 cycles and reverse the carrier')
    assertApprox(pipeline.resolveUniformValue(audioProgram, 0.0125), 0.75, 1e-9,
        'negative raw audio should reverse the carrier')
})

test('automated external-input ranges are integrated across normalized time', () => {
    const { value } = compiledAmount(`search synth
let shape = osc(type: oscKind.sine)
let rate = midi(channel: 1, mode: midiMode.gateVelocity, min: shape, max: shape)
let carrier = osc(type: oscKind.saw, speed: rate)
nestedAutomationProbe(amount: carrier).write(o0)`)
    const pipeline = new Pipeline(null, null)
    pipeline.setMidiState(new MidiState())

    // With min and max both driven by shape, MIDI state cancels out and rate
    // is exactly the nested sine mapped onto -20..20.
    const expected = ((-20 / (Math.PI * 2)) % 1 + 1) % 1
    assertApprox(pipeline.resolveUniformValue(value, 0.25), expected, 1e-8,
        'dynamic MIDI range must be integrated rather than sampled once at the endpoint')
})

test('multiple nested rate modulators remain bounded and deterministic', () => {
    const { result, value } = compiledAmount(`search synth
let rate8 = osc(type: oscKind.sine)
let rate7 = osc(type: oscKind.sine, speed: rate8)
let rate6 = osc(type: oscKind.sine, speed: rate7)
let rate5 = osc(type: oscKind.sine, speed: rate6)
let rate4 = osc(type: oscKind.sine, speed: rate5)
let rate3 = osc(type: oscKind.sine, speed: rate4)
let rate2 = osc(type: oscKind.sine, speed: rate3)
let rate1 = osc(type: oscKind.sine, speed: rate2)
let carrier = osc(type: oscKind.saw, speed: rate1)
nestedAutomationProbe(amount: carrier).write(o0)`)
    assertEqual(result.diagnostics.length, 0, 'eight nested levels should compile')

    const pipeline = new Pipeline(null, null)
    const first = pipeline.resolveUniformValue(value, 0.61)
    const repeated = pipeline.resolveUniformValue(value, 0.61)
    assert(Number.isFinite(first), 'deeply nested rate should remain finite')
    assertEqual(repeated, first, 'deeply nested rate should be deterministic')
})

test('automation nesting beyond eight levels is rejected', () => {
    const { result } = compiledAmount(`search synth
let rate9 = osc(type: oscKind.sine)
let rate8 = osc(type: oscKind.sine, speed: rate9)
let rate7 = osc(type: oscKind.sine, speed: rate8)
let rate6 = osc(type: oscKind.sine, speed: rate7)
let rate5 = osc(type: oscKind.sine, speed: rate6)
let rate4 = osc(type: oscKind.sine, speed: rate5)
let rate3 = osc(type: oscKind.sine, speed: rate4)
let rate2 = osc(type: oscKind.sine, speed: rate3)
let rate1 = osc(type: oscKind.sine, speed: rate2)
let carrier = osc(type: oscKind.saw, speed: rate1)
nestedAutomationProbe(amount: carrier).write(o0)`)

    assert(result.diagnostics.some(diagnostic =>
        diagnostic.message.includes('maximum depth of 8')),
    `ninth nested level should report the depth limit, got ${JSON.stringify(result.diagnostics)}`)
})

console.log(`\nNested automation: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
