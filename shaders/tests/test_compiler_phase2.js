import { lex } from '../src/lang/lexer.js'
import { parse } from '../src/lang/parser.js'
import { validate, registerStarterOps } from '../src/lang/validator.js'
import { registerOp } from '../src/lang/ops.js'

registerOp('synth.osc', {
    name: 'osc',
    args: [
        { name: 'freq', type: 'float', default: 60 },
        { name: 'sync', type: 'float', default: 0.1 },
        { name: 'offset', type: 'float', default: 0 }
    ]
})
registerOp('filter.rotate', {
    name: 'rotate',
    args: [
        { name: 'angle', type: 'float', default: 0 },
        { name: 'speed', type: 'float', default: 0 }
    ]
})
registerStarterOps(['synth.osc'])

function compile(code) {
    const tokens = lex(code)
    const ast = parse(tokens)
    return validate(ast)
}

function test(name, code, check) {
    try {
        console.log(`Running test: ${name}`)
        const result = compile(code)
        check(result)
        console.log(`PASS: ${name}`)
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e)
    }
}

test('Variable Alias (Function)', 'search synth, filter\nlet x = osc; x(10).write(o0)', (result) => {
    const plan = result.plans[0]
    const step = plan.chain[0]
    if (step.op !== 'synth.osc') throw new Error(`Expected synth.osc, got ${step.op}`)
    if (step.args.freq !== 10) throw new Error(`Expected freq 10, got ${step.args.freq}`)
})

test('Variable Alias (Partial)', 'search synth, filter\nlet x = osc(10); x().write(o0)', (result) => {
    const plan = result.plans[0]
    const step = plan.chain[0]
    if (step.op !== 'synth.osc') throw new Error(`Expected synth.osc, got ${step.op}`)
    if (step.args.freq !== 10) throw new Error(`Expected freq 10, got ${step.args.freq}`)
})

test('Variable Merge', 'search synth, filter\nlet x = osc(10); x(20).write(o0)', (result) => {
    const plan = result.plans[0]
    const step = plan.chain[0]
    if (step.op !== 'synth.osc') throw new Error(`Expected synth.osc, got ${step.op}`)
    if (step.args.freq !== 10) throw new Error(`Expected freq 10, got ${step.args.freq}`)
    if (step.args.sync !== 20) throw new Error(`Expected sync 20, got ${step.args.sync}`)
})

test('Variable Merge (Named)', 'search synth, filter\nlet x = osc(freq: 10); x(sync: 0.5).write(o0)', (result) => {
    const plan = result.plans[0]
    const step = plan.chain[0]
    if (step.args.freq !== 10) throw new Error(`Expected freq 10, got ${step.args.freq}`)
    if (step.args.sync !== 0.5) throw new Error(`Expected sync 0.5, got ${step.args.sync}`)
})

test('Chained Variables', `search synth, filter
let gen = osc(10)
let eff = rotate(1, 0.1)
gen().eff().write(o0)
`, (result) => {
    const plan = result.plans[0]
    // plan.chain also carries compiler builtins such as the terminal _write
    const effects = plan.chain.filter((step) => !step.op.startsWith('_'))
    if (effects.length !== 2) throw new Error(`Expected 2 effect steps, got ${effects.length}`)
    if (effects[0].op !== 'synth.osc') throw new Error('Expected synth.osc first')
    if (effects[1].op !== 'filter.rotate') throw new Error('Expected filter.rotate second')
})
