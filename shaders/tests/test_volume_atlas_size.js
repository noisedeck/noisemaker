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
 * Run:  node shaders/tests/test_volume_atlas_size.js
 */

import assert from 'assert'
import {
    registerEffect, registerOp, registerStarterOps,
    mergeIntoEnums, stdEnums
} from '../src/index.js'
import { compileGraph } from '../src/runtime/compiler.js'

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

console.log(`Volume atlas size tests passed (${passed})`)
