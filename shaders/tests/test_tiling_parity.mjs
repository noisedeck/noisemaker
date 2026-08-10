#!/usr/bin/env node
// Tile-parity gate: every effect whose GLSL is tile-aware must render a tiled
// region (offset != 0, fullResolution = full image) whose interior matches the
// same region cropped from a full-frame render -- on BOTH backends. A WGSL port
// that seeds its procedural pattern from raw pos.xy instead of pos.xy+tileOffset
// shifts the entire pattern, so the interior comparison fails decisively.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const effectsDir = path.join(repoRoot, 'shaders/effects')
process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot

const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
        process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan'],
})

const FULL = 128
const TILE = 64
const OFFSET = [32, 32]
const MARGIN = 18   // ignore the neighbor-sampling border; a correct interior must match
const TOL = 2       // per-channel LSB tolerance for a correct tile interior

// Effect DSL fragments chosen so each effect's tile-aware procedural pattern is
// active (strong enough that a per-tile restart would be visible).
const EFFECTS = [
    'scatter(mode: clumped, radius: 12)',
    'relief()',
    'spinBlur(amount: 60)',
    'craquelure()',
    'extrude()',
    'hatch()',
    'lensFlare()',
    'oilPaint()',
    'patchwork()',
    'pondRipples(amount: 60)',
    'stamp()',
    'stipple(mode: mezzoStrokes)',
    'strokes()',
    'watercolor()',
    'emboss()',
]

const dslFor = call => `search synth, filter

testPattern(pattern: uvMap)
  .${call}
  .write(o0)

render(o0)`

async function install(preferWebGPU, width, height) {
    const page = await browser.newPage({ viewport: { width, height } })
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    const errors = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', e => errors.push(e.message))
    await page.setContent(`<!doctype html>
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
const r = new CanvasRenderer({canvas:document.getElementById('canvas'),width:${width},height:${height},basePath:'${baseUrl}/shaders',preferWebGPU:${preferWebGPU}});
await r.loadManifest();
await r.loadEffects(['synth/testPattern','filter/scatter','filter/relief','filter/spinBlur','filter/craquelure','filter/extrude','filter/hatch','filter/lensFlare','filter/oilPaint','filter/patchwork','filter/pondRipples','filter/stamp','filter/stipple','filter/strokes','filter/watercolor','filter/emboss']);
window.renderDsl=async(dsl,region)=>{await r.compile(dsl);if(region)r.setTileRegion(region);else r.clearTileRegion();r.render(0);r.render(0);const q=r.pipeline?.backend?.device?.queue;if(q?.onSubmittedWorkDone)await q.onSubmittedWorkDone();return r.pipeline.backend.getName();};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function')
    return { page, errors }
}

async function capture(page) {
    const url = await page.locator('canvas').evaluate(c => c.toDataURL('image/png'))
    return PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

// Canvas/GL present with a bottom-left origin, so a tile at pixel offset (ox,oy)
// corresponds to this crop of the full-frame image.
function cropFromBottomLeft(src, [ox, oy], w, h) {
    const out = new PNG({ width: w, height: h })
    PNG.bitblt(src, out, ox, src.height - oy - h, w, h, 0, 0)
    return out
}

function interiorMaxDiff(tile, cropped, margin) {
    let max = 0, worst = null
    for (let y = margin; y < tile.height - margin; y++) {
        for (let x = margin; x < tile.width - margin; x++) {
            for (let c = 0; c < 3; c++) {
                const i = (y * tile.width + x) * 4 + c
                const d = Math.abs(tile.data[i] - cropped.data[i])
                if (d > max) { max = d; worst = [x, y, c] }
            }
        }
    }
    return { max, worst }
}

function backendParity(a, b, tolerance = 1) {
    assert.equal(a.width, b.width)
    assert.equal(a.height, b.height)
    let mismatch = 0
    let max = 0
    let total = 0
    const channels = a.width * a.height * 3
    for (let i = 0; i < a.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const d = Math.abs(a.data[i + c] - b.data[i + c])
            max = Math.max(max, d)
            total += d
            if (d > tolerance) mismatch++
        }
    }
    return { max, mean: total / channels, mismatchPercent: mismatch / channels * 100 }
}

const results = []
const fullFrames = new Map()
try {
    for (const [preferWebGPU, label] of [[false, 'WebGL2'], [true, 'WebGPU']]) {
        for (const call of EFFECTS) {
            const name = call.split('(')[0]
            try {
                const full = await install(preferWebGPU, FULL, FULL)
                const backend = await full.page.evaluate(d => window.renderDsl(d), dslFor(call))
                assert.equal(backend, label, `${name}: expected ${label}, got ${backend}`)
                const fullImg = await capture(full.page)
                fullFrames.set(`${label}/${name}`, fullImg)
                await full.page.close()

                const tile = await install(preferWebGPU, TILE, TILE)
                await tile.page.evaluate(({ d, region }) => window.renderDsl(d, region),
                    { d: dslFor(call), region: { offset: OFFSET, fullResolution: [FULL, FULL] } })
                const tileImg = await capture(tile.page)
                await tile.page.close()

                const { max, worst } = interiorMaxDiff(tileImg, cropFromBottomLeft(fullImg, OFFSET, TILE, TILE), MARGIN)
                const ok = max <= TOL
                results.push({ name, label, max, ok })
                console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(7)} ${name.padEnd(12)} interior maxDiff=${max}${worst ? ` @${worst}` : ''}`)
            } catch (err) {
                results.push({ name, label, max: -1, ok: false })
                console.log(`ERR  ${label.padEnd(7)} ${name.padEnd(12)} ${String(err.message || err).slice(0, 90).replace(/\s+/g, ' ')}`)
            }
        }
    }
    const failed = results.filter(r => !r.ok)
    assert.equal(failed.length, 0,
        `Tile-parity failures (interior must match full-frame crop): ${failed.map(f => `${f.label}/${f.name}=${f.max}`).join(', ')}`)

    const parityFailures = []
    for (const name of ['hatch', 'pondRipples', 'spinBlur', 'stipple', 'strokes']) {
        const parity = backendParity(fullFrames.get(`WebGL2/${name}`), fullFrames.get(`WebGPU/${name}`))
        console.log(`PARITY ${name.padEnd(12)} maxDiff=${parity.max} meanDiff=${parity.mean.toFixed(3)} mismatch=${parity.mismatchPercent.toFixed(2)}%`)
        if (parity.mismatchPercent >= 1) parityFailures.push(`${name}=${parity.mismatchPercent.toFixed(2)}%`)
    }
    assert.equal(parityFailures.length, 0,
        `WebGL2/WebGPU presented-pixel parity failures: ${parityFailures.join(', ')}`)

    console.log(`\nTile parity OK: ${results.length} effect/backend checks passed`)
} finally {
    await browser.close()
    await releaseServer()
}
