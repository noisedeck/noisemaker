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

// ---------------------------------------------------------------------------
// Mixed positional/keyword argument binding.
//
// Relaxing the "positional and keyword arguments are mutually exclusive" rule
// (needed so scene() can carry settings as keywords beside child nodes as
// positionals) left the binding loop indexing the dense positional list by
// parameter slot. Once a keyword fills a slot, every later positional shifts
// and falls off the end.
// ---------------------------------------------------------------------------

registerOp('filter.blur', {
    name: 'blur',
    args: [
        { name: 'amount', type: 'float', default: 0.1 },
        { name: 'angle', type: 'float', default: 0 },
        { name: 'quality', type: 'float', default: 1 }
    ]
})

registerOp('filter.tint', {
    name: 'tint',
    args: [
        { name: 'r', type: 'float', default: 1 },
        { name: 'g', type: 'float', default: 1 },
        { name: 'b', type: 'float', default: 1 },
        { name: 'alpha', type: 'float', default: 1 }
    ]
})

function argsOf(result, op) {
    const step = result.plans[0].chain.find(s => s.op === op)
    if (!step) throw new Error(`no '${op}' step in chain: ${result.plans[0].chain.map(s => s.op).join(', ')}`)
    return step.args
}

test('positional after keyword binds to the next unfilled slot',
    'search synth, filter\nnoise().blur(0.9, angle: 0.5, 4).write(o0)', (result) => {
        const a = argsOf(result, 'filter.blur')
        if (a.amount !== 0.9) throw new Error(`amount: expected 0.9, got ${a.amount}`)
        if (a.angle !== 0.5) throw new Error(`angle: expected 0.5, got ${a.angle}`)
        if (a.quality !== 4) throw new Error(`quality: expected 4, got ${a.quality} (positional was dropped)`)
    })

test('keyword first, then positionals fill remaining slots in order',
    'search synth, filter\nnoise().blur(angle: 0.5, 0.9, 4).write(o0)', (result) => {
        const a = argsOf(result, 'filter.blur')
        if (a.amount !== 0.9) throw new Error(`amount: expected 0.9, got ${a.amount}`)
        if (a.angle !== 0.5) throw new Error(`angle: expected 0.5, got ${a.angle}`)
        if (a.quality !== 4) throw new Error(`quality: expected 4, got ${a.quality}`)
    })

test('excess positional arguments are diagnosed, not silently dropped',
    'search synth, filter\nnoise().kaleid(4, 9, 9).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => /too many|excess|positional/i.test(d.message || ''))
        if (!diag) {
            throw new Error(`Expected a diagnostic for excess positionals, got ${JSON.stringify(result.diagnostics)}`)
        }
    })

test('hex color still splats across r/g/b when another keyword is present',
    'search synth, filter\nnoise().tint(#ff8000, alpha: 0.5).write(o0)', (result) => {
        const a = argsOf(result, 'filter.tint')
        if (Math.abs(a.r - 1) > 1e-6) throw new Error(`r: expected 1, got ${a.r}`)
        if (Math.abs(a.g - 0.502) > 0.01) throw new Error(`g: expected ~0.502, got ${a.g}`)
        if (Math.abs(a.b - 0) > 1e-6) throw new Error(`b: expected 0, got ${a.b}`)
        if (a.alpha !== 0.5) throw new Error(`alpha: expected 0.5, got ${a.alpha}`)
    })

// ---------------------------------------------------------------------------
// Scene names are only chain elements as `scene()` itself.
//
// camera/mesh/light/group/material/solid/surface/pbr/emit/environment are
// children *inside* a scene() call, preserved as AST and never reaching the
// chain loop. Letting them pass through at any chain position turned an
// "Unknown effect" typo into a silent no-op that renders nothing.
// ---------------------------------------------------------------------------

test('a scene child name used as a chain element is an unknown effect',
    'search synth, filter\nnoise().camera(fov: 60).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => d.code === 'S001'
            && /camera/.test(d.message || '')
            && /only valid inside scene\(\)/.test(d.message || ''))
        if (!diag) throw new Error(`Expected S001 naming 'camera' and the scene() constraint, got ${JSON.stringify(result.diagnostics)}`)
    })

test('volume() used as a chain element is an unknown effect',
    'search synth, filter\nnoise().volume(vol0).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => d.code === 'S001'
            && /volume/.test(d.message || '')
            && /only valid inside scene\(\)/.test(d.message || ''))
        if (!diag) throw new Error(`Expected S001 naming 'volume' and the scene() constraint, got ${JSON.stringify(result.diagnostics)}`)
    })

test('solid() with no synth in scope is still an unknown effect',
    'search filter\nsolid(r: 1).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => d.code === 'S001'
            && /solid/.test(d.message || '')
            && /only valid inside scene\(\)/.test(d.message || ''))
        if (!diag) throw new Error(`Expected S001 naming 'solid' and the scene() constraint, got ${JSON.stringify(result.diagnostics)}`)
    })

// ---------------------------------------------------------------------------
// Diagnostics report a usable column.
//
// The parser writes `loc.col`; pushDiag read `loc.column`, so every location
// it built carried `column: undefined` and the demo UI printed "col undefined".
// ---------------------------------------------------------------------------

test('a diagnostic carries a numeric column',
    'search synth, filter\nnoise().bogusEffect(1).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => d.code === 'S001')
        if (!diag) throw new Error(`Expected S001, got ${JSON.stringify(result.diagnostics)}`)
        if (!diag.location) throw new Error(`Expected a location on ${JSON.stringify(diag)}`)
        if (typeof diag.location.line !== 'number') throw new Error(`line: expected a number, got ${diag.location.line}`)
        if (typeof diag.location.column !== 'number') throw new Error(`column: expected a number, got ${diag.location.column}`)
    })

// ---------------------------------------------------------------------------
// A positional hex colour fills exactly the r/g/b slots no keyword claimed.
//
// The splat used to stand down entirely when g: or b: was present, dropping
// the Color into the float path: r clamped to 1, b left at its default, and a
// bogus S002 about 'r' on top. The colour the author typed simply vanished.
// ---------------------------------------------------------------------------

test('hex splat fills only the r/g/b slots no keyword claimed',
    'search synth, filter\nnoise().tint(#804020, g: 0.25).write(o0)', (result) => {
        const a = argsOf(result, 'filter.tint')
        if (Math.abs(a.r - 0.502) > 0.01) throw new Error(`r: expected ~0.502 from the hex, got ${a.r}`)
        if (a.g !== 0.25) throw new Error(`g: expected the keyword 0.25 to win, got ${a.g}`)
        if (Math.abs(a.b - 0.125) > 0.01) throw new Error(`b: expected ~0.125 from the hex, got ${a.b}`)
        if (result.diagnostics.length > 0) {
            throw new Error(`Expected no diagnostics, got ${JSON.stringify(result.diagnostics)}`)
        }
    })

test('a bare hex splat still fills all three slots',
    'search synth, filter\nnoise().tint(#804020).write(o0)', (result) => {
        const a = argsOf(result, 'filter.tint')
        if (Math.abs(a.r - 0.502) > 0.01) throw new Error(`r: expected ~0.502, got ${a.r}`)
        if (Math.abs(a.g - 0.251) > 0.01) throw new Error(`g: expected ~0.251, got ${a.g}`)
        if (Math.abs(a.b - 0.125) > 0.01) throw new Error(`b: expected ~0.125, got ${a.b}`)
        if (result.diagnostics.length > 0) {
            throw new Error(`Expected no diagnostics, got ${JSON.stringify(result.diagnostics)}`)
        }
    })

// ---------------------------------------------------------------------------
// scene() is a generator and must start its chain.
//
// Mid-chain it compiled clean and silently discarded the incoming surface, so
// `noise().scene(...).write(o0)` rendered the scene and threw the noise away
// with nothing said about it.
// ---------------------------------------------------------------------------

test('scene() mid-chain is diagnosed instead of eating its input',
    'search synth, filter\nnoise().scene(camera(fov: 60)).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => d.code === 'S001' && /scene\(\)/.test(d.message || ''))
        if (!diag) throw new Error(`Expected S001 for a mid-chain scene(), got ${JSON.stringify(result.diagnostics)}`)
    })

test('a second scene() in the same chain is diagnosed',
    'search synth, filter\nscene(camera(fov: 60)).scene(camera(fov: 30)).write(o0)', (result) => {
        const diag = result.diagnostics.find(d => d.code === 'S001' && /scene\(\)/.test(d.message || ''))
        if (!diag) throw new Error(`Expected S001 for a second scene(), got ${JSON.stringify(result.diagnostics)}`)
    })

test('scene() itself still passes through to the scene compiler',
    'search synth, filter\nscene(camera(fov: 60)).write(o0)', (result) => {
        const step = result.plans[0].chain.find(s => s.op === '_scene.scene')
        if (!step) throw new Error(`Expected a _scene.scene step, got ${result.plans[0].chain.map(s => s.op).join(', ')}`)
        if (!step.args || !step.args._ast) throw new Error('Expected the original AST to be preserved on the step')
        if (result.diagnostics.length > 0) {
            throw new Error(`Expected a chain-initial scene() to be clean, got ${JSON.stringify(result.diagnostics)}`)
        }
    })

// ---------------------------------------------------------------------------
// `let` bindings inside an animation descriptor.
//
// substitute() rebuilds Oscillator nodes so a `let`-bound value reaches the
// descriptor's fields, but Midi and Audio nodes were returned untouched. The
// binding then never resolved: the 2D path's resolveMidiParam/resolveAudioParam
// see an Ident, return undefined, and fall back to the parameter's DEFAULT — so
// `let ch = 5; midi(channel: ch)` silently played channel 1. In a scene() the
// same node reaches the scene compiler and throws
// `midi() channel must be a number`.
// ---------------------------------------------------------------------------

registerOp('synth.descarg', {
    name: 'descarg',
    args: [{ name: 'scale', type: 'float', default: 1, min: 0, max: 100 }]
})
registerStarterOps(['synth.noise', 'synth.descarg'])

test('a let binding resolves inside midi()',
    'search synth\nlet ch = 5\ndescarg(scale: midi(channel: ch)).write(o0)', (result) => {
        const step = result.plans[0].chain.find(s => s.op === 'synth.descarg')
        const value = step.args.scale
        if (value?.type !== 'Midi') throw new Error(`Expected a Midi descriptor, got ${JSON.stringify(value)}`)
        if (value.channel !== 5) throw new Error(`Expected channel 5 from the let binding, got ${value.channel}`)
    })

test('a let binding resolves inside midi() mode',
    'search synth\nlet m = midiMode.gateNote\ndescarg(scale: midi(channel: 2, mode: m)).write(o0)', (result) => {
        const value = result.plans[0].chain.find(s => s.op === 'synth.descarg').args.scale
        if (value?.mode !== 1) throw new Error(`Expected midiMode.gateNote (1) from the let binding, got ${value?.mode}`)
    })

test('a let binding resolves inside audio()',
    'search synth\nlet lo = 0.25\ndescarg(scale: audio(band: audioBand.low, min: lo)).write(o0)', (result) => {
        const value = result.plans[0].chain.find(s => s.op === 'synth.descarg').args.scale
        if (value?.type !== 'Audio') throw new Error(`Expected an Audio descriptor, got ${JSON.stringify(value)}`)
        if (value.min !== 0.25) throw new Error(`Expected min 0.25 from the let binding, got ${value.min}`)
    })

// ---------------------------------------------------------------------------
// A positional hex colour splatting across an r/g/b triple.
//
// The splat was detected only when the 'r' slot was filled by that positional,
// so naming `r:` as a keyword stood the splat down: the Color fell through to
// the 'g' float slot, which defaulted g AND b and reported a bogus S002 about
// 'g'. The colour claims the whole triple; a keyword overrides its own member.
// ---------------------------------------------------------------------------

registerOp('synth.rgbprobe', {
    name: 'rgbprobe',
    args: [
        { name: 'r', type: 'float', default: 1, min: 0, max: 1 },
        { name: 'g', type: 'float', default: 1, min: 0, max: 1 },
        { name: 'b', type: 'float', default: 1, min: 0, max: 1 }
    ]
})

function rgbOf(result) {
    const step = result.plans[0].chain.find(s => s.op === 'synth.rgbprobe')
    return [step.args.r, step.args.g, step.args.b]
}
const HEX = [0x80 / 255, 0x40 / 255, 0x20 / 255]
const near = (a, b) => Math.abs(a - b) < 1e-9

test('a positional hex colour splats across r/g/b',
    'search synth\nnoise().rgbprobe(#804020).write(o0)', (result) => {
        const [r, g, b] = rgbOf(result)
        if (!near(r, HEX[0]) || !near(g, HEX[1]) || !near(b, HEX[2])) {
            throw new Error(`Expected the hex components, got ${JSON.stringify([r, g, b])}`)
        }
        if (result.diagnostics.length > 0) throw new Error(`Expected no diagnostics, got ${JSON.stringify(result.diagnostics)}`)
    })

test('a g: keyword overrides only its own member of a splatted hex colour',
    'search synth\nnoise().rgbprobe(#804020, g: 0.25).write(o0)', (result) => {
        const [r, g, b] = rgbOf(result)
        if (!near(r, HEX[0]) || g !== 0.25 || !near(b, HEX[2])) {
            throw new Error(`Expected r/b from the hex and g from the keyword, got ${JSON.stringify([r, g, b])}`)
        }
        if (result.diagnostics.length > 0) throw new Error(`Expected no diagnostics, got ${JSON.stringify(result.diagnostics)}`)
    })

test('an r: keyword overrides only its own member of a splatted hex colour',
    'search synth\nnoise().rgbprobe(#804020, r: 0.25).write(o0)', (result) => {
        const [r, g, b] = rgbOf(result)
        if (r !== 0.25 || !near(g, HEX[1]) || !near(b, HEX[2])) {
            throw new Error(`Expected g/b from the hex and r from the keyword, got ${JSON.stringify([r, g, b])}`)
        }
        if (result.diagnostics.length > 0) throw new Error(`Expected no diagnostics, got ${JSON.stringify(result.diagnostics)}`)
    })
