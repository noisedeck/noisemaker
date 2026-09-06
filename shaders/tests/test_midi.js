/**
 * Tests for MIDI Evaluation in the Pipeline
 *
 * Tests the evaluateMidi() function and MIDI integration with resolveUniformValue().
 */

import { Pipeline } from '../src/runtime/pipeline.js'
import { MidiState } from '../src/runtime/external-input.js'

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
        failCount++
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed')
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

// Helper to create a test pipeline with MIDI state
function createTestPipeline() {
    const pipeline = new Pipeline(null, null)
    const midiState = new MidiState()
    pipeline.setMidiState(midiState)
    return { pipeline, midiState }
}

// ============================================================================
// MIDI Mode: noteChange (mode 0)
// ============================================================================

console.log('\n=== MIDI Mode: noteChange (0) ===\n')

test('noteChange returns note value regardless of gate', () => {
    const { pipeline, midiState } = createTestPipeline()

    // Set up channel 1 with a note (gate off)
    midiState.getChannel(1).key = 60
    midiState.getChannel(1).gate = 0

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 0,  // noteChange
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // 60/127 ≈ 0.472
    assertApprox(result, 60 / 127, 0.01, 'should return note value even with gate off')
})

test('noteChange maps to min/max range', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).key = 127  // Max MIDI note

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 0,
        min: 0,
        max: 10,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 10, 0.01, 'should map max note to max value')
})

// ============================================================================
// MIDI Mode: gateNote (mode 1)
// ============================================================================

console.log('\n=== MIDI Mode: gateNote (1) ===\n')

test('gateNote returns note value when gate is on', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).noteOn(64, 100)

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 1,  // gateNote
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 64 / 127, 0.01, 'should return note value when gate on')
})

test('gateNote returns min when gate is off', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).key = 64
    midiState.getChannel(1).gate = 0

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 1,  // gateNote
        min: 5,
        max: 10,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 5, 'should return min when gate off')
})

// ============================================================================
// MIDI Mode: gateVelocity (mode 2)
// ============================================================================

console.log('\n=== MIDI Mode: gateVelocity (2) ===\n')

test('gateVelocity returns velocity when gate is on', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).noteOn(60, 100)

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 2,  // gateVelocity
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 100 / 127, 0.01, 'should return velocity when gate on')
})

test('gateVelocity returns min when gate is off', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).velocity = 100
    midiState.getChannel(1).gate = 0

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 2,  // gateVelocity
        min: 0,
        max: 10,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 0, 'should return min when gate off')
})

// ============================================================================
// MIDI Mode: triggerNote (mode 3)
// ============================================================================

console.log('\n=== MIDI Mode: triggerNote (3) ===\n')

test('triggerNote returns full note value immediately after note on', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).noteOn(64, 100)
    // time is now, so elapsed is ~0

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 3,  // triggerNote
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // With ~0 elapsed time, should be close to full value
    assertApprox(result, 64 / 127, 0.05, 'should return ~full note value immediately')
})

test('triggerNote decays over time', () => {
    const { pipeline, midiState } = createTestPipeline()

    // Simulate note on 500ms ago
    midiState.getChannel(1).key = 127
    midiState.getChannel(1).velocity = 127
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now() - 500

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 3,  // triggerNote
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // With sensitivity=1 and 500ms elapsed: decay = min(1, 500 * 1 * 0.001) = 0.5
    // value = 127 * (1 - 0.5) = 63.5, normalized = 63.5/127 ≈ 0.5
    assertApprox(result, 0.5, 0.1, 'should decay to ~half after 500ms')
})

test('triggerNote higher sensitivity decays faster', () => {
    const { pipeline, midiState } = createTestPipeline()

    // Simulate note on 250ms ago
    midiState.getChannel(1).key = 127
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now() - 250

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 3,  // triggerNote
        min: 0,
        max: 1,
        sensitivity: 4  // 4x faster decay
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // decay = min(1, 250 * 4 * 0.001) = 1.0 (clamped)
    // value = 127 * (1 - 1) = 0
    assertApprox(result, 0, 0.05, 'should fully decay with high sensitivity')
})

// ============================================================================
// MIDI Mode: velocity (mode 4) - Default
// ============================================================================

console.log('\n=== MIDI Mode: velocity (4) ===\n')

test('velocity returns full velocity immediately after note on', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).noteOn(60, 100)

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 4,  // velocity
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 100 / 127, 0.05, 'should return ~full velocity immediately')
})

test('velocity decays over time', () => {
    const { pipeline, midiState } = createTestPipeline()

    // Simulate note on 1000ms ago with full velocity
    midiState.getChannel(1).velocity = 127
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now() - 1000

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 4,  // velocity
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // decay = min(1, 1000 * 1 * 0.001) = 1.0
    // value = 127 * (1 - 1) = 0
    assertApprox(result, 0, 0.05, 'should fully decay after 1000ms')
})

// ============================================================================
// Channel Selection
// ============================================================================

console.log('\n=== Channel Selection ===\n')

test('selects correct MIDI channel', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).noteOn(60, 50)
    midiState.getChannel(5).noteOn(72, 100)

    const config = {
        type: 'Midi',
        channel: 5,
        mode: 2,  // gateVelocity
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 100 / 127, 0.01, 'should use channel 5 velocity')
})

// ============================================================================
// Min/Max Range Mapping
// ============================================================================

console.log('\n=== Range Mapping ===\n')

test('maps MIDI value to custom min/max range', () => {
    const { pipeline, midiState } = createTestPipeline()

    midiState.getChannel(1).key = 64  // ~50% of 127

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 0,  // noteChange
        min: 10,
        max: 20,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // 64/127 ≈ 0.504, so result ≈ 10 + 0.504 * 10 ≈ 15.04
    assertApprox(result, 15.04, 0.5, 'should map to custom range')
})

test('returns min when no MIDI state', () => {
    const pipeline = new Pipeline(null, null)
    // No MIDI state set

    const config = {
        type: 'Midi',
        channel: 1,
        mode: 4,
        min: 5,
        max: 10,
        sensitivity: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 5, 'should return min when no MIDI state')
})

// ============================================================================
// Integration with non-MIDI values
// ============================================================================

console.log('\n=== Integration ===\n')

test('resolveUniformValue passes through non-MIDI values', () => {
    const { pipeline } = createTestPipeline()

    assertEqual(pipeline.resolveUniformValue(42, 0), 42, 'should pass through numbers')
    assertEqual(pipeline.resolveUniformValue('test', 0), 'test', 'should pass through strings')
    assertEqual(pipeline.resolveUniformValue(null, 0), null, 'should pass through null')
})

test('resolveUniformValue handles oscillator configs', () => {
    const { pipeline } = createTestPipeline()

    const oscConfig = {
        type: 'Oscillator',
        oscType: 0,  // sine
        min: 0,
        max: 1,
        speed: 1,
        offset: 0,
        seed: 1
    }

    const result = pipeline.resolveUniformValue(oscConfig, 0)
    assert(typeof result === 'number', 'should evaluate oscillator')
})


test('CC holds its value independently of notes, channels and ports', () => {
    const { pipeline, midiState } = createTestPipeline()
    const left = { id: 'left', name: 'Controller' }
    const right = { id: 'right', name: 'Controller' }
    const config = { type: 'Midi', channel: 2, mode: 5, cc: 74, min: 0.2, max: 0.8, id: 'left', name: 'Controller' }
    midiState.handleMessage([0xb1, 74, 127], left)
    midiState.handleMessage([0xb0, 74, 12], left)
    midiState.handleMessage([0xb1, 74, 8], right)
    midiState.handleMessage([0x91, 60, 30], left)
    midiState.handleMessage([0x81, 60, 0], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.8, 0.000001, 'CC should hold full scale after note off')
    midiState.handleMessage([0xb1, 74, 64], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.5023622047244094, 0.000001, 'CC should use 7-bit normalization')
    midiState.handleMessage([0xb1, 74, 0], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.2, 0.000001, 'zero CC should map to min')
})

test('CC14 retains partial bytes without crossing MIDI ports or channels', () => {
    const { pipeline, midiState } = createTestPipeline()
    const left = { id: 'left', name: 'Left' }
    const right = { id: 'right', name: 'Right' }
    const config = { type: 'Midi', channel: 1, mode: 6, cc: 1, min: 0, max: 1 }
    midiState.handleMessage([0xb0, 1, 64], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.5000305194408838, 0.00000001, 'MSB alone should use a zero LSB')
    midiState.handleMessage([0xb0, 33, 127], right)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.007751937984496124, 0.00000001, 'aggregate should use only bytes from right port')
    midiState.handleMessage([0xb1, 33, 127], left)
    midiState.handleMessage([0xb0, 33, 1], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.5000915583226515, 0.00000001, 'left LSB should reuse only its own channel MSB')
    midiState.handleMessage([0xb0, 1, 127], left)
    midiState.handleMessage([0xb0, 33, 127], left)
    assertEqual(pipeline.resolveUniformValue(config, 0), 1, '14-bit full scale should map to max')
    midiState.handleMessage([0x90, 60, 127], left)
    midiState.handleMessage([0x80, 60, 0], left)
    assertEqual(pipeline.resolveUniformValue(config, 0), 1, 'notes must not interfere with CC14')
    midiState.disconnectPort('left')
    assertEqual(pipeline.resolveUniformValue(config, 0), 0, 'disconnect must clear the aggregate value from that port')
    midiState.handleMessage([0xb0, 33, 127], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.007751937984496124, 0.00000001, 'reconnect must not resurrect old MSB')
    midiState.reset()
    assertEqual(pipeline.resolveUniformValue(config, 0), 0, 'reset must clear aggregate CC14')
    midiState.handleMessage([0xb0, 33, 127], left)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.007751937984496124, 0.00000001, 'reset must clear per-port partial bytes')
})

test('CC defaults to controller one and invalid selectors stay inert', () => {
    const { pipeline, midiState } = createTestPipeline()
    midiState.handleMessage([0xb0, 1, 127])
    midiState.handleMessage([0x90, 60, 127])
    assertEqual(pipeline.resolveUniformValue({ type: 'Midi', channel: 1, mode: 5, min: 0, max: 1 }, 0), 1, 'CC should default to controller one')
    for (const [mode, cc] of [[5, 128], [6, 32], [6, -1], [5, 0.5]]) {
        assertEqual(pipeline.resolveUniformValue({ type: 'Midi', channel: 1, mode, cc, min: 0.2, max: 1 }, 0), 0.2, 'invalid controller should be inert')
    }
    midiState.reset()
    assertEqual(pipeline.resolveUniformValue({ type: 'Midi', channel: 1, mode: 5, min: 0, max: 1 }, 0), 0, 'reset must clear CC')
})


test('CC modes reject invalid channels instead of consuming channel one', () => {
    const { pipeline, midiState } = createTestPipeline()
    midiState.handleMessage([0xb0, 1, 127])
    midiState.handleMessage([0xb0, 33, 127])
    for (const mode of [5, 6]) {
        for (const channel of [0, 17, 1.5, true, '1', undefined]) {
            assertEqual(pipeline.resolveUniformValue({ type: 'Midi', channel, mode, min: 0.2, max: 1 }, 0), 0.2,
                'invalid CC channel must never fall back to channel one')
        }
    }
})

test('pitch bend and channel/poly pressure decode full wire values independently', () => {
    const { pipeline, midiState: state } = createTestPipeline()
    const port = { id: 'expressive', name: 'Expressive' }
    state.registerPort(port)
    const read = mode => pipeline.resolveUniformValue({ type: 'Midi', channel: 2, mode, min: 0, max: 1, ...port }, 0)
    assertApprox(read(8), 8192 / 16383, 1e-12, 'bend should initialize at center')
    state.handleMessage([0xe1, 127, 127], port)
    state.handleMessage([0xd1, 91], port)
    state.handleMessage([0x91, 60, 100], port)
    state.handleMessage([0xa1, 60, 63], port)
    state.handleMessage([0xa1, 61, 127], port)
    assertEqual(read(8), 1, 'full bend')
    assertApprox(read(9), 91 / 127, 1e-12, 'two-byte pressure')
    assertApprox(read(10), 63 / 127, 1e-12, 'poly pressure should use current key')
    for (const data of [[0xe1, 128, 127], [0xe1, 0], [0xd1], [0xd1, 128], [0xa1, 60, 255]]) {
        state.handleMessage(data, port)
    }
    assertEqual(read(8), 1, 'malformed bend ignored')
    assertApprox(read(9), 91 / 127, 1e-12, 'malformed pressure ignored')
    state.handleMessage([0x81, 60, 0], port)
    assertEqual(read(10), 0, 'released key pressure cleared')
})

test('NRPN selection and data stay isolated per parameter, channel, port and RPN family', () => {
    const { pipeline, midiState: state } = createTestPipeline()
    const a = { id: 'nrpn-a', name: 'Controller' }
    const b = { id: 'nrpn-b', name: 'Controller' }
    const cc = (port, channel, controller, value) => state.handleMessage([0xb0 | (channel - 1), controller, value], port)
    const select = (port, parameter, channel = 1) => {
        cc(port, channel, 99, parameter >> 7)
        cc(port, channel, 98, parameter & 127)
    }
    const read = (parameter, port, channel = 1) => pipeline.resolveUniformValue({
        type: 'Midi', mode: 7, nrpn: parameter, channel, min: 0, max: 1, ...port
    }, 0) * 16383
    cc(a, 1, 99, 1)
    cc(a, 1, 6, 20)
    assertEqual(read(128, a), 0, 'initial selector needs both halves')
    cc(a, 1, 98, 2)
    cc(a, 1, 6, 64)
    cc(a, 1, 38, 127)
    assertApprox(read(130, a), 8319, 1e-9, 'complete NRPN data')
    select(a, 131)
    cc(a, 1, 38, 5)
    assertApprox(read(131, a), 5, 1e-9, 'new parameter cannot inherit previous MSB')
    select(a, 130)
    assertApprox(read(130, a), 8319, 1e-9, 'selector alone preserves parameter')
    cc(a, 1, 6, 32)
    assertApprox(read(130, a), 4096, 1e-9, 'Data Entry MSB clears fine byte')
    cc(a, 1, 101, 0)
    cc(a, 1, 100, 0)
    cc(a, 1, 6, 12)
    assertApprox(read(130, a), 4096, 1e-9, 'RPN data must not update NRPN')
    select(b, 130)
    cc(b, 1, 38, 7)
    assertApprox(read(130, b), 7, 1e-9, 'ports do not share data registers')
    assertApprox(read(130), 7, 1e-9, 'aggregate uses originating port complete value')
    select(a, 130, 2)
    cc(a, 2, 38, 9)
    assertApprox(read(130, a, 2), 9, 1e-9, 'channels do not share data registers')
    select(a, 16383)
    cc(a, 1, 6, 127)
    assertApprox(read(130, a), 4096, 1e-9, 'null NRPN selection is inert')
})

test('NRPN increment/decrement saturate and Reset All Controllers preserves parameter values', () => {
    const { midiState: state } = createTestPipeline()
    const cc = (controller, value) => state.handleMessage([0xb0, controller, value])
    cc(99, 0); cc(98, 3); cc(6, 127); cc(38, 127); cc(96, 92)
    const channel = state.getChannel(1)
    assertEqual(channel.nrpn.get(3), 16383, 'increment saturates at max')
    cc(97, 0)
    assertEqual(channel.nrpn.get(3), 16382, 'decrement ignores data byte')
    cc(6, 0); cc(97, 127)
    assertEqual(channel.nrpn.get(3), 0, 'decrement saturates at zero')
    cc(6, 20); cc(38, 3)
    for (const [controller, value] of [[74, 99], [7, 81], [10, 61], [1, 91], [64, 127]]) cc(controller, value)
    state.handleMessage([0xe0, 127, 127])
    state.handleMessage([0xd0, 80])
    state.handleMessage([0x90, 60, 100])
    state.handleMessage([0xa0, 60, 80])
    cc(121, 0)
    assertEqual(channel.pitchBend, 8192, 'CC121 centers bend')
    assertEqual(channel.pressure, 0, 'CC121 clears pressure')
    assertEqual(channel.polyPressure[60], 0, 'CC121 clears poly pressure')
    assertEqual(channel.cc[74], 99, 'CC121 preserves sound controls')
    assertEqual(channel.cc[7], 81, 'CC121 preserves volume')
    assertEqual(channel.cc[10], 61, 'CC121 preserves pan')
    assertEqual(channel.cc[1], 0, 'CC121 resets modulation')
    assertEqual(channel.cc[11], 127, 'CC121 restores expression')
    assertEqual(channel.cc[64], 0, 'CC121 releases sustain')
    assertEqual(channel.cc[99], 127, 'CC121 restores null selector bytes')
    assertEqual(channel.nrpn.get(3), 2563, 'CC121 preserves parameters')
    assertEqual(channel.keys[60], 100, 'CC121 must not be full note reset')
    cc(6, 90)
    assertEqual(channel.nrpn.get(3), 2563, 'CC121 nulls selectors')
})

test('MPE zones select newest held note and fall back across keys, channels and ports', () => {
    const { pipeline, midiState: state } = createTestPipeline()
    const a = { id: 'mpe-a', name: 'MPE' }
    const b = { id: 'mpe-b', name: 'MPE' }
    const read = (mode, port, extra = {}) => pipeline.resolveUniformValue({
        type: 'Midi', zone: 0, mode, cc: 74, min: 0, max: 1, ...port, ...extra
    }, 0)
    state.handleMessage([0xe1, 0, 96], a)
    state.handleMessage([0x91, 60, 80], a)
    state.handleMessage([0xa1, 60, 40], a)
    assertApprox(read(8, a), 12288 / 16383, 1e-12, 'expression before NoteOn is retained')
    state.handleMessage([0x91, 62, 100], a)
    state.handleMessage([0xa1, 62, 70], a)
    assertApprox(read(0, a), 62 / 127, 1e-12, 'newest key on one member wins')
    state.handleMessage([0x81, 62, 0], a)
    assertApprox(read(0, a), 60 / 127, 1e-12, 'fall back to another held key on member')
    assertApprox(read(10, a), 40 / 127, 1e-12, 'fallback uses that key pressure')
    state.handleMessage([0x92, 67, 110], a)
    state.handleMessage([0xb2, 74, 100], a)
    state.handleMessage([0x92, 70, 120], b)
    state.handleMessage([0xb2, 74, 10], b)
    assertApprox(read(5), 10 / 127, 1e-12, 'aggregate follows newest port without mixing expression')
    assertApprox(read(5, a), 100 / 127, 1e-12, 'exact port stays isolated')
    state.handleMessage([0x82, 70, 0], b)
    assertApprox(read(0), 67 / 127, 1e-12, 'released newest port falls back')
    state.handleMessage([0xb2, 64, 127], a)
    state.handleMessage([0x92, 67, 0], a)
    assertApprox(read(0, a), 60 / 127, 1e-12, 'velocity-zero release ignores sustain for selection')
    state.handleMessage([0xb1, 123, 0], a)
    assertEqual(read(8, a), 0, 'no held notes resolves to min even for centered bend')
    state.handleMessage([0x91, 64, 100], a)
    state.handleMessage([0xb1, 120, 0], a)
    assertEqual(read(0, a), 0, 'All Sound Off clears held notes')
})

test('MPE RPN6 detection handles overlap, deactivation and explicit member overrides', () => {
    const { pipeline, midiState: state } = createTestPipeline()
    const port = { id: 'zones', name: 'Zones' }
    const config = (master, count) => {
        for (const [controller, value] of [[101, 0], [100, 6], [6, count]]) {
            state.handleMessage([0xb0 | (master - 1), controller, value], port)
        }
    }
    const read = (zone, members) => pipeline.resolveUniformValue({
        type: 'Midi', mode: 0, zone, ...(members === undefined ? {} : { members }), min: 0, max: 1, ...port
    }, 0)
    config(1, 10)
    state.handleMessage([0x9a, 70, 100], port)
    assertApprox(read(0), 70 / 127, 1e-12, 'lower detected member channel11')
    config(16, 8)
    assertEqual(read(0), 0, 'overlapping upper zone clears reassigned held notes')
    state.handleMessage([0x97, 66, 100], port)
    assertEqual(read(0), 0, 'lower shrinks to channels2..7')
    assertApprox(read(1), 66 / 127, 1e-12, 'upper owns channel8')
    assertApprox(read(0, 15), 66 / 127, 1e-12, 'explicit members overrides discovery')
    config(16, 0)
    state.handleMessage([0x9e, 71, 100], port)
    assertEqual(read(1), 0, 'received zero count disables detected zone')
    assertApprox(read(1, 1), 71 / 127, 1e-12, 'explicit upper selection still works')
    config(1, 15)
    state.handleMessage([0x9f, 72, 100], port)
    assertApprox(read(0), 72 / 127, 1e-12, 'single lower zone can consume channel16')
})

test('disconnect and full reset clear expression, NRPN and aggregate origins', () => {
    const { midiState: state } = createTestPipeline()
    const port = { id: 'reset-expression', name: 'Reset' }
    for (const data of [[0xb1, 99, 0], [0xb1, 98, 1], [0xb1, 6, 100], [0xe1, 127, 127], [0xd1, 90], [0x91, 60, 100]]) {
        state.handleMessage(data, port)
    }
    state.disconnectPort(port.id)
    const aggregate = state.getChannel(2)
    assertEqual(aggregate.pitchBend, 8192, 'disconnected bend origin clears')
    assertEqual(aggregate.pressure, 0, 'disconnected pressure origin clears')
    assertEqual(aggregate.nrpn.size, 0, 'disconnected parameter origin clears')
    assertEqual(aggregate.heldNotes.size, 0, 'disconnected held-note origin clears')
    state.handleMessage([0xb1, 38, 127], port)
    assertEqual(state.getPortState(port).getChannel(2).nrpn.size, 0, 'reconnection has no selector')
    state.handleMessage([0x91, 60, 100], port)
    state.reset()
    assertEqual(state.getZoneVoice({ zone: 0 }), null, 'full reset clears held voices')
    assertEqual(state.getPortState(port).getChannel(2).pitchBend, 8192, 'reset bend centered')
})

test('zone configuration resets aggregate expression only for the originating port', () => {
    const { midiState: state } = createTestPipeline()
    const a = { id: 'config-a', name: 'A' }
    const b = { id: 'config-b', name: 'B' }
    state.handleMessage([0xe1, 127, 127], a)
    state.handleMessage([0xd1, 100], a)
    state.handleMessage([0x91, 60, 100], a)
    state.handleMessage([0xe2, 0, 32], b)
    state.handleMessage([0x92, 62, 100], b)
    for (const [cc, value] of [[101, 0], [100, 6], [6, 3]]) state.handleMessage([0xb0, cc, value], a)
    assertEqual(state.getChannel(2).pitchBend, 8192, 'MCM clears aggregate bend from reset member')
    assertEqual(state.getChannel(2).pressure, 0, 'MCM clears aggregate pressure from reset member')
    assertEqual(state.getChannel(2).heldNotes.size, 0, 'MCM clears aggregate held note from reset member')
    assertEqual(state.getChannel(3).pitchBend, 4096, 'another port expression is preserved')
    assertEqual(state.getPortState(b).getChannel(3).heldNotes.size, 1, 'another port voice is preserved')
    assertEqual(state.getPortState(a).getChannel(2).cc[74], 64, 'MCM uses neutral adapter timbre default')
})

test('new expression modes keep invalid runtime selectors inert', () => {
    const { pipeline, midiState: state } = createTestPipeline()
    state.handleMessage([0x91, 60, 100])
    state.handleMessage([0xd1, 127])
    for (const fields of [
        { channel: 17, mode: 8 }, { channel: 0, mode: 9 }, { channel: 1.5, mode: 10 },
        { channel: 2, mode: 7, nrpn: 16383 }, { zone: 0, channel: 2, mode: 9 },
        { zone: 2, mode: 9 }, { zone: 0, members: 16, mode: 9 }, { channel: 2, members: 2, mode: 9 }
    ]) {
        assertEqual(pipeline.resolveUniformValue({ type: 'Midi', min: 0.2, max: 1, ...fields }, 0), 0.2,
            'invalid descriptor must not fall back to another route')
    }
})

test('port resets preserve unscoped expression and other-port same-key pressure', () => {
    const { midiState: state } = createTestPipeline()
    const a = { id: 'origin-a', name: 'A' }
    const b = { id: 'origin-b', name: 'B' }
    state.handleMessage([0xd1, 100])
    state.handleMessage([0xb1, 1, 100])
    state.handleMessage([0xb1, 121, 0], a)
    assertEqual(state.getChannel(2).pressure, 100, 'unscoped origin differs from unowned default')
    assertEqual(state.getChannel(2).cc[1], 100, 'reset must preserve unscoped CC')
    state.handleMessage([0x91, 60, 80], a)
    state.handleMessage([0x91, 60, 100], b)
    state.handleMessage([0xa1, 60, 99], b)
    state.handleMessage([0x81, 60, 0], a)
    assertEqual(state.getChannel(2).polyPressure[60], 99, 'other-port NoteOff must not erase pressure')
    assertEqual(state.getChannel(2).heldNotes.get(60).velocity, 100, 'other-port NoteOff must not erase held identity')
})

test('MPE activation resets the manager while keeping the RPN6 transaction usable', () => {
    const { midiState: state } = createTestPipeline()
    const port = { id: 'manager-reset', name: 'Manager' }
    state.handleMessage([0xd0, 95], port)
    state.handleMessage([0xb0, 74, 99], port)
    state.handleMessage([0x90, 60, 100], port)
    for (const [cc, value] of [[101, 0], [100, 6], [6, 2]]) state.handleMessage([0xb0, cc, value], port)
    const scoped = state.getPortState(port)
    assertEqual(scoped.getChannel(1).pressure, 0, 'new manager pressure clears')
    assertEqual(scoped.getChannel(1).cc[74], 64, 'new manager timbre is neutral')
    assertEqual(scoped.getChannel(1).heldNotes.size, 0, 'new manager old note clears')
    assertEqual(scoped.getChannel(1).cc[100], 6, 'MCM does not null active RPN selector')
    state.handleMessage([0xb0, 6, 4], port)
    assertEqual(scoped.mpeZones.lower, 4, 'subsequent Data Entry resizes the zone')
})

test('keyless noteOff clears held voices in the public channel API', () => {
    const state = new MidiState({ portRegistry: false })
    state.getChannel(2).noteOn(60, 100)
    state.getChannel(2).noteOn(64, 100)
    state.getChannel(2).noteOff()
    assertEqual(state.getZoneVoice({ zone: 0 }), null, 'keyless release clears held voices')
    assertEqual(state.getChannel(2).key, 64, 'last note reference retained')
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
