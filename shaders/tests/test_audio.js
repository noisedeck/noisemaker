/**
 * Tests for Audio Evaluation in the Pipeline
 *
 * Tests the evaluateAudio() function and Audio integration with resolveUniformValue().
 */

import { Pipeline } from '../src/runtime/pipeline.js'
import { AudioState } from '../src/runtime/external-input.js'
import { registerEffect } from '../src/runtime/registry.js'

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

// Helper to create a test pipeline with Audio state
function createTestPipeline() {
    const pipeline = new Pipeline(null, null)
    const audioState = new AudioState()
    pipeline.setAudioState(audioState)
    return { pipeline, audioState }
}

test('compiled pipelines expose deduplicated audio input requirements', () => {
    const aggregate = { type: 'Audio', band: 0, min: 0, max: 1 }
    const selected = {
        type: 'Audio', band: 4, min: 0, max: 1,
        channel: 7, name: 'Interface', id: 'interface-b'
    }
    const selectedFft = { ...selected, band: 0 }
    const nameOnly = {
        type: 'Audio', band: 1, min: 0, max: 1,
        channel: 2, name: 'Unique Interface'
    }
    const pipeline = new Pipeline({
        passes: [
            { uniforms: { scale: aggregate, rotation: selectedFft } },
            { uniforms: { repeated: selected, nested: [nameOnly] } }
        ]
    }, null)

    const requirements = pipeline.getAudioInputRequirements()
    assertEqual(requirements.needsLegacy, true, 'aggregate audio should require legacy capture')
    assertEqual(requirements.needsLegacyRaw, false, 'non-raw aggregate audio should not require raw capture')
    assertEqual(JSON.stringify(requirements.selected), JSON.stringify([
        { id: 'interface-b', name: 'Interface', channel: 7, needsRaw: true },
        { id: null, name: 'Unique Interface', channel: 2, needsRaw: false }
    ]), 'selected requirements should retain identity and channel without pass duplicates')
})

test('compiled pipelines flag aggregate raw input requirements', () => {
    const pipeline = new Pipeline({
        passes: [{ uniforms: { scale: { type: 'Audio', band: 4, min: 0, max: 1 } } }]
    }, null)
    const requirements = pipeline.getAudioInputRequirements()
    assertEqual(requirements.needsLegacy, true, 'raw audio should require legacy capture')
    assertEqual(requirements.needsLegacyRaw, true, 'raw audio should require a signed-sample worklet')
})

test('compiled pipelines expose legacy capture for audio-tagged effects', () => {
    registerEffect('test.audioTagged', {
        name: 'Audio tagged test effect',
        namespace: 'test',
        func: 'audioTagged',
        tags: ['audio'],
        passes: []
    })
    const pipeline = new Pipeline({
        passes: [{ effectKey: 'test.audioTagged', nodeId: 'audio_tagged_0', uniforms: {} }]
    }, null)
    const requirements = pipeline.getAudioInputRequirements()

    assertEqual(requirements.needsLegacy, true, 'audio-tagged effects should be represented by compiled requirements')
    assertEqual(requirements.needsLegacyRaw, false, 'audio-tagged effects should not imply raw capture')
})

test('compiled pipelines do not reinterpret malformed selectors as legacy audio', () => {
    const invalidSelected = {
        type: 'Audio', band: 4, min: 0, max: 1,
        name: 'Interface',
        _ast: {
            type: 'Audio',
            band: { type: 'Member', path: ['audioBand', 'raw'] },
            channel: { type: 'Number', value: 0 },
            name: { type: 'String', value: 'Interface' }
        }
    }
    const pipeline = new Pipeline({ passes: [{ uniforms: { scale: invalidSelected } }] }, null)
    const requirements = pipeline.getAudioInputRequirements()

    assertEqual(requirements.needsLegacy, false, 'invalid selector should not open the default microphone')
    assertEqual(requirements.needsLegacyRaw, false, 'invalid selector should not open default raw capture')
    assertEqual(requirements.selected.length, 0, 'invalid selector should request no selected capture')
})

test('invalid audio configurations never consume live aggregate state', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.low = 0.8
    const invalid = {
        type: 'Audio', band: 0, min: 0.2, max: 0.9,
        _invalid: true
    }

    assertApprox(pipeline.resolveUniformValue(invalid, 0), 0.2, 0.001,
        'diagnosed audio config should remain inert at min')
})

test('raw audio maps bipolar full scale across min and max', () => {
    const { pipeline, audioState } = createTestPipeline()
    const config = { type: 'Audio', band: 4, min: 0.2, max: 0.8 }

    audioState.setRaw(-1)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.2, 0.001,
        'negative full scale should map to min')
    audioState.setRaw(0)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.5, 0.001,
        'zero signal should map to midpoint')
    audioState.setRaw(1)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.8, 0.001,
        'positive full scale should map to max')
})

test('aggregate raw audio stays at min until a signed sample is available', () => {
    const { pipeline, audioState } = createTestPipeline()
    const config = { type: 'Audio', band: 4, min: 0.2, max: 0.8 }

    assertApprox(pipeline.resolveUniformValue(config, 0), 0.2, 0.001,
        'unavailable raw input should fail closed at min')
    audioState.setRaw(0)
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.5, 0.001,
        'an actual zero sample should map to the midpoint')
    audioState.setRawUnavailable()
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.2, 0.001,
        'losing raw processing should return to min')
})

test('selected raw audio stays at min until that channel receives a sample', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.registerDevice({ id: 'a', name: 'Interface', channelCount: 1 })
    const config = {
        type: 'Audio', band: 4, min: 0.2, max: 0.8,
        channel: 1, name: 'Interface', id: 'a'
    }

    assertApprox(pipeline.resolveUniformValue(config, 0), 0.2, 0.001,
        'registered channel without raw processing should fail closed')
    audioState.setChannelValues('a', 1, { raw: 0 })
    assertApprox(pipeline.resolveUniformValue(config, 0), 0.5, 0.001,
        'a real selected-channel zero sample should map to midpoint')
})

test('selected audio resolves only the requested device channel', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.low = 0.1
    audioState.registerDevice({ id: 'a', name: 'Interface', channelCount: 2 })
    audioState.registerDevice({ id: 'b', name: 'Interface', channelCount: 2 })
    audioState.setChannelValues('a', 2, { low: 0.35, raw: -0.5 })
    audioState.setChannelValues('b', 2, { low: 0.85, raw: 0.5 })

    const selectedBand = {
        type: 'Audio', band: 0, min: 0, max: 1,
        channel: 2, name: 'Interface', id: 'b'
    }
    assertApprox(pipeline.resolveUniformValue(selectedBand, 0), 0.85, 0.001,
        'exact device id should be authoritative')

    const selectedRaw = { ...selectedBand, band: 4 }
    assertApprox(pipeline.resolveUniformValue(selectedRaw, 0), 0.75, 0.001,
        'selected bipolar raw value should map to 0..1')
    assertApprox(pipeline.resolveUniformValue({ type: 'Audio', band: 0, min: 0, max: 1 }, 0), 0.1, 0.001,
        'legacy aggregate audio should remain unchanged')
})

test('missing or ambiguous selected audio resolves to min without fallback', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.low = 1
    audioState.registerDevice({ id: 'a', name: 'Duplicate', channelCount: 1 })
    audioState.registerDevice({ id: 'b', name: 'Duplicate', channelCount: 1 })
    audioState.setChannelValues('a', 1, { low: 1 })
    audioState.setChannelValues('b', 1, { low: 1 })

    const missing = {
        type: 'Audio', band: 0, min: 0.25, max: 0.75,
        channel: 1, name: 'Missing', id: 'gone'
    }
    assertApprox(pipeline.resolveUniformValue(missing, 0), 0.25, 0.001,
        'missing exact id should be inert at min')

    const ambiguous = {
        type: 'Audio', band: 0, min: 0.25, max: 0.75,
        channel: 1, name: 'Duplicate'
    }
    assertApprox(pipeline.resolveUniformValue(ambiguous, 0), 0.25, 0.001,
        'ambiguous name-only selector should be inert at min')
})

// ============================================================================
// Audio Band: low (band 0)
// ============================================================================

console.log('\n=== Audio Band: low (0) ===\n')

test('low band returns low frequency value', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.low = 0.7

    const config = {
        type: 'Audio',
        band: 0,  // low
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 0.7, 0.01, 'should return low band value')
})

test('low band maps to non-trivial percentage range', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.low = 0.5

    const config = {
        type: 'Audio',
        band: 0,  // low
        min: 0.2,
        max: 0.8
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // pct = 0.2 + 0.5 * (0.8 - 0.2) = 0.5
    assertApprox(result, 0.5, 0.01, 'should map to percentage range')
})

// ============================================================================
// Audio Band: mid (band 1)
// ============================================================================

console.log('\n=== Audio Band: mid (1) ===\n')

test('mid band returns mid frequency value', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.mid = 0.4

    const config = {
        type: 'Audio',
        band: 1,  // mid
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 0.4, 0.01, 'should return mid band value')
})

test('mid band maps to non-trivial percentage range', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.mid = 1.0

    const config = {
        type: 'Audio',
        band: 1,  // mid
        min: 0.3,
        max: 0.7
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // pct = 0.3 + 1.0 * (0.7 - 0.3) = 0.7
    assertApprox(result, 0.7, 0.01, 'should map to percentage range')
})

// ============================================================================
// Audio Band: high (band 2)
// ============================================================================

console.log('\n=== Audio Band: high (2) ===\n')

test('high band returns high frequency value', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.high = 0.9

    const config = {
        type: 'Audio',
        band: 2,  // high
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 0.9, 0.01, 'should return high band value')
})

test('high band maps to non-trivial percentage range', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.high = 0.0

    const config = {
        type: 'Audio',
        band: 2,  // high
        min: 0.1,
        max: 0.9
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // pct = 0.1 + 0.0 * (0.9 - 0.1) = 0.1
    assertApprox(result, 0.1, 0.01, 'should map to percentage range')
})

// ============================================================================
// Audio Band: vol (band 3)
// ============================================================================

console.log('\n=== Audio Band: vol (3) ===\n')

test('vol band returns overall volume', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.vol = 0.65

    const config = {
        type: 'Audio',
        band: 3,  // vol
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertApprox(result, 0.65, 0.01, 'should return vol value')
})

test('vol band maps to non-trivial percentage range', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.vol = 0.5

    const config = {
        type: 'Audio',
        band: 3,  // vol
        min: 0.0,
        max: 0.5
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // pct = 0.0 + 0.5 * (0.5 - 0.0) = 0.25
    assertApprox(result, 0.25, 0.01, 'should map to percentage range')
})

// ============================================================================
// Percentage Scaling Tests
// ============================================================================

console.log('\n=== Percentage Scaling ===\n')

test('resolveUniformValue scales percentage by paramSpec', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.low = 0.5

    const config = {
        type: 'Audio',
        band: 0,  // low
        min: 0,   // 0% (percentage)
        max: 1    // 100% (percentage)
    }
    const paramSpec = { min: 10, max: 50 }

    const result = pipeline.resolveUniformValue(config, 0, paramSpec)
    // audio raw = 0.5, pct = 0 + 0.5 * 1 = 0.5, output = 10 + 0.5 * 40 = 30
    assertApprox(result, 30, 0.01, 'should scale percentage by paramSpec')
})

test('resolveUniformValue with partial percentage range', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.low = 0.5

    const config = {
        type: 'Audio',
        band: 0,
        min: 0.25,  // 25%
        max: 0.75   // 75%
    }
    const paramSpec = { min: 0, max: 100 }

    const result = pipeline.resolveUniformValue(config, 0, paramSpec)
    // audio raw = 0.5, pct = 0.25 + 0.5 * 0.5 = 0.5, output = 0 + 0.5 * 100 = 50
    assertApprox(result, 50, 0.01, 'should scale partial percentage by paramSpec')
})

test('resolveUniformValue without paramSpec returns raw percentage', () => {
    const { pipeline, audioState } = createTestPipeline()
    audioState.low = 0.5

    const config = {
        type: 'Audio',
        band: 0,
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // No paramSpec, returns raw percentage
    assertApprox(result, 0.5, 0.01, 'should return raw percentage without paramSpec')
})

// ============================================================================
// Edge Cases
// ============================================================================

console.log('\n=== Edge Cases ===\n')

test('audio returns min when no audio state set', () => {
    const pipeline = new Pipeline(null, null)
    // No audio state set

    const config = {
        type: 'Audio',
        band: 0,
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 0, 'should return 0% when no audio state')
})

test('audio handles zero values', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.low = 0

    const config = {
        type: 'Audio',
        band: 0,
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 0, 'should return 0 for zero audio level')
})

test('audio handles max values', () => {
    const { pipeline, audioState } = createTestPipeline()

    audioState.mid = 1.0

    const config = {
        type: 'Audio',
        band: 1,
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 1, 'should return 1 for max audio level')
})

test('audio clamps values above 1', () => {
    const { pipeline, audioState } = createTestPipeline()

    // Simulate audio spike above 1.0
    audioState.high = 1.5

    const config = {
        type: 'Audio',
        band: 2,
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    // rawValue clamped to 1.0, percentage = 0 + 1.0 * 1 = 1.0
    assertEqual(result, 1, 'should clamp to max percentage for values > 1')
})

test('audio defaults band values correctly', () => {
    const { pipeline } = createTestPipeline()

    // AudioState initializes all bands to 0
    const config = {
        type: 'Audio',
        band: 0,
        min: 0,
        max: 1
    }

    const result = pipeline.resolveUniformValue(config, 0)
    assertEqual(result, 0, 'should return 0 for default audio state')
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
