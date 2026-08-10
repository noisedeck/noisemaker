#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const newEffects = [
    'chrome', 'craquelure', 'directionalBlur', 'extrude', 'halftone',
    'hatch', 'highPass', 'lensFlare', 'median', 'morphology',
    'mosaicTiles', 'oilPaint', 'patchwork', 'photocopy', 'plasticWrap',
    'pondRipples', 'relief', 'scatter', 'spinBlur', 'stamp', 'stipple',
    'strokes', 'unsharpMask', 'watercolor', 'wind',
]
const extendedEffects = ['edge', 'emboss', 'grain', 'invert', 'lowPoly', 'texture']
const effectIds = [...newEffects, ...extendedEffects].map(name => `filter/${name}`)

const cases = []
const add = (label, call) => cases.push({ label, call })
for (const name of newEffects) add(`${name}/default`, `${name}()`)

for (const type of ['blocks', 'pyramids']) {
    for (const depthSource of ['luminance', 'random']) add(`extrude/${type}/${depthSource}`, `extrude(type: ${type}, depthSource: ${depthSource})`)
}
add('halftone/color/dot', 'halftone(mode: color, pattern: dot)')
for (const pattern of ['dot', 'line', 'circle']) add(`halftone/mono/${pattern}`, `halftone(mode: mono, pattern: ${pattern})`)
for (const mode of ['pen', 'charcoal', 'chalkCharcoal', 'conte', 'crosshatch', 'coloredPencil']) add(`hatch/${mode}`, `hatch(mode: ${mode}, direction: rightDiag)`)
add('hatch/leftDiag', 'hatch(mode: coloredPencil, direction: leftDiag)')
for (const lensType of ['zoom50_300', 'prime35', 'prime105', 'moviePrime']) add(`lensFlare/${lensType}`, `lensFlare(lensType: ${lensType}, centerX: 0.31, centerY: 0.67)`)
for (const mode of ['dilate', 'erode']) {
    for (const shape of ['square', 'round']) add(`morphology/${mode}/${shape}`, `morphology(mode: ${mode}, shape: ${shape})`)
}
for (const mode of ['mosaic', 'shifted']) add(`mosaicTiles/${mode}`, `mosaicTiles(mode: ${mode})`)
for (const mode of ['facet', 'daubs', 'dryBrush', 'fresco', 'knife', 'sponge']) add(`oilPaint/${mode}`, `oilPaint(mode: ${mode})`)
for (const style of ['aroundCenter', 'outFromCenter', 'pondRipples']) add(`pondRipples/${style}`, `pondRipples(style: ${style}, amount: 70)`)
add('pondRipples/repeat', 'pondRipples(style: pondRipples, wrap: repeat, amount: 70)')
add('pondRipples/clamp', 'pondRipples(style: pondRipples, wrap: clamp, amount: 70)')
for (const mode of ['basRelief', 'plaster', 'notePaper']) add(`relief/${mode}`, `relief(mode: ${mode}, lightAngle: 37)`)
for (const mode of ['normal', 'darkenOnly', 'lightenOnly', 'anisotropic', 'clumped']) add(`scatter/${mode}`, `scatter(mode: ${mode})`)
for (const mode of ['pointillize', 'mezzoDots', 'mezzoLines', 'mezzoStrokes', 'reticulation']) add(`stipple/${mode}`, `stipple(mode: ${mode})`)
for (const mode of ['angled', 'sprayed', 'dark', 'sumiE', 'smudge']) add(`strokes/${mode}`, `strokes(mode: ${mode})`)
for (const method of ['wind', 'blast', 'stagger']) {
    for (const direction of ['fromLeft', 'fromRight']) add(`wind/${method}/${direction}`, `wind(method: ${method}, direction: ${direction})`)
}
add('directionalBlur/angled', 'directionalBlur(angle: 37, distance: 75)')
add('plasticWrap/directed', 'plasticWrap(lightDirection: vec3(0.2, -0.4, 0.8))')
add('spinBlur/offCenter', 'spinBlur(amount: 30, centerX: 0.35, centerY: 0.3)')

add('edge/contour', 'edge(kernel: contour, contourSide: upper, invert: on)')
add('emboss/gray', 'emboss(style: gray, angle: 37, height: 4, colorAmount: 55)')
add('invert/solarize', 'invert(mode: solarize)')
for (const mode of ['flat', 'edges', 'distance2', 'distance3']) add(`lowPoly/${mode}`, `lowPoly(mode: ${mode})`)
for (const mode of ['regular', 'soft', 'sprinkles', 'clumped', 'contrasty', 'enlarged', 'stippled', 'horizontal', 'vertical', 'speckle']) add(`texture/${mode}`, `texture(mode: ${mode})`)

function dependencyValues(condition, globals) {
    if (!condition) return {}
    if (condition.and) return Object.assign({}, ...condition.and.map(item => dependencyValues(item, globals)))
    if (condition.or) return dependencyValues(condition.or[0], globals)
    const control = globals[condition.param]
    const choices = control?.choices ? Object.values(control.choices) : []
    if ('eq' in condition) return { [condition.param]: condition.eq }
    if ('neq' in condition) return { [condition.param]: choices.find(value => value !== condition.neq) ?? condition.neq + 1 }
    if ('in' in condition) return { [condition.param]: condition.in[0] }
    if ('notIn' in condition) return { [condition.param]: choices.find(value => !condition.notIn.includes(value)) ?? 0 }
    if ('gt' in condition) return { [condition.param]: choices.find(value => value > condition.gt) ?? condition.gt + 1 }
    throw new Error(`Unsupported enabledBy condition: ${JSON.stringify(condition)}`)
}

function formatValue(value, control) {
    if (control.choices) {
        const choice = Object.entries(control.choices).find(([, numeric]) => numeric === value)
        assert.ok(choice, `No choice label for ${value}`)
        return choice[0]
    }
    if (control.type === 'boolean') return value ? 'true' : 'false'
    if (control.type === 'color') return Array.isArray(value) ? `vec3(${value.join(', ')})` : value
    if (control.type === 'vec3') return `vec3(${value.join(', ')})`
    if (control.type === 'vec2') return `vec2(${value.join(', ')})`
    return String(value)
}

function alternateValue(name, control) {
    if (control.choices) {
        const values = Object.values(control.choices)
        return values.find(value => value !== control.default)
    }
    if (control.type === 'boolean') return !control.default
    if (control.type === 'color') return '#2aa6e0'
    if (control.type === 'vec3') return [0.2, -0.4, 0.8]
    if (control.type === 'vec2') return [0.23, 0.71]
    if (name.toLowerCase().includes('angle')) {
        return Math.min(control.max, Math.max(control.min, control.default + (control.max - control.min) * 0.23))
    }
    if (name === 'seed') return Math.min(control.max, control.default + 1)
    if (control.type === 'int') return control.default === control.max ? control.min : control.max
    return control.default === control.max
        ? control.min + (control.max - control.min) * 0.2
        : control.min + (control.max - control.min) * 0.83
}

function callWith(effect, values, globals) {
    const args = Object.entries(values).map(([name, value]) => `${name}: ${formatValue(value, globals[name])}`)
    return `${effect}(${args.join(', ')})`
}

const responsiveness = []
for (const effect of [...newEffects, ...extendedEffects]) {
    const definition = (await import(pathToFileURL(path.join(effectsDir, 'filter', effect, 'definition.js')))).default
    for (const [param, control] of Object.entries(definition.globals)) {
        const dependencies = dependencyValues(control.ui?.enabledBy, definition.globals)
        const baseValues = { ...dependencies, [param]: control.default }
        const changedValues = { ...dependencies, [param]: alternateValue(param, control) }
        if (effect === 'texture' && ['mode', 'alpha', 'scale'].includes(param)) {
            baseValues.mode = definition.globals.mode.choices.regular
            changedValues.mode = param === 'mode'
                ? definition.globals.mode.choices.soft
                : definition.globals.mode.choices.regular
        }
        if (effect === 'pondRipples' && param === 'wrap') {
            Object.assign(baseValues, { amount: 100, ridges: 7, style: definition.globals.style.choices.outFromCenter })
            Object.assign(changedValues, { amount: 100, ridges: 7, style: definition.globals.style.choices.outFromCenter })
        }
        const baseLabel = `control/${effect}/${param}/base`
        const changedLabel = `control/${effect}/${param}/changed`
        add(baseLabel, callWith(effect, baseValues, definition.globals))
        add(changedLabel, callWith(effect, changedValues, definition.globals))
        responsiveness.push({ effect, param, baseLabel, changedLabel })
    }
}

async function install(preferWebGPU) {
    const width = 96
    const height = 80
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
await renderer.loadEffects(${JSON.stringify(['synth/testPattern', ...effectIds])});
window.renderDsl=async(dsl)=>{await renderer.compile(dsl);renderer.stop();renderer.clearTileRegion();renderer.render(0.37);renderer.render(0.37);const queue=renderer.pipeline?.backend?.device?.queue;if(queue?.onSubmittedWorkDone)await queue.onSubmittedWorkDone();await new Promise(resolve=>requestAnimationFrame(resolve));return renderer.pipeline.backend.getName();};
</script>`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.renderDsl === 'function')
    return { page, errors }
}

function dsl(call = null) {
    const chain = call ? `\n  .${call}` : ''
    return `search synth, filter\n\ntestPattern(pattern: colorGrid, gridSize: 7)${chain}\n  .write(o0)\n\nrender(o0)`
}

async function capture(page) {
    const url = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'))
    return PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

function difference(a, b, tolerance = 1) {
    assert.equal(a.data.length, b.data.length)
    let max = 0
    let total = 0
    let changed = 0
    let count = 0
    for (let i = 0; i < a.data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            const delta = Math.abs(a.data[i + channel] - b.data[i + channel])
            max = Math.max(max, delta)
            total += delta
            changed += Number(delta > tolerance)
            count++
        }
    }
    return { max, mean: total / count, changedPercent: changed / count * 100 }
}

async function renderCases(preferWebGPU, expectedBackend) {
    const { page, errors } = await install(preferWebGPU)
    const frames = new Map()
    const render = async (source, label) => {
        const result = await page.evaluate(async program => {
            try {
                return { backend: await window.renderDsl(program) }
            } catch (error) {
                return { error: error?.message ?? String(error), stack: error?.stack ?? '' }
            }
        }, source)
        assert.equal(result.error, undefined, `${expectedBackend} ${label}: ${result.error}\n${result.stack}`)
        assert.equal(result.backend, expectedBackend, label)
    }
    try {
        await render(dsl(), 'source')
        frames.set('source', await capture(page))
        for (const item of cases) {
            await render(dsl(item.call), item.label)
            frames.set(item.label, await capture(page))
        }
        assert.deepEqual(errors, [], `${expectedBackend} emitted browser errors`)
        return frames
    } finally {
        await page.close()
    }
}

try {
    const gl = await renderCases(false, 'WebGL2')
    const gpu = await renderCases(true, 'WebGPU')
    // Cross-backend parity. Effects must render pixel-identically on WebGL2 and
    // WebGPU except for a negligible fraction of high-gradient pixels where FP
    // reassociation between the GLSL and WGSL compilers is genuinely unavoidable
    // -- e.g. pondRipples' animated ripple crests diverge by up to a few dozen
    // LSB on ~0.03% of channels at t=0.37, yet are bit-exact at t=0 in the
    // dedicated pond invariant test. We therefore fail when MORE THAN 0.1% of
    // channels differ by more than TOL LSB. That is 10x stricter than the
    // previous >=1% gate; unlike a bare max-diff check it cannot be defeated by
    // a lone FP-noise crest pixel (nor pass a real bug on a small area, since a
    // real per-mode/per-region mismatch spans far more than 0.1% of the frame).
    // Per-effect exactness is additionally pinned by the dedicated invariant
    // tests (Emboss/Grain/Pond/Stipple/Mosaic/Texture/... hashes).
    const TOL = 2, MAX_DIVERGENT_PERCENT = 0.1
    const parityFailures = []
    for (const { label } of cases) {
        const stats = difference(gl.get(label), gpu.get(label), TOL)
        console.log(`PARITY ${label.padEnd(34)} max=${String(stats.max).padStart(3)} mean=${stats.mean.toFixed(3)} >${TOL}LSB=${stats.changedPercent.toFixed(3)}%`)
        if (stats.changedPercent > MAX_DIVERGENT_PERCENT) {
            parityFailures.push(`${label}=max:${stats.max}, >${TOL}LSB:${stats.changedPercent.toFixed(3)}%`)
        }
    }
    assert.deepEqual(parityFailures, [], `Presented WebGL2/WebGPU parity failures: ${parityFailures.join(', ')}`)

    for (const backend of [['WebGL2', gl], ['WebGPU', gpu]]) {
        const [label, frames] = backend
        for (const name of newEffects) {
            const stats = difference(frames.get(`${name}/default`), frames.get('source'))
            console.log(`ACTIVE ${label.padEnd(7)} ${name.padEnd(18)} mean=${stats.mean.toFixed(3)} changed=${stats.changedPercent.toFixed(2)}%`)
            assert.ok(stats.changedPercent >= 1 && stats.mean >= 0.1,
                `${label} ${name} default is effectively pass-through: ${JSON.stringify(stats)}`)
        }
    }

    const responsivenessFailures = []
    for (const [backend, frames] of [['WebGL2', gl], ['WebGPU', gpu]]) {
        for (const item of responsiveness) {
            const stats = difference(frames.get(item.baseLabel), frames.get(item.changedLabel))
            if (stats.changedPercent < 0.05 || stats.mean < 0.01) {
                responsivenessFailures.push(`${backend} ${item.effect}.${item.param} ${JSON.stringify(stats)}`)
            }
        }
    }
    assert.deepEqual(responsivenessFailures, [],
        `Visually unresponsive controls:\n${responsivenessFailures.join('\n')}`)
    console.log(`Artistic release gate passed: ${cases.length} cross-backend cases, ${newEffects.length * 2} active-default checks, and ${responsiveness.length * 2} responsive-control checks`)
} finally {
    await browser.close()
    await releaseServer()
}
