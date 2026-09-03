/**
 * Regression test for MRT color-attachment byte budgets on mobile GPUs.
 *
 * iOS WebKit enforces Metal's 32-bytes-per-sample color attachment budget on
 * WebGL2 framebuffers (measured on iOS 26.5): any MRT whose attachment formats
 * sum past the budget is FRAMEBUFFER_UNSUPPORTED (36061). render/pointsEmit's
 * init pass writes xyz (rgba32f, 16B) + vel (rgba32f, 16B) + rgba (rgba8, 4B)
 * = 36B, so on iPhone the pass fails every frame with WebGL Error 1286 and
 * the particle layer never updates (surfaced by shade's default program).
 *
 * When the backend reports capabilities.maxColorBytesPerSample, the pipeline
 * must demote trailing rgba32f attachments of over-budget MRT groups to
 * rgba16f until the group fits — keeping the first (highest-precision-need)
 * attachments intact. Backends without the capability, and budgets the group
 * already fits, are left untouched.
 *
 * Run:  node shaders/tests/test_mrt_format_budget.js
 */

import {
    registerEffect, registerOp, registerStarterOps,
    mergeIntoEnums, stdEnums
} from '../src/index.js'
import { compileGraph } from '../src/runtime/compiler.js'
import { Pipeline } from '../src/runtime/pipeline.js'

mergeIntoEnums(stdEnums)

let passed = 0
let failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err)
        failed++
    }
}

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
            const top = { [namespace]: { [instance.func]: choicesEnum } }
            mergeIntoEnums(top)
        }
    }
}

await loadEffect(new URL('../effects/synth/noise/definition.js', import.meta.url).pathname, 'synth', 'noise')
await loadEffect(new URL('../effects/render/pointsEmit/definition.js', import.meta.url).pathname, 'render', 'pointsEmit')

class StubBackend {
    constructor(capabilities) {
        this.textures = new Map()
        if (capabilities) this.capabilities = capabilities
    }
    createTexture(id, spec) { this.textures.set(id, { width: spec.width, height: spec.height, format: spec.format }) }
    createTexture3D(id, spec) { this.textures.set(id, { width: spec.width, height: spec.height, depth: spec.depth, format: spec.format }) }
    destroyTexture(id) { this.textures.delete(id) }
}

const DSL = `search synth, render
noise().pointsEmit().write(o0)
render(o0)`

function buildPipeline(capabilities) {
    const graph = compileGraph(DSL)
    const pipeline = new Pipeline(graph, new StubBackend(capabilities))
    pipeline.width = 512
    pipeline.height = 512
    pipeline.createSurfaces()
    pipeline.recreateTextures(pipeline.collectDefaultUniforms())
    return { graph, pipeline }
}

function specFormat(graph, keyPrefix) {
    for (const [key, spec] of graph.textures.entries()) {
        if (key.startsWith(keyPrefix)) return { key, format: spec.format }
    }
    return null
}

function createdFormat(pipeline, keyPrefix) {
    for (const [key, tex] of pipeline.backend.textures.entries()) {
        if (key.startsWith(keyPrefix)) return { key, format: tex.format }
    }
    return null
}

// ---------------------------------------------------------------------------

await test('32-byte budget demotes pointsEmit vel to rgba16f, keeps xyz at rgba32f', () => {
    const { graph, pipeline } = buildPipeline({ maxColorBytesPerSample: 32 })
    const xyz = specFormat(graph, 'global_xyz')
    const vel = specFormat(graph, 'global_vel')
    const rgba = specFormat(graph, 'global_rgba')
    if (!xyz || !vel || !rgba) throw new Error(`state texture specs not found: ${JSON.stringify([xyz, vel, rgba])}`)
    if (xyz.format !== 'rgba32f') throw new Error(`${xyz.key}: expected rgba32f (positions keep precision), got ${xyz.format}`)
    if (vel.format !== 'rgba16f') throw new Error(`${vel.key}: expected rgba16f demotion, got ${vel.format}`)
    if (rgba.format !== 'rgba8') throw new Error(`${rgba.key}: expected rgba8 untouched, got ${rgba.format}`)

    const velTex = createdFormat(pipeline, 'global_vel')
    if (!velTex || velTex.format !== 'rgba16f') {
        throw new Error(`created vel texture: expected rgba16f, got ${JSON.stringify(velTex)}`)
    }
})

await test('64-byte budget leaves pointsEmit formats untouched (desktop)', () => {
    const { graph } = buildPipeline({ maxColorBytesPerSample: 64 })
    const xyz = specFormat(graph, 'global_xyz')
    const vel = specFormat(graph, 'global_vel')
    if (xyz.format !== 'rgba32f' || vel.format !== 'rgba32f') {
        throw new Error(`expected rgba32f/rgba32f untouched, got ${xyz.format}/${vel.format}`)
    }
})

await test('backend without the capability is left untouched (headless stubs)', () => {
    const { graph } = buildPipeline(undefined)
    const vel = specFormat(graph, 'global_vel')
    if (vel.format !== 'rgba32f') throw new Error(`expected rgba32f untouched, got ${vel.format}`)
})

await test('the byte table scores single-channel float formats at 4 bytes', () => {
    // The scene G-buffer's depth target is r32f; scoring it as an 8-byte
    // default overstated the pass by 4 bytes per sample.
    const { pipeline } = buildPipeline(undefined)
    if (pipeline.mrtFormatBytes('r32f') !== 4) throw new Error(`r32f scored ${pipeline.mrtFormatBytes('r32f')}, expected 4`)
    if (pipeline.mrtFormatBytes('r32float') !== 4) throw new Error(`r32float scored ${pipeline.mrtFormatBytes('r32float')}, expected 4`)
    if (pipeline.mrtFormatBytes('rgba16f') !== 8) throw new Error('rgba16f must still score 8')
    if (pipeline.mrtFormatBytes('rgba32f') !== 16) throw new Error('rgba32f must still score 16')
})

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
