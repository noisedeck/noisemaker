// test-define-recompile.mjs
//
// One-shot integration test: load synth/noise in the demo viewer, change the
// `type` dropdown (a `define: NOISE_TYPE` global), and verify that a new
// program with a `__NOISE_TYPE_<value>` cache key suffix gets compiled.
//
// This is the regression check for the program-state recompileNeeded wiring —
// without it, mutating a compile-time-define-flagged global only writes a
// runtime uniform (which the shader doesn't read), and the new variant is
// never built.
//
// Portable and self-contained: starts the repo's own static harness server and
// drives playwright's bundled Chromium headless with a platform-appropriate
// ANGLE backend. No machine-specific browser path and no externally-started
// server -- this runs for any contributor on macOS, Linux, or Windows.
//
// Usage:
//   node shaders/tests/test-define-recompile.mjs
//   node shaders/tests/test-define-recompile.mjs --backend wgsl

import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const effectsDir = join(repoRoot, 'shaders/effects')
process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot
const { acquireServer, releaseServer } = await import(join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
const VIEWER_BASE = `${baseUrl}/demo/shaders/`

const NAV_TIMEOUT_MS = 20_000
const PIPELINE_TIMEOUT_MS = 30_000

function arg(name, def = null) {
    const i = process.argv.indexOf(`--${name}`)
    if (i < 0) return def
    return process.argv[i + 1] ?? true
}

const backend = arg('backend', 'glsl')

// Snapshot the backend's compiled program cache keys. Variant compilation is
// observable here directly; the old [compile-...] console tracing this test
// used to scrape was removed in 6c1e27cd.
const programKeys = (page) => page.evaluate(() => {
    const pipeline = window.__noisemakerRenderingPipeline
    const programs = pipeline?.backend?.programs
    return programs ? Array.from(programs.keys()) : []
})

async function main() {
    const userDataDir = mkdtempSync(join(tmpdir(), 'noisemaker-define-recompile-'))
    console.log(`backend=${backend}  userDataDir=${userDataDir}`)

    const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
            process.platform === 'darwin' ? '--use-angle=metal'
                : process.platform === 'win32' ? '--use-angle=d3d11'
                    : '--use-angle=vulkan'],
    })

    const page = ctx.pages()[0] || (await ctx.newPage())

    const errors = []
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`))

    const url = `${VIEWER_BASE}?backend=${backend}&effect=${encodeURIComponent('synth.noise')}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForFunction(
        () => window.__noisemakerRenderingPipeline != null,
        { timeout: PIPELINE_TIMEOUT_MS, polling: 50 }
    )
    await page.waitForFunction(
        () => (window.__noisemakerRenderingPipeline?.backend?.programs?.size ?? 0) > 0,
        { timeout: PIPELINE_TIMEOUT_MS, polling: 50 }
    )

    let failed = false

    // The noise effect's `type` global has default=10 (simplex), so the initial
    // program key should carry `__NOISE_TYPE_10`.
    const initialKeys = await programKeys(page)
    console.log(`initial programs=${initialKeys.length}`)
    for (const k of initialKeys) console.log(`  ${k}`)
    if (!initialKeys.some(k => k.includes('__NOISE_TYPE_10'))) {
        console.log('\nFAIL: initial program key does not carry __NOISE_TYPE_10')
        failed = true
    }

    // Change the noise type via the ProgramState test hook. Going through the
    // state layer (rather than the custom-element dropdown) tests exactly the
    // wiring we care about: setValue on a `define:`-flagged param should
    // trigger a recompile.
    await page.evaluate(() => {
        const ps = window.__noisemakerProgramState
        if (!ps) throw new Error('window.__noisemakerProgramState not set')
        // Pick a value different from the default 10. constant=0 in the choices.
        ps.setValue('step_0', 'type', 0)
    })
    await page.waitForTimeout(2000)

    const afterDefine = await programKeys(page)
    const newVariants = afterDefine.filter(k => !initialKeys.includes(k))
    console.log(`\nnew programs after define change=${newVariants.length}`)
    for (const k of newVariants) console.log(`  ${k}`)

    if (!newVariants.some(k => k.includes('__NOISE_TYPE_0'))) {
        console.log('\nFAIL: noise type change did not trigger a recompile of the new variant')
        failed = true
    }

    // Negative case: changing a regular runtime uniform must NOT trigger a
    // recompile. `octaves` is a real noise global with no `define:` flag, so
    // after bumping it no new program key should appear.
    await page.evaluate(() => {
        window.__noisemakerProgramState.setValue('step_0', 'octaves', 5)
    })
    await page.waitForTimeout(1000)

    const afterRuntime = await programKeys(page)
    const unexpected = afterRuntime.filter(k => !afterDefine.includes(k))
    if (unexpected.length > 0) {
        console.log(`\nFAIL: runtime uniform change triggered ${unexpected.length} unexpected compile(s):`)
        for (const k of unexpected) console.log(`  ${k}`)
        failed = true
    }

    if (errors.length > 0) {
        console.log('\nERRORS:')
        for (const e of errors) console.log(`  ${e}`)
        failed = true
    }

    await ctx.close()
    rmSync(userDataDir, { recursive: true, force: true })
    await releaseServer()

    if (failed) process.exit(1)
    console.log('\nPASS: noise type change recompiled new __NOISE_TYPE_0 variant')
    console.log('PASS: regular runtime uniform change did not trigger any recompile')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
