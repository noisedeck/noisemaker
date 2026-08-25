/**
 * The committed share/meshes/*.obj assets are serialized from the same
 * primitives.js generators the scene graph uses. This test runs the generator
 * into a temp directory and reads the result back through the runtime OBJ
 * parser, so a change to either side that breaks the assets fails here.
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'

import { parseOBJ } from '../src/runtime/obj-parser.js'
import {
  createSphere,
  createBox,
  createCylinder,
  createTorus,
  createCone,
  createCapsule,
  createIcosphere
} from '../src/geometry/primitives.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const generator = path.join(repoRoot, 'share', 'meshes', 'generate.cjs')

// Mirrors the recipes in generate.cjs; a drift here means the generator no
// longer produces what the committed assets claim to be.
const expected = {
  cube: createBox({ size: [1, 1, 1] }),
  sphere: createSphere({ radius: 0.5, segments: 32 }),
  torus: createTorus({ radius: 0.35, tube: 0.15, segments: 32, tubeSegments: 16 }),
  cylinder: createCylinder({ radius: 0.4, height: 1, segments: 32 }),
  cone: createCone({ radius: 0.4, height: 1, segments: 32 }),
  capsule: createCapsule({ radius: 0.25, height: 1.1, segments: 32, rings: 8 }),
  icosphere: createIcosphere({ radius: 0.5, subdivisions: 2 })
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noisemaker-meshes-'))

try {
  const result = spawnSync('node', [generator, '--out', outDir], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  assert.strictEqual(result.status, 0,
    `generate.cjs exited ${result.status}: ${result.stderr}`)

  for (const [name, geo] of Object.entries(expected)) {
    const file = path.join(outDir, `${name}.obj`)
    assert.ok(fs.existsSync(file), `${name}.obj written`)

    const mesh = parseOBJ(fs.readFileSync(file, 'utf8'))

    // The parser de-indexes: one vertex per index, three per triangle
    assert.strictEqual(mesh.vertexCount, geo.indices.length,
      `${name}: round-trips every triangle from primitives.js`)
    assert.strictEqual(mesh.vertexCount % 3, 0, `${name}: whole triangles`)
    assert.strictEqual(mesh.positions.length, mesh.vertexCount * 3, `${name}: position count`)
    assert.strictEqual(mesh.normals.length, mesh.vertexCount * 3, `${name}: normal count`)
    assert.strictEqual(mesh.uvs.length, mesh.vertexCount * 2, `${name}: uv count`)

    for (let i = 0; i < mesh.positions.length; i++) {
      assert.ok(Number.isFinite(mesh.positions[i]), `${name}: position[${i}] finite`)
    }
    for (let i = 0; i < mesh.uvs.length; i++) {
      assert.ok(Number.isFinite(mesh.uvs[i]), `${name}: uv[${i}] finite`)
    }
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      assert.ok(Number.isFinite(len) && Math.abs(len - 1) < 0.01,
        `${name}: normal ${i / 3} is unit length (got ${len})`)
    }

    // The dropdown assumes origin-centered shapes of roughly unit size.
    // The capsule is the tallest at 1.1, so 0.55 is the shared bound.
    for (let i = 0; i < mesh.positions.length; i++) {
      assert.ok(Math.abs(mesh.positions[i]) <= 0.55 + 1e-6,
        `${name}: vertex component ${mesh.positions[i]} within origin-centered bounds`)
    }

    // The parser reverses face order on read, so the triangles it hands the
    // backend must come out counter-clockwise against their normals or
    // back-face culling shows the inside of the mesh.
    let inverted = 0
    let checked = 0
    for (let t = 0; t < mesh.vertexCount; t += 3) {
      const at = (o, k) => mesh.positions[(t + o) * 3 + k]
      const e1 = [0, 1, 2].map(k => at(1, k) - at(0, k))
      const e2 = [0, 1, 2].map(k => at(2, k) - at(0, k))
      const g = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0]
      ]
      const gLen = Math.hypot(g[0], g[1], g[2])
      if (gLen < 1e-12) continue
      const vn = [0, 1, 2].map(k =>
        (mesh.normals[t * 3 + k] + mesh.normals[(t + 1) * 3 + k] + mesh.normals[(t + 2) * 3 + k]) / 3)
      checked++
      if ((g[0] * vn[0] + g[1] * vn[1] + g[2] * vn[2]) / gLen <= 0) inverted++
    }
    assert.ok(checked > 0, `${name}: has non-degenerate triangles`)
    assert.strictEqual(inverted, 0,
      `${name}: ${inverted}/${checked} parsed triangles wound against their normals`)

    // The committed asset must match what the generator produces right now.
    // Compared by digest so a mismatch reports one line, not the whole file.
    const committed = path.join(repoRoot, 'share', 'meshes', `${name}.obj`)
    const digest = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    assert.strictEqual(
      digest(file),
      digest(committed),
      `${name}.obj: committed asset does not match the generator — re-run share/meshes/generate.cjs`
    )
  }
} finally {
  fs.rmSync(outDir, { recursive: true, force: true })
}

console.log('Mesh OBJ generator tests passed')
