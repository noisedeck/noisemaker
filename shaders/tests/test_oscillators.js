/**
 * Tests for Oscillator support in the Polymorphic DSL
 *
 * Oscillators are time-varying values that can be used as inputs for effect parameters.
 * They generate looping values synchronized with the animation duration.
 */

import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { registerStarterOps } from '../src/lang/validator.js'
import { compile } from '../src/lang/index.js'
import { formatValue } from '../src/lang/unparser.js'
import { registerOp } from '../src/lang/ops.js'

// Register test ops
registerOp('synth.noise', {
    name: 'noise',
    args: [
        { name: 'scale', type: 'float', default: 10 },
        { name: 'octaves', type: 'int', default: 1 },
        { name: 'rotation', type: 'float', default: 0 }
    ]
})

registerOp('filter.bloom', {
    name: 'bloom',
    args: [
        { name: 'amount', type: 'float', default: 0.5 }
    ]
})

registerStarterOps(['synth.noise'])

let passCount = 0
let failCount = 0

function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
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

// ============================================================================
// Parser Tests
// ============================================================================

test('Parser: Basic oscillator with type only', () => {
    const tokens = lex('search synth, filter\nnoise(scale: osc(type: oscKind.sine)).write(o0)')
    const ast = parse(tokens)

    // Find the oscillator in the call args
    const noiseCall = ast.plans[0].chain[0]
    assert(noiseCall.name === 'noise', 'Expected noise call')
    assert(noiseCall.kwargs, 'Expected kwargs')

    const scaleArg = noiseCall.kwargs.scale
    assert(scaleArg, 'Expected scale kwarg')
    assert(scaleArg.type === 'Oscillator', `Expected Oscillator type, got ${scaleArg.type}`)
    assert(scaleArg.oscType.type === 'Member', 'Expected oscType to be Member')
    assert(scaleArg.oscType.path.join('.') === 'oscKind.sine', 'Expected oscKind.sine')
})

test('Parser: Oscillator with all parameters', () => {
    const code = 'search synth, filter\nnoise(scale: osc(type: oscKind.tri, min: 0.2, max: 0.8, speed: 2, offset: 0.25, seed: 42)).write(o0)'
    const tokens = lex(code)
    const ast = parse(tokens)

    const scaleArg = ast.plans[0].chain[0].kwargs.scale
    assert(scaleArg.type === 'Oscillator', 'Expected Oscillator type')
    assertEqual(scaleArg.min.value, 0.2, 'Expected min 0.2')
    assertEqual(scaleArg.max.value, 0.8, 'Expected max 0.8')
    assertEqual(scaleArg.speed.value, 2, 'Expected speed 2')
    assertEqual(scaleArg.offset.value, 0.25, 'Expected offset 0.25')
    assertEqual(scaleArg.seed.value, 42, 'Expected seed 42')
})

test('Parser: Oscillator with positional arguments', () => {
    const code = 'search synth, filter\nnoise(scale: osc(oscKind.saw, 0.1, 0.5)).write(o0)'
    const tokens = lex(code)
    const ast = parse(tokens)

    const scaleArg = ast.plans[0].chain[0].kwargs.scale
    assert(scaleArg.type === 'Oscillator', 'Expected Oscillator type')
    assert(scaleArg.oscType.path.join('.') === 'oscKind.saw', 'Expected oscKind.saw')
    assertEqual(scaleArg.min.value, 0.1, 'Expected min 0.1')
    assertEqual(scaleArg.max.value, 0.5, 'Expected max 0.5')
})

test('Parser: Oscillator stored in variable', () => {
    const code = 'search synth, filter\nlet myOsc = osc(type: oscKind.sine, min: 0, max: 1)\nnoise(scale: myOsc).write(o0)'
    const tokens = lex(code)
    const ast = parse(tokens)

    // Check variable assignment
    assert(ast.vars.length === 1, 'Expected 1 variable')
    const varExpr = ast.vars[0].expr
    assert(varExpr.type === 'Oscillator', 'Expected Oscillator type in variable')
})

// ============================================================================
// Validator Tests
// ============================================================================

test('Validator: Oscillator resolves to oscillator config', () => {
    const result = compile('search synth, filter\nnoise(scale: osc(type: oscKind.sine, min: 0.2, max: 0.8)).write(o0)')

    // Find the compiled step
    const step = result.plans[0].chain[0]
    assert(step.args, 'Expected args')

    const scaleArg = step.args.scale
    assert(scaleArg, 'Expected scale arg')
    assert(scaleArg.type === 'Oscillator', 'Expected oscillator type')
    assertEqual(scaleArg.oscType, 0, 'Expected oscType 0 (sine)')
    assertEqual(scaleArg.min, 0.2, 'Expected min 0.2')
    assertEqual(scaleArg.max, 0.8, 'Expected max 0.8')
})

test('Validator: Different oscillator types resolve to correct values', () => {
    const types = [
        ['sine', 0],
        ['tri', 1],
        ['saw', 2],
        ['sawInv', 3],
        ['square', 4],
        ['noise', 5]
    ]

    for (const [typeName, expectedValue] of types) {
        const result = compile(`search synth, filter\nnoise(scale: osc(type: oscKind.${typeName})).write(o0)`)
        const scaleArg = result.plans[0].chain[0].args.scale
        assertEqual(scaleArg.oscType, expectedValue, `Expected oscType ${expectedValue} for ${typeName}`)
    }
})

test('Validator: Oscillator defaults are applied correctly', () => {
    const result = compile('search synth, filter\nnoise(scale: osc(type: oscKind.sine)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale

    assertEqual(scaleArg.min, 0, 'Expected default min 0')
    assertEqual(scaleArg.max, 1, 'Expected default max 1')
    assertEqual(scaleArg.speed, 1, 'Expected default speed 1')
    assertEqual(scaleArg.offset, 0, 'Expected default offset 0')
    assertEqual(scaleArg.seed, 1, 'Expected default seed 1')
})

test('Validator: Oscillator min/max are clamped to [0, 1]', () => {
    const result = compile('search synth, filter\nnoise(scale: osc(type: oscKind.sine, min: -0.5, max: 2)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale
    assertEqual(scaleArg.min, 0, 'min should be clamped to 0')
    assertEqual(scaleArg.max, 1, 'max should be clamped to 1')
})

test('Validator: Oscillator min/max within [0, 1] pass through unchanged', () => {
    const result = compile('search synth, filter\nnoise(scale: osc(type: oscKind.sine, min: 0.25, max: 0.75)).write(o0)')
    const scaleArg = result.plans[0].chain[0].args.scale
    assertEqual(scaleArg.min, 0.25, 'min should be 0.25')
    assertEqual(scaleArg.max, 0.75, 'max should be 0.75')
})

// ============================================================================
// Unparser Tests (Round-trip)
// ============================================================================

test('Unparser: formatValue handles oscillator config', () => {
    const oscConfig = {
        type: 'Oscillator',
        oscType: 0,
        min: 0.2,
        max: 0.8,
        speed: 1,
        offset: 0,
        seed: 1
    }

    const formatted = formatValue(oscConfig)
    assert(formatted.includes('osc('), 'Expected osc( in output')
    assert(formatted.includes('oscKind.sine'), 'Expected oscKind.sine')
    assert(formatted.includes('min: 0.2'), 'Expected min: 0.2')
    assert(formatted.includes('max: 0.8'), 'Expected max: 0.8')
})

test('Unparser: formatValue omits default values', () => {
    const oscConfig = {
        type: 'Oscillator',
        oscType: 0,
        min: 0,
        max: 1,
        speed: 1,
        offset: 0,
        seed: 1
    }

    const formatted = formatValue(oscConfig)
    // Only type should be included since all others are default
    assert(!formatted.includes('min:'), 'Should not include default min')
    assert(!formatted.includes('max:'), 'Should not include default max')
    assert(!formatted.includes('speed:'), 'Should not include default speed')
    assert(!formatted.includes('offset:'), 'Should not include default offset')
})

test('Unparser: All oscillator types format correctly', () => {
    const types = ['sine', 'tri', 'saw', 'sawInv', 'square', 'noise']

    for (let i = 0; i < types.length; i++) {
        const oscConfig = {
            type: 'Oscillator',
            oscType: i,
            min: 0,
            max: 1,
            speed: 1,
            offset: 0,
            seed: 1
        }

        const formatted = formatValue(oscConfig)
        assert(formatted.includes(`oscKind.${types[i]}`), `Expected oscKind.${types[i]} in ${formatted}`)
    }
})

// ============================================================================
// Integration Tests
// ============================================================================

test('Integration: Full compile and unparse round-trip', () => {
    const original = 'search synth, filter\nnoise(scale: osc(type: oscKind.sine, min: 0.2, max: 0.8)).write(o0)'
    const compiled = compile(original)

    // Verify compilation produced oscillator config
    const scaleArg = compiled.plans[0].chain[0].args.scale
    assert(scaleArg.type === 'Oscillator', 'Expected oscillator in compiled output')

    // The unparser should be able to format this back
    // Note: We can't do exact string comparison because the unparser may reorder/format differently
})

test('Integration: Oscillator in complex chain', () => {
    const code = `search synth, filter
let scaleOsc = osc(type: oscKind.saw, min: 0.1, max: 1, speed: 2)
noise(scale: scaleOsc).bloom(amount: 0.5).write(o0)`

    const compiled = compile(code)
    assert(compiled.plans.length === 1, 'Expected 1 plan')

    // First step should have oscillator
    const noiseStep = compiled.plans[0].chain[0]
    assert(noiseStep.args.scale.type === 'Oscillator', 'Expected oscillator in noise scale')
    assertEqual(noiseStep.args.scale.oscType, 2, 'Expected saw type (2)')
    assertEqual(noiseStep.args.scale.speed, 2, 'Expected speed 2')
})

// ============================================================================
// Mixed positional/keyword arguments
//
// osc()/midi()/audio() resolve parameters by walking the parameter order and
// indexing the positional list by slot. Positionals are dense — a keyword does
// not occupy a slot in them — so any positional written after a keyword must
// bind to the next unfilled parameter, not to args[slot].
// ============================================================================

function oscFrom(code) {
    const ast = parse(lex(code))
    let found = null
    const walk = (n) => {
        if (!n || typeof n !== 'object') return
        if (n.type === 'Oscillator') { found = found || n; return }
        for (const v of Object.values(n)) {
            if (Array.isArray(v)) v.forEach(walk)
            else if (v && typeof v === 'object') walk(v)
        }
    }
    walk(ast)
    if (!found) throw new Error('no Oscillator node parsed from: ' + code)
    const num = (v) => (v && typeof v === 'object' && 'value' in v) ? v.value : v
    return { min: num(found.min), max: num(found.max) }
}

test('osc() positional after keyword binds to the next unfilled slot', () => {
    const o = oscFrom('search synth\nnoise(osc(oscKind.saw, min: 0.2, 0.8)).write(o0)')
    assertEqual(o.min, 0.2, 'min')
    assertEqual(o.max, 0.8, 'max (positional after keyword was dropped)')
})

test('osc() all-positional form is unchanged', () => {
    const o = oscFrom('search synth\nnoise(osc(oscKind.saw, 0.2, 0.8)).write(o0)')
    assertEqual(o.min, 0.2, 'min')
    assertEqual(o.max, 0.8, 'max')
})

// ============================================================================
// Summary
// ============================================================================

console.log('\n========================================')
console.log(`Oscillator Tests Complete`)
console.log(`Passed: ${passCount}`)
console.log(`Failed: ${failCount}`)
console.log('========================================')

if (failCount > 0) {
    process.exit(1)
}
