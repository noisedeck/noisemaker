#!/usr/bin/env node

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import remapEffect from '../effects/synth/remap/definition.js'
import { compile, formatValue, unparse } from '../src/lang/index.js'
import { registerOp } from '../src/lang/ops.js'
import { registerStarterOps } from '../src/lang/validator.js'
import { registerEffect } from '../src/runtime/registry.js'
import { ProgramState } from '../../demo/shaders/lib/program-state.js'

const preciseVertices = [
    0.8000000780001997,
    0.4500000195000499,
    0.09999996099990016,
    0.4500000195000499
]

function registerRemapForDsl() {
    registerEffect('remap', remapEffect)
    registerEffect('synth.remap', remapEffect)
    registerEffect('synth/remap', remapEffect)

    registerOp('synth.remap', {
        name: 'remap',
        args: Object.entries(remapEffect.globals).map(([name, spec]) => ({
            name,
            // Match CanvasRenderer.registerEffectWithRuntime so this test
            // exercises the shipped legacy-hex compatibility path.
            type: spec.type === 'vec4' ? 'color' : spec.type,
            default: spec.default,
            min: spec.min,
            max: spec.max
        }))
    })
    registerStarterOps(['remap', 'synth.remap'])
}

registerRemapForDsl()

describe('lossless Remap vector formatting', () => {
    test('unopted vec4 and genuine color formatting remain hexadecimal', () => {
        assert.equal(formatValue(preciseVertices, { type: 'vec4' }), '#cc731973')
        assert.equal(formatValue([0.2, 0.4, 0.6, 0.8], { type: 'color' }), '#336699cc')
    })

    test('vector formatting emits exact finite values without color clamping or decimal rounding', () => {
        const values = [
            0.8000000780001997,
            -0.4500000195000499,
            1.0999999609999003,
            0.0000001
        ]

        const formatted = formatValue(values, { type: 'vec4', ui: { format: 'vector' } })
        assert.equal(formatted,
            '[0.8000000780001997, -0.4500000195000499, 1.0999999609999003, 0.0000001]')

        const compiled = compile(`search synth\nremap(zone0_v0: ${formatted}).write(o0)`)
        assert.deepEqual(compiled.diagnostics, [])
        assert.deepEqual(compiled.plans[0].chain[0].args.zone0_v0, values)
    })

    test('every Remap vertex pair opts into vector formatting', () => {
        const vertexSpecs = Object.entries(remapEffect.globals)
            .filter(([name]) => /^zone[0-7]_v(?:[0-9]|[12][0-9]|3[01])$/.test(name))

        assert.equal(vertexSpecs.length, 8 * 32)
        for (const [name, spec] of vertexSpecs) {
            assert.equal(spec.type, 'vec4', `${name} must remain a vec4`)
            assert.equal(spec.ui?.format, 'vector', `${name} must use lossless vector formatting`)
        }
    })

    test('compile and unparse preserve precise Remap array literals', () => {
        const source = `search synth

remap(zone0_v1: [${preciseVertices.join(', ')}])
  .write(o0)`
        const compiled = compile(source)
        const regenerated = unparse(compiled, {}, {
            getEffectDef: name => name === 'remap' || name === 'synth.remap' ? remapEffect : null
        })
        const restored = compile(regenerated)

        assert.match(regenerated, /zone0_v1:\s*\[0\.8000000780001997, 0\.4500000195000499, 0\.09999996099990016, 0\.4500000195000499\]/)
        assert.deepEqual(restored.diagnostics, [])
        assert.deepEqual(restored.plans[0].chain[0].args.zone0_v1, preciseVertices)
    })

    test('ProgramState preserves all four coordinates exactly through DSL regeneration', () => {
        const renderer = {
            currentDsl: `search synth

remap(zoneCount: 1, zone0_count: 4, zone0_v1: #cc731973)
  .write(o0)`,
            enums: {}
        }
        const state = new ProgramState({ renderer })
        state.fromDsl(renderer.currentDsl)
        state.setValue('step_0', 'zone0_v1', preciseVertices)

        const regenerated = state.toDsl()
        assert.match(regenerated, /zone0_v1:\s*\[0\.8000000780001997, 0\.4500000195000499, 0\.09999996099990016, 0\.4500000195000499\]/)

        const compiled = compile(regenerated)
        assert.deepEqual(compiled.diagnostics, [])
        assert.deepEqual(compiled.plans[0].chain[0].args.zone0_v1, preciseVertices)

        const restored = new ProgramState({
            renderer: { currentDsl: regenerated, enums: {} }
        })
        restored.fromDsl(regenerated)
        assert.deepEqual(restored.getValue('step_0', 'zone0_v1'), preciseVertices)
    })

    test('legacy hexadecimal Remap vertices still compile', () => {
        const compiled = compile(`search synth

remap(zoneCount: 1, zone0_count: 4, zone0_v1: #cc731973)
  .write(o0)`)

        assert.deepEqual(compiled.diagnostics, [])
        assert.deepEqual(compiled.plans[0].chain[0].args.zone0_v1, [
            0.8,
            0.45098039215686275,
            0.09803921568627451,
            0.45098039215686275
        ])
    })
})
