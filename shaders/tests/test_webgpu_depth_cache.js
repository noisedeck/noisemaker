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

function stubBackend() {
    const destroyed = []
    let resolveWork = null
    const backend = Object.create(WebGPUBackend.prototype)
    backend.depthTextures = new Map()
    backend.device = {
        createTexture(desc) {
            return { desc, destroy() { destroyed.push(this) } }
        },
        queue: {
            onSubmittedWorkDone() {
                return new Promise(resolve => { resolveWork = resolve })
            }
        }
    }
    return { backend, destroyed, flushGpu: async () => { if (resolveWork) resolveWork(); await Promise.resolve() } }
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

console.log(`\nWebGPU depth cache: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
