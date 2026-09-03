/**
 * Effect-string localization tests.
 *
 *  1. Drift — the committed strings.en.json matches a fresh build
 *     (run `npm run strings` if this fails).
 *  2. Backward-compat — with no locale set, effect strings are unchanged
 *     English: getEffectDescription returns the manifest description, and
 *     localize() returns the caller's fallback.
 *  3. Localized — after setLocale(), strings resolve to the active locale,
 *     then the English base catalog, then the fallback. Resetting to no locale
 *     restores the unchanged-English behavior.
 *
 * The localizer is exercised on a real (headless) CanvasRenderer; fetch is
 * stubbed to serve catalogs, the same way the runtime fetches them from the CDN.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildCatalog } from '../scripts/generate-effect-strings.mjs'
import { CanvasRenderer } from '../src/renderer/canvas.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EFFECTS_DIR = join(__dirname, '..', 'effects')
const EN_PATH = join(EFFECTS_DIR, 'strings.en.json')
const TRANSLATED_LOCALES = ['de', 'es', 'fr', 'it', 'ja', 'pt']

let failed = false
async function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
        await fn()
        console.log(`PASS: ${name}`)
    } catch (error) {
        failed = true
        console.error(`FAIL: ${name}`)
        console.error(error.message || error)
    }
}
function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

await test('committed strings.en.json is in sync with the generator', async () => {
    const committed = readFileSync(EN_PATH, 'utf8')
    const fresh = JSON.stringify(await buildCatalog(), null, 2) + '\n'
    if (fresh !== committed) throw new Error('strings.en.json is out of date — run `npm run strings`')
})

await test('translated catalogs match English key order and contain no empty values', async () => {
    const englishKeys = Object.keys(JSON.parse(readFileSync(EN_PATH, 'utf8')))
    for (const locale of TRANSLATED_LOCALES) {
        const catalog = JSON.parse(readFileSync(join(EFFECTS_DIR, `strings.${locale}.json`), 'utf8'))
        const localeKeys = Object.keys(catalog)
        const mismatch = localeKeys.findIndex((key, index) => key !== englishKeys[index])
        if (localeKeys.length !== englishKeys.length || mismatch !== -1) {
            const index = mismatch === -1 ? Math.min(localeKeys.length, englishKeys.length) : mismatch
            throw new Error(`${locale} key order differs at index ${index}: expected ${JSON.stringify(englishKeys[index])}, got ${JSON.stringify(localeKeys[index])}`)
        }
        for (const [key, value] of Object.entries(catalog)) {
            if (typeof value !== 'string' || value.trim() === '') {
                throw new Error(`${locale}:${key} must be a non-empty string`)
            }
        }
    }
})

await test('no locale set: effect strings are unchanged English', async () => {
    const r = new CanvasRenderer({ basePath: '/x' })
    r._manifest = { 'filter/adjust': { description: 'Colorspace, hue/saturation, brightness/contrast' } }
    assertEqual(r.getLocale(), null, 'default locale is null')
    assertEqual(r.getEffectDescription('filter/adjust'), 'Colorspace, hue/saturation, brightness/contrast', 'description unchanged')
    assertEqual(r.localize('filter/adjust', 'adjust'), 'adjust', 'localize returns fallback')
    assertEqual(r.localize('filter/adjust.rotation', 'rotation'), 'rotation', 'param label fallback')
    assertEqual(r.getEffectDescription('does/not-exist'), null, 'unknown effect -> null')
})

await test('locale set: resolves locale -> en base -> fallback, and resets', async () => {
    const enCat = {
        'filter/adjust': 'Adjust',
        'filter/adjust#desc': 'EN description',
        'filter/adjust.rotation': 'hue rotation',
        'filter/adjust.contrast': 'contrast',
    }
    const xxCat = {
        'filter/adjust': 'XX Adjust',
        'filter/adjust.contrast': '', // empty translation -> falls back to English
        // (missing 'filter/adjust.rotation' and '#desc' -> also fall back)
    }
    const origFetch = global.fetch
    global.fetch = async (url) => ({
        ok: true,
        json: async () => (url.endsWith('strings.xx.json') ? xxCat : url.endsWith('strings.en.json') ? enCat : {}),
    })
    try {
        const r = new CanvasRenderer({ basePath: '/x' })
        r._manifest = { 'filter/adjust': { description: 'manifest desc' } }

        assertEqual(await r.setLocale('xx'), 'xx', 'setLocale returns active locale')
        assertEqual(r.getLocale(), 'xx', 'getLocale reflects it')
        assertEqual(r.localize('filter/adjust', 'fb'), 'XX Adjust', 'locale hit wins')
        assertEqual(r.localize('filter/adjust.rotation', 'fb'), 'hue rotation', 'missing locale key -> en base')
        assertEqual(r.localize('filter/adjust.contrast', 'fb'), 'contrast', 'empty locale value -> en base')
        assertEqual(r.getEffectDescription('filter/adjust'), 'EN description', 'description -> en base over manifest')
        assertEqual(r.localize('totally/missing', 'fb'), 'fb', 'unknown key -> fallback')

        await r.setLocale(null)
        assertEqual(r.getEffectDescription('filter/adjust'), 'manifest desc', 'reset -> manifest description again')
        assertEqual(r.localize('filter/adjust', 'fb'), 'fb', 'reset -> fallback again')
    } finally {
        global.fetch = origFetch
    }
})

await test('missing locale catalog falls back to English base without throwing', async () => {
    const enCat = {
        'filter/adjust': 'Adjust',
        'filter/adjust#desc': 'EN description',
    }
    const origFetch = global.fetch
    global.fetch = async (url) => {
        if (url.endsWith('strings.en.json')) {
            return { ok: true, json: async () => enCat }
        }
        return { ok: false, json: async () => ({}) }
    }
    try {
        const r = new CanvasRenderer({ basePath: '/x' })
        r._manifest = { 'filter/adjust': { description: 'manifest desc' } }

        assertEqual(await r.setLocale('missing'), 'missing', 'missing locale still becomes active')
        assertEqual(r.getLocale(), 'missing', 'getLocale reflects requested locale')
        assertEqual(r.localize('filter/adjust', 'fb'), 'Adjust', 'missing locale -> en base')
        assertEqual(r.getEffectDescription('filter/adjust'), 'EN description', 'description -> en base')
        assertEqual(r.localize('totally/missing', 'fb'), 'fb', 'unknown key -> fallback')
    } finally {
        global.fetch = origFetch
    }
})

if (failed) process.exit(1)
console.log('\nAll effect-string localization tests passed.')
