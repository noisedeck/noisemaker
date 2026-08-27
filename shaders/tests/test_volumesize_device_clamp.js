/**
 * Regression test for device-limit clamping of volumeSize in 3D chains.
 *
 * Mobile WebKit caps WebGL2 MAX_TEXTURE_SIZE at 8192 (measured on iOS 26.5;
 * desktop browsers report 16384). The 3D volume atlas is sized
 * volumeSize × volumeSize², so volumeSize=128 demands a 128×16384 texture:
 * the allocation fails on every iPhone (GL_INVALID_VALUE, incomplete FBO),
 * the volume samples as zeros, and renderLit3d degrades to a flat gray
 * "solid cube" (reported against sharing.noisedeck.app/s/Fdx90w).
 *
 * The pipeline must clamp the effective volumeSize so that
 * volumeSize² ≤ capabilities.maxTextureSize, snapping down power-of-two so
 * the atlas allocates and shader addressing agrees with the texture. The
 * clamp covers all three write paths into pass uniforms:
 *   - graph load (expander output) — the share-link path
 *   - Pipeline.setUniform — host/global updates
 *   - runtime UI updates (applyStepParameterValues → broadcastChainScopedParam)
 *
 * A backend without capabilities (headless stubs) and devices whose limit
 * admits the requested size must be left untouched.
 *
 * Run:  node shaders/tests/test_volumesize_device_clamp.js
 */

import { CanvasRenderer } from '../src/renderer/canvas.js'
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

await loadEffect(new URL('../effects/synth3d/noise3d/definition.js', import.meta.url).pathname, 'synth3d', 'noise3d')
await loadEffect(new URL('../effects/filter3d/palette3d/definition.js', import.meta.url).pathname, 'filter3d', 'palette3d')
await loadEffect(new URL('../effects/render/renderLit3d/definition.js', import.meta.url).pathname, 'render', 'renderLit3d')

class StubBackend {
    constructor(capabilities) {
        this.textures = new Map()
        if (capabilities) this.capabilities = capabilities
    }
    createTexture(id, spec) { this.textures.set(id, { width: spec.width, height: spec.height, format: spec.format }) }
    createTexture3D(id, spec) { this.textures.set(id, { width: spec.width, height: spec.height, depth: spec.depth, format: spec.format }) }
    destroyTexture(id) { this.textures.delete(id) }
}

const SCREEN = 1024

const SHARE_DSL = `search synth3d, filter3d, render
noise3d(volumeSize: x128).palette3d().renderLit3d().write(o0)
render(o0)`

function buildPipeline(dsl, capabilities) {
    const graph = compileGraph(dsl)
    const pipeline = new Pipeline(graph, new StubBackend(capabilities))
    pipeline.width = SCREEN
    pipeline.height = SCREEN
    pipeline.createSurfaces()
    pipeline.recreateTextures(pipeline.collectDefaultUniforms())
    return { graph, pipeline }
}

function getTexSize(pipeline, texId) {
    const tex = pipeline.backend.textures.get(texId)
    return tex ? `${tex.width}x${tex.height}` : null
}

function assertSize(pipeline, texId, expected, label) {
    const actual = getTexSize(pipeline, texId)
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`)
    }
}

function assertAllVolumeSizeUniforms(graph, expected, label) {
    for (const pass of graph.passes) {
        if (!pass.uniforms) continue
        for (const [key, value] of Object.entries(pass.uniforms)) {
            if (key !== 'volumeSize' && !key.startsWith('volumeSize_chain_') && !key.startsWith('volumeSize_node_')) continue
            if (typeof value !== 'number') continue
            if (value !== expected) {
                throw new Error(`${label}: pass ${pass.id} uniform ${key} expected ${expected}, got ${value}`)
            }
        }
    }
}

const MOBILE_CAPS = { isMobile: true, maxTextureSize: 8192, maxStateSize: 512 }
const DESKTOP_CAPS = { isMobile: false, maxTextureSize: 16384, maxStateSize: 2048 }

// ---------------------------------------------------------------------------

await test('graph load on an 8192-limit device clamps x128 chain to 64 (atlas fits, shaders agree)', () => {
    const { graph, pipeline } = buildPipeline(SHARE_DSL, MOBILE_CAPS)
    assertSize(pipeline, 'node_0_volumeCache', '64x4096', 'noise3d atlas')
    assertSize(pipeline, 'node_1_volumeCache', '64x4096', 'palette3d atlas')
    assertAllVolumeSizeUniforms(graph, 64, 'clamped uniforms')
})

await test('graph load on a 16384-limit device leaves x128 untouched', () => {
    const { graph, pipeline } = buildPipeline(SHARE_DSL, DESKTOP_CAPS)
    assertSize(pipeline, 'node_0_volumeCache', '128x16384', 'noise3d atlas')
    assertSize(pipeline, 'node_1_volumeCache', '128x16384', 'palette3d atlas')
    assertAllVolumeSizeUniforms(graph, 128, 'unclamped uniforms')
})

await test('backend without capabilities is left untouched (headless stubs)', () => {
    const { graph, pipeline } = buildPipeline(SHARE_DSL, undefined)
    assertSize(pipeline, 'node_0_volumeCache', '128x16384', 'noise3d atlas')
    assertAllVolumeSizeUniforms(graph, 128, 'uniforms without caps')
})

await test('a 2048-limit device clamps x128 to 32', () => {
    const { graph, pipeline } = buildPipeline(SHARE_DSL, { maxTextureSize: 2048 })
    assertSize(pipeline, 'node_0_volumeCache', '32x1024', 'noise3d atlas')
    assertAllVolumeSizeUniforms(graph, 32, 'clamped uniforms')
})

await test('runtime UI bump beyond the device limit clamps instead of breaking the atlas', () => {
    const { graph, pipeline } = buildPipeline(
        `search synth3d, filter3d, render
noise3d(volumeSize: x64).palette3d().renderLit3d().write(o0)
render(o0)`,
        MOBILE_CAPS
    )
    assertSize(pipeline, 'node_0_volumeCache', '64x4096', 'initial atlas')

    const noisePass = graph.passes.find(p => p.stepIndex === 0)
    if (!noisePass) throw new Error('noise3d pass not found')

    const renderer = Object.create(CanvasRenderer.prototype)
    renderer._pipeline = pipeline
    renderer.applyStepParameterValues({
        [`step_${noisePass.stepIndex}`]: { volumeSize: 128 }
    })

    assertSize(pipeline, 'node_0_volumeCache', '64x4096', 'atlas after bump')
    assertSize(pipeline, 'node_1_volumeCache', '64x4096', 'palette3d atlas after bump')
    assertAllVolumeSizeUniforms(graph, 64, 'uniforms after bump')
})

await test('setUniform beyond the device limit clamps like the stateSize cap', () => {
    const { graph, pipeline } = buildPipeline(
        `search synth3d, filter3d, render
noise3d(volumeSize: x64).palette3d().renderLit3d().write(o0)
render(o0)`,
        MOBILE_CAPS
    )
    pipeline.setUniform('volumeSize', 128)
    assertSize(pipeline, 'node_0_volumeCache', '64x4096', 'atlas after setUniform')
    assertAllVolumeSizeUniforms(graph, 64, 'uniforms after setUniform')
})

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
