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

// Empty field (all values above threshold) -> empty geometry
{
  const field = new Float32Array(8 * 8 * 8).fill(1.0)
  const geo = marchingCubes(field, 8, 8, 8, 0.5)
  assert.strictEqual(geo.positions.length, 0, 'empty field -> no geometry')
}

console.log('Procedural geometry tests passed')
