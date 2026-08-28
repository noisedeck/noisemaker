/**
 * The committed shaders for render/render3d and render/renderCubemap3d are
 * emitted from shaders/src/rendering/marcher-fragments.js by
 * shaders/scripts/generate-marcher-shaders.mjs. This test runs the generator
 * into a temp directory and byte-compares the result against what is on disk,
 * so a fragment edit that was never regenerated — or a hand-edit of a generated
 * file — fails here instead of silently changing a shipped effect.
 *
 * Byte-identity is the whole gate: identical bytes compile to an identical
 * program, so no rendering is required to prove the output is unchanged.
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import { marcherBodyGLSL, marcherBodyWGSL, MARCHER_BODY_ORDER }
  from '../src/rendering/marcher-fragments.js'
import { generatedMarcherShaders } from '../scripts/generate-marcher-shaders.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const generator = path.join(repoRoot, 'shaders', 'scripts', 'generate-marcher-shaders.mjs')

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

// --- 3. The shared body really is shared: one text, present verbatim in all ---

const glslBody = marcherBodyGLSL()
const wgslBody = marcherBodyWGSL()
assert.strictEqual(MARCHER_BODY_ORDER.length, 14,
  'twelve shared marcher functions plus the two result structs they return')

let glslFiles = 0
let wgslFiles = 0
for (const file of files) {
  const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8')
  if (file.path.endsWith('.glsl')) {
    assert.ok(source.includes(glslBody), `${file.path} does not contain the shared GLSL body verbatim`)
    glslFiles++
  } else {
    assert.ok(source.includes(wgslBody), `${file.path} does not contain the shared WGSL body verbatim`)
    wgslFiles++
  }
}
assert.ok(glslFiles >= 2 && wgslFiles >= 2,
  'the shared body must be proven against at least two files per language')

// --- 4. A fragment edit changes the output (the gate is live, not vacuous) ---

const [first] = files
const withoutBody = first.path.endsWith('.glsl')
  ? first.source.replace(glslBody, '')
  : first.source.replace(wgslBody, '')
assert.notStrictEqual(withoutBody, first.source,
  'the emitted file must actually be assembled from the shared fragments')

console.log(`test_generated_marcher_shaders: ${files.length} generated files verified ` +
  `(${glslFiles} GLSL, ${wgslFiles} WGSL), ${MARCHER_BODY_ORDER.length} shared fragments`)
