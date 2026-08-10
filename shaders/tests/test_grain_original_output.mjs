#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const effectsDir = path.join(repoRoot, 'shaders/effects')
process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot

const { default: definition } = await import(path.join(effectsDir, 'filter/grain/definition.js'))
assert.deepEqual(Object.keys(definition.globals), ['alpha', 'pause'])

const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
        process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan'],
})

const dsl = `search synth, filter

solid(color: #808080)
  .grain()
  .write(o0)

render(o0)`

async function install(preferWebGPU, width, height) {
    const page = await browser.newPage({ viewport: { width, height } })
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    await page.setContent(`<!doctype html>
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}canvas{display:block;width:${width}px;height:${height}px}</style>
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
const renderer = new CanvasRenderer({canvas:document.getElementById('canvas'),width:${width},height:${height},basePath:'${baseUrl}/shaders',preferWebGPU:${preferWebGPU}});
await renderer.loadManifest();
await renderer.loadEffects(['synth/solid','filter/grain']);
window.renderDsl=async(dsl,region)=>{await renderer.compile(dsl);if(region)renderer.setTileRegion(region);else renderer.clearTileRegion();renderer.render(0);renderer.render(0);const queue=renderer.pipeline?.backend?.device?.queue;if(queue?.onSubmittedWorkDone)await queue.onSubmittedWorkDone();return renderer.pipeline.backend.getName();};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function')
    return page
}

async function render(page, expectedBackend, region = null) {
    assert.equal(await page.evaluate(({ source, tile }) => window.renderDsl(source, tile),
        { source: dsl, tile: region }), expectedBackend)
    const url = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'))
    return PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

function cropFromBottomLeft(source, [offsetX, offsetY], width, height) {
    const result = new PNG({ width, height })
    const top = source.height - offsetY - height
    PNG.bitblt(source, result, offsetX, top, width, height, 0, 0)
    return result
}

try {
    const full = {}
    for (const [preferWebGPU, backend] of [[false, 'WebGL2'], [true, 'WebGPU']]) {
        const page = await install(preferWebGPU, 128, 128)
        full[backend] = await render(page, backend)
        await page.close()
    }

    const hash = crypto.createHash('sha256').update(full.WebGL2.data).digest('hex')
    assert.equal(hash, '5f310272067f9215247d2503e14ea1a993164c237cc8170a66137acf495885d3',
        'Grain default pixels must retain the pre-extension output contract')
    assert.deepEqual(full.WebGPU.data, full.WebGL2.data,
        'Grain full-frame output must match across backends')

    const offset = [32, 24]
    const tileWidth = 48
    const tileHeight = 40
    const region = { offset, fullResolution: [128, 128] }
    for (const [preferWebGPU, backend] of [[false, 'WebGL2'], [true, 'WebGPU']]) {
        const page = await install(preferWebGPU, tileWidth, tileHeight)
        const tile = await render(page, backend, region)
        assert.deepEqual(tile.data,
            cropFromBottomLeft(full[backend], offset, tileWidth, tileHeight).data,
            `${backend} Grain tile must equal its full-frame crop`)
        await page.close()
    }
    console.log(`Grain original hash and tiled backend parity: ${hash}`)
} finally {
    await browser.close()
    await releaseServer()
}
