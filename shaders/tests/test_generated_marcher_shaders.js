/**
 * The committed shaders for render/render3d, render/renderCubemap3d and
 * render/renderCubemapSurface are emitted from
 * shaders/src/rendering/marcher-fragments.js by
 * shaders/scripts/generate-marcher-shaders.mjs. This test runs the generator
 * into a temp directory and byte-compares the result against what is on disk,
 * so a fragment edit that was never regenerated — or a hand-edit of a generated
 * file — fails here instead of silently changing a shipped effect.
 *
 * Byte-identity is the whole gate: identical bytes compile to an identical
 * program, so no rendering is required to prove the output is unchanged.
 *
 * The second gate is the sharing itself. Each generated file declares below
 * exactly which fragments it is built from, and the test asserts SET EQUALITY
 * against the fragments that actually appear in it verbatim — so a fragment
 * silently dropped from a file fails, and so does a copy of one re-introduced
 * into a file that is meant to be bespoke.
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import { GLSL_FRAGMENTS, WGSL_FRAGMENTS, marcherBodyGLSL, marcherBodyWGSL, MARCHER_BODY_ORDER }
  from '../src/rendering/marcher-fragments.js'
import { generatedMarcherShaders } from '../scripts/generate-marcher-shaders.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const generator = path.join(repoRoot, 'shaders', 'scripts', 'generate-marcher-shaders.mjs')

/**
 * Which shared fragments each generated file is assembled from.
 *
 * render3d and renderCubemap3d take the whole marcher; renderCubemapSurface
 * samples the raw field along a ray without tracing an isosurface, so it takes
 * only the atlas pair (and the MRT output block every one of them writes).
 */
const PROLOGUE_KEYS = ['defineNote', 'outputs', 'constants']
const FULL_MARCHER = [...PROLOGUE_KEYS, ...MARCHER_BODY_ORDER]
const EXPECTED_SHARED = {
  'shaders/effects/render/render3d/glsl/render3d.glsl': FULL_MARCHER,
  'shaders/effects/render/render3d/wgsl/render3d.wgsl': FULL_MARCHER,
  'shaders/effects/render/renderCubemap3d/glsl/renderCubemap3d.glsl': FULL_MARCHER,
  'shaders/effects/render/renderCubemap3d/wgsl/renderCubemap3d.wgsl': FULL_MARCHER,
  'shaders/effects/render/renderCubemapSurface/glsl/renderCubemapSurface.glsl':
    ['outputs', 'atlasIndex', 'sampleVolume'],
  'shaders/effects/render/renderCubemapSurface/wgsl/renderCubemapSurface.wgsl':
    ['outputs', 'atlasIndex', 'sampleVolume'],
}

const files = generatedMarcherShaders()
assert.ok(files.length > 0, 'the generator claims to own at least one file')

// --- 1. The generator, run as a subprocess, reproduces every committed file ---

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcher-shaders-'))
try {
  const result = spawnSync('node', [generator, '--out-dir', outDir], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  assert.strictEqual(result.status, 0,
    `generator exited ${result.status}: ${result.stderr || result.stdout}`)

  for (const file of files) {
    const generated = fs.readFileSync(path.join(outDir, file.path))
    const committed = fs.readFileSync(path.join(repoRoot, file.path))
    assert.ok(committed.equals(generated),
      `${file.path} is not what the generator emits. ` +
      'Run: node shaders/scripts/generate-marcher-shaders.mjs')
    console.log(`  ${file.path} byte-identical (${committed.length} bytes)`)
  }
} finally {
  fs.rmSync(outDir, { recursive: true, force: true })
}

// --- 2. --check agrees with the working tree ---

const check = spawnSync('node', [generator, '--check'], { cwd: repoRoot, encoding: 'utf8' })
assert.strictEqual(check.status, 0,
  `--check reported drift: ${check.stderr || check.stdout}`)

// --- 3. Every file carries exactly the shared fragments it declares ---

assert.strictEqual(MARCHER_BODY_ORDER.length, 14,
  'twelve shared marcher functions plus the two result structs they return')
assert.deepStrictEqual(
  Object.keys(EXPECTED_SHARED).sort(), files.map((f) => f.path).sort(),
  'every generated file must declare which fragments it is built from')

const fragmentUse = new Map()
for (const file of files) {
  const fragments = file.path.endsWith('.glsl') ? GLSL_FRAGMENTS : WGSL_FRAGMENTS
  const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8')
  const present = Object.keys(fragments).filter((key) => source.includes(fragments[key]))
  assert.deepStrictEqual(present.sort(), [...EXPECTED_SHARED[file.path]].sort(),
    `${file.path} does not carry exactly the shared fragments it declares`)
  for (const key of present) fragmentUse.set(key, (fragmentUse.get(key) ?? 0) + 1)
  const lines = present.reduce((n, key) => n + fragments[key].split('\n').length, 0)
  console.log(`  ${file.path}: ${present.length} shared fragments, ${lines} shared lines`)
}

// The whole point: no fragment exists for a single consumer.
for (const [key, uses] of fragmentUse) {
  assert.ok(uses >= 2, `fragment "${key}" is used by ${uses} file(s) — it is not shared text`)
}

// The full marcher body is one contiguous text, not a re-ordered assembly.
for (const file of files) {
  if (EXPECTED_SHARED[file.path] !== FULL_MARCHER) continue
  const body = file.path.endsWith('.glsl') ? marcherBodyGLSL() : marcherBodyWGSL()
  const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8')
  assert.ok(source.includes(body), `${file.path} does not contain the shared body verbatim`)
}

// --- 4. A fragment edit changes the output (the gate is live, not vacuous) ---

const [first] = files
const firstBody = first.path.endsWith('.glsl') ? marcherBodyGLSL() : marcherBodyWGSL()
assert.notStrictEqual(first.source.replace(firstBody, ''), first.source,
  'the emitted file must actually be assembled from the shared fragments')

// --- 5. Emitted text carries no trailing whitespace ---
//
// One canonical spelling of the shared text, matching the rest of
// shaders/src/rendering/. Locking it here keeps a hand-edit or a pasted-in
// fragment from re-introducing the legacy noise the emitter cleared out.

for (const file of files) {
  const dirty = file.source.split('\n').filter((line) => /[ \t]+$/.test(line)).length
  assert.strictEqual(dirty, 0, `${file.path} has ${dirty} line(s) with trailing whitespace`)
}

console.log(`test_generated_marcher_shaders: ${files.length} generated files verified ` +
  `across ${new Set(files.map((f) => f.path.split('/')[3])).size} effects, ` +
  `${MARCHER_BODY_ORDER.length} shared marcher fragments`)
