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
const pondDir = path.join(effectsDir, 'filter', 'pondRipples')
const plasticDir = path.join(effectsDir, 'filter', 'plasticWrap')

process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot

const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const { default: pondDefinition } = await import(path.join(pondDir, 'definition.js'))
const { default: plasticDefinition } = await import(path.join(plasticDir, 'definition.js'))

const width = 96
const height = 96
const defaultPondHash = 'fc7d901982ab7f080faa0770f203b5c0c2846efc2864fa0db4e37921807845a9'
const defaultPondWebgpuHash = defaultPondHash
const defaultPlasticHash = 'c2dd9c18ec53919f94c921968dc3af3f0127acb5dd9bf817bb7975aaecccd8c3'

const sourceDsl = `search synth

testPattern(pattern: colorGrid, gridSize: 6)
  .write(o0)

render(o0)`

function pondDsl(amount) {
    return `search synth, filter

testPattern(pattern: colorGrid, gridSize: 6)
  .pondRipples(amount: ${amount})
  .write(o0)

render(o0)`
}

function plasticDsl(highlight = 60, detail = 40, smoothness = 30, lightDirection = null) {
    const directionArg = lightDirection
        ? `, lightDirection: vec3(${lightDirection.join(', ')})`
        : ''
    return `search synth, filter

testPattern(pattern: colorGrid, gridSize: 6)
  .plasticWrap(highlight: ${highlight}, detail: ${detail}, smoothness: ${smoothness}${directionArg})
  .write(o0)

render(o0)`
}

function hash(png) {
    return crypto.createHash('sha256').update(png.data).digest('hex')
}

function difference(a, b, margin = 0) {
    assert.equal(a.width, b.width)
    assert.equal(a.height, b.height)
    let sum = 0
    let max = 0
    let changed = 0
    let count = 0
    for (let y = margin; y < a.height - margin; y++) {
        for (let x = margin; x < a.width - margin; x++) {
            for (let c = 0; c < 3; c++) {
                const i = (y * a.width + x) * 4 + c
                const delta = Math.abs(a.data[i] - b.data[i])
                sum += delta
                max = Math.max(max, delta)
                if (delta !== 0) changed++
                count++
            }
        }
    }
    return { mean: sum / count, max, changed }
}

function cropFromBottomLeft(png, [offsetX, offsetY], cropWidth, cropHeight) {
    const result = new PNG({ width: cropWidth, height: cropHeight })
    PNG.bitblt(png, result, offsetX, png.height - offsetY - cropHeight,
        cropWidth, cropHeight, 0, 0)
    return result
}

function assertStaticContracts() {
    assert.equal(pondDefinition.globals.amount.min, 0,
        'Pond Ripples amount must use a public 0..100 scale')
    assert.equal(pondDefinition.globals.amount.max, 100,
        'Pond Ripples amount must use a public 0..100 scale')
    assert.equal(pondDefinition.globals.amount.default, 30,
        'Pond Ripples must retain amount=30 as its default')

    assert.deepEqual(plasticDefinition.globals.lightDirection, {
        type: 'vec3',
        default: [-0.4, 0.6, 0.7],
        uniform: 'lightDirection',
        ui: { label: 'direction', control: 'vector3' },
    }, 'Plastic Wrap must expose the operator-facing key-light heading, rotated 180 degrees from the internal vector')
    assert.deepEqual(Object.keys(plasticDefinition.globals),
        ['highlight', 'detail', 'smoothness', 'lightDirection'],
        'lightDirection must be appended so positional Plastic Wrap calls stay compatible')

    const gain = amount => {
        if (amount <= 30) return amount / 100
        const x = (amount - 30) / 70
        return 0.3 + 0.7 * x + x * x
    }
    assert.equal(gain(30), 0.3, 'the shipped amount=30 displacement gain must remain exact')
    assert.equal(gain(100), 2, 'amount=100 must be exactly twice the former maximum gain')
    for (let amount = 1; amount <= 100; amount++) {
        assert.ok(gain(amount) > gain(amount - 1),
            `Pond Ripples gain must increase monotonically at amount=${amount}`)
    }

    for (const effectDir of [pondDir, plasticDir]) {
        for (const relativePath of fs.readdirSync(effectDir, { recursive: true })) {
            const absolutePath = path.join(effectDir, relativePath)
            if (!fs.statSync(absolutePath).isFile()) continue
            const prohibitedProduct = String.fromCharCode(80, 104, 111, 116, 111, 115, 104, 111, 112)
            assert.equal(fs.readFileSync(absolutePath, 'utf8').toLowerCase().includes(prohibitedProduct.toLowerCase()), false,
                `${path.relative(repoRoot, absolutePath)} must use vendor-neutral terminology`)
        }
    }

    for (const language of ['glsl', 'wgsl']) {
        const pondSource = fs.readFileSync(path.join(pondDir, language, `pondRipples.${language}`), 'utf8')
        assert.match(pondSource, /amount\s*<=?\s*30\.0|uniforms\.amount\s*<=?\s*30\.0/,
            `${language} must preserve the shipped mapping through the default amount`)
        assert.match(pondSource, /1\.7|2\.0/,
            `${language} must raise the amount=100 displacement gain to 2x the prior maximum`)

        const plasticSource = fs.readFileSync(path.join(plasticDir, language, `pwSpec.${language}`), 'utf8')
        assert.match(plasticSource, /4\.0\s*\*\s*hC|hC\s*\*\s*4\.0/,
            `${language} Plastic Wrap must use a two-dimensional five-point Laplacian`)
        for (const term of ['hL', 'hR', 'hB', 'hT']) {
            assert.match(plasticSource, new RegExp(`curv[^;\\n]*${term}|${term}[^;\\n]*curv`),
                `${language} curvature must include ${term}`)
        }
        assert.match(plasticSource, language === 'glsl'
            ? /uniform\s+vec3\s+lightDirection\s*;/
            : /lightDirection\s*:\s*vec3<f32>/,
        `${language} Plastic Wrap must declare the controlled light direction`)
        assert.match(plasticSource, language === 'glsl'
            ? /dot\(lightDirection,\s*lightDirection\)/
            : /dot\(uniforms\.lightDirection,\s*uniforms\.lightDirection\)/,
        `${language} Plastic Wrap must guard a zero-length controlled light direction`)
        assert.match(plasticSource, /halfLengthSq/,
            `${language} Plastic Wrap must guard a light direction antipodal to the view vector`)
    }
}

async function installHarness(page, baseUrl, preferWebGPU, canvasWidth = width, canvasHeight = height) {
    await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;width:${canvasWidth}px;height:${canvasHeight}px;overflow:hidden}canvas{display:block}</style>
<canvas id="canvas" width="${canvasWidth}" height="${canvasHeight}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
const renderer = new CanvasRenderer({
  canvas: document.getElementById('canvas'), width: ${canvasWidth}, height: ${canvasHeight},
  basePath: '${baseUrl}/shaders', preferWebGPU: ${preferWebGPU}
});
await renderer.loadManifest();
await renderer.loadEffects(['synth/testPattern', 'filter/pondRipples', 'filter/plasticWrap']);
window.renderDsl = async (source, tileRegion) => {
  await renderer.compile(source);
  if (tileRegion) renderer.setTileRegion(tileRegion);
  renderer.render(0); renderer.render(0);
  await new Promise(resolve => requestAnimationFrame(resolve));
  return renderer.pipeline?.backend?.getName?.() || 'unknown';
};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function', null, { timeout: 30000 })
}

async function render(page, dsl, expectedBackend, tileRegion = null) {
    const backend = await page.evaluate(
        async ({ source, region }) => window.renderDsl(source, region),
        { source: dsl, region: tileRegion })
    assert.equal(backend, expectedBackend)
    return PNG.sync.read(await (await page.$('canvas')).screenshot({ type: 'png' }))
}

async function assertBackend(browser, baseUrl, preferWebGPU, expectedBackend) {
    const page = await browser.newPage({ viewport: { width, height } })
    const diagnostics = []
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    page.on('console', message => {
        if (!['error', 'warning'].includes(message.type())) return
        if (message.type() === 'warning' && message.text().includes('GL Driver Message (OpenGL, Performance')) return
        diagnostics.push(`[${message.type()}] ${message.text()}`)
    })
    page.on('pageerror', error => diagnostics.push(`[pageerror] ${error.message}`))
    await installHarness(page, baseUrl, preferWebGPU)

    const source = await render(page, sourceDsl, expectedBackend)
    const pondDefault = await render(page, pondDsl(30), expectedBackend)
    const pondMax = await render(page, pondDsl(100), expectedBackend)
    const plasticZero = await render(page, plasticDsl(0), expectedBackend)
    const plasticDefault = await render(page, plasticDsl(60), expectedBackend)
    const plasticExplicitDefault = await render(page, plasticDsl(60, 40, 30, [-0.4, 0.6, 0.7]), expectedBackend)
    const plasticZeroDirection = await render(page, plasticDsl(60, 40, 30, [0, 0, 0]), expectedBackend)
    const plasticAntipodal = await render(page, plasticDsl(60, 40, 30, [0, 0, -1]), expectedBackend)
    const plasticOpposite = await render(page, plasticDsl(60, 40, 30, [0.4, -0.6, 0.7]), expectedBackend)
    const plasticCoarse = await render(page, plasticDsl(60, 0, 30), expectedBackend)
    const plasticFine = await render(page, plasticDsl(60, 100, 30), expectedBackend)
    const plasticSharp = await render(page, plasticDsl(60, 40, 0), expectedBackend)
    const plasticSmooth = await render(page, plasticDsl(60, 40, 100), expectedBackend)

    if (expectedBackend === 'WebGL2') {
        console.log(`Pond default baseline hash: ${hash(pondDefault)}`)
        if (!defaultPondHash.startsWith('__')) {
            assert.equal(hash(pondDefault), defaultPondHash,
                'amount=30 Pond Ripples pixels must remain byte-identical')
        }
    } else {
        console.log(`Pond WebGPU default baseline hash: ${hash(pondDefault)}`)
        if (!defaultPondWebgpuHash.startsWith('__')) {
            assert.equal(hash(pondDefault), defaultPondWebgpuHash,
                'WebGPU amount=30 Pond Ripples pixels must remain byte-identical')
        }
    }
    assert.deepEqual(plasticZero.data, source.data,
        `${expectedBackend} highlight=0 must reproduce the input byte-for-byte`)
    assert.equal(hash(plasticDefault), defaultPlasticHash,
        `${expectedBackend} omitted Plastic Wrap direction must retain the current default pixels`)
    assert.deepEqual(plasticExplicitDefault.data, plasticDefault.data,
        `${expectedBackend} explicit default direction must equal the omitted default byte-for-byte`)
    assert.deepEqual(plasticZeroDirection.data, plasticDefault.data,
        `${expectedBackend} a zero-length direction must safely fall back to the default light`)
    assert.deepEqual(plasticAntipodal.data, plasticDefault.data,
        `${expectedBackend} a view-antipodal direction must safely fall back to the default half-vector`)
    assert.ok(difference(plasticOpposite, plasticDefault, 16).changed > 500,
        `${expectedBackend} Plastic Wrap direction must visibly steer the highlight`)

    const plasticStrength = difference(plasticDefault, source, 16)
    console.log(`${expectedBackend} Plastic Wrap default delta: mean=${plasticStrength.mean.toFixed(3)}, max=${plasticStrength.max}, changed=${plasticStrength.changed}`)
    assert.ok(plasticStrength.mean >= 8,
        `${expectedBackend} Plastic Wrap default must be materially visible, mean delta=${plasticStrength.mean.toFixed(3)}`)
    assert.ok(difference(plasticCoarse, plasticFine, 16).changed > 500,
        `${expectedBackend} Plastic Wrap detail must visibly change contour scale`)
    assert.ok(difference(plasticSharp, plasticSmooth, 16).changed > 500,
        `${expectedBackend} Plastic Wrap smoothness must visibly change highlight width`)

    assert.ok(difference(pondMax, pondDefault, 8).changed > 1000,
        `${expectedBackend} amount=100 must be visibly stronger than amount=30`)
    assert.deepEqual(diagnostics, [], `${expectedBackend} browser diagnostics:\n${diagnostics.join('\n')}`)
    await page.close()
    return { source, pondDefault, pondMax, plasticDefault, plasticOpposite }
}

async function assertTileParity(browser, baseUrl, preferWebGPU, expectedBackend, fullPlastic) {
    const tileWidth = 64
    const tileHeight = 64
    const offset = [16, 16]
    const page = await browser.newPage({ viewport: { width: tileWidth, height: tileHeight } })
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    await installHarness(page, baseUrl, preferWebGPU, tileWidth, tileHeight)
    const tile = await render(page, plasticDsl(60, 40, 30, [0.4, -0.6, 0.7]), expectedBackend,
        { offset, fullResolution: [width, height] })
    const expected = cropFromBottomLeft(fullPlastic, offset, tileWidth, tileHeight)
    const delta = difference(tile, expected, 14)
    console.log(`${expectedBackend} Plastic Wrap tile interior delta: mean=${delta.mean.toFixed(4)}, max=${delta.max}`)
    assert.ok(delta.max <= 2 && delta.mean <= 0.05,
        `${expectedBackend} Plastic Wrap tile interior must match full-frame crop`)
    await page.close()
}

async function main() {
    assertStaticContracts()
    const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
            '--enable-webgpu-developer-features',
            process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan',
        ],
    })
    try {
        const webgl = await assertBackend(browser, baseUrl, false, 'WebGL2')
        const webgpu = await assertBackend(browser, baseUrl, true, 'WebGPU')
        const pondDefaultParity = difference(webgpu.pondDefault, webgl.pondDefault)
        const pondMaxParity = difference(webgpu.pondMax, webgl.pondMax)
        const plasticParity = difference(webgpu.plasticDefault, webgl.plasticDefault)
        console.log(`backend parity: pond30 mean=${pondDefaultParity.mean.toFixed(4)} max=${pondDefaultParity.max}; pond100 mean=${pondMaxParity.mean.toFixed(4)} max=${pondMaxParity.max}; plastic mean=${plasticParity.mean.toFixed(4)} max=${plasticParity.max}`)
        assert.ok(plasticParity.max <= 2,
            'Plastic Wrap backends must remain visually equivalent')
        assert.ok(difference(webgpu.plasticOpposite, webgl.plasticOpposite).max <= 2,
            'custom Plastic Wrap direction must remain visually equivalent across backends')
        await assertTileParity(browser, baseUrl, false, 'WebGL2', webgl.plasticOpposite)
        await assertTileParity(browser, baseUrl, true, 'WebGPU', webgpu.plasticOpposite)
    } finally {
        await browser.close()
        await releaseServer()
    }
}

await main()
