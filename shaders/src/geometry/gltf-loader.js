import { Geometry } from './geometry.js'

// glTF component type to TypedArray mapping
const COMPONENT_TYPES = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
}

// Number of components per accessor type
const TYPE_SIZES = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

/**
 * Parse a JSON glTF file with separate binary buffer(s).
 * @param {object} json - The parsed glTF JSON
 * @param {ArrayBuffer|ArrayBuffer[]} buffers - Binary buffer(s) referenced by the glTF
 * @returns {{ meshes: Array, toGeometries: function }}
 */
export function parseGLTF(json, buffers) {
  const bufferArray = Array.isArray(buffers) ? buffers : [buffers]
  return parseGLTFInternal(json, bufferArray)
}

/**
 * Parse a GLB (binary glTF) file.
 * @param {Uint8Array} data - The raw GLB bytes
 * @returns {{ meshes: Array, toGeometries: function }}
 */
export function parseGLB(data) {
  const buffer = data.buffer.byteLength === data.byteLength
    ? data.buffer
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)

  const headerView = new DataView(buffer)

  // 12-byte header
  const magic = headerView.getUint32(0, true)
  if (magic !== 0x46546C67) {
    throw new Error('Not a valid GLB file (bad magic)')
  }
  const version = headerView.getUint32(4, true)
  if (version !== 2) {
    throw new Error(`Unsupported glTF version: ${version}`)
  }
  // const totalLength = headerView.getUint32(8, true)

  // Parse chunks
  let offset = 12
  let jsonChunk = null
  let binChunk = null

  while (offset < buffer.byteLength) {
    const chunkLength = headerView.getUint32(offset, true)
    const chunkType = headerView.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8

    if (chunkType === 0x4E4F534A) {
      // JSON chunk
      const jsonBytes = new Uint8Array(buffer, chunkDataOffset, chunkLength)
      jsonChunk = JSON.parse(new TextDecoder().decode(jsonBytes))
    } else if (chunkType === 0x004E4942) {
      // BIN chunk
      binChunk = buffer.slice(chunkDataOffset, chunkDataOffset + chunkLength)
    }

    offset = chunkDataOffset + chunkLength
  }

  if (!jsonChunk) {
    throw new Error('GLB missing JSON chunk')
  }

  return parseGLTFInternal(jsonChunk, [binChunk])
}

/**
 * Internal shared implementation for both parseGLB and parseGLTF.
 */
function parseGLTFInternal(jsonChunk, bufferChunks) {
  // Helper: read an accessor's data as a typed array
  function readAccessor(accessorIndex) {
    const accessor = jsonChunk.accessors[accessorIndex]
    const bufferView = jsonChunk.bufferViews[accessor.bufferView]
    const bufferIndex = bufferView.buffer || 0
    const binChunk = bufferChunks[bufferIndex]
    const TypedArrayCtor = COMPONENT_TYPES[accessor.componentType]
    if (!TypedArrayCtor) {
      throw new Error(`Unknown component type: ${accessor.componentType}`)
    }
    const numComponents = TYPE_SIZES[accessor.type]
    if (!numComponents) {
      throw new Error(`Unknown accessor type: ${accessor.type}`)
    }

    const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0)
    const count = accessor.count * numComponents

    // If the buffer view has a stride that differs from tightly packed, we need
    // to manually unpack. For now, handle the common tightly-packed case.
    const byteStride = bufferView.byteStride || 0
    const elementSize = TypedArrayCtor.BYTES_PER_ELEMENT * numComponents

    if (byteStride && byteStride !== elementSize) {
      // Strided access: copy element by element
      const result = new TypedArrayCtor(count)
      for (let i = 0; i < accessor.count; i++) {
        const srcOffset = byteOffset + i * byteStride
        const src = new TypedArrayCtor(binChunk, srcOffset, numComponents)
        result.set(src, i * numComponents)
      }
      return result
    }

    return new TypedArrayCtor(binChunk, byteOffset, count)
  }

  // Extract meshes from all primitives
  const meshes = []

  if (jsonChunk.meshes) {
    for (const mesh of jsonChunk.meshes) {
      for (const primitive of mesh.primitives) {
        const entry = {
          positions: null,
          normals: null,
          uvs: null,
          indices: null,
        }

        // Positions (required)
        if (primitive.attributes.POSITION !== undefined) {
          entry.positions = new Float32Array(readAccessor(primitive.attributes.POSITION))
        }

        // Normals (optional)
        if (primitive.attributes.NORMAL !== undefined) {
          entry.normals = new Float32Array(readAccessor(primitive.attributes.NORMAL))
        }

        // UVs (optional)
        if (primitive.attributes.TEXCOORD_0 !== undefined) {
          entry.uvs = new Float32Array(readAccessor(primitive.attributes.TEXCOORD_0))
        }

        // Indices (optional but common)
        if (primitive.indices !== undefined) {
          const rawIndices = readAccessor(primitive.indices)
          // Normalize to Uint16Array or Uint32Array
          if (rawIndices instanceof Uint16Array || rawIndices instanceof Uint32Array) {
            entry.indices = rawIndices
          } else {
            entry.indices = new Uint32Array(rawIndices)
          }
        }

        meshes.push(entry)
      }
    }
  }

  return {
    meshes,
    toGeometries() {
      return meshes.map(mesh => {
        const positions = mesh.positions
        const indices = mesh.indices || generateIndices(positions.length / 3)
        const normals = mesh.normals || generateNormals(positions, indices)
        const uvs = mesh.uvs || generateUVs(positions)

        return new Geometry({
          positions,
          normals,
          uvs,
          indices: new Uint32Array(indices),
        })
      })
    },
  }
}

/**
 * Generate sequential indices for non-indexed geometry.
 */
function generateIndices(vertexCount) {
  const indices = new Uint32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    indices[i] = i
  }
  return indices
}

/**
 * Generate normals by computing face normals and averaging at shared vertices.
 */
function generateNormals(positions, indices) {
  const vertexCount = positions.length / 3
  const normals = new Float32Array(vertexCount * 3)

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i]
    const i1 = indices[i + 1]
    const i2 = indices[i + 2]

    // Triangle vertices
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2]
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2]
    const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2]

    // Edge vectors
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az

    // Cross product (face normal, not normalized yet -- area-weighted)
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x

    // Accumulate into each vertex of this face
    normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz
    normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz
    normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz
  }

  // Normalize
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2]
    const len = Math.sqrt(x * x + y * y + z * z)
    if (len > 0) {
      normals[i] /= len
      normals[i + 1] /= len
      normals[i + 2] /= len
    } else {
      // Degenerate -- default to +Y
      normals[i] = 0
      normals[i + 1] = 1
      normals[i + 2] = 0
    }
  }

  return normals
}

/**
 * Generate UVs using planar projection as a fallback.
 * Projects onto the XY plane, normalized to [0, 1] based on bounding box.
 */
function generateUVs(positions) {
  const vertexCount = positions.length / 3
  const uvs = new Float32Array(vertexCount * 2)

  // Find bounding box in X and Y
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const rangeX = maxX - minX || 1
  const rangeY = maxY - minY || 1

  for (let i = 0; i < vertexCount; i++) {
    uvs[i * 2] = (positions[i * 3] - minX) / rangeX
    uvs[i * 2 + 1] = (positions[i * 3 + 1] - minY) / rangeY
  }

  return uvs
}
