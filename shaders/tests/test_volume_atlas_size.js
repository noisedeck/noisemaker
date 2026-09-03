/**
 * A volume() scene node can only read a 64-cube atlas.
 *
 * The vol0..vol7 globals are allocated at a hardwired 64 x 4096 rgba16f
 * (pipeline.js createSurfaces, `volumeSliceSize = 64`), and the marcher decodes
 * them with the matching slice stride (`y + z * 64`, volume-shaders.js
 * atlasTexel, driven by VOLUME_ATLAS_SIZE in volume-renderer.js).
 *
 * write3d into a volN global, though, is a plain 2D blit (expander.js
 * `_write3d_vol_blit`). A producer chain at volumeSize x32 emits a 32 x 1024
 * atlas, the blit STRETCHES it to 64 x 4096, and the marcher then reads slices
 * that straddle the stretched slice boundaries: a sheared volume that renders
 * plausibly and reports nothing. Measured on the reviewer's probe: 75% duplicate
 * rows, IoU 0.935 against the correct field — wrong, but not wrong enough to
 * look wrong.
 *
 * The graph knows both halves at compile time, so this is a compile error.
 *
 * The same shear is reachable at runtime without recompiling: the UI paths
 * (canvas.applyStepParameterValues / applyParameterValues,
 * program-state._applyToPipeline, Pipeline.setUniform) patch pass uniforms in
 * place, so a program that compiles clean at x64 can be dragged to x32 by a
 * slider. The second half of this file covers that path, where the answer is
 * warn-and-refuse rather than a compile error: the constraint is the same, and
 * x64 is the only value the marcher can decode.
 *
 * Run:  node shaders/tests/test_volume_atlas_size.js
 */

import assert from 'assert'
import {
    registerEffect, registerOp, registerStarterOps,
    mergeIntoEnums, stdEnums
} from '../src/index.js'
import { compileGraph, recompile } from '../src/runtime/compiler.js'
import { Pipeline } from '../src/runtime/pipeline.js'
import { CanvasRenderer } from '../src/renderer/canvas.js'

mergeIntoEnums(stdEnums)

async function loadEffect(file, namespace, name) {
    const mod = await import(file)
    const def = mod.default
    const instance = (typeof def === 'function') ? new def() : def
    registerEffect(instance.func, instance)
    registerEffect(`${namespace}.${instance.func}`, instance)
    registerEffect(`${namespace}/${name}`, instance)
    registerEffect(`${namespace}.${name}`, instance)

    const args = Object.entries(instance.globals || {}).map(([key, spec]) => {
        let enumPath = spec.enum || spec.enumPath
        if (spec.choices && !enumPath) enumPath = `${namespace}.${instance.func}.${key}`
        return {
            name: key,
            type: spec.type === 'vec4' ? 'color' : spec.type,
            default: spec.default,
            enum: enumPath,
            enumPath,
            min: spec.min,
            max: spec.max,
            uniform: spec.uniform,
            choices: spec.choices
        }
    })
    registerOp(`${namespace}.${instance.func}`, { name: instance.func, args })

    const isStarter = !((instance.passes || []).some(p =>
        p.inputs && Object.values(p.inputs).some(v =>
            ['inputTex', 'inputTex3d', 'src', 'o0', 'o1'].includes(v))))
    if (isStarter) registerStarterOps([`${namespace}.${instance.func}`])
    if (instance.enums) mergeIntoEnums(instance.enums)
    if (instance.globals) {
        const choicesEnum = {}
        for (const [key, spec] of Object.entries(instance.globals)) {
            if (spec.choices) {
                const inner = {}
                for (const [n, v] of Object.entries(spec.choices)) {
                    if (n.endsWith(':')) continue
                    inner[n] = { type: 'Number', value: v }
                }
                choicesEnum[key] = inner
            }
        }
        if (Object.keys(choicesEnum).length) {
            mergeIntoEnums({ [namespace]: { [instance.func]: choicesEnum } })
        }
    }
}

await loadEffect(new URL('../effects/synth3d/noise3d/definition.js', import.meta.url).pathname, 'synth3d', 'noise3d')
await loadEffect(new URL('../effects/render/render3d/definition.js', import.meta.url).pathname, 'render', 'render3d')

// The single-effect host path (docs viewer, MCP harness, foundry) hands
// applyParameterValues an effect descriptor rather than per-step state.
const noise3dModule = await import(new URL('../effects/synth3d/noise3d/definition.js', import.meta.url).pathname)
const noise3dEffect = {
    instance: (typeof noise3dModule.default === 'function')
        ? new noise3dModule.default()
        : noise3dModule.default,
    namespace: 'synth3d'
}

const CAMERA = 'camera(fov: 55, pos: [0, 4, -1.6], target: [0, 0, 0])'

function program({ volumeSize, writeTo = 'vol0', readFrom = 'vol0', scene = true }) {
    const size = volumeSize === null ? '' : `, volumeSize: x${volumeSize}`
    const producer = `noise3d(speed: 0, seed: 4, scale: 3${size}).write3d(${writeTo}, geo0)`
    if (!scene) {
        return `search synth3d, render
${producer}
noise3d(speed: 0, seed: 4, scale: 3${size}).render3d().write(o0)
render(o0)`
    }
    return `search synth3d
${producer}
scene(
  ${CAMERA},
  volume(${readFrom}, threshold: 0.5)
).write(o0)
render(o0)`
}

function compileError(source) {
    try {
        compileGraph(source)
    } catch (err) {
        return err
    }
    return null
}

let passed = 0
function check(name, fn) {
    fn()
    console.log(`PASS: ${name}`)
    passed++
}

// The failing case: a 32-cube producer feeding a scene volume.
check('a non-64 producer feeding a scene volume fails compilation', () => {
    const err = compileError(program({ volumeSize: 32 }))
    assert.ok(err, 'compilation must not succeed')
    assert.strictEqual(err.code, 'ERR_VOLUME_ATLAS_SIZE', `unexpected error: ${JSON.stringify(err)}`)

    const message = err.errors.map(e => e.message).join(' ')
    // The message has to be actionable on its own: which surface, what the
    // producer actually is, and what is required.
    assert.ok(message.includes('vol0'), `names the surface: ${message}`)
    assert.ok(message.includes('32'), `names the producer's size: ${message}`)
    assert.ok(message.includes('64'), `names the requirement: ${message}`)
    assert.ok(/volumeSize/.test(message), `names the parameter to change: ${message}`)
})

// The passing case, same shape.
check('an x64 producer feeding a scene volume compiles', () => {
    const graph = compileGraph(program({ volumeSize: 64 }))
    assert.strictEqual(graph._isScene, true, 'precondition: this is a scene program')
    assert.strictEqual(
        graph.sceneIR.nodes.filter(n => n.type === 'volume').length, 1,
        'precondition: the scene has a volume node')
})

// noise3d's own default is 64, so the common case — no volumeSize at all —
// must keep compiling.
check('a producer with no explicit volumeSize compiles', () => {
    compileGraph(program({ volumeSize: null }))
})

// The check is about the scene marcher's fixed decode, so a program with no
// scene() is none of its business: render3d reads the same global with its own
// u_volumeSize and is unaffected.
check('a non-scene program at x32 is unaffected', () => {
    const graph = compileGraph(program({ volumeSize: 32, scene: false }))
    assert.strictEqual(graph._isScene, false, 'precondition: no scene node')
})

// Only the surfaces a volume node actually reads are constrained. An x32 chain
// written to a global no volume() references stays legal.
check('an x32 producer on an unreferenced surface is unaffected', () => {
    compileGraph(program({ volumeSize: 32, writeTo: 'vol1', readFrom: 'vol0' }))
})

// Every offending surface is reported, not just the first — fixing one and
// recompiling to discover the next is a bad loop.
check('every offending surface is named at once', () => {
    const source = `search synth3d
noise3d(speed: 0, seed: 1, volumeSize: x32).write3d(vol0, geo0)
noise3d(speed: 0, seed: 2, volumeSize: x128).write3d(vol1, geo1)
scene(
  ${CAMERA},
  volume(vol0, threshold: 0.5),
  volume(vol1, threshold: 0.5)
).write(o0)
render(o0)`
    const err = compileError(source)
    assert.ok(err, 'compilation must not succeed')
    assert.strictEqual(err.errors.length, 2, `one error per offending surface: ${JSON.stringify(err.errors)}`)
    const message = err.errors.map(e => e.message).join(' ')
    assert.ok(message.includes('vol0') && message.includes('32'), `reports vol0 at 32: ${message}`)
    assert.ok(message.includes('vol1') && message.includes('128'), `reports vol1 at 128: ${message}`)
})

// ---------------------------------------------------------------------------
// Runtime updates. A slider drag never re-enters compileGraph, so the same
// constraint has to hold on the in-place uniform patch paths.
// ---------------------------------------------------------------------------

class StubBackend {
    constructor() { this.textures = new Map() }
    createTexture(id, spec) { this.textures.set(id, { width: spec.width, height: spec.height }) }
    createTexture3D(id, spec) { this.textures.set(id, { width: spec.width, height: spec.height, depth: spec.depth }) }
    destroyTexture(id) { this.textures.delete(id) }
}

function buildPipeline(source) {
    const graph = compileGraph(source)
    const pipeline = new Pipeline(graph, new StubBackend())
    pipeline.width = 512
    pipeline.height = 512
    pipeline.createSurfaces()
    pipeline.recreateTextures(pipeline.collectDefaultUniforms())
    const renderer = Object.create(CanvasRenderer.prototype)
    renderer._pipeline = pipeline
    renderer._uniformBindings = new Map()
    return { graph, pipeline, renderer }
}

/** Run `fn` with console.warn captured, and return what it wrote. */
function captureWarnings(fn) {
    const warnings = []
    const original = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
        fn()
    } finally {
        console.warn = original
    }
    return warnings
}

function atlasSize(pipeline, texId) {
    const tex = pipeline.backend.textures.get(texId)
    return tex ? `${tex.width}x${tex.height}` : null
}

/** The chain's emitter pass — the one a UI slider writes. */
function emitter(graph) {
    const pass = graph.passes.find(p => p.effectFunc === 'noise3d')
    assert.ok(pass, 'precondition: the producer chain has a noise3d pass')
    return pass
}

check('a runtime drag off x64 is refused on a chain feeding a scene volume', () => {
    const { graph, pipeline, renderer } = buildPipeline(program({ volumeSize: 64 }))
    const producer = emitter(graph)
    assert.strictEqual(producer.uniforms.volumeSize, 64, 'precondition: compiled at x64')
    assert.strictEqual(atlasSize(pipeline, 'node_0_volumeCache'), '64x4096',
        'precondition: the producer atlas matches the global')

    const warnings = captureWarnings(() => {
        renderer.applyStepParameterValues({
            [`step_${producer.stepIndex}`]: { volumeSize: 32 }
        })
    })

    assert.strictEqual(producer.uniforms.volumeSize, 64, 'the uniform must be left unchanged')
    assert.strictEqual(producer.uniforms.volumeSize_chain_0, 64,
        'the chain-scoped variant must be left unchanged')
    assert.strictEqual(atlasSize(pipeline, 'node_0_volumeCache'), '64x4096',
        'the producer atlas must not be resized out from under the marcher')

    const text = warnings.join(' ')
    assert.ok(/vol0/.test(text), `the warning names the surface: ${text}`)
    assert.ok(/32/.test(text), `the warning names the refused value: ${text}`)
    assert.ok(/64/.test(text), `the warning names the requirement: ${text}`)
    assert.ok(/volumeSize/.test(text), `the warning names the parameter: ${text}`)
})

check('a runtime update to x64 is accepted and silent', () => {
    const { graph, pipeline, renderer } = buildPipeline(program({ volumeSize: 64 }))
    const producer = emitter(graph)

    const warnings = captureWarnings(() => {
        renderer.applyStepParameterValues({
            [`step_${producer.stepIndex}`]: { volumeSize: 64, seed: 9 }
        })
    })

    assert.strictEqual(producer.uniforms.volumeSize, 64)
    assert.strictEqual(producer.uniforms.seed, 9, 'other params on the same pass still apply')
    assert.deepStrictEqual(warnings, [], `no warning for a legal value: ${warnings.join(' ')}`)
    assert.strictEqual(atlasSize(pipeline, 'node_0_volumeCache'), '64x4096')
})

check('a chain writing a surface no volume() reads still takes runtime updates', () => {
    const { graph, pipeline, renderer } = buildPipeline(
        program({ volumeSize: 64, writeTo: 'vol1', readFrom: 'vol0' }))
    const producer = emitter(graph)

    const warnings = captureWarnings(() => {
        renderer.applyStepParameterValues({
            [`step_${producer.stepIndex}`]: { volumeSize: 32 }
        })
    })

    assert.strictEqual(producer.uniforms.volumeSize, 32, 'unconstrained chain: the update applies')
    assert.strictEqual(atlasSize(pipeline, 'node_0_volumeCache'), '32x1024')
    assert.deepStrictEqual(warnings, [], `no warning off the marched path: ${warnings.join(' ')}`)
})

check('a sibling chain in the same scene program still resizes', () => {
    // Two 3D chains, only one of them marched. The pin is per chain scope, so
    // vol1's chain must stay free — refusing it would be a false positive that
    // freezes an unrelated slider.
    const { graph, pipeline, renderer } = buildPipeline(`search synth3d
noise3d(speed: 0, seed: 1, scale: 3, volumeSize: x64).write3d(vol0, geo0)
noise3d(speed: 0, seed: 2, scale: 3, volumeSize: x64).write3d(vol1, geo1)
scene(
  ${CAMERA},
  volume(vol0, threshold: 0.5)
).write(o0)
render(o0)`)

    const marched = graph.passes.find(p => p.scopedParams?.volumeSize === 'volumeSize_chain_0')
    const free = graph.passes.find(p => p.scopedParams?.volumeSize === 'volumeSize_chain_1')
    assert.ok(marched && free, 'precondition: two chain-scoped producers')

    const warnings = captureWarnings(() => {
        renderer.applyStepParameterValues({
            [`step_${free.stepIndex}`]: { volumeSize: 32 },
            [`step_${marched.stepIndex}`]: { volumeSize: 32 }
        })
    })

    assert.strictEqual(free.uniforms.volumeSize, 32, 'the unmarched chain takes the update')
    assert.strictEqual(marched.uniforms.volumeSize, 64, 'the marched chain is refused')
    assert.strictEqual(atlasSize(pipeline, `${free.nodeId}_volumeCache`), '32x1024')
    assert.strictEqual(atlasSize(pipeline, `${marched.nodeId}_volumeCache`), '64x4096')
    assert.strictEqual(warnings.length, 1, `exactly one refusal: ${warnings.join(' ')}`)
    assert.ok(/vol0/.test(warnings[0]) && !/vol1/.test(warnings[0]),
        `the warning names the marched surface only: ${warnings[0]}`)
})

check('a non-scene program is unaffected by the runtime guard', () => {
    const { graph, pipeline, renderer } = buildPipeline(program({ volumeSize: 64, scene: false }))
    const producer = emitter(graph)

    const warnings = captureWarnings(() => {
        renderer.applyStepParameterValues({
            [`step_${producer.stepIndex}`]: { volumeSize: 32 }
        })
    })

    assert.strictEqual(producer.uniforms.volumeSize, 32, 'no scene: the update applies')
    assert.strictEqual(atlasSize(pipeline, 'node_0_volumeCache'), '32x1024')
    assert.deepStrictEqual(warnings, [], `no warning without a scene: ${warnings.join(' ')}`)
})

check('applyParameterValues (single-effect host path) is refused too', () => {
    const { graph, renderer } = buildPipeline(program({ volumeSize: 64 }))
    const producer = emitter(graph)

    const warnings = captureWarnings(() => {
        renderer.applyParameterValues(noise3dEffect, { volumeSize: 32 })
    })

    assert.strictEqual(producer.uniforms.volumeSize, 64, 'the uniform must be left unchanged')
    assert.ok(/vol0/.test(warnings.join(' ')), `warns: ${warnings.join(' ')}`)
})

check('the ProgramState broadcast path is refused at the pipeline', () => {
    // demo/shaders/lib/program-state.js _applyToPipeline writes pass.uniforms
    // itself and then calls broadcastChainScopedParam. The guard has to hold
    // there too, which means restoring the pinned size on the source pass.
    const { graph, pipeline } = buildPipeline(program({ volumeSize: 64 }))
    const producer = emitter(graph)

    const warnings = captureWarnings(() => {
        producer.uniforms.volumeSize = 32
        producer.uniforms.volumeSize_chain_0 = 32
        pipeline.broadcastChainScopedParam(producer, 'volumeSize', 'volumeSize_chain_0')
    })

    assert.strictEqual(producer.uniforms.volumeSize, 64, 'the source pass is restored')
    assert.strictEqual(producer.uniforms.volumeSize_chain_0, 64, 'the chain-scoped variant is restored')
    assert.ok(/vol0/.test(warnings.join(' ')), `warns: ${warnings.join(' ')}`)
})

check('Pipeline.setUniform is refused on a scene volume program', () => {
    const { graph, pipeline } = buildPipeline(program({ volumeSize: 64 }))
    const producer = emitter(graph)

    const warnings = captureWarnings(() => pipeline.setUniform('volumeSize', 32))

    assert.strictEqual(producer.uniforms.volumeSize, 64, 'the uniform must be left unchanged')
    assert.strictEqual(atlasSize(pipeline, 'node_0_volumeCache'), '64x4096')
    assert.ok(/vol0/.test(warnings.join(' ')), `warns: ${warnings.join(' ')}`)
})

// The refusal's ONLY signal is the warning: the drag is silently reverted to
// the pinned size and no diagnostic reaches the caller. The warn-once memo is
// therefore load-bearing, and it is keyed by scope and value — not by graph.
// A memo that outlives the graph it was built against makes every refusal
// after the first recompile completely silent, which is the failure mode the
// guard exists to prevent.
check('a refusal warns again after the graph is swapped by a recompile', () => {
    const { graph, pipeline, renderer } = buildPipeline(program({ volumeSize: 64 }))
    const producer = emitter(graph)
    const drag = () => renderer.applyStepParameterValues({
        [`step_${producer.stepIndex}`]: { volumeSize: 32 }
    })

    const first = captureWarnings(drag)
    assert.ok(/vol0/.test(first.join(' ')), `the first refusal warns: ${first.join(' ')}`)

    // Within one graph the memo does its job: an identical drag is silent.
    assert.deepStrictEqual(captureWarnings(drag), [],
        'a repeated identical drag stays quiet on the same graph')

    const newGraph = recompile(pipeline, program({ volumeSize: 64 }))
    assert.ok(newGraph, 'precondition: the recompile succeeded')
    assert.strictEqual(pipeline.graph, newGraph, 'precondition: the graph was swapped')

    const afterProducer = emitter(newGraph)
    const afterWarnings = captureWarnings(() => renderer.applyStepParameterValues({
        [`step_${afterProducer.stepIndex}`]: { volumeSize: 32 }
    }))
    assert.strictEqual(afterProducer.uniforms.volumeSize, 64,
        'the new graph is still refused')
    assert.ok(/vol0/.test(afterWarnings.join(' ')),
        `the refusal must warn again against the new graph: ${JSON.stringify(afterWarnings)}`)
})

console.log(`Volume atlas size tests passed (${passed})`)
