import assert from 'assert'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { PRESETS as JSPRESETS, setSeed } from '../js/noisemaker/presets.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const JS_ONLY = [
  'erode-post',
  'ghost-diagram',
  'ghost',
  'maybe-hyperspace',
  'maybe-mask',
  'shake-it',
  'shrink-triangulate',
  'cell-reflect',
  'density-wave',
  'glom',
  'jorts',
  'jovian-clouds',
  'paintball-party',
  'pearlescent',
  'posterize',
  'quadrants',
  'rasteroids',
  'sbup',
  'symmetry',
  'the-data-must-flow',
]

function getPythonPresetData() {
  const py = `import json, random
from noisemaker import rng
from noisemaker.composer import _resolve_metadata_value
from noisemaker.presets import PRESETS

seeds = [0, 1, 2, 3, 4]
preset_names = sorted(PRESETS().keys())
combined = {}
for name in preset_names:
    layers = None
    settings_per_seed = []
    for seed in seeds:
        random.seed(seed)
        rng.set_seed(seed)
        preset = PRESETS()[name]
        if layers is None and preset.get('layers'):
            layers = _resolve_metadata_value(preset['layers'], {})
        raw_settings = preset.get('settings')
        if raw_settings:
            template = raw_settings() if callable(raw_settings) else raw_settings
            settings = {}
            for key, value in template.items():
                settings[key] = _resolve_metadata_value(value, settings)
            settings = {
                key: getattr(value, 'value', value)
                for key, value in settings.items()
            }
        else:
            settings = {}
        settings_per_seed.append(settings)
    entry = {}
    if layers is not None:
        entry['layers'] = layers
    if settings_per_seed and settings_per_seed[0]:
        entry['settings_per_seed'] = settings_per_seed
    combined[name] = entry
print(json.dumps(combined))`
  const res = spawnSync('python3', ['-c', py], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  })
  if (res.status !== 0) {
    throw new Error(res.stderr)
  }
  return JSON.parse(res.stdout)
}

function getJSPresetData() {
  const seeds = [0, 1, 2, 3, 4]
  const presetNames = Object.keys(JSPRESETS()).sort()
  const combined = {}

  for (const name of presetNames) {
    let layers = null
    const settingsPerSeed = []

    for (const seed of seeds) {
      setSeed(seed)
      const preset = JSPRESETS()[name]
      if (layers === null && preset.layers) {
        layers = preset.layers.slice()
      }
      const rawSettings = preset.settings
        ? {
            ...(typeof preset.settings === 'function'
              ? preset.settings()
              : preset.settings),
          }
        : {}
      const s = Object.fromEntries(
        Object.entries(rawSettings).map(([key, value]) => [
          key,
          typeof value === 'function' ? value() : value,
        ]),
      )
      settingsPerSeed.push(s)
    }

    const entry = {}
    if (layers) entry.layers = layers
    if (settingsPerSeed.length && Object.keys(settingsPerSeed[0]).length) {
      entry.settings_per_seed = settingsPerSeed
    }
    combined[name] = entry
  }

  return combined
}

const pyData = getPythonPresetData()
const jsData = getJSPresetData()

const missing = []
const extra = []
const mismatched = []

function describePresetMismatch(name, pyPreset, jsPreset) {
  const differences = []
  if (JSON.stringify(jsPreset.layers) !== JSON.stringify(pyPreset.layers)) {
    differences.push(
      `${name}.layers: Python=${JSON.stringify(pyPreset.layers)}, JS=${JSON.stringify(jsPreset.layers)}`,
    )
  }
  const pySettings = pyPreset.settings_per_seed || []
  const jsSettings = jsPreset.settings_per_seed || []
  for (let seed = 0; seed < Math.max(pySettings.length, jsSettings.length); seed++) {
    const py = pySettings[seed] || {}
    const js = jsSettings[seed] || {}
    for (const key of new Set([...Object.keys(py), ...Object.keys(js)])) {
      try {
        assert.deepStrictEqual(js[key], py[key])
      } catch {
        differences.push(
          `${name}.${key}[seed=${seed}]: Python=${JSON.stringify(py[key])}, JS=${JSON.stringify(js[key])}`,
        )
      }
    }
  }
  return differences
}

for (const [name, pyPreset] of Object.entries(pyData)) {
  if (JS_ONLY.includes(name)) continue
  const jsPreset = jsData[name]
  if (!jsPreset) {
    missing.push(name)
    continue
  }
  try {
    assert.deepStrictEqual(jsPreset, pyPreset)
  } catch {
    mismatched.push(...describePresetMismatch(name, pyPreset, jsPreset))
  }
}

for (const name of Object.keys(jsData)) {
  if (JS_ONLY.includes(name)) continue
  if (!(name in pyData)) extra.push(name)
}

if (missing.length || extra.length || mismatched.length) {
  let msg = ''
  if (missing.length) msg += `Missing JS presets: ${missing.join(', ')}\n`
  if (extra.length) msg += `Extra JS presets: ${extra.join(', ')}\n`
  if (mismatched.length) msg += `Preset mismatches:\n${mismatched.join('\n')}`
  assert.fail(msg.trim())
}

console.log('preset params parity ok')
