#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
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
const { default: medianDefinition } = await import(path.join(effectsDir, 'filter', 'median', 'definition.js'))

const width = 17
const height = 17
const seed = 29

const fixtureGlsl = `#ifdef GL_ES
precision highp float;
#endif
uniform vec2 resolution;
uniform int seed;
uniform int mode;
out vec4 fragColor;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int v = (p.x * 37 + p.y * 17 + seed * 13) % 16;
    int a = mode == 3 ? 63 + ((p.x * 13 + p.y * 31 + seed * 5) % 192) : 255;
    vec3 rgb = vec3(float(v * 16), float(v * 13), float(v * 9)) / 255.0;
    ivec2 center = ivec2(resolution) / 2;
    ivec2 d = p - center;
    if (mode == 1) {
        bool strideX = d.x == -3 || d.x == 0 || d.x == 3;
        bool strideY = d.y == -3 || d.y == 0 || d.y == 3;
        rgb = (strideX && strideY) ? vec3(0.0) : vec3(1.0);
    } else if (mode == 2 && abs(d.x) <= 1 && abs(d.y) <= 1) {
        int index = (d.y + 1) * 3 + d.x + 1;
        rgb = index < 3 ? vec3(1.0, 0.0, 0.0) :
              (index < 6 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    }
    fragColor = vec4(rgb, float(a) / 255.0);
}`

const fixtureWgsl = `struct Uniforms { resolution: vec2<f32>, seed: i32, mode: i32, }
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@fragment fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(pos.xy);
    let v = (p.x * 37 + p.y * 17 + uniforms.seed * 13) % 16;
    let a = select(255, 63 + ((p.x * 13 + p.y * 31 + uniforms.seed * 5) % 192), uniforms.mode == 3);
    var rgb = vec3<f32>(f32(v * 16), f32(v * 13), f32(v * 9)) / 255.0;
    let center = vec2<i32>(uniforms.resolution) / 2;
    let d = p - center;
    if (uniforms.mode == 1) {
        let strideX = d.x == -3 || d.x == 0 || d.x == 3;
        let strideY = d.y == -3 || d.y == 0 || d.y == 3;
        rgb = select(vec3<f32>(1.0), vec3<f32>(0.0), strideX && strideY);
    } else if (uniforms.mode == 2 && abs(d.x) <= 1 && abs(d.y) <= 1) {
        let index = (d.y + 1) * 3 + d.x + 1;
        if (index < 3) { rgb = vec3<f32>(1.0, 0.0, 0.0); }
        else if (index < 6) { rgb = vec3<f32>(0.0, 1.0, 0.0); }
        else { rgb = vec3<f32>(0.0, 0.0, 1.0); }
    }
    return vec4<f32>(rgb, f32(a) / 255.0);
}`

function medianDsl(radius, threshold = 0, mode = 0) {
    return `search synth, filter

seededFixture(seed: ${seed}, mode: ${mode})
  .median(radius: ${radius}, threshold: ${threshold})
  .write(o0)

render(o0)`
}

function sourceDsl(mode = 0) {
    return `search synth

seededFixture(seed: ${seed}, mode: ${mode})
  .write(o0)

render(o0)`
}

function rgbaAt(png, x, y) {
    const offset = (y * png.width + x) * 4
    return Array.from(png.data.subarray(offset, offset + 4))
}

function luma(rgb) {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

function compareRgb(a, b) {
    const dl = luma(a) - luma(b)
    if (dl !== 0) return dl
    for (let channel = 0; channel < 3; channel++) {
        if (a[channel] !== b[channel]) return a[channel] - b[channel]
    }
    return 0
}

function referencePixel(source, x, y, radius, threshold = 0) {
    const samples = []
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const sx = Math.max(0, Math.min(source.width - 1, x + dx))
            const sy = Math.max(0, Math.min(source.height - 1, y + dy))
            samples.push(rgbaAt(source, sx, sy))
        }
    }
    samples.sort(compareRgb)
    const median = samples[Math.floor(samples.length / 2)]
    const center = rgbaAt(source, x, y)
    const maxDiff = Math.max(...median.slice(0, 3).map((value, channel) => Math.abs(value - center[channel])))
    const replace = threshold <= 0 || maxDiff >= threshold * 2.55 - 1e-6
    return [...(replace ? median : center).slice(0, 3), center[3]]
}

function assertInteriorMatches(actual, source, radius, threshold = 0, tolerance = 2) {
    for (let y = radius; y < height - radius; y++) {
        for (let x = radius; x < width - radius; x++) {
            const got = rgbaAt(actual, x, y)
            const expected = referencePixel(source, x, y, radius, threshold)
            for (let channel = 0; channel < 4; channel++) {
                assert.ok(Math.abs(got[channel] - expected[channel]) <= tolerance,
                    `radius ${radius}, threshold ${threshold}, pixel (${x},${y}), channel ${channel}: got ${got}, expected ${expected}`)
            }
        }
    }
}

function assertWholeColorMedian() {
    const neighborhood = [
        [255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255],
        [0, 255, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255],
        [0, 0, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255],
    ]
    neighborhood.sort(compareRgb)
    const selected = neighborhood[4].slice(0, 3)
    assert.ok(neighborhood.some((sample) => sample.slice(0, 3).every((value, i) => value === selected[i])),
        'brightness median must carry a source RGB triplet')
    assert.notDeepEqual(selected, [0, 0, 0], 'whole-color median must not synthesize the component median')
}

function assertStaticContract() {
    const glslPath = path.join(effectsDir, 'filter', 'median', 'glsl', 'median.glsl')
    const wgslPath = path.join(effectsDir, 'filter', 'median', 'wgsl', 'median.wgsl')
    for (const shaderPath of [glslPath, wgslPath]) {
        assert.ok(fs.existsSync(shaderPath), `${path.basename(shaderPath)} must be the single Median pass`)
        const source = fs.readFileSync(shaderPath, 'utf8')
        assert.match(source, /RADIUS\s*==\s*1[\s\S]*REAL_COUNT\s+9/,
            `${path.basename(shaderPath)} must specialize radius 1 to 9 reads`)
        assert.match(source, /RADIUS\s*==\s*2[\s\S]*REAL_COUNT\s+25/,
            `${path.basename(shaderPath)} must specialize radius 2 to 25 reads`)
        assert.match(source, /REAL_COUNT\s+49/,
            `${path.basename(shaderPath)} must specialize radius 3 to 49 reads`)
        assert.equal((source.match(/(?:textureLoad|texelFetch)\s*\(/g) || []).length, 1,
            `${path.basename(shaderPath)} must fetch only the exact dense neighborhood`)
        assert.doesNotMatch(source, /strided|pass\s+repeat|iterations/i,
            `${path.basename(shaderPath)} must not contain the sparse/repeated topology`)
        assert.doesNotMatch(source, /partition_?step|left_?step|right_?step/i,
            `${path.basename(shaderPath)} must not use triply nested bounded partition scans`)
        assert.doesNotMatch(source, /rank_?step/i,
            `${path.basename(shaderPath)} must not place every lower rank when only the median rank is needed`)
        assert.match(source, /while\s*\(|\bloop\s*\{/,
            `${path.basename(shaderPath)} must use an adaptive exact selection loop`)
    }

    assert.deepEqual(Object.keys(medianDefinition.globals), ['radius', 'threshold'])
    assert.deepEqual(medianDefinition.globals.radius, {
        type: 'int', default: 3, define: 'RADIUS', min: 1, max: 3, step: 1,
        ui: { label: 'radius', control: 'slider' },
    })
    assert.equal(medianDefinition.passes.length, 1, 'Median must be exactly one pass')
    assert.equal(medianDefinition.textures, undefined, 'Median must allocate no internal textures')
}

async function installHarness(page, baseUrl, preferWebGPU) {
    if (preferWebGPU) await page.goto(`${baseUrl}/shaders/effects/manifest.json`, { waitUntil: 'load' })
    await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}canvas{display:block;width:${width}px;height:${height}px}</style>
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script type="module">
import { CanvasRenderer } from '${baseUrl}/shaders/src/index.js';
import { Effect } from '${baseUrl}/shaders/src/runtime/effect.js';

const glsl = ${JSON.stringify(fixtureGlsl)};
const wgsl = ${JSON.stringify(fixtureWgsl)};
const fixture = new Effect({
    name: 'Seeded Fixture', namespace: 'synth', func: 'seededFixture', tags: ['util'],
    globals: {
        seed: { type: 'int', default: ${seed}, uniform: 'seed', min: 0, max: 100 },
        mode: { type: 'int', default: 0, uniform: 'mode', min: 0, max: 3 },
    },
    passes: [{ name: 'render', program: 'fixture', inputs: {}, outputs: { fragColor: 'outputTex' } }],
});
fixture.shaders = { fixture: { glsl, wgsl } };

const renderer = new CanvasRenderer({
    canvas: document.getElementById('canvas'), width: ${width}, height: ${height},
    basePath: '${baseUrl}/shaders', preferWebGPU: ${preferWebGPU},
});
await renderer.loadManifest();
renderer.registerEffectsFromBundle({ namespace: 'synth', effects: { seededFixture: fixture } });
await renderer.loadEffects(['filter/median']);
window.renderDsl = async (dsl) => {
    await renderer.compile(dsl);
    renderer.stop();
    renderer.render(0);
    const queue = renderer.pipeline?.backend?.device?.queue;
    if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
    await new Promise(resolve => requestAnimationFrame(resolve));
    return renderer.pipeline?.backend?.getName?.() || 'unknown';
};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function')
}

async function render(page, dsl, expectedBackend) {
    const backend = await page.evaluate((source) => window.renderDsl(source), dsl)
    assert.equal(backend, expectedBackend)
    const dataUrl = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'))
    return PNG.sync.read(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
}

async function verifyBackend(browser, baseUrl, preferWebGPU, expectedBackend) {
    const page = await browser.newPage({ viewport: { width, height } })
    page.setDefaultTimeout(30000)
    const messages = []
    page.on('console', message => {
        if (['warning', 'error'].includes(message.type())) messages.push(`[${message.type()}] ${message.text()}`)
    })
    page.on('pageerror', error => messages.push(`[pageerror] ${error.message}`))
    try {
        await installHarness(page, baseUrl, preferWebGPU)
        messages.length = 0
        const source = await render(page, sourceDsl(), expectedBackend)
        for (const radius of [1, 2, 3]) {
            const actual = await render(page, medianDsl(radius), expectedBackend)
            assertInteriorMatches(actual, source, radius)
        }

        const center = [8, 8]
        const sparseTrap = await render(page, medianDsl(3, 0, 1), expectedBackend)
        assert.deepEqual(rgbaAt(sparseTrap, ...center).slice(0, 3), [255, 255, 255],
            '7x7 majority white must defeat the former nine strided black taps')

        const wholeColor = await render(page, medianDsl(1, 0, 2), expectedBackend)
        const selectedTriplet = rgbaAt(wholeColor, ...center).slice(0, 3)
        assert.ok([[255, 0, 0], [0, 255, 0], [0, 0, 255]].some(sample =>
            sample.every((value, channel) => Math.abs(value - selectedTriplet[channel]) <= 1)),
        `RGB neighborhood must select one source triplet, got ${selectedTriplet}`)
        assert.notDeepEqual(selectedTriplet, [0, 0, 0], 'RGB neighborhood must not synthesize component-wise black')

        const rank = referencePixel(source, center[0], center[1], 3, 0)
        const original = rgbaAt(source, center[0], center[1])
        const delta = Math.max(...rank.slice(0, 3).map((value, channel) => Math.abs(value - original[channel])))
        assert.ok(delta > 3 && delta < 253, `fixture center must exercise threshold gate, delta=${delta}`)
        const intermediate = delta / 255 * 50
        const above = Math.min(100, delta / 255 * 100 + 1)
        const thresholdZero = await render(page, medianDsl(3, 0), expectedBackend)
        const thresholdIntermediate = await render(page, medianDsl(3, intermediate), expectedBackend)
        const thresholdAbove = await render(page, medianDsl(3, above), expectedBackend)
        assert.deepEqual(rgbaAt(thresholdZero, ...center), rank, 'threshold zero must emit the rank result')
        assert.deepEqual(rgbaAt(thresholdIntermediate, ...center), rank, 'intermediate threshold must replace the center')
        assert.deepEqual(rgbaAt(thresholdAbove, ...center), original, 'threshold above delta must preserve the center')
        const alphaSource = await render(page, sourceDsl(3), expectedBackend)
        const alphaMedian = await render(page, medianDsl(3, 0, 3), expectedBackend)
        assert.equal(rgbaAt(alphaMedian, ...center)[3], rgbaAt(alphaSource, ...center)[3],
            'output alpha must be original center alpha')
        assert.equal(messages.length, 0, messages.join('\n'))
        console.log(`${expectedBackend}: exact radii 1/2/3 and Dust & Scratches threshold passed`)
    } finally {
        await page.close()
    }
}

async function main() {
    assertWholeColorMedian()
    const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
            '--enable-webgpu-developer-features', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan'],
    })
    try {
        await verifyBackend(browser, baseUrl, false, 'WebGL2')
        await verifyBackend(browser, baseUrl, true, 'WebGPU')
    } finally {
        await browser.close()
        releaseServer()
    }
    assertStaticContract()
    console.log('Median exact invariant test passed')
}

main().catch(error => {
    console.error(error.stack || error)
    process.exitCode = 1
})
