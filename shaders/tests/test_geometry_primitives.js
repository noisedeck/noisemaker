import assert from 'assert'
import { Geometry } from '../src/geometry/geometry.js'
import {
  createSphere,
  createBox,
  createPlane,
  createCylinder,
  createTorus
} from '../src/geometry/primitives.js'

function assertGeometry(geo, label) {
  assert.ok(geo instanceof Geometry, `${label}: is Geometry`)
  assert.ok(geo.positions.length > 0, `${label}: has positions`)
  assert.ok(geo.normals.length > 0, `${label}: has normals`)
  assert.ok(geo.uvs.length > 0, `${label}: has uvs`)
  assert.ok(geo.indices.length > 0, `${label}: has indices`)
  assert.strictEqual(geo.positions.length, geo.normals.length,
    `${label}: positions and normals same length`)
  assert.strictEqual(geo.positions.length / 3, geo.uvs.length / 2,
    `${label}: position/uv vertex count match`)
  // all indices in range
  const vertCount = geo.positions.length / 3
  for (let i = 0; i < geo.indices.length; i++) {
    assert.ok(geo.indices[i] < vertCount,
      `${label}: index ${i} (${geo.indices[i]}) < vertCount (${vertCount})`)
  }
  // normals are unit length
  for (let i = 0; i < geo.normals.length; i += 3) {
    const len = Math.sqrt(
      geo.normals[i] ** 2 + geo.normals[i+1] ** 2 + geo.normals[i+2] ** 2
    )
    assert.ok(Math.abs(len - 1.0) < 0.01,
      `${label}: normal at ${i/3} is unit length (got ${len})`)
  }
}

// Sphere
{
  const geo = createSphere({ radius: 1, segments: 16 })
  assertGeometry(geo, 'sphere')
  for (let i = 0; i < geo.positions.length; i += 3) {
    const dist = Math.sqrt(
      geo.positions[i] ** 2 + geo.positions[i+1] ** 2 + geo.positions[i+2] ** 2
    )
    assert.ok(Math.abs(dist - 1.0) < 0.01, `sphere vertex at radius 1`)
  }
}

// Box
{
  const geo = createBox({ size: [2, 3, 4] })
  assertGeometry(geo, 'box')
  assert.strictEqual(geo.indices.length, 36, 'box has 36 indices')
}

// Plane
{
  const geo = createPlane({ width: 10, height: 10 })
  assertGeometry(geo, 'plane')
  assert.strictEqual(geo.indices.length, 6, 'plane has 6 indices (2 tris)')
}

// Cylinder
{
  const geo = createCylinder({ radius: 1, height: 2, segments: 16 })
  assertGeometry(geo, 'cylinder')
}

// Torus
{
  const geo = createTorus({ radius: 1, tube: 0.3, segments: 16, tubeSegments: 12 })
  assertGeometry(geo, 'torus')
}

// Default params
{
  const geo = createSphere({})
  assertGeometry(geo, 'sphere-defaults')
  const geo2 = createBox({})
  assertGeometry(geo2, 'box-defaults')
}

/**
 * Triangle winding must agree with the vertex normals.
 *
 * The backend renders meshes with gl.frontFace(CCW) and gl.cullFace(BACK), so
 * a triangle whose geometric normal (edge1 x edge2) opposes its vertex normals
 * has its exterior culled — you see the inside of the far surface instead. A
 * torus reads as see-through; a box reads flat and unlit.
 */
function assertWindingMatchesNormals(geo, label) {
  const P = geo.positions
  const N = geo.normals
  const I = geo.indices
  let inverted = 0
  let checked = 0

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
    if (gLen < 1e-12) continue // degenerate (cap fans can produce these)

    const vn = [0, 1, 2].map(k => (N[i0 * 3 + k] + N[i1 * 3 + k] + N[i2 * 3 + k]) / 3)
    const dot = (g[0] * vn[0] + g[1] * vn[1] + g[2] * vn[2]) / gLen

    checked++
    if (dot <= 0) inverted++
  }

  assert.ok(checked > 0, `${label}: has non-degenerate triangles`)
  assert.strictEqual(
    inverted, 0,
    `${label}: ${inverted}/${checked} triangles wound against their normals (front faces would be culled)`
  )
}

// Every primitive must be wound counter-clockwise relative to its normals
{
  assertWindingMatchesNormals(createSphere({}), 'sphere')
  assertWindingMatchesNormals(createBox({}), 'box')
  assertWindingMatchesNormals(createPlane({}), 'plane')
  assertWindingMatchesNormals(createCylinder({}), 'cylinder')
  assertWindingMatchesNormals(createTorus({}), 'torus')
}

// Non-default parameters must not change winding
{
  assertWindingMatchesNormals(createSphere({ radius: 2, segments: 12 }), 'sphere-params')
  assertWindingMatchesNormals(createBox({ size: [2, 0.5, 3] }), 'box-params')
  assertWindingMatchesNormals(createCylinder({ radius: 2, height: 4, segments: 8 }), 'cylinder-params')
  assertWindingMatchesNormals(createTorus({ radius: 3, tube: 0.2, segments: 8, tubeSegments: 6 }), 'torus-params')
}

console.log('Geometry primitives tests passed')
