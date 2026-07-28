#!/usr/bin/env node
// updateTextureFromSource() must return the source dimensions SYNCHRONOUSLY on
// every backend.
//
// Regression: WebGL2Backend.updateTextureFromSource was sync and returned
// {width, height}; WebGPUBackend.updateTextureFromSource was declared `async`
// and so returned a Promise. CanvasRenderer.updateTextureFromSource forwards
// the backend value verbatim and documents a `{width, height}` return, so on
// WebGPU every consumer that read `result.width` synchronously got undefined.
//
// The visible failure: consumers use that return value to publish the media's
// intrinsic size into the effect's `imageSize` uniform. Dropped on WebGPU,
// `imageSize` stayed at the effect default (1024x1024) and synth/media sampled
// gl_FragCoord/imageSize across the whole frame — the image stretched to 100%
// of the render instead of keeping its own aspect. Noisemaker's demo UI worked
// around it by sniffing for `.then`; the contract is fixed here instead.
//
// Case 1 pins the API contract on both backends. Case 2 renders synth/media
// from a non-square source through the same path a host app uses and asserts
// the image keeps its aspect ratio (letterboxed) rather than filling the frame.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const effectsDir = path.join(repoRoot, 'shaders', 'effects')

process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot

const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))

// Square render, 2:1 source. A correct render letterboxes: the image covers the
// full width and half the height. The regression covers the whole frame.
const RENDER_SIZE = 128
const SOURCE_WIDTH = 128
const SOURCE_HEIGHT = 64

const MEDIA_DSL = `search synth

media(bgColor: #000000, bgAlpha: 1)
  .write(o0)

render(o0)`

/** Fraction of rows that contain at least one bright (non-background) pixel. */
function litRowFraction(png) {
    let lit = 0
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const i = (y * png.width + x) * 4
            if (png.data[i] > 100 || png.data[i + 1] > 100 || png.data[i + 2] > 100) {
                lit++
                break
            }
        }
    }
    return lit / png.height
}

/** Fraction of columns that contain at least one bright pixel. */
function litColumnFraction(png) {
    let lit = 0
    for (let x = 0; x < png.width; x++) {
        for (let y = 0; y < png.height; y++) {
            const i = (y * png.width + x) * 4
            if (png.data[i] > 100 || png.data[i + 1] > 100 || png.data[i + 2] > 100) {
                lit++
                break
            }
        }
    }
    return lit / png.width
}

async function installHarness(page, baseUrl, preferWebGPU) {
    await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
html, body { margin: 0; width: ${RENDER_SIZE}px; height: ${RENDER_SIZE}px; overflow: hidden; background: black; }
canvas#canvas { display: block; width: ${RENDER_SIZE}px; height: ${RENDER_SIZE}px; }
</style>
<canvas id="canvas" width="${RENDER_SIZE}" height="${RENDER_SIZE}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';

const canvas = document.getElementById('canvas');
const renderer = new CanvasRenderer({
    canvas,
    width: ${RENDER_SIZE},
    height: ${RENDER_SIZE},
    basePath: '${baseUrl}/shaders',
    preferWebGPU: ${preferWebGPU ? 'true' : 'false'}
});
await renderer.loadManifest();
await renderer.loadEffects(['synth/media']);

// A solid white 2:1 source canvas stands in for a camera/video/image element.
const source = document.createElement('canvas');
source.width = ${SOURCE_WIDTH};
source.height = ${SOURCE_HEIGHT};
const sctx = source.getContext('2d');
sctx.fillStyle = '#ffffff';
sctx.fillRect(0, 0, source.width, source.height);

window.backendName = () => renderer.pipeline?.backend?.getName?.() || 'unknown';

window.compileDsl = async (dsl) => {
    await renderer.compile(dsl);
    renderer.stop();
    renderer.render(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return window.backendName();
};

// Mirror what a host app does: upload the source, then publish the dimensions
// the call returned into the effect's imageSize uniform. Reads .width/.height
// straight off the return value — that is the contract under test.
window.uploadMedia = () => {
    const pass = renderer.pipeline?.graph?.passes?.find((p) => p.effectFunc === 'media');
    if (!pass) return { error: 'no media pass' };
    const texId = 'imageTex_step_' + pass.stepIndex;
    const result = renderer.updateTextureFromSource(texId, source, { flipY: false });
    const isThenable = !!result && typeof result.then === 'function';
    if (result && result.width > 0 && result.height > 0) {
        renderer.applyStepParameterValues({
            ['step_' + pass.stepIndex]: { imageSize: [result.width, result.height] }
        });
    }
    return { isThenable, width: result?.width, height: result?.height };
};

window.renderFrame = async () => {
    renderer.render(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.compileDsl === 'function', null, { timeout: 30000 })
}

async function screenshotPng(page) {
    const handle = await page.$('#canvas')
    if (!handle) throw new Error('test canvas not found')
    return PNG.sync.read(await handle.screenshot({ type: 'png' }))
}

async function runBackend(browser, baseUrl, { preferWebGPU, expectedName }) {
    const consoleMessages = []
    const page = await browser.newPage({ viewport: { width: RENDER_SIZE, height: RENDER_SIZE } })
    page.setDefaultTimeout(30000)
    page.on('console', (message) => {
        if (['error', 'warning'].includes(message.type())) {
            const text = message.text()
            if (message.type() === 'warning' && text.includes('GL Driver Message (OpenGL, Performance')) return
            consoleMessages.push(`[${message.type()}] ${text}`)
        }
    })
    page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${error.message}`))

    try {
        await installHarness(page, baseUrl, preferWebGPU)
        const backend = await page.evaluate((dsl) => window.compileDsl(dsl), MEDIA_DSL)
        if (backend !== expectedName) {
            console.log(`SKIP ${expectedName}: backend resolved to ${backend}`)
            return null
        }

        // --- Case 1: the API contract.
        const upload = await page.evaluate(() => window.uploadMedia())
        assert.equal(upload.error, undefined, `media pass missing on ${backend}`)
        assert.equal(upload.isThenable, false,
            `${backend}: updateTextureFromSource must return {width, height}, not a Promise`)
        assert.equal(upload.width, SOURCE_WIDTH, `${backend}: returned width`)
        assert.equal(upload.height, SOURCE_HEIGHT, `${backend}: returned height`)

        // --- Case 2: the visible consequence.
        await page.evaluate(() => window.renderFrame())
        const png = await screenshotPng(page)
        const rows = litRowFraction(png)
        const cols = litColumnFraction(png)
        console.log(`${backend}: lit rows=${(rows * 100).toFixed(1)}% cols=${(cols * 100).toFixed(1)}%`)

        // 2:1 source in a square frame => full width, ~half height.
        assert.ok(cols > 0.9, `${backend}: 2:1 source should span the full width (got ${cols})`)
        assert.ok(rows > 0.35 && rows < 0.65,
            `${backend}: 2:1 source should cover ~half the height, not stretch to fill (got ${rows})`)

        assert.deepEqual(consoleMessages, [], `${backend} console output:\n${consoleMessages.join('\n')}`)
        return backend
    } finally {
        await page.close()
    }
}

// Static guard: catches the regression even where no WebGPU adapter exists.
// An `async` method reports its constructor as AsyncFunction, which is exactly
// how the contract was broken.
async function assertSyncSignatures() {
    const [{ WebGL2Backend }, { WebGPUBackend }] = await Promise.all([
        import('../src/runtime/backends/webgl2.js'),
        import('../src/runtime/backends/webgpu.js'),
    ])
    for (const [name, Backend] of [['WebGL2Backend', WebGL2Backend], ['WebGPUBackend', WebGPUBackend]]) {
        const fn = Backend?.prototype?.updateTextureFromSource
        assert.equal(typeof fn, 'function', `${name}.updateTextureFromSource missing`)
        assert.equal(fn.constructor.name, 'Function',
            `${name}.updateTextureFromSource must be synchronous, got ${fn.constructor.name}`)
    }
    console.log('signature check: both backends expose a synchronous updateTextureFromSource')
}

async function main() {
    await assertSyncSignatures()

    const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-gpu-sandbox',
            '--enable-unsafe-webgpu',
            '--enable-webgpu-developer-features',
            process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=egl',
        ],
    })

    try {
        const ran = []
        const gl = await runBackend(browser, baseUrl, { preferWebGPU: false, expectedName: 'WebGL2' })
        if (gl) ran.push(gl)
        const gpu = await runBackend(browser, baseUrl, { preferWebGPU: true, expectedName: 'WebGPU' })
        if (gpu) ran.push(gpu)

        assert.ok(ran.includes('WebGL2'), 'WebGL2 backend did not run')
        if (!ran.includes('WebGPU')) {
            console.log('NOTE: WebGPU unavailable in this environment; only WebGL2 was asserted')
        }
        console.log(`PASS test_external_texture_upload (${ran.join(', ')})`)
    } finally {
        await browser.close()
        await releaseServer()
    }
}

await main()
