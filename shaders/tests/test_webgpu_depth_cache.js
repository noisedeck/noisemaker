/**
 * The WebGPU depth-texture cache must be bounded.
 *
 * It is keyed by "WxH" and was never evicted, so every distinct viewport size
 * seen during a resize drag permanently allocated a depth24plus texture — and
 * SceneRenderer.resize() fires per resize event. Eviction has to be deferred
 * until submitted work has completed: destroying a texture still referenced by
 * an in-flight command buffer is a validation error, which is why the previous
 * size-keyed eviction was removed rather than fixed.
 *
 * Run: node shaders/tests/test_webgpu_depth_cache.js
 */

import assert from 'node:assert'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'

// Browser global the backend reads when describing the texture.
globalThis.GPUTextureUsage = globalThis.GPUTextureUsage ?? { RENDER_ATTACHMENT: 0x10 }

let passed = 0
let failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err.message)
        failed++
    }
}

/** Let the deferred retirement callbacks run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function stubBackend() {
    const destroyed = []
    // One resolver per onSubmittedWorkDone() call, so a test can complete the
    // work outstanding at one moment without completing a later one.
    const resolvers = []
    const backend = Object.create(WebGPUBackend.prototype)
    backend.depthTextures = new Map()
    backend.device = {
        createTexture(desc) {
            return { desc, destroy() { destroyed.push(this) } }
        },
        queue: {
            onSubmittedWorkDone() {
                return new Promise(resolve => { resolvers.push(resolve) })
            }
        }
    }
    const flushGpu = async () => {
        for (const resolve of resolvers.splice(0)) resolve()
        await settle()
    }
    return { backend, destroyed, resolvers, flushGpu }
}

/** Widths of the textures destroyed, in order — a readable identity per texture. */
const widths = destroyed => destroyed.map(texture => texture.desc.size.width)

/** Minimal state the rest of destroy() walks, so the depth paths can be exercised. */
function stubTeardownState(backend) {
    backend.textures = new Map()
    backend.programs = new Map()
    backend.pipelines = new Map()
    backend.bindGroups = new Map()
    backend.samplers = new Map()
    backend.uniformBufferPool = []
    backend.activeUniformBuffers = []
    backend.context = null
}

await test('the cache does not grow without bound across resize sizes', async () => {
    const { backend } = stubBackend()
    for (let i = 0; i < 40; i++) backend.getDepthTexture(320 + i, 240)
    assert.ok(backend.depthTextures.size <= 8,
        `depth cache grew to ${backend.depthTextures.size} entries across 40 resize steps`)
})

await test('a still-current size is reused rather than recreated', async () => {
    const { backend } = stubBackend()
    const a = backend.getDepthTexture(320, 240)
    const b = backend.getDepthTexture(320, 240)
    assert.strictEqual(a, b, 'same size must hit the cache')
})

await test('evicted depth textures are destroyed only after submitted work completes', async () => {
    const { backend, destroyed, flushGpu } = stubBackend()
    for (let i = 0; i < 40; i++) backend.getDepthTexture(320 + i, 240)
    assert.strictEqual(destroyed.length, 0,
        'nothing may be destroyed while command buffers may still reference it')
    await flushGpu()
    assert.ok(destroyed.length > 0, 'evicted textures are released once the GPU is idle')
})

await test('an eviction is not released by a promise requested before it', async () => {
    // onSubmittedWorkDone() only covers the submits outstanding when it was
    // requested. Coalescing every retirement behind the FIRST one lets a
    // texture retired later be destroyed while a submit that still references
    // it is in flight.
    const { backend, destroyed, resolvers } = stubBackend()
    for (let i = 0; i < 4; i++) backend.getDepthTexture(100 + i, 240)
    assert.strictEqual(resolvers.length, 0, 'the cache is only at its limit; nothing evicted yet')

    backend.getDepthTexture(200, 240)   // evicts the 100-wide texture
    backend.getDepthTexture(201, 240)   // evicts the 101-wide texture
    assert.strictEqual(resolvers.length, 2,
        `each eviction needs its own onSubmittedWorkDone, got ${resolvers.length} for two evictions`)

    resolvers[0]()
    await settle()
    assert.deepStrictEqual(widths(destroyed), [100],
        `only the texture retired before that promise may be released by it, got ${widths(destroyed)}`)

    resolvers[1]()
    await settle()
    assert.deepStrictEqual(widths(destroyed), [100, 101],
        'the later eviction is released by its own promise')
})

await test('destroy() drains retirements so none fire against a torn-down device', async () => {
    const { backend, destroyed, resolvers } = stubBackend()
    for (let i = 0; i < 4; i++) backend.getDepthTexture(100 + i, 240)
    backend.getDepthTexture(200, 240)   // evicts the 100-wide texture
    assert.strictEqual(destroyed.length, 0, 'the retirement is still deferred')

    stubTeardownState(backend)
    backend.destroy()
    const atTeardown = destroyed.length
    assert.ok(atTeardown > 0, 'teardown releases the depth textures it still owns')

    resolvers[0]()
    await settle()
    assert.strictEqual(destroyed.length, atTeardown,
        `a retirement deferred past destroy() must not touch anything, got ${destroyed.length - atTeardown} late destroy call(s)`)
    assert.strictEqual(new Set(destroyed).size, destroyed.length,
        'no texture may be destroyed twice')
})

console.log(`\nWebGPU depth cache: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
