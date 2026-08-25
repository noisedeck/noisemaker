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

/**
 * Create a cone with a base cap. Apex at +height/2, base at -height/2.
 * @param {object} opts
 * @param {number} [opts.radius=1] - Base radius
 * @param {number} [opts.height=2]
 * @param {number} [opts.segments=32]
 * @returns {Geometry}
 */
export function createCone({ radius = 1, height = 2, segments = 32 } = {}) {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  const halfH = height / 2

  // Slope normal components: radial and vertical parts of the side normal
  const slope = Math.hypot(radius, height)
  const nRadial = slope > 0 ? height / slope : 1
  const nUp = slope > 0 ? radius / slope : 0

  // --- Side ---
  // The apex is duplicated per segment boundary so each side triangle gets a
  // normal pointing along its own slope instead of a meaningless averaged one.
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    const theta = u * Math.PI * 2

    const cx = Math.cos(theta)
    const cz = Math.sin(theta)

    // Base vertex
    positions.push(cx * radius, -halfH, cz * radius)
    normals.push(cx * nRadial, nUp, cz * nRadial)
    uvs.push(u, 0)

    // Apex vertex, normal taken at the midpoint of the segment it spans
    const thetaMid = ((i + 0.5) / segments) * Math.PI * 2
    positions.push(0, halfH, 0)
    normals.push(Math.cos(thetaMid) * nRadial, nUp, Math.sin(thetaMid) * nRadial)
    uvs.push((i + 0.5) / segments, 1)
  }

  for (let i = 0; i < segments; i++) {
    const base = i * 2
    indices.push(base, base + 1, base + 2)
  }

  // --- Base cap ---
  const capCenterIdx = positions.length / 3
  positions.push(0, -halfH, 0)
  normals.push(0, -1, 0)
  uvs.push(0.5, 0.5)

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2
    const cx = Math.cos(theta)
    const cz = Math.sin(theta)

    positions.push(cx * radius, -halfH, cz * radius)
    normals.push(0, -1, 0)
    uvs.push(cx * 0.5 + 0.5, cz * 0.5 + 0.5)
  }

  for (let i = 0; i < segments; i++) {
    indices.push(capCenterIdx, capCenterIdx + 1 + i, capCenterIdx + 2 + i)
  }

  return new Geometry({ positions, normals, uvs, indices })
}

/**
 * Create a capsule: a cylinder along Y capped by two hemispheres.
 * `height` is the total extent along Y, so the cylindrical mid-section is
 * height - 2 * radius (clamped at zero, where the capsule becomes a sphere).
 * @param {object} opts
 * @param {number} [opts.radius=0.5]
 * @param {number} [opts.height=2] - Total height including both caps
 * @param {number} [opts.segments=32] - Segments around the axis
 * @param {number} [opts.rings=8] - Latitude rings per hemisphere
 * @returns {Geometry}
 */
export function createCapsule({ radius = 0.5, height = 2, segments = 32, rings = 8 } = {}) {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  const halfCyl = Math.max(0, height / 2 - radius)

  // Rows 0..rings are the top hemisphere (pole to equator, offset +halfCyl);
  // rows rings+1..2*rings+1 are the bottom hemisphere (equator to pole,
  // offset -halfCyl). The equator is present in both, and the quad band
  // between the two equator rows forms the cylindrical mid-section.
  const rowCount = 2 * (rings + 1)
  const stride = segments + 1

  for (let row = 0; row < rowCount; row++) {
    const topHalf = row <= rings
    const t = topHalf ? row / rings : (row - rings - 1) / rings
    const phi = topHalf
      ? t * Math.PI * 0.5
      : Math.PI * 0.5 + t * Math.PI * 0.5
    const yOffset = topHalf ? halfCyl : -halfCyl
    const v = row / (rowCount - 1)

    for (let x = 0; x <= segments; x++) {
      const u = x / segments
      const theta = u * Math.PI * 2

      const nx = -Math.sin(phi) * Math.cos(theta)
      const ny = Math.cos(phi)
      const nz = Math.sin(phi) * Math.sin(theta)

      positions.push(nx * radius, ny * radius + yOffset, nz * radius)
      normals.push(nx, ny, nz)
      uvs.push(u, v)
    }
  }

  for (let row = 0; row < rowCount - 1; row++) {
    for (let x = 0; x < segments; x++) {
      const a = row * stride + x
      const b = a + 1
      const c = a + stride
      const d = c + 1

      // Skip degenerate triangles at the poles
      if (row !== 0) {
        indices.push(a, c, b)
      }
      if (row !== rowCount - 2) {
        indices.push(b, c, d)
      }
    }
  }

  return new Geometry({ positions, normals, uvs, indices })
}

/**
 * Create an icosphere: an icosahedron with each face recursively subdivided
 * and the resulting vertices projected onto the sphere. More uniform triangle
 * sizes than a UV sphere, and no pole pinching.
 * @param {object} opts
 * @param {number} [opts.radius=1]
 * @param {number} [opts.subdivisions=2] - Vertex count is 10 * 4^n + 2
 * @returns {Geometry}
 */
export function createIcosphere({ radius = 1, subdivisions = 2 } = {}) {
  const t = (1 + Math.sqrt(5)) / 2

  const normalize = (v) => {
    const len = Math.hypot(v[0], v[1], v[2])
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0]
  }

  // Regular icosahedron: three mutually perpendicular golden rectangles
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ].map(normalize)

  let tris = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ]

  const midpointCache = new Map()
  const getMidpoint = (a, b) => {
    const key = `${Math.min(a, b)}_${Math.max(a, b)}`
    const cached = midpointCache.get(key)
    if (cached !== undefined) return cached

    const va = verts[a]
    const vb = verts[b]
    const idx = verts.length
    verts.push(normalize([
      (va[0] + vb[0]) / 2,
      (va[1] + vb[1]) / 2,
      (va[2] + vb[2]) / 2
    ]))
    midpointCache.set(key, idx)
    return idx
  }

  for (let s = 0; s < subdivisions; s++) {
    const next = []
    for (const [a, b, c] of tris) {
      const ab = getMidpoint(a, b)
      const bc = getMidpoint(b, c)
      const ca = getMidpoint(c, a)
      // All four children keep the parent's counter-clockwise winding
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    tris = next
  }

  const positions = []
  const normals = []
  const uvs = []

  for (const v of verts) {
    positions.push(v[0] * radius, v[1] * radius, v[2] * radius)
    normals.push(v[0], v[1], v[2])
    // Spherical mapping. Vertices are shared across the seam, so the u wrap
    // is discontinuous there — fine for lighting, approximate for texturing.
    uvs.push(
      0.5 + Math.atan2(v[2], v[0]) / (Math.PI * 2),
      0.5 - Math.asin(Math.max(-1, Math.min(1, v[1]))) / Math.PI
    )
  }

  const indices = []
  for (const [a, b, c] of tris) indices.push(a, b, c)

  return new Geometry({ positions, normals, uvs, indices })
}
