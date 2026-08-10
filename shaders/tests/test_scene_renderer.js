import assert from 'assert'
import { SceneRenderer } from '../src/rendering/scene-renderer.js'
import { MeshRenderer } from '../src/rendering/mesh-renderer.js'

import { SceneTree } from '../src/scene/tree.js'

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
    async compileProgram(id) { this.programs.add(id) },
    executePass(pass, state) { this.passes.push(pass); this.lastFrameState = state },
    beginFrame() { this.frames++ },
    endFrame() { this.framesEnded++ },
    uploadMeshData() { return { success: true } }
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
    getWorldMatrix: () => new Float32Array(16)
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
    getWorldMatrix: () => new Float32Array(16)
  }
  const object = {
    id: 'object',
    meshType: 'box',
    meshParams: {},
    getWorldMatrix: () => new Float32Array(16)
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

  const planarMeshes = backend.passes.filter(p => p.id === 'scene_planar_mesh_pass')
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

console.log('Scene renderer tests passed')
