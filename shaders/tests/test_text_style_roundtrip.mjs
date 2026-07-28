#!/usr/bin/env node
/**
 * filter/text must carry its `style` through the DSL.
 *
 * Hosts rasterize text on the CPU and choose the face themselves, so the named
 * cut ("Bold Italic", or a per-typeface label like "Argon Medium Italic" for a
 * family that bundles several) is not a uniform. But it is still a parameter of
 * the effect: the saved artifact is the DSL string, and unparse() drops any key
 * the effect does not declare in `globals` (unparser.js — "only include keys
 * that are defined in globals"). Without `style` declared, the value was
 * silently discarded on every unparse, so recompiling — or reopening a saved
 * program — reverted the text to the family's first cut.
 */
import assert from 'node:assert/strict'
import { unparse } from '../src/lang/unparser.js'
import Text from '../effects/filter/text/definition.js'

const textDef = new Text()

assert.ok(textDef.globals.style, 'filter/text must declare a `style` global')
assert.equal(textDef.globals.style.type, 'string', '`style` must be a string')
assert.equal(textDef.globals.style.ui?.control, false,
    '`style` gets no generic control — valid labels depend on the font, so hosts render their own picker')
assert.equal(textDef.globals.style.ui?.hidden, true,
    '`style` must be hidden so hosts do not render a stray generic control for it')
console.log('✓ filter/text declares a `style` global')

const STYLE = 'Argon Medium Italic'

const compiled = {
    searchNamespaces: ['synth', 'filter'],
    plans: [
        {
            chain: [
                { op: 'synth.perlin', args: { scale: 100 } },
                { op: 'filter.text', args: { text: 'Hamburg', font: 'Monaspace' } },
            ],
            write: { kind: 'output', name: 'o0' },
        },
    ],
}

const getEffectDef = (op) => (op === 'filter.text' ? textDef : null)

// The text step is index 1 in the flattened walk; a style set on it is exactly
// what the style control writes into program state.
const overrides = { 1: { text: 'Hamburg', font: 'Monaspace', style: STYLE } }
const out = unparse(compiled, overrides, { getEffectDef })

assert.ok(out.includes('style:'), `unparse dropped style:\n${out}`)
assert.ok(out.includes(STYLE), `unparse dropped the style value:\n${out}`)
console.log('✓ style survives unparse')

// Guard the mechanism itself: a key the effect does NOT declare is still
// dropped, so this test fails if `style` is removed from globals again.
const withUnknown = unparse(compiled, { 1: { style: STYLE, notAParam: 'x' } }, { getEffectDef })
assert.ok(withUnknown.includes(STYLE), 'style should survive alongside an unknown key')
assert.ok(!withUnknown.includes('notAParam'), 'undeclared keys must still be dropped')
console.log('✓ undeclared keys are still dropped, so the guard is real')

console.log('PASS test_text_style_roundtrip')
