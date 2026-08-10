import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { validate, registerStarterOps } from '../src/lang/validator.js'
import { registerOp } from '../src/lang/ops.js'

registerOp('synth.noise', {
    name: 'noise',
    args: [
        { name: 'scale', type: 'float', default: 10 },
        { name: 'seed', type: 'float', default: 1 }
    ]
})

registerOp('filter.kaleid', {
    name: 'kaleid',
    args: [
        { name: 'nSides', type: 'float', default: 4 }
    ]
})

registerOp('filter.bloom', {
    name: 'bloom',
    args: [
        { name: 'intensity', type: 'float', default: 0.5 }
    ]
})

registerStarterOps(['synth.noise'])

let failed = 0

function test(name, code, check) {
    try {
        console.log(`Running test: ${name}`)
        const tokens = lex(code)
        const ast = parse(tokens)
        const result = validate(ast)
        check(result)
        console.log(`PASS: ${name}`)
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e)
        failed++
    }
}

process.on('exit', () => { if (failed > 0) process.exitCode = 1 })

test('Valid Chain', 'search synth, filter\nnoise(10).write(o0)', (result) => {
    if (result.diagnostics.length > 0) {
        throw new Error(`Expected no diagnostics, got ${JSON.stringify(result.diagnostics)}`)
    }
    if (result.plans.length !== 1) throw new Error('Expected 1 plan')
})

test('Unknown Function', 'search synth, filter\nunknown(10).write(o0)', (result) => {
    const diag = result.diagnostics.find(d => d.code === 'S001')
    if (!diag) throw new Error('Expected S001 (Unknown identifier)')
    // Verify the identifier name is included in the message
    if (!diag.identifier) throw new Error('Expected identifier field in diagnostic')
    if (diag.identifier !== 'unknown') throw new Error(`Expected identifier 'unknown', got '${diag.identifier}'`)
    if (!diag.message.includes('unknown')) throw new Error('Expected identifier name in message')
})

test('Missing Write', 'search synth, filter\nnoise(10)', (result) => {
    // S001 is the generic error for missing write(), S006 is more specific for starter chains
    // Without the effect registry loaded, we get S001
    const diag = result.diagnostics.find(d => d.code === 'S006' || d.code === 'S001')
    if (!diag) throw new Error('Expected S006 or S001 (Chain missing write)')
})

test('Argument Type Mismatch', 'search synth, filter\nnoise("string").write(o0)', (result) => {
    // Passing a string literal to a numeric param raises S001
    // ("String literal not allowed for numeric parameter '…'").
    const diag = result.diagnostics.find(d => d.code === 'S001')
    if (!diag) throw new Error('Expected S001 type-mismatch diagnostic, got: ' + JSON.stringify(result.diagnostics))
})

test('Illegal Chain Structure', 'search synth, filter\nbloom(0.5).write(o0)', (result) => {
    const diag = result.diagnostics.find(d => d.code === 'S005')
    if (!diag) throw new Error('Expected S005 (Illegal chain structure)')
})

// === Array literal — additive coercion for vec3/vec4 params ===

registerOp('synth.vecop', {
    name: 'vecop',
    args: [
        { name: 'pos3', type: 'vec3', default: [0, 0, 0] },
        { name: 'pos4', type: 'vec4', default: [0, 0, 0, 1] }
    ]
})
registerStarterOps(['synth.vecop'])

test('Array literal coerces to vec3 numeric array', 'search synth\nvecop(pos3: [0.1, 0.2, 0.3]).write(o0)', (result) => {
    if (result.diagnostics.length > 0) throw new Error('Unexpected diagnostics: ' + JSON.stringify(result.diagnostics))
    const args = result.plans[0].chain[0].args
    if (!(args.pos3?.[0] === 0.1 && args.pos3?.[1] === 0.2 && args.pos3?.[2] === 0.3)) {
        throw new Error('Wrong values: ' + JSON.stringify(args.pos3))
    }
})

test('Array literal coerces to vec4 numeric array', 'search synth\nvecop(pos4: [0.05, 0.5, 0.95, 1]).write(o0)', (result) => {
    if (result.diagnostics.length > 0) throw new Error('Diagnostics: ' + JSON.stringify(result.diagnostics))
    const args = result.plans[0].chain[0].args
    if (args.pos4.length !== 4 || args.pos4[0] !== 0.05 || args.pos4[3] !== 1) {
        throw new Error('Wrong: ' + JSON.stringify(args.pos4))
    }
})

test('Array literal — any length passes through unchanged', 'search synth\nvecop(pos3: [1, 2]).write(o0)', (result) => {
    // Length is NOT enforced. Whatever elements the source declared
    // get handed off to the runtime as-is.
    const args = result.plans[0].chain[0].args
    if (!Array.isArray(args.pos3)) throw new Error('Expected array, got: ' + JSON.stringify(args.pos3))
    if (args.pos3.length !== 2 || args.pos3[0] !== 1 || args.pos3[1] !== 2) {
        throw new Error('Expected [1, 2], got: ' + JSON.stringify(args.pos3))
    }
})

test('Existing vec3() Call still produces same value', 'search synth\nvecop(pos3: vec3(0.1, 0.2, 0.3)).write(o0)', (result) => {
    if (result.diagnostics.length > 0) throw new Error('Diagnostics: ' + JSON.stringify(result.diagnostics))
    const args = result.plans[0].chain[0].args
    if (args.pos3[0] !== 0.1 || args.pos3[1] !== 0.2 || args.pos3[2] !== 0.3) {
        throw new Error('Wrong: ' + JSON.stringify(args.pos3))
    }
})

test('Existing hex Color still produces same value for vec4', 'search synth\nvecop(pos4: #ff8800).write(o0)', (result) => {
    if (result.diagnostics.length > 0) throw new Error('Diagnostics: ' + JSON.stringify(result.diagnostics))
    const args = result.plans[0].chain[0].args
    if (args.pos4.length !== 4) throw new Error('Wrong arity: ' + JSON.stringify(args.pos4))
    // Hex #ff8800 → [1, 0x88/255, 0, 1.0]
    const expectR = 1
    const expectG = 0x88 / 255
    if (Math.abs(args.pos4[0] - expectR) > 1e-6 || Math.abs(args.pos4[1] - expectG) > 1e-6) {
        throw new Error('Hex color path changed: ' + JSON.stringify(args.pos4))
    }
})
