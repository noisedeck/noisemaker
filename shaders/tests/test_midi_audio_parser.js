/**
 * Tests for midi() and audio() Parser Integration
 *
 * Tests parsing, validation, and unparsing of midi() and audio() functions.
 */

import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { registerStarterOps } from '../src/lang/validator.js'
import { compile, unparse } from '../src/lang/index.js'
import { formatValue } from '../src/lang/unparser.js'
import { registerOp } from '../src/lang/ops.js'
import { compileGraph } from '../src/runtime/compiler.js'
import { Pipeline } from '../src/runtime/pipeline.js'
import { registerEffect } from '../src/runtime/registry.js'

// Register test ops
registerOp('synth.noise', {
    name: 'noise',
    args: [
        { name: 'scale', type: 'float', default: 10 },
        { name: 'rotation', type: 'float', default: 0 }
    ]
})

registerEffect('synth.noise', {
    name: 'Noise',
    namespace: 'synth',
    func: 'noise',
    globals: {
        scale: { type: 'float', default: 10 },
        rotation: { type: 'float', default: 0 }
    },
    passes: [{
        name: 'main',
        type: 'render',
        program: 'noise',
        inputs: {},
        outputs: { color: 'outputTex' }
    }]
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

// ============================================================================
// midi() Parsing Tests
// ============================================================================

console.log('\n=== midi() Parsing ===\n')

test('parses midi with channel only', () => {
    const tokens = lex('search synth\nnoise(scale: midi(channel: 1)).write(o0)')
    const ast = parse(tokens)

    // Find the midi node in the AST
    const chain = ast.plans[0].chain
    const noiseCall = chain[0]
    const scaleArg = noiseCall.kwargs.scale

    assertEqual(scaleArg.type, 'Midi', 'should create Midi node')
    assertEqual(scaleArg.channel.value, 1, 'channel should be 1')
    // Default mode should be midiMode.velocity
    assertEqual(scaleArg.mode.type, 'Member', 'mode should be Member node')
    assertEqual(scaleArg.mode.path[1], 'velocity', 'default mode should be velocity')
})

test('parses midi with all parameters', () => {
    const tokens = lex('search synth\nnoise(scale: midi(channel: 5, mode: midiMode.gateNote, min: 0.2, max: 0.8, sensitivity: 3)).write(o0)')
    const ast = parse(tokens)

    const chain = ast.plans[0].chain
    const noiseCall = chain[0]
    const scaleArg = noiseCall.kwargs.scale

    assertEqual(scaleArg.type, 'Midi', 'should create Midi node')
    assertEqual(scaleArg.channel.value, 5, 'channel should be 5')
    assertEqual(scaleArg.mode.path[1], 'gateNote', 'mode should be gateNote')
    assertEqual(scaleArg.min.value, 0.2, 'min should be 0.2')
    assertEqual(scaleArg.max.value, 0.8, 'max should be 0.8')
    assertEqual(scaleArg.sensitivity.value, 3, 'sensitivity should be 3')
})

test('parses midi port name and id as keyword-only string fields', () => {
    const tokens = lex('search synth\nnoise(scale: midi(channel: 5, name: "Launch Control XL", id: "port-2")).write(o0)')
    const ast = parse(tokens)

    const scaleArg = ast.plans[0].chain[0].kwargs.scale
    assertEqual(scaleArg.name.type, 'String', 'name should be a String node')
    assertEqual(scaleArg.name.value, 'Launch Control XL', 'name should preserve the readable port name')
    assertEqual(scaleArg.id.type, 'String', 'id should be a String node')
    assertEqual(scaleArg.id.value, 'port-2', 'id should preserve the unique port id')
})

test('parses midi with positional arguments', () => {
    const tokens = lex('search synth\nnoise(scale: midi(1, midiMode.velocity, 0, 0.8)).write(o0)')
    const ast = parse(tokens)

    const chain = ast.plans[0].chain
    const noiseCall = chain[0]
    const scaleArg = noiseCall.kwargs.scale

    assertEqual(scaleArg.type, 'Midi', 'should create Midi node')
    assertEqual(scaleArg.channel.value, 1, 'channel should be 1')
    assertEqual(scaleArg.max.value, 0.8, 'max should be 0.8')
})

test('parses MIDI identity after positional descriptor arguments', () => {
    const result = compile(
        'search synth\nnoise(scale: midi(1, 0, 0.2, 0.8, 3, name: "Controller", id: "port-id")).write(o0)'
    )
    const config = result.plans[0].chain[0].args.scale
    assertEqual(config.channel, 1, 'channel should stay positional')
    assertEqual(config.mode, 0, 'numeric mode should stay positional')
    assertEqual(config.name, 'Controller', 'name should compile')
    assertEqual(config.id, 'port-id', 'id should compile')
})

test('parses the exact identity-first mixed form emitted by Noisedeck', () => {
    const result = compile(
        'search synth\nnoise(scale: midi(name: "Controller", id: "port-id", 2, 1, 0.25, 0.75, 2)).write(o0)'
    )
    const config = result.plans[0].chain[0].args.scale
    assertEqual(config.channel, 2, 'channel should compile after identity kwargs')
    assertEqual(config.mode, 1, 'numeric mode should compile after identity kwargs')
    assertEqual(config.min, 0.25, 'min should compile after identity kwargs')
    assertEqual(config.max, 0.75, 'max should compile after identity kwargs')
    assertEqual(config.sensitivity, 2, 'sensitivity should compile after identity kwargs')
})

test('non-MIDI calls still reject mixed positional and keyword arguments', () => {
    let threw = false
    try {
        parse(lex('search synth\nnoise(scale: 1, 2).write(o0)'))
    } catch (e) {
        threw = true
        assert(e.message.includes('Cannot mix positional and keyword arguments'),
            'global DSL rule should remain intact outside midi()')
    }
    assert(threw, 'non-MIDI calls must still reject mixed arguments')
})

test('midi throws on missing channel', () => {
    const tokens = lex('search synth\nnoise(scale: midi()).write(o0)')
    let threw = false
    try {
        parse(tokens)
    } catch (e) {
        threw = true
        assert(e.message.includes('channel'), 'should mention channel')
    }
    assert(threw, 'should throw on missing channel')
})

test('midi rejects id without a readable name', () => {
    let threw = false
    try {
        parse(lex('search synth\nnoise(scale: midi(channel: 1, id: "port-2")).write(o0)'))
    } catch (e) {
        threw = true
        assert(e.message.includes('name'), 'should explain that id requires name')
    }
    assert(threw, 'should reject id without name')
})

test('midi rejects variable-backed device identity strings', () => {
    let threw = false
    try {
        parse(lex(`search synth
let portName = "Launch Control XL"
noise(scale: midi(channel: 1, name: portName)).write(o0)`))
    } catch (e) {
        threw = true
        assert(e.message.includes('quoted string'), 'should require a direct quoted string')
    }
    assert(threw, 'should reject a variable-backed MIDI name')
})

test('midi rejects empty device identity strings', () => {
    for (const source of [
        'search synth\nnoise(scale: midi(channel: 1, name: "")).write(o0)',
        'search synth\nnoise(scale: midi(channel: 1, name: "Controller", id: "")).write(o0)'
    ]) {
        let threw = false
        try {
            parse(lex(source))
        } catch (e) {
            threw = true
            assert(e.message.includes('must not be empty'), 'should explain that identity cannot be empty')
        }
        assert(threw, 'should reject empty MIDI identity')
    }
})

test('midi keeps name and id keyword-only', () => {
    let threw = false
    try {
        parse(lex('search synth\nnoise(scale: midi(1, midiMode.velocity, 0, 1, 1, "Launch Control XL", "port-2")).write(o0)'))
    } catch (e) {
        threw = true
        assert(e.message.includes('keyword'), 'should explain that name and id are keyword-only')
    }
    assert(threw, 'should reject positional name and id')
})

test('midi rejects mixed keyword and positional overflow', () => {
    let threw = false
    try {
        parse(lex('search synth\nnoise(scale: midi(channel: 1, midiMode.velocity, 0, 1, 1, 99)).write(o0)'))
    } catch (e) {
        threw = true
        assert(e.message.includes('positional'), 'should explain that a positional argument is excess')
    }
    assert(threw, 'should not silently discard an unconsumed positional argument')
})

// ============================================================================
// audio() Parsing Tests
// ============================================================================

console.log('\n=== audio() Parsing ===\n')

test('parses audio with band only', () => {
    const tokens = lex('search synth\nnoise(scale: audio(band: audioBand.low)).write(o0)')
    const ast = parse(tokens)

    const chain = ast.plans[0].chain
    const noiseCall = chain[0]
    const scaleArg = noiseCall.kwargs.scale

    assertEqual(scaleArg.type, 'Audio', 'should create Audio node')
    assertEqual(scaleArg.band.path[1], 'low', 'band should be low')
    assertEqual(scaleArg.min.value, 0, 'default min should be 0')
    assertEqual(scaleArg.max.value, 1, 'default max should be 1')
})

test('parses audio with all parameters', () => {
    const tokens = lex('search synth\nnoise(scale: audio(band: audioBand.mid, min: 0.1, max: 0.9)).write(o0)')
    const ast = parse(tokens)

    const chain = ast.plans[0].chain
    const noiseCall = chain[0]
    const scaleArg = noiseCall.kwargs.scale

    assertEqual(scaleArg.type, 'Audio', 'should create Audio node')
    assertEqual(scaleArg.band.path[1], 'mid', 'band should be mid')
    assertEqual(scaleArg.min.value, 0.1, 'min should be 0.1')
    assertEqual(scaleArg.max.value, 0.9, 'max should be 0.9')
})

test('parses audio with positional arguments', () => {
    const tokens = lex('search synth\nnoise(scale: audio(audioBand.high, 0, 0.5)).write(o0)')
    const ast = parse(tokens)

    const chain = ast.plans[0].chain
    const noiseCall = chain[0]
    const scaleArg = noiseCall.kwargs.scale

    assertEqual(scaleArg.type, 'Audio', 'should create Audio node')
    assertEqual(scaleArg.band.path[1], 'high', 'band should be high')
    assertEqual(scaleArg.max.value, 0.5, 'max should be 0.5')
})

test('parses selected audio device and channel as keyword-only fields', () => {
    const result = compile(
        'search synth\nnoise(scale: audio(band: audioBand.raw, channel: 2, name: "ES-9", id: "audio-port-2")).write(o0)'
    )
    const config = result.plans[0].chain[0].args.scale
    assertEqual(config.band, 4, 'raw should compile as audio band 4')
    assertEqual(config.channel, 2, 'channel should compile as one-based channel 2')
    assertEqual(config.name, 'ES-9', 'readable device name should compile')
    assertEqual(config.id, 'audio-port-2', 'exact device id should compile')
})

test('parses audio identity after positional descriptor arguments', () => {
    const result = compile(
        'search synth\nnoise(scale: audio(audioBand.high, 0.2, 0.8, channel: 3, name: "Interface", id: "port-id")).write(o0)'
    )
    const config = result.plans[0].chain[0].args.scale
    assertEqual(config.band, 2, 'positional band should remain high')
    assertEqual(config.min, 0.2, 'positional min should remain intact')
    assertEqual(config.max, 0.8, 'positional max should remain intact')
    assertEqual(config.channel, 3, 'keyword channel should compile')
})

test('parses dense audio positionals after a keyword band', () => {
    const result = compile(
        'search synth\nnoise(scale: audio(band: audioBand.raw, 0.25, 0.75, channel: 2, name: "Interface")).write(o0)'
    )
    const config = result.plans[0].chain[0].args.scale
    assertEqual(config.band, 4, 'keyword band should remain raw')
    assertEqual(config.min, 0.25, 'first positional should fill min')
    assertEqual(config.max, 0.75, 'second positional should fill max')
})

test('audio rejects mixed keyword and positional overflow', () => {
    let threw = false
    try {
        parse(lex(
            'search synth\nnoise(scale: audio(band: audioBand.raw, 0.25, 0.75, 99, channel: 2, name: "Interface")).write(o0)'
        ))
    } catch (e) {
        threw = true
        assert(e.message.includes('positional'), 'should explain that a positional argument is excess')
    }
    assert(threw, 'should not silently discard an unconsumed positional argument')
})

test('audio requires device name and channel together, and id requires name', () => {
    for (const source of [
        'search synth\nnoise(scale: audio(band: audioBand.low, channel: 1)).write(o0)',
        'search synth\nnoise(scale: audio(band: audioBand.low, name: "Interface")).write(o0)',
        'search synth\nnoise(scale: audio(band: audioBand.low, channel: 1, id: "port-id")).write(o0)'
    ]) {
        let threw = false
        try {
            parse(lex(source))
        } catch (e) {
            threw = true
            assert(e.message.includes('name') || e.message.includes('channel'),
                'should explain the missing selector field')
        }
        assert(threw, 'incomplete audio device selector should fail')
    }
})

test('audio keeps channel, name and id keyword-only', () => {
    let threw = false
    try {
        parse(lex('search synth\nnoise(scale: audio(audioBand.low, 0, 1, 2, "Interface", "port-id")).write(o0)'))
    } catch (e) {
        threw = true
        assert(e.message.includes('keyword'), 'should explain that selector fields are keyword-only')
    }
    assert(threw, 'positional audio selector fields should fail')
})

test('audio throws on missing band', () => {
    const tokens = lex('search synth\nnoise(scale: audio()).write(o0)')
    let threw = false
    try {
        parse(tokens)
    } catch (e) {
        threw = true
        assert(e.message.includes('band'), 'should mention band')
    }
    assert(threw, 'should throw on missing band')
})

// ============================================================================
// Validation Tests
// ============================================================================

console.log('\n=== Validation ===\n')

test('validates midi() and creates runtime config', () => {
    const result = compile('search synth\nnoise(scale: midi(channel: 1)).write(o0)')

    // Find the compiled step
    const step = result.plans[0].chain[0]
    assert(step.args, 'should have args')

    const scaleArg = step.args.scale
    assert(scaleArg, 'should have scale arg')
    assertEqual(scaleArg.type, 'Midi', 'should have midi type')
    assertEqual(scaleArg.channel, 1, 'should have channel')
    assertEqual(scaleArg.mode, 4, 'should have velocity mode (4)')
})

test('validates allowlisted midi port strings into the runtime config', () => {
    const result = compile('search synth\nnoise(scale: midi(channel: 1, name: "Launch Control XL", id: "port-2")).write(o0)')
    assertEqual(result.diagnostics.length, 0, 'allowlisted midi strings should compile cleanly')

    const scaleArg = result.plans[0].chain[0].args.scale
    assertEqual(scaleArg.name, 'Launch Control XL', 'runtime config should retain port name')
    assertEqual(scaleArg.id, 'port-2', 'runtime config should retain port id')
})

test('midi port identity decodes escaped DSL strings and formats them stably', () => {
    const name = 'Launch "Control" \\ XL'
    const id = 'port\\two'
    const source = `search synth\nnoise(scale: midi(channel: 1, name: ${JSON.stringify(name)}, id: ${JSON.stringify(id)})).write(o0)`
    const result = compile(source)
    const config = result.plans[0].chain[0].args.scale

    assertEqual(config.name, name, 'runtime config should decode the device name')
    assertEqual(config.id, id, 'runtime config should decode the device id')

    const formatted = formatValue(config)
    assert(formatted.includes(`name: ${JSON.stringify(name)}`), 'formatter should preserve escaped name')
    assert(formatted.includes(`id: ${JSON.stringify(id)}`), 'formatter should preserve escaped id')

    const reparsed = compile(`search synth\nnoise(scale: ${formatted}).write(o0)`)
    const reparsedConfig = reparsed.plans[0].chain[0].args.scale
    assertEqual(reparsedConfig.name, name, 'formatted name should compile back to the same value')
    assertEqual(reparsedConfig.id, id, 'formatted id should compile back to the same value')
})

test('rejects non-string midi port identity fields', () => {
    let threw = false
    try {
        compile('search synth\nnoise(scale: midi(channel: 1, name: 2, id: 3)).write(o0)')
    } catch (e) {
        threw = true
        assert(e.message.includes("'name' requires a quoted string"), 'should reject numeric name')
    }
    assert(threw, 'non-string MIDI identity should fail during parsing')
})

test('validates audio() and creates runtime config', () => {
    const result = compile('search synth\nnoise(scale: audio(band: audioBand.low)).write(o0)')

    const step = result.plans[0].chain[0]
    assert(step.args, 'should have args')

    const scaleArg = step.args.scale
    assert(scaleArg, 'should have scale arg')
    assertEqual(scaleArg.type, 'Audio', 'should have audio type')
    assertEqual(scaleArg.band, 0, 'should have low band (0)')
})

test('audio device identity decodes escaped DSL strings and formats stably', () => {
    const name = 'Expert "Sleepers" \\ ES-9'
    const id = 'audio\\port'
    const source = `search synth\nnoise(scale: audio(band: audioBand.raw, channel: 4, name: ${JSON.stringify(name)}, id: ${JSON.stringify(id)})).write(o0)`
    const result = compile(source)
    const config = result.plans[0].chain[0].args.scale

    assertEqual(config.name, name, 'runtime config should decode the audio device name')
    assertEqual(config.id, id, 'runtime config should decode the audio device id')

    const formatted = formatValue(config)
    assert(formatted.includes(`name: ${JSON.stringify(name)}`), 'formatter should preserve escaped name')
    assert(formatted.includes(`id: ${JSON.stringify(id)}`), 'formatter should preserve escaped id')

    const reparsed = compile(`search synth\nnoise(scale: ${formatted}).write(o0)`)
    assertEqual(reparsed.plans[0].chain[0].args.scale.name, name,
        'formatted name should compile back to the same value')
    assertEqual(reparsed.plans[0].chain[0].args.scale.id, id,
        'formatted id should compile back to the same value')
})

test('audio selected-device channel must be a positive integer', () => {
    for (const channel of ['missingChannel', 0, 1.5, -1]) {
        const result = compile(
            `search synth\nnoise(scale: audio(band: audioBand.raw, channel: ${channel}, name: "Interface")).write(o0)`
        )
        assert(result.diagnostics.some(diagnostic =>
            diagnostic.code === 'S002' && diagnostic.message.includes('positive integer')),
        `channel ${channel} should produce an S002 diagnostic`)
        assertEqual(result.plans[0].chain[0].args.scale.channel, undefined,
            `invalid channel ${channel} should remain inert`)
    }
})

test('audio rejects forbidden strings and invalid numeric field types', () => {
    const cases = [
        { field: 'band', value: '"forbidden"', runtimeField: 'band' },
        { field: 'band', value: 'audioBand.bogus', runtimeField: 'band' },
        { field: 'band', value: 'true', runtimeField: 'band' },
        { field: 'min', value: '"forbidden"', runtimeField: 'min' },
        { field: 'max', value: '"forbidden"', runtimeField: 'max' },
        { field: 'channel', value: 'true', runtimeField: 'channel', selected: true }
    ]

    for (const testCase of cases) {
        const selector = testCase.selected ? ', name: "Interface"' : ''
        const source = `search synth\nnoise(scale: audio(band: audioBand.low, ${testCase.field}: ${testCase.value}${selector})).write(o0)`
        const result = compile(source)
        assert(result.diagnostics.some(diagnostic => diagnostic.code === 'S001' || diagnostic.code === 'S002'),
            `${testCase.field}: ${testCase.value} should produce a validation diagnostic`)
        const config = result.plans[0].chain[0].args.scale
        if (testCase.runtimeField === 'band') {
            assertEqual(config.band, undefined, `${testCase.value} must not become audioBand.low`)
        } else if (testCase.runtimeField === 'channel') {
            assertEqual(config.channel, undefined, 'boolean channel must remain invalid')
        }
    }
})

test('invalid audio fields remain stable when diagnostics are unparsed', () => {
    const source = 'search synth\nnoise(scale: audio(band: audioBand.raw, channel: true, name: "Interface")).write(o0)'
    const once = unparse(compile(source))
    assert(once.includes('channel: true'), 'unparser should preserve the invalid channel for correction')
    const twice = unparse(compile(once))
    assertEqual(twice, once, 'invalid audio diagnostics should remain structurally stable')
})

test('escaped invalid audio strings do not grow escapes during round-trip', () => {
    for (const field of ['band', 'min', 'max']) {
        const args = field === 'band'
            ? 'band: "bad\\\\nvalue"'
            : `band: audioBand.low, ${field}: "bad\\\\nvalue"`
        const source = `search synth\nnoise(scale: audio(${args})).write(o0)`
        const once = unparse(compile(source))
        const twice = unparse(compile(once))
        assertEqual(twice, once, `invalid escaped ${field} string should be stable`)
    }
})

test('boolean audio channel produces one validation diagnostic', () => {
    const result = compile(
        'search synth\nnoise(scale: audio(band: audioBand.raw, channel: true, name: "Interface")).write(o0)'
    )
    const diagnostics = result.diagnostics.filter(diagnostic => diagnostic.message.includes('audio() channel'))
    assertEqual(diagnostics.length, 1, 'one invalid channel should produce one actionable diagnostic')
})

test('validates midi mode enum values', () => {
    const modes = ['noteChange', 'gateNote', 'gateVelocity', 'triggerNote', 'velocity']

    modes.forEach((mode, index) => {
        const result = compile(`search synth\nnoise(scale: midi(channel: 1, mode: midiMode.${mode})).write(o0)`)
        const scaleArg = result.plans[0].chain[0].args.scale
        assertEqual(scaleArg.mode, index, `mode ${mode} should resolve to ${index}`)
    })
})

test('validates numeric midi mode values used by Noisedeck', () => {
    for (let mode = 0; mode <= 4; mode++) {
        const result = compile(`search synth\nnoise(scale: midi(channel: 1, mode: ${mode})).write(o0)`)
        assertEqual(result.plans[0].chain[0].args.scale.mode, mode,
            `numeric mode ${mode} should not collapse to velocity`)
    }
})

test('validates audio band enum values', () => {
    const bands = ['low', 'mid', 'high', 'vol', 'raw']

    bands.forEach((band, index) => {
        const result = compile(`search synth\nnoise(scale: audio(band: audioBand.${band})).write(o0)`)
        const scaleArg = result.plans[0].chain[0].args.scale
        assertEqual(scaleArg.band, index, `band ${band} should resolve to ${index}`)
    })
})

test('validates numeric audio band values used by Noisedeck', () => {
    for (let band = 0; band <= 4; band++) {
        const result = compile(`search synth\nnoise(scale: audio(band: ${band})).write(o0)`)
        assertEqual(result.plans[0].chain[0].args.scale.band, band,
            `numeric audio band ${band} should compile without collapsing to low`)
    }
})

test('rejects numeric audio bands outside the integer 0-4 range', () => {
    for (const band of [-1, 1.5, 5]) {
        const result = compile(`search synth\nnoise(scale: audio(band: ${band})).write(o0)`)
        assert(result.diagnostics.some(diagnostic =>
            diagnostic.code === 'S002' && diagnostic.message.includes('integer from 0 to 4')),
        `audio band ${band} should produce an S002 diagnostic`)
        assertEqual(result.plans[0].chain[0].args.scale.band, undefined,
            `invalid audio band ${band} should remain inert`)
    }
})

test('real compiler graph exposes multiline and inline audio capture requirements', () => {
    const graph = compileGraph(`search synth
let cv = audio(
    band: audioBand.raw,
    channel: 3,
    name: "Interface",
    id: "interface-a"
)
noise(scale: cv, rotation: audio(band: audioBand.raw)).write(o0)`)
    const requirements = new Pipeline(graph, null).getAudioInputRequirements()

    assertEqual(requirements.needsLegacy, true, 'inline aggregate should require legacy capture')
    assertEqual(requirements.needsLegacyRaw, true, 'inline aggregate raw should require a worklet')
    assertEqual(JSON.stringify(requirements.selected), JSON.stringify([{
        id: 'interface-a',
        name: 'Interface',
        channel: 3,
        needsRaw: true
    }]), 'multiline selected audio should survive into the real render graph')
})

test('malformed selected audio never requests legacy fallback capture', () => {
    const graph = compileGraph(`search synth
noise(scale: audio(
    band: audioBand.raw,
    channel: 0,
    name: "Interface",
    id: "interface-a"
)).write(o0)`)
    const requirements = new Pipeline(graph, null).getAudioInputRequirements()

    assertEqual(requirements.needsLegacy, false, 'selector intent must not become default capture')
    assertEqual(requirements.needsLegacyRaw, false, 'malformed raw selector must not open a raw default input')
    assertEqual(requirements.selected.length, 0, 'malformed selector must not request a selected device')
})

// ============================================================================
// Unparser Tests
// ============================================================================

console.log('\n=== Unparser ===\n')

test('formats midi runtime config', () => {
    const config = {
        type: 'Midi',
        channel: 1,
        mode: 4,  // velocity
        min: 0,
        max: 1,
        sensitivity: 1
    }

    const result = formatValue(config)
    assertEqual(result, 'midi(channel: 1)', 'should format with defaults omitted')
})

test('formats midi with non-default values', () => {
    const config = {
        type: 'Midi',
        channel: 5,
        mode: 1,  // gateNote
        min: 0.2,
        max: 0.8,
        sensitivity: 3
    }

    const result = formatValue(config)
    assert(result.includes('channel: 5'), 'should include channel')
    assert(result.includes('mode: midiMode.gateNote'), 'should include mode')
    assert(result.includes('min: 0.2'), 'should include min')
    assert(result.includes('max: 0.8'), 'should include max')
    assert(result.includes('sensitivity: 3'), 'should include sensitivity')
})

test('formats midi with readable name and exact id', () => {
    const config = {
        type: 'Midi',
        channel: 1,
        mode: 4,
        min: 0,
        max: 1,
        sensitivity: 1,
        name: 'Launch Control XL',
        id: 'port-2'
    }

    const result = formatValue(config)
    assertEqual(result,
        'midi(channel: 1, name: "Launch Control XL", id: "port-2")',
        'should retain readable and exact port identity')
})

test('formats audio runtime config', () => {
    const config = {
        type: 'Audio',
        band: 0,  // low
        min: 0,
        max: 1
    }

    const result = formatValue(config)
    assertEqual(result, 'audio(band: audioBand.low)', 'should format with defaults omitted')
})

test('formats audio with non-default values', () => {
    const config = {
        type: 'Audio',
        band: 2,  // high
        min: 0.25,
        max: 0.75
    }

    const result = formatValue(config)
    assert(result.includes('band: audioBand.high'), 'should include band')
    assert(result.includes('min: 0.25'), 'should include min')
    assert(result.includes('max: 0.75'), 'should include max')
})

test('formats selected raw audio with readable name, exact id and channel', () => {
    const result = formatValue({
        type: 'Audio',
        band: 4,
        channel: 2,
        name: 'ES-9',
        id: 'audio-port-2',
        min: 0,
        max: 1
    })
    assertEqual(result,
        'audio(band: audioBand.raw, channel: 2, name: "ES-9", id: "audio-port-2")',
        'should retain selected raw audio identity')
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
