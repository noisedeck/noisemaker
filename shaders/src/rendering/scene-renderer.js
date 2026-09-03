// shaders/src/rendering/scene-renderer.js
//
// Orchestrates the full deferred rendering frame by constructing pass objects
// and executing them via the existing WebGL2 backend. Never calls gl.* directly.

import { GBufferConfig } from './gbuffer.js'
import { MeshRenderer, SCENE_GBUFFER_PASS_ID } from './mesh-renderer.js'
import { VolumeRenderer } from './volume-renderer.js'
import { volumeFragmentGLSL, volumeFragmentWGSL } from './volume-shaders.js'
import { presentShader, tonemapPresentShader } from './post-shaders.js'
import { CameraNode } from '../scene/camera.js'
import { CUBE_FACES } from '../renderer/cubeCamera.js'
import {
  mat4,
  planeFromWorldMatrix,
  reflectDirectionAcrossPlane,
  reflectPointAcrossPlane
} from '../scene/math.js'

const GBUF_TEXTURES = [
  { id: 'scene_gbuf_albedo_metallic', format: 'rgba16f' },
  { id: 'scene_gbuf_normal_roughness', format: 'rgba16f' },
  { id: 'scene_gbuf_position_emission', format: 'rgba16f' },
  { id: 'scene_gbuf_depth', format: 'r32f' }
]

const WORK_TEXTURES = [
  { id: 'scene_lit_color', format: 'rgba16f' },
  { id: 'scene_ssao', format: 'rgba16f' },
  { id: 'scene_planar_lit', format: 'rgba16f' },
  { id: 'scene_reflect_color', format: 'rgba16f' },
  // Bound as u_albedoTexture when a material has no surface source. The
  // shader branch never samples it (u_hasAlbedoTexture == 0) — it exists
  // because WGSL declares the binding unconditionally and WebGPU requires
  // every declared binding to be provided. Content is irrelevant.
  { id: 'scene_albedo_fallback', format: 'rgba16f' }
]

const PLANAR_GBUF_TEXTURES = [
  { id: 'scene_planar_gbuf_albedo_metallic', format: 'rgba16f' },
  { id: 'scene_planar_gbuf_normal_roughness', format: 'rgba16f' },
  { id: 'scene_planar_gbuf_position_emission', format: 'rgba16f' },
  { id: 'scene_planar_gbuf_depth', format: 'r32f' }
]

const PLANAR_GBUF_OUTPUTS = Object.freeze({
  color0: 'scene_planar_gbuf_albedo_metallic',
  color1: 'scene_planar_gbuf_normal_roughness',
  color2: 'scene_planar_gbuf_position_emission',
  color3: 'scene_planar_gbuf_depth'
})

/**
 * Pass id shared by every pass filling the mirrored G-buffer — mesh and volume
 * alike, for the same reason the main group shares one. See
 * SCENE_GBUFFER_PASS_ID: the WebGL2 MRT framebuffer, and the depth renderbuffer
 * hanging off it, are keyed on `mrt_${pass.id}_${outputs}`.
 */
const PLANAR_GBUFFER_PASS_ID = 'scene_planar_gbuf_pass'

/**
 * The same rule, once per cube face — and interned rather than built per face
 * per frame, since the probe re-renders a face on every frame it is active.
 */
const PROBE_GBUFFER_PASS_IDS = Object.freeze(
  CUBE_FACES.map((_, face) => `scene_probe_gbuf_face_${face}`)
)

const PROBE_GBUF_TEXTURES = [
  { id: 'scene_probe_gbuf_albedo_metallic', format: 'rgba16f' },
  { id: 'scene_probe_gbuf_normal_roughness', format: 'rgba16f' },
  { id: 'scene_probe_gbuf_position_emission', format: 'rgba16f' },
  { id: 'scene_probe_gbuf_depth', format: 'r32f' }
]

/**
 * Zero the four targets of a G-buffer.
 *
 * Not a draw. The previous form submitted a fullscreen triangle with
 * scene_present — a single-output program — against drawBuffers: 4. WebGPU
 * rejects that pipeline at interface matching, and WebGL2 accepts it but writes
 * only attachment 0, leaving normals, positions and depth undefined rather than
 * cleared. clearTexture zeroes each target directly and behaves the same on
 * both backends, which is also what the `depth <= 0` no-hit sentinel expects.
 *
 * Ordering constraint: on WebGPU, clearTexture submits its own command buffer
 * immediately, so these clears land AHEAD of anything recorded into the frame's
 * shared encoder — including work recorded earlier in the same frame. This
 * helper is therefore only valid when nothing has written the targets yet this
 * frame, which is what the zero-mesh call sites guarantee.
 * @param {object} backend - Active render backend
 * @param {object} outputs - colorN -> texture id map for the G-buffer
 */
function clearGBuffer(backend, outputs) {
  for (const id of Object.values(outputs)) {
    backend.clearTexture(id)
  }
}

const PROBE_GBUF_OUTPUTS = Object.freeze({
  color0: 'scene_probe_gbuf_albedo_metallic',
  color1: 'scene_probe_gbuf_normal_roughness',
  color2: 'scene_probe_gbuf_position_emission',
  color3: 'scene_probe_gbuf_depth'
})

const REFLECTION_PROBE_TEXTURE = 'scene_reflection_probe'
const REFLECTION_PROBE_FALLBACK = 'scene_reflection_probe_fallback'

/**
 * Turn a pipeline tile region into the camera's tile rectangle, or null.
 *
 * The region is the same object the 2D path receives through
 * Pipeline.setTileRegion: a bottom-left pixel offset into the full image, plus
 * the full image's size. The tile's own size is the size the scene renderer is
 * currently rendering at, which is what the export resizes between tiles.
 *
 * Null means "render the full frame", and so does a region that describes the
 * whole image: a degenerate tile is not a tile, and routing it through
 * mat4.frustum instead of mat4.perspective would perturb the matrix by an ulp
 * for no reason. Malformed regions are ignored rather than allowed to poison a
 * projection with NaN.
 *
 * The rectangle is a fresh object, but only on the tiled path — a live,
 * untiled render loop returns null here and allocates nothing. Tiled export is
 * a one-shot capture, not a loop.
 * @param {?{offset: number[], fullResolution: number[]}} region - Tile region
 * @param {number} width - Current render width (this tile's width)
 * @param {number} height - Current render height (this tile's height)
 * @returns {?{x: number, y: number, width: number, height: number,
 *             fullWidth: number, fullHeight: number}}
 */
function resolveTile(region, width, height) {
  if (!region) return null
  const { offset, fullResolution } = region
  if (!Array.isArray(offset) || offset.length !== 2) return null
  if (!Array.isArray(fullResolution) || fullResolution.length !== 2) return null
  const [x, y] = offset
  const [fullWidth, fullHeight] = fullResolution
  for (const value of [x, y, fullWidth, fullHeight]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
  }
  if (fullWidth <= 0 || fullHeight <= 0) return null
  if (x === 0 && y === 0 && fullWidth === width && fullHeight === height) return null
  return { x, y, width, height, fullWidth, fullHeight }
}

/**
 * Aim a camera out of `position` along one cube face.
 *
 * The two callers differ only in `upSign`, and that difference is the whole
 * distinction between the two cube conventions in this codebase:
 *
 * - The reflection probe renders INTO a cube texture and is sampled by
 *   direction, so it uses the face's own up (`+1`) — the GL cubemap
 *   convention CUBE_FACES is written in.
 * - A cubemap EXPORT is read back as six images that a consumer lays out or
 *   writes to disk, and those images follow the 2D cubemap renderers:
 *   `rd = cubeBasis * vec3(uv.x, -uv.y, 1.0)`, so the top row of a face points
 *   along MINUS the face's up (`-1`). A camera's image top is its own up, so
 *   the export camera takes the negated one. Negating up also flips the
 *   handedness of `cross(forward, up)` back to faceRight(), which is what
 *   keeps the horizontal direction matching too.
 * @param {CameraNode} camera - Camera to aim (mutated in place)
 * @param {ArrayLike<number>} position - Eye position
 * @param {number} face - CUBE_FACES index
 * @param {number} upSign - +1 for a cube-texture capture, -1 for a readback
 */
function aimCameraAtCubeFace(camera, position, face, upSign) {
  const cubeFace = CUBE_FACES[face]
  for (let i = 0; i < 3; i++) {
    camera._position[i] = position[i]
    camera.target[i] = position[i] + cubeFace.forward[i]
    camera.up[i] = upSign * cubeFace.up[i]
  }
}

const LIGHT_TYPE_CODE = Object.freeze({ point: 0, directional: 1, spot: 2 })

/**
 * Uniform names for one light slot, interned per index.
 *
 * `u_lights[i].position` and its seven siblings were built from template
 * literals inside the per-frame uniform walk — eight strings per light per
 * frame. The names depend only on the index, so they are built once and reused
 * for the life of the module.
 * @param {number} index - Light slot
 * @returns {object} The eight uniform names for that slot
 */
const LIGHT_UNIFORM_KEYS = []
function lightUniformKeys(index) {
  let keys = LIGHT_UNIFORM_KEYS[index]
  if (!keys) {
    const prefix = `u_lights[${index}]`
    keys = {
      position: `${prefix}.position`,
      color: `${prefix}.color`,
      intensity: `${prefix}.intensity`,
      lightType: `${prefix}.lightType`,
      direction: `${prefix}.direction`,
      cosInner: `${prefix}.cosInner`,
      cosOuter: `${prefix}.cosOuter`,
      falloff: `${prefix}.falloff`
    }
    LIGHT_UNIFORM_KEYS[index] = keys
  }
  return keys
}

/**
 * Read-only stand-ins for values a scene may leave unset.
 *
 * Each was an inline literal on the per-frame path, so an unset background (or
 * a light with no explicit colour) minted a fresh array every tick. Frozen
 * because they are shared by every frame and every pass that falls back to
 * them.
 */
const DEFAULT_BACKGROUND = Object.freeze([0, 0, 0])
const DEFAULT_CAMERA_POSITION = Object.freeze([0, 0, 5])
const DEFAULT_TARGET = Object.freeze([0, 0, 0])
const DEFAULT_UP = Object.freeze([0, 1, 0])
const DEFAULT_LIGHT_POSITION = Object.freeze([0, 0, 0])
const DEFAULT_LIGHT_COLOR = Object.freeze([1, 1, 1])
const DEFAULT_LIGHT_DIRECTION = Object.freeze([0, -1, 0])

/** The main G-buffer's targets, for the nothing-drew clear. */
const GBUF_OUTPUTS = Object.freeze({
  color0: 'scene_gbuf_albedo_metallic',
  color1: 'scene_gbuf_normal_roughness',
  color2: 'scene_gbuf_position_emission',
  color3: 'scene_gbuf_depth'
})

/** Hoisted out of `meshNodes.find(...)`, which built a closure every frame. */
const IS_PLANAR_REFLECTOR = node => node.planarReflection

/**
 * Colour-attachment bytes per sample, by texture format.
 *
 * Mirrors Pipeline.mrtFormatBytes for the two formats the scene G-buffer uses.
 * The pipeline's own table has no r32f entry (its MRT surfaces are all rgba),
 * and a single-channel 32-bit target costs four bytes, not eight.
 */
const FORMAT_BYTES_PER_SAMPLE = Object.freeze({ rgba16f: 8, r32f: 4 })

/** What one G-buffer sample costs across its four colour attachments. */
const GBUF_BYTES_PER_SAMPLE = GBUF_TEXTURES.reduce(
  (total, tex) => total + FORMAT_BYTES_PER_SAMPLE[tex.format], 0)

const ALL_TEXTURES = [...GBUF_TEXTURES, ...PLANAR_GBUF_TEXTURES, ...WORK_TEXTURES]

/**
 * One deferred-lighting pass, built once and rewritten in place each frame.
 *
 * The three variants — the main view, the mirrored planar view, and each probe
 * face — run one program over different G-buffers into different targets. What
 * is fixed for the life of a variant is set here; the two swappable inputs and
 * the whole uniform block are rewritten every frame by the caller.
 *
 * Input key ORDER is load-bearing on WebGL2, which assigns texture units in
 * insertion order, so it matches what these passes have always declared.
 * @param {string} id - Pass id
 * @param {object} gbuf - colorN -> texture id map of the G-buffer to light
 * @param {string} target - Texture the lit result is written to
 * @param {number} [cubeFace] - Cube face index; omitted for a 2D target
 * @returns {{pass: object, lightCount: number}} Reusable state; lightCount is
 *   how many light slots the uniform block currently carries
 */
function lightingPassState(id, gbuf, target, cubeFace) {
  const pass = {
    id,
    program: 'scene_lighting',
    inputs: {
      u_albedoMetallic: gbuf.color0,
      u_normalRoughness: gbuf.color1,
      u_positionEmission: gbuf.color2,
      u_depth: gbuf.color3,
      u_ssao: 'scene_albedo_fallback',
      u_envTexture: 'scene_albedo_fallback',
      u_reflectionProbe: REFLECTION_PROBE_FALLBACK
    },
    outputs: { color0: target },
    drawBuffers: 1
  }
  // Inserted here, between drawBuffers and clear, so a probe face's descriptor
  // enumerates exactly as it did when it was rebuilt per frame.
  if (cubeFace !== undefined) pass.cubeFace = cubeFace
  pass.clear = true
  pass.uniforms = {}
  return { pass, lightCount: -1 }
}

export class SceneRenderer {
  constructor(backend, existingPipeline) {
    this.backend = backend
    this.pipeline = existingPipeline
    this.meshRenderer = new MeshRenderer(backend)
    // Shares the mesh renderer's geometry cache: the bounding box every volume
    // rasterizes is an ordinary primitive.
    this.volumeRenderer = new VolumeRenderer(this.meshRenderer)
    this.gbufferConfig = null
    this._shaderLang = backend?.device ? 'wgsl' : 'glsl'
    this._width = 0
    this._height = 0
    this._initialized = false
    this._frameIndex = 0
    this._probeSize = 0
    this._probeInitialized = false
    this._probeNextFace = 0
    this._probePosition = new Float32Array(3)
    // Pre-allocated per-frame view-projection (render loops must not allocate)
    this._viewProj = mat4.create()
    this._reflectionViewProj = mat4.create()
    this._planePoint = new Float32Array(3)
    this._planeNormal = new Float32Array(3)
    this._clipPlane = new Float32Array(4)
    this._reflectionCamera = new CameraNode({
      id: '__planar_reflection_camera__',
      position: [0, 0, 0],
      target: [0, 0, 0],
      up: [0, 1, 0]
    })
    this._probeCamera = new CameraNode({
      id: '__scene_reflection_probe_camera__',
      fov: 90,
      near: 0.1,
      far: 1000,
      position: [0, 0, 0],
      target: [0, 0, 1],
      up: [0, -1, 0]
    })
    /**
     * The camera a cubemap export renders each face through. The scene's own
     * camera is never touched: only its position, near and far are borrowed,
     * because a cube face is a 90-degree square view along a world axis.
     */
    this._cubeExportCamera = new CameraNode({
      id: '__scene_cubemap_export_camera__',
      fov: 90,
      near: 0.1,
      far: 1000,
      position: [0, 0, 0],
      target: [0, 0, 1],
      up: [0, 1, 0]
    })
    // Set only between beginCubemapExport() and endCubemapExport(): see
    // beginCubemapExport for why an export captures the probe exactly once.
    this._probeFrozen = false
    this._probeStateBeforeExport = null

    /**
     * Everything a frame hands the backend, built once and rewritten in place.
     *
     * The project bans per-frame allocation in render loops, and this file
     * said so over the view-projection buffers above while rebuilding a frame
     * state, five fullscreen pass descriptors, one more per probe face, and
     * every one of their inputs/outputs/uniform objects on each tick. The mesh
     * and volume renderers already reuse their per-node passes; these are the
     * rest of the frame.
     *
     * Only two things reshape any of this, and neither happens in a steady
     * loop: a light count change (which also recompiles the lighting shader,
     * and drops the surplus u_lights[] keys here) and a resize (which
     * reallocates textures, not descriptors — the ids are stable, so the
     * descriptors survive it untouched).
     */
    this._frameState = {
      frameIndex: 0,
      time: 0,
      globalUniforms: { u_time: 0, u_resolution: [0, 0] },
      surfaces: {},
      writeSurfaces: {},
      screenWidth: 0,
      screenHeight: 0
    }
    // The names currently present in frameState.surfaces, and the buffer next
    // frame fills. A name the pipeline has stopped publishing has to be
    // deleted from the reused map rather than left to resolve against a
    // destroyed texture; the two arrays swap each frame so the bookkeeping
    // allocates nothing.
    this._surfaceNames = []
    this._surfaceNamesScratch = []
    /**
     * The flat grey settings.sky and settings.ground fall back to.
     *
     * It cannot be a frozen constant: the value is settings.ambient, which the
     * scene owns. One buffer serves both uniforms — they take the same value,
     * and a pass only ever reads them.
     */
    this._ambientColor = [0, 0, 0]
    // SSAO's tile-local dither offset, (0,0) on every untiled frame.
    this._tileOffset = [0, 0]

    this._ssaoPass = {
      id: 'scene_ssao_pass',
      program: 'scene_ssao',
      inputs: {
        u_normalRoughness: 'scene_gbuf_normal_roughness',
        u_positionEmission: 'scene_gbuf_position_emission',
        u_depth: 'scene_gbuf_depth'
      },
      outputs: { color: 'scene_ssao' },
      clear: true,
      uniforms: {
        u_viewProj: this._viewProj,
        u_cameraPos: DEFAULT_CAMERA_POSITION,
        u_radius: 0.75,
        // The SSAO kernel-rotation hash seeds from the fragment coordinate,
        // which is tile-local under tiled export — without the tile's pixel
        // offset each tile re-dithers with a different phase. (0,0) leaves
        // untiled output byte-identical.
        u_tileOffset: this._tileOffset
      }
    }

    this._lightingPassState = lightingPassState(
      'scene_lighting', GBUF_OUTPUTS, 'scene_lit_color')
    this._planarLightingPassState = lightingPassState(
      'scene_planar_lighting', PLANAR_GBUF_OUTPUTS, 'scene_planar_lit')
    this._probeLightingPassStates = CUBE_FACES.map((_, face) => lightingPassState(
      `scene_probe_lighting_face_${face}`,
      PROBE_GBUF_OUTPUTS,
      REFLECTION_PROBE_TEXTURE,
      face
    ))

    this._ssrPass = {
      id: 'scene_ssr_pass',
      program: 'scene_ssr',
      inputs: {
        u_litColor: 'scene_lit_color',
        u_albedoMetallic: 'scene_gbuf_albedo_metallic',
        u_normalRoughness: 'scene_gbuf_normal_roughness',
        u_positionEmission: 'scene_gbuf_position_emission',
        u_depth: 'scene_gbuf_depth',
        u_planarReflection: 'scene_albedo_fallback'
      },
      outputs: { color: 'scene_reflect_color' },
      clear: true,
      uniforms: {
        u_viewProj: this._viewProj,
        u_reflectionViewProj: this._reflectionViewProj,
        u_cameraPos: DEFAULT_CAMERA_POSITION,
        u_reflStrength: 1,
        u_planarEnabled: 0,
        u_planePoint: this._planePoint,
        u_planeNormal: this._planeNormal
      }
    }

    this._presentPass = {
      id: 'scene_tonemap_present',
      program: 'scene_tonemap_present',
      inputs: { u_texture: 'scene_lit_color' },
      outputs: { color: 'screen' },
      clear: true,
      uniforms: { u_exposure: 1 }
    }
  }

  /**
   * Refuse a device whose colour-attachment budget cannot hold the G-buffer.
   *
   * The 2D pipeline handles an over-budget MRT pass by demoting trailing
   * rgba32f attachments to rgba16f (Pipeline.applyMrtFormatBudget, measured
   * against `backend.capabilities.maxColorBytesPerSample`). The scene
   * G-buffer has nothing to demote — three rgba16f plus an r32f depth is
   * already the minimum the deferred shaders can reconstruct from — and it
   * bypasses that pass entirely, because these textures are created here
   * rather than declared in the pipeline's graph.
   *
   * So the budget is checked instead of trimmed. Without this the framebuffer
   * simply comes back FRAMEBUFFER_UNSUPPORTED on every frame, one console warn
   * at a time, with nothing on screen and no statement of why; a throw out of
   * initialize() surfaces through compile() where a host can report it.
   * @private
   */
  _assertColorBudget() {
    const budget = this.backend?.capabilities?.maxColorBytesPerSample
    if (typeof budget !== 'number' || budget >= GBUF_BYTES_PER_SAMPLE) return
    const formats = GBUF_TEXTURES.map(tex => tex.format).join(' + ')
    throw new Error(
      `Scene G-buffer pass '${SCENE_GBUFFER_PASS_ID}' needs ` +
      `${GBUF_BYTES_PER_SAMPLE} bytes per sample across ${GBUF_TEXTURES.length} ` +
      `colour attachments (${formats}), but this device allows ${budget}. ` +
      'The deferred scene renderer cannot run here; its attachment formats are ' +
      'already at the minimum the lighting pass can reconstruct from.'
    )
  }

  async initialize(width, height) {
    this._assertColorBudget()
    this._width = width
    this._height = height
    this.gbufferConfig = new GBufferConfig(width, height)

    if (!this.backend) {
      this._initialized = true
      return
    }

    // Create G-buffer and work textures
    for (const tex of ALL_TEXTURES) {
      this.backend.createTexture(tex.id, {
        width,
        height,
        format: tex.format,
        usage: ['render', 'sample', 'copySrc']
      })
    }
    this.backend.createCubeTexture?.(REFLECTION_PROBE_FALLBACK, {
      size: 1,
      format: 'rgba8',
      usage: ['sample']
    })

    // Compile static shaders. perBindingUniforms opts scene programs into
    // the WebGPU backend's per-binding struct packing — the mesh pass binds
    // two different uniform structs (vertex matrices + fragment material),
    // and lighting carries an array of light structs; the default shared
    // program-wide buffer can represent neither.
    const lang = this._shaderLang
    const meshShaderSpec = lang === 'wgsl'
      ? { vertexWGSL: this.gbufferConfig.getMeshVertexShader(lang), fragment: this.gbufferConfig.getMeshFragmentShader(lang), perBindingUniforms: true }
      : { vertex: this.gbufferConfig.getMeshVertexShader(lang), fragment: this.gbufferConfig.getMeshFragmentShader(lang) }
    await this.backend.compileProgram('scene_mesh_gbuf', meshShaderSpec)

    // Volume nodes rasterize their bounding box with the SAME vertex shader and
    // fill the SAME four targets; only the fragment stage differs, marching the
    // density atlas instead of shading an interpolated surface.
    const volumeShaderSpec = lang === 'wgsl'
      ? { vertexWGSL: this.gbufferConfig.getMeshVertexShader(lang), fragment: volumeFragmentWGSL(), perBindingUniforms: true }
      : { vertex: this.gbufferConfig.getMeshVertexShader(lang), fragment: volumeFragmentGLSL() }
    await this.backend.compileProgram('scene_volume_gbuf', volumeShaderSpec)

    await this.backend.compileProgram('scene_present', {
      fragment: presentShader(lang),
      perBindingUniforms: true
    })

    await this.backend.compileProgram('scene_tonemap_present', {
      fragment: tonemapPresentShader(lang),
      perBindingUniforms: true
    })

    await this.backend.compileProgram('scene_ssao', {
      fragment: this.gbufferConfig.getSSAOShader(lang),
      perBindingUniforms: true
    })

    await this.backend.compileProgram('scene_ssr', {
      fragment: this.gbufferConfig.getSSRShader(lang),
      perBindingUniforms: true
    })

    this._initialized = true
  }

  resize(width, height) {
    this._width = width
    this._height = height
    if (this.gbufferConfig) this.gbufferConfig.resize(width, height)

    if (!this.backend) return

    // Recreate textures at new size
    for (const tex of ALL_TEXTURES) {
      this.backend.destroyTexture(tex.id)
      this.backend.createTexture(tex.id, {
        width,
        height,
        format: tex.format,
        usage: ['render', 'sample', 'copySrc']
      })
    }
  }

  /**
   * @param {SceneTree} sceneTree - Scene to draw
   * @param {Clock} clock - Supplies elapsed time
   * @param {string} [target='screen'] - Texture to present into. Scene
   *   programs pass a pipeline surface so 2D effects can consume the result.
   * @param {?{offset: number[], fullResolution: number[]}} [tileRegion=null] -
   *   The region set on the canvas for tiled hi-res export, or null for a full
   *   frame. The same object the 2D pipeline is given; the scene turns it into
   *   a camera sub-frustum rather than a fragment-coordinate shift.
   * @param {?CameraNode} [cameraOverride=null] - View to render instead of the
   *   scene's own camera. Cubemap export passes one camera per cube face; the
   *   scene tree is left untouched so the live view survives a capture.
   */
  async render(sceneTree, clock, target = 'screen', tileRegion = null, cameraOverride = null) {
    if (!this._initialized || !this.backend) return

    const camera = cameraOverride || sceneTree.camera
    const meshNodes = sceneTree.getMeshNodes()
    const volumeNodes = sceneTree.getVolumeNodes()
    const lights = sceneTree.lights || []
    const settings = sceneTree.settings || {}
    const materials = sceneTree.materials || {}
    const width = this._width
    const height = this._height
    const time = clock?.elapsed || 0

    // Tiled hi-res export. Written on EVERY frame, null included, so a tile
    // set for one export can never leak into a later untiled frame. Everything
    // that projects the main view — the mesh and volume G-buffer fills, the
    // mirrored planar view, and the view-projection SSAO and SSR reconstruct
    // through — reads this camera, so this single assignment tiles all of them.
    // The reflection probe deliberately does NOT: see _renderReflectionProbe.
    camera.tile = resolveTile(tileRegion, width, height)

    const reflStrength = settings.reflections ?? 1
    const probeActive = reflStrength > 0 && this._prepareReflectionProbe(settings)
    if (probeActive) this._ensureReflectionProbeResources(this._resolvedProbeSize)

    // Compile before opening the frame: no await may sit between
    // beginFrame() and endFrame(), or the pipeline's own frame (which the
    // caller starts right after us) would clobber the shared command
    // encoder mid-flight on WebGPU.
    await this._ensureLightingShader(lights.length)

    // Rewritten in place: one frame state for the life of the renderer. See
    // the constructor.
    const frameState = this._frameState
    frameState.frameIndex = this._frameIndex++
    frameState.time = time
    frameState.globalUniforms.u_time = time
    frameState.globalUniforms.u_resolution[0] = width
    frameState.globalUniforms.u_resolution[1] = height
    frameState.screenWidth = width
    frameState.screenHeight = height

    // Expose the pipeline's surfaces (read side) so scene passes can bind
    // global_oN — surface(oN) materials and environment(oN) sample the
    // surface's previous-frame content, since the scene renders before the
    // pipeline's own frame each tick.
    //
    // The map is reused, so a name the pipeline has stopped publishing (a
    // recompile with fewer surfaces) has to be removed rather than left to
    // resolve against a destroyed texture.
    const surfaces = frameState.surfaces
    const previousNames = this._surfaceNames
    const currentNames = this._surfaceNamesScratch
    let count = 0
    if (this.pipeline?.surfaces) {
      for (const [name, surface] of this.pipeline.surfaces) {
        const tex = this.backend.textures?.get?.(surface.read)
        if (!tex) continue
        surfaces[name] = tex
        currentNames[count++] = name
      }
    }
    currentNames.length = count
    for (let i = 0; i < previousNames.length; i++) {
      const name = previousNames[i]
      let live = false
      for (let j = 0; j < count; j++) {
        if (currentNames[j] === name) { live = true; break }
      }
      if (!live) delete surfaces[name]
    }
    // Swap rather than copy: next frame's scratch is this frame's record.
    this._surfaceNames = currentNames
    this._surfaceNamesScratch = previousNames

    // Bracket all scene passes in a backend frame. WebGL2 treats this as
    // cosmetic; WebGPU allocates its command encoder in beginFrame() and
    // submits in endFrame() — without the bracket every pass dereferences a
    // null encoder.
    this.backend.beginFrame(frameState)
    try {
      this._renderPasses(
        frameState,
        meshNodes,
        volumeNodes,
        materials,
        camera,
        lights,
        settings,
        sceneTree.environment ?? null,
        target,
        width,
        height,
        probeActive
      )
    } finally {
      this.backend.endFrame()
    }
  }

  /**
   * @private All per-frame pass execution; must contain no awaits, and must
   * not allocate: every descriptor, uniform block and default array it submits
   * is built once (in the constructor, or by the mesh and volume renderers)
   * and rewritten in place here.
   */
  _renderPasses(frameState, meshNodes, volumeNodes, materials, camera, lights, settings, environment, target, width, height, probeActive) {
    const reflStrength = settings.reflections ?? 1
    const aspect = width / height
    const reflector = reflStrength > 0
      ? meshNodes.find(IS_PLANAR_REFLECTOR)
      : null
    const planarActive = Boolean(
      reflector && this._preparePlanarReflection(reflector, camera, aspect)
    )
    const envTexture = environment ? `global_${environment.surface}` : 'scene_albedo_fallback'
    const envIntensity = environment ? (environment.intensity ?? 1) : 0
    const ambient = settings.ambient ?? 0.1
    // One reused buffer behind both defaults — see _ambientColor.
    const ambientColor = this._ambientColor
    ambientColor[0] = ambient
    ambientColor[1] = ambient
    ambientColor[2] = ambient
    const sky = settings.sky ?? ambientColor
    const ground = settings.ground ?? ambientColor
    const background = settings.background ?? DEFAULT_BACKGROUND
    const cameraPosition = camera._position || DEFAULT_CAMERA_POSITION

    // A frozen probe is still sampled by lighting below; it is only the
    // capture that is skipped. See beginCubemapExport().
    if (probeActive && !this._probeFrozen) {
      this._renderReflectionProbe(
        frameState,
        meshNodes,
        volumeNodes,
        materials,
        lights,
        envTexture,
        envIntensity,
        background,
        sky,
        ground
      )
    }

    // --- 1. Mesh passes ---
    // The fallback albedo is bound on BOTH backends. WGSL needs every
    // declared binding provided; GLSL needs it because the mesh program is
    // shared across passes — a pass that sets the albedo sampler to unit N
    // leaves it there for the next pass, whose unit N may hold a G-buffer
    // texture that pass is writing (sampler-references-attachment feedback,
    // GL error 1282). Binding a texture every pass keeps the sampler unit
    // deterministic.
    const meshPasses = this.meshRenderer.buildMeshPasses(meshNodes, materials, camera, width, height, {
      albedoFallbackTexture: 'scene_albedo_fallback'
    })
    for (const pass of meshPasses) {
      this.backend.executePass(pass, frameState)
    }

    // --- 1a. Volume passes ---
    // Each volume node rasterizes its bounding box into the SAME four targets
    // with the SAME depth attachment, so the hardware depth test composites
    // volumes against meshes for free on both backends. Depth alone would make
    // the order irrelevant; volumes run after meshes so the clear decision
    // below is deterministic rather than order-dependent.
    //
    // The mirrored G-buffer and each probe face repeat this pairing with their
    // own targets and their own pass id — a volume is a scene node, so every
    // view of the scene draws it.
    const volumePasses = this.volumeRenderer.buildVolumePasses(volumeNodes, materials, camera, width, height, {
      firstClear: meshPasses.length === 0
    })
    for (const pass of volumePasses) {
      this.backend.executePass(pass, frameState)
    }

    // Nothing filled the G-buffer, so zero it directly — the `depth <= 0`
    // no-hit sentinel every downstream pass reads is backed by this clear.
    if (meshPasses.length === 0 && volumePasses.length === 0) {
      clearGBuffer(this.backend, GBUF_OUTPUTS)
    }

    // A planar reflector is a second view of the scene, not a screen-space
    // depth reconstruction. Render from the camera mirrored across the
    // receiver, omit the receiver itself, and clip geometry behind its plane.
    if (planarActive) {
      const planarMeshPasses = this.meshRenderer.buildMeshPasses(
        meshNodes,
        materials,
        this._reflectionCamera,
        width,
        height,
        {
          albedoFallbackTexture: 'scene_albedo_fallback',
          outputs: PLANAR_GBUF_OUTPUTS,
          passId: PLANAR_GBUFFER_PASS_ID,
          excludeNode: reflector,
          clipPlane: this._clipPlane,
          cullMode: 'none'
        }
      )
      for (const pass of planarMeshPasses) {
        this.backend.executePass(pass, frameState)
      }
      // Volumes are mirrored on the same terms: same camera, same targets, same
      // pass id (hence the same depth buffer), same clip plane. No excludeNode
      // — a reflector is a mesh flag, so a volume can never be the receiver.
      // cullMode stays the renderer's own 'front': the reflection camera is a
      // proper rigid frame, so the mirroring does not flip the box's winding.
      // See VolumeRenderer._passState.
      const planarVolumePasses = this.volumeRenderer.buildVolumePasses(
        volumeNodes,
        materials,
        this._reflectionCamera,
        width,
        height,
        {
          outputs: PLANAR_GBUF_OUTPUTS,
          passId: PLANAR_GBUFFER_PASS_ID,
          clipPlane: this._clipPlane,
          firstClear: planarMeshPasses.length === 0
        }
      )
      for (const pass of planarVolumePasses) {
        this.backend.executePass(pass, frameState)
      }
      if (planarMeshPasses.length === 0 && planarVolumePasses.length === 0) {
        clearGBuffer(this.backend, PLANAR_GBUF_OUTPUTS)
      }
    }

    // View-projection is shared by SSAO reprojection and SSR marching. While
    // tiling this is the TILE's: both passes project world points back into the
    // G-buffer they are reading, and that G-buffer holds only the tile.
    mat4.multiply(this._viewProj, camera.getProjectionMatrix(aspect), camera.getViewMatrix())

    // --- 1b. SSAO pass ---
    // u_radius is a WORLD-space radius, so tiling does not rescale it: the
    // kernel is built around the world position the G-buffer stores and
    // reprojected through u_viewProj, which the tile already accounts for.
    //
    // SEAM: occluders that fall outside the tile are not in the tile's
    // G-buffer, so a reprojected sample landing outside [0,1] is skipped and
    // pixels within the kernel's projected radius of a tile edge darken less
    // than they would in a full frame. Measured on hardware at up to 156/255
    // within 24px of a seam, back to the noise floor beyond 32px — the band is
    // as wide as the kernel reaches and no wider. This is the same class of
    // seam the 2D path accepts for every neighbourhood-sampling effect
    // (test_tiling_parity gates the tile INTERIOR and skips an 18px border on a
    // 64px tile); a screen-space effect cannot see beyond its own screen.
    //
    // Separately, the per-pixel kernel rotation hashes gl_FragCoord, which in a
    // tile is tile-local, so each tile realises the AO dither with a different
    // phase (28-32/255 per pixel, 0.29/255 mean, flat across the image). Making
    // that identical needs the tile offset inside the hash — a uniform on the
    // SSAO shader, the same fix tile-aware 2D effects apply to their own
    // procedural seeds. testSceneTileStitch measures both effects separately.
    const ssaoStrength = settings.ssao ?? 1
    if (ssaoStrength > 0) {
      const ssaoUniforms = this._ssaoPass.uniforms
      ssaoUniforms.u_cameraPos = cameraPosition
      ssaoUniforms.u_radius = settings.ssaoRadius ?? 0.75
      this._tileOffset[0] = camera.tile ? camera.tile.x : 0
      this._tileOffset[1] = camera.tile ? camera.tile.y : 0
      this.backend.executePass(this._ssaoPass, frameState)
    }

    // --- 2. Deferred lighting pass ---
    // (shader ensured before the frame opened — see render())
    const probeTexture = probeActive ? REFLECTION_PROBE_TEXTURE : REFLECTION_PROBE_FALLBACK

    if (planarActive) {
      const planar = this._planarLightingPassState
      planar.pass.inputs.u_envTexture = envTexture
      planar.pass.inputs.u_reflectionProbe = probeTexture
      this._buildLightingUniforms(
        planar,
        this._reflectionCamera._position,
        lights,
        background,
        sky,
        ground,
        0,
        envIntensity,
        probeActive ? 1 : 0,
        0
      )
      this.backend.executePass(planar.pass, frameState)
    }

    const lighting = this._lightingPassState
    // With SSAO off, u_ssaoStrength is 0 so the shader ignores the sample —
    // any bindable texture satisfies the declaration. Same contract for the
    // environment at intensity 0.
    lighting.pass.inputs.u_ssao = ssaoStrength > 0 ? 'scene_ssao' : 'scene_albedo_fallback'
    lighting.pass.inputs.u_envTexture = envTexture
    lighting.pass.inputs.u_reflectionProbe = probeTexture
    this._buildLightingUniforms(
      lighting,
      cameraPosition,
      lights,
      background,
      sky,
      ground,
      ssaoStrength,
      envIntensity,
      probeActive ? 1 : 0,
      0
    )
    this.backend.executePass(lighting.pass, frameState)

    // --- 2b. Reflections ---
    // The existing reflection stage composites the mirrored scene on the
    // explicit planar receiver, then uses SSR only for all other materials.
    // Keeping this in one fullscreen pass preserves WebGPU texture parity.
    //
    // TILING: the planar half is tile-exact — the mirrored G-buffer is the
    // matching tile of the mirrored view, so u_reflectionViewProj lands on the
    // right texel — except for its own `planarEdgeFade`, which fades the last
    // 2.5% of the mirrored image and now fades at tile edges too.
    //
    // The SSR half cannot be tile-exact, and no projection fixes that: a ray
    // marched off the side of the tile has nothing to hit, because the geometry
    // it would have hit was never rasterized into this tile's G-buffer. The
    // march therefore breaks early and `edgeFade` (10% of the image, now 10% of
    // the TILE) attenuates hits near the border. Reflections seam more widely
    // than SSAO does, exactly as a 24-step screen-space march must. The 2D
    // pipeline accepts the identical trade for its own neighbourhood effects.
    if (reflStrength > 0) {
      const ssr = this._ssrPass
      ssr.inputs.u_planarReflection = planarActive ? 'scene_planar_lit' : 'scene_albedo_fallback'
      ssr.uniforms.u_cameraPos = cameraPosition
      ssr.uniforms.u_reflStrength = reflStrength
      ssr.uniforms.u_planarEnabled = planarActive ? 1 : 0
      this.backend.executePass(ssr, frameState)
    }

    // --- 3. Present (with tone mapping + gamma) ---
    // Tile-exact by construction: a fullscreen pass over the tile, mapping each
    // of the tile's texels through a per-pixel tone curve. Nothing here reads a
    // neighbour or a screen position, so the tile's output is byte-identical to
    // the corresponding rectangle of a full-frame present of the same input.
    const present = this._presentPass
    present.inputs.u_texture = reflStrength > 0 ? 'scene_reflect_color' : 'scene_lit_color'
    present.outputs.color = target
    present.uniforms.u_exposure = settings.exposure ?? 1
    this.backend.executePass(present, frameState)
  }

  _prepareReflectionProbe(settings) {
    const position = settings.reflectionProbe
    if (!Array.isArray(position) || position.length !== 3) return false
    for (let i = 0; i < 3; i++) {
      if (typeof position[i] !== 'number' || !Number.isFinite(position[i])) return false
      this._probePosition[i] = position[i]
    }
    const requestedSize = settings.reflectionProbeSize ?? 128
    if (typeof requestedSize !== 'number' || !Number.isFinite(requestedSize)) return false
    this._resolvedProbeSize = Math.min(512, Math.max(16, Math.round(requestedSize)))
    return true
  }

  _ensureReflectionProbeResources(size) {
    if (this._probeSize === size) return
    if (this._probeSize > 0) {
      for (const tex of PROBE_GBUF_TEXTURES) this.backend.destroyTexture(tex.id)
      this.backend.destroyTexture(REFLECTION_PROBE_TEXTURE)
    }
    for (const tex of PROBE_GBUF_TEXTURES) {
      this.backend.createTexture(tex.id, {
        width: size,
        height: size,
        format: tex.format,
        usage: ['render', 'sample']
      })
    }
    this.backend.createCubeTexture(REFLECTION_PROBE_TEXTURE, {
      size,
      format: 'rgba16f',
      usage: ['render', 'sample']
    })
    this._probeSize = size
    this._probeInitialized = false
    this._probeNextFace = 0
  }

  /**
   * Capture the world-space reflection cubemap.
   *
   * TILING: the probe is never tiled, and `this._probeCamera.tile` is left null
   * for the life of the renderer. A probe face is not a view of the screen —
   * it is one 90-degree face of a cubemap at probe resolution, sampled by
   * reflection DIRECTION rather than by screen position. Restricting a face to
   * the screen tile's sub-rectangle would capture a fraction of that face's
   * world and leave every reflection direction outside it reading the wrong
   * texel, so each tile would carry a different, wrong cubemap. Capturing all
   * six full faces per tile is both correct and the same cost it always was.
   * @private
   */
  _renderReflectionProbe(frameState, meshNodes, volumeNodes, materials, lights, envTexture, envIntensity, background, sky, ground) {
    const camera = this._probeCamera
    const position = this._probePosition

    const faceCount = this._probeInitialized ? 1 : CUBE_FACES.length
    const firstFace = this._probeInitialized ? this._probeNextFace : 0
    for (let faceOffset = 0; faceOffset < faceCount; faceOffset++) {
      const face = (firstFace + faceOffset) % CUBE_FACES.length
      // +1: the capture lands in a cube texture sampled by direction.
      aimCameraAtCubeFace(camera, position, face, 1)

      const passId = PROBE_GBUFFER_PASS_IDS[face]
      const meshPasses = this.meshRenderer.buildMeshPasses(
        meshNodes,
        materials,
        camera,
        this._probeSize,
        this._probeSize,
        {
          albedoFallbackTexture: 'scene_albedo_fallback',
          outputs: PROBE_GBUF_OUTPUTS,
          passId
        }
      )
      for (const pass of meshPasses) this.backend.executePass(pass, frameState)
      // Volumes come along on every face. The probe primes all six and then
      // amortizes to one face per frame, so a volume costs one extra march per
      // frame at probe resolution once the cube is up.
      const volumePasses = this.volumeRenderer.buildVolumePasses(
        volumeNodes,
        materials,
        camera,
        this._probeSize,
        this._probeSize,
        {
          outputs: PROBE_GBUF_OUTPUTS,
          passId,
          firstClear: meshPasses.length === 0
        }
      )
      for (const pass of volumePasses) this.backend.executePass(pass, frameState)
      if (meshPasses.length === 0 && volumePasses.length === 0) {
        clearGBuffer(this.backend, PROBE_GBUF_OUTPUTS)
      }

      // One descriptor per face, built with the constructor. Only the
      // environment binding and the uniform block move between frames.
      const probeLighting = this._probeLightingPassStates[face]
      probeLighting.pass.inputs.u_envTexture = envTexture
      this._buildLightingUniforms(
        probeLighting,
        position,
        lights,
        background,
        sky,
        ground,
        0,
        envIntensity,
        0,
        1
      )
      this.backend.executePass(probeLighting.pass, frameState)
    }

    if (this._probeInitialized) {
      this._probeNextFace = (this._probeNextFace + 1) % CUBE_FACES.length
    } else {
      this._probeInitialized = true
      this._probeNextFace = 0
    }
  }

  /**
   * Open a cubemap export.
   *
   * Two things are arranged here, both about the reflection probe.
   *
   * The probe is a world-space cube captured from a fixed point, so it does
   * not change between export faces — one capture is correct for all six. The
   * first face therefore primes the whole cube (`_probeInitialized = false`),
   * and `renderCubemapFace` freezes it afterwards so the remaining five
   * faces sample the completed cube instead of re-rendering the same six
   * views five more times. Faces still light with the probe: only the capture
   * is skipped.
   *
   * A live render loop's amortization state is saved and restored, so an
   * export cannot move the rotation a running loop is partway through — the
   * cube it leaves behind is fully current either way.
   */
  beginCubemapExport() {
    this._probeStateBeforeExport = {
      initialized: this._probeInitialized,
      nextFace: this._probeNextFace
    }
    this._probeFrozen = false
    this._probeInitialized = false
    this._probeNextFace = 0
  }

  /**
   * Draw one cube face of a cubemap export.
   *
   * The full pass stack runs per face — G-buffer, SSAO, deferred lighting,
   * reflections, tone-mapped present — from a square 90-degree camera at the
   * SCENE camera's position, aimed along the face axis. Never tiled: a face is
   * sampled by direction, so a screen tile would capture a fraction of it.
   * @param {SceneTree} sceneTree - Scene to draw
   * @param {Clock} clock - Supplies elapsed time; ticked once per export, not
   *   per face, so all six faces are the same instant
   * @param {number} face - CUBE_FACES index, 0..5 (+X,-X,+Y,-Y,+Z,-Z)
   * @param {string} target - Texture to present the face into
   */
  async renderCubemapFace(sceneTree, clock, face, target) {
    const sceneCamera = sceneTree.camera
    const camera = this._cubeExportCamera
    camera.near = sceneCamera.near
    camera.far = sceneCamera.far
    // -1: the face is read back as an image, not sampled as a cube texture.
    aimCameraAtCubeFace(camera, sceneCamera._position || DEFAULT_CAMERA_POSITION, face, -1)

    await this.render(sceneTree, clock, target, null, camera)
    this._probeFrozen = true
  }

  /** Close a cubemap export, restoring the live probe's amortization state. */
  endCubemapExport() {
    this._probeFrozen = false
    const saved = this._probeStateBeforeExport
    if (!saved) return
    this._probeInitialized = saved.initialized
    this._probeNextFace = saved.nextFace
    this._probeStateBeforeExport = null
  }

  _preparePlanarReflection(reflector, camera, aspect) {
    planeFromWorldMatrix(
      this._planePoint,
      this._planeNormal,
      reflector.getWorldMatrix()
    )
    const normalLength = Math.hypot(
      this._planeNormal[0],
      this._planeNormal[1],
      this._planeNormal[2]
    )
    if (normalLength < 0.5) return false

    const cameraPosition = camera._position || DEFAULT_CAMERA_POSITION
    const cameraSide =
      (cameraPosition[0] - this._planePoint[0]) * this._planeNormal[0] +
      (cameraPosition[1] - this._planePoint[1]) * this._planeNormal[1] +
      (cameraPosition[2] - this._planePoint[2]) * this._planeNormal[2]
    if (cameraSide < 0) {
      this._planeNormal[0] *= -1
      this._planeNormal[1] *= -1
      this._planeNormal[2] *= -1
    }

    const reflectedCamera = this._reflectionCamera
    reflectedCamera.fov = camera.fov
    reflectedCamera.near = camera.near
    reflectedCamera.far = camera.far
    // The mirrored view fills a G-buffer of the same size as the main one and
    // SSR projects the receiver into it with u_reflectionViewProj, so when the
    // main view is a tile the mirror is the same tile of the mirrored image.
    // Any other frustum here would sample the planar target at the wrong UV.
    reflectedCamera.tile = camera.tile
    reflectPointAcrossPlane(
      reflectedCamera._position,
      cameraPosition,
      this._planePoint,
      this._planeNormal
    )
    reflectPointAcrossPlane(
      reflectedCamera.target,
      camera.target || DEFAULT_TARGET,
      this._planePoint,
      this._planeNormal
    )
    reflectDirectionAcrossPlane(
      reflectedCamera.up,
      camera.up || DEFAULT_UP,
      this._planeNormal
    )

    this._clipPlane[0] = this._planeNormal[0]
    this._clipPlane[1] = this._planeNormal[1]
    this._clipPlane[2] = this._planeNormal[2]
    this._clipPlane[3] = -(
      this._planeNormal[0] * this._planePoint[0] +
      this._planeNormal[1] * this._planePoint[1] +
      this._planeNormal[2] * this._planePoint[2]
    )

    mat4.multiply(
      this._reflectionViewProj,
      reflectedCamera.getProjectionMatrix(aspect),
      reflectedCamera.getViewMatrix()
    )
    return true
  }

  /**
   * Write one lighting variant's uniform block into its reused pass state.
   *
   * The block used to be a fresh object literal per variant per frame, plus
   * eight template-literal keys per light. Both are now written into the
   * descriptor the constructor built; `state.lightCount` records how many
   * light slots the block currently carries so a scene that DROPS a light does
   * not leave the surplus slots behind for the shader to read. That is a
   * rebuild, not a steady-state cost: the same change recompiles the lighting
   * shader in _ensureLightingShader.
   * @param {{pass: object, lightCount: number}} state - Reusable pass state
   * @param {ArrayLike<number>} cameraPosition - Eye the variant lights from
   * @param {object[]} lights - Scene lights
   * @param {ArrayLike<number>} background - Background colour
   * @param {ArrayLike<number>} sky - Upper hemisphere ambient
   * @param {ArrayLike<number>} ground - Lower hemisphere ambient
   * @param {number} ssaoStrength - 0 disables the AO sample
   * @param {number} envIntensity - 0 disables the environment sample
   * @param {number} [probeEnabled=0] - Whether specular samples the probe
   * @param {number} [probeCapture=0] - Whether this IS a probe capture
   */
  _buildLightingUniforms(
    state,
    cameraPosition,
    lights,
    background,
    sky,
    ground,
    ssaoStrength,
    envIntensity,
    probeEnabled = 0,
    probeCapture = 0
  ) {
    const uniforms = state.pass.uniforms
    uniforms.u_cameraPos = cameraPosition
    uniforms.u_backgroundColor = background
    uniforms.u_skyColor = sky
    uniforms.u_groundColor = ground
    uniforms.u_ssaoStrength = ssaoStrength
    uniforms.u_envIntensity = envIntensity
    uniforms.u_probeEnabled = probeEnabled
    uniforms.u_probeCapture = probeCapture
    // Per-light uniforms. lightType: 0 = point, 1 = directional, 2 = spot.
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i]
      const keys = lightUniformKeys(i)
      uniforms[keys.position] = light.position || DEFAULT_LIGHT_POSITION
      uniforms[keys.color] = light.color || DEFAULT_LIGHT_COLOR
      uniforms[keys.intensity] = light.intensity ?? 1
      uniforms[keys.lightType] = LIGHT_TYPE_CODE[light.lightType] ?? 0
      uniforms[keys.direction] = light.direction || DEFAULT_LIGHT_DIRECTION
      const angleRad = (light.angle ?? 45) * Math.PI / 180
      const outerRad = angleRad * (1 + (light.penumbra ?? 0.1))
      uniforms[keys.cosInner] = Math.cos(angleRad)
      uniforms[keys.cosOuter] = Math.cos(outerRad)
      uniforms[keys.falloff] = light.falloff ?? 0
    }
    for (let i = lights.length; i < state.lightCount; i++) {
      const keys = lightUniformKeys(i)
      delete uniforms[keys.position]
      delete uniforms[keys.color]
      delete uniforms[keys.intensity]
      delete uniforms[keys.lightType]
      delete uniforms[keys.direction]
      delete uniforms[keys.cosInner]
      delete uniforms[keys.cosOuter]
      delete uniforms[keys.falloff]
    }
    state.lightCount = lights.length
  }

  async _ensureLightingShader(numLights) {
    const count = Math.max(numLights, 1)
    const id = 'scene_lighting'
    // Recompile if light count changes (rare)
    if (this._lastLightCount !== count) {
      const shader = this.gbufferConfig.getDeferredLightingShader(this._shaderLang, count)
      await this.backend.compileProgram(id, { fragment: shader, perBindingUniforms: true })
      this._lastLightCount = count
    }
  }

  /**
   * Release the geometry cache and per-node pass state without touching the
   * render targets. For a renderer that outlives the tree it drew — a
   * same-backend recompile — so geometry the new tree no longer declares is
   * not stranded on the GPU. The next render re-uploads what it needs.
   */
  releaseGeometry() {
    if (this.volumeRenderer) this.volumeRenderer.dispose()
    if (this.meshRenderer) this.meshRenderer.dispose()
  }

  dispose() {
    if (!this.backend) return
    for (const tex of ALL_TEXTURES) {
      this.backend.destroyTexture(tex.id)
    }
    for (const tex of PROBE_GBUF_TEXTURES) {
      this.backend.destroyTexture(tex.id)
    }
    this.backend.destroyTexture(REFLECTION_PROBE_TEXTURE)
    this.backend.destroyTexture(REFLECTION_PROBE_FALLBACK)
    // Mesh geometry lives in textures the mesh renderer owns — including the
    // bounding box the volume renderer draws, which shares that cache.
    if (this.volumeRenderer) this.volumeRenderer.dispose()
    if (this.meshRenderer) this.meshRenderer.dispose()
  }
}
