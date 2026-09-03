import assert from 'assert'
import { Geometry } from '../src/geometry/geometry.js'
import { marchingCubes } from '../src/geometry/procedural.js'

// Marching cubes with a sphere field (CPU fallback)
{
  const resolution = 16
  const field = new Float32Array(resolution * resolution * resolution)

  // Fill with signed distance to a sphere of radius 0.4 centered at origin (in normalized coords)
  for (let z = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const nx = x / (resolution - 1) - 0.5
        const ny = y / (resolution - 1) - 0.5
        const nz = z / (resolution - 1) - 0.5
        const dist = Math.sqrt(nx*nx + ny*ny + nz*nz)
        field[z * resolution * resolution + y * resolution + x] = dist
      }
    }
  }

  const geo = marchingCubes(field, resolution, resolution, resolution, 0.4)
  assert.ok(geo instanceof Geometry, 'returns Geometry')
  assert.ok(geo.positions.length > 0, 'has vertices')
  assert.ok(geo.indices.length > 0, 'has indices')
  assert.ok(geo.normals.length > 0, 'has normals')
  assert.strictEqual(geo.positions.length, geo.normals.length, 'positions/normals match')

  // Sphere should produce roughly spherical output
  for (let i = 0; i < geo.positions.length; i += 3) {
    const dx = geo.positions[i]
    const dy = geo.positions[i+1]
    const dz = geo.positions[i+2]
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
    assert.ok(dist < 0.6, `vertex within expected bounds: ${dist}`)
    assert.ok(dist > 0.2, `vertex outside expected inner bound: ${dist}`)
  }
}

// Triangle winding must agree with the vertex normals, exactly as it does for
// every primitive in primitives.js.
//
// The mesh G-buffer pass draws with frontFace(CCW) and cullFace(BACK), so a
// triangle whose geometric normal (edge1 x edge2) opposes its vertex normals
// has its exterior culled and the surface renders inside-out or not at all.
// marchingCubes computes its vertex normals from +gradient of the field, which
// points from "inside" (value < threshold) to outside, so both the winding and
// the normals must face away from the enclosed volume.
{
  const resolution = 16
  const field = new Float32Array(resolution * resolution * resolution)
  for (let z = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const nx = x / (resolution - 1) - 0.5
        const ny = y / (resolution - 1) - 0.5
        const nz = z / (resolution - 1) - 0.5
        field[z * resolution * resolution + y * resolution + x] = Math.sqrt(nx*nx + ny*ny + nz*nz)
      }
    }
  }

  const geo = marchingCubes(field, resolution, resolution, resolution, 0.4)
  const P = geo.positions
  const N = geo.normals
  const I = geo.indices

  let checked = 0
  let againstNormals = 0
  let againstOutward = 0

  for (let t = 0; t < I.length; t += 3) {
    const [i0, i1, i2] = [I[t], I[t + 1], I[t + 2]]
    const p0 = [P[i0 * 3], P[i0 * 3 + 1], P[i0 * 3 + 2]]
    const p1 = [P[i1 * 3], P[i1 * 3 + 1], P[i1 * 3 + 2]]
    const p2 = [P[i2 * 3], P[i2 * 3 + 1], P[i2 * 3 + 2]]

    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
    const g = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0]
    ]
    const gLen = Math.hypot(g[0], g[1], g[2])
    if (gLen < 1e-12) continue

    checked++

    const vn = [0, 1, 2].map(k => (N[i0 * 3 + k] + N[i1 * 3 + k] + N[i2 * 3 + k]) / 3)
    if ((g[0] * vn[0] + g[1] * vn[1] + g[2] * vn[2]) / gLen <= 0) againstNormals++

    // The field is a distance to the origin, so "away from the volume" is
    // simply the direction of the triangle centroid.
    const c = [0, 1, 2].map(k => (p0[k] + p1[k] + p2[k]) / 3)
    if ((g[0] * c[0] + g[1] * c[1] + g[2] * c[2]) / gLen <= 0) againstOutward++
  }

  assert.ok(checked > 0, 'marching cubes has non-degenerate triangles')
  assert.strictEqual(againstNormals, 0,
    `${againstNormals}/${checked} marching cubes triangles wound against their own normals`)
  assert.strictEqual(againstOutward, 0,
    `${againstOutward}/${checked} marching cubes triangles wound into the volume (front faces would be culled)`)
}

// Empty field (all values above threshold) -> empty geometry
{
  const field = new Float32Array(8 * 8 * 8).fill(1.0)
  const geo = marchingCubes(field, 8, 8, 8, 0.5)
  assert.strictEqual(geo.positions.length, 0, 'empty field -> no geometry')
}

console.log('Procedural geometry tests passed')
