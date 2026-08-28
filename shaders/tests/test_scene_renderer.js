import assert from 'assert'
import { readFileSync } from 'fs'
import { SceneRenderer } from '../src/rendering/scene-renderer.js'
import { MeshRenderer } from '../src/rendering/mesh-renderer.js'

import { SceneTree } from '../src/scene/tree.js'

/**
 * The world matrix an untransformed node actually produces.
 *
 * An all-zero Float32Array — what these mocks used to hand back — is singular,
 * so it now (correctly) trips the singular-transform fallback and its warning.
 * Identity is what a real SceneNode with no transform yields.
 */
const IDENTITY_WORLD = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/**
 * Minimal backend stub recording the passes SceneRenderer submits.
 * Enough surface for initialize() and render() to run headlessly.
 */
function stubBackend() {
  return {
    type: 'webgl2',
    passes: [],
    textures: new Map(),
    programs: new Set(),
    textureSpecs: new Map(),
    cubeTextureSpecs: new Map(),
    frames: 0,
    framesEnded: 0,
    lastFrameState: null,
    createTexture(id, spec) {
      this.textures.set(id, { handle: id })
      this.textureSpecs.set(id, spec)
    },
    createCubeTexture(id, spec) {
      this.textures.set(id, { handle: id, cube: true })
      this.cubeTextureSpecs.set(id, spec)
    },
    destroyTexture(id) { this.textures.delete(id) },
    clearedTextures: [],
    clearTexture(id) { this.clearedTextures.push(id) },
    async compileProgram(id) { this.programs.add(id) },
    executePass(pass, state) { this.passes.push(pass); this.lastFrameState = state },
    beginFrame() { this.frames++ },
    endFrame() { this.framesEnded++ },
    uploadMeshData(meshId) {
      // Mirrors the real backends: three textures per distinct geometry.
      for (const suffix of ['positions', 'normals', 'uvs']) {
        this.textures.set(`global_${meshId}_${suffix}`, { handle: meshId })
      }
      return { success: true }
    }
  }
}

// A configured reflection probe is captured entirely on the GPU before the
// main deferred pass. Each cube face reuses the probe G-buffer, and the main
// view samples the completed cube while probe lighting itself remains
// non-recursive.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    {
      reflectionProbe: [0, 2, -1],
      reflectionProbeSize: 64,
      reflections: 0.8
    }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  assert.deepStrictEqual(
    backend.cubeTextureSpecs.get('scene_reflection_probe'),
    { size: 64, format: 'rgba16f', usage: ['render', 'sample'] },
    'probe allocates an HDR renderable cube'
  )
  const probeLighting = backend.passes.filter(p => p.id.startsWith('scene_probe_lighting_face_'))
  assert.strictEqual(probeLighting.length, 6, 'all six cube faces are captured')
  assert.deepStrictEqual(probeLighting.map(p => p.cubeFace), [0, 1, 2, 3, 4, 5], 'GL cube face order')
  assert.ok(probeLighting.every(p => p.outputs.color0 === 'scene_reflection_probe'), 'lighting writes cube texture')
  assert.ok(probeLighting.every(p => p.uniforms.u_probeEnabled === 0), 'probe does not recursively sample itself')
  const mainLighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.ok(backend.passes.indexOf(probeLighting[5]) < backend.passes.indexOf(mainLighting), 'probe completes before main lighting')
  assert.strictEqual(mainLighting.inputs.u_reflectionProbe, 'scene_reflection_probe', 'main PBR samples probe')
  assert.strictEqual(mainLighting.uniforms.u_probeEnabled, 1, 'probe specular enabled')

  backend.passes.length = 0
  await renderer.render(tree, { elapsed: 0.016 }, 'scene_color')
  const dynamicProbeLighting = backend.passes.filter(p => p.id.startsWith('scene_probe_lighting_face_'))
  assert.strictEqual(dynamicProbeLighting.length, 1, 'dynamic probe amortizes to one face per frame after initialization')
  assert.strictEqual(dynamicProbeLighting[0].cubeFace, 0, 'dynamic updates begin at +X')
}

// Existing DSL programs remain unchanged: no configured probe means no six-view
// capture and deferred PBR samples the initialized cube fallback with the probe
// branch disabled.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  await renderer.render(
    treeWithLights([{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }]),
    { elapsed: 0 },
    'scene_color'
  )
  assert.ok(!backend.passes.some(p => p.id.startsWith('scene_probe_')), 'no probe capture by default')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.strictEqual(lighting.inputs.u_reflectionProbe, 'scene_reflection_probe_fallback')
  assert.strictEqual(lighting.uniforms.u_probeEnabled, 0)
}

async function makeRenderer() {
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 1000, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    settings: { ambient: 0.1 },
    materials: {},
    nodes: []
  })
  return { renderer, backend, tree, clock: { elapsed: 0 } }
}

// Scene targets remain readable on WebGPU so the visual/parity harness can
// inspect the planar source and final composite, not merely the canvas.
{
  const { backend } = await makeRenderer()
  for (const [id, spec] of backend.textureSpecs) {
    assert.ok(spec.usage.includes('copySrc'), `${id} must support readPixels()`)
  }
}

// SceneRenderer class exists and has expected API
{
  assert.strictEqual(typeof SceneRenderer, 'function')
  // Constructor takes backend and existingPipeline
  const renderer = new SceneRenderer(null, null)
  assert.strictEqual(typeof renderer.initialize, 'function')
  assert.strictEqual(typeof renderer.resize, 'function')
  assert.strictEqual(typeof renderer.render, 'function')
}

// MeshRenderer class exists and has expected API
{
  assert.strictEqual(typeof MeshRenderer, 'function')
  const mr = new MeshRenderer(null)
  assert.strictEqual(typeof mr.getGeometry, 'function')
  assert.strictEqual(typeof mr.buildMeshPasses, 'function')
}

// SceneRenderer initializes GBufferConfig on initialize()
{
  const renderer = new SceneRenderer(null, null)
  assert.strictEqual(renderer._initialized, false)
  assert.strictEqual(renderer.gbufferConfig, null)
  await renderer.initialize(1920, 1080)
  assert.strictEqual(renderer._initialized, true)
  assert.ok(renderer.gbufferConfig !== null)
  assert.strictEqual(renderer.gbufferConfig.width, 1920)
  assert.strictEqual(renderer.gbufferConfig.height, 1080)
}

// SceneRenderer resize updates GBufferConfig dimensions
{
  const renderer = new SceneRenderer(null, null)
  await renderer.initialize(800, 600)
  renderer.resize(1024, 768)
  assert.strictEqual(renderer.gbufferConfig.width, 1024)
  assert.strictEqual(renderer.gbufferConfig.height, 768)
}

// SceneRenderer creates sub-renderers
{
  const renderer = new SceneRenderer(null, null)
  assert.ok(renderer.meshRenderer instanceof MeshRenderer)
}

// MeshRenderer.getGeometry returns null for unknown mesh types
{
  const mr = new MeshRenderer(null)
  const result = mr.getGeometry('nonexistent', {})
  assert.strictEqual(result, null)
}

// MeshRenderer.getGeometry returns handle even without backend (still creates geometry)
{
  const mr = new MeshRenderer(null)
  const result = mr.getGeometry('sphere', {})
  assert.ok(result, 'returns handle even without backend')
  assert.ok(result.vertexCount > 0, 'has vertex count')
}

// MeshRenderer generates correct passes
{
  // Mock backend that records calls
  const uploaded = []
  const mockBackend = {
    uploadMeshData(meshId, posData, normData, uvData, w, h, count) {
      uploaded.push({ meshId, w, h, count })
      return { success: true, vertexCount: count }
    }
  }

  const renderer = new MeshRenderer(mockBackend)

  // Get geometry + upload for a sphere
  const handle = renderer.getGeometry('sphere', { segments: 8 })
  assert.ok(handle, 'geometry created')
  assert.ok(uploaded.length > 0, 'uploadMeshData was called')
  assert.ok(uploaded[0].count > 0, 'has vertex count')

  // Build a pass
  const mockCamera = {
    getViewMatrix: () => new Float32Array(16),
    getProjectionMatrix: () => new Float32Array(16),
    _position: [0, 0, 5]
  }
  const mockNode = {
    id: 'test_mesh',
    meshType: 'sphere',
    meshParams: { segments: 8 },
    materialId: 'mat_0',
    getWorldMatrix: () => IDENTITY_WORLD
  }
  const mockMaterials = {
    mat_0: { baseColor: [1, 0, 0], pbr: { metallic: 0.5, roughness: 0.3 } }
  }

  const passes = renderer.buildMeshPasses([mockNode], mockMaterials, mockCamera, 800, 600)
  assert.ok(passes.length === 1, 'one pass for one mesh')
  const pass = passes[0]
  assert.strictEqual(pass.program, 'scene_mesh_gbuf', 'correct program')
  assert.strictEqual(pass.drawMode, 'triangles', 'triangle draw mode')
  assert.strictEqual(pass.drawBuffers, 4, '4 MRT outputs')
  assert.ok(pass.uniforms.u_modelMatrix, 'has model matrix')
  assert.ok(pass.inputs.u_positions, 'has position texture input')
}

// Reflection geometry can target an isolated G-buffer, omit the receiver,
// clip the hidden half-space, and request two-sided rasterization.
{
  const renderer = new MeshRenderer(null)
  const camera = {
    getViewMatrix: () => new Float32Array(16),
    getProjectionMatrix: () => new Float32Array(16)
  }
  const reflector = {
    id: 'floor',
    meshType: 'plane',
    meshParams: {},
    getWorldMatrix: () => IDENTITY_WORLD
  }
  const object = {
    id: 'object',
    meshType: 'box',
    meshParams: {},
    getWorldMatrix: () => IDENTITY_WORLD
  }
  const outputs = {
    color0: 'planar_albedo',
    color1: 'planar_normal',
    color2: 'planar_position',
    color3: 'planar_depth'
  }
  const passes = renderer.buildMeshPasses(
    [reflector, object],
    {},
    camera,
    800,
    600,
    {
      outputs,
      passId: 'scene_planar_mesh_pass',
      excludeNode: reflector,
      clipPlane: [0, 1, 0, 0.6],
      cullMode: 'none'
    }
  )
  assert.strictEqual(passes.length, 1, 'reflector is omitted from mirrored render')
  assert.strictEqual(passes[0].id, 'scene_planar_mesh_pass')
  assert.deepStrictEqual(passes[0].outputs, outputs)
  assert.strictEqual(passes[0].clear, true, 'first included mesh clears reflection G-buffer')
  assert.deepStrictEqual(passes[0].uniforms.u_clipPlane, [0, 1, 0, 0.6])
  assert.strictEqual(passes[0].uniforms.u_clipEnabled, 1)
  assert.strictEqual(passes[0].cullMode, 'none')
}

// SceneRenderer builds full frame pass sequence
{
  const textures = new Map()
  const programs = new Map()
  const executedPasses = []

  const mockBackend = {
    type: 'webgl2',
    createTexture(id, spec) { textures.set(id, spec) },
    destroyTexture(id) { textures.delete(id) },
    async compileProgram(id, spec) { programs.set(id, spec) },
    executePass(pass) { executedPasses.push(pass) },
    beginFrame() {},
    endFrame() {},
    uploadMeshData(meshId, p, n, u, w, h, c) { return { success: true, vertexCount: c } }
  }

  const renderer = new SceneRenderer(mockBackend, null)
  await renderer.initialize(800, 600)

  // Verify G-buffer textures were created
  assert.ok(textures.has('scene_gbuf_albedo_metallic'), 'albedo texture created')
  assert.ok(textures.has('scene_gbuf_depth'), 'depth texture created')
  assert.ok(textures.has('scene_lit_color'), 'lit color texture created')

  // Verify shaders were compiled
  assert.ok(programs.has('scene_mesh_gbuf'), 'mesh shader compiled')
  assert.ok(programs.has('scene_present'), 'present shader compiled')

  // Build a minimal scene and render
  const ir = {
    camera: { fov: 60, near: 0.1, far: 1000, position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] },
    lights: [{ type: 'point', position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 2 }],
    nodes: [
      { id: 'box1', type: 'mesh', parent: null, meshType: 'box', meshParams: {},  material: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }
    ],
    sdfs: [],
    procedurals: [],
    materials: {},
    settings: { background: [0, 0, 0], ambient: 0.1 }
  }
  const tree = SceneTree.fromIR(ir)
  await renderer.render(tree, { delta: 0.016, elapsed: 0, frame: 0 })

  // Should have: mesh pass + lighting pass + present pass (no post, no SDF)
  assert.ok(executedPasses.length >= 3, `expected >= 3 passes, got ${executedPasses.length}`)
  const meshPass = executedPasses.find(p => p.drawMode === 'triangles')
  assert.ok(meshPass, 'has a mesh pass')
  const lightingPass = executedPasses.find(p => p.program === 'scene_lighting')
  assert.ok(lightingPass, 'has a lighting pass')
  const presentPass = executedPasses.find(p => p.program === 'scene_tonemap_present')
  assert.ok(presentPass, 'has a present pass')
}

// Present pass honours an explicit render target
{
  const { renderer, backend, tree, clock } = await makeRenderer()
  await renderer.render(tree, clock, 'scene_color')
  const present = backend.passes.find(p => p.id === 'scene_tonemap_present')
  assert.ok(present, 'present pass executed')
  assert.strictEqual(present.outputs.color, 'scene_color', 'present targets the texture')
}

// Default target is still the screen
{
  const { renderer, backend, tree, clock } = await makeRenderer()
  await renderer.render(tree, clock)
  const present = backend.passes.find(p => p.id === 'scene_tonemap_present')
  assert.strictEqual(present.outputs.color, 'screen', 'default target is screen')
}

// Targeting a texture does not disturb the G-buffer or lighting stages
{
  const { renderer, backend, tree, clock } = await makeRenderer()
  await renderer.render(tree, clock, 'scene_color')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.ok(lighting, 'lighting pass still runs')
  assert.strictEqual(lighting.outputs.color0, 'scene_lit_color', 'lighting still writes lit colour')
}

// Scene passes are bracketed in a backend frame (WebGPU needs the encoder)
{
  const { renderer, backend, tree, clock } = await makeRenderer()
  await renderer.render(tree, clock, 'scene_color')
  assert.strictEqual(backend.frames, 1, 'beginFrame called once')
  assert.strictEqual(backend.framesEnded, 1, 'endFrame called once')
}

// --- Material feed ---

function treeWithMaterial(material) {
  return SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 1000, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    settings: {},
    materials: { m0: material },
    nodes: [{ id: 'n0', type: 'mesh', meshType: 'box', meshParams: {}, material: 'm0', transform: {}, children: [], parent: null }]
  })
}

// A surface-sourced material binds the surface texture as albedo
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithMaterial({ baseColor: [1, 1, 1], albedoSurface: 'o2', pbr: { metallic: 0.5, roughness: 0.5 }, emission: 0 })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const mesh = backend.passes.find(p => p.program === 'scene_mesh_gbuf')
  assert.ok(mesh, 'mesh pass built')
  assert.strictEqual(mesh.inputs.u_albedoTexture, 'global_o2', 'surface bound as albedo')
  assert.strictEqual(mesh.uniforms.u_hasAlbedoTexture, 1, 'albedo flag on')
}

// A solid material binds the fallback albedo with the flag off — the mesh
// program is shared across passes, so the sampler unit must be assigned
// deterministically every pass (stale units cause GL feedback errors).
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithMaterial({ baseColor: [1, 0, 0], pbr: { metallic: 0, roughness: 1 }, emission: 0 })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const mesh = backend.passes.find(p => p.program === 'scene_mesh_gbuf')
  assert.strictEqual(mesh.uniforms.u_hasAlbedoTexture, 0, 'albedo flag off')
  assert.strictEqual(mesh.inputs.u_albedoTexture, 'scene_albedo_fallback', 'fallback bound')
}

// Emission strength flows to the G-buffer pass
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithMaterial({ baseColor: [1, 1, 1], pbr: { metallic: 0, roughness: 1 }, emission: 2.5 })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const mesh = backend.passes.find(p => p.program === 'scene_mesh_gbuf')
  assert.strictEqual(mesh.uniforms.u_emissionStrength, 2.5, 'emission flows')
}

// Surface tint/UV controls and safe PBR bounds reach the mesh pass
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithMaterial({
    baseColor: [0.8, 0.6, 0.4],
    albedoSurface: 'o2',
    uvScale: [3, -2],
    uvOffset: [0.25, 0.5],
    pbr: { metallic: 2, roughness: 0 },
    emission: -3
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const u = backend.passes.find(p => p.program === 'scene_mesh_gbuf').uniforms
  assert.deepStrictEqual(u.u_baseColor, [0.8, 0.6, 0.4, 1], 'surface tint feeds base color')
  assert.deepStrictEqual(u.u_uvScale, [3, -2], 'uvScale flows')
  assert.deepStrictEqual(u.u_uvOffset, [0.25, 0.5], 'uvOffset flows')
  assert.strictEqual(u.u_metallic, 1, 'programmatic metallic clamps to one')
  assert.strictEqual(u.u_roughness, 0.045, 'zero roughness clamps above the GGX singularity')
  assert.strictEqual(u.u_emissionStrength, 0, 'negative emission clamps to zero')
}

// Malformed programmatic IR falls back to finite material uniforms
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithMaterial({
    baseColor: [Number.NaN, 0, 0],
    uvScale: 'bad',
    uvOffset: [Number.POSITIVE_INFINITY, 0],
    pbr: { metallic: Number.NaN, roughness: Number.POSITIVE_INFINITY },
    emission: Number.NaN
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const u = backend.passes.find(p => p.program === 'scene_mesh_gbuf').uniforms
  assert.deepStrictEqual(u.u_baseColor, [1, 1, 1, 1], 'invalid tint falls back white')
  assert.deepStrictEqual(u.u_uvScale, [1, 1], 'invalid uvScale falls back one')
  assert.deepStrictEqual(u.u_uvOffset, [0, 0], 'invalid uvOffset falls back zero')
  assert.strictEqual(u.u_metallic, 0, 'invalid metallic falls back zero')
  assert.strictEqual(u.u_roughness, 1, 'invalid roughness falls back one')
  assert.strictEqual(u.u_emissionStrength, 0, 'invalid emission falls back zero')
}

// Pipeline surfaces are injected into the scene frame state (read side)
{
  const backend = stubBackend()
  const fakePipeline = { surfaces: new Map([['o2', { read: 'ptex_o2_a', write: 'ptex_o2_b' }]]) }
  backend.textures.set('ptex_o2_a', { handle: 'H_o2_read' })
  const renderer = new SceneRenderer(backend, fakePipeline)
  await renderer.initialize(320, 240)
  const tree = treeWithMaterial({ baseColor: [1, 1, 1], albedoSurface: 'o2', pbr: { metallic: 0, roughness: 1 }, emission: 0 })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  assert.ok(backend.lastFrameState.surfaces, 'frame state has surfaces')
  assert.strictEqual(backend.lastFrameState.surfaces.o2.handle, 'H_o2_read', 'read texture injected under surface name')
}

// --- Lighting v2 ---

function treeWithLights(lights, settings = {}) {
  return SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 1000, position: [0, 0, 5], target: [0, 0, 0] },
    lights,
    settings,
    materials: {},
    nodes: [{ id: 'n0', type: 'mesh', meshType: 'box', meshParams: {}, transform: {}, children: [], parent: null }]
  })
}

// Spot light uniforms: explicit type, direction, and cone cosines
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights([
    { type: 'spot', position: [0, 5, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 4, falloff: 1, angle: 30, penumbra: 0.2 }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  const u = lighting.uniforms
  assert.strictEqual(u['u_lights[0].lightType'], 2, 'spot type = 2')
  assert.deepStrictEqual(u['u_lights[0].direction'], [0, -1, 0], 'spot direction')
  const cosInner = Math.cos(30 * Math.PI / 180)
  const cosOuter = Math.cos(30 * 1.2 * Math.PI / 180)
  assert.ok(Math.abs(u['u_lights[0].cosInner'] - cosInner) < 1e-6, 'inner cone cosine')
  assert.ok(Math.abs(u['u_lights[0].cosOuter'] - cosOuter) < 1e-6, 'outer cone cosine')
}

// Directional and point map to types 1 and 0, position carries the payload
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights([
    { type: 'directional', direction: [1, -1, 0], color: [1, 1, 1], intensity: 2 },
    { type: 'point', position: [3, 2, 1], color: [1, 0, 0], intensity: 3, falloff: 1 }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const u = backend.passes.find(p => p.id === 'scene_lighting').uniforms
  assert.strictEqual(u['u_lights[0].lightType'], 1, 'directional type = 1')
  assert.deepStrictEqual(u['u_lights[0].direction'], [1, -1, 0], 'directional direction field')
  assert.strictEqual(u['u_lights[1].lightType'], 0, 'point type = 0')
  assert.deepStrictEqual(u['u_lights[1].position'], [3, 2, 1], 'point position')
}

// Hemisphere ambient: scalar ambient produces equal sky/ground (back-compat)
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    { ambient: 0.3 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const u = backend.passes.find(p => p.id === 'scene_lighting').uniforms
  assert.deepStrictEqual(u.u_skyColor, [0.3, 0.3, 0.3], 'scalar ambient -> sky')
  assert.deepStrictEqual(u.u_groundColor, [0.3, 0.3, 0.3], 'scalar ambient -> ground')
}

// Explicit sky/ground override the scalar
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    { ambient: 0.3, sky: [0.4, 0.6, 1.0], ground: [0.3, 0.2, 0.1] }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const u = backend.passes.find(p => p.id === 'scene_lighting').uniforms
  assert.deepStrictEqual(u.u_skyColor, [0.4, 0.6, 1.0], 'explicit sky')
  assert.deepStrictEqual(u.u_groundColor, [0.3, 0.2, 0.1], 'explicit ground')
}

// Background and point/spot falloff are real lighting controls
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [
      { type: 'point', position: [0, 2, 0], color: [1, 1, 1], intensity: 3, falloff: 0 },
      { type: 'spot', position: [0, 5, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 4 }
    ],
    { background: [0.02, 0.03, 0.05] }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const u = backend.passes.find(p => p.id === 'scene_lighting').uniforms
  assert.deepStrictEqual(u.u_backgroundColor, [0.02, 0.03, 0.05], 'background reaches lighting')
  assert.strictEqual(u['u_lights[0].falloff'], 0, 'explicit zero disables distance falloff')
  assert.strictEqual(u['u_lights[1].falloff'], 1, 'omitted falloff defaults to one')
}

// Exposure reaches the tonemap pass, default 1
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    { exposure: 1.8 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const tonemap = backend.passes.find(p => p.id === 'scene_tonemap_present')
  assert.strictEqual(tonemap.uniforms.u_exposure, 1.8, 'exposure flows')

  const backend2 = stubBackend()
  const renderer2 = new SceneRenderer(backend2, null)
  await renderer2.initialize(320, 240)
  await renderer2.render(treeWithLights([{ type: 'point', position: [0, 1, 0], color: [1, 1, 1], intensity: 1, falloff: 0 }]), { elapsed: 0 }, 'scene_color')
  const tonemap2 = backend2.passes.find(p => p.id === 'scene_tonemap_present')
  assert.strictEqual(tonemap2.uniforms.u_exposure, 1, 'exposure defaults to 1')
}

// --- SSAO ---

// Default settings run an SSAO pass before lighting, feeding it
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights([{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const ids = backend.passes.map(p => p.id)
  const ssaoIdx = ids.indexOf('scene_ssao_pass')
  const lightIdx = ids.indexOf('scene_lighting')
  assert.ok(ssaoIdx !== -1, 'ssao pass present by default')
  assert.ok(ssaoIdx < lightIdx, 'ssao runs before lighting')
  const ssao = backend.passes[ssaoIdx]
  assert.strictEqual(ssao.outputs.color, 'scene_ssao', 'ssao writes its texture')
  assert.strictEqual(ssao.uniforms.u_radius, 0.75, 'default radius')
  assert.ok(ssao.uniforms.u_viewProj, 'view-projection supplied')
  const lighting = backend.passes[lightIdx]
  assert.strictEqual(lighting.inputs.u_ssao, 'scene_ssao', 'lighting consumes ssao')
  assert.strictEqual(lighting.uniforms.u_ssaoStrength, 1, 'default strength 1')
}

// ssao: 0 skips the pass entirely and neutralizes the strength
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    { ssao: 0 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  assert.ok(!backend.passes.some(p => p.id === 'scene_ssao_pass'), 'no ssao pass at ssao: 0')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.strictEqual(lighting.uniforms.u_ssaoStrength, 0, 'strength 0 disables in shader')
}

// ssaoRadius flows through
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    { ssaoRadius: 1.5, ssao: 0.6 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const ssao = backend.passes.find(p => p.id === 'scene_ssao_pass')
  assert.strictEqual(ssao.uniforms.u_radius, 1.5, 'radius flows')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.strictEqual(lighting.uniforms.u_ssaoStrength, 0.6, 'strength flows')
}

// --- SSR + environment ---

// Default settings run SSR between lighting and tonemap; tonemap reads it
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights([{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const ids = backend.passes.map(p => p.id)
  const ssrIdx = ids.indexOf('scene_ssr_pass')
  assert.ok(ssrIdx !== -1, 'ssr pass present by default')
  assert.ok(ids.indexOf('scene_lighting') < ssrIdx, 'ssr after lighting')
  assert.ok(ssrIdx < ids.indexOf('scene_tonemap_present'), 'ssr before tonemap')
  const ssr = backend.passes[ssrIdx]
  assert.strictEqual(ssr.inputs.u_litColor, 'scene_lit_color', 'ssr reads lit color')
  assert.strictEqual(ssr.outputs.color, 'scene_reflect_color', 'ssr writes reflect texture')
  assert.strictEqual(ssr.uniforms.u_reflStrength, 1, 'default strength')
  const tonemap = backend.passes.find(p => p.id === 'scene_tonemap_present')
  assert.strictEqual(tonemap.inputs.u_texture, 'scene_reflect_color', 'tonemap reads ssr output')
}

// reflections: 0 skips SSR and tonemap reads lit color directly
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights(
    [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    { reflections: 0 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  assert.ok(!backend.passes.some(p => p.id === 'scene_ssr_pass'), 'no ssr pass at reflections: 0')
  const tonemap = backend.passes.find(p => p.id === 'scene_tonemap_present')
  assert.strictEqual(tonemap.inputs.u_texture, 'scene_lit_color', 'tonemap reads lit directly')
}

// An explicit reflector renders an isolated mirrored scene and composites it
// before SSR; the receiver itself is omitted from both mirrored geometry and
// SSR so screen-space artifacts cannot fill its underhangs.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  assert.ok(backend.textures.has('scene_planar_gbuf_albedo_metallic'), 'planar G-buffer allocated')
  assert.ok(backend.textures.has('scene_planar_lit'), 'planar lighting target allocated')

  const tree = SceneTree.fromIR({
    camera: {
      fov: 52,
      near: 0.1,
      far: 1000,
      position: [0, 3.2, -8.5],
      target: [0, 0.6, 0],
      up: [0, 1, 0]
    },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    settings: { reflections: 0.65 },
    materials: {
      floor: { baseColor: [0.6, 0.6, 0.6], pbr: { metallic: 0.9, roughness: 0.2 } }
    },
    nodes: [
      {
        id: 'floor',
        type: 'mesh',
        meshType: 'plane',
        meshParams: { width: 20, height: 20 },
        material: 'floor',
        planarReflection: true,
        transform: { position: [0, -0.6, 0] },
        parent: null,
        children: []
      },
      {
        id: 'box',
        type: 'mesh',
        meshType: 'box',
        meshParams: {},
        transform: { position: [0, 0, 0] },
        parent: null,
        children: []
      }
    ]
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const planarMeshes = backend.passes.filter(p => p.program === 'scene_mesh_gbuf' && p.id === 'scene_planar_gbuf_pass')
  assert.strictEqual(planarMeshes.length, 1, 'only the non-reflector mesh is mirrored')
  assert.strictEqual(planarMeshes[0].outputs.color0, 'scene_planar_gbuf_albedo_metallic')
  assert.strictEqual(planarMeshes[0].uniforms.u_clipEnabled, 1)
  assert.strictEqual(planarMeshes[0].cullMode, 'none')

  const planarLighting = backend.passes.find(p => p.id === 'scene_planar_lighting')
  assert.ok(planarLighting, 'mirrored G-buffer is lit')
  assert.strictEqual(planarLighting.inputs.u_normalRoughness, 'scene_planar_gbuf_normal_roughness')
  assert.strictEqual(planarLighting.outputs.color0, 'scene_planar_lit')
  assert.ok(Math.abs(planarLighting.uniforms.u_cameraPos[1] - -4.4) < 1e-5, 'camera position mirrors across floor')

  const ssr = backend.passes.find(p => p.id === 'scene_ssr_pass')
  assert.strictEqual(ssr.inputs.u_litColor, 'scene_lit_color')
  assert.strictEqual(ssr.inputs.u_planarReflection, 'scene_planar_lit', 'reflection stage samples mirrored lighting')
  assert.strictEqual(ssr.uniforms.u_reflStrength, 0.65)
  assert.strictEqual(ssr.uniforms.u_reflectionViewProj, renderer._reflectionViewProj)
  assert.strictEqual(ssr.uniforms.u_planarEnabled, 1, 'SSR suppresses the planar receiver')
  assert.ok(Math.abs(ssr.uniforms.u_planePoint[1] - -0.6) < 1e-5)
}

// The global reflection switch disables both SSR and the extra planar render.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { position: [0, 3, -5], target: [0, 0, 0] },
    lights: [],
    settings: { reflections: 0 },
    materials: {},
    nodes: [{
      id: 'floor',
      type: 'mesh',
      meshType: 'plane',
      meshParams: {},
      planarReflection: true,
      transform: {},
      parent: null,
      children: []
    }]
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  assert.ok(!backend.passes.some(p => p.id.startsWith('scene_planar_')), 'no planar work at reflections: 0')
}

// An environment surface feeds the single deferred IBL stage. SSR adds only
// valid local hits and must not double the environment contribution.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 1000, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    settings: {},
    materials: {},
    nodes: [{ id: 'n0', type: 'mesh', meshType: 'box', meshParams: {}, transform: {}, children: [], parent: null }],
    environment: { surface: 'o3', intensity: 0.5 }
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.strictEqual(lighting.inputs.u_envTexture, 'global_o3', 'lighting samples environment')
  assert.strictEqual(lighting.uniforms.u_envIntensity, 0.5, 'env intensity flows to lighting')
  const ssr = backend.passes.find(p => p.id === 'scene_ssr_pass')
  assert.ok(!('u_envTexture' in ssr.inputs), 'ssr does not resample the environment')
  assert.ok(!('u_envIntensity' in ssr.uniforms), 'ssr does not double environment intensity')
}

// Without an environment the intensity is zero and a fallback is bound
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = treeWithLights([{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const lighting = backend.passes.find(p => p.id === 'scene_lighting')
  assert.strictEqual(lighting.uniforms.u_envIntensity, 0, 'no env -> intensity 0')
  assert.strictEqual(lighting.inputs.u_envTexture, 'scene_albedo_fallback', 'fallback bound for the declaration')
}

// No pass may declare more draw buffers than its program writes outputs.
//
// The zero-mesh G-buffer clears drew a fullscreen triangle with scene_present,
// which declares a single @location(0) output, against drawBuffers: 4. WebGPU
// rejects that pipeline outright at interface-matching; WebGL2 accepts it and
// leaves attachments 1-3 undefined rather than cleared, so the lighting pass
// then reads garbage normals and positions.
{
  const FRAGMENT_OUTPUTS = { scene_present: 1, scene_tonemap: 1 }
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)

  // A scene with lights but no meshes takes every zero-mesh clear path.
  const tree = treeWithLights([{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }])
  tree.getMeshNodes = () => []
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  for (const pass of backend.passes) {
    const outputs = FRAGMENT_OUTPUTS[pass.program]
    if (outputs === undefined) continue
    const declared = pass.drawBuffers ?? 1
    assert.ok(declared <= outputs,
      `pass '${pass.id}' declares drawBuffers: ${declared} but program '${pass.program}' writes ${outputs} output(s)`)
  }

  // And the G-buffer is genuinely cleared rather than partly overwritten.
  assert.ok(backend.clearedTextures.length >= 4,
    `expected the four G-buffer targets to be cleared, got ${JSON.stringify(backend.clearedTextures)}`)
}

// Mesh passes state their cull mode explicitly.
//
// Left undefined, the two backends disagree by default: WebGL2 enables
// CULL_FACE and culls back faces, while the WebGPU MRT pipeline sets no
// cullMode at all and so renders double-sided. Every G-buffer fill is MRT, so
// the whole scene was single-sided on one backend and double-sided on the
// other, which changes normals, SSAO and reflections downstream.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    materials: [],
    settings: {},
    nodes: [{ id: 'n0', type: 'mesh', meshType: 'box', meshParams: {}, transform: {}, children: [], parent: null }]
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const meshPass = backend.passes.find(p => p.program === 'scene_mesh_gbuf')
  assert.ok(meshPass, 'a mesh G-buffer pass was submitted')
  assert.ok(meshPass.cullMode !== undefined,
    'mesh passes must state cullMode explicitly so both backends agree')
  assert.strictEqual(meshPass.cullMode, 'back', 'default matches WebGL2 back-face culling')
}

// Mesh passes are built once per node and mutated, not reallocated per frame.
//
// The project bans per-frame allocation in render loops, and Pipeline builds
// its passes once at compile time. buildMeshPasses rebuilt everything on every
// frame instead: a full JSON.stringify of the mesh params per mesh even on the
// geometry cache-hit path, a mat4.create for the normal matrix, four template
// literals for texture names, an array spread for the base colour, and three
// object literals.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    materials: [],
    settings: {},
    nodes: [
      { id: 'a', type: 'mesh', meshType: 'box', meshParams: {}, transform: {}, children: [], parent: null },
      { id: 'b', type: 'mesh', meshType: 'sphere', meshParams: { radius: 2 }, transform: {}, children: [], parent: null }
    ]
  })
  const meshNodes = tree.getMeshNodes()
  const camera = tree.camera

  const first = renderer.meshRenderer.buildMeshPasses(meshNodes, [], camera, 320, 240, {})
  const second = renderer.meshRenderer.buildMeshPasses(meshNodes, [], camera, 320, 240, {})

  assert.strictEqual(first.length, 2, 'two mesh passes')
  for (let i = 0; i < first.length; i++) {
    assert.strictEqual(first[i], second[i], `pass ${i} must be reused between frames, not rebuilt`)
    assert.strictEqual(first[i].uniforms, second[i].uniforms, `pass ${i} uniforms must be reused`)
    assert.strictEqual(first[i].uniforms.u_normalMatrix, second[i].uniforms.u_normalMatrix,
      `pass ${i} normal matrix must be written into a reused buffer`)
    assert.strictEqual(first[i].inputs, second[i].inputs, `pass ${i} inputs must be reused`)
  }
}

// dispose() releases the mesh geometry textures too.
//
// It destroyed only ALL_TEXTURES and the probe targets, never the
// global_<meshId>_{positions,normals,uvs} uploaded per distinct geometry. The
// renderer is reused across recompiles on the same backend, so editing
// mesh("sphere", segments: N) interned a new cache entry and three new
// textures for every distinct N, for the lifetime of the backend.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    materials: [],
    settings: {},
    nodes: [{ id: 'a', type: 'mesh', meshType: 'box', meshParams: {}, transform: {}, children: [], parent: null }]
  })
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const meshTextures = [...backend.textures.keys()].filter(id => /_positions$|_normals$|_uvs$/.test(id))
  assert.ok(meshTextures.length >= 3, `precondition: geometry textures were uploaded (${meshTextures.length})`)

  renderer.dispose()

  const leaked = [...backend.textures.keys()].filter(id => /_positions$|_normals$|_uvs$/.test(id))
  assert.deepStrictEqual(leaked, [], `dispose() left mesh geometry textures behind: ${leaked.join(', ')}`)
}

const GBUF_OUTPUTS = {
  color0: 'scene_gbuf_albedo_metallic',
  color1: 'scene_gbuf_normal_roughness',
  color2: 'scene_gbuf_position_emission',
  color3: 'scene_gbuf_depth'
}

const PLANAR_GBUF_OUTPUTS = {
  color0: 'scene_planar_gbuf_albedo_metallic',
  color1: 'scene_planar_gbuf_normal_roughness',
  color2: 'scene_planar_gbuf_position_emission',
  color3: 'scene_planar_gbuf_depth'
}

const PROBE_GBUF_OUTPUTS = {
  color0: 'scene_probe_gbuf_albedo_metallic',
  color1: 'scene_probe_gbuf_normal_roughness',
  color2: 'scene_probe_gbuf_position_emission',
  color3: 'scene_probe_gbuf_depth'
}

const PLANAR_PASS_ID = 'scene_planar_gbuf_pass'

function volumeTree(nodes, materials = {}, settings = {}) {
  return SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    materials,
    settings,
    nodes
  })
}

/** A reflector plane under a volume, the fixture every Phase 4 case shares. */
function reflectedVolumeTree(extraNodes = [], settings = {}) {
  return volumeTree([
    {
      id: 'mirror',
      type: 'mesh',
      meshType: 'plane',
      meshParams: { width: 16, height: 16 },
      transform: {},
      planarReflection: true,
      children: [],
      parent: null
    },
    { id: 'cloud', type: 'volume', surface: 'vol0', threshold: 0.5, transform: { position: [0, 1.5, 0] }, children: [], parent: null },
    ...extraNodes
  ], {}, settings)
}

// A volume is not a mesh, but it does reach the G-buffer: its bounding box is
// rasterized as a triangles MRT pass so both backends attach a depth buffer,
// and the marcher fills the same four targets a mesh fills.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'cloud', type: 'volume', surface: 'vol3', threshold: 0.4, transform: {}, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  assert.strictEqual(tree.getMeshNodes().length, 0, 'a volume is never a mesh node')
  assert.strictEqual(tree.getVolumeNodes().length, 1, 'the volume is reachable on its own accessor')
  assert.deepStrictEqual(
    backend.passes.filter(p => p.program === 'scene_mesh_gbuf'), [],
    'no mesh pass is built for a volume node')

  assert.ok(backend.programs.has('scene_volume_gbuf'), 'the volume fill program is compiled up front')

  const volumePasses = backend.passes.filter(p => p.program === 'scene_volume_gbuf')
  assert.strictEqual(volumePasses.length, 1, 'one pass per volume node')
  const pass = volumePasses[0]
  assert.strictEqual(pass.drawMode, 'triangles', 'triangles is what buys the depth attachment on both backends')
  assert.strictEqual(pass.cullMode, 'front',
    'back faces only: one fragment per pixel, and still drawn with the camera inside the box')
  assert.strictEqual(pass.drawBuffers, 4, 'writes the whole G-buffer')
  assert.strictEqual(pass.count, 36, 'a non-indexed unit box')
  assert.deepStrictEqual(pass.outputs, GBUF_OUTPUTS, 'the same four targets the mesh pass writes')
  assert.strictEqual(pass.inputs.u_volumeAtlas, 'global_vol3', 'binds the node\'s own atlas')
  assert.ok(/^global_scene_mesh_\d+_positions$/.test(pass.inputs.u_positions), 'box geometry from the shared cache')
  assert.ok(/^global_scene_mesh_\d+_normals$/.test(pass.inputs.u_normals), 'box normals bound')
  assert.ok(/^global_scene_mesh_\d+_uvs$/.test(pass.inputs.u_uvs), 'box uvs bound')
  assert.strictEqual(pass.uniforms.u_threshold, 0.4, 'the node\'s iso level reaches the marcher')
  assert.strictEqual(pass.uniforms.u_mode, 0, 'a node with no mode marches the smooth isosurface')
  assert.strictEqual(pass.uniforms.u_volumeSize, 64, 'the global vol atlases are 64 cubed')
  assert.strictEqual(pass.uniforms.u_invModelMatrix.length, 16, 'world -> local for the ray')
  assert.strictEqual(pass.uniforms.u_normalMatrix.length, 16, 'local -> world for the gradient')
  assert.deepStrictEqual(
    Array.from(pass.uniforms.u_cameraPos), [0, 0, 5],
    'the ray origin is the camera')

  // A volume-only scene must clear the G-buffer exactly once, and the volume
  // pass itself is what does it — clearTexture would land ahead of the frame's
  // recorded work on WebGPU.
  assert.strictEqual(pass.clear, true, 'the first content pass clears')
  assert.deepStrictEqual(backend.clearedTextures, [], 'no separate zero-content clear when a volume drew')

  assert.ok(backend.passes.some(p => p.id === 'scene_lighting'), 'the frame still completes')
  assert.ok(
    backend.passes.indexOf(pass) < backend.passes.findIndex(p => p.id === 'scene_lighting'),
    'the volume fills the G-buffer before lighting reads it')
}

// mode reaches the marcher as u_mode, and it is per NODE — not per program.
// Two volumes in one scene with different modes must produce two passes of the
// SAME program carrying different uniform values, or the second would silently
// march the first one's algorithm.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'blocky', type: 'volume', surface: 'vol0', threshold: 0.5, mode: 'voxel', transform: {}, children: [], parent: null },
    { id: 'smooth', type: 'volume', surface: 'vol1', threshold: 0.5, mode: 'smooth', transform: {}, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const volumePasses = backend.passes.filter(p => p.program === 'scene_volume_gbuf')
  assert.strictEqual(volumePasses.length, 2, 'one pass per volume node')
  assert.deepStrictEqual(
    volumePasses.map(p => p.program), ['scene_volume_gbuf', 'scene_volume_gbuf'],
    'mode is a uniform, not a second program')
  assert.deepStrictEqual(
    volumePasses.map(p => p.uniforms.u_mode), [1, 0],
    'each node carries its own mode into the uniform')

  // The pass-state reuse pattern is what makes that non-trivial: uniforms
  // objects are rewritten in place per frame, so a mode written once and never
  // rewritten would leak into the next node reusing the same state.
  const modes = new Set(volumePasses.map(p => p.uniforms))
  assert.strictEqual(modes.size, 2, 'the two nodes hold distinct uniform objects')
}

// An unknown mode string can only arrive from a hand-built tree — the compiler
// rejects it — and must not become an out-of-range uniform the shader branches
// on unpredictably.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'odd', type: 'volume', surface: 'vol0', threshold: 0.5, mode: 'blocky', transform: {}, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  const pass = backend.passes.find(p => p.program === 'scene_volume_gbuf')
  assert.strictEqual(pass.uniforms.u_mode, 0, 'an unrecognized mode falls back to the smooth default')
}

// Volume passes run after mesh passes, and only the very first pass into the
// G-buffer clears it. Depth handles the real compositing; the order is fixed so
// the clear decision is deterministic.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'ground', type: 'mesh', meshType: 'plane', meshParams: {}, transform: {}, children: [], parent: null },
    { id: 'cloud', type: 'volume', surface: 'vol1', threshold: 0.5, transform: {}, children: [], parent: null },
    { id: 'smoke', type: 'volume', surface: 'vol2', threshold: 0.5, transform: {}, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const gbufPasses = backend.passes.filter(
    p => p.program === 'scene_mesh_gbuf' || p.program === 'scene_volume_gbuf'
  )
  assert.deepStrictEqual(
    gbufPasses.map(p => p.program),
    ['scene_mesh_gbuf', 'scene_volume_gbuf', 'scene_volume_gbuf'],
    'volumes execute after meshes into the same G-buffer')
  assert.deepStrictEqual(
    gbufPasses.map(p => p.clear), [true, false, false],
    'only the first content pass clears')
  assert.deepStrictEqual(
    gbufPasses.map(p => p.outputs), [GBUF_OUTPUTS, GBUF_OUTPUTS, GBUF_OUTPUTS],
    'one G-buffer, one depth attachment')
  // Not cosmetic: the WebGL2 backend keys its MRT framebuffer — and therefore
  // the depth renderbuffer attached to it — on `mrt_${pass.id}_${outputs}`.
  // Distinct ids over identical outputs gave mesh and volume passes separate
  // depth buffers, so the volume tested against depth the mesh never wrote and
  // vanished entirely on WebGL2 while rendering correctly on WebGPU (which keys
  // its depth texture by size).
  assert.strictEqual(
    new Set(gbufPasses.map(p => p.id)).size, 1,
    `mesh and volume passes must share one framebuffer: ${gbufPasses.map(p => p.id).join(', ')}`)
  assert.deepStrictEqual(
    gbufPasses.slice(1).map(p => p.inputs.u_volumeAtlas), ['global_vol1', 'global_vol2'],
    'each volume binds its own atlas')
  assert.deepStrictEqual(backend.clearedTextures, [], 'the mesh pass already cleared')
}

// A volume belongs in the planar reflection: the mirrored G-buffer is a second
// view of the whole scene, not a mesh-only one. Same mirrored camera, same
// planar targets, same clip plane — and the SAME pass id the planar mesh passes
// use, because the WebGL2 MRT framebuffer (and the depth renderbuffer hanging
// off it) is keyed on `mrt_${pass.id}_${outputs}`.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = reflectedVolumeTree([
    { id: 'box', type: 'mesh', meshType: 'box', meshParams: {}, transform: { position: [0, 1.5, 0] }, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const mainVolume = backend.passes.filter(
    p => p.program === 'scene_volume_gbuf' && p.outputs.color0 === GBUF_OUTPUTS.color0
  )
  assert.strictEqual(mainVolume.length, 1, 'still exactly one volume pass into the main G-buffer')

  const planarPasses = backend.passes.filter(p => p.id === PLANAR_PASS_ID)
  const planarVolume = planarPasses.filter(p => p.program === 'scene_volume_gbuf')
  assert.strictEqual(planarVolume.length, 1, 'the volume is drawn into the mirrored G-buffer too')
  const pass = planarVolume[0]
  assert.deepStrictEqual(pass.outputs, PLANAR_GBUF_OUTPUTS, 'into the planar targets')
  assert.strictEqual(pass.id, PLANAR_PASS_ID,
    'the planar volume pass shares the planar mesh pass id, or it gets its own depth buffer')
  assert.strictEqual(
    new Set(planarPasses.map(p => p.id)).size, 1,
    'one framebuffer, one depth buffer, for the whole mirrored G-buffer group')
  assert.strictEqual(pass.uniforms.u_clipEnabled, 1, 'the reflector plane clips the march')
  assert.strictEqual(pass.uniforms.u_clipPlane, renderer._clipPlane, 'and it is the reflector\'s own plane')
  assert.deepStrictEqual(
    Array.from(pass.uniforms.u_cameraPos),
    Array.from(renderer._reflectionCamera._position),
    'the marched ray starts at the mirrored eye')
  // Derived, not copied from the mesh path: the reflection camera is built by
  // lookAt from mirrored position/target/up, which is a proper rigid transform
  // (det +1), so nothing about the mirrored view flips triangle winding. Back
  // faces stay back faces, and 'front' remains both one-fragment-per-pixel and
  // robust to the mirrored eye landing inside the box.
  assert.strictEqual(pass.cullMode, 'front', 'the mirrored view does not flip the box winding')

  // Exactly one clear across the whole mirrored group, and it is a draw, not a
  // clearTexture — the mesh drew first here.
  assert.deepStrictEqual(
    planarPasses.map(p => p.clear), [true, false],
    'the first planar pass clears and no other does')
  assert.ok(
    !backend.clearedTextures.some(id => id.startsWith('scene_planar_')),
    'no separate zero-content clear when the mirrored group drew')
}

// The mirrored group's clear is a property of the GROUP, not of the mesh list:
// a reflector with nothing but a volume above it must still clear exactly once,
// and the volume pass is what does it.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  await renderer.render(reflectedVolumeTree(), { elapsed: 0 }, 'scene_color')

  const planarPasses = backend.passes.filter(p => p.id === PLANAR_PASS_ID)
  assert.strictEqual(planarPasses.length, 1, 'the reflector itself is excluded, so only the volume is mirrored')
  assert.strictEqual(planarPasses[0].program, 'scene_volume_gbuf')
  assert.strictEqual(planarPasses[0].clear, true, 'the volume pass is the first into the mirrored G-buffer')
  assert.ok(
    !backend.clearedTextures.some(id => id.startsWith('scene_planar_')),
    'a volume that drew must suppress the zero-content clear')
}

// ...and with neither, the zero-content branch still fires exactly once.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'mirror', type: 'mesh', meshType: 'plane', meshParams: {}, transform: {}, planarReflection: true, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  assert.deepStrictEqual(
    backend.clearedTextures.filter(id => id.startsWith('scene_planar_')),
    Object.values(PLANAR_GBUF_OUTPUTS),
    'nothing mirrored, so the four planar targets are zeroed directly')
}

// The probe is six views of the scene. Volumes come along on every face, into
// that face's own G-buffer group.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree(
    [
      { id: 'ground', type: 'mesh', meshType: 'plane', meshParams: {}, transform: {}, children: [], parent: null },
      { id: 'cloud', type: 'volume', surface: 'vol0', threshold: 0.5, transform: {}, children: [], parent: null }
    ],
    {},
    { reflectionProbe: [0, 1, 0], reflectionProbeSize: 64 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  for (let face = 0; face < 6; face++) {
    const id = `scene_probe_gbuf_face_${face}`
    const facePasses = backend.passes.filter(p => p.id === id)
    assert.deepStrictEqual(
      facePasses.map(p => p.program), ['scene_mesh_gbuf', 'scene_volume_gbuf'],
      `face ${face} fills its G-buffer from meshes AND volumes`)
    assert.deepStrictEqual(facePasses[1].outputs, PROBE_GBUF_OUTPUTS, `face ${face} volume writes the probe targets`)
    assert.strictEqual(facePasses[1].uniforms.u_clipEnabled, 0, `face ${face} has no clip plane`)
    assert.deepStrictEqual(facePasses.map(p => p.clear), [true, false], `face ${face} clears exactly once`)
  }
  assert.ok(
    !backend.clearedTextures.some(id => id.startsWith('scene_probe_')),
    'no separate zero-content clear when a face drew')

  // Amortization is unchanged: after priming, one face per frame, volumes
  // included.
  backend.passes.length = 0
  await renderer.render(tree, { elapsed: 0.016 }, 'scene_color')
  const drawnFaces = backend.passes.filter(p => /^scene_probe_gbuf_face_\d+$/.test(p.id))
  assert.deepStrictEqual(
    drawnFaces.map(p => p.program), ['scene_mesh_gbuf', 'scene_volume_gbuf'],
    'one face per frame after priming, still carrying the volume')
}

// A probe face with only a volume in front of it clears from the volume pass.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree(
    [{ id: 'cloud', type: 'volume', surface: 'vol0', threshold: 0.5, transform: {}, children: [], parent: null }],
    {},
    { reflectionProbe: [0, 0, 0], reflectionProbeSize: 32 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')
  for (let face = 0; face < 6; face++) {
    const facePasses = backend.passes.filter(p => p.id === `scene_probe_gbuf_face_${face}`)
    assert.deepStrictEqual(facePasses.map(p => p.clear), [true], `face ${face}: the volume pass clears`)
  }
  assert.ok(
    !backend.clearedTextures.some(id => id.startsWith('scene_probe_')),
    'a volume that drew must suppress the zero-content clear')
}

// A scene with a reflector, a probe and a volume builds all three G-buffer
// groups, and each group is internally consistent.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = reflectedVolumeTree(
    [{ id: 'ball', type: 'mesh', meshType: 'sphere', meshParams: {}, transform: { position: [2, 1, 0] }, children: [], parent: null }],
    { reflectionProbe: [0, 1.5, 0], reflectionProbeSize: 32 }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const volumePasses = backend.passes.filter(p => p.program === 'scene_volume_gbuf')
  assert.strictEqual(volumePasses.length, 8, 'main + planar + six probe faces')
  const byOutputs = new Map()
  for (const pass of volumePasses) {
    const key = pass.outputs.color0
    byOutputs.set(key, (byOutputs.get(key) || 0) + 1)
  }
  assert.strictEqual(byOutputs.get(GBUF_OUTPUTS.color0), 1)
  assert.strictEqual(byOutputs.get(PLANAR_GBUF_OUTPUTS.color0), 1)
  assert.strictEqual(byOutputs.get(PROBE_GBUF_OUTPUTS.color0), 6)

  // Each variant is a distinct, reused pass object: one pass mutated across
  // variants would carry the last variant's outputs into every earlier one.
  assert.strictEqual(new Set(volumePasses).size, 8, 'one pass object per variant, not one object reused across variants')
  assert.strictEqual(new Set(volumePasses.map(p => p.id)).size, 8, 'and one pass id per variant')
}

// Material uniforms on a volume are the mesh material set. surface() albedo is
// rejected upstream, so a volume never carries an albedo texture.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree(
    [{ id: 'cloud', type: 'volume', surface: 'vol0', threshold: 0.5, material: 'mat0', transform: {}, children: [], parent: null }],
    { mat0: { baseColor: [0.2, 0.7, 0.3], pbr: { metallic: 0.4, roughness: 0.25 }, emission: 1.5 } }
  )
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const pass = backend.passes.find(p => p.program === 'scene_volume_gbuf')
  assert.deepStrictEqual(pass.uniforms.u_baseColor, [0.2, 0.7, 0.3, 1], 'solid() colour')
  assert.strictEqual(pass.uniforms.u_metallic, 0.4)
  assert.strictEqual(pass.uniforms.u_roughness, 0.25)
  assert.strictEqual(pass.uniforms.u_emissionStrength, 1.5)
  assert.strictEqual(pass.uniforms.u_hasMaterial, 1, 'the material replaces the atlas-derived albedo')
  assert.strictEqual(pass.inputs.u_albedoTexture, undefined, 'a volume has no UVs and no albedo texture')
}

// Without a material the marcher falls back to the atlas RGB, so the shader
// needs to know which case it is in.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'cloud', type: 'volume', surface: 'vol0', threshold: 0.5, transform: {}, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const pass = backend.passes.find(p => p.program === 'scene_volume_gbuf')
  assert.strictEqual(pass.uniforms.u_hasMaterial, 0, 'no material: atlas RGB drives albedo')
  assert.strictEqual(pass.uniforms.u_metallic, 0, 'internMaterial defaults')
  assert.strictEqual(pass.uniforms.u_roughness, 1)
  assert.strictEqual(pass.uniforms.u_emissionStrength, 0)
}

// Volume passes follow the mesh convention: built once per node and rewritten
// in place. Rebuilding them per frame allocated matrices, texture-name strings
// and three object literals per volume per frame.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'a', type: 'volume', surface: 'vol0', threshold: 0.5, transform: {}, children: [], parent: null },
    { id: 'b', type: 'volume', surface: 'vol1', threshold: 0.6, transform: {}, children: [], parent: null }
  ])
  const volumeNodes = tree.getVolumeNodes()
  const camera = tree.camera

  const first = renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, camera, 320, 240, {})
  const second = renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, camera, 320, 240, {})

  assert.strictEqual(first.length, 2, 'two volume passes')
  for (let i = 0; i < first.length; i++) {
    assert.strictEqual(first[i], second[i], `pass ${i} must be reused between frames, not rebuilt`)
    assert.strictEqual(first[i].uniforms, second[i].uniforms, `pass ${i} uniforms must be reused`)
    assert.strictEqual(first[i].inputs, second[i].inputs, `pass ${i} inputs must be reused`)
    assert.strictEqual(first[i].uniforms.u_invModelMatrix, second[i].uniforms.u_invModelMatrix,
      `pass ${i} inverse world matrix must be written into a reused buffer`)
    assert.strictEqual(first[i].uniforms.u_normalMatrix, second[i].uniforms.u_normalMatrix,
      `pass ${i} normal matrix must be written into a reused buffer`)
    assert.strictEqual(first[i].uniforms.u_baseColor, second[i].uniforms.u_baseColor,
      `pass ${i} base colour must be written into a reused buffer`)
  }
  assert.notStrictEqual(first[0], first[1], 'each node gets its own pass object')
}

// One box for every volume in the program: the geometry cache is shared with
// the mesh renderer, so N volumes upload three textures, not 3N.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'a', type: 'volume', surface: 'vol0', threshold: 0.5, transform: {}, children: [], parent: null },
    { id: 'b', type: 'volume', surface: 'vol1', threshold: 0.5, transform: {}, children: [], parent: null },
    { id: 'c', type: 'volume', surface: 'vol2', threshold: 0.5, transform: {}, children: [], parent: null }
  ])
  await renderer.render(tree, { elapsed: 0 }, 'scene_color')

  const geometryTextures = [...backend.textures.keys()].filter(id => /_positions$|_normals$|_uvs$/.test(id))
  assert.strictEqual(geometryTextures.length, 3, `one shared box, got ${geometryTextures.join(', ')}`)

  const passes = backend.passes.filter(p => p.program === 'scene_volume_gbuf')
  const positionInputs = new Set(passes.map(p => p.inputs.u_positions))
  assert.strictEqual(positionInputs.size, 1, 'all three volumes draw the same box')

  renderer.dispose()
  const leaked = [...backend.textures.keys()].filter(id => /_positions$|_normals$|_uvs$/.test(id))
  assert.deepStrictEqual(leaked, [], `dispose() left the volume box geometry behind: ${leaked.join(', ')}`)
}

// A degenerate scale makes the world matrix singular, and mat4.invert then
// returns null WITHOUT touching its output. For a volume the inverse IS the ray
// transform, so an untouched output means frame 1 marches through a zeroed
// matrix and every later frame silently marches through the PREVIOUS frame's
// transform — a stale image with no signal at all. Fall back to identity and
// say so, once per node, since this sits on the per-frame path.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'flat', type: 'volume', surface: 'vol0', threshold: 0.5,
      transform: { scale: [2, 4, 8] }, children: [], parent: null }
  ])
  const volumeNodes = tree.getVolumeNodes()

  // Frame 1 is healthy, so the reused buffer holds a REAL inverse. Only then
  // does a stale carry-over differ from the identity mat4.create() left there,
  // which is what makes this assertion mean anything.
  const first = renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, tree.camera, 320, 240, {})[0]
  assert.strictEqual(first.uniforms.u_invModelMatrix[0], 0.5, 'precondition: frame 1 inverted cleanly')

  volumeNodes[0].scale = [1, 1, 0]

  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, tree.camera, 320, 240, {})
    renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, tree.camera, 320, 240, {})
  } finally {
    console.warn = realWarn
  }

  const pass = renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, tree.camera, 320, 240, {})[0]
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  assert.deepStrictEqual(
    Array.from(pass.uniforms.u_invModelMatrix), IDENTITY,
    'a singular volume transform falls back to identity, not an untouched buffer')
  assert.deepStrictEqual(
    Array.from(pass.uniforms.u_normalMatrix), IDENTITY,
    'the normal matrix follows the same fallback')
  assert.strictEqual(warnings.length, 1, `warn once per node across frames, got ${warnings.length}`)
  assert.ok(warnings[0].includes('flat'), `the warning names the node: ${warnings[0]}`)
  assert.ok(warnings[0].includes('1,1,0') || warnings[0].includes('1, 1, 0'),
    `the warning names the degenerate scale: ${warnings[0]}`)
}

// Same hazard on the mesh side: a singular world matrix leaves the normal
// matrix untouched, so lighting reads the previous frame's normals.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = SceneTree.fromIR({
    camera: { fov: 60, near: 0.1, far: 100, position: [0, 0, 5], target: [0, 0, 0] },
    lights: [{ type: 'directional', direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
    materials: {},
    settings: {},
    nodes: [{ id: 'squashed', type: 'mesh', meshType: 'box', meshParams: {},
      transform: { scale: [2, 4, 8] }, children: [], parent: null }]
  })
  const meshNodes = tree.getMeshNodes()

  const healthy = renderer.meshRenderer.buildMeshPasses(meshNodes, {}, tree.camera, 320, 240, {})[0]
  assert.strictEqual(healthy.uniforms.u_normalMatrix[0], 0.5, 'precondition: frame 1 inverted cleanly')
  meshNodes[0].scale = [1, 1, 0]

  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    renderer.meshRenderer.buildMeshPasses(meshNodes, {}, tree.camera, 320, 240, {})
    renderer.meshRenderer.buildMeshPasses(meshNodes, {}, tree.camera, 320, 240, {})
  } finally {
    console.warn = realWarn
  }

  const pass = renderer.meshRenderer.buildMeshPasses(meshNodes, {}, tree.camera, 320, 240, {})[0]
  assert.deepStrictEqual(
    Array.from(pass.uniforms.u_normalMatrix), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    'a singular mesh transform falls back to an identity normal matrix')
  assert.strictEqual(warnings.length, 1, `warn once per node across frames, got ${warnings.length}`)
  assert.ok(warnings[0].includes('squashed'), `the warning names the node: ${warnings[0]}`)
}

// The no-material path must not allocate. `mat.pbr || {}` and
// `materials[id] || {}` each minted a fresh object per node per frame; shared
// frozen empties cost nothing and cannot be written through.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  const tree = volumeTree([
    { id: 'a', type: 'volume', surface: 'vol0', threshold: 0.5, transform: {}, children: [], parent: null }
  ])
  const volumeNodes = tree.getVolumeNodes()

  for (const source of [
    readFileSync(new URL('../src/rendering/volume-renderer.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/rendering/mesh-renderer.js', import.meta.url), 'utf8')
  ]) {
    assert.ok(source.includes('const EMPTY_MATERIAL = Object.freeze({})'),
      'a module-level frozen empty material')
    assert.ok(source.includes('const EMPTY_PBR = Object.freeze({})'),
      'a module-level frozen empty pbr block')
    assert.ok(!/const mat = .*\|\|\s*\{\}/.test(source),
      'the material fallback is the shared frozen empty, not a fresh literal')
    assert.ok(!/const pbr = .*\|\|\s*\{\}/.test(source),
      'the pbr fallback is the shared frozen empty, not a fresh literal')
  }

  // And the defaults the frozen empties feed through are unchanged.
  const pass = renderer.volumeRenderer.buildVolumePasses(volumeNodes, {}, tree.camera, 320, 240, {})[0]
  assert.strictEqual(pass.uniforms.u_hasMaterial, 0)
  assert.strictEqual(pass.uniforms.u_metallic, 0)
  assert.strictEqual(pass.uniforms.u_roughness, 1)
  assert.deepStrictEqual(Array.from(pass.uniforms.u_baseColor), [1, 1, 1, 1])
}

// An empty scene still clears the G-buffer exactly once — the zero-content
// branch now covers meshes AND volumes.
{
  const backend = stubBackend()
  const renderer = new SceneRenderer(backend, null)
  await renderer.initialize(320, 240)
  await renderer.render(volumeTree([]), { elapsed: 0 }, 'scene_color')
  assert.deepStrictEqual(
    backend.clearedTextures, Object.values(GBUF_OUTPUTS),
    'nothing drew, so the four targets are zeroed directly')
}

console.log('Scene renderer tests passed')
