// shaders/src/rendering/volume-renderer.js
import { mat4 } from '../scene/math.js'
import { SCENE_GBUFFER_PASS_ID, invertOrIdentity } from './mesh-renderer.js'

/**
 * Shared stand-ins for "this node has no material" / "no pbr block".
 *
 * `materialRecord || {}` and `mat.pbr || {}` each minted a fresh object per
 * volume per frame on the no-material path. They are only ever read, and
 * freezing them makes that a guarantee rather than a convention.
 */
const EMPTY_MATERIAL = Object.freeze({})
const EMPTY_PBR = Object.freeze({})

const DEFAULT_COLOR = Object.freeze([1, 1, 1])
const DEFAULT_CLIP_PLANE = Object.freeze([0, 0, 0, 0])
/** Stand-in eye for a camera with no position, shared rather than minted. */
const DEFAULT_CAMERA_POSITION = Object.freeze([0, 0, 5])
const DEFAULT_OUTPUTS = Object.freeze({
  color0: 'scene_gbuf_albedo_metallic',
  color1: 'scene_gbuf_normal_roughness',
  color2: 'scene_gbuf_position_emission',
  color3: 'scene_gbuf_depth'
})

/**
 * The bounding box every volume node rasterizes.
 *
 * Size [2,2,2] spans local [-1,1]^3 — the body space every existing marcher
 * works in, so the slab test, step size and atlas sampling copied from render3d
 * need no rescaling. One entry in the shared geometry cache serves every volume
 * in the program.
 */
const BOX_PARAMS = Object.freeze({ size: [2, 2, 2] })

/**
 * Resolution of the global vol0..vol7 atlases.
 *
 * The pipeline hardwires them to 64 x 4096 rgba16f, so anything routed through
 * a volN surface is a 64-cube regardless of the producing effect's volumeSize.
 * Phase 1 states that here rather than pretending to plumb a value through.
 */
const VOLUME_ATLAS_SIZE = 64

/**
 * The `u_mode` values the volume fragment shader branches on.
 *
 * mode is a per-NODE property, so it is a uniform on one program rather than a
 * second program: two volumes in one scene can want different algorithms, and
 * the scene renderer compiles its programs by name with no define machinery to
 * specialize them with. The shader names the same values (MODE_VOXEL 1).
 *
 * Anything unrecognized falls back to smooth. The compiler rejects an unknown
 * mode with a located error, so this only guards a hand-built tree — but an
 * out-of-range int would leave the shader's branch to chance.
 */
const VOLUME_MODES = Object.freeze({ smooth: 0, voxel: 1 })
const DEFAULT_VOLUME_MODE = 0

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

/**
 * Builds the G-buffer fill passes for volume() scene nodes.
 *
 * Parallel to MeshRenderer, and deliberately not part of it: what it emits is a
 * raymarch, not geometry. It does share the mesh renderer's geometry cache —
 * the bounding box is an ordinary primitive and there is no reason to upload a
 * second copy of one, or to duplicate the cache's disposal.
 */
export class VolumeRenderer {
  /**
   * @param {MeshRenderer} meshRenderer - Owns the geometry cache the bounding
   *   box is uploaded through, and the textures it is released with.
   */
  constructor(meshRenderer) {
    this.meshRenderer = meshRenderer
    // Keyed by pass id (main, planar, each probe face) and then weakly by node,
    // exactly as MeshRenderer does: the same node now has one pass object per
    // G-buffer variant, and a single shared object would carry the last
    // variant's outputs and camera into every earlier one within a frame.
    this._passStates = new Map() // passId -> WeakMap<node, reusable pass state>
    this._variantStates = new Map() // passId -> reusable { passes, viewMatrix, projMatrix }
  }

  dispose() {
    // Box geometry belongs to the mesh renderer's cache, which disposes it.
    this._passStates.clear()
    this._variantStates.clear()
  }

  /**
   * Reusable per-VARIANT state — the pass list and this variant's view and
   * projection matrices — mirroring MeshRenderer._variantState, and for the
   * same reasons: the list was a fresh `[]` per call, the matrices a fresh
   * mat4 per camera query, and the copy is what keeps each variant's uniforms
   * holding the matrix that variant was built with when several variants share
   * one camera.
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
   * Reusable per-node pass state for one pass variant, mirroring
   * MeshRenderer._passState.
   *
   * Rewritten in place each frame; only the identity is stable. Rebuilding
   * these per frame would allocate two matrices, a colour array, three texture
   * names and three object literals per volume per variant per frame.
   * @param {string} passId - Pass variant this state belongs to
   * @param {object} node - Volume node the pass draws
   * @param {object} handle - Geometry handle carrying the box texture ids
   * @returns {object} Reusable { pass, uniforms, inputs, invModelMatrix, normalMatrix, baseColorRgba }
   */
  _passState(passId, node, handle) {
    let byNode = this._passStates.get(passId)
    if (!byNode) {
      byNode = new WeakMap()
      this._passStates.set(passId, byNode)
    }
    let state = byNode.get(node)
    // The texture names derive from the geometry handle, so rebuild if it moves.
    if (state && state.meshId === handle.meshId) return state

    const invModelMatrix = mat4.create()
    const normalMatrix = mat4.create()
    const baseColorRgba = [0, 0, 0, 1]
    const inputs = {
      u_positions: `global_${handle.meshId}_positions`,
      u_normals: `global_${handle.meshId}_normals`,
      u_uvs: `global_${handle.meshId}_uvs`,
      // frameState.surfaces already routes vol0..vol7 from the pipeline, so
      // this resolves with no extra plumbing. The scene renders before the
      // pipeline each tick, so the content is the previous frame's — the same
      // contract surface(oN) materials and environment(oN) live under.
      u_volumeAtlas: `global_${node.surface}`
    }
    const uniforms = {
      u_modelMatrix: null,
      u_invModelMatrix: invModelMatrix,
      u_viewMatrix: null,
      u_projectionMatrix: null,
      u_normalMatrix: normalMatrix,
      u_cameraPos: null,
      u_meshTexWidth: handle.texWidth,
      u_volumeSize: VOLUME_ATLAS_SIZE,
      u_threshold: 0.5,
      u_mode: DEFAULT_VOLUME_MODE,
      u_baseColor: baseColorRgba,
      u_hasMaterial: 0,
      u_metallic: 0,
      u_roughness: 1,
      u_emissionStrength: 0,
      u_clipPlane: null,
      u_clipEnabled: 0
    }
    const pass = {
      // Deliberately the SAME id the mesh passes of this variant use. On WebGL2
      // that is what puts both on one framebuffer and therefore one depth
      // buffer, which is what the volume/mesh compositing depends on. See
      // SCENE_GBUFFER_PASS_ID.
      id: passId,
      program: 'scene_volume_gbuf',
      // 'triangles' is what attaches a depth buffer and enables the depth test
      // on BOTH backends; without it the volume could not composite against
      // meshes at all.
      drawMode: 'triangles',
      // Back faces only. One fragment per covered pixel, and the box stays
      // drawn when the camera is inside it. Stated rather than defaulted: the
      // backends disagree on the default for an MRT triangles pass.
      //
      // The same value is correct in the mirrored planar variant, and that is
      // derived rather than inherited. The reflection camera is built by
      // lookAt() from a mirrored position, target and up, and lookAt always
      // produces a proper rigid frame — determinant +1, measured — so the
      // mirroring never reaches the winding: a back face seen from the mirrored
      // eye is genuinely a back face. (The planar MESH passes use 'none' for an
      // unrelated reason: single-sided geometry such as a plane, viewed from the
      // far side of the reflector, would vanish under any culling. A closed box
      // has no such problem.) 'front' therefore stays both one-fragment-per-
      // pixel and robust to the mirrored eye landing inside the box, which
      // 'back' would not be.
      cullMode: 'front',
      count: handle.vertexCount,
      inputs,
      outputs: null,
      drawBuffers: 4,
      clear: false,
      uniforms
    }
    state = { pass, uniforms, inputs, invModelMatrix, normalMatrix, baseColorRgba, meshId: handle.meshId }
    byNode.set(node, state)
    return state
  }

  /**
   * Build a pass per volume node, filling one scene G-buffer variant.
   * @param {object[]} volumeNodes - Nodes from SceneTree.getVolumeNodes()
   * @param {object} materials - Interned material records by key
   * @param {CameraNode} camera - View the volume is marched from
   * @param {number} width - G-buffer width
   * @param {number} height - G-buffer height
   * @param {object} [opts]
   * @param {object} [opts.outputs] - colorN -> texture id map. Defaults to the
   *   main G-buffer; the planar reflection and each probe face pass their own.
   * @param {string} [opts.passId] - Pass id, which is what the WebGL2 backend
   *   keys its MRT framebuffer (and therefore its depth buffer) on. Must be the
   *   SAME id the mesh passes of this variant use.
   * @param {Float32Array|number[]} [opts.clipPlane] - World-space plane
   *   (xyz = normal, w = -dot(normal, point)); a marched hit behind it is
   *   discarded. Absent means no clipping.
   * @param {boolean} [opts.firstClear=false] - Whether the first volume pass is
   *   the first pass into this G-buffer variant this frame and must therefore
   *   clear it. Mesh passes run first, so this is true only when the variant's
   *   mesh list came out empty.
   */
  buildVolumePasses(volumeNodes, materials, camera, width, height, opts = {}) {
    const passId = opts.passId ?? SCENE_GBUFFER_PASS_ID
    // Reused across frames; the caller consumes it before asking for the same
    // variant again. See MeshRenderer._variantState.
    const variant = this._variantState(passId)
    const passes = variant.passes
    passes.length = 0
    if (volumeNodes.length === 0) return passes

    const handle = this.meshRenderer.getGeometry('box', BOX_PARAMS)
    if (!handle) return passes

    const aspect = width / height
    const viewMatrix = mat4.copy(variant.viewMatrix, camera.getViewMatrix())
    const projMatrix = mat4.copy(variant.projMatrix, camera.getProjectionMatrix(aspect))
    const cameraPos = camera._position || DEFAULT_CAMERA_POSITION
    const firstClear = opts.firstClear === true
    const outputs = opts.outputs ?? DEFAULT_OUTPUTS
    const clipPlane = opts.clipPlane ?? DEFAULT_CLIP_PLANE
    const clipEnabled = opts.clipPlane ? 1 : 0

    for (let i = 0; i < volumeNodes.length; i++) {
      const node = volumeNodes[i]
      const modelMatrix = node.getWorldMatrix()

      const materialRecord = node.materialId ? materials?.[node.materialId] : undefined
      const mat = materialRecord || EMPTY_MATERIAL
      const pbr = mat.pbr || EMPTY_PBR
      const baseColor = finiteVector(mat.baseColor, 3, DEFAULT_COLOR)
      const metallic = boundedNumber(pbr.metallic, 0, 0, 1)
      const roughness = boundedNumber(pbr.roughness, 1, 0.045, 1)
      const emission = boundedNumber(mat.emission, 0, 0, Number.POSITIVE_INFINITY)

      const state = this._passState(passId, node, handle)
      const { pass, uniforms, invModelMatrix, normalMatrix, baseColorRgba } = state

      // World -> local carries the ray into the box's own [-1,1] space. A
      // singular transform has no such inverse; identity (and one warning) is
      // the honest answer, because an unchecked invert would leave the reused
      // buffer holding the PREVIOUS frame's ray transform. See
      // invertOrIdentity.
      invertOrIdentity(invModelMatrix, modelMatrix, node, 'volume')
      // Local -> world for the field gradient. transpose(inverse(model)) is the
      // normal matrix, which is exactly what the mesh vertex shader uses to
      // carry ITS local vertex normals to world; the gradient is no different.
      mat4.transpose(normalMatrix, invModelMatrix)

      baseColorRgba[0] = baseColor[0]
      baseColorRgba[1] = baseColor[1]
      baseColorRgba[2] = baseColor[2]
      baseColorRgba[3] = 1.0

      pass.count = handle.vertexCount
      pass.outputs = outputs
      pass.clear = firstClear && passes.length === 0

      uniforms.u_modelMatrix = modelMatrix
      uniforms.u_viewMatrix = viewMatrix
      uniforms.u_projectionMatrix = projMatrix
      uniforms.u_cameraPos = cameraPos
      uniforms.u_meshTexWidth = handle.texWidth
      uniforms.u_threshold = boundedNumber(node.threshold, 0.5, 0, 1)
      // Rewritten every frame like every other uniform here: the pass state is
      // reused in place, so a mode written only at construction would pin the
      // node to whatever it was built with.
      uniforms.u_mode = VOLUME_MODES[node.mode] ?? DEFAULT_VOLUME_MODE
      // A material replaces the atlas-derived albedo outright; without one the
      // shader falls back to the volume's own RGB. surface() albedo is rejected
      // at compile time (an isosurface has no UVs), so there is never a texture.
      uniforms.u_hasMaterial = materialRecord ? 1 : 0
      uniforms.u_metallic = metallic
      uniforms.u_roughness = roughness
      uniforms.u_emissionStrength = emission
      uniforms.u_clipPlane = clipPlane
      uniforms.u_clipEnabled = clipEnabled

      passes.push(pass)
    }
    return passes
  }
}
