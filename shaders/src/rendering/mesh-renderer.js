// shaders/src/rendering/mesh-renderer.js
import { createSphere, createBox, createPlane, createCylinder, createTorus } from '../geometry/primitives.js'
import { meshTextureSize } from '../geometry/geometry.js'
import { mat4 } from '../scene/math.js'

/**
 * Shared stand-ins for "this node has no material" / "no pbr block".
 *
 * `mat.pbr || {}` and `materials[id] || {}` each minted a fresh object per node
 * per frame on the no-material path. They are only ever read, and freezing them
 * makes that a guarantee rather than a convention.
 */
const EMPTY_MATERIAL = Object.freeze({})
const EMPTY_PBR = Object.freeze({})

const DEFAULT_COLOR = Object.freeze([1, 1, 1])
const DEFAULT_UV_SCALE = Object.freeze([1, 1])
const DEFAULT_UV_OFFSET = Object.freeze([0, 0])
const DEFAULT_CLIP_PLANE = Object.freeze([0, 0, 0, 0])
const DEFAULT_OUTPUTS = Object.freeze({
  color0: 'scene_gbuf_albedo_metallic',
  color1: 'scene_gbuf_normal_roughness',
  color2: 'scene_gbuf_position_emission',
  color3: 'scene_gbuf_depth'
})

/**
 * Pass id shared by every pass that fills the main scene G-buffer — mesh and
 * volume alike.
 *
 * It is not cosmetic. The WebGL2 backend keys its MRT framebuffer cache on
 * `mrt_${pass.id}_${outputIds.join('_')}`, and the depth renderbuffer hangs off
 * the framebuffer. Two passes writing the same four colour targets under
 * DIFFERENT ids therefore get two framebuffers with two independent depth
 * buffers: colour accumulates, depth does not, and the second pass tests
 * against a depth buffer the first never wrote (and, at clear:false, never
 * cleared either). WebGPU does not have this failure mode — it keys its depth
 * texture by size alone — so the two backends silently disagree.
 *
 * Sharing the id puts both renderers on one framebuffer and one depth buffer,
 * which is what "the volume composites against the mesh for free" depends on.
 * Pass variants that genuinely want their own depth — the planar reflection,
 * each probe face — pass their own passId, as they always have.
 */
export const SCENE_GBUFFER_PASS_ID = 'scene_gbuf_pass'

/** Nodes already reported as having a singular world transform. */
const SINGULAR_WARNED = new WeakSet()

/**
 * Invert `modelMatrix` into `out`, falling back to identity when it is singular.
 *
 * gl-matrix's `invert` returns null on a singular matrix and leaves `out`
 * UNTOUCHED. Because these output buffers are reused across frames, an
 * unchecked call does not fail loudly: frame 1 keeps whatever `mat4.create()`
 * left, and every frame after it keeps the PREVIOUS frame's inverse. For a
 * volume that inverse IS the ray transform, so the node quietly renders from a
 * stale camera-relative pose. A degenerate scale — any axis at 0, e.g. a mesh
 * flattened to a card — is the way this is normally reached.
 *
 * Identity is the honest fallback: it draws the untransformed body rather than
 * a lie. The warning is once per node because this sits on the per-frame path.
 * @param {Float32Array} out - Destination matrix, written in every case
 * @param {Float32Array} modelMatrix - World matrix to invert
 * @param {object} node - Node being drawn, for the diagnostic
 * @param {string} kind - 'volume' or 'mesh', for the diagnostic
 * @returns {boolean} Whether the inverse was well-defined
 */
export function invertOrIdentity(out, modelMatrix, node, kind) {
  if (mat4.invert(out, modelMatrix)) return true
  mat4.identity(out)
  if (!SINGULAR_WARNED.has(node)) {
    SINGULAR_WARNED.add(node)
    const scale = Array.isArray(node._scale) ? node._scale.join(', ') : 'unknown'
    console.warn(
      `Scene ${kind} '${node.id}' has a singular world transform (scale [${scale}]) ` +
      'and cannot be inverted; falling back to an identity transform. ' +
      'A scale with a zero axis is the usual cause.'
    )
  }
  return false
}

function finiteVector(value, length, fallback) {
  if (!Array.isArray(value) || value.length !== length) return fallback
  for (let i = 0; i < length; i++) {
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) return fallback
  }
  return value
}

function boundedNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export class MeshRenderer {
  constructor(backend) {
    this.backend = backend
    this._geometryCache = new Map()   // meshType+params -> { texWidth, texHeight, vertexCount, meshId }
    this._geometryKeys = new WeakMap() // meshParams object -> cache key
    this._passStates = new Map()      // passId -> WeakMap<node, reusable pass state>
    this._variantStates = new Map()   // passId -> reusable { passes, viewMatrix, projMatrix }
    this._meshIdCounter = 0
  }

  /**
   * Release every geometry texture this renderer uploaded.
   *
   * Three textures are uploaded per distinct geometry and the cache is never
   * evicted, so without this each recompile with different mesh params — say
   * editing mesh("sphere", segments: N) live — stranded another set for the
   * lifetime of the backend.
   */
  dispose() {
    for (const handle of this._geometryCache.values()) {
      this.backend.destroyTexture(`global_${handle.meshId}_positions`)
      this.backend.destroyTexture(`global_${handle.meshId}_normals`)
      this.backend.destroyTexture(`global_${handle.meshId}_uvs`)
    }
    this._geometryCache.clear()
    this._passStates.clear()
    this._variantStates.clear()
  }

  /**
   * Reusable per-VARIANT state: the returned pass list and the view and
   * projection matrices that variant draws through.
   *
   * The list used to be a fresh `[]` per call and the two matrices a fresh
   * mat4 each (`camera.getViewMatrix()` / `getProjectionMatrix()` allocated
   * one per call), so a frame with a main view, a mirrored view and a probe
   * face paid for all three several times over.
   *
   * The matrices are COPIES of the camera's, not the camera's own buffers.
   * A camera now rewrites one buffer per matrix on every call, and the six
   * probe faces share a single camera — pointing all six variants' uniforms at
   * it would leave every face carrying the last face's view. One buffer per
   * variant keeps each pass holding the matrix it was actually built with,
   * which is what an inspecting caller (and every test that reads a recorded
   * pass) has always seen.
   * @param {string} passId - Pass variant this state belongs to
   * @returns {{passes: object[], viewMatrix: Float32Array, projMatrix: Float32Array}}
   */
  _variantState(passId) {
    let state = this._variantStates.get(passId)
    if (!state) {
      state = { passes: [], viewMatrix: mat4.create(), projMatrix: mat4.create() }
      this._variantStates.set(passId, state)
    }
    return state
  }

  /**
   * Reusable per-node pass state for one pass variant.
   *
   * Keyed by pass id (main, planar, probe) and then weakly by node, so a
   * recompile that rebuilds the scene tree does not pin the old nodes. The
   * returned objects are rewritten in place each frame; only their identity is
   * stable.
   * @param {string} passId - Pass variant this state belongs to
   * @param {object} node - Mesh node the pass draws
   * @param {object} handle - Geometry handle carrying the mesh texture ids
   * @returns {object} Reusable { pass, uniforms, inputs, normalMatrix, baseColorRgba }
   */
  _passState(passId, node, handle) {
    let byNode = this._passStates.get(passId)
    if (!byNode) {
      byNode = new WeakMap()
      this._passStates.set(passId, byNode)
    }
    let state = byNode.get(node)
    // The geometry handle changes if mesh params change, and the texture names
    // are derived from it, so rebuild when it does.
    if (state && state.meshId === handle.meshId) return state

    const normalMatrix = mat4.create()
    const baseColorRgba = [0, 0, 0, 1]
    const inputs = {
      u_positions: `global_${handle.meshId}_positions`,
      u_normals: `global_${handle.meshId}_normals`,
      u_uvs: `global_${handle.meshId}_uvs`
    }
    const uniforms = {
      u_modelMatrix: null,
      u_viewMatrix: null,
      u_projectionMatrix: null,
      u_normalMatrix: normalMatrix,
      u_baseColor: baseColorRgba,
      u_uvScale: null,
      u_uvOffset: null,
      u_metallic: 0,
      u_roughness: 1,
      u_emissionStrength: 0,
      u_hasAlbedoTexture: 0,
      u_clipPlane: null,
      u_clipEnabled: 0,
      u_meshTexWidth: handle.texWidth
    }
    const pass = {
      // All mesh passes share one MRT FBO + depth buffer
      id: passId,
      program: 'scene_mesh_gbuf',
      drawMode: 'triangles',
      // Stated explicitly rather than left undefined: the backends disagree
      // on the default. WebGL2 enables CULL_FACE and culls back faces; the
      // WebGPU MRT pipeline sets none, rendering double-sided.
      cullMode: 'back',
      count: handle.vertexCount,
      inputs,
      outputs: null,
      drawBuffers: 4,
      clear: false,
      uniforms
    }
    state = { pass, uniforms, inputs, normalMatrix, baseColorRgba, meshId: handle.meshId }
    byNode.set(node, state)
    return state
  }

  /**
   * Get or create the packed mesh textures for a mesh type,
   * upload them to the GPU, return handle with metadata.
   */
  getGeometry(meshType, meshParams) {
    // meshParams is fixed at compile time, so the key is derived once per
    // params object rather than re-serialized on every cache hit — which meant
    // a full JSON.stringify per mesh per frame.
    let key = this._geometryKeys.get(meshParams)
    if (key === undefined) {
      key = meshType + JSON.stringify(meshParams)
      this._geometryKeys.set(meshParams, key)
    }
    if (this._geometryCache.has(key)) return this._geometryCache.get(key)

    const geo = this._createPrimitive(meshType, meshParams)
    if (!geo) return null

    // The backends draw with drawArrays and read vertices from a texel grid, so
    // the geometry is de-indexed and packed by the shared Geometry path.
    const { texWidth, texHeight } = meshTextureSize(geo.indices.length)
    const packed = geo.toPackedTextures(texWidth, texHeight)
    const vertexCount = packed.vertexCount

    const meshId = `scene_mesh_${this._meshIdCounter++}`

    if (this.backend) {
      this.backend.uploadMeshData(meshId, packed.positionData, packed.normalData, packed.uvData, texWidth, texHeight, vertexCount)
    }

    const handle = { meshId, texWidth, texHeight, vertexCount }
    this._geometryCache.set(key, handle)
    return handle
  }

  /**
   * Build an array of pass objects for all mesh nodes.
   * @param {object} [opts]
   * @param {string|null} [opts.albedoFallbackTexture] - Texture to bind as
   *   albedo when a material has no surface source. WGSL declares the
   *   binding unconditionally, so WebGPU must always receive one; GLSL
   *   passes null and omits the input (the shader branch never samples it).
   */
  buildMeshPasses(meshNodes, materials, camera, width, height, opts = {}) {
    const aspect = width / height
    const albedoFallback = opts.albedoFallbackTexture ?? null
    const outputs = opts.outputs ?? DEFAULT_OUTPUTS
    const passId = opts.passId ?? SCENE_GBUFFER_PASS_ID
    // Reused across frames. The caller consumes the list before asking for the
    // same variant again — each executePass runs synchronously inside the
    // frame's own loop — so refilling it in place is safe.
    const variant = this._variantState(passId)
    const passes = variant.passes
    passes.length = 0
    const viewMatrix = mat4.copy(variant.viewMatrix, camera.getViewMatrix())
    const projMatrix = mat4.copy(variant.projMatrix, camera.getProjectionMatrix(aspect))
    const clipPlane = opts.clipPlane ?? DEFAULT_CLIP_PLANE
    const clipEnabled = opts.clipPlane ? 1 : 0

    for (let i = 0; i < meshNodes.length; i++) {
      const node = meshNodes[i]
      if (node === opts.excludeNode) continue
      const handle = this.getGeometry(node.meshType, node.meshParams || {})
      if (!handle) continue

      const modelMatrix = node.getWorldMatrix()

      // Resolve material
      const mat = (node.materialId && materials[node.materialId]) || EMPTY_MATERIAL
      const pbr = mat.pbr || EMPTY_PBR
      const baseColor = finiteVector(mat.baseColor, 3, DEFAULT_COLOR)
      const uvScale = finiteVector(mat.uvScale, 2, DEFAULT_UV_SCALE)
      const uvOffset = finiteVector(mat.uvOffset, 2, DEFAULT_UV_OFFSET)
      const metallic = boundedNumber(pbr.metallic, 0, 0, 1)
      const roughness = boundedNumber(pbr.roughness, 1, 0.045, 1)
      const emission = boundedNumber(mat.emission, 0, 0, Number.POSITIVE_INFINITY)

      // The pass, its inputs and its uniform block are built once per node and
      // rewritten in place on later frames. Rebuilding them allocated a normal
      // matrix, four texture-name strings, a base-colour array and three object
      // literals per mesh per frame.
      const state = this._passState(passId, node, handle)
      const { pass, uniforms, inputs, normalMatrix, baseColorRgba } = state

      invertOrIdentity(normalMatrix, modelMatrix, node, 'mesh')
      mat4.transpose(normalMatrix, normalMatrix)

      let hasAlbedoTexture = 0
      if (mat.albedoSurface) {
        // A DSL surface as albedo: sampled by mesh UV. Content is the
        // surface's previous-frame read side (the scene renders before the
        // pipeline each frame) — standard feedback semantics.
        inputs.u_albedoTexture = `global_${mat.albedoSurface}`
        hasAlbedoTexture = 1
      } else if (albedoFallback) {
        inputs.u_albedoTexture = albedoFallback
      } else {
        delete inputs.u_albedoTexture
      }

      baseColorRgba[0] = baseColor[0]
      baseColorRgba[1] = baseColor[1]
      baseColorRgba[2] = baseColor[2]
      baseColorRgba[3] = 1.0

      pass.cullMode = opts.cullMode ?? 'back'
      pass.count = handle.vertexCount
      pass.outputs = outputs
      pass.clear = passes.length === 0  // only first included mesh clears G-buffer

      uniforms.u_modelMatrix = modelMatrix
      uniforms.u_viewMatrix = viewMatrix
      uniforms.u_projectionMatrix = projMatrix
      uniforms.u_uvScale = uvScale
      uniforms.u_uvOffset = uvOffset
      uniforms.u_metallic = metallic
      uniforms.u_roughness = roughness
      uniforms.u_emissionStrength = emission
      uniforms.u_hasAlbedoTexture = hasAlbedoTexture
      uniforms.u_clipPlane = clipPlane
      uniforms.u_clipEnabled = clipEnabled
      uniforms.u_meshTexWidth = handle.texWidth

      passes.push(pass)
    }
    return passes
  }

  _createPrimitive(meshType, meshParams) {
    switch (meshType) {
      case 'sphere': return createSphere(meshParams)
      case 'box': return createBox(meshParams)
      case 'plane': return createPlane(meshParams)
      case 'cylinder': return createCylinder(meshParams)
      case 'torus': return createTorus(meshParams)
      default: return null
    }
  }
}
