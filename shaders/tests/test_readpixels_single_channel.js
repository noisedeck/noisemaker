/**
 * readPixels must handle single-channel float textures.
 *
 * scene_gbuf_depth is r32f. Both backends assumed four channels: WebGPU has no
 * r32float case, so it fell through to the rgba8unorm branch and reinterpreted
 * 4 bytes of ONE float as 4 unorm bytes; WebGL2 asked gl.readPixels for
 * RGBA/FLOAT from an R32F attachment, which is not the implementation colour
 * read format and yields nothing useful. Both returned garbage without
 * complaining, which is how a depth divergence stayed invisible.
 *
 * The contract stays what it always was — top-down RGBA8 — so a single-channel
 * texture reads back as greyscale: the value in R, G and B, alpha opaque.
 *
 * Run: node shaders/tests/test_readpixels_single_channel.js
 */

import assert from 'node:assert'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'
import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'

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

const WIDTH = 4
const HEIGHT = 2

// Top-down, as WebGPU stores it.
const DEPTH_ROWS = [
    [0.125, 0.375, 0.625, 0.875],
    [0.0, 0.25, 0.5, 1.0]
]
const EXPECTED_GREY = [
    [32, 96, 159, 223],
    [0, 64, 128, 255]
]

function expectedRGBA() {
    const out = new Uint8Array(WIDTH * HEIGHT * 4)
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const v = EXPECTED_GREY[y][x]
            const i = (y * WIDTH + x) * 4
            out[i] = v
            out[i + 1] = v
            out[i + 2] = v
            out[i + 3] = 255
        }
    }
    return out
}

// --- WebGPU ---------------------------------------------------------------

globalThis.GPUBufferUsage = globalThis.GPUBufferUsage ?? { COPY_DST: 0x8, MAP_READ: 0x1 }
globalThis.GPUMapMode = globalThis.GPUMapMode ?? { READ: 0x1 }

/**
 * @param {string} gpuFormat
 * @param {(bytesPerRow: number) => ArrayBuffer} fill - Produces the mapped bytes.
 */
function webgpuBackend(gpuFormat, fill) {
    const copies = []
    const backend = Object.create(WebGPUBackend.prototype)
    backend.textures = new Map([['scene_gbuf_depth', {
        handle: 'depth-handle', width: WIDTH, height: HEIGHT, gpuFormat
    }]])
    let mapped = null
    backend.device = {
        createBuffer(desc) {
            return {
                desc,
                async mapAsync() {},
                getMappedRange() { return mapped },
                unmap() {},
                destroy() {}
            }
        },
        createCommandEncoder() {
            return {
                copyTextureToBuffer(src, dst, size) {
                    copies.push({ src, dst, size })
                    mapped = fill(dst.bytesPerRow)
                },
                finish() { return {} }
            }
        }
    }
    backend.queue = { submit() {} }
    return { backend, copies }
}

await test('WebGPU sizes the r32float staging copy at 4 bytes per pixel', async () => {
    const { backend, copies } = webgpuBackend('r32float', (bytesPerRow) => new ArrayBuffer(bytesPerRow * HEIGHT))
    await backend.readPixels('scene_gbuf_depth')
    assert.strictEqual(copies.length, 1)
    assert.strictEqual(copies[0].dst.bytesPerRow, 256,
        'r32float is 4 bytes per pixel, aligned up to the 256-byte row requirement')
    assert.strictEqual(copies[0].dst.buffer.desc.size, 256 * HEIGHT)
})

await test('WebGPU decodes r32float as greyscale, not as packed rgba8', async () => {
    const { backend } = webgpuBackend('r32float', (bytesPerRow) => {
        const buf = new ArrayBuffer(bytesPerRow * HEIGHT)
        const view = new Float32Array(buf)
        for (let y = 0; y < HEIGHT; y++) {
            const rowStart = (y * bytesPerRow) / 4
            for (let x = 0; x < WIDTH; x++) view[rowStart + x] = DEPTH_ROWS[y][x]
        }
        return buf
    })
    const { width, height, data } = await backend.readPixels('scene_gbuf_depth')
    assert.strictEqual(width, WIDTH)
    assert.strictEqual(height, HEIGHT)
    assert.deepStrictEqual(Array.from(data), Array.from(expectedRGBA()))
})

await test('WebGPU rgba8unorm readback is byte-identical to before', async () => {
    const source = new Uint8Array(WIDTH * HEIGHT * 4)
    for (let i = 0; i < source.length; i++) source[i] = (i * 7) & 0xff
    const { backend, copies } = webgpuBackend('rgba8unorm', (bytesPerRow) => {
        const buf = new ArrayBuffer(bytesPerRow * HEIGHT)
        const view = new Uint8Array(buf)
        for (let y = 0; y < HEIGHT; y++) {
            view.set(source.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4), y * bytesPerRow)
        }
        return buf
    })
    const { data } = await backend.readPixels('scene_gbuf_depth')
    assert.strictEqual(copies[0].dst.bytesPerRow, 256)
    assert.deepStrictEqual(Array.from(data), Array.from(source))
})

// --- WebGL2 ---------------------------------------------------------------

const GL = {
    FRAMEBUFFER: 'FRAMEBUFFER',
    COLOR_ATTACHMENT0: 'COLOR_ATTACHMENT0',
    TEXTURE_2D: 'TEXTURE_2D',
    FRAMEBUFFER_COMPLETE: 'COMPLETE',
    RGBA: 'RGBA',
    RED: 'RED',
    FLOAT: 'FLOAT',
    HALF_FLOAT: 'HALF_FLOAT',
    UNSIGNED_BYTE: 'UNSIGNED_BYTE',
    R32F: 'R32F',
    RGBA8: 'RGBA8'
}

/** @param {(format: string, type: string, buf: ArrayBufferView) => void} fill */
function webgl2Backend(glFormat, fill) {
    const reads = []
    const backend = Object.create(WebGL2Backend.prototype)
    backend.gl = {
        ...GL,
        createFramebuffer() { return { id: 'fbo' } },
        bindFramebuffer() {},
        framebufferTexture2D() {},
        checkFramebufferStatus() { return GL.FRAMEBUFFER_COMPLETE },
        deleteFramebuffer() {},
        readPixels(x, y, w, h, format, type, buf) {
            reads.push({ x, y, w, h, format, type, length: buf.length })
            fill(format, type, buf)
        }
    }
    backend.textures = new Map([['scene_gbuf_depth', {
        handle: 'depth-handle', width: WIDTH, height: HEIGHT, glFormat
    }]])
    return { backend, reads }
}

const R32F_FORMAT = { internalFormat: GL.R32F, format: GL.RED, type: GL.FLOAT }
const RGBA8_FORMAT = { internalFormat: GL.RGBA8, format: GL.RGBA, type: GL.UNSIGNED_BYTE }

await test('WebGL2 reads an r32f attachment as RED/FLOAT', async () => {
    const { backend, reads } = webgl2Backend(R32F_FORMAT, () => {})
    backend.readPixels('scene_gbuf_depth')
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0].format, GL.RED,
        'RGBA is not the implementation colour read format of an R32F attachment')
    assert.strictEqual(reads[0].type, GL.FLOAT)
    assert.strictEqual(reads[0].length, WIDTH * HEIGHT,
        'the destination must be sized for one channel')
})

await test('WebGL2 decodes r32f as greyscale, bottom-up rows flipped', async () => {
    const { backend } = webgl2Backend(R32F_FORMAT, (format, type, buf) => {
        // gl.readPixels is bottom-up: row 0 of the buffer is the LAST row.
        for (let y = 0; y < HEIGHT; y++) {
            const src = DEPTH_ROWS[HEIGHT - 1 - y]
            for (let x = 0; x < WIDTH; x++) buf[y * WIDTH + x] = src[x]
        }
    })
    const { width, height, data } = backend.readPixels('scene_gbuf_depth')
    assert.strictEqual(width, WIDTH)
    assert.strictEqual(height, HEIGHT)
    assert.deepStrictEqual(Array.from(data), Array.from(expectedRGBA()))
})

await test('WebGL2 rgba8 readback is byte-identical to before', async () => {
    const source = new Uint8Array(WIDTH * HEIGHT * 4)
    for (let i = 0; i < source.length; i++) source[i] = (i * 7) & 0xff
    const { backend, reads } = webgl2Backend(RGBA8_FORMAT, (format, type, buf) => {
        for (let y = 0; y < HEIGHT; y++) {
            const srcRow = source.subarray((HEIGHT - 1 - y) * WIDTH * 4, (HEIGHT - y) * WIDTH * 4)
            buf.set(srcRow, y * WIDTH * 4)
        }
    })
    const { data } = backend.readPixels('scene_gbuf_depth')
    assert.strictEqual(reads[0].format, GL.RGBA)
    assert.strictEqual(reads[0].type, GL.UNSIGNED_BYTE)
    assert.deepStrictEqual(Array.from(data), Array.from(source))
})

console.log(`\nreadPixels single-channel: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
