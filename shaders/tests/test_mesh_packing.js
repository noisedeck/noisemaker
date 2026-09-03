// Mesh vertex-data packing: one implementation, one in-memory shape.
//
// Geometry (indexed) is the canonical mesh representation. Every path that
// uploads mesh textures — the OBJ loader on canvas and the scene MeshRenderer —
// goes through Geometry.deindex()/toPackedTextures(). These tests pin the packed
// layout and catch the two paths drifting apart again.
import assert from 'assert'
import { Geometry, meshTextureSize } from '../src/geometry/geometry.js'
import { createBox, createSphere } from '../src/geometry/primitives.js'
import { MeshRenderer } from '../src/rendering/mesh-renderer.js'
import { parseOBJ } from '../src/runtime/obj-parser.js'
import { CanvasRenderer } from '../src/index.js'

function assertSameFloats(actual, expected, label) {
  assert.ok(actual instanceof Float32Array, `${label}: actual is Float32Array`)
  assert.ok(expected instanceof Float32Array, `${label}: expected is Float32Array`)
  assert.strictEqual(actual.length, expected.length, `${label}: same length`)
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Object.is(actual[i], expected[i]),
      `${label}: element ${i} (${actual[i]} !== ${expected[i]})`)
  }
}

// meshTextureSize lays vertices out in a square-ish texel grid
{
  assert.deepStrictEqual(meshTextureSize(36), { texWidth: 6, texHeight: 6 })
  assert.deepStrictEqual(meshTextureSize(84), { texWidth: 10, texHeight: 9 })
  assert.deepStrictEqual(meshTextureSize(1), { texWidth: 1, texHeight: 1 })
  const { texWidth, texHeight } = meshTextureSize(1000)
  assert.ok(texWidth * texHeight >= 1000, 'grid holds every vertex')
}

// Geometry.deindex expands indices into triangle-soup arrays
{
  const geo = new Geometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [2, 1, 0]
  })
  const expanded = geo.deindex()
  assert.strictEqual(expanded.vertexCount, 3, 'deindex vertexCount')
  assertSameFloats(expanded.positions,
    new Float32Array([0, 1, 0, 1, 0, 0, 0, 0, 0]), 'deindex positions')
  assertSameFloats(expanded.uvs, new Float32Array([0, 1, 1, 0, 0, 0]), 'deindex uvs')
}

// Packed layout: RGBA texel per vertex, w=1 valid flag, zero-padded tail
{
  const geo = new Geometry({
    positions: [1, 2, 3],
    normals: [0, 1, 0],
    uvs: [0.25, 0.75],
    indices: [0]
  })
  const packed = geo.toPackedTextures(2, 2)
  assert.strictEqual(packed.vertexCount, 1, 'packed vertexCount')
  assertSameFloats(packed.positionData,
    new Float32Array([1, 2, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'packed positions')
  assertSameFloats(packed.normalData,
    new Float32Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'packed normals')
  assertSameFloats(packed.uvData,
    new Float32Array([0.25, 0.75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'packed uvs')
}

// A geometry built without uvs gets zeroed ones, not NaN.
// deindex() reads uvs[idx * 2]; against an empty array that is undefined, which
// lands in the Float32Array as NaN and uploads garbage to the uv texture.
{
  const geo = new Geometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2]
  })
  assert.strictEqual(geo.uvs.length, geo.vertexCount * 2, 'missing uvs default to two per vertex')
  assertSameFloats(geo.uvs, new Float32Array(6), 'defaulted uvs are zero')

  const expanded = geo.deindex()
  assertSameFloats(expanded.uvs, new Float32Array(6), 'deindexed uvs stay zero, not NaN')

  const packed = geo.toPackedTextures(2, 2)
  assertSameFloats(packed.uvData, new Float32Array(16), 'packed uvs stay zero, not NaN')
}

// Empty geometry packs into a harmless 1x1 zero texel instead of a NaN grid.
// meshTextureSize(0) used to return { texWidth: 0, texHeight: NaN }.
{
  assert.deepStrictEqual(meshTextureSize(0), { texWidth: 1, texHeight: 1 },
    'empty meshes get a 1x1 grid')

  const geo = new Geometry({ positions: [], normals: [], uvs: [], indices: [] })
  const { texWidth, texHeight } = meshTextureSize(geo.deindex().vertexCount)
  const packed = geo.toPackedTextures(texWidth, texHeight)
  assert.strictEqual(packed.vertexCount, 0, 'empty packed vertexCount')
  // One texel, position w=0: the backend reads it as an invalid vertex.
  assertSameFloats(packed.positionData, new Float32Array(4), 'empty positions are one zero texel')
  assertSameFloats(packed.normalData, new Float32Array(4), 'empty normals are one zero texel')
  assertSameFloats(packed.uvData, new Float32Array(4), 'empty uvs are one zero texel')
}

// Meshes larger than the texture grid are truncated, not overflowed
{
  const vertexCount = 5
  const geo = new Geometry({
    positions: new Float32Array(vertexCount * 3).fill(2),
    normals: new Float32Array(vertexCount * 3).fill(0),
    uvs: new Float32Array(vertexCount * 2).fill(0),
    indices: Uint32Array.from({ length: vertexCount }, (_, i) => i)
  })
  const packed = geo.toPackedTextures(2, 2)
  assert.strictEqual(packed.vertexCount, 4, 'truncated to grid capacity')
  assert.strictEqual(packed.positionData.length, 16, 'no overflow past the grid')
}

// The scene MeshRenderer uploads exactly what the shared packing path produces
{
  for (const [meshType, params, factory] of [
    ['box', { size: [2, 3, 4] }, createBox],
    ['sphere', { segments: 7 }, createSphere]
  ]) {
    const uploads = []
    const backend = {
      uploadMeshData(meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount) {
        uploads.push({ meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount })
        return { success: true, vertexCount }
      },
      destroyTexture() {}
    }
    const renderer = new MeshRenderer(backend)
    const handle = renderer.getGeometry(meshType, params)
    assert.strictEqual(uploads.length, 1, `${meshType}: uploaded once`)
    const upload = uploads[0]

    const geo = factory(params)
    const { texWidth, texHeight } = meshTextureSize(geo.deindex().vertexCount)
    const expected = geo.toPackedTextures(texWidth, texHeight)

    assert.strictEqual(upload.texWidth, texWidth, `${meshType}: texWidth`)
    assert.strictEqual(upload.texHeight, texHeight, `${meshType}: texHeight`)
    assert.strictEqual(upload.vertexCount, expected.vertexCount, `${meshType}: vertexCount`)
    assert.strictEqual(handle.vertexCount, expected.vertexCount, `${meshType}: handle vertexCount`)
    assert.strictEqual(handle.texWidth, texWidth, `${meshType}: handle texWidth`)
    assertSameFloats(upload.positionData, expected.positionData, `${meshType}: positions`)
    assertSameFloats(upload.normalData, expected.normalData, `${meshType}: normals`)
    assertSameFloats(upload.uvData, expected.uvData, `${meshType}: uvs`)
  }
}

// parseOBJ produces a Geometry, so the OBJ path packs through the same code
{
  const objText = [
    'v 0 0 0',
    'v 1 0 0',
    'v 0 1 0',
    'vt 0 0',
    'vt 1 0',
    'vt 0 1',
    'vn 0 0 1',
    'f 1/1/1 2/2/1 3/3/1'
  ].join('\n')

  const geo = parseOBJ(objText)
  assert.ok(geo instanceof Geometry, 'parseOBJ returns a Geometry')
  assert.strictEqual(geo.vertexCount, 3, 'OBJ vertexCount')
  assert.strictEqual(geo.indices.length, 3, 'OBJ geometry carries indices')

  // Faces are wound OBJ CW -> GL CCW, so the emitted order is v0, v2, v1.
  const packed = geo.toPackedTextures(2, 2)
  assert.strictEqual(packed.vertexCount, 3, 'OBJ packed vertexCount')
  assertSameFloats(packed.positionData, new Float32Array([
    0, 0, 0, 1,
    0, 1, 0, 1,
    1, 0, 0, 1,
    0, 0, 0, 0   // unused texel: w=0 marks it invalid
  ]), 'OBJ packed positions')
  assertSameFloats(packed.normalData, new Float32Array([
    0, 0, 1, 0,
    0, 0, 1, 0,
    0, 0, 1, 0,
    0, 0, 0, 0
  ]), 'OBJ packed normals')
  assertSameFloats(packed.uvData, new Float32Array([
    0, 0, 0, 0,
    0, 1, 0, 0,
    1, 0, 0, 0,
    0, 0, 0, 0
  ]), 'OBJ packed uvs')
}

// canvas.loadOBJFromString uploads and caches what the shared path packs
{
  const objText = [
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1 1 0',
    'vn 0 0 1',
    'f 1//1 2//1 4//1 3//1'
  ].join('\n')

  const uploads = []
  const renderer = Object.create(CanvasRenderer.prototype)
  renderer._meshCache = new Map()
  renderer._pipeline = {
    backend: {
      uploadMeshData(meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount) {
        uploads.push({ meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount })
        return { success: true, vertexCount }
      }
    }
  }

  const result = await renderer.loadOBJFromString(objText, 'mesh0')
  const expected = parseOBJ(objText).toPackedTextures(256, 256)

  assert.strictEqual(result.success, true, 'loadOBJFromString succeeded')
  assert.strictEqual(result.vertexCount, expected.vertexCount, 'loaded vertexCount')
  assert.strictEqual(uploads.length, 1, 'uploaded once')
  const upload = uploads[0]
  assert.strictEqual(upload.meshId, 'mesh0', 'upload target surface')
  assert.strictEqual(upload.texWidth, 256, 'OBJ meshes use the 256x256 grid')
  assert.strictEqual(upload.texHeight, 256, 'OBJ meshes use the 256x256 grid')
  assertSameFloats(upload.positionData, expected.positionData, 'canvas OBJ positions')
  assertSameFloats(upload.normalData, expected.normalData, 'canvas OBJ normals')
  assertSameFloats(upload.uvData, expected.uvData, 'canvas OBJ uvs')

  const cached = renderer._meshCache.get('mesh0')
  assert.ok(cached, 'mesh cached for context restore')
  assert.strictEqual(cached.width, 256, 'cached width')
  assert.strictEqual(cached.height, 256, 'cached height')
  assert.strictEqual(cached.vertexCount, expected.vertexCount, 'cached vertexCount')
  assertSameFloats(cached.positionData, expected.positionData, 'cached positions')
}

// canvas.loadGLTFFromString packs through the same path as the OBJ loader
//
// The glTF loader parses one Geometry per primitive, so the canvas call site
// merges them before packing — a mesh surface is one vertex buffer. Two
// single-triangle primitives here pin both the merge (indices rebased onto the
// second primitive's vertices) and the shared 256x256 upload grid.
{
  const gltf = {
    asset: { version: '2.0' },
    meshes: [{
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 },
        { attributes: { POSITION: 3, NORMAL: 1 }, indices: 2 }
      ]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: 3, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 12 },
      { buffer: 0, byteOffset: 84, byteLength: 36 }
    ],
    buffers: [{ byteLength: 120 }]
  }

  const bin = new ArrayBuffer(120)
  new Float32Array(bin, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0])
  new Float32Array(bin, 36, 9).set([0, 0, 1, 0, 0, 1, 0, 0, 1])
  new Uint32Array(bin, 72, 3).set([0, 1, 2])
  new Float32Array(bin, 84, 9).set([2, 0, 0, 3, 0, 0, 2, 1, 0])

  const uploads = []
  const renderer = Object.create(CanvasRenderer.prototype)
  renderer._meshCache = new Map()
  renderer._pipeline = {
    backend: {
      uploadMeshData(meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount) {
        uploads.push({ meshId, positionData, normalData, uvData, texWidth, texHeight, vertexCount })
        return { success: true, vertexCount }
      }
    }
  }

  const json = { ...gltf, buffers: [{ byteLength: 120, uri: dataURI(bin) }] }
  const result = await renderer.loadGLTFFromString(JSON.stringify(json), 'mesh1')

  assert.strictEqual(result.success, true, `loadGLTFFromString succeeded (${result.error || ''})`)
  assert.strictEqual(result.vertexCount, 6, 'both primitives reached the surface')
  assert.strictEqual(uploads.length, 1, 'uploaded once')

  const upload = uploads[0]
  assert.strictEqual(upload.meshId, 'mesh1', 'upload target surface')
  assert.strictEqual(upload.texWidth, 256, 'glTF meshes use the same 256x256 grid as OBJ')
  assert.strictEqual(upload.texHeight, 256, 'glTF meshes use the same 256x256 grid as OBJ')

  // The second primitive's vertices land after the first's, so its rebased
  // indices read the x=2..3 triangle rather than re-reading the first.
  const merged = new Geometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: new Float32Array(12),
    indices: [0, 1, 2, 3, 4, 5]
  })
  const expected = merged.toPackedTextures(256, 256)
  assert.strictEqual(upload.vertexCount, expected.vertexCount, 'glTF vertexCount')
  assertSameFloats(upload.positionData, expected.positionData, 'canvas glTF positions')
  assertSameFloats(upload.normalData, expected.normalData, 'canvas glTF normals')

  const cached = renderer._meshCache.get('mesh1')
  assert.ok(cached, 'glTF mesh cached for context restore')
  assert.strictEqual(cached.vertexCount, expected.vertexCount, 'cached glTF vertexCount')
}

/** Encode an ArrayBuffer as the base64 data: URI a JSON glTF embeds. */
function dataURI(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:application/octet-stream;base64,${btoa(binary)}`
}

console.log('test_mesh_packing: all tests passed')
