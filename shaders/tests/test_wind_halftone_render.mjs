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
const { acquireServer, releaseServer } = await import(path.join(repoRoot, 'vendor/shade-mcp/harness/index.js'))

const width = 160
const height = 96
const expectedPatternHashes = {
    line: '842b9a9d8176638ead50666b3f97b0756ab403e129fe46ad007f57c4626bd2ce',
    circle: '0c1bb60f6ee1609c725092be1a460432c9f720ac32a34f491a9d0f9134d45892',
}
const fixtureGlsl = `
#ifdef GL_ES
precision highp float;
#endif
uniform vec2 resolution;
uniform vec2 tileOffset;
out vec4 fragColor;
void main() {
    vec2 gc = gl_FragCoord.xy + tileOffset;
    float bar = step(35.0, gc.x) * (1.0 - step(36.0, gc.x));
    fragColor = vec4(vec3(mix(0.08, 0.95, bar)), 1.0);
}`
const fixtureWgsl = `
struct Uniforms { tileOffset: vec2<f32>, }
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@fragment fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let gc = pos.xy + uniforms.tileOffset;
    let bar = step(35.0, gc.x) * (1.0 - step(36.0, gc.x));
    return vec4<f32>(vec3<f32>(mix(0.08, 0.95, bar)), 1.0);
}`

function windDsl(method = 'blast', direction = 'fromLeft') {
    return `search synth, filter
windFixture().wind(method: ${method}, direction: ${direction}, strength: 90, threshold: 10).write(o0)
render(o0)`
}

function monoDotDsl(color) {
    return `search synth, filter
solid(color: ${color}).halftone(mode: mono, pattern: dot, frequency: 24, monoAngle: 0, sharpness: 100, inkColor: #000000, paperColor: #ffffff).write(o0)
render(o0)`
}

function cyanDotDsl() {
    return `search synth, filter
solid(color: #b0ffff).halftone(mode: color, frequency: 24, cyanAngle: 0, magentaAngle: 0, yellowAngle: 0, blackAngle: 0, sharpness: 100).write(o0)
render(o0)`
}

function monoPatternDsl(pattern) {
    return `search synth, filter
solid(color: #707070).halftone(mode: mono, pattern: ${pattern}, frequency: 19, monoAngle: 30, sharpness: 80, inkColor: #000000, paperColor: #ffffff).write(o0)
render(o0)`
}

function hash(png) {
    return crypto.createHash('sha256').update(png.data).digest('hex')
}

function rgba(png, x, y) {
    const index = (y * png.width + x) * 4
    return [...png.data.subarray(index, index + 4)]
}

function luma(pixel) {
    return pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722
}

function meanRegion(png, x0, x1, y0 = 8, y1 = png.height - 8) {
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            sum += luma(rgba(png, x, y))
            count++
        }
    }
    return sum / count
}

function maxRowRange(png, x0, x1) {
    let range = 0
    for (let x = x0; x < x1; x++) {
        const values = []
        for (let y = 8; y < png.height - 8; y++) values.push(luma(rgba(png, x, y)))
        range = Math.max(range, Math.max(...values) - Math.min(...values))
    }
    return range
}

function maxDifference(a, b) {
    assert.equal(a.data.length, b.data.length)
    let max = 0
    for (let index = 0; index < a.data.length; index++) {
        max = Math.max(max, Math.abs(a.data[index] - b.data[index]))
    }
    return max
}

function cropFromBottomLeft(source, [offsetX, offsetY], cropWidth, cropHeight) {
    const result = new PNG({ width: cropWidth, height: cropHeight })
    const top = source.height - offsetY - cropHeight
    for (let y = 0; y < cropHeight; y++) {
        const start = ((top + y) * source.width + offsetX) * 4
        result.data.set(source.data.subarray(start, start + cropWidth * 4), y * cropWidth * 4)
    }
    return result
}

async function installHarness(page, baseUrl, preferWebGPU, canvasWidth, canvasHeight) {
    await page.setContent(`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${canvasWidth}px;height:${canvasHeight}px;overflow:hidden}canvas{display:block}</style>
<canvas id="canvas" width="${canvasWidth}" height="${canvasHeight}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
import { Effect } from '${baseUrl}/shaders/src/runtime/effect.js';
const fixture = new Effect({ name:'Wind Fixture', namespace:'synth', func:'windFixture', tags:['util'], globals:{},
  passes:[{name:'render',program:'fixture',inputs:{},outputs:{fragColor:'outputTex'}}] });
fixture.shaders = { fixture: { glsl:${JSON.stringify(fixtureGlsl)}, wgsl:${JSON.stringify(fixtureWgsl)} } };
const renderer = new CanvasRenderer({ canvas:document.getElementById('canvas'), width:${canvasWidth}, height:${canvasHeight},
  basePath:'${baseUrl}/shaders', preferWebGPU:${preferWebGPU} });
await renderer.loadManifest();
renderer.registerEffectsFromBundle({namespace:'synth',effects:{windFixture:fixture}});
await renderer.loadEffects(['synth/solid','filter/wind','filter/halftone']);
window.renderDsl = async (dsl, region) => {
  await renderer.compile(dsl);
  if (region) renderer.setTileRegion(region); else renderer.clearTileRegion();
  renderer.stop(); renderer.render(0); renderer.render(0);
  const queue=renderer.pipeline?.backend?.device?.queue; if(queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
  return renderer.pipeline?.backend?.getName?.() || 'unknown';
};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function')
}

async function render(page, dsl, backend, region = null) {
    assert.equal(await page.evaluate(({ source, tile }) => window.renderDsl(source, tile), { source: dsl, tile: region }), backend)
    const url = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'))
    return PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

async function backendRenders(browser, baseUrl, preferWebGPU, backend) {
    const page = await browser.newPage({ viewport: { width, height } })
    const messages = []
    page.on('console', message => {
        if (['warning', 'error'].includes(message.type())) messages.push(message.text())
    })
    page.on('pageerror', error => messages.push(error.message))
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    await installHarness(page, baseUrl, preferWebGPU, width, height)
    messages.length = 0
    const result = {
        blastLeft: await render(page, windDsl('blast', 'fromLeft'), backend),
        blastRight: await render(page, windDsl('blast', 'fromRight'), backend),
        stagger: await render(page, windDsl('stagger', 'fromLeft'), backend),
        lightDots: await render(page, monoDotDsl('#b0b0b0'), backend),
        darkDots: await render(page, monoDotDsl('#202020'), backend),
        cyanDots: await render(page, cyanDotDsl(), backend),
        line: await render(page, monoPatternDsl('line'), backend),
        circle: await render(page, monoPatternDsl('circle'), backend),
    }
    assert.deepEqual(messages, [], `${backend} console output:\n${messages.join('\n')}`)
    await page.close()
    return result
}

function assertWind(result, label) {
    const rightTrail = meanRegion(result.blastLeft, 45, 95)
    const wrongSide = meanRegion(result.blastLeft, 5, 30)
    assert.ok(rightTrail > wrongSide + 10,
        `${label} fromLeft must carry the bar to the right (${rightTrail.toFixed(1)} vs ${wrongSide.toFixed(1)})`)
    const leftTrail = meanRegion(result.blastRight, 5, 30)
    const rightBackground = meanRegion(result.blastRight, 55, 90)
    assert.ok(leftTrail > rightBackground + 10,
        `${label} fromRight must carry the bar to the left (${leftTrail.toFixed(1)} vs ${rightBackground.toFixed(1)})`)
    assert.ok(maxRowRange(result.blastLeft, 42, 110) <= 1,
        `${label} Blast on row-invariant input must not introduce row grain`)
    let maxColumnJump = 0
    for (let x = 45; x < 95; x++) {
        maxColumnJump = Math.max(maxColumnJump,
            Math.abs(luma(rgba(result.blastLeft, x, 48)) - luma(rgba(result.blastLeft, x + 1, 48))))
    }
    assert.ok(maxColumnJump < 4,
        `${label} one-pixel source must produce a continuous trail without even/odd comb gaps; jump=${maxColumnJump.toFixed(2)}`)

    const rowMeans = []
    for (let y = 8; y < height - 8; y++) rowMeans.push(meanRegion(result.stagger, 46, 70, y, y + 1))
    let maxJump = 0
    for (let index = 1; index < rowMeans.length; index++) maxJump = Math.max(maxJump, Math.abs(rowMeans[index] - rowMeans[index - 1]))
    assert.ok(maxJump < 12, `${label} Stagger row phase must stay continuous; adjacent jump=${maxJump.toFixed(2)}`)
    console.log(`${label} Wind: fromLeft trail=${rightTrail.toFixed(1)}, background=${wrongSide.toFixed(1)}, ` +
        `fromRight trail=${leftTrail.toFixed(1)}, blast row range=${maxRowRange(result.blastLeft, 42, 110).toFixed(1)}, column jump=${maxColumnJump.toFixed(1)}, stagger row jump=${maxJump.toFixed(2)}`)
}

function assertRoundDots(result, label) {
    for (const [name, image] of [['light', result.lightDots]]) {
        // Cell center is between pixels 11/12; edge midpoint and corner are
        // both outside the capped circle and must share the same field tone.
        const center = luma(rgba(image, 11, 11))
        const edge = luma(rgba(image, 0, 11))
        const corner = luma(rgba(image, 0, 0))
        assert.ok(Math.abs(edge - corner) <= 3,
            `${label} ${name} dot field must not form square/cross joins; edge=${edge.toFixed(1)} corner=${corner.toFixed(1)}`)
        assert.ok(center < edge - 25,
            `${label} ${name} tone must retain a visible circular dot; center=${center.toFixed(1)} edge=${edge.toFixed(1)}`)
        for (let y = 0; y < 24; y++) {
            for (let x = 0; x < 24; x++) {
                assert.ok(Math.abs(luma(rgba(image, x, y)) - luma(rgba(image, y, x))) <= 1,
                    `${label} ${name} dot cell must be radially symmetric at ${x},${y}`)
            }
        }
    }
    const darkCenter = luma(rgba(result.darkDots, 11, 11))
    const darkEdge = luma(rgba(result.darkDots, 0, 11))
    const darkCorner = luma(rgba(result.darkDots, 0, 0))
    assert.ok(darkCenter < darkEdge - 25,
        `${label} dark tones must retain a visibly round center dot; center=${darkCenter.toFixed(1)} edge=${darkEdge.toFixed(1)}`)
    assert.ok(darkEdge < darkCorner - 25,
        `${label} dark dot edge must remain a radial antialias ramp instead of a hard cell edge; edge=${darkEdge.toFixed(1)} corner=${darkCorner.toFixed(1)}`)
    for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) {
            const xy = luma(rgba(result.darkDots, x, y))
            const yx = luma(rgba(result.darkDots, y, x))
            assert.ok(Math.abs(xy - yx) <= 2,
                `${label} dark dot cell must be radially symmetric at ${x},${y}: ${xy}/${yx}`)
        }
    }
    const center = rgba(result.cyanDots, 11, 11)
    const edge = rgba(result.cyanDots, 0, 11)
    const corner = rgba(result.cyanDots, 0, 0)
    assert.ok(center[0] + 25 < center[1] && center[0] + 25 < center[2],
        `${label} color screen must retain subtractive cyan ink at dot center: ${center}`)
    assert.ok(Math.max(...edge.slice(0, 3).map((value, channel) => Math.abs(value - corner[channel]))) <= 3,
        `${label} color dot edge and corner must remain the same paper field`)
    console.log(`${label} Halftone: dark center/edge/corner=${[darkCenter, darkEdge, darkCorner].map(value => value.toFixed(1)).join('/')}, cyan center=${center.slice(0, 3).join('/')}`)
    assert.equal(hash(result.line), expectedPatternHashes.line,
        `${label} mono line pixels must retain their established output`)
    assert.equal(hash(result.circle), expectedPatternHashes.circle,
        `${label} mono circle pixels must retain their established output`)
    console.log(`${label} Halftone line/circle hashes: ${hash(result.line)} ${hash(result.circle)}`)
}

async function main() {
    const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
    const browser = await chromium.launch({ headless: true, args: ['--disable-gpu-sandbox', '--enable-unsafe-webgpu',
        '--enable-features=Vulkan', '--enable-webgpu-developer-features', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan'] })
    try {
        const webgl = await backendRenders(browser, baseUrl, false, 'WebGL2')
        const webgpu = await backendRenders(browser, baseUrl, true, 'WebGPU')
        assertWind(webgl, 'WebGL2')
        assertWind(webgpu, 'WebGPU')
        assertRoundDots(webgl, 'WebGL2')
        assertRoundDots(webgpu, 'WebGPU')
        for (const key of Object.keys(webgl)) {
            assert.ok(maxDifference(webgl[key], webgpu[key]) <= 1, `${key} backend parity exceeded one LSB`)
        }

        const tileWidth = 80
        const tileHeight = 64
        const tileOffset = [32, 16]
        const region = { offset: tileOffset, fullResolution: [width, height] }
        for (const [preferWebGPU, backend, full] of [[false, 'WebGL2', webgl], [true, 'WebGPU', webgpu]]) {
            const page = await browser.newPage({ viewport: { width: tileWidth, height: tileHeight } })
            if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
            await installHarness(page, baseUrl, preferWebGPU, tileWidth, tileHeight)
            const windTile = await render(page, windDsl('stagger', 'fromLeft'), backend, region)
            const dotTile = await render(page, monoDotDsl('#b0b0b0'), backend, region)
            // Ignore Wind's left overlap margin where a standalone tile cannot
            // contain every upwind source tap; retained production interiors match.
            const windExpected = cropFromBottomLeft(full.stagger, tileOffset, tileWidth, tileHeight)
            for (let y = 0; y < tileHeight; y++) {
                for (let x = 16; x < tileWidth; x++) assert.deepEqual(rgba(windTile, x, y), rgba(windExpected, x, y))
            }
            assert.ok(maxDifference(dotTile, cropFromBottomLeft(full.lightDots, tileOffset, tileWidth, tileHeight)) <= 1,
                `${backend} Halftone tile geometry must equal full-frame crop`)
            await page.close()
        }
    } finally {
        await browser.close()
        releaseServer()
    }
    console.log('Wind/Halftone rendered invariants passed')
}

main().catch(error => {
    console.error(error.stack || error)
    process.exitCode = 1
})
