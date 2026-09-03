#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

// An interrupted run must not leave the browser process tree behind:
// Playwright's own SIGTERM handler closes its browsers but never exits, and
// its SIGINT handler races this test's teardown. These close what this test
// owns and then exit. The 'exit' listener is the last-resort fallback for the
// process.exit() paths below, where only synchronous work still runs.
let activeBrowser = null
let shuttingDown = false

async function shutdownAndExit(code) {
    if (shuttingDown) return
    shuttingDown = true
    const browser = activeBrowser
    activeBrowser = null
    try {
        await browser?.close()
    } catch {
        // Already closed.
    }
    try {
        releaseServer()
    } catch {
        // Server already released.
    }
    process.exit(code)
}

process.on('SIGINT', () => { shutdownAndExit(130) })
process.on('SIGTERM', () => { shutdownAndExit(143) })
process.on('exit', () => {
    try { activeBrowser?.close() } catch { /* already closed */ }
    try { releaseServer() } catch { /* already released */ }
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const effectsDir = path.join(repoRoot, 'shaders', 'effects')

process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot

const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const { default: halftoneDefinition } = await import(path.join(effectsDir, 'filter', 'halftone', 'definition.js'))

const width = 128
const height = 128
const LUMA = [0.2126, 0.7152, 0.0722]
const inkLuma = luma([0.1 * 255, 0.1 * 255, 0.1 * 255])
const paperLuma = luma([0.96 * 255, 0.94 * 255, 0.88 * 255])

const defaultEdgeDsl = `search synth, filter

testPattern(pattern: gradient)
  .edge()
  .write(o0)

render(o0)`

const explicitOriginalEdgeDsl = `search synth, filter

testPattern(pattern: gradient)
  .edge(kernel: bold, level: 50, size: kernel5x5, channel: color, amount: 100, invert: off, threshold: 0, blend: normal, mix: 100)
  .write(o0)

render(o0)`

const conteDsl = `search synth, filter

testPattern(pattern: gradient)
  .hatch(mode: conte)
  .write(o0)

render(o0)`

function colorHalftoneDsl(color) {
    return `search synth, filter

solid(color: ${color})
  .halftone(mode: color)
  .write(o0)

render(o0)`
}

function contourDsl(contourSide) {
    return `search synth, filter

testPattern(pattern: gradient)
  .edge(kernel: contour, contourSide: ${contourSide}, level: 50, channel: luminance, blend: normal, mix: 100)
  .write(o0)

render(o0)`
}

function luma(rgb) {
    return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2]
}

function bandMeanLuma(png, x0, x1, y0 = 8, y1 = height - 8) {
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * png.width + x) * 4
            sum += luma([png.data[i], png.data[i + 1], png.data[i + 2]])
            count++
        }
    }
    return sum / count
}

function columnMeanLumas(png, y0 = 8, y1 = height - 8) {
    const means = []
    for (let x = 0; x < png.width; x++) {
        means.push(bandMeanLuma(png, x, x + 1, y0, y1))
    }
    return means
}

function contourStats(png) {
    const means = columnMeanLumas(png)
    const sortedInterior = means.slice(2, -2).toSorted((a, b) => a - b)
    const background = sortedInterior[Math.floor(sortedInterior.length * 0.75)]
    const columns = []
    for (let x = 2; x < png.width - 2; x++) {
        if (means[x] < background - 64) columns.push(x)
    }
    const centroid = columns.reduce((sum, x) => sum + x, 0) / columns.length
    return { background, columns, centroid, means }
}

function pixelHash(png) {
    return crypto.createHash('sha256').update(png.data).digest('hex')
}

function interiorPixels(png, predicate = () => true, margin = 8) {
    const pixels = []
    for (let y = margin; y < png.height - margin; y++) {
        for (let x = margin; x < png.width - margin; x++) {
            const i = (y * png.width + x) * 4
            const rgb = [png.data[i], png.data[i + 1], png.data[i + 2]]
            if (predicate(rgb)) pixels.push(rgb)
        }
    }
    return pixels
}

function percentile(values, quantile) {
    assert.ok(values.length > 0, 'percentile requires at least one sample')
    const sorted = values.toSorted((a, b) => a - b)
    return sorted[Math.ceil((sorted.length - 1) * quantile)]
}

function assertAngleMetadata() {
    const expected = {
        cyanAngle: { default: 108, mode: 0 },
        magentaAngle: { default: 162, mode: 0 },
        yellowAngle: { default: 90, mode: 0 },
        blackAngle: { default: 45, mode: 0 },
    }
    const monoAngle = halftoneDefinition.globals.monoAngle
    assert.equal(monoAngle.default, 45)
    assert.equal(monoAngle.min, -180)
    assert.equal(monoAngle.max, 180)
    assert.deepEqual(monoAngle.ui?.enabledBy, {
        and: [
            { param: 'mode', eq: 1 },
            { param: 'pattern', in: [0, 1] },
        ],
    }, 'monoAngle must be inactive when the circle pattern ignores angle')
    for (const [name, { default: defaultValue, mode }] of Object.entries(expected)) {
        const spec = halftoneDefinition.globals[name]
        assert.ok(spec, `Halftone must expose ${name}`)
        assert.equal(spec.default, defaultValue, `${name} must default to ${defaultValue}`)
        assert.equal(spec.min, -180, `${name} must have min -180`)
        assert.equal(spec.max, 180, `${name} must have max 180`)
        assert.deepEqual(spec.ui?.enabledBy, { param: 'mode', eq: mode },
            `${name} must be enabled only in ${mode === 0 ? 'color' : 'mono'} mode`)
    }
    assert.equal(Object.hasOwn(halftoneDefinition.globals, 'angle'), false,
        'Halftone must not retain the obsolete base angle parameter')
}

async function installHarness(page, baseUrl) {
    await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: black; }
canvas { display: block; width: ${width}px; height: ${height}px; }
</style>
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';

const canvas = document.getElementById('canvas');
const renderer = new CanvasRenderer({
    canvas,
    width: ${width},
    height: ${height},
    basePath: '${baseUrl}/shaders',
    preferWebGPU: false
});
await renderer.loadManifest();
await renderer.loadEffects(['synth/testPattern', 'synth/solid', 'filter/hatch', 'filter/edge', 'filter/halftone']);

window.renderTestDsl = async (dsl) => {
    await renderer.compile(dsl);
    renderer.render(0);
    renderer.render(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return renderer.pipeline?.backend?.getName?.() || 'unknown';
};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderTestDsl === 'function', null, { timeout: 30000 })
}

async function renderPng(page, dsl) {
    const backend = await page.evaluate(async (source) => window.renderTestDsl(source), dsl)
    assert.equal(backend, 'WebGL2', `expected WebGL2 backend, got ${backend}`)
    const canvas = await page.$('canvas')
    assert.ok(canvas, 'test canvas not found')
    return PNG.sync.read(await canvas.screenshot({ type: 'png' }))
}

async function main() {
    const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-gpu-sandbox',
            process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=egl',
        ],
    })
    activeBrowser = browser
    const page = await browser.newPage({ viewport: { width, height } })
    page.setDefaultTimeout(30000)
    const consoleMessages = []
    page.on('console', (message) => {
        if (!['error', 'warning'].includes(message.type())) return
        const text = message.text()
        if (message.type() === 'warning' && text.includes('GL Driver Message (OpenGL, Performance')) return
        consoleMessages.push(`[${message.type()}] ${text}`)
    })
    page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${error.message}`))

    try {
        await installHarness(page, baseUrl)

        const defaultEdge = await renderPng(page, defaultEdgeDsl)
        const explicitOriginalEdge = await renderPng(page, explicitOriginalEdgeDsl)
        assert.deepEqual(defaultEdge.data, explicitOriginalEdge.data,
            'default Edge pixels must equal the explicit original bold defaults')
        console.log(`original edge pixel hash: ${pixelHash(defaultEdge)}`)

        const conte = await renderPng(page, conteDsl)
        const leftLuma = bandMeanLuma(conte, 8, 32)
        const rightLuma = bandMeanLuma(conte, 96, 120)
        assert.ok(Math.abs(leftLuma - inkLuma) < Math.abs(leftLuma - paperLuma),
            `Conté shadow band must be closer to ink than paper (left=${leftLuma.toFixed(2)}, ink=${inkLuma.toFixed(2)}, paper=${paperLuma.toFixed(2)})`)
        assert.ok(Math.abs(rightLuma - paperLuma) < Math.abs(rightLuma - inkLuma),
            `Conté highlight band must be closer to paper than ink (right=${rightLuma.toFixed(2)}, ink=${inkLuma.toFixed(2)}, paper=${paperLuma.toFixed(2)})`)
        console.log(`Conté band luma: left=${leftLuma.toFixed(2)}, right=${rightLuma.toFixed(2)}`)

        const lower = contourStats(await renderPng(page, contourDsl('lower')))
        const upper = contourStats(await renderPng(page, contourDsl('upper')))
        assert.deepEqual(lower.columns.length, 1,
            `lower contour must occupy exactly one column, got [${lower.columns.join(', ')}]`)
        assert.deepEqual(upper.columns.length, 1,
            `upper contour must occupy exactly one column, got [${upper.columns.join(', ')}]`)
        assert.equal(upper.centroid - lower.centroid, 1,
            `lower and upper contours must occupy adjacent ordered sides (lower=${lower.centroid}, upper=${upper.centroid})`)
        console.log(`contour columns: lower=${lower.centroid}, upper=${upper.centroid}`)

        const neutral = await renderPng(page, colorHalftoneDsl('#808080'))
        const neutralInk = interiorPixels(neutral,
            ([r, g, b]) => Math.min(r, g, b) < 250)
        assert.ok(neutralInk.length > 1000,
            `neutral halftone must contain enough non-paper samples, got ${neutralInk.length}`)
        const neutralChroma99 = percentile(neutralInk.map((rgb) => Math.max(...rgb) - Math.min(...rgb)), 0.99)
        assert.ok(neutralChroma99 <= 2,
            `neutral halftone chroma p99 must be <= 2 LSB, got ${neutralChroma99} across ${neutralInk.length} samples`)
        console.log(`neutral halftone: samples=${neutralInk.length}, chromaP99=${neutralChroma99}`)

        const black = await renderPng(page, colorHalftoneDsl('#000000'))
        const gray = await renderPng(page, colorHalftoneDsl('#808080'))
        const white = await renderPng(page, colorHalftoneDsl('#ffffff'))
        const blackLuma = bandMeanLuma(black, 8, width - 8)
        const grayLuma = bandMeanLuma(gray, 8, width - 8)
        const whiteLuma = bandMeanLuma(white, 8, width - 8)
        assert.ok(blackLuma < grayLuma && grayLuma < whiteLuma,
            `color halftone luma must be monotonic black < gray < white, got ${blackLuma.toFixed(2)}, ${grayLuma.toFixed(2)}, ${whiteLuma.toFixed(2)}`)
        console.log(`halftone solid luma: black=${blackLuma.toFixed(2)}, gray=${grayLuma.toFixed(2)}, white=${whiteLuma.toFixed(2)}`)

        // HSL-saturated cyan tint: 50% C leaves both ink and paper to measure.
        const cyan = await renderPng(page, colorHalftoneDsl('#80ffff'))
        const cyanInk = interiorPixels(cyan, ([r, g, b]) => r < 245 && Math.max(g, b) > 245)
        const cyanPaper = interiorPixels(cyan, ([r]) => r >= 253)
        assert.ok(cyanInk.length > 1000,
            `cyan halftone must contain enough ink samples, got ${cyanInk.length}`)
        assert.ok(cyanPaper.length > 100,
            `cyan halftone must contain enough near-white paper samples, got ${cyanPaper.length}`)
        const cyanInkMeans = [0, 1, 2].map((channel) =>
            cyanInk.reduce((sum, rgb) => sum + rgb[channel], 0) / cyanInk.length)
        assert.ok(255 - cyanInkMeans[0] > 3 * Math.max(255 - cyanInkMeans[1], 255 - cyanInkMeans[2]),
            `cyan ink must suppress red more strongly than green/blue, got means ${cyanInkMeans.map((v) => v.toFixed(2)).join(', ')}`)
        const cyanPaperChroma99 = percentile(cyanPaper.map((rgb) => Math.max(...rgb) - Math.min(...rgb)), 0.99)
        assert.ok(cyanPaperChroma99 <= 2,
            `cyan paper chroma p99 must be <= 2 LSB, got ${cyanPaperChroma99}`)
        console.log(`cyan halftone: inkSamples=${cyanInk.length}, inkMeans=${cyanInkMeans.map((v) => v.toFixed(2)).join('/')}, paperSamples=${cyanPaper.length}, paperChromaP99=${cyanPaperChroma99}`)

        assertAngleMetadata()
        console.log('halftone angle metadata: exact CMYK and mono controls verified')

        assert.deepEqual(consoleMessages, [],
            `browser console reported errors or warnings:\n${consoleMessages.join('\n')}`)
    } finally {
        await browser.close()
        releaseServer()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
