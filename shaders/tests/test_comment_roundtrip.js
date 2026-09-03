/**
 * Tests for comment preservation through parse -> validate -> unparse cycles.
 *
 * These tests verify that comments survive the full DSL round-trip,
 * enabling downstream applications to embed metadata in DSL source.
 */

import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { validate, registerStarterOps } from '../src/lang/validator.js'
import { unparse } from '../src/lang/unparser.js'
import { ops } from '../src/lang/ops.js'

// Register test effects with the ops registry
ops['synth.noise'] = {
    globals: { freq: { name: 'freq', type: 'float', default: 10 } },
    starter: true,
    category: 'synth'
}
ops['filter.bloom'] = {
    globals: { radius: { name: 'radius', type: 'float', default: 1 } },
    category: 'filter'
}
ops['mixer.blend'] = {
    globals: { amount: { name: 'amount', type: 'float', default: 0.5 } },
    category: 'mixer'
}

// Register starter ops
registerStarterOps(['synth.noise'])

// Mock effect definitions for unparsing
function getEffectDef(name) {
    return ops[name] || null
}

function roundTrip(source) {
    const tokens = lex(source)
    const ast = parse(tokens)
    const compiled = validate(ast)
    return unparse(compiled, {}, { getEffectDef })
}

let failed = 0

function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
        fn()
        console.log(`PASS: ${name}`)
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e.message)
        failed++
    }
}

process.on('exit', () => { if (failed > 0) process.exitCode = 1 })

// ============ Round-Trip Tests ============

test('Simple program round-trips without comments', () => {
    const source = `search synth

noise().write(o0)`
    const result = roundTrip(source)
    if (!result.includes('noise()')) throw new Error('Expected noise() in output')
    if (!result.includes('write(o0)')) throw new Error('Expected write(o0) in output')
})

test('Plan-level comment survives round-trip', () => {
    const source = `search synth

// this is a plan comment
noise().write(o0)`
    const result = roundTrip(source)
    if (!result.includes('// this is a plan comment')) {
        throw new Error(`Expected plan comment in output. Got:\n${result}`)
    }
})

test('Multiple plan comments survive round-trip', () => {
    const source = `search synth

// first comment
// second comment
noise().write(o0)`
    const result = roundTrip(source)
    if (!result.includes('// first comment')) {
        throw new Error(`Expected first comment in output. Got:\n${result}`)
    }
    if (!result.includes('// second comment')) {
        throw new Error(`Expected second comment in output. Got:\n${result}`)
    }
})

test('Chained method comment survives round-trip', () => {
    const source = `search synth, filter

noise()
  // comment on bloom
  .bloom().write(o0)`
    const result = roundTrip(source)
    if (!result.includes('// comment on bloom')) {
        throw new Error(`Expected chained method comment in output. Got:\n${result}`)
    }
})

test('Subchain markers survive round-trip', () => {
    const source = `search synth, filter

// @subchain:begin name="feedback" id="sc1"
noise()
  .bloom()
  // @subchain:end id="sc1"
  .write(o0)`
    const result = roundTrip(source)
    if (!result.includes('@subchain:begin')) {
        throw new Error(`Expected @subchain:begin in output. Got:\n${result}`)
    }
    if (!result.includes('@subchain:end')) {
        throw new Error(`Expected @subchain:end in output. Got:\n${result}`)
    }
})

test('Block comment survives round-trip', () => {
    const source = `search synth

/* block comment */
noise().write(o0)`
    const result = roundTrip(source)
    if (!result.includes('/* block comment */')) {
        throw new Error(`Expected block comment in output. Got:\n${result}`)
    }
})

test('Trailing comments survive round-trip', () => {
    const source = `search synth

noise().write(o0)
// trailing comment`
    const result = roundTrip(source)
    if (!result.includes('// trailing comment')) {
        throw new Error(`Expected trailing comment in output. Got:\n${result}`)
    }
})

test('Comments on multiple chains survive round-trip', () => {
    const source = `search synth, filter

// first chain
noise().write(o0)

// second chain
noise().bloom().write(o1)`
    const result = roundTrip(source)
    if (!result.includes('// first chain')) {
        throw new Error(`Expected first chain comment. Got:\n${result}`)
    }
    if (!result.includes('// second chain')) {
        throw new Error(`Expected second chain comment. Got:\n${result}`)
    }
})

console.log('\n=== Comment Round-Trip Tests Complete ===')
