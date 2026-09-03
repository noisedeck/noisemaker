/**
 * An MRT pass may not target a cube texture — and both backends must say so.
 *
 * WebGL2 guarded its cube-face selection with `!isMRT`, so an MRT pass aimed at
 * a cube map quietly rendered every attachment into whichever face was bound
 * when the FBO was created (+X). WebGPU's executeMRTRenderPass never read
 * pass.cubeFace at all and attached `tex.view`, which for a cube texture is a
 * `dimension: 'cube'` view and is not a legal colour attachment — so it failed
 * validation somewhere downstream, far from the cause.
 *
 * Nothing reaches this today (the probe lighting pass is single-output), but it
 * is one drawBuffers change away. Fail loudly at the pass instead.
 *
 * Run: node shaders/tests/test_mrt_cube_target.js
 */

import assert from 'node:assert'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'
import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err.message)
        failed++
    }
}

const CUBE_TEX = {
    handle: 'cube-handle',
    width: 256,
    height: 256,
    cube: true,
    format: 'rgba16f',
    gpuFormat: 'rgba16float',
    view: { dimension: 'cube' },
    faceViews: [0, 1, 2, 3, 4, 5].map(f => ({ face: f }))
}

const FLAT_TEX = {
    handle: 'flat-handle',
    width: 256,
    height: 256,
    format: 'rgba16f',
    gpuFormat: 'rgba16float',
    view: { dimension: '2d' }
}

const MRT_PASS = {
    id: 'scene_probe_gbuf_pass',
    program: 'scene_mesh_gbuf',
    drawMode: 'triangles',
    cubeFace: 2,
    drawBuffers: 2,
    outputs: { color0: 'probe_cube', color1: 'scene_gbuf_normal_roughness' }
}

// --- WebGPU ---------------------------------------------------------------

// Browser global the depth-texture path reads.
globalThis.GPUTextureUsage = globalThis.GPUTextureUsage ?? { RENDER_ATTACHMENT: 0x10 }

const WEBGPU_PROGRAM = {
    pipelineCache: new Map(),
    vertexModule: {},
    fragmentModule: {},
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main'
}

function webgpuBackend() {
    const backend = Object.create(WebGPUBackend.prototype)
    backend.textures = new Map([
        ['probe_cube', CUBE_TEX],
        ['scene_gbuf_normal_roughness', FLAT_TEX]
    ])
    backend.depthTextures = new Map()
    backend.device = {
        createRenderPipeline() { return {} },
        createTexture() { return { createView() { return {} } } }
    }
    backend.commandEncoder = {
        beginRenderPass() {
            throw new Error('a cube MRT pass must be rejected before the render pass is begun')
        }
    }
    return backend
}

test('WebGPU rejects an MRT pass targeting a cube texture', () => {
    const backend = webgpuBackend()
    assert.throws(
        () => backend.executeMRTRenderPass(MRT_PASS, WEBGPU_PROGRAM, {}, Object.keys(MRT_PASS.outputs)),
        (err) => {
            assert.ok(err instanceof Error, `expected an Error, got ${JSON.stringify(err)}`)
            assert.ok(err.message.includes('scene_probe_gbuf_pass'),
                `the error must name the pass: ${err.message}`)
            assert.ok(err.message.includes('probe_cube'),
                `the error must name the cube texture: ${err.message}`)
            return true
        }
    )
})

test('WebGPU still accepts a flat MRT target', () => {
    const backend = webgpuBackend()
    const pass = { ...MRT_PASS, outputs: { color0: 'scene_gbuf_normal_roughness' } }
    // beginRenderPass throwing marks the point where output resolution succeeded.
    assert.throws(
        () => backend.executeMRTRenderPass(pass, WEBGPU_PROGRAM, {}, Object.keys(pass.outputs)),
        /rejected before the render pass is begun/,
        'a non-cube MRT target must reach the render pass'
    )
})

// --- WebGL2 ---------------------------------------------------------------

function webgl2Backend() {
    const backend = Object.create(WebGL2Backend.prototype)
    backend.gl = {
        NO_ERROR: 0,
        getError() { return 0 },
        useProgram() {}
    }
    backend._glCheckThisFrame = false
    backend.programs = new Map([['scene_mesh_gbuf', { handle: 'prog' }]])
    backend.textures = new Map([
        ['probe_cube', CUBE_TEX],
        ['scene_gbuf_normal_roughness', FLAT_TEX]
    ])
    backend.fbos = new Map()
    backend.createMRTFBO = () => {
        throw new Error('a cube MRT pass must be rejected before the FBO is built')
    }
    return backend
}

test('WebGL2 rejects an MRT pass targeting a cube texture', () => {
    const backend = webgl2Backend()
    assert.throws(
        () => backend.executePass(MRT_PASS, {}),
        (err) => {
            assert.ok(err instanceof Error, `expected an Error, got ${JSON.stringify(err)}`)
            assert.ok(err.message.includes('scene_probe_gbuf_pass'),
                `the error must name the pass: ${err.message}`)
            assert.ok(err.message.includes('probe_cube'),
                `the error must name the cube texture: ${err.message}`)
            return true
        }
    )
})

test('WebGL2 still accepts a flat MRT target', () => {
    const backend = webgl2Backend()
    const pass = { ...MRT_PASS, outputs: { color0: 'scene_gbuf_normal_roughness', color1: 'scene_gbuf_normal_roughness' } }
    assert.throws(
        () => backend.executePass(pass, {}),
        /rejected before the FBO is built/,
        'a non-cube MRT target must reach FBO creation'
    )
})

console.log(`\nMRT cube target guard: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
