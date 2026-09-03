// Smoke test: walks every define-flagged param on each effect-under-test
// through every legal value via the ProgramState test hook and verifies each
// recompile produces a valid program (no link/compile errors).
//
// Coverage model: parameters are walked sequentially (additive), not
// Cartesian-product. Each setValue swaps one knob against the cumulative
// state, so a typo in any single `#elif MACRO == N` branch is caught by the
// pass over that param's value list. Cross-variant interactions (e.g.
// COLOR_MODE=4 × LOOP_OFFSET=210) are not exercised — add those manually if
// a regression appears that needs full-matrix coverage.
//
// Replaces the older test-noise-variants.mjs which only covered
// classicNoisedeck/noise.
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// An interrupted run must not leave the browser process tree behind:
// Playwright's own SIGTERM handler closes its browsers but never exits, and
// its SIGINT handler races this test's teardown. These close what this test
// owns and then exit. The 'exit' listener is the last-resort fallback for the
// process.exit() paths below, where only synchronous work still runs.
let activeContext = null
let shuttingDown = false

async function shutdownAndExit(code) {
    if (shuttingDown) return
    shuttingDown = true
    const context = activeContext
    activeContext = null
    try {
        await context?.close()
    } catch {
        // Already closed.
    }
    try {
        releaseServer()
    } catch {
        // Server already released.
    }
    process.exit(code)
}

process.on('SIGINT', () => { shutdownAndExit(130) })
process.on('SIGTERM', () => { shutdownAndExit(143) })
process.on('exit', () => {
    try { activeContext?.close() } catch { /* already closed */ }
    try { releaseServer() } catch { /* already released */ }
})

// Portable and self-contained: start the repo's own static harness server and
// drive playwright's bundled Chromium headless with a platform-appropriate
// ANGLE backend. No machine-specific browser path and no externally-started
// server -- this runs for any contributor on macOS, Linux, or Windows.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const effectsDir = join(repoRoot, 'shaders/effects')
process.env.SHADE_EFFECTS_DIR = effectsDir
process.env.SHADE_PROJECT_ROOT = repoRoot
const { acquireServer, releaseServer } = await import(join(repoRoot, 'vendor/shade-mcp/harness/index.js'))
const baseUrl = await acquireServer(undefined, repoRoot, effectsDir)
const VIEWER_BASE = `${baseUrl}/demo/shaders/`

// Each entry: { effect: 'namespace.func', variants: [{ param, values }, ...] }
const SUITES = [
    {
        effect: 'classicNoisedeck.noise',
        variants: [
            { param: 'colorMode', values: [0, 1, 2, 3, 4, 6] },
            { param: 'refractMode', values: [0, 1, 2] },
            { param: 'loopOffset', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 200, 210, 300, 400, 410] },
            { param: 'metric', values: [0, 1, 2, 3, 4, 5] },
            { param: 'type', values: [0, 1, 2, 3, 4, 5, 6, 10, 11] },
        ],
    },
    {
        effect: 'synth.noise',
        variants: [
            { param: 'loopOffset', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 200, 210, 300, 400, 410] },
            { param: 'type', values: [0, 1, 2, 3, 4, 5, 6, 10, 11] },
        ],
    },
    {
        effect: 'classicNoisedeck.effects',
        variants: [
            // every effect kernel: 0/100/110/200/210/220/230 + convolution kernels
            { param: 'effect', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100, 110, 120, 200, 210, 220, 230, 300, 301] },
            { param: 'flip', values: [0, 1, 2, 3, 11, 12, 13, 14, 15, 16, 17, 18] },
        ],
    },
    {
        effect: 'classicNoisedeck.shapes3d',
        variants: [
            { param: 'shapeA', values: [10, 20, 30, 31, 40, 50, 60, 70, 80] },
            { param: 'shapeB', values: [10, 20, 30, 31, 40, 50, 60, 70, 80] },
            { param: 'blendMode', values: [10, 20, 25, 26, 30, 40, 50, 51] },
        ],
    },
    {
        effect: 'classicNoisedeck.cellRefract',
        variants: [
            { param: 'shape', values: [0, 1, 2, 3, 4, 6] },
            { param: 'kernel', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100, 110, 120] },
        ],
    },
    {
        effect: 'classicNoisedeck.moodscape',
        variants: [
            { param: 'colorMode', values: [0, 1, 2, 3] },
            // moodscape's noise type is exposed as `interp` in its definition
            { param: 'interp', values: [0, 1, 2, 3, 4, 5, 6, 10, 11] },
        ],
    },
    {
        effect: 'classicNoisedeck.bitEffects',
        // Coverage note: this walk is additive, not product. `mode` flips to 1
        // in the first sub-walk, and the subsequent FORMULA/COLOR_SCHEME/INTERP
        // iterations all run with mode stuck at 1 (the last value in its
        // list). That still exercises every #elif branch in those cascades for
        // compile-correctness because bitField() and bitValue() live at file
        // scope — the GLSL preprocessor selects and compiles the chosen FORMULA
        // branch regardless of MODE, so the body is reachable by the compiler
        // even if it's dead at runtime. Same reasoning in reverse for
        // MASK_FORMULA/MASK_COLOR_SCHEME landing under mode=1 (the live half).
        // If you reorder this list, preserve that invariant or add an explicit
        // mode reset between the two halves.
        variants: [
            // mode picks bitField (0) vs bitMask (1) — the outer MODE split
            { param: 'mode', values: [0, 1] },
            // MODE==0 path: formula (6), colorScheme (15), interp (2)
            { param: 'formula', values: [0, 1, 2, 3, 4, 5] },
            { param: 'colorScheme', values: [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20] },
            { param: 'interp', values: [0, 1] },
            // MODE==1 path: maskFormula (4), maskColorScheme (4)
            { param: 'maskFormula', values: [10, 11, 20, 30] },
            { param: 'maskColorScheme', values: [0, 1, 2, 3] },
        ],
    },
    {
        effect: 'classicNoisedeck.kaleido',
        variants: [
            { param: 'metric', values: [0, 1, 2, 3, 4, 5] },
            { param: 'direction', values: [0, 1, 2] },
            // kernel: all 12 convolution kernels used by kaleido
            { param: 'kernel', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 110, 120] },
            // loopOffset sample across shapes, directional, all 9 noise variants, rings/sine
            { param: 'loopOffset', values: [10, 30, 60, 200, 300, 310, 320, 330, 340, 350, 360, 370, 380, 400, 410] },
        ],
    },
    {
        effect: 'synth.curl',
        variants: [
            { param: 'octaves', values: [1, 2, 3] },
            { param: 'ridges', values: [false, true] },
            { param: 'outputMode', values: [0, 1, 2, 3, 4] },
        ],
    },
    {
        effect: 'filter.texture',
        // Texture has five relief surfaces and ten material-noise kernels baked
        // into the shader via MODE. Exercise every compile-time branch.
        variants: [
            { param: 'mode', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
        ],
    },
    {
        effect: 'filter3d.flow3d',
        // BEHAVIOR drives the computeRotationBias dispatch in the agent pass.
        // All 7 legal behavior values (0=none, 1=obedient, 2=crosshatch,
        // 3=unruly, 4=chaotic, 5=randomMix, 10=meandering) get their own
        // compiled program.
        variants: [
            { param: 'behavior', values: [0, 1, 2, 3, 4, 5, 10] },
        ],
    },
]

async function main() {
    const userDataDir = mkdtempSync(join(tmpdir(), 'noisemaker-variants-'))
    const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
            process.platform === 'darwin' ? '--use-angle=metal'
                : process.platform === 'win32' ? '--use-angle=d3d11'
                    : '--use-angle=vulkan'],
    })
    activeContext = ctx
    const page = ctx.pages()[0] || (await ctx.newPage())

    let totalChecks = 0
    let totalFailures = 0
    let suiteFailures = 0

    for (const suite of SUITES) {
        const errors = []
        const errorListener = msg => {
            if (msg.type() === 'error') errors.push(msg.text())
        }
        const pageErrorListener = err => errors.push(`pageerror: ${err.message}`)

        page.on('console', errorListener)
        page.on('pageerror', pageErrorListener)

        const url = `${VIEWER_BASE}?backend=glsl&effect=${encodeURIComponent(suite.effect)}`
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
            await page.waitForFunction(() => window.__noisemakerProgramState != null, { timeout: 25000 })
            await page.waitForFunction(() => window.__noisemakerRenderingPipeline != null, { timeout: 25000 })
        } catch (e) {
            console.log(`\n[${suite.effect}] FAIL on initial load: ${e.message.split('\n')[0]}`)
            suiteFailures++
            page.off('console', errorListener)
            page.off('pageerror', pageErrorListener)
            continue
        }

        console.log(`\n[${suite.effect}] initial load OK`)

        let suiteChecks = 0
        let suiteOk = 0
        for (const { param, values } of suite.variants) {
            for (const v of values) {
                const errorsBefore = errors.length
                await page.evaluate(({ p, val }) => {
                    const ps = window.__noisemakerProgramState
                    const stepKey = ps.getStepKeys()[0]
                    ps.setValue(stepKey, p, val)
                }, { p: param, val: v })
                await page.waitForTimeout(400)
                const newErrors = errors.slice(errorsBefore).filter(e => !/passive event/i.test(e))
                totalChecks++
                suiteChecks++
                if (newErrors.length > 0) {
                    totalFailures++
                    console.log(`  FAIL ${param}=${v}: ${newErrors[0].slice(0, 200)}`)
                } else {
                    suiteOk++
                    console.log(`    ok ${param}=${v}`)
                }
            }
        }
        console.log(`[${suite.effect}] ${suiteOk}/${suiteChecks} variants OK`)

        page.off('console', errorListener)
        page.off('pageerror', pageErrorListener)
    }

    console.log(`\n=== TOTAL: ${totalChecks - totalFailures}/${totalChecks} variants OK across ${SUITES.length} effects ===`)
    if (suiteFailures > 0) {
        console.log(`(${suiteFailures} suite(s) failed to load and were skipped)`)
    }
    await ctx.close()
    try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    return totalFailures > 0 || suiteFailures > 0
}

main()
    .then(async (failed) => { await releaseServer(); process.exit(failed ? 1 : 0) })
    .catch(async (e) => { console.error(e); await releaseServer(); process.exit(1) })
