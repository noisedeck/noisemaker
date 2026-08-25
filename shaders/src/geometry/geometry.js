/**
 * Canonical in-memory mesh representation.
 *
 * Everything that produces mesh data — primitives, procedural generators, the
 * glTF loader, the OBJ parser — returns a Geometry, and everything that uploads
 * mesh data to the GPU goes through deindex()/toPackedTextures(). One shape,
 * one packing entry point.
 */

/**
 * Texel grid dimensions for a de-indexed vertex count.
 * Mesh textures store one vertex per texel in a square-ish 2D grid.
 * @param {number} vertexCount - De-indexed vertex count
 * @returns {{ texWidth: number, texHeight: number }}
 */
export function meshTextureSize(vertexCount) {
  // An empty mesh would divide zero by zero and hand the backend a NaN height.
  // A 1x1 grid is the harmless empty upload: its single texel is zeroed, so its
  // position w is 0 and the shader reads it as an invalid vertex.
  if (!(vertexCount > 0)) return { texWidth: 1, texHeight: 1 }
  const texWidth = Math.ceil(Math.sqrt(vertexCount))
  const texHeight = Math.ceil(vertexCount / texWidth)
  return { texWidth, texHeight }
}

export class Geometry {
  /**
   * @param {object} attrs
   * @param {ArrayLike<number>} attrs.positions - xyz per vertex
   * @param {ArrayLike<number>} attrs.normals - xyz per vertex
   * @param {ArrayLike<number>} [attrs.uvs] - uv per vertex; omitted means a
   *   zeroed uv per vertex, because deindex() reading past a missing uv array
   *   would write undefined (NaN) into the packed uv texture.
   * @param {ArrayLike<number>} attrs.indices
   */
  constructor({ positions, normals, uvs, indices }) {
    this.positions = positions instanceof Float32Array ? positions : new Float32Array(positions)
    this.normals = normals instanceof Float32Array ? normals : new Float32Array(normals)
    this.uvs = uvs?.length
      ? (uvs instanceof Float32Array ? uvs : new Float32Array(uvs))
      : new Float32Array((this.positions.length / 3) * 2)
    this.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices)
  }

  get vertexCount() {
    return this.positions.length / 3
  }

  get triangleCount() {
    return this.indices.length / 3
  }

  /**
   * Expand indexed attributes into flat triangle-soup arrays.
   * The backends draw meshes with drawArrays, so the GPU-side data is always
   * de-indexed.
   * @returns {{
   *   positions: Float32Array,  // xyz per vertex
   *   normals: Float32Array,    // xyz per vertex
   *   uvs: Float32Array,        // uv per vertex
   *   vertexCount: number
   * }}
   */
  deindex() {
    const { positions, normals, uvs, indices } = this
    const vertexCount = indices.length
    const expandedPos = new Float32Array(vertexCount * 3)
    const expandedNorm = new Float32Array(vertexCount * 3)
    const expandedUv = new Float32Array(vertexCount * 2)

    for (let i = 0; i < vertexCount; i++) {
      const idx = indices[i]
      expandedPos[i * 3] = positions[idx * 3]
      expandedPos[i * 3 + 1] = positions[idx * 3 + 1]
      expandedPos[i * 3 + 2] = positions[idx * 3 + 2]
      expandedNorm[i * 3] = normals[idx * 3]
      expandedNorm[i * 3 + 1] = normals[idx * 3 + 1]
      expandedNorm[i * 3 + 2] = normals[idx * 3 + 2]
      expandedUv[i * 2] = uvs[idx * 2]
      expandedUv[i * 2 + 1] = uvs[idx * 2 + 1]
    }

    return {
      positions: expandedPos,
      normals: expandedNorm,
      uvs: expandedUv,
      vertexCount
    }
  }

  /**
   * Pack this geometry into texture-sized arrays for GPU upload.
   * Mesh textures store vertex data in a 2D grid where each texel is one
   * vertex; texels past the vertex count are left zeroed and their position w
   * marks them invalid.
   *
   * @param {number} texWidth - Mesh texture width (e.g., 256)
   * @param {number} texHeight - Mesh texture height (e.g., 256)
   * @returns {{
   *   positionData: Float32Array,  // RGBA32F: xyz, w=1 for valid vertex
   *   normalData: Float32Array,    // RGBA16F: xyz, w=0
   *   uvData: Float32Array,        // RGBA16F: uv, zw=0
   *   vertexCount: number
   * }}
   */
  toPackedTextures(texWidth, texHeight) {
    const { positions, normals, uvs, vertexCount } = this.deindex()
    const pixelCount = texWidth * texHeight

    if (vertexCount > pixelCount) {
      console.warn(`[Geometry] Mesh has ${vertexCount} vertices, but texture can only hold ${pixelCount}. Truncating.`)
    }

    const usedVertices = Math.min(vertexCount, pixelCount)

    // RGBA textures: 4 components per pixel
    const positionData = new Float32Array(pixelCount * 4)
    const normalData = new Float32Array(pixelCount * 4)
    const uvData = new Float32Array(pixelCount * 4)

    for (let i = 0; i < usedVertices; i++) {
      const pi = i * 4
      const vi3 = i * 3
      const vi2 = i * 2

      // Position: xyz, w=1 (valid vertex flag)
      positionData[pi] = positions[vi3]
      positionData[pi + 1] = positions[vi3 + 1]
      positionData[pi + 2] = positions[vi3 + 2]
      positionData[pi + 3] = 1.0  // Valid vertex

      // Normal: xyz, w=0
      normalData[pi] = normals[vi3]
      normalData[pi + 1] = normals[vi3 + 1]
      normalData[pi + 2] = normals[vi3 + 2]

      // UV: uv, zw=0
      uvData[pi] = uvs[vi2]
      uvData[pi + 1] = uvs[vi2 + 1]
    }

    // Texels past usedVertices stay zeroed: position w=0 marks them invalid.

    return {
      positionData,
      normalData,
      uvData,
      vertexCount: usedVertices
    }
  }
}
