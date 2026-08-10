import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { validate, registerStarterOps } from '../src/lang/validator.js'
import { registerOp } from '../src/lang/ops.js'
import { registerEffect } from '../src/runtime/registry.js'
import { expand } from '../src/runtime/expander.js'

registerOp('synth.osc', {
    name: 'osc',
    args: [{ name: 'freq', type: 'float', default: 60 }]
})
registerOp('filter.blend', {
    name: 'blend',
    args: [{ name: 'tex', type: 'surface' }]
})
registerStarterOps(['synth.osc'])

registerEffect('synth.osc', {
    name: 'osc',
    passes: [
        {
            type: 'render',
            program: 'osc',
            outputs: { color: 'outputTex' }
        }
    ]
})
registerEffect('filter.blend', {
    name: 'blend',
    passes: [{
        type: 'render',
        program: 'blend',
        inputs: {
            src: 'inputColor',
            tex: 'tex'
        },
        outputs: { color: 'outputTex' }
    }]
})

function compile(code) {
    const tokens = lex(code)
    const ast = parse(tokens)
    return validate(ast)
}

let failed = 0

function test(name, code, check) {
    try {
        console.log(`Running test: ${name}`)
        const result = compile(code)
        if (result.diagnostics.length > 0) {
            throw new Error(`Compilation failed: ${JSON.stringify(result.diagnostics)}`)
        }
        const expanded = expand(result)
        check(expanded)
        console.log(`PASS: ${name}`)
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e)
        failed++
    }
}

process.on('exit', () => { if (failed > 0) process.exitCode = 1 })

// Effects render into their own internal texture; the terminal write() becomes
// a trailing blit into the user surface (o0..o7 are user-only).
test('Expand Simple Chain', 'search synth, filter\nosc(10).write(o0)', (result) => {
    if (result.errors.length > 0) throw new Error(result.errors[0].message)
    if (result.passes.length !== 2) throw new Error(`Expected 2 passes, got ${result.passes.length}`)

    const oscPass = result.passes[0]
    if (oscPass.program !== 'node_0_osc') throw new Error(`Expected node_0_osc program, got ${oscPass.program}`)
    if (oscPass.outputs.color !== 'node_0_out') throw new Error(`Expected output node_0_out, got ${oscPass.outputs.color}`)

    const blitPass = result.passes[1]
    if (blitPass.program !== 'blit') throw new Error(`Expected blit program, got ${blitPass.program}`)
    if (blitPass.outputs.color !== 'global_o0') throw new Error(`Expected output global_o0, got ${blitPass.outputs.color}`)
})

test('Expand Blend Chain', 'search synth, filter\nosc(10).blend(read(o0)).write(o1)', (result) => {
    if (result.errors.length > 0) throw new Error(result.errors[0].message)
    // osc -> blend -> blit
    // osc is node_0, blend is node_1; the write(o1) terminal becomes a blit.
    if (result.passes.length !== 3) throw new Error(`Expected 3 passes, got ${result.passes.length}`)

    const oscPass = result.passes[0]
    if (oscPass.program !== 'node_0_osc') throw new Error(`Expected node_0_osc first, got ${oscPass.program}`)

    if (oscPass.outputs.color !== 'node_0_out') throw new Error(`Expected osc output node_0_out, got ${oscPass.outputs.color}`)

    const blendPass = result.passes[1]
    if (blendPass.program !== 'node_1_blend') throw new Error(`Expected node_1_blend second, got ${blendPass.program}`)
    // The upstream chain value arrives through node_1's own input binding
    if (blendPass.inputs.src !== 'node_1_inputColor') throw new Error(`Expected src=node_1_inputColor, got ${blendPass.inputs.src}`)
    if (blendPass.inputs.tex !== 'global_o0') throw new Error(`Expected tex=global_o0, got ${blendPass.inputs.tex}`)
    if (blendPass.outputs.color !== 'node_1_out') throw new Error(`Expected blend output node_1_out, got ${blendPass.outputs.color}`)

    const blitPass = result.passes[2]
    if (blitPass.program !== 'blit') throw new Error(`Expected blit last, got ${blitPass.program}`)
    if (blitPass.inputs.src !== 'node_1_out') throw new Error(`Expected blit src=node_1_out, got ${blitPass.inputs.src}`)
    if (blitPass.outputs.color !== 'global_o1') throw new Error(`Expected output global_o1, got ${blitPass.outputs.color}`)
})
