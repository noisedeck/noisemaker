import { Geometry } from './geometry.js'

/**
 * Create a UV sphere.
 * @param {object} opts
 * @param {number} [opts.radius=1]
 * @param {number} [opts.segments=32] - Number of longitude segments (and half for latitude)
 * @returns {Geometry}
 */
export function createSphere({ radius = 1, segments = 32 } = {}) {
  const widthSegments = segments
  const heightSegments = Math.max(2, Math.floor(segments / 2))

  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  // Generate vertices
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments
    const phi = v * Math.PI // 0 to PI (top to bottom)

    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments
      const theta = u * Math.PI * 2 // 0 to 2*PI

      const nx = -Math.sin(phi) * Math.cos(theta)
      const ny = Math.cos(phi)
      const nz = Math.sin(phi) * Math.sin(theta)

      positions.push(nx * radius, ny * radius, nz * radius)
      normals.push(nx, ny, nz)
      uvs.push(u, v)
    }
  }

  // Generate indices
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * (widthSegments + 1) + x
      const b = a + 1
      const c = a + (widthSegments + 1)
      const d = c + 1

      // Skip degenerate triangles at the poles
      if (y !== 0) {
        indices.push(a, c, b)
      }
      if (y !== heightSegments - 1) {
        indices.push(b, c, d)
      }
    }
  }

  return new Geometry({ positions, normals, uvs, indices })
}

/**
 * Create a box (rectangular prism).
 * @param {object} opts
 * @param {number[]} [opts.size=[1,1,1]] - [width, height, depth]
 * @returns {Geometry}
 */
export function createBox({ size = [1, 1, 1] } = {}) {
  const [w, h, d] = [size[0] / 2, size[1] / 2, size[2] / 2]

  // Each face: 4 unique vertices (for correct normals), 2 triangles
  // 6 faces * 4 verts = 24 vertices, 6 faces * 6 indices = 36 indices
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  // Face definitions: [normal, tangent, bitangent, center offset direction]
  const faces = [
    // +X
    { normal: [1, 0, 0], corners: [[w, -h, -d], [w, -h, d], [w, h, d], [w, h, -d]] },
    // -X
    { normal: [-1, 0, 0], corners: [[-w, -h, d], [-w, -h, -d], [-w, h, -d], [-w, h, d]] },
    // +Y
    { normal: [0, 1, 0], corners: [[-w, h, -d], [w, h, -d], [w, h, d], [-w, h, d]] },
    // -Y
    { normal: [0, -1, 0], corners: [[-w, -h, d], [w, -h, d], [w, -h, -d], [-w, -h, -d]] },
    // +Z
    { normal: [0, 0, 1], corners: [[-w, -h, d], [-w, h, d], [w, h, d], [w, -h, d]] },
    // -Z
    { normal: [0, 0, -1], corners: [[w, -h, -d], [w, h, -d], [-w, h, -d], [-w, -h, -d]] },
  ]

  const faceUVs = [[0, 0], [1, 0], [1, 1], [0, 1]]

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]
    const baseIndex = f * 4

    for (let v = 0; v < 4; v++) {
      positions.push(face.corners[v][0], face.corners[v][1], face.corners[v][2])
      normals.push(face.normal[0], face.normal[1], face.normal[2])
      uvs.push(faceUVs[v][0], faceUVs[v][1])
    }

    // Two triangles per face
    indices.push(baseIndex, baseIndex + 2, baseIndex + 1)
    indices.push(baseIndex, baseIndex + 3, baseIndex + 2)
  }

  return new Geometry({ positions, normals, uvs, indices })
}

/**
 * Create a plane (XZ plane, normal pointing +Y).
 * @param {object} opts
 * @param {number} [opts.width=1]
 * @param {number} [opts.height=1]
 * @returns {Geometry}
 */
export function createPlane({ width = 1, height = 1 } = {}) {
  const hw = width / 2
  const hh = height / 2

  const positions = [
    -hw, 0, -hh,
     hw, 0, -hh,
     hw, 0,  hh,
    -hw, 0,  hh,
  ]

  const normals = [
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]

  const uvs = [
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]

  const indices = [
    0, 2, 1,
    0, 3, 2,
  ]

  return new Geometry({ positions, normals, uvs, indices })
}

/**
 * Create a cylinder with caps.
 * @param {object} opts
 * @param {number} [opts.radius=1]
 * @param {number} [opts.height=2]
 * @param {number} [opts.segments=32]
 * @returns {Geometry}
 */
export function createCylinder({ radius = 1, height = 2, segments = 32 } = {}) {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  const halfH = height / 2

  // --- Side ---
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    const theta = u * Math.PI * 2

    const nx = Math.cos(theta)
    const nz = Math.sin(theta)

    // Bottom vertex of side
    positions.push(nx * radius, -halfH, nz * radius)
    normals.push(nx, 0, nz)
    uvs.push(u, 0)

    // Top vertex of side
    positions.push(nx * radius, halfH, nz * radius)
    normals.push(nx, 0, nz)
    uvs.push(u, 1)
  }

  // Side indices
  for (let i = 0; i < segments; i++) {
    const a = i * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3

    indices.push(a, b, c)
    indices.push(b, d, c)
  }

  // --- Top cap ---
  const topCenterIdx = positions.length / 3
  positions.push(0, halfH, 0)
  normals.push(0, 1, 0)
  uvs.push(0.5, 0.5)

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2
    const nx = Math.cos(theta)
    const nz = Math.sin(theta)

    positions.push(nx * radius, halfH, nz * radius)
    normals.push(0, 1, 0)
    uvs.push(nx * 0.5 + 0.5, nz * 0.5 + 0.5)
  }

  for (let i = 0; i < segments; i++) {
    indices.push(topCenterIdx, topCenterIdx + 2 + i, topCenterIdx + 1 + i)
  }

  // --- Bottom cap ---
  const botCenterIdx = positions.length / 3
  positions.push(0, -halfH, 0)
  normals.push(0, -1, 0)
  uvs.push(0.5, 0.5)

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2
    const nx = Math.cos(theta)
    const nz = Math.sin(theta)

    positions.push(nx * radius, -halfH, nz * radius)
    normals.push(0, -1, 0)
    uvs.push(nx * 0.5 + 0.5, nz * 0.5 + 0.5)
  }

  for (let i = 0; i < segments; i++) {
    // Reversed winding for bottom cap
    indices.push(botCenterIdx, botCenterIdx + 1 + i, botCenterIdx + 2 + i)
  }

  return new Geometry({ positions, normals, uvs, indices })
}

/**
 * Create a torus.
 * @param {object} opts
 * @param {number} [opts.radius=1] - Distance from center of torus to center of tube
 * @param {number} [opts.tube=0.4] - Radius of the tube
 * @param {number} [opts.segments=32] - Main ring segments
 * @param {number} [opts.tubeSegments=16] - Tube cross-section segments
 * @returns {Geometry}
 */
export function createTorus({ radius = 1, tube = 0.4, segments = 32, tubeSegments = 16 } = {}) {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  for (let j = 0; j <= segments; j++) {
    const u = j / segments
    const theta = u * Math.PI * 2 // angle around the main ring

    for (let i = 0; i <= tubeSegments; i++) {
      const v = i / tubeSegments
      const phi = v * Math.PI * 2 // angle around the tube

      // Position on the torus surface
      const x = (radius + tube * Math.cos(phi)) * Math.cos(theta)
      const y = tube * Math.sin(phi)
      const z = (radius + tube * Math.cos(phi)) * Math.sin(theta)

      positions.push(x, y, z)

      // Normal: direction from the ring center to the surface point
      // Ring center at this theta: (radius * cos(theta), 0, radius * sin(theta))
      const cx = radius * Math.cos(theta)
      const cz = radius * Math.sin(theta)

      const nx = x - cx
      const ny = y
      const nz = z - cz

      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      normals.push(nx / len, ny / len, nz / len)

      uvs.push(u, v)
    }
  }

  // Generate indices
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < tubeSegments; i++) {
      const a = j * (tubeSegments + 1) + i
      const b = a + 1
      const c = a + (tubeSegments + 1)
      const d = c + 1

      indices.push(a, b, c)
      indices.push(b, d, c)
    }
  }

  return new Geometry({ positions, normals, uvs, indices })
}
