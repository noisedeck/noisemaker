#!/usr/bin/env node
/*
 * Regression test: a WebGL context loss must not permanently disable
 * single-frame rendering across backend switches.
 *
 * Before the fix, the webglcontextlost handler set _isContextLost = true and
 * stopped the render loop. switchBackend() then replaced the canvas element,
 * so the webglcontextrestored event that clears the flag could never fire.
 * Result: CanvasRenderer.render(t) — the path exports use — silently no-ops
 * forever on every backend (the rAF loop is unguarded, so the live view still
 * works), and only a page reload recovers. Downstream symptom: exports come
 * out black after switching to WGSL, and stay black after switching back.
 *
 * The fix: resetCanvas() clears _isContextLost (the lost context belonged to
 * the discarded canvas), and compile() restarts the loop when the stop came
 * from a context loss.
 *
 * Usage: node shaders/tests/test_context_loss_backend_switch.mjs
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

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
    process.exit(code)
}

process.on('SIGINT', () => { shutdownAndExit(130) })
process.on('SIGTERM', () => { shutdownAndExit(143) })
process.on('exit', () => {
    try { activeBrowser?.close() } catch { /* already closed */ }
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const EFFECTS_DIR = path.join(PROJECT_ROOT, 'shaders', 'effects')

process.env.SHADE_EFFECTS_DIR = EFFECTS_DIR
process.env.SHADE_PROJECT_ROOT = PROJECT_ROOT
process.env.SHADE_GLOBALS_PREFIX = '__noisemaker'

import { acquireServer } from '../../vendor/shade-mcp/harness/index.js'

const RENDER_SETTLE_MS = 1500

async function sampleCanvas(page) {
    // toBlob → ImageBitmap → 2D readback works for both WebGL2 and WebGPU
    // canvases (drawImage from a WebGPU canvas reads back blank).
    return page.evaluate(async () => {
        const canvas = document.querySelector('canvas')
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
        if (!blob) return { max: 0, error: 'toBlob returned null' }
        const bitmap = await createImageBitmap(blob)
        const copy = document.createElement('canvas')
        copy.width = bitmap.width
        copy.height = bitmap.height
        const ctx = copy.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const data = ctx.getImageData(0, 0, copy.width, copy.height).data
        let max = 0
        for (let i = 0; i < data.length; i += 4 * 7) {
            const m = Math.max(data[i], data[i + 1], data[i + 2])
            if (m > max) max = m
        }
        return { max }
    })
}

async function rendererState(page) {
    return page.evaluate(() => {
        const r = window.__noisemakerCanvasRenderer
        return {
            isContextLost: r._isContextLost,
            isRunning: r._isRunning,
            hasPipeline: !!r._pipeline,
            backend: r.backend,
        }
    })
}

async function switchAndRecompile(page, backend) {
    await page.evaluate(async (target) => {
        const r = window.__noisemakerCanvasRenderer
        await r.switchBackend(target)
        await r.compile(r._currentDsl)
    }, backend)
}

async function singleShotRender(page) {
    // What export loops do: stop the loop, render one frame at a fixed time.
    await page.evaluate(async () => {
        const r = window.__noisemakerCanvasRenderer
        r.stop()
        r.render(0.25)
        await new Promise(resolve => requestAnimationFrame(resolve))
        const queue = r._pipeline?.backend?.device?.queue
        if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone()
    })
}

async function main() {
    const baseUrl = await acquireServer(undefined, PROJECT_ROOT, EFFECTS_DIR)
    const args = [
        '--disable-gpu-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--enable-webgpu-developer-features',
        process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=vulkan',
    ]
    const browser = await chromium.launch({ headless: true, args })
    activeBrowser = browser
    const context = await browser.newContext({ viewport: { width: 512, height: 512 } })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)

    const errors = []
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`))

    let failed = false
    const check = (cond, label) => {
        console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`)
        if (!cond) failed = true
    }

    try {
        await page.goto(`${baseUrl}/demo/shaders/?effect=synth/noise`, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => window.__noisemakerRenderingPipeline != null, { polling: 50 })
        await page.waitForTimeout(RENDER_SETTLE_MS)

        const gpu = await page.evaluate(async () => {
            if (!navigator.gpu) return false
            return !!(await navigator.gpu.requestAdapter().catch(() => null))
        })
        if (!gpu) {
            console.log('SKIP: no WebGPU adapter available in this browser build')
            return
        }

        const baseline = await sampleCanvas(page)
        check(baseline.max > 16, `baseline glsl render is non-black (max=${baseline.max})`)

        // Simulate the context loss firing while the handler is attached —
        // exactly what happens on synchronous loseContext() dispatch or a
        // GPU-pressure eviction just before/during a backend switch.
        await page.evaluate(() => {
            document.querySelector('canvas')
                .dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
        })
        const lost = await rendererState(page)
        check(lost.isContextLost === true, 'context-loss handler engaged (precondition)')

        await switchAndRecompile(page, 'wgsl')
        await page.waitForTimeout(RENDER_SETTLE_MS)
        const wgslState = await rendererState(page)
        check(wgslState.isContextLost === false, 'switch to wgsl clears context-loss state')
        check(wgslState.isRunning === true, 'render loop resumes after wgsl recompile')

        await singleShotRender(page)
        const wgslSample = await sampleCanvas(page)
        check(wgslSample.max > 16, `single-shot wgsl render is non-black (max=${wgslSample.max})`)
        await page.evaluate(() => window.__noisemakerCanvasRenderer.start())

        await switchAndRecompile(page, 'glsl')
        await page.waitForTimeout(RENDER_SETTLE_MS)
        const glslState = await rendererState(page)
        check(glslState.isContextLost === false, 'switch back to glsl keeps context-loss state clear')
        check(glslState.isRunning === true, 'render loop runs after switching back')

        await singleShotRender(page)
        const glslSample = await sampleCanvas(page)
        check(glslSample.max > 16, `single-shot glsl render is non-black after round-trip (max=${glslSample.max})`)
    } finally {
        await browser.close()
    }

    if (errors.length) {
        console.log('\nPage errors:')
        for (const e of errors) console.log(`  ${e}`)
    }

    if (failed) process.exit(1)
    console.log('\nAll context-loss backend-switch checks passed')
    process.exit(0)
}

main().catch(err => {
    console.error(err)
    process.exit(2)
})
