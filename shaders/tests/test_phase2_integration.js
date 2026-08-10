import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { validate, registerStarterOps } from '../src/lang/validator.js'
import { registerOp } from '../src/lang/ops.js'
import { registerEffect } from '../src/runtime/registry.js'
import { expand } from '../src/runtime/expander.js'
import { allocateResources } from '../src/runtime/resources.js'

// Setup. Ops must be registered under the namespaces the program searches.
registerOp('synth.osc', { name: 'osc', args: [{ name: 'freq', type: 'float', default: 60 }] })
registerOp('filter.kaleid', { name: 'kaleid', args: [{ name: 'n', type: 'float', default: 4 }] })
registerStarterOps(['synth.osc'])

registerEffect('synth.osc', {
    name: 'osc',
    passes: [{ type: 'render', program: 'osc', outputs: { color: 'outputTex' } }]
})
registerEffect('filter.kaleid', {
    name: 'kaleid',
    passes: [{ type: 'render', program: 'kaleid', inputs: { tex: 'inputColor' }, outputs: { color: 'outputTex' } }]
})

function compileAndAllocate(code) {
    const tokens = lex(code)
    const ast = parse(tokens)
    const validated = validate(ast)
    if (validated.diagnostics.length > 0) throw new Error(JSON.stringify(validated.diagnostics))

    const { passes, errors } = expand(validated)
    if (errors.length > 0) throw new Error(JSON.stringify(errors))

    const allocations = allocateResources(passes)
    return { passes, allocations }
}

try {
    console.log('Running Phase 2 Integration Test...')
    // osc -> kaleid -> kaleid -> out
    // A -> B -> C
    // A and C should share a slot?
    // 0: osc (Write A)
    // 1: kaleid (Read A, Write B) -> A released
    // 2: kaleid (Read B, Write C) -> B released. C can use A's slot.

    const code = 'search synth, filter\nosc(10).kaleid(4).kaleid(2).write(o0)'
    const { passes, allocations } = compileAndAllocate(code)

    const texA = passes[0].outputs.color // node_0_out
    const texB = passes[1].outputs.color // node_1_out
    const texC = passes[2].outputs.color // node_2_out or global_o0

    const physA = allocations.get(texA)
    const physB = allocations.get(texB)

    if (!physA) throw new Error('A not allocated')
    if (!physB) throw new Error('B not allocated')
    if (physA === physB) throw new Error('A and B overlap')

    if (texC !== 'global_o0') {
        const physC = allocations.get(texC)
        if (physB === physC) throw new Error('B and C overlap')
        if (physA !== physC) throw new Error(`Expected reuse: A=${physA}, C=${physC}`)
    }

    console.log('PASS: Phase 2 Integration')
} catch (e) {
    console.error('FAIL: Phase 2 Integration')
    console.error(e)
    process.exitCode = 1
}
