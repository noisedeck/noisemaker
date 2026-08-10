#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const outDir = path.join(repoRoot, 'shaders/tests/.artifacts/spawnpoint-wgsl-vertical-mirror')

const BASE_DSL = `search filter, mixer, points, render, synth

solid()
  .subchain(name: "life", id: "zxnr") {
    .pointsEmit(
      stateSize: x64,
      layout: center,
      seed: 11,
      attrition: 2.26
    )
    .life(
      typeCount: 8,
      attractionScale: 1.9,
      repulsionScale: 3.2,
      minRadius: 0.021,
      friction: 0.25,
      matrixSeed: 78.425
    )
    .lenia(
      muK: 9,
      sigmaK: 3.4,
      repulsion: 0.6,
      dt: 0.08,
      searchRadius: 19,
      depositAmount: 1.4
    )
    .pointsRender(
      density: 100,
      intensity: 94.45,
      inputIntensity: 0,
      rotateX: 4.221,
      rotateY: 0.646,
      rotateZ: 1.316,
      viewScale: 1.546,
      posX: -25.066,
      posY: -19.438,
      matteOpacity: 0.839
    )
  }
  .write(o0)

render(o0)`

function withMotionBlurAccumulator(dsl) {
    return dsl.replace('\n  }\n  .write(o0)', '\n    .motionBlur(amount: 80)\n  }\n  .write(o0)')
}

function argValue(name, fallback) {
    const index = process.argv.indexOf(name)
    if (index === -1) return fallback
    return process.argv[index + 1] ?? fallback
}

function hasArg(name) {
    return process.argv.includes(name)
}

function expectedEffects(useAccumulation) {
    const effects = [
        'synth/solid',
        'render/pointsEmit',
        'points/life',
        'points/lenia',
        'render/pointsRender'
    ]
    if (useAccumulation) effects.push('filter/motionBlur')
    return effects
}

function contentType(file) {
    if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript'
    if (file.endsWith('.json')) return 'application/json'
    if (file.endsWith('.wasm')) return 'application/wasm'
    if (file.endsWith('.css')) return 'text/css'
    if (file.endsWith('.html')) return 'text/html'
    if (file.endsWith('.glsl') || file.endsWith('.wgsl')) return 'text/plain'
    return 'application/octet-stream'
}

function html() {
    return `<!doctype html>
<meta charset="utf-8">
<style>
body { margin: 0; background: #000; }
canvas { display: block; width: 1024px; height: 1024px; }
</style>
<canvas id="canvas" width="1024" height="1024"></canvas>
<script type="module">
import { CanvasRenderer } from '/shaders/src/index.js';
import { extractEffectNamesFromDsl } from '/demo/shaders/lib/demo-ui.js';

window.initSpawnpointWgsl = async function initSpawnpointWgsl(dsl, preferWebGPU) {
    try {
        const oldCanvas = document.getElementById('canvas');
        const canvas = oldCanvas.cloneNode(false);
        canvas.id = 'canvas';
        canvas.width = 1024;
        canvas.height = 1024;
        oldCanvas.replaceWith(canvas);

        const renderer = new CanvasRenderer({
            canvas,
            width: 1024,
            height: 1024,
            basePath: '/shaders',
            preferWebGPU
        });
        const manifest = await renderer.loadManifest();
        const effects = extractEffectNamesFromDsl(dsl, manifest).map((entry) => entry.effectId);
        const loaded = await renderer.loadEffects(effects);
        if (loaded.some((effect) => !effect)) throw new Error('failed to load effect in spawnpoint DSL');

        const pipeline = await renderer.compile(dsl);
        window.spawnpointWgslRenderer = renderer;
        window.spawnpointWgslPipeline = pipeline;
        window.spawnpointWgslFrame = 0;

        return {
            ok: true,
            backend: pipeline.backend?.getName?.() || 'unknown',
            frame: pipeline.frameIndex,
            passes: pipeline.graph?.passes?.length || 0,
            blits: pipeline.graph?.passes?.filter((pass) => pass.program === 'blit').length || 0,
            effects
        };
    } catch (err) {
        return {
            ok: false,
            name: err?.name,
            message: err?.message,
            stack: err?.stack,
            json: JSON.stringify(err),
            keys: Object.keys(err || {})
        };
    }
};

window.renderSpawnpointWgslChunk = async function renderSpawnpointWgslChunk(frames) {
    try {
        const renderer = window.spawnpointWgslRenderer;
        const pipeline = window.spawnpointWgslPipeline;
        if (!renderer || !pipeline) throw new Error('spawnpoint WGSL pipeline is not initialized');

        for (let i = 0; i < frames; i++) {
            const frame = window.spawnpointWgslFrame++;
            const seconds = frame / 60;
            renderer.render((seconds % 10) / 10);
            await pipeline.backend?.waitForIdle?.();
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
            ok: true,
            frame: pipeline.frameIndex,
            renderedFrames: window.spawnpointWgslFrame
        };
    } catch (err) {
        return {
            ok: false,
            name: err?.name,
            message: err?.message,
            stack: err?.stack,
            json: JSON.stringify(err),
            keys: Object.keys(err || {})
        };
    }
};

function mirrorRatioPixels(px, axis) {
    const { width, height, data } = px;
    let mirroredSum = 0;
    let directSum = 0;
    let n = 0;

    if (axis === 'horizontal') {
        const h = Math.floor(height / 2);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < width; x++) {
                const top = (y * width + x) * 4;
                const bottomDirect = ((height - h + y) * width + x) * 4;
                const bottomMirrored = ((height - 1 - y) * width + x) * 4;
                for (let c = 0; c < 3; c++) {
                    const mirroredDiff = data[top + c] - data[bottomMirrored + c];
                    const directDiff = data[top + c] - data[bottomDirect + c];
                    mirroredSum += mirroredDiff * mirroredDiff;
                    directSum += directDiff * directDiff;
                    n++;
                }
            }
        }
    } else {
        const w = Math.floor(width / 2);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < w; x++) {
                const left = (y * width + x) * 4;
                const rightDirect = (y * width + (width - w + x)) * 4;
                const rightMirrored = (y * width + (width - 1 - x)) * 4;
                for (let c = 0; c < 3; c++) {
                    const mirroredDiff = data[left + c] - data[rightMirrored + c];
                    const directDiff = data[left + c] - data[rightDirect + c];
                    mirroredSum += mirroredDiff * mirroredDiff;
                    directSum += directDiff * directDiff;
                    n++;
                }
            }
        }
    }

    return (mirroredSum / n) / (directSum / n);
}

function mirrorStatsPixels(px) {
    const horizontalRatio = mirrorRatioPixels(px, 'horizontal');
    const verticalRatio = mirrorRatioPixels(px, 'vertical');
    return {
        width: px.width,
        height: px.height,
        horizontalRatio,
        verticalRatio,
        mirrored: horizontalRatio < 0.49 && (verticalRatio - horizontalRatio) > 0.05
    };
}

window.dumpSpawnpointWgslTextureStats = async function dumpSpawnpointWgslTextureStats() {
    const pipeline = window.spawnpointWgslPipeline;
    if (!pipeline) throw new Error('spawnpoint WGSL pipeline is not initialized');

    const backend = pipeline.backend;
    const candidates = new Map();
    const add = (label, id) => {
        if (!id || typeof id !== 'string') return;
        if (!backend.textures?.has?.(id)) return;
        candidates.set(label, id);
    };

    for (const [name, surface] of pipeline.surfaces || []) {
        add('surface:' + name + ':read', pipeline.frameReadTextures?.get(name) || surface.read);
        add('surface:' + name + ':write', pipeline.frameWriteTextures?.get(name) || surface.write);
    }
    for (const pass of pipeline.graph?.passes || []) {
        for (const [slot, id] of Object.entries(pass.inputs || {})) add(pass.id + ':input:' + slot, id);
        for (const [slot, id] of Object.entries(pass.outputs || {})) add(pass.id + ':output:' + slot, id);
    }
    for (const id of backend.textures?.keys?.() || []) {
        if (/points_trail|global_o0|node_\\d+_out|_selfTex/.test(id)) {
            add('texture:' + id, id);
        }
    }

    const textures = [];
    const seen = new Set();
    for (const [label, id] of candidates) {
        if (seen.has(label)) continue;
        seen.add(label);
        try {
            const px = await backend.readPixels(id);
            if (px.width < 128 || px.height < 128) continue;
            textures.push({ label, id, ...mirrorStatsPixels(px) });
        } catch (err) {
            textures.push({ label, id, error: err?.message || String(err) });
        }
    }

    return {
        frame: pipeline.frameIndex,
        renderedFrames: window.spawnpointWgslFrame,
        passes: (pipeline.graph?.passes || []).map((pass) => ({
            id: pass.id,
            program: pass.program,
            inputs: pass.inputs,
            outputs: pass.outputs
        })),
        textures
    };
};
</script>`
}

function startServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        if (url.pathname === '/spawnpoint.html') {
            res.writeHead(200, {
                'content-type': 'text/html',
                'cache-control': 'no-store'
            })
            res.end(html())
            return
        }

        const file = path.normalize(path.join(repoRoot, decodeURIComponent(url.pathname)))
        if (!file.startsWith(repoRoot)) {
            res.writeHead(403)
            res.end('forbidden')
            return
        }

        fs.stat(file, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404)
                res.end('not found')
                return
            }
            res.writeHead(200, {
                'content-type': contentType(file),
                'cache-control': 'no-store'
            })
            fs.createReadStream(file).pipe(res)
        })
    })

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function meanSquaredError(a, b) {
    assert.equal(a.width, b.width)
    assert.equal(a.height, b.height)
    let sum = 0
    let n = 0
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const i = (y * a.width + x) * 4
            for (let channel = 0; channel < 3; channel++) {
                const diff = a.data[i + channel] - b.data[i + channel]
                sum += diff * diff
                n++
            }
        }
    }
    return sum / n
}

function mirrorRatio(png, axis) {
    let width
    let height
    let first
    let mirrored
    let direct

    if (axis === 'horizontal') {
        width = png.width
        height = Math.floor(png.height / 2)
        first = new PNG({ width, height })
        mirrored = new PNG({ width, height })
        direct = new PNG({ width, height })
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dst = (y * width + x) * 4
                const top = (y * png.width + x) * 4
                const bottomDirect = ((png.height - height + y) * png.width + x) * 4
                const bottomMirrored = ((png.height - 1 - y) * png.width + x) * 4
                first.data.set(png.data.subarray(top, top + 4), dst)
                direct.data.set(png.data.subarray(bottomDirect, bottomDirect + 4), dst)
                mirrored.data.set(png.data.subarray(bottomMirrored, bottomMirrored + 4), dst)
            }
        }
    } else {
        width = Math.floor(png.width / 2)
        height = png.height
        first = new PNG({ width, height })
        mirrored = new PNG({ width, height })
        direct = new PNG({ width, height })
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dst = (y * width + x) * 4
                const left = (y * png.width + x) * 4
                const rightDirect = (y * png.width + (png.width - width + x)) * 4
                const rightMirrored = (y * png.width + (png.width - 1 - x)) * 4
                first.data.set(png.data.subarray(left, left + 4), dst)
                direct.data.set(png.data.subarray(rightDirect, rightDirect + 4), dst)
                mirrored.data.set(png.data.subarray(rightMirrored, rightMirrored + 4), dst)
            }
        }
    }

    return meanSquaredError(first, mirrored) / meanSquaredError(first, direct)
}

// A blank frame makes both mean-squared-error terms zero, so every ratio comes
// out NaN and every `< 0.49` comparison is false -- i.e. a dead render would
// report "not mirrored" and pass. Carry the variance so the caller can reject
// that case explicitly.
function frameVariance(png) {
    let sum = 0
    let sumSq = 0
    let n = 0
    for (let i = 0; i < png.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = png.data[i + c]
            sum += v
            sumSq += v * v
            n++
        }
    }
    if (n === 0) return 0
    const mean = sum / n
    return sumSq / n - mean * mean
}

function mirrorStats(png) {
    const horizontalRatio = mirrorRatio(png, 'horizontal')
    const verticalRatio = mirrorRatio(png, 'vertical')
    const mirrored = horizontalRatio < 0.49 && (verticalRatio - horizontalRatio) > 0.05
    return { horizontalRatio, verticalRatio, mirrored, variance: frameVariance(png) }
}

function mirrorMessage(stats, source) {
    return `WGSL vertical mirroring detected for provided spawnpoint program.
horizontalRatio=${stats.horizontalRatio.toFixed(3)}
verticalRatio=${stats.verticalRatio.toFixed(3)}
screenshot=${source}`
}

function analyzeImageFile(file) {
    const png = PNG.sync.read(fs.readFileSync(file))
    return mirrorStats(png)
}

function runImageMode(mode, file) {
    assert.ok(file, `${mode} requires a PNG path`)
    const source = path.resolve(file)
    const stats = analyzeImageFile(source)

    if (mode === '--expect-mirrored') {
        assert.equal(stats.mirrored, true, `expected detector to catch vertical mirroring.
horizontalRatio=${stats.horizontalRatio.toFixed(3)}
verticalRatio=${stats.verticalRatio.toFixed(3)}
screenshot=${source}`)
        console.log(`PASS: detector caught vertical mirroring in ${source}`)
        console.log(`horizontalRatio=${stats.horizontalRatio.toFixed(3)}`)
        console.log(`verticalRatio=${stats.verticalRatio.toFixed(3)}`)
        return
    }

    assert.equal(stats.mirrored, false, mirrorMessage(stats, source))
    console.log(`PASS: no vertical mirroring detected in ${source}`)
    console.log(`horizontalRatio=${stats.horizontalRatio.toFixed(3)}`)
    console.log(`verticalRatio=${stats.verticalRatio.toFixed(3)}`)
}

async function main() {
    const { chromium } = await import('playwright')
    const useAccumulation = hasArg('--accumulate')
    const diagnoseTextures = hasArg('--diagnose-textures')
    const useWebGL = hasArg('--webgl')
    const frameCount = Number.parseInt(argValue('--frames', '3600'), 10)
    const chunkSize = Number.parseInt(argValue('--chunk', '300'), 10)
    const dsl = useAccumulation ? withMotionBlurAccumulator(BASE_DSL) : BASE_DSL
    const expectedBackend = useWebGL ? 'WebGL2' : 'WebGPU'

    const server = await startServer()
    const port = server.address().port
    // Headed: the headless adapter exposes the default
    // maxColorAttachmentBytesPerSample of 32, and this pipeline's G-buffer
    // needs 40 (RGBA32F + RGBA32F + RGBA8). Running headless fails validation
    // rather than exercising the mirror behaviour under test.
    const browser = await chromium.launch({
        headless: false,
        args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features']
    })

    try {
        const page = await browser.newPage({
            viewport: { width: 1024, height: 1024 },
            deviceScaleFactor: 1
        })
        const errors = []
        page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text())
        })
        page.on('pageerror', (error) => errors.push(error.stack || error.message))

        await page.goto(`http://127.0.0.1:${port}/spawnpoint.html`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        })
        await page.waitForFunction(() => !!window.initSpawnpointWgsl, null, { timeout: 30000 })

        const result = await page.evaluate(
            ({ dsl, preferWebGPU }) => window.initSpawnpointWgsl(dsl, preferWebGPU),
            { dsl, preferWebGPU: !useWebGL }
        )
        assert.equal(result.ok, true, result.json || result.message || 'WGSL render failed')
        assert.equal(result.backend, expectedBackend, `expected ${expectedBackend} backend, got ${result.backend}`)
        assert.deepEqual(result.effects, expectedEffects(useAccumulation))
        assert.equal(result.blits, 1, 'provided program must contain exactly one write(o0) blit')
        assert.deepEqual(errors, [], `browser errors: ${errors.join('\n')}`)

        for (let rendered = 0; rendered < frameCount; rendered += chunkSize) {
            const framesThisChunk = Math.min(chunkSize, frameCount - rendered)
            const chunk = await page.evaluate((frames) => window.renderSpawnpointWgslChunk(frames), framesThisChunk)
            assert.equal(chunk.ok, true, chunk.json || chunk.message || 'WGSL render chunk failed')
        }

        await page.waitForTimeout(250)
        const screenshot = await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: 1024, height: 1024 },
            timeout: 60000
        })
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.join(
            outDir,
            useAccumulation
                ? `spawnpoint-${expectedBackend.toLowerCase()}-motionblur-${frameCount}f.png`
                : `spawnpoint-${expectedBackend.toLowerCase()}-${frameCount}f.png`
        )
        fs.writeFileSync(file, screenshot)

        const png = PNG.sync.read(screenshot)
        const stats = mirrorStats(png)

        if (diagnoseTextures) {
            const textureStats = await page.evaluate(() => window.dumpSpawnpointWgslTextureStats())
            console.log(JSON.stringify({
                screenshot: file,
                screenshotStats: stats,
                ...textureStats
            }, null, 2))
            return
        }

        // A device-lost or crashed render during the frame loop would otherwise
        // reach the mirror check as a blank frame and silently pass.
        assert.deepEqual(errors, [], `browser errors during render: ${errors.join('\n')}`)
        assert.ok(
            stats.variance > 1,
            `render produced a blank frame (variance ${stats.variance.toFixed(4)}); ${file}`
        )

        assert.equal(
            stats.mirrored,
            false,
            mirrorMessage(stats, file)
        )

        console.log(`PASS: provided spawnpoint WGSL output is not vertically mirrored after ${frameCount} frames`)
    } finally {
        await browser.close()
        await new Promise((resolve) => server.close(resolve))
    }
}

const [mode, file] = process.argv.slice(2)
if (mode === '--analyze-image' || mode === '--expect-mirrored') {
    try {
        runImageMode(mode, file)
    } catch (error) {
        console.error(error)
        process.exit(1)
    }
} else {
    main().catch((error) => {
        console.error(error)
        process.exit(1)
    })
}
