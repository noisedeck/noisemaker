#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const effectsDir = path.join(repoRoot, 'shaders', 'effects')
const embossDir = path.join(effectsDir, 'filter', 'emboss')

process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot

const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const { default: embossDefinition } = await import(path.join(embossDir, 'definition.js'))

const width = 128
const height = 128
const colorDefaultHash = '2b072a298207ac5ce8f63d671b28a09d9560d3df0f451c668444cb7cb4af7c2e'
const colorWebgpuDefaultHash = '2b072a298207ac5ce8f63d671b28a09d9560d3df0f451c668444cb7cb4af7c2e'

const dsl = (source, args = '') => `search synth, filter

${source}
  .emboss(${args})
  .write(o0)

render(o0)`

const colorDefaultDsl = dsl('testPattern(pattern: colorGrid, gridSize: 4)')
const colorExplicitDsl = dsl('testPattern(pattern: colorGrid, gridSize: 4)',
    'style: color, amount: 1, angle: 135, height: 1')

function pixelHash(png) {
    return crypto.createHash('sha256').update(png.data).digest('hex')
}

function imageDifference(a, b) {
    assert.equal(a.width, b.width)
    assert.equal(a.height, b.height)
    let sum = 0
    let max = 0
    let changed = 0
    for (let i = 0; i < a.data.length; i++) {
        const delta = Math.abs(a.data[i] - b.data[i])
        sum += delta
        max = Math.max(max, delta)
        if (delta > 0) changed++
    }
    return { mean: sum / a.data.length, max, changed }
}

function imageInteriorDifference(a, b, margin) {
    assert.equal(a.width, b.width)
    assert.equal(a.height, b.height)
    let sum = 0
    let max = 0
    let changed = 0
    let count = 0
    for (let y = margin; y < a.height - margin; y++) {
        for (let x = margin; x < a.width - margin; x++) {
            for (let channel = 0; channel < 4; channel++) {
                const i = (y * a.width + x) * 4 + channel
                const delta = Math.abs(a.data[i] - b.data[i])
                sum += delta
                max = Math.max(max, delta)
                if (delta > 0) changed++
                count++
            }
        }
    }
    return { mean: sum / count, max, changed }
}

function cropFromBottomLeft(png, [offsetX, offsetY], cropWidth, cropHeight) {
    const cropped = new PNG({ width: cropWidth, height: cropHeight })
    const topY = png.height - offsetY - cropHeight
    PNG.bitblt(png, cropped, offsetX, topY, cropWidth, cropHeight, 0, 0)
    return cropped
}

function cropFromTopLeft(png, [offsetX, offsetY], cropWidth, cropHeight) {
    const cropped = new PNG({ width: cropWidth, height: cropHeight })
    PNG.bitblt(png, cropped, offsetX, offsetY, cropWidth, cropHeight, 0, 0)
    return cropped
}

function interiorRgb(png, margin = 8) {
    const pixels = []
    for (let y = margin; y < png.height - margin; y++) {
        for (let x = margin; x < png.width - margin; x++) {
            const i = (y * png.width + x) * 4
            pixels.push([png.data[i], png.data[i + 1], png.data[i + 2]])
        }
    }
    return pixels
}

function percentile(values, quantile) {
    assert.ok(values.length > 0)
    const sorted = values.toSorted((a, b) => a - b)
    return sorted[Math.ceil((sorted.length - 1) * quantile)]
}

function chroma(rgb) {
    return Math.max(...rgb) - Math.min(...rgb)
}

function reliefDeviation(rgb) {
    return Math.abs((rgb[0] + rgb[1] + rgb[2]) / 3 - 128)
}

function flatColorBarPixels(png, boundaryMargin) {
    return interiorRgb(png).filter((_, index) => {
        const interiorWidth = png.width - 16
        const x = index % interiorWidth + 8
        const nearestBoundary = Math.min(...[16, 32, 48, 64, 80, 96, 112].map((b) => Math.abs(x - b)))
        return nearestBoundary > boundaryMargin
    })
}

function edgeColorBarPixels(png, boundaryMargin) {
    return interiorRgb(png).filter((_, index) => {
        const interiorWidth = png.width - 16
        const x = index % interiorWidth + 8
        const nearestBoundary = Math.min(...[16, 32, 48, 64, 80, 96, 112].map((b) => Math.abs(x - b)))
        return nearestBoundary <= boundaryMargin
    })
}

function nonNeutralCount(png, threshold = 3) {
    return interiorRgb(png).filter((rgb) => reliefDeviation(rgb) > threshold).length
}

function assertMetadataAndSourceInvariants() {
    const globals = embossDefinition.globals
    assert.deepEqual(globals.style?.choices, { color: 0, gray: 1 },
        'style must offer only color and gray')
    assert.equal(globals.style?.default, 0, 'color must remain the shipped default')
    assert.deepEqual(globals.amount.ui.enabledBy, { param: 'style', eq: 0 },
        'amount must be color-style only')
    assert.deepEqual(globals.colorAmount?.ui?.enabledBy, { param: 'style', eq: 1 },
        'colorAmount must be gray-style only')
    assert.equal(globals.colorAmount?.default, 100)
    assert.equal(globals.colorAmount?.min, 0)
    assert.equal(globals.colorAmount?.max, 100)
    assert.equal(globals.angle.ui.enabledBy, undefined, 'angle must be available in both styles')
    assert.equal(globals.height.ui.enabledBy, undefined, 'height must be available in both styles')

    for (const language of ['glsl', 'wgsl']) {
        const source = fs.readFileSync(path.join(embossDir, language, `emboss.${language}`), 'utf8')
        const exact = source.match(/COLOR_DEFAULT_EXACT_BEGIN([\s\S]*?)COLOR_DEFAULT_EXACT_END/)?.[1]
        assert.ok(exact, `${language} must mark the exact color-default implementation`)
        assert.doesNotMatch(exact, /\b(?:sin|cos|radians)\s*\(/,
            `${language} exact color-default implementation must not derive offsets through trig`)
        assert.match(exact, /-texelSize\.x|vec2<f32>\(-1\.0, -1\.0\) \* texelSize/,
            `${language} exact path must contain literal color-style grid offsets`)
        assert.match(source, /angle\s*==\s*135\.0[\s\S]{0,80}height\s*==\s*1\.0/,
            `${language} must dispatch exact defaults before generalized rotation`)
    }
}

async function installHarness(page, baseUrl, preferWebGPU = false,
    canvasWidth = width, canvasHeight = height) {
    await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
html, body { margin: 0; width: ${canvasWidth}px; height: ${canvasHeight}px; overflow: hidden; background: black; }
canvas { display: block; width: ${canvasWidth}px; height: ${canvasHeight}px; }
</style>
<canvas id="canvas" width="${canvasWidth}" height="${canvasHeight}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';

const renderer = new CanvasRenderer({
    canvas: document.getElementById('canvas'),
    width: ${canvasWidth},
    height: ${canvasHeight},
    basePath: '${baseUrl}/shaders',
    preferWebGPU: ${preferWebGPU}
});
await renderer.loadManifest();
await renderer.loadEffects(['synth/solid', 'synth/testPattern', 'filter/emboss']);
window.renderTestDsl = async (source, tileRegion) => {
    await renderer.compile(source);
    if (tileRegion) renderer.setTileRegion(tileRegion);
    renderer.render(0);
    renderer.render(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return renderer.pipeline?.backend?.getName?.() || 'unknown';
};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderTestDsl === 'function', null, { timeout: 30000 })
}

async function renderPng(page, source, expectedBackend = 'WebGL2', tileRegion = null) {
    const backend = await page.evaluate(
        async ({ program, tile }) => window.renderTestDsl(program, tile),
        { program: source, tile: tileRegion })
    assert.equal(backend, expectedBackend)
    const canvas = await page.$('canvas')
    return PNG.sync.read(await canvas.screenshot({ type: 'png' }))
}

async function assertTileParity(browser, baseUrl, fullPage, preferWebGPU,
    expectedBackend, consoleMessages) {
    const tileWidth = 48
    const tileHeight = 40
    const positiveOffset = [32, 24]
    const negativeOffset = [-16, 24]
    const positiveRegion = { offset: positiveOffset, fullResolution: [width, height] }
    const negativeRegion = { offset: negativeOffset, fullResolution: [width, height] }
    const cases = [
        {
            label: 'color default',
            program: dsl('testPattern(pattern: uvMap)'),
            margin: 2,
        },
        {
            label: 'Gray',
            program: dsl('testPattern(pattern: colorGrid, gridSize: 4)',
                'style: gray, angle: 37, height: 4, colorAmount: 100'),
            margin: 5,
        },
    ]
    const failures = []

    const tilePage = await browser.newPage({ viewport: { width: tileWidth, height: tileHeight } })
    // Bootstrap WebGPU's trustworthy origin before attaching diagnostics so a
    // navigation-only favicon request cannot hide or pollute shader messages.
    if (preferWebGPU) await tilePage.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    tilePage.on('console', (message) => {
        if (!['error', 'warning'].includes(message.type())) return
        const text = message.text()
        if (message.type() === 'warning' && text.includes('GL Driver Message (OpenGL, Performance')) return
        consoleMessages.push(`[${expectedBackend} tile ${message.type()}] ${text}`)
    })
    tilePage.on('pageerror', (error) => consoleMessages.push(`[${expectedBackend} tile pageerror] ${error.message}`))
    await installHarness(tilePage, baseUrl, preferWebGPU, tileWidth, tileHeight)

    for (const testCase of cases) {
        const full = await renderPng(fullPage, testCase.program, expectedBackend)
        const positive = await renderPng(tilePage, testCase.program, expectedBackend, positiveRegion)
        const positiveExpected = cropFromBottomLeft(full, positiveOffset, tileWidth, tileHeight)
        const positiveDifference = imageInteriorDifference(positive, positiveExpected, testCase.margin)
        if (positiveDifference.max !== 0) {
            failures.push(`${expectedBackend} ${testCase.label} positive tile interior differs from full crop: max=${positiveDifference.max}, mean=${positiveDifference.mean.toFixed(4)}`)
        }

        const negative = await renderPng(tilePage, testCase.program, expectedBackend, negativeRegion)
        const retainedWidth = tileWidth + negativeOffset[0]
        const negativeRetained = cropFromTopLeft(negative, [-negativeOffset[0], 0], retainedWidth, tileHeight)
        const negativeExpected = cropFromBottomLeft(full, [0, negativeOffset[1]], retainedWidth, tileHeight)
        const negativeDifference = imageInteriorDifference(negativeRetained, negativeExpected, testCase.margin)
        if (negativeDifference.max !== 0) {
            failures.push(`${expectedBackend} ${testCase.label} negative-overlap retained interior differs from full crop: max=${negativeDifference.max}, mean=${negativeDifference.mean.toFixed(4)}`)
        }
        console.log(`${expectedBackend} ${testCase.label} tile parity: positiveMax=${positiveDifference.max}, negativeMax=${negativeDifference.max}`)
    }
    await tilePage.close()
    return failures
}

async function main() {
    const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-gpu-sandbox',
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--enable-webgpu-developer-features',
            process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan',
        ],
    })
    const page = await browser.newPage({ viewport: { width, height } })
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

        const colorDefault = await renderPng(page, colorDefaultDsl)
        const hash = pixelHash(colorDefault)
        console.log(`color default hash: ${hash}`)
        if (colorDefaultHash) assert.equal(hash, colorDefaultHash, 'color default pixels changed')
        const colorExplicit = await renderPng(page, colorExplicitDsl)
        assert.deepEqual(colorDefault.data, colorExplicit.data,
            'omitted defaults and explicit color defaults must be byte-identical')

        const colorAngle = await renderPng(page, dsl('testPattern(pattern: colorGrid, gridSize: 4)',
            'style: color, amount: 1, angle: 45, height: 1'))
        const colorHeight = await renderPng(page, dsl('testPattern(pattern: colorGrid, gridSize: 4)',
            'style: color, amount: 1, angle: 135, height: 3'))
        assert.ok(imageDifference(colorDefault, colorAngle).changed > 1000,
            'non-default color angle must remain responsive')
        assert.ok(imageDifference(colorDefault, colorHeight).changed > 1000,
            'non-default color height must remain responsive')

        // This is the first new contract and intentionally makes the pre-change
        // test fail after the old behavior has been pinned above.
        assertMetadataAndSourceInvariants()

        for (const args of [
            'style: gray, angle: 0, height: 1, colorAmount: 0',
            'style: gray, angle: 73, height: 6, colorAmount: 0',
            'style: gray, angle: -145, height: 10, colorAmount: 100',
        ]) {
            const uniform = await renderPng(page, dsl('solid(color: #ff3010)', args))
            const pixels = interiorRgb(uniform)
            assert.ok(pixels.every(([r, g, b]) => r === g && g === b && Math.abs(r - 128) <= 1),
                `uniform saturated input must remain neutral gray for ${args}`)
        }

        const edge0 = await renderPng(page, dsl('testPattern(pattern: colorBars)',
            'style: gray, angle: 0, height: 4, colorAmount: 0'))
        const edge100 = await renderPng(page, dsl('testPattern(pattern: colorBars)',
            'style: gray, angle: 0, height: 4, colorAmount: 100'))
        const achromatic99 = percentile(interiorRgb(edge0).map(chroma), 0.99)
        assert.ok(achromatic99 <= 1, `colorAmount=0 must be achromatic, p99 chroma=${achromatic99}`)
        const reliefEdges = await renderPng(page, dsl('testPattern(pattern: gridLines, gridSize: 4)',
            'style: gray, angle: 0, height: 4, colorAmount: 0'))
        const edgeLumas = interiorRgb(reliefEdges).map((rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3)
        assert.ok(Math.min(...edgeLumas) < 105 && Math.max(...edgeLumas) > 150,
            `color edges must create opposing shadow/highlight responses, range=${Math.min(...edgeLumas)}..${Math.max(...edgeLumas)}`)
        const edgeChroma99 = percentile(edgeColorBarPixels(edge100, 5).map(chroma), 0.99)
        assert.ok(edgeChroma99 >= 24, `colorAmount=100 must add substantial traced-edge chroma, p99=${edgeChroma99}`)
        const flat100 = flatColorBarPixels(edge100, 6)
        assert.ok(flat100.every(([r, g, b]) => r === g && g === b && Math.abs(r - 128) <= 1),
            'gray-style flat interiors must remain neutral even at colorAmount=100')

        const horizontal = edge0
        const vertical = await renderPng(page, dsl('testPattern(pattern: colorBars)',
            'style: gray, angle: 90, height: 4, colorAmount: 0'))
        assert.ok(nonNeutralCount(horizontal) > nonNeutralCount(vertical) * 8,
            `angle must rotate the response away from vertical edges (horizontal=${nonNeutralCount(horizontal)}, vertical=${nonNeutralCount(vertical)})`)
        const reach1 = await renderPng(page, dsl('testPattern(pattern: colorBars)',
            'style: gray, angle: 0, height: 1, colorAmount: 0'))
        const reach6 = await renderPng(page, dsl('testPattern(pattern: colorBars)',
            'style: gray, angle: 0, height: 6, colorAmount: 0'))
        assert.ok(nonNeutralCount(reach6) > nonNeutralCount(reach1) * 3,
            `height must increase edge reach (height1=${nonNeutralCount(reach1)}, height6=${nonNeutralCount(reach6)})`)

        const webglTileFailures = await assertTileParity(
            browser, baseUrl, page, false, 'WebGL2', consoleMessages)

        // WebGPU needs a trustworthy origin before setContent. Pixel checks on
        // this second backend catch uniform-layout and constant-vector errors
        // that compile-only harness gates cannot see.
        const webgpuPage = await browser.newPage({ viewport: { width, height } })
        await webgpuPage.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
        webgpuPage.on('console', (message) => {
            if (!['error', 'warning'].includes(message.type())) return
            const text = message.text()
            if (message.type() === 'warning' && text.includes('GL Driver Message (OpenGL, Performance')) return
            consoleMessages.push(`[webgpu ${message.type()}] ${text}`)
        })
        webgpuPage.on('pageerror', (error) => consoleMessages.push(`[webgpu pageerror] ${error.message}`))
        await installHarness(webgpuPage, baseUrl, true)

        const colorWebgpu = await renderPng(webgpuPage, colorDefaultDsl, 'WebGPU')
        const webgpuHash = pixelHash(colorWebgpu)
        console.log(`color WebGPU default hash: ${webgpuHash}`)
        if (colorWebgpuDefaultHash) {
            assert.equal(webgpuHash, colorWebgpuDefaultHash, 'WebGPU color default pixels changed')
        }
        const colorExplicitWebgpu = await renderPng(webgpuPage, colorExplicitDsl, 'WebGPU')
        assert.deepEqual(colorWebgpu.data, colorExplicitWebgpu.data,
            'WebGPU omitted defaults and explicit color defaults must be byte-identical')

        const parityPrograms = [
            dsl('testPattern(pattern: colorGrid, gridSize: 4)',
                'style: gray, angle: 37, height: 4, colorAmount: 100'),
            dsl('testPattern(pattern: uvMap)',
                'style: gray, angle: -53, height: 6, colorAmount: 0'),
        ]
        for (const program of parityPrograms) {
            const webgl = await renderPng(page, program)
            const webgpu = await renderPng(webgpuPage, program, 'WebGPU')
            const parity = imageDifference(webgl, webgpu)
            assert.ok(parity.max <= 2 && parity.mean <= 0.15,
                `Gray WebGL2/WebGPU pixels diverged: max=${parity.max}, mean=${parity.mean.toFixed(4)}`)
            console.log(`gray backend parity: max=${parity.max}, mean=${parity.mean.toFixed(4)}`)
        }
        const webgpuTileFailures = await assertTileParity(
            browser, baseUrl, webgpuPage, true, 'WebGPU', consoleMessages)
        await webgpuPage.close()

        assert.deepEqual([...webglTileFailures, ...webgpuTileFailures], [],
            `Emboss tile parity failures:\n${[...webglTileFailures, ...webgpuTileFailures].join('\n')}`)

        assert.deepEqual(consoleMessages, [],
            `browser console reported errors or warnings:\n${consoleMessages.join('\n')}`)
        console.log(`gray edge chroma p99: zero=${achromatic99}, full=${edgeChroma99}`)
        console.log(`gray angle response pixels: angle0=${nonNeutralCount(horizontal)}, angle90=${nonNeutralCount(vertical)}`)
        console.log(`gray height reach pixels: height1=${nonNeutralCount(reach1)}, height6=${nonNeutralCount(reach6)}`)
    } finally {
        await browser.close()
        releaseServer()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
