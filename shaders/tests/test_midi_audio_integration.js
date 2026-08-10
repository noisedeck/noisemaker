/**
 * Integration Tests for MIDI and Audio with Full Pipeline
 *
 * Tests the complete flow: DSL source → compile → pipeline → resolveUniformValue
 */

import { compile } from '../src/lang/index.js'
import { Pipeline } from '../src/runtime/pipeline.js'
import { MidiState, AudioState } from '../src/runtime/external-input.js'
import { registerStarterOps } from '../src/lang/validator.js'
import { registerOp } from '../src/lang/ops.js'

// Register test ops
registerOp('synth.noise', {
    name: 'noise',
    args: [
        { name: 'scale', type: 'float', default: 10 },
        { name: 'speed', type: 'float', default: 1 }
    ]
})

registerStarterOps(['synth.noise'])

let passCount = 0
let failCount = 0

function test(name, fn) {
    try {
        fn()
        console.log(`PASS: ${name}`)
        passCount++
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e.message)
        if (e.stack) console.error(e.stack.split('\n').slice(1, 3).join('\n'))
        failCount++
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

function assertApprox(actual, expected, tolerance = 0.01, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message || 'Assertion failed'}: expected ~${expected}, got ${actual}`)
    }
}

// Helper to create pipeline with external state
function createTestPipeline() {
    const pipeline = new Pipeline(null, null)
    const midiState = new MidiState()
    const audioState = new AudioState()
    pipeline.setMidiState(midiState)
    pipeline.setAudioState(audioState)
    return { pipeline, midiState, audioState }
}

// ============================================================================
// MIDI Integration Tests
// ============================================================================

console.log('\n=== MIDI Integration ===\n')

test('midi() compiles to runtime config and resolves correctly', () => {
    // Compile DSL with midi()
    // min/max on automation are a normalized [0, 1] sub-range; the absolute
    // output range comes from the consuming parameter's spec.
    const result = compile('search synth\nnoise(scale: midi(channel: 1, min: 0, max: 1)).write(o0)')

    // Get the compiled midi config from the step args
    const scaleArg = result.plans[0].chain[0].args.scale

    // Verify it compiled correctly
    assertEqual(scaleArg.type, 'Midi', 'should have type Midi')
    assertEqual(scaleArg.channel, 1, 'should have channel')
    assertEqual(scaleArg.min, 0, 'should have min')
    assertEqual(scaleArg.max, 1, 'should have max')

    // Now test that it resolves correctly at runtime
    const { pipeline, midiState } = createTestPipeline()

    // Simulate MIDI note on channel 1 (just happened - no decay yet)
    midiState.getChannel(1).key = 60
    midiState.getChannel(1).velocity = 100
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now()  // Just happened

    // Resolve against a consumer range of 1-10 (velocity mode by default)
    const value = pipeline.resolveUniformValue(scaleArg, 0, { min: 1, max: 10 })

    // velocity mode with no decay: pct = velocity/127 = 100/127
    // mapped to 1-10: 1 + (100/127) * 9 ≈ 8.09
    assertApprox(value, 1 + (100/127) * 9, 0.1, 'should resolve midi value correctly')
})

test('midi with different modes resolves correctly', () => {
    // Compile with gateVelocity mode
    const result = compile('search synth\nnoise(scale: midi(channel: 2, mode: midiMode.gateVelocity, min: 0, max: 1)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale

    assertEqual(scaleArg.mode, 2, 'should have gateVelocity mode (2)')

    const { pipeline, midiState } = createTestPipeline()
    const range = { min: 0, max: 100 }

    // Gate is off - should return min
    midiState.getChannel(2).velocity = 127
    midiState.getChannel(2).gate = 0

    let value = pipeline.resolveUniformValue(scaleArg, 0, range)
    assertEqual(value, 0, 'should return min when gate is off')

    // Gate is on - should return velocity mapped
    midiState.getChannel(2).gate = 1

    value = pipeline.resolveUniformValue(scaleArg, 0, range)
    assertEqual(value, 100, 'should return max when gate is on and velocity is 127')
})

test('midi sensitivity affects trigger falloff', () => {
    // Compile with triggerNote mode and high sensitivity
    const result = compile('search synth\nnoise(scale: midi(channel: 1, mode: midiMode.triggerNote, sensitivity: 5, min: 0, max: 1)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale

    assertEqual(scaleArg.sensitivity, 5, 'should have sensitivity 5')
    assertEqual(scaleArg.mode, 3, 'should have triggerNote mode (3)')

    const { pipeline, midiState } = createTestPipeline()

    // Simulate note that just triggered - no decay yet
    midiState.getChannel(1).key = 127  // Max note
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now()  // Just happened

    // No decay yet, should get full value
    let value = pipeline.resolveUniformValue(scaleArg, 0)
    assertApprox(value, 1, 0.01, 'should be ~1 at trigger time')

    // Simulate note from 500ms ago - should be fully decayed with sensitivity 5
    // decay = min(1, 500 * 5 * 0.001) = min(1, 2.5) = 1 (fully decayed)
    midiState.getChannel(1).time = Date.now() - 500
    value = pipeline.resolveUniformValue(scaleArg, 0)
    assertEqual(value, 0, 'should be 0 when fully decayed')
})

// ============================================================================
// Audio Integration Tests
// ============================================================================

console.log('\n=== Audio Integration ===\n')

test('audio() compiles to runtime config and resolves correctly', () => {
    // Compile DSL with audio()
    const result = compile('search synth\nnoise(scale: audio(band: audioBand.low, min: 0, max: 1)).write(o0)')

    // Get the compiled audio config from the step args
    const scaleArg = result.plans[0].chain[0].args.scale

    // Verify it compiled correctly
    assertEqual(scaleArg.type, 'Audio', 'should have type Audio')
    assertEqual(scaleArg.band, 0, 'should have low band (0)')
    assertEqual(scaleArg.min, 0, 'should have min')
    assertEqual(scaleArg.max, 1, 'should have max')

    // Now test that it resolves correctly at runtime
    const { pipeline, audioState } = createTestPipeline()

    // Simulate audio input
    audioState.low = 0.5

    // Resolve against a consumer range of 1-10
    const value = pipeline.resolveUniformValue(scaleArg, 0, { min: 1, max: 10 })

    // 0.5 mapped to 1-10: 1 + 0.5 * 9 = 5.5
    assertApprox(value, 5.5, 0.01, 'should resolve audio value correctly')
})

test('audio with different bands resolves correctly', () => {
    const bands = [
        { name: 'low', enum: 'audioBand.low', index: 0 },
        { name: 'mid', enum: 'audioBand.mid', index: 1 },
        { name: 'high', enum: 'audioBand.high', index: 2 },
        { name: 'vol', enum: 'audioBand.vol', index: 3 }
    ]

    for (const { name, enum: enumVal, index } of bands) {
        const result = compile(`search synth\nnoise(scale: audio(band: ${enumVal}, min: 0, max: 1)).write(o0)`)
        const scaleArg = result.plans[0].chain[0].args.scale

        assertEqual(scaleArg.band, index, `should have ${name} band (${index})`)

        const { pipeline, audioState } = createTestPipeline()

        // Set the specific band
        audioState[name] = 0.75

        const value = pipeline.resolveUniformValue(scaleArg, 0)
        assertApprox(value, 0.75, 0.01, `should resolve ${name} band correctly`)
    }
})

// ============================================================================
// Combined MIDI + Audio Tests
// ============================================================================

console.log('\n=== Combined MIDI + Audio ===\n')

test('multiple parameters can use different automation sources', () => {
    // Compile with both midi and audio on different parameters
    const result = compile(`search synth
noise(scale: midi(channel: 1, min: 0, max: 1), speed: audio(band: audioBand.mid, min: 0, max: 1)).write(o0)`)

    const step = result.plans[0].chain[0]

    // Check scale uses midi
    const scaleArg = step.args.scale
    assertEqual(scaleArg.type, 'Midi', 'scale should use midi')

    // Check speed uses audio
    const speedArg = step.args.speed
    assertEqual(speedArg.type, 'Audio', 'speed should use audio')

    // Resolve both
    const { pipeline, midiState, audioState } = createTestPipeline()

    midiState.getChannel(1).velocity = 127
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now()  // Just happened
    audioState.mid = 0.5

    const scaleValue = pipeline.resolveUniformValue(scaleArg, 0, { min: 1, max: 5 })
    const speedValue = pipeline.resolveUniformValue(speedArg, 0, { min: 0.5, max: 2 })

    // scale: 1 + (127/127) * 4 = 5
    assertApprox(scaleValue, 5, 0.01, 'scale should resolve from midi')
    // speed: 0.5 + 0.5 * 1.5 = 1.25
    assertApprox(speedValue, 1.25, 0.01, 'speed should resolve from audio')
})

test('static values still work alongside automation', () => {
    // Compile with mix of static and automated values
    const result = compile(`search synth
noise(scale: 5, speed: midi(channel: 1, min: 0, max: 1)).write(o0)`)

    const step = result.plans[0].chain[0]

    // Check scale is static
    const scaleArg = step.args.scale
    assertEqual(scaleArg, 5, 'scale should be static number')

    // Check speed uses midi
    const speedArg = step.args.speed
    assertEqual(speedArg.type, 'Midi', 'speed should use midi')

    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).velocity = 64
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now()  // Just happened

    const scaleValue = pipeline.resolveUniformValue(scaleArg, 0)
    const speedValue = pipeline.resolveUniformValue(speedArg, 0, { min: 0.5, max: 2 })

    assertEqual(scaleValue, 5, 'static value should resolve as-is')
    // 0.5 + (64/127) * 1.5 ≈ 1.26
    assertApprox(speedValue, 0.5 + (64/127) * 1.5, 0.01, 'midi value should resolve correctly')
})

// ============================================================================
// Edge Cases
// ============================================================================

console.log('\n=== Edge Cases ===\n')

test('midi resolves to min when no external state', () => {
    const result = compile('search synth\nnoise(scale: midi(channel: 1, min: 0, max: 1)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale

    // Pipeline without external state
    const pipeline = new Pipeline(null, null)

    const value = pipeline.resolveUniformValue(scaleArg, 0, { min: 5, max: 10 })
    assertEqual(value, 5, 'should return min when no midi state')
})

test('audio resolves to min when no external state', () => {
    const result = compile('search synth\nnoise(scale: audio(band: audioBand.high, min: 0, max: 1)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale

    // Pipeline without external state
    const pipeline = new Pipeline(null, null)

    const value = pipeline.resolveUniformValue(scaleArg, 0, { min: 3, max: 7 })
    assertEqual(value, 3, 'should return min when no audio state')
})

test('oscillator still works correctly', () => {
    // Verify we didn't break osc() when adding midi/audio
    const result = compile('search synth\nnoise(scale: osc(type: oscKind.sine, min: 0, max: 1, speed: 1)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale

    assertEqual(scaleArg.type, 'Oscillator', 'should have oscillator type')

    const pipeline = new Pipeline(null, null)

    // At time 0, sine wave starts at min: oscSine(0) = (1 - cos(0)) * 0.5 = 0
    const value = pipeline.resolveUniformValue(scaleArg, 0, { min: 0, max: 10 })
    assertApprox(value, 0, 0.1, 'oscillator should start at min')

    // At time 0.5, sine wave peaks: oscSine(0.5) = (1 - cos(π)) * 0.5 = 1
    const valueMid = pipeline.resolveUniformValue(scaleArg, 0.5, { min: 0, max: 10 })
    assertApprox(valueMid, 10, 0.1, 'oscillator should peak at max')
})

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== Test Summary ===')
console.log(`Passed: ${passCount}`)
console.log(`Failed: ${failCount}`)

if (failCount > 0) {
    process.exit(1)
}
