import assert from 'assert'
import { Geometry } from '../src/geometry/geometry.js'
import {
  createSphere,
  createBox,
  createPlane,
  createCylinder,
  createTorus,
  createCone,
  createCapsule,
  createIcosphere
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
  // every component is finite (no NaN/Infinity leaking from trig or normalization)
  for (let i = 0; i < geo.positions.length; i++) {
    assert.ok(Number.isFinite(geo.positions[i]), `${label}: position[${i}] is finite`)
  }
  for (let i = 0; i < geo.normals.length; i++) {
    assert.ok(Number.isFinite(geo.normals[i]), `${label}: normal[${i}] is finite`)
  }
  for (let i = 0; i < geo.uvs.length; i++) {
    assert.ok(Number.isFinite(geo.uvs[i]), `${label}: uv[${i}] is finite`)
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

// Cone
{
  const segments = 16
  const geo = createCone({ radius: 1, height: 2, segments })
  assertGeometry(geo, 'cone')
  // side: (base + apex) per segment boundary; cap: center + ring
  assert.strictEqual(geo.positions.length / 3, 3 * segments + 4, 'cone vertex count')
  // segments side triangles + segments cap triangles
  assert.strictEqual(geo.indices.length, 6 * segments, 'cone index count')

  let apexCount = 0
  for (let i = 0; i < geo.positions.length; i += 3) {
    const [x, y, z] = [geo.positions[i], geo.positions[i + 1], geo.positions[i + 2]]
    assert.ok(y >= -1.0001 && y <= 1.0001, 'cone vertex within height')
    if (Math.abs(y - 1) < 1e-6) {
      apexCount++
      assert.ok(Math.hypot(x, z) < 1e-6, 'cone apex is on the axis')
    } else {
      assert.ok(Math.abs(y + 1) < 1e-6, 'cone non-apex vertex sits on the base plane')
      assert.ok(Math.abs(Math.hypot(x, z) - 1) < 1e-6 || Math.hypot(x, z) < 1e-6,
        'cone base vertex on base ring or cap center')
    }
  }
  assert.strictEqual(apexCount, segments + 1, 'cone has one apex vertex per side segment boundary')
}

// Capsule
{
  const segments = 16
  const rings = 6
  const radius = 0.5
  const height = 2
  const geo = createCapsule({ radius, height, segments, rings })
  assertGeometry(geo, 'capsule')
  // two hemispheres of (rings + 1) rows, each row (segments + 1) wide
  assert.strictEqual(geo.positions.length / 3, 2 * (rings + 1) * (segments + 1), 'capsule vertex count')
  assert.strictEqual(geo.indices.length, 12 * rings * segments, 'capsule index count')

  const halfCyl = height / 2 - radius
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < geo.positions.length; i += 3) {
    const [x, y, z] = [geo.positions[i], geo.positions[i + 1], geo.positions[i + 2]]
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    // distance to the capsule's spine segment must equal the radius
    const spineY = Math.max(-halfCyl, Math.min(halfCyl, y))
    const d = Math.hypot(x, y - spineY, z)
    assert.ok(Math.abs(d - radius) < 1e-6, `capsule vertex at radius ${radius} (got ${d})`)
  }
  assert.ok(Math.abs(maxY - height / 2) < 1e-6, 'capsule top pole at +height/2')
  assert.ok(Math.abs(minY + height / 2) < 1e-6, 'capsule bottom pole at -height/2')
}

// Icosphere
{
  const subdivisions = 2
  const geo = createIcosphere({ radius: 1, subdivisions })
  assertGeometry(geo, 'icosphere')
  assert.strictEqual(geo.positions.length / 3, 10 * 4 ** subdivisions + 2, 'icosphere vertex count')
  assert.strictEqual(geo.indices.length, 20 * 4 ** subdivisions * 3, 'icosphere index count')

  for (let i = 0; i < geo.positions.length; i += 3) {
    const dist = Math.hypot(geo.positions[i], geo.positions[i + 1], geo.positions[i + 2])
    assert.ok(Math.abs(dist - 1.0) < 1e-6, `icosphere vertex at radius 1 (got ${dist})`)
  }

  // subdivision 0 is the bare icosahedron
  const base = createIcosphere({ subdivisions: 0 })
  assertGeometry(base, 'icosahedron')
  assert.strictEqual(base.positions.length / 3, 12, 'icosahedron has 12 vertices')
  assert.strictEqual(base.indices.length, 60, 'icosahedron has 20 faces')
}

// Degenerate parameters must still produce finite geometry.
//
// A segment or ring count below the minimum closed cross-section used to divide
// by zero and fill the buffers with NaN — createCapsule({ rings: 0 }) alone
// produced 198 NaN components. The generators clamp instead of trusting the
// caller, so every one of these lands on the floor count.
{
  const sameSize = (a, b, label) => {
    assert.strictEqual(a.positions.length, b.positions.length, `${label}: same vertex count`)
    assert.strictEqual(a.indices.length, b.indices.length, `${label}: same index count`)
  }

  const cone0 = createCone({ segments: 0 })
  assertGeometry(cone0, 'cone-segments-0')
  sameSize(cone0, createCone({ segments: 3 }), 'cone-segments-0 clamps to 3')

  const capsuleRings0 = createCapsule({ rings: 0 })
  assertGeometry(capsuleRings0, 'capsule-rings-0')
  sameSize(capsuleRings0, createCapsule({ rings: 1 }), 'capsule-rings-0 clamps to 1')

  const capsule0 = createCapsule({ segments: 0, rings: 0 })
  assertGeometry(capsule0, 'capsule-segments-rings-0')
  sameSize(capsule0, createCapsule({ segments: 3, rings: 1 }), 'capsule-segments-0 clamps to 3')

  const sphere0 = createSphere({ segments: 0 })
  assertGeometry(sphere0, 'sphere-segments-0')
  sameSize(sphere0, createSphere({ segments: 3 }), 'sphere-segments-0 clamps to 3')

  const cylinder0 = createCylinder({ segments: 0 })
  assertGeometry(cylinder0, 'cylinder-segments-0')
  sameSize(cylinder0, createCylinder({ segments: 3 }), 'cylinder-segments-0 clamps to 3')

  const torus0 = createTorus({ segments: 0, tubeSegments: 0 })
  assertGeometry(torus0, 'torus-segments-0')
  sameSize(torus0, createTorus({ segments: 3, tubeSegments: 3 }), 'torus-segments-0 clamps to 3')

  // A zero-radius tube collapses the surface onto the ring, where the normal
  // direction is undefined; it must not normalize a zero-length vector.
  assertGeometry(createTorus({ tube: 0 }), 'torus-tube-0')

  // Negative and fractional counts land on the same floors
  assertGeometry(createSphere({ segments: -8 }), 'sphere-segments-negative')
  sameSize(createCone({ segments: 8.7 }), createCone({ segments: 8 }), 'cone-segments-fractional')
  sameSize(createTorus({ segments: 8.7, tubeSegments: 6.2 }), createTorus({ segments: 8, tubeSegments: 6 }),
    'torus-segments-fractional')
  sameSize(createCapsule({ segments: 8.7, rings: 3.4 }), createCapsule({ segments: 8, rings: 3 }),
    'capsule-rings-fractional')

  // Subdivision counts below zero or between integers land on whole levels
  const icoNeg = createIcosphere({ subdivisions: -1 })
  assertGeometry(icoNeg, 'icosphere-subdivisions-negative')
  sameSize(icoNeg, createIcosphere({ subdivisions: 0 }), 'icosphere-subdivisions-negative clamps to 0')
  sameSize(createIcosphere({ subdivisions: 2.5 }), createIcosphere({ subdivisions: 2 }),
    'icosphere-subdivisions-fractional')

  // Clamped geometry is still wound correctly
  assertWindingMatchesNormals(cone0, 'cone-segments-0')
  assertWindingMatchesNormals(capsule0, 'capsule-segments-rings-0')
  assertWindingMatchesNormals(sphere0, 'sphere-segments-0')
  assertWindingMatchesNormals(cylinder0, 'cylinder-segments-0')
  assertWindingMatchesNormals(torus0, 'torus-segments-0')
  assertWindingMatchesNormals(icoNeg, 'icosphere-subdivisions-negative')
}

// Default params
{
  const geo = createSphere({})
  assertGeometry(geo, 'sphere-defaults')
  const geo2 = createBox({})
  assertGeometry(geo2, 'box-defaults')
  assertGeometry(createCone({}), 'cone-defaults')
  assertGeometry(createCapsule({}), 'capsule-defaults')
  assertGeometry(createIcosphere({}), 'icosphere-defaults')
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
  assertWindingMatchesNormals(createCone({}), 'cone')
  assertWindingMatchesNormals(createCapsule({}), 'capsule')
  assertWindingMatchesNormals(createIcosphere({}), 'icosphere')
}

// Non-default parameters must not change winding
{
  assertWindingMatchesNormals(createSphere({ radius: 2, segments: 12 }), 'sphere-params')
  assertWindingMatchesNormals(createBox({ size: [2, 0.5, 3] }), 'box-params')
  assertWindingMatchesNormals(createCylinder({ radius: 2, height: 4, segments: 8 }), 'cylinder-params')
  assertWindingMatchesNormals(createTorus({ radius: 3, tube: 0.2, segments: 8, tubeSegments: 6 }), 'torus-params')
  assertWindingMatchesNormals(createCone({ radius: 0.4, height: 1, segments: 8 }), 'cone-params')
  assertWindingMatchesNormals(createCapsule({ radius: 0.25, height: 1.1, segments: 12, rings: 4 }), 'capsule-params')
  assertWindingMatchesNormals(createIcosphere({ radius: 0.5, subdivisions: 3 }), 'icosphere-params')
}

console.log('Geometry primitives tests passed')
