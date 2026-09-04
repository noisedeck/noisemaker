#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

/**
 * Ordered list of test modules and helpers.
 * Set `parity` to true when the module depends on the Python implementation.
 */
const testEntries = [
  { file: 'scripts/checkEnums.js', parity: true },
  { file: 'test/rng.test.js', parity: false },
  { file: 'test/constants.test.js', parity: false },
  { file: 'test/constants-parity.test.js', parity: true },
  { file: 'test/simplex.test.js', parity: false },
  { file: 'test/value.test.js', parity: false },
  { file: 'test/value-parity.test.js', parity: true },
  { file: 'test/points.test.js', parity: false },
  { file: 'test/masks.test.js', parity: false },
  { file: 'test/masks-parity.test.js', parity: true },
  { file: 'test/palettes.test.js', parity: false },
  { file: 'test/palettes-parity.test.js', parity: true },
  { file: 'test/asyncInit.test.js', parity: false },
  { file: 'test/effectsRegistry.test.js', parity: false },
  { file: 'test/effects-parity.test.js', parity: true },
  { file: 'test/effects.test.js', parity: true }, // Most tests use Python-generated fixtures
  { file: 'test/composer.test.js', parity: false },
  { file: 'test/presets-parity.test.js', parity: true },
  { file: 'test/presets-params-parity.test.js', parity: true },
  { file: 'test/presets.test.js', parity: false },
  { file: 'test/presets-render.test.js', parity: false },
  { file: 'test/preset-cycle.test.js', parity: false },
  { file: 'test/colors.test.js', parity: false },
  { file: 'test/canvas.test.js', parity: false },
  { file: 'test/cubeCamera.test.js', parity: false },
  { file: 'test/cubeExport.test.js', parity: false },
  { file: 'shaders/tests/test_pipeline.js', parity: false },
  { file: 'shaders/tests/test_audio.js', parity: false },
  { file: 'shaders/tests/test_external_input.js', parity: false },
  { file: 'shaders/tests/test_midi_audio_parser.js', parity: false },
  { file: 'shaders/tests/test_nested_automation.js', parity: false },
  { file: 'shaders/tests/test-let-roundtrip.mjs', parity: false },
  { file: 'shaders/tests/test_gl_error_gating.js', parity: false },
  { file: 'shaders/tests/test_cube_driver.js', parity: false },
  { file: 'shaders/tests/test_cube_texture.js', parity: false },
  { file: 'shaders/tests/test_remap_contract.js', parity: false },
  { file: 'test/generators.test.js', parity: false },
  { file: 'test/parser.test.js', parity: false },
  { file: 'test/evaluator.test.js', parity: false },
  { file: 'test/encoder.test.js', parity: false },
  { file: 'test/cli.test.js', parity: false },
  { file: 'test/docs-static-paths.test.js', parity: false }
]

const skipParity = process.argv.includes('--skip-parity')
const forwardedArgs = process.argv.filter((arg) => arg !== '--skip-parity')

// Set environment variable to skip fixture tests when running non-parity suite
if (skipParity) {
  process.env.SKIP_FIXTURES = '1'
}

for (const entry of testEntries) {
  if (skipParity && entry.parity) {
    continue
  }

  const resolved = path.resolve(repoRoot, entry.file)
  const runArgs = [resolved, ...forwardedArgs]
  const result = spawnSync('node', runArgs, {
    cwd: repoRoot,
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
