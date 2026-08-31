#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import {
    comparePixelFrames,
    computeFileHash,
    computeParitySourceHash,
    effectDirectory,
    matchesTargetEffectPass,
    PARITY_ATTESTATION_SCHEMA_VERSION,
    validateFrameEvidence,
    validateParityCase,
} from './lib/shader-parity-attestation.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const effectId = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const shouldWrite = process.argv.includes('--write')

if (!effectId) {
    console.error('Usage: node scripts/attest-shader-parity.mjs <namespace/effect> [--write]')
    process.exit(2)
}

const effectDir = effectDirectory(repoRoot, effectId)
const casePath = path.join(effectDir, 'parity-case.json')
const attestationPath = path.join(effectDir, 'parity-attestation.json')

if (!fs.existsSync(casePath)) {
    throw new Error(`${effectId} has no parity-case.json`)
}

const parityCase = JSON.parse(fs.readFileSync(casePath, 'utf8'))
const caseErrors = validateParityCase(parityCase, effectId)
if (caseErrors.length > 0) throw new Error(`Invalid parity case: ${caseErrors.join('; ')}`)
const resolution = parityCase.resolution

async function renderBackend(browser, baseUrl, preferWebGPU) {
    const [width, height] = resolution
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
await renderer.loadEffects(${JSON.stringify(parityCase.effects)});
await renderer.compile(${JSON.stringify(parityCase.dsl)});
renderer.stop();
renderer.render(0);
renderer.render(0);
await renderer.pipeline.backend.device?.queue?.onSubmittedWorkDone?.();
const surface = renderer.pipeline.surfaces.get(${JSON.stringify(parityCase.surface || 'o0')});
const matchesTargetEffectPass = ${matchesTargetEffectPass.toString()};
const candidates = [surface?.read, surface?.write].filter(Boolean);
let capture = null;
for (const id of candidates) {
    try {
        const pixels = await renderer.pipeline.backend.readPixels(id);
        if (!pixels?.data) continue;
        let nonzeroRgbPixels = 0;
        let nonzeroAlphaPixels = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.data.length; i += 4) {
            if (pixels.data[i] || pixels.data[i + 1] || pixels.data[i + 2]) nonzeroRgbPixels++;
            if (pixels.data[i + 3]) nonzeroAlphaPixels++;
            colors.add(pixels.data[i] + ',' + pixels.data[i + 1] + ',' + pixels.data[i + 2]);
        }
        if (!capture || nonzeroRgbPixels > capture.nonzeroRgbPixels) {
            capture = {
                id,
                width: pixels.width,
                height: pixels.height,
                nonzeroRgbPixels,
                nonzeroAlphaPixels,
                uniqueColors: colors.size,
                data: Array.from(pixels.data)
            };
        }
    } catch {}
}
window.parityResult = {
    backend: renderer.pipeline.backend.getName(),
    targetPassCount: renderer.pipeline.graph.passes.filter((pass) =>
        matchesTargetEffectPass(pass, ${JSON.stringify(effectId)})
    ).length,
    capture
};
</script>`, { waitUntil: 'load' })
        await page.waitForFunction(() => window.parityResult, null, { timeout: 30000 })
        const result = await page.evaluate(() => window.parityResult)
        const expectedBackend = preferWebGPU ? 'WebGPU' : 'WebGL2'
        assert.equal(result.backend, expectedBackend, `expected ${expectedBackend}, got ${result.backend}`)
        assert.ok(result.targetPassCount > 0, `${expectedBackend} graph did not execute ${effectId}`)
        assert.ok(result.capture, `${expectedBackend} produced no readable output`)
        assert.deepEqual(consoleMessages, [], `${expectedBackend} console errors:\n${consoleMessages.join('\n')}`)
        return result
    } finally {
        await page.close()
    }
}

const effectsDir = path.join(repoRoot, 'shaders/effects')
process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot
const { acquireServer, releaseServer } = await import('../vendor/shade-mcp/harness/index.js')
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
    const webglResult = await renderBackend(browser, baseUrl, false)
    const webgpuResult = await renderBackend(browser, baseUrl, true)
    const webgl = webglResult.capture
    const webgpu = webgpuResult.capture
    const frames = {
        webgl2: {
            width: webgl.width,
            height: webgl.height,
            nonzeroRgbPixels: webgl.nonzeroRgbPixels,
            nonzeroAlphaPixels: webgl.nonzeroAlphaPixels,
            uniqueColors: webgl.uniqueColors,
        },
        webgpu: {
            width: webgpu.width,
            height: webgpu.height,
            nonzeroRgbPixels: webgpu.nonzeroRgbPixels,
            nonzeroAlphaPixels: webgpu.nonzeroAlphaPixels,
            uniqueColors: webgpu.uniqueColors,
        },
    }
    const execution = {
        webgl2TargetPasses: webglResult.targetPassCount,
        webgpuTargetPasses: webgpuResult.targetPassCount,
    }

    const frameErrors = validateFrameEvidence(frames, parityCase.requireColorVariation === true)
    if (frameErrors.length > 0) {
        throw new Error(`EMPTY FRAME GATE FAILED: ${frameErrors.join('; ')}`)
    }

    const parity = comparePixelFrames(webgl, webgpu)
    if (parity.mismatchCount !== 0 || parity.maxDiff !== 0) {
        throw new Error(`PIXEL PARITY FAILED: ${JSON.stringify(parity)}`)
    }

    const attestation = {
        schemaVersion: PARITY_ATTESTATION_SCHEMA_VERSION,
        effect: effectId,
        sourceHash: computeParitySourceHash(repoRoot, parityCase),
        caseHash: computeFileHash(casePath),
        resolution,
        frames,
        execution,
        parity,
    }

    if (shouldWrite) {
        fs.writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`)
        console.log(`Wrote ${path.relative(repoRoot, attestationPath)}`)
    } else {
        process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`)
    }
} finally {
    if (browser) await browser.close()
    releaseServer()
}
