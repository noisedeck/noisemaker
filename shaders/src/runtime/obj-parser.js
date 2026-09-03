/**
 * OBJ File Parser
 *
 * Parses Wavefront OBJ format mesh files into the canonical Geometry shape.
 *
 * Supports:
 * - Vertices (v)
 * - Texture coordinates (vt)
 * - Normals (vn)
 * - Faces (f) with vertex/uv/normal indices
 * - Triangulation of quads and n-gons
 */
import { Geometry } from '../geometry/geometry.js'

/**
 * Parse OBJ file content into geometry.
 *
 * OBJ attributes are indexed per-attribute rather than per-vertex, so faces are
 * expanded to triangle soup while parsing; the returned Geometry carries the
 * identity index buffer over that soup.
 * @param {string} objText - Raw OBJ file content
 * @returns {Geometry}
 */
export function parseOBJ(objText) {
    // Raw data arrays (indexed)
    const rawPositions = []  // vec3[]
    const rawNormals = []    // vec3[]
    const rawUVs = []        // vec2[]

    // Expanded triangle data (de-indexed)
    const positions = []
    const normals = []
    const uvs = []

    const lines = objText.split('\n')

    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line.length === 0 || line.startsWith('#')) continue

        const parts = line.split(/\s+/)
        const cmd = parts[0]

        switch (cmd) {
            case 'v': {
                // Vertex position: v x y z [w]
                const x = parseFloat(parts[1]) || 0
                const y = parseFloat(parts[2]) || 0
                const z = parseFloat(parts[3]) || 0
                rawPositions.push([x, y, z])
                break
            }

            case 'vn': {
                // Vertex normal: vn x y z
                const x = parseFloat(parts[1]) || 0
                const y = parseFloat(parts[2]) || 0
                const z = parseFloat(parts[3]) || 0
                rawNormals.push([x, y, z])
                break
            }

            case 'vt': {
                // Texture coordinate: vt u v [w]
                const u = parseFloat(parts[1]) || 0
                const v = parseFloat(parts[2]) || 0
                rawUVs.push([u, v])
                break
            }

            case 'f': {
                // Face: f v1/vt1/vn1 v2/vt2/vn2 v3/vt3/vn3 ...
                // Can be: f v, f v/vt, f v//vn, f v/vt/vn
                const faceVerts = []

                for (let i = 1; i < parts.length; i++) {
                    const indices = parts[i].split('/')

                    // OBJ indices are 1-based, convert to 0-based
                    const vIdx = parseInt(indices[0], 10) - 1
                    const vtIdx = indices[1] ? parseInt(indices[1], 10) - 1 : -1
                    const vnIdx = indices[2] ? parseInt(indices[2], 10) - 1 : -1

                    faceVerts.push({ vIdx, vtIdx, vnIdx })
                }

                // Triangulate the face (fan triangulation for convex polygons)
                // Reverse winding: OBJ CW to OpenGL CCW
                for (let i = 1; i < faceVerts.length - 1; i++) {
                    const v0 = faceVerts[0]
                    const v1 = faceVerts[i]
                    const v2 = faceVerts[i + 1]

                    addVertex(v0)
                    addVertex(v2)
                    addVertex(v1)
                }
                break
            }
        }
    }

    function addVertex(v) {
        // Position (required)
        if (v.vIdx >= 0 && v.vIdx < rawPositions.length) {
            positions.push(...rawPositions[v.vIdx])
        } else {
            positions.push(0, 0, 0)
        }

        // Normal (optional, will be computed later if missing)
        if (v.vnIdx >= 0 && v.vnIdx < rawNormals.length) {
            normals.push(...rawNormals[v.vnIdx])
        } else {
            // Placeholder - will compute face normals if needed
            normals.push(0, 0, 1)
        }

        // UV (optional)
        if (v.vtIdx >= 0 && v.vtIdx < rawUVs.length) {
            uvs.push(...rawUVs[v.vtIdx])
        } else {
            uvs.push(0, 0)
        }
    }

    const vertexCount = positions.length / 3

    // If no normals were provided, compute face normals
    if (rawNormals.length === 0 && vertexCount > 0) {
        computeFaceNormals(positions, normals)
    }

    const indices = new Uint32Array(vertexCount)
    for (let i = 0; i < vertexCount; i++) indices[i] = i

    return new Geometry({
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices
    })
}

/**
 * Compute smooth vertex normals by averaging face normals of adjacent triangles.
 * Vertices sharing the same position get the same averaged normal for smooth shading.
 * @param {number[]} positions - Flat array of xyz positions
 * @param {number[]} normals - Flat array to fill with normals (modified in place)
 */
function computeFaceNormals(positions, normals) {
    const vertexCount = positions.length / 3
    const triangleCount = vertexCount / 3

    // Step 1: Compute face normals for each triangle
    const faceNormals = new Float32Array(triangleCount * 3)
    for (let tri = 0; tri < triangleCount; tri++) {
        const i0 = tri * 9       // v0
        const i1 = i0 + 3        // v2 (second vertex in reversed order)
        const i2 = i0 + 6        // v1 (third vertex in reversed order)

        // Get triangle vertices (a=v0, b=v2, c=v1 in reversed order)
        const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2]
        const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2]
        const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2]

        // Edge vectors for CCW winding: (v2-v0) × (v1-v0) = (b-a) × (c-a)
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az

        // Cross product: e1 × e2 gives outward normal for CCW
        let nx = e1y * e2z - e1z * e2y
        let ny = e1z * e2x - e1x * e2z
        let nz = e1x * e2y - e1y * e2x

        // Normalize
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        if (len > 0.0001) {
            nx /= len
            ny /= len
            nz /= len
        } else {
            nx = 0
            ny = 0
            nz = 1
        }

        faceNormals[tri * 3] = nx
        faceNormals[tri * 3 + 1] = ny
        faceNormals[tri * 3 + 2] = nz
    }

    // Step 2: Build position → accumulated normal map
    // Use a string key for position (rounded to avoid float precision issues)
    const posToNormal = new Map()
    const round = (v) => Math.round(v * 10000) / 10000

    for (let v = 0; v < vertexCount; v++) {
        const px = positions[v * 3]
        const py = positions[v * 3 + 1]
        const pz = positions[v * 3 + 2]
        const key = `${round(px)},${round(py)},${round(pz)}`

        const triIdx = Math.floor(v / 3)
        const fnx = faceNormals[triIdx * 3]
        const fny = faceNormals[triIdx * 3 + 1]
        const fnz = faceNormals[triIdx * 3 + 2]

        if (!posToNormal.has(key)) {
            posToNormal.set(key, { nx: 0, ny: 0, nz: 0, count: 0 })
        }
        const acc = posToNormal.get(key)
        acc.nx += fnx
        acc.ny += fny
        acc.nz += fnz
        acc.count++
    }

    // Step 3: Normalize accumulated normals
    for (const acc of posToNormal.values()) {
        const len = Math.sqrt(acc.nx * acc.nx + acc.ny * acc.ny + acc.nz * acc.nz)
        if (len > 0.0001) {
            acc.nx /= len
            acc.ny /= len
            acc.nz /= len
        } else {
            acc.nx = 0
            acc.ny = 0
            acc.nz = 1
        }
    }

    // Step 4: Assign averaged normals to each vertex
    for (let v = 0; v < vertexCount; v++) {
        const px = positions[v * 3]
        const py = positions[v * 3 + 1]
        const pz = positions[v * 3 + 2]
        const key = `${round(px)},${round(py)},${round(pz)}`

        const acc = posToNormal.get(key)
        normals[v * 3] = acc.nx
        normals[v * 3 + 1] = acc.ny
        normals[v * 3 + 2] = acc.nz
    }
}

/**
 * Load and parse OBJ file from URL
 * @param {string} url - URL to OBJ file
 * @returns {Promise<Geometry>}
 */
export async function loadOBJ(url) {
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to load OBJ: ${response.status} ${response.statusText}`)
    }
    const text = await response.text()
    return parseOBJ(text)
}
