import assert from 'assert'
import { parseGLB } from '../src/geometry/gltf-loader.js'
import { Geometry } from '../src/geometry/geometry.js'
import { CanvasRenderer } from '../src/index.js'

// Test with a minimal programmatically-generated GLB
// A GLB is: 12-byte header + JSON chunk + BIN chunk

function buildMinimalGLB() {
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1
      }]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3",
        max: [1, 1, 0], min: [-1, -1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ byteLength: 44 }]
  }

  const jsonStr = JSON.stringify(gltf)
  const jsonPadded = jsonStr + ' '.repeat((4 - (jsonStr.length % 4)) % 4)
  const jsonBytes = new TextEncoder().encode(jsonPadded)

  const binData = new ArrayBuffer(44)
  const floats = new Float32Array(binData, 0, 9)
  floats[0] = 0; floats[1] = 1; floats[2] = 0
  floats[3] = -1; floats[4] = -1; floats[5] = 0
  floats[6] = 1; floats[7] = -1; floats[8] = 0
  const indices = new Uint16Array(binData, 36, 3)
  indices[0] = 0; indices[1] = 1; indices[2] = 2

  const totalLength = 12 + 8 + jsonBytes.length + 8 + 44
  const glb = new ArrayBuffer(totalLength)
  const view = new DataView(glb)

  view.setUint32(0, 0x46546C67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)

  let offset = 12
  view.setUint32(offset, jsonBytes.length, true); offset += 4
  view.setUint32(offset, 0x4E4F534A, true); offset += 4
  new Uint8Array(glb, offset, jsonBytes.length).set(jsonBytes); offset += jsonBytes.length

  view.setUint32(offset, 44, true); offset += 4
  view.setUint32(offset, 0x004E4942, true); offset += 4
  new Uint8Array(glb, offset, 44).set(new Uint8Array(binData))

  return new Uint8Array(glb)
}

// Parse GLB
{
  const glbData = buildMinimalGLB()
  const result = parseGLB(glbData)
  assert.ok(result.meshes.length >= 1, 'has at least one mesh')
  const mesh = result.meshes[0]
  assert.ok(mesh.positions, 'has positions')
  assert.strictEqual(mesh.positions.length, 9, '3 vertices * 3 components')
  assert.ok(mesh.indices, 'has indices')
  assert.strictEqual(mesh.indices.length, 3, '3 indices')
}

// Convert to Geometry
{
  const glbData = buildMinimalGLB()
  const result = parseGLB(glbData)
  const geometries = result.toGeometries()
  assert.ok(geometries.length >= 1)
  assert.ok(geometries[0] instanceof Geometry)
  // Should have generated normals since none were in the GLB
  assert.ok(geometries[0].normals.length > 0, 'has generated normals')
  // Should have generated UVs since none were in the GLB
  assert.ok(geometries[0].uvs.length > 0, 'has generated uvs')
}

// Normalized TEXCOORD_0. Exporters routinely write UVs as normalized
// unsigned shorts: the raw 65535 means 1.0, not 65535.0. Without the
// accessor.normalized rescale the packed uv texture carries five-digit
// garbage and every texture lookup wraps to noise.
function buildNormalizedUvGLB() {
  // 3 vertices: 36 bytes of positions, 12 bytes of unsigned-short UVs
  // (padded to 16), 6 bytes of unsigned-short indices (padded to 8).
  const gltf = {
    asset: { version: '2.0' },
    meshes: [{
      primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC2', normalized: true },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 12 },
      { buffer: 0, byteOffset: 52, byteLength: 6 }
    ],
    buffers: [{ byteLength: 60 }]
  }

  const binData = new ArrayBuffer(60)
  const floats = new Float32Array(binData, 0, 9)
  floats.set([0, 1, 0, -1, -1, 0, 1, -1, 0])
  const uvs = new Uint16Array(binData, 36, 6)
  uvs.set([0, 0, 65535, 0, 0, 65535])
  const indices = new Uint16Array(binData, 52, 3)
  indices.set([0, 1, 2])

  return packGLB(gltf, binData)
}

// A bufferView-less accessor. The spec says such an accessor reads as zeros
// (a sparse accessor then substitutes into it; we do not support sparse, but
// the zero base must not be an exception).
function buildMissingBufferViewGLB() {
  const gltf = {
    asset: { version: '2.0' },
    meshes: [{
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ byteLength: 44 }]
  }

  const binData = new ArrayBuffer(44)
  new Float32Array(binData, 0, 9).set([0, 1, 0, -1, -1, 0, 1, -1, 0])
  new Uint16Array(binData, 36, 3).set([0, 1, 2])

  return packGLB(gltf, binData)
}

/** Wrap a glTF JSON object and a BIN payload into GLB container bytes. */
function packGLB(gltf, binData) {
  const jsonStr = JSON.stringify(gltf)
  const jsonPadded = jsonStr + ' '.repeat((4 - (jsonStr.length % 4)) % 4)
  const jsonBytes = new TextEncoder().encode(jsonPadded)
  const binLength = binData.byteLength

  const totalLength = 12 + 8 + jsonBytes.length + 8 + binLength
  const glb = new ArrayBuffer(totalLength)
  const view = new DataView(glb)

  view.setUint32(0, 0x46546C67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)

  let offset = 12
  view.setUint32(offset, jsonBytes.length, true); offset += 4
  view.setUint32(offset, 0x4E4F534A, true); offset += 4
  new Uint8Array(glb, offset, jsonBytes.length).set(jsonBytes); offset += jsonBytes.length

  view.setUint32(offset, binLength, true); offset += 4
  view.setUint32(offset, 0x004E4942, true); offset += 4
  new Uint8Array(glb, offset, binLength).set(new Uint8Array(binData))

  return new Uint8Array(glb)
}

// Normalized UVs are rescaled to [0, 1], not widened verbatim
{
  const result = parseGLB(buildNormalizedUvGLB())
  const uvs = result.meshes[0].uvs
  assert.ok(uvs, 'has uvs')
  assert.strictEqual(uvs.length, 6, '3 vertices * 2 components')
  const expected = [0, 0, 1, 0, 0, 1]
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(uvs[i] - expected[i]) < 1e-6,
      `normalized uv ${i}: ${uvs[i]} !== ${expected[i]}`)
  }
}

// An accessor without a bufferView reads as zeros rather than throwing
{
  const result = parseGLB(buildMissingBufferViewGLB())
  const normals = result.meshes[0].normals
  assert.ok(normals, 'has normals')
  assert.strictEqual(normals.length, 9, '3 vertices * 3 components')
  for (let i = 0; i < normals.length; i++) {
    assert.strictEqual(normals[i], 0, `bufferView-less normal ${i} is zero`)
  }
  // Geometry conversion must survive the zero normals too.
  assert.ok(result.toGeometries()[0] instanceof Geometry, 'converts to Geometry')
}

// canvas.loadGLTFFromString accepts raw GLB bytes, not only glTF JSON
//
// The JSON branch is pinned in test_mesh_packing alongside the OBJ call site;
// this covers the other half of the sniff, where the leading 'glTF' magic
// routes the same argument to parseGLB.
{
  const uploads = []
  const renderer = Object.create(CanvasRenderer.prototype)
  renderer._meshCache = new Map()
  renderer._pipeline = {
    backend: {
      uploadMeshData(meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount) {
        uploads.push({ meshId, vertexCount })
        return { success: true, vertexCount }
      }
    }
  }

  const result = await renderer.loadGLTFFromString(buildMinimalGLB(), 'mesh2')
  assert.strictEqual(result.success, true, `GLB bytes loaded (${result.error || ''})`)
  assert.strictEqual(result.vertexCount, 3, 'the GLB triangle reached the surface')
  assert.strictEqual(uploads.length, 1, 'uploaded once')
  assert.strictEqual(uploads[0].meshId, 'mesh2', 'upload target surface')

  // A JSON glTF naming an external buffer cannot resolve without a base URL,
  // and says so rather than parsing into empty geometry.
  const external = await renderer.loadGLTFFromString(
    JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'scene.bin' }], meshes: [] }),
    'mesh2')
  assert.strictEqual(external.success, false, 'external buffer without a base URL fails')
  assert.match(external.error, /external/, 'error names the unresolvable reference')
}

console.log('glTF loader tests passed')
