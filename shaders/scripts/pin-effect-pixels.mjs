#!/usr/bin/env node
/**
 * Per-backend before/after pixel pin.
 *
 * The parity attestation (scripts/attest-shader-parity.mjs) asks "do the two
 * backends agree?". This asks a different question: "does each backend still
 * produce what it produced before?". It never compares WebGL2 against WebGPU:
 * the two readbacks arrive in opposite row order, so their raw bytes never
 * hash alike even when the rendered images are identical pixel for pixel.
 * Aligning the two rasters is the attestation's job — see comparePixelFrames
 * in scripts/lib/shader-parity-attestation.mjs, and the epsilon-0
 * parity-attestation.json committed beside each volumetric marcher. Here each
 * backend is only ever compared against its own prior self, which is what
 * makes this the right gate for a refactor that must not move a single pixel.
 *
 *   node shaders/scripts/pin-effect-pixels.mjs --case <case.json> --out <pin.json>
 *   node shaders/scripts/pin-effect-pixels.mjs --case <case.json> --check <pin.json>
 *
 * The case file reuses the parity-case.json shape (effects / dsl / surface /
 * resolution) so one file can serve both tools.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

function flagValue(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? null : process.argv[index + 1]
}

const casePath = flagValue('--case')
const outPath = flagValue('--out')
const checkPath = flagValue('--check')

if (!casePath || (!outPath && !checkPath)) {
    console.error('Usage: node shaders/scripts/pin-effect-pixels.mjs --case <case.json> (--out <pin.json> | --check <pin.json>)')
    process.exit(2)
}

const pinCase = JSON.parse(fs.readFileSync(casePath, 'utf8'))
for (const field of ['effects', 'dsl', 'surface', 'resolution']) {
    if (pinCase[field] == null) throw new Error(`pin case is missing "${field}"`)
}
const [width, height] = pinCase.resolution

async function renderBackend(browser, baseUrl, preferWebGPU) {
    const page = await browser.newPage({ viewport: { width, height } })
    const consoleMessages = []
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push(message.text())
    })
    page.on('pageerror', (error) => consoleMessages.push(error.message))

    try {
        if (preferWebGPU) {
            await page.goto(`${baseUrl}/shaders/manifest.json`, { waitUntil: 'load' })
            consoleMessages.length = 0
        }
        await page.setContent(`<!doctype html>
<link rel="icon" href="data:,">
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
const renderer = new CanvasRenderer({
    canvas: document.getElementById('canvas'),
    width: ${width},
    height: ${height},
    basePath: '${baseUrl}/shaders',
    preferWebGPU: ${preferWebGPU}
});
await renderer.loadManifest();
await renderer.loadEffects(${JSON.stringify(pinCase.effects)});
await renderer.compile(${JSON.stringify(pinCase.dsl)});
renderer.stop();
renderer.render(0);
renderer.render(0);
await renderer.pipeline.backend.device?.queue?.onSubmittedWorkDone?.();
const surface = renderer.pipeline.surfaces.get(${JSON.stringify(pinCase.surface)});
const candidates = [surface?.read, surface?.write].filter(Boolean);
let capture = null;
for (const id of candidates) {
    try {
        const pixels = await renderer.pipeline.backend.readPixels(id);
        if (!pixels?.data) continue;
        let nonzeroRgbPixels = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.data.length; i += 4) {
            if (pixels.data[i] || pixels.data[i + 1] || pixels.data[i + 2]) nonzeroRgbPixels++;
            colors.add(pixels.data[i] + ',' + pixels.data[i + 1] + ',' + pixels.data[i + 2]);
        }
        if (!capture || nonzeroRgbPixels > capture.nonzeroRgbPixels) {
            capture = {
                id,
                width: pixels.width,
                height: pixels.height,
                nonzeroRgbPixels,
                uniqueColors: colors.size,
                data: Array.from(pixels.data)
            };
        }
    } catch {}
}
window.pinResult = { backend: renderer.pipeline.backend.getName(), capture };
</script>`, { waitUntil: 'load' })
        await page.waitForFunction(() => window.pinResult, null, { timeout: 60000 })
        const result = await page.evaluate(() => window.pinResult)
        const expectedBackend = preferWebGPU ? 'WebGPU' : 'WebGL2'
        assert.equal(result.backend, expectedBackend, `expected ${expectedBackend}, got ${result.backend}`)
        assert.ok(result.capture, `${expectedBackend} produced no readable output`)
        assert.ok(result.capture.nonzeroRgbPixels > 0, `${expectedBackend} frame is empty`)
        if (consoleMessages.length > 0) {
            console.error(`${expectedBackend} console output:\n  ${consoleMessages.join('\n  ')}`)
        }
        return result.capture
    } finally {
        await page.close()
    }
}

function pinFrame(capture) {
    return {
        surface: capture.id,
        width: capture.width,
        height: capture.height,
        nonzeroRgbPixels: capture.nonzeroRgbPixels,
        uniqueColors: capture.uniqueColors,
        sha256: crypto.createHash('sha256').update(Buffer.from(capture.data)).digest('hex'),
    }
}

const effectsDir = path.join(repoRoot, 'shaders/effects')
process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot
const { acquireServer, releaseServer } = await import('../../vendor/shade-mcp/harness/index.js')
const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
let browser

try {
    browser = await chromium.launch({
        headless: true,
        args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan',
        ],
    })
    const pin = {
        case: path.relative(repoRoot, path.resolve(casePath)).split(path.sep).join('/'),
        resolution: [width, height],
        webgl2: pinFrame(await renderBackend(browser, baseUrl, false)),
        webgpu: pinFrame(await renderBackend(browser, baseUrl, true)),
    }

    if (outPath) {
        fs.writeFileSync(outPath, `${JSON.stringify(pin, null, 2)}\n`)
        console.log(`Wrote ${outPath}`)
        console.log(`  webgl2 ${pin.webgl2.sha256}  (${pin.webgl2.nonzeroRgbPixels} lit px, ${pin.webgl2.uniqueColors} colors)`)
        console.log(`  webgpu ${pin.webgpu.sha256}  (${pin.webgpu.nonzeroRgbPixels} lit px, ${pin.webgpu.uniqueColors} colors)`)
    } else {
        const expected = JSON.parse(fs.readFileSync(checkPath, 'utf8'))
        const failures = []
        for (const backend of ['webgl2', 'webgpu']) {
            const before = expected[backend]
            const after = pin[backend]
            const status = before?.sha256 === after.sha256 ? 'IDENTICAL' : 'CHANGED'
            console.log(`  ${backend.padEnd(6)} ${status}  before=${before?.sha256} after=${after.sha256}`)
            if (status === 'CHANGED') {
                failures.push(`${backend}: ${before?.sha256} -> ${after.sha256}`)
            }
        }
        if (failures.length > 0) {
            throw new Error(`PIXEL PIN FAILED:\n  ${failures.join('\n  ')}`)
        }
        console.log('Pixel pin holds on both backends.')
    }
} finally {
    if (browser) await browser.close()
    releaseServer()
}
