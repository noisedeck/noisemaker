import assert from 'assert'
import { parseGLB } from '../src/geometry/gltf-loader.js'
import { Geometry } from '../src/geometry/geometry.js'

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

console.log('glTF loader tests passed')
