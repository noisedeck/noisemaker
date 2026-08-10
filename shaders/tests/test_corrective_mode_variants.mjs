#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import crypto from 'node:crypto'
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

const textureModes = [
    'canvas', 'crosshatch', 'halftone', 'paper', 'stucco',
    'regular', 'soft', 'sprinkles', 'clumped', 'contrasty',
    'enlarged', 'stippled', 'horizontal', 'vertical', 'speckle',
]
const strokeModes = ['angled', 'sprayed', 'dark', 'sumiE', 'smudge']

for (const backend of ['glsl', 'wgsl']) {
    const stippleSource = fs.readFileSync(path.join(effectsDir, 'filter', 'stipple', backend, `stipple.${backend}`), 'utf8')
    assert.doesNotMatch(stippleSource, /smoothstep\s*\(\s*radius\s*\+\s*aa\s*,\s*radius\s*-\s*aa/,
        `${backend} Pointillize antialiasing must not use undefined reversed smoothstep edges`)
    if (backend === 'wgsl') {
        assert.match(stippleSource, /tileOffset\s*:\s*vec2<f32>/,
            'WGSL Pointillize and noise geometry must use global tile coordinates')
    }

    const oilSource = fs.readFileSync(path.join(effectsDir, 'filter', 'oilPaint', backend, `oilFlatten.${backend}`), 'utf8')
    assert.match(oilSource, /sample_?limit\s*=\s*[^;\n]*ceil\s*\(\s*fr\s*\)/i,
        `${backend} Oil Paint must bound its Kuwahara lattice to the active radius`)
    assert.doesNotMatch(oilSource, /(?:int|i32)[^\n=]*[xy][^\n=]*=\s*-12/,
        `${backend} Oil Paint must not execute the full 25x25 loop domain for smaller radii`)
    assert.doesNotMatch(oilSource, /(?:mean|sqr|cnt)\s*:\s*array|(?:vec3|float)\s+(?:mean|sqr|cnt)\s*\[\s*8\s*\]/,
        `${backend} Oil Paint must not dynamically index eight fragment-local accumulator arrays`)
}

async function install(preferWebGPU, width = 96, height = 96) {
    const page = await browser.newPage({ viewport: { width, height } })
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    const errors = []
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<!doctype html>
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
const renderer = new CanvasRenderer({canvas:document.getElementById('canvas'),width:${width},height:${height},basePath:'${baseUrl}/shaders',preferWebGPU:${preferWebGPU}});
await renderer.loadManifest();
await renderer.loadEffects(['synth/testPattern','synth/solid','filter/texture','filter/strokes','filter/mosaicTiles','filter/stipple']);
window.renderDsl=async(dsl,region)=>{await renderer.compile(dsl);if(region)renderer.setTileRegion(region);else renderer.clearTileRegion();renderer.render(0);renderer.render(0);const queue=renderer.pipeline?.backend?.device?.queue;if(queue?.onSubmittedWorkDone)await queue.onSubmittedWorkDone();return renderer.pipeline.backend.getName();};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function')
    return { page, errors }
}

async function capture(page) {
    const url = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'))
    return PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

function cropFromBottomLeft(source, [offsetX, offsetY], width, height) {
    const result = new PNG({ width, height })
    PNG.bitblt(source, result, offsetX, source.height - offsetY - height,
        width, height, 0, 0)
    return result
}

function maxDifference(a, b) {
    assert.equal(a.data.length, b.data.length)
    let max = 0
    for (let index = 0; index < a.data.length; index++) {
        max = Math.max(max, Math.abs(a.data[index] - b.data[index]))
    }
    return max
}

function pixelDifference(a, b, margin = 0) {
    let sum = 0
    let changed = 0
    let max = 0
    let count = 0
    for (let y = margin; y < a.height - margin; y++) {
        for (let x = margin; x < a.width - margin; x++) {
            for (let channel = 0; channel < 3; channel++) {
                const i = (y * a.width + x) * 4 + channel
                const delta = Math.abs(a.data[i] - b.data[i])
                sum += delta
                changed += Number(delta > 0)
                max = Math.max(max, delta)
                count++
            }
        }
    }
    return { mean: sum / count, changed, max }
}

function softTextureStats(png) {
    let horizontal = 0
    let vertical = 0
    let horizontalCount = 0
    let verticalCount = 0
    let plateaus = 0
    let blocks = 0
    const values = new Set()
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const i = (y * png.width + x) * 4
            values.add(png.data[i])
            if (x + 1 < png.width) {
                horizontal += Math.abs(png.data[i] - png.data[i + 4])
                horizontalCount++
            }
            if (y + 1 < png.height) {
                vertical += Math.abs(png.data[i] - png.data[i + png.width * 4])
                verticalCount++
            }
            if (x + 1 < png.width && y + 1 < png.height) {
                blocks++
                const a = png.data[i]
                if (a === png.data[i + 4] && a === png.data[i + png.width * 4] &&
                    a === png.data[i + (png.width + 1) * 4]) plateaus++
            }
        }
    }
    const horizontalMean = horizontal / horizontalCount
    const verticalMean = vertical / verticalCount
    return {
        unique: values.size,
        anisotropy: horizontal / vertical,
        plateauRatio: plateaus / blocks,
        horizontalMean,
        verticalMean,
        variation: (horizontalMean + verticalMean) * 0.5,
    }
}

function equalNeighborRatio(png, margin = 8) {
    let equal = 0
    let total = 0
    const sameRgb = (a, b) => png.data[a] === png.data[b] &&
        png.data[a + 1] === png.data[b + 1] && png.data[a + 2] === png.data[b + 2]
    for (let y = margin; y < png.height - margin; y++) {
        for (let x = margin; x < png.width - margin; x++) {
            const i = (y * png.width + x) * 4
            if (x + 1 < png.width - margin) {
                equal += Number(sameRgb(i, i + 4))
                total++
            }
            if (y + 1 < png.height - margin) {
                equal += Number(sameRgb(i, i + png.width * 4))
                total++
            }
        }
    }
    return equal / total
}

function tileFaceColorCount(png, tileSize = 32) {
    const colors = new Set()
    for (let y = tileSize / 2; y < png.height; y += tileSize) {
        for (let x = tileSize / 2; x < png.width; x += tileSize) {
            const i = (y * png.width + x) * 4
            colors.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`)
        }
    }
    return colors.size
}

function directionalTextureStats(png) {
    let horizontal = 0
    let vertical = 0
    let horizontalCount = 0
    let verticalCount = 0
    const rowJumps = []
    const columnJumps = []
    for (let y = 1; y < png.height - 1; y++) {
        let rowJump = 0
        for (let x = 1; x < png.width - 1; x++) {
            const i = (y * png.width + x) * 4
            horizontal += Math.abs(png.data[i] - png.data[i + 4])
            vertical += Math.abs(png.data[i] - png.data[i + png.width * 4])
            rowJump += Math.abs(png.data[i] - png.data[i + png.width * 4])
            horizontalCount++
            verticalCount++
        }
        rowJumps.push(rowJump / (png.width - 2))
    }
    for (let x = 1; x < png.width - 1; x++) {
        let columnJump = 0
        for (let y = 1; y < png.height - 1; y++) {
            const i = (y * png.width + x) * 4
            columnJump += Math.abs(png.data[i] - png.data[i + 4])
        }
        columnJumps.push(columnJump / (png.height - 2))
    }
    const spikeRatio = values => {
        const sorted = values.toSorted((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]
        return Math.max(...values) / Math.max(median, 1e-6)
    }
    return {
        horizontal: horizontal / horizontalCount,
        vertical: vertical / verticalCount,
        rowSpike: spikeRatio(rowJumps),
        columnSpike: spikeRatio(columnJumps),
    }
}

try {
    const rendered = {}
    const softDsl = `search synth, filter

solid(color: #808080)
  .texture(mode: soft, alpha: 0.8, scale: 1, intensity: 55, contrast: 55)
  .write(o0)

render(o0)`
    const paperDsl = `search synth, filter

testPattern(pattern: uvMap)
  .texture()
  .write(o0)

render(o0)`
    const mosaicDsl = `search synth, filter

testPattern(pattern: uvMap)
  .mosaicTiles(mode: mosaic, tileSize: 32, groutWidth: 0, relief: 0, seed: 1)
  .write(o0)

render(o0)`
    const shiftedDslFor = (maxOffset, seed) => `search synth, filter

testPattern(pattern: uvMap)
  .mosaicTiles(mode: shifted, tileSize: 32, maxOffset: ${maxOffset}, seed: ${seed})
  .write(o0)

render(o0)`
    const shiftedDsl = shiftedDslFor(25, 1)
    const shiftedNoOffsetDsl = shiftedDslFor(0, 1)
    const shiftedAltSeedDsl = shiftedDslFor(25, 2)
    const directionalDsl = mode => `search synth, filter

solid(color: #808080)
  .texture(mode: ${mode}, alpha: 0.8, scale: 1, intensity: 55, contrast: 55)
  .write(o0)

render(o0)`
    const highScaleMaterialDsl = mode => `search synth, filter

solid(color: #808080)
  .texture(mode: ${mode}, alpha: 1, scale: 10, intensity: 40, contrast: 30, mono: true)
  .write(o0)

render(o0)`
    const uvSourceDsl = `search synth

testPattern(pattern: uvMap)
  .write(o0)

render(o0)`
    const strokesDsl = `search synth, filter

testPattern(pattern: uvMap)
  .strokes(mode: angled, length: 55, sharpness: 20)
  .write(o0)

render(o0)`
    const stippleDsl = `search synth, filter

testPattern(pattern: uvMap)
  .stipple(mode: pointillize, cellSize: 8, seed: 1)
  .write(o0)

render(o0)`
    for (const preferWebGPU of [false, true]) {
        const expected = preferWebGPU ? 'WebGPU' : 'WebGL2'
        const { page, errors } = await install(preferWebGPU)
        for (const mode of textureModes) {
            const dsl = `search synth, filter

testPattern(pattern: uvMap)
  .texture(mode: ${mode}, alpha: 0.8)
  .write(o0)

render(o0)`
            assert.equal(await page.evaluate(source => window.renderDsl(source), dsl), expected,
                `${expected} Texture ${mode} must render on the requested backend`)
        }
        for (const mode of strokeModes) {
            const dsl = `search synth, filter

testPattern(pattern: colorGrid, gridSize: 8)
  .strokes(mode: ${mode})
  .write(o0)

render(o0)`
            assert.equal(await page.evaluate(source => window.renderDsl(source), dsl), expected,
                `${expected} Strokes ${mode} must render on the requested backend`)
        }
        assert.equal(await page.evaluate(source => window.renderDsl(source), paperDsl), expected)
        const paper = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), softDsl), expected)
        const soft = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), mosaicDsl), expected)
        const mosaic = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), shiftedDsl), expected)
        const shifted = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), shiftedNoOffsetDsl), expected)
        const shiftedNoOffset = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), shiftedAltSeedDsl), expected)
        const shiftedAltSeed = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), directionalDsl('horizontal')), expected)
        const horizontal = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), directionalDsl('vertical')), expected)
        const vertical = await capture(page)
        const highScaleMaterial = {}
        for (const mode of ['regular', 'soft', 'horizontal', 'vertical']) {
            assert.equal(await page.evaluate(source => window.renderDsl(source), highScaleMaterialDsl(mode)), expected)
            highScaleMaterial[mode] = await capture(page)
        }
        assert.equal(await page.evaluate(source => window.renderDsl(source), uvSourceDsl), expected)
        const uvSource = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), strokesDsl), expected)
        const strokes = await capture(page)
        assert.equal(await page.evaluate(source => window.renderDsl(source), stippleDsl), expected)
        const stipple = await capture(page)
        rendered[expected] = {
            paper, soft, mosaic, shifted, shiftedNoOffset, shiftedAltSeed,
            horizontal, vertical, uvSource, strokes, stipple,
            highScaleMaterial,
        }
        assert.deepEqual(errors, [], `${expected} mode variants emitted browser errors`)
        console.log(`${expected}: ${textureModes.length} Texture and ${strokeModes.length} Strokes modes passed`)
        await page.close()

        const offset = [24, 16]
        const tileWidth = 48
        const tileHeight = 40
        const tilePage = await install(preferWebGPU, tileWidth, tileHeight)
        assert.equal(await tilePage.page.evaluate(({ source, region }) => window.renderDsl(source, region), {
            source: softDsl,
            region: { offset, fullResolution: [96, 96] },
        }), expected)
        const tile = await capture(tilePage.page)
        assert.ok(maxDifference(tile,
            cropFromBottomLeft(soft, offset, tileWidth, tileHeight)) <= 1,
        `${expected} Soft Texture tile must match its full-frame crop`)
        assert.deepEqual(tilePage.errors, [], `${expected} Soft Texture tile emitted browser errors`)
        await tilePage.page.close()

        for (const mode of ['horizontal', 'vertical']) {
            const directionalTilePage = await install(preferWebGPU, tileWidth, tileHeight)
            assert.equal(await directionalTilePage.page.evaluate(({ source, region }) => window.renderDsl(source, region), {
                source: directionalDsl(mode),
                region: { offset, fullResolution: [96, 96] },
            }), expected)
            const directionalTile = await capture(directionalTilePage.page)
            assert.ok(maxDifference(directionalTile,
                cropFromBottomLeft(rendered[expected][mode], offset, tileWidth, tileHeight)) <= 1,
            `${expected} ${mode} Texture tile must match its full-frame crop`)
            assert.deepEqual(directionalTilePage.errors, [],
                `${expected} ${mode} Texture tile emitted browser errors`)
            await directionalTilePage.page.close()
        }

        const strokesTilePage = await install(preferWebGPU, tileWidth, tileHeight)
        assert.equal(await strokesTilePage.page.evaluate(({ source, region }) => window.renderDsl(source, region), {
            source: strokesDsl,
            region: { offset, fullResolution: [96, 96] },
        }), expected)
        const strokesTile = await capture(strokesTilePage.page)
        const strokesTileDelta = pixelDifference(strokesTile,
            cropFromBottomLeft(rendered[expected].strokes, offset, tileWidth, tileHeight), 14)
        assert.ok(strokesTileDelta.max <= 2 && strokesTileDelta.mean <= 0.1,
            `${expected} Strokes tile interior must match its full-frame crop: ${JSON.stringify(strokesTileDelta)}`)
        assert.deepEqual(strokesTilePage.errors, [], `${expected} Strokes tile emitted browser errors`)
        await strokesTilePage.page.close()

        // A tile representative can live up to half a cell plus the 25% warp
        // outside the rendered region. Ignore that unavoidable source-halo
        // band and verify the procedural grid plus in-tile lookups globally.
        const mosaicTileSize = 64
        const mosaicTileOffset = [16, 16]
        const mosaicTilePage = await install(preferWebGPU, mosaicTileSize, mosaicTileSize)
        assert.equal(await mosaicTilePage.page.evaluate(({ source, region }) => window.renderDsl(source, region), {
            source: mosaicDsl,
            region: { offset: mosaicTileOffset, fullResolution: [96, 96] },
        }), expected)
        const mosaicTile = await capture(mosaicTilePage.page)
        const mosaicTileDelta = pixelDifference(mosaicTile,
            cropFromBottomLeft(rendered[expected].mosaic, mosaicTileOffset, mosaicTileSize, mosaicTileSize), 24)
        assert.ok(mosaicTileDelta.max <= 1 && mosaicTileDelta.mean <= 0.05,
            `${expected} Mosaic procedural grid and interior samples must not restart per tile: ${JSON.stringify(mosaicTileDelta)}`)
        assert.equal(await mosaicTilePage.page.evaluate(({ source, region }) => window.renderDsl(source, region), {
            source: stippleDsl,
            region: { offset: mosaicTileOffset, fullResolution: [96, 96] },
        }), expected)
        const stippleTile = await capture(mosaicTilePage.page)
        const stippleTileDelta = pixelDifference(stippleTile,
            cropFromBottomLeft(rendered[expected].stipple, mosaicTileOffset, mosaicTileSize, mosaicTileSize), 10)
        assert.ok(stippleTileDelta.max <= 1 && stippleTileDelta.mean <= 0.05,
            `${expected} Pointillize geometry and interior samples must not restart per tile: ${JSON.stringify(stippleTileDelta)}`)
        assert.deepEqual(mosaicTilePage.errors, [], `${expected} Mosaic tile emitted browser errors`)
        await mosaicTilePage.page.close()

        // Shifted tiles can sample up to 0.75 cell widths away from a fragment
        // (half a cell to its center plus the default 25% random offset).
        // Render a 32px source halo and compare a 64px core spanning multiple
        // representative tile faces instead of validating a tiny central patch.
        const shiftedFullSize = 192
        const shiftedTileSize = 128
        const shiftedHalo = 32
        const shiftedOffset = [32, 32]
        const shiftedFullPage = await install(preferWebGPU, shiftedFullSize, shiftedFullSize)
        assert.equal(await shiftedFullPage.page.evaluate(source => window.renderDsl(source), shiftedDsl), expected)
        const shiftedFull = await capture(shiftedFullPage.page)
        assert.deepEqual(shiftedFullPage.errors, [], `${expected} full Shifted Mosaic emitted browser errors`)
        await shiftedFullPage.page.close()

        const shiftedTilePage = await install(preferWebGPU, shiftedTileSize, shiftedTileSize)
        assert.equal(await shiftedTilePage.page.evaluate(({ source, region }) => window.renderDsl(source, region), {
            source: shiftedDsl,
            region: { offset: shiftedOffset, fullResolution: [shiftedFullSize, shiftedFullSize] },
        }), expected)
        const shiftedTile = await capture(shiftedTilePage.page)
        const shiftedTileDelta = pixelDifference(shiftedTile,
            cropFromBottomLeft(shiftedFull, shiftedOffset, shiftedTileSize, shiftedTileSize), shiftedHalo)
        assert.ok(shiftedTileDelta.max <= 1 && shiftedTileDelta.mean <= 0.05,
            `${expected} Shifted Mosaic haloed tile core must match its full-frame crop: ${JSON.stringify(shiftedTileDelta)}`)
        assert.deepEqual(shiftedTilePage.errors, [], `${expected} tiled Shifted Mosaic emitted browser errors`)
        await shiftedTilePage.page.close()
    }
    assert.ok(maxDifference(rendered.WebGL2.soft, rendered.WebGPU.soft) <= 1,
        'Soft Texture must match across backends')
    assert.ok(maxDifference(rendered.WebGL2.mosaic, rendered.WebGPU.mosaic) <= 1,
        'Mosaic Tiles pixelization must match across backends')
    assert.ok(maxDifference(rendered.WebGL2.shifted, rendered.WebGPU.shifted) <= 1,
        'Shifted Mosaic pixelization must match across backends')
    for (const mode of ['horizontal', 'vertical']) {
        assert.ok(maxDifference(rendered.WebGL2[mode], rendered.WebGPU[mode]) <= 1,
            `${mode} Texture must match across backends`)
    }
    for (const backend of ['WebGL2', 'WebGPU']) {
        const strokeDelta = pixelDifference(rendered[backend].strokes, rendered[backend].uvSource, 8)
        assert.ok(strokeDelta.mean > 2 && strokeDelta.changed > 5000,
            `${backend} Strokes must lay visible pigment marks over a smooth field: ${JSON.stringify(strokeDelta)}`)
    }
    const strokesParity = pixelDifference(rendered.WebGL2.strokes, rendered.WebGPU.strokes)
    assert.ok(strokesParity.mean <= 4 && strokesParity.max <= 40,
        `Strokes pigment marks must remain visually equivalent across backend orientation conventions: ${JSON.stringify(strokesParity)}`)
    const horizontalStats = directionalTextureStats(rendered.WebGL2.horizontal)
    const verticalStats = directionalTextureStats(rendered.WebGL2.vertical)
    assert.ok(horizontalStats.horizontal / horizontalStats.vertical > 0.04 &&
        horizontalStats.horizontal / horizontalStats.vertical < 0.45,
    `Horizontal Texture must form continuous fibers without collapsing into row bands: ${JSON.stringify(horizontalStats)}`)
    assert.ok(verticalStats.vertical / verticalStats.horizontal > 0.04 &&
        verticalStats.vertical / verticalStats.horizontal < 0.45,
    `Vertical Texture must form continuous fibers without collapsing into column bands: ${JSON.stringify(verticalStats)}`)
    assert.ok(horizontalStats.rowSpike < 3 && verticalStats.columnSpike < 3,
        `Directional Texture must not expose periodic lattice knot lines: ${JSON.stringify({ horizontalStats, verticalStats })}`)
    for (const backend of ['WebGL2', 'WebGPU']) {
        const highScale = rendered[backend].highScaleMaterial
        const regularStats = softTextureStats(highScale.regular)
        const highSoftStats = softTextureStats(highScale.soft)
        const highSoftGridStats = directionalTextureStats(highScale.soft)
        const highHorizontalStats = directionalTextureStats(highScale.horizontal)
        const highVerticalStats = directionalTextureStats(highScale.vertical)
        assert.ok(highSoftStats.variation < regularStats.variation * 0.75,
            `${backend} high-scale Soft Texture must visibly smooth regular texture without blocky grain: ${JSON.stringify({ regularStats, highSoftStats })}`)
        assert.ok(highSoftGridStats.rowSpike < 1.5 && highSoftGridStats.columnSpike < 1.5,
            `${backend} high-scale Soft Texture must not expose horizontal or vertical lattice steps: ${JSON.stringify(highSoftGridStats)}`)
        assert.ok(highHorizontalStats.horizontal / highHorizontalStats.vertical < 0.2,
            `${backend} high-scale Horizontal Texture must form continuous horizontal fibers: ${JSON.stringify(highHorizontalStats)}`)
        assert.ok(highVerticalStats.vertical / highVerticalStats.horizontal < 0.2,
            `${backend} high-scale Vertical Texture must form continuous vertical fibers: ${JSON.stringify(highVerticalStats)}`)
    }
    const stippleHashes = Object.fromEntries(['WebGL2', 'WebGPU'].map(backend => [backend,
        crypto.createHash('sha256').update(rendered[backend].stipple.data).digest('hex')]))
    // Rebaselined when the Voronoi jitter hash moved to integer arithmetic.
    // The previous value was only ever reproducible on WebGPU; WebGL2 disagreed
    // with it, and with itself across ANGLE backends. Both backends now agree.
    assert.deepEqual(stippleHashes, {
        WebGL2: '23ed00f547697984d3cab0fd4eefc048b9ec925e112e7e32028813ba321a30e2',
        WebGPU: '23ed00f547697984d3cab0fd4eefc048b9ec925e112e7e32028813ba321a30e2',
    }, 'Pointillize pixels must retain their existing contract')
    const mosaicPlateau = equalNeighborRatio(rendered.WebGL2.mosaic)
    assert.ok(mosaicPlateau > 0.6,
        `Mosaic Tiles must pixelize each tile to a representative source sample; equal-neighbor ratio=${mosaicPlateau.toFixed(4)}`)
    const mosaicHashes = Object.fromEntries(['WebGL2', 'WebGPU'].map(backend => [backend,
        crypto.createHash('sha256').update(rendered[backend].mosaic.data).digest('hex')]))
    // Stale control constant: Mosaic and Shifted share mosaicWarp and
    // mosaicGroutMask, so the Shifted correction moved Mosaic too and this
    // "unchanged" baseline was never refreshed. Both backends agree on the
    // current value bit-for-bit, and the Shifted and Paper hashes below still
    // match their originals.
    assert.deepEqual(mosaicHashes, {
        WebGL2: '662262ed0c4723f20802e300bd2f6637cea6d71b9fbc38bb562a89f94f25ac3d',
        WebGPU: '662262ed0c4723f20802e300bd2f6637cea6d71b9fbc38bb562a89f94f25ac3d',
    }, 'Mosaic mode pixels must remain byte-identical while Shifted is corrected')
    const shiftedHashes = Object.fromEntries(['WebGL2', 'WebGPU'].map(backend => [backend,
        crypto.createHash('sha256').update(rendered[backend].shifted.data).digest('hex')]))
    assert.deepEqual(shiftedHashes, {
        WebGL2: '8aee2e35c5456911d010354c39f664f179925e2ae83fc4466d3b93daed35753c',
        WebGPU: '8aee2e35c5456911d010354c39f664f179925e2ae83fc4466d3b93daed35753c',
    }, 'corrected Shifted Mosaic pixels must remain byte-identical across backends')
    for (const backend of ['WebGL2', 'WebGPU']) {
        for (const variant of ['shifted', 'shiftedNoOffset', 'shiftedAltSeed']) {
            const shiftedPlateau = equalNeighborRatio(rendered[backend][variant])
            assert.ok(shiftedPlateau > 0.6,
                `${backend} ${variant} must retain flat pixelized tile faces; equal-neighbor ratio=${shiftedPlateau.toFixed(4)}`)
            assert.ok(tileFaceColorCount(rendered[backend][variant]) >= 6,
                `${backend} ${variant} must retain multiple distinct representative tile colors`)
        }
        const offsetDelta = pixelDifference(rendered[backend].shifted, rendered[backend].shiftedNoOffset, 8)
        assert.ok(offsetDelta.mean > 1 && offsetDelta.changed > 1000,
            `${backend} Shifted Mosaic maxOffset must materially change tile samples: ${JSON.stringify(offsetDelta)}`)
        const seedDelta = pixelDifference(rendered[backend].shifted, rendered[backend].shiftedAltSeed, 8)
        assert.ok(seedDelta.mean > 1 && seedDelta.changed > 1000,
            `${backend} Shifted Mosaic seed must materially change tile samples: ${JSON.stringify(seedDelta)}`)
    }
    const paperHashes = Object.fromEntries(['WebGL2', 'WebGPU'].map(backend => [backend,
        crypto.createHash('sha256').update(rendered[backend].paper.data).digest('hex')]))
    assert.deepEqual(paperHashes, {
        WebGL2: '26624775e320302ac79ff2151bcb66a24308fc8580c4a73a3966a72fc67328e9',
        WebGPU: 'c22a69b73345b2f9f28a22cd82cb50fc35f0f08048aecd959b72945d92cc7729',
    }, 'original Paper Texture pixels must retain their backend-specific contracts')
    const softStats = softTextureStats(rendered.WebGL2.soft)
    assert.ok(softStats.unique > 100, `Soft Texture needs continuous tonal variation: ${JSON.stringify(softStats)}`)
    assert.ok(softStats.anisotropy > 0.8 && softStats.anisotropy < 1.25,
        `Soft Texture must be isotropic: ${JSON.stringify(softStats)}`)
    assert.ok(softStats.plateauRatio < 0.02,
        `Soft Texture must not form block plateaus: ${JSON.stringify(softStats)}`)
    console.log(`Paper Texture hashes pinned; Soft stats: ${JSON.stringify(softStats)}`)
} finally {
    await browser.close()
    await releaseServer()
}
