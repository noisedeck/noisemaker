// shaders/src/rendering/scene-renderer.js
//
// Orchestrates the full deferred rendering frame by constructing pass objects
// and executing them via the existing WebGL2 backend. Never calls gl.* directly.

import { GBufferConfig } from './gbuffer.js'
import { MeshRenderer } from './mesh-renderer.js'
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

const PROBE_GBUF_TEXTURES = [
  { id: 'scene_probe_gbuf_albedo_metallic', format: 'rgba16f' },
  { id: 'scene_probe_gbuf_normal_roughness', format: 'rgba16f' },
  { id: 'scene_probe_gbuf_position_emission', format: 'rgba16f' },
  { id: 'scene_probe_gbuf_depth', format: 'r32f' }
]

const PROBE_GBUF_OUTPUTS = Object.freeze({
  color0: 'scene_probe_gbuf_albedo_metallic',
  color1: 'scene_probe_gbuf_normal_roughness',
  color2: 'scene_probe_gbuf_position_emission',
  color3: 'scene_probe_gbuf_depth'
})

const REFLECTION_PROBE_TEXTURE = 'scene_reflection_probe'
const REFLECTION_PROBE_FALLBACK = 'scene_reflection_probe_fallback'

const LIGHT_TYPE_CODE = Object.freeze({ point: 0, directional: 1, spot: 2 })
const ALL_TEXTURES = [...GBUF_TEXTURES, ...PLANAR_GBUF_TEXTURES, ...WORK_TEXTURES]

export class SceneRenderer {
  constructor(backend, existingPipeline) {
    this.backend = backend
    this.pipeline = existingPipeline
    this.meshRenderer = new MeshRenderer(backend)
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
  }

  async initialize(width, height) {
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
   */
  async render(sceneTree, clock, target = 'screen') {
    if (!this._initialized || !this.backend) return

    const camera = sceneTree.camera
    const meshNodes = sceneTree.getMeshNodes()
    const lights = sceneTree.lights || []
    const settings = sceneTree.settings || {}
    const materials = sceneTree.materials || {}
    const width = this._width
    const height = this._height
    const time = clock?.elapsed || 0
    const reflStrength = settings.reflections ?? 1
    const probeActive = reflStrength > 0 && this._prepareReflectionProbe(settings)
    if (probeActive) this._ensureReflectionProbeResources(this._resolvedProbeSize)

    // Compile before opening the frame: no await may sit between
    // beginFrame() and endFrame(), or the pipeline's own frame (which the
    // caller starts right after us) would clobber the shared command
    // encoder mid-flight on WebGPU.
    await this._ensureLightingShader(lights.length)

    const frameState = {
      frameIndex: this._frameIndex++,
      time,
      globalUniforms: {
        u_time: time,
        u_resolution: [width, height]
      },
      surfaces: {},
      writeSurfaces: {},
      screenWidth: width,
      screenHeight: height
    }

    // Expose the pipeline's surfaces (read side) so scene passes can bind
    // global_oN — surface(oN) materials and environment(oN) sample the
    // surface's previous-frame content, since the scene renders before the
    // pipeline's own frame each tick.
    if (this.pipeline?.surfaces) {
      for (const [name, surface] of this.pipeline.surfaces) {
        const tex = this.backend.textures?.get?.(surface.read)
        if (tex) frameState.surfaces[name] = tex
      }
    }

    // Bracket all scene passes in a backend frame. WebGL2 treats this as
    // cosmetic; WebGPU allocates its command encoder in beginFrame() and
    // submits in endFrame() — without the bracket every pass dereferences a
    // null encoder.
    this.backend.beginFrame(frameState)
    try {
      this._renderPasses(
        frameState,
        meshNodes,
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

  /** @private All per-frame pass execution; must contain no awaits. */
  _renderPasses(frameState, meshNodes, materials, camera, lights, settings, environment, target, width, height, probeActive) {
    const reflStrength = settings.reflections ?? 1
    const aspect = width / height
    const reflector = reflStrength > 0
      ? meshNodes.find(node => node.planarReflection)
      : null
    const planarActive = Boolean(
      reflector && this._preparePlanarReflection(reflector, camera, aspect)
    )
    const envTexture = environment ? `global_${environment.surface}` : 'scene_albedo_fallback'
    const envIntensity = environment ? (environment.intensity ?? 1) : 0
    const ambient = settings.ambient ?? 0.1
    const sky = settings.sky ?? [ambient, ambient, ambient]
    const ground = settings.ground ?? [ambient, ambient, ambient]
    const background = settings.background ?? [0, 0, 0]

    if (probeActive) {
      this._renderReflectionProbe(
        frameState,
        meshNodes,
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

    // If no meshes, clear the G-buffer
    if (meshPasses.length === 0) {
      this.backend.executePass({
        id: 'scene_gbuf_clear',
        program: 'scene_present',
        inputs: {},
        outputs: {
          color0: 'scene_gbuf_albedo_metallic',
          color1: 'scene_gbuf_normal_roughness',
          color2: 'scene_gbuf_position_emission',
          color3: 'scene_gbuf_depth'
        },
        drawBuffers: 4,
        clear: true,
        uniforms: {}
      }, frameState)
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
          passId: 'scene_planar_mesh_pass',
          excludeNode: reflector,
          clipPlane: this._clipPlane,
          cullMode: 'none'
        }
      )
      for (const pass of planarMeshPasses) {
        this.backend.executePass(pass, frameState)
      }
      if (planarMeshPasses.length === 0) {
        this.backend.executePass({
          id: 'scene_planar_gbuf_clear',
          program: 'scene_present',
          inputs: {},
          outputs: PLANAR_GBUF_OUTPUTS,
          drawBuffers: 4,
          clear: true,
          uniforms: {}
        }, frameState)
      }
    }

    // View-projection is shared by SSAO reprojection and SSR marching.
    mat4.multiply(this._viewProj, camera.getProjectionMatrix(aspect), camera.getViewMatrix())

    // --- 1b. SSAO pass ---
    const ssaoStrength = settings.ssao ?? 1
    if (ssaoStrength > 0) {
      this.backend.executePass({
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
          u_cameraPos: camera._position || [0, 0, 5],
          u_radius: settings.ssaoRadius ?? 0.75
        }
      }, frameState)
    }

    // --- 2. Deferred lighting pass ---
    // (shader ensured before the frame opened — see render())
    const lightingUniforms = this._buildLightingUniforms(
      camera._position || [0, 0, 5],
      lights,
      background,
      sky,
      ground,
      ssaoStrength,
      envIntensity,
      probeActive ? 1 : 0,
      0
    )

    if (planarActive) {
      this.backend.executePass({
        id: 'scene_planar_lighting',
        program: 'scene_lighting',
        inputs: {
          u_albedoMetallic: 'scene_planar_gbuf_albedo_metallic',
          u_normalRoughness: 'scene_planar_gbuf_normal_roughness',
          u_positionEmission: 'scene_planar_gbuf_position_emission',
          u_depth: 'scene_planar_gbuf_depth',
          u_ssao: 'scene_albedo_fallback',
          u_envTexture: envTexture,
          u_reflectionProbe: probeActive ? REFLECTION_PROBE_TEXTURE : REFLECTION_PROBE_FALLBACK
        },
        outputs: { color0: 'scene_planar_lit' },
        drawBuffers: 1,
        clear: true,
        uniforms: this._buildLightingUniforms(
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
      }, frameState)
    }

    this.backend.executePass({
      id: 'scene_lighting',
      program: 'scene_lighting',
      inputs: {
        u_albedoMetallic: 'scene_gbuf_albedo_metallic',
        u_normalRoughness: 'scene_gbuf_normal_roughness',
        u_positionEmission: 'scene_gbuf_position_emission',
        u_depth: 'scene_gbuf_depth',
        // With SSAO off, u_ssaoStrength is 0 so the shader ignores the
        // sample — any bindable texture satisfies the declaration. Same
        // contract for the environment at intensity 0.
        u_ssao: ssaoStrength > 0 ? 'scene_ssao' : 'scene_albedo_fallback',
        u_envTexture: envTexture,
        u_reflectionProbe: probeActive ? REFLECTION_PROBE_TEXTURE : REFLECTION_PROBE_FALLBACK
      },
      outputs: { color0: 'scene_lit_color' },
      drawBuffers: 1,
      clear: true,
      uniforms: lightingUniforms
    }, frameState)

    // --- 2b. Reflections ---
    // The existing reflection stage composites the mirrored scene on the
    // explicit planar receiver, then uses SSR only for all other materials.
    // Keeping this in one fullscreen pass preserves WebGPU texture parity.
    if (reflStrength > 0) {
      this.backend.executePass({
        id: 'scene_ssr_pass',
        program: 'scene_ssr',
        inputs: {
          u_litColor: 'scene_lit_color',
          u_albedoMetallic: 'scene_gbuf_albedo_metallic',
          u_normalRoughness: 'scene_gbuf_normal_roughness',
          u_positionEmission: 'scene_gbuf_position_emission',
          u_depth: 'scene_gbuf_depth',
          u_planarReflection: planarActive ? 'scene_planar_lit' : 'scene_albedo_fallback'
        },
        outputs: { color: 'scene_reflect_color' },
        clear: true,
        uniforms: {
          u_viewProj: this._viewProj,
          u_reflectionViewProj: this._reflectionViewProj,
          u_cameraPos: camera._position || [0, 0, 5],
          u_reflStrength: reflStrength,
          u_planarEnabled: planarActive ? 1 : 0,
          u_planePoint: this._planePoint,
          u_planeNormal: this._planeNormal
        }
      }, frameState)
    }

    // --- 3. Present (with tone mapping + gamma) ---
    this.backend.executePass({
      id: 'scene_tonemap_present',
      program: 'scene_tonemap_present',
      inputs: { u_texture: reflStrength > 0 ? 'scene_reflect_color' : 'scene_lit_color' },
      outputs: { color: target },
      clear: true,
      uniforms: { u_exposure: settings.exposure ?? 1 }
    }, frameState)
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

  _renderReflectionProbe(frameState, meshNodes, materials, lights, envTexture, envIntensity, background, sky, ground) {
    const camera = this._probeCamera
    const position = this._probePosition
    camera._position[0] = position[0]
    camera._position[1] = position[1]
    camera._position[2] = position[2]

    const faceCount = this._probeInitialized ? 1 : CUBE_FACES.length
    const firstFace = this._probeInitialized ? this._probeNextFace : 0
    for (let faceOffset = 0; faceOffset < faceCount; faceOffset++) {
      const face = (firstFace + faceOffset) % CUBE_FACES.length
      const cubeFace = CUBE_FACES[face]
      camera.target[0] = position[0] + cubeFace.forward[0]
      camera.target[1] = position[1] + cubeFace.forward[1]
      camera.target[2] = position[2] + cubeFace.forward[2]
      camera.up[0] = cubeFace.up[0]
      camera.up[1] = cubeFace.up[1]
      camera.up[2] = cubeFace.up[2]

      const meshPasses = this.meshRenderer.buildMeshPasses(
        meshNodes,
        materials,
        camera,
        this._probeSize,
        this._probeSize,
        {
          albedoFallbackTexture: 'scene_albedo_fallback',
          outputs: PROBE_GBUF_OUTPUTS,
          passId: `scene_probe_mesh_face_${face}`
        }
      )
      for (const pass of meshPasses) this.backend.executePass(pass, frameState)
      if (meshPasses.length === 0) {
        this.backend.executePass({
          id: `scene_probe_gbuf_clear_face_${face}`,
          program: 'scene_present',
          inputs: {},
          outputs: PROBE_GBUF_OUTPUTS,
          drawBuffers: 4,
          clear: true,
          uniforms: {}
        }, frameState)
      }

      this.backend.executePass({
        id: `scene_probe_lighting_face_${face}`,
        program: 'scene_lighting',
        inputs: {
          u_albedoMetallic: 'scene_probe_gbuf_albedo_metallic',
          u_normalRoughness: 'scene_probe_gbuf_normal_roughness',
          u_positionEmission: 'scene_probe_gbuf_position_emission',
          u_depth: 'scene_probe_gbuf_depth',
          u_ssao: 'scene_albedo_fallback',
          u_envTexture: envTexture,
          u_reflectionProbe: REFLECTION_PROBE_FALLBACK
        },
        outputs: { color0: REFLECTION_PROBE_TEXTURE },
        drawBuffers: 1,
        cubeFace: face,
        clear: true,
        uniforms: this._buildLightingUniforms(
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
      }, frameState)
    }

    if (this._probeInitialized) {
      this._probeNextFace = (this._probeNextFace + 1) % CUBE_FACES.length
    } else {
      this._probeInitialized = true
      this._probeNextFace = 0
    }
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

    const cameraPosition = camera._position || [0, 0, 5]
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
    reflectPointAcrossPlane(
      reflectedCamera._position,
      cameraPosition,
      this._planePoint,
      this._planeNormal
    )
    reflectPointAcrossPlane(
      reflectedCamera.target,
      camera.target || [0, 0, 0],
      this._planePoint,
      this._planeNormal
    )
    reflectDirectionAcrossPlane(
      reflectedCamera.up,
      camera.up || [0, 1, 0],
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

  _buildLightingUniforms(
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
    const uniforms = {
      u_cameraPos: cameraPosition,
      u_backgroundColor: background,
      u_skyColor: sky,
      u_groundColor: ground,
      u_ssaoStrength: ssaoStrength,
      u_envIntensity: envIntensity,
      u_probeEnabled: probeEnabled,
      u_probeCapture: probeCapture
    }
    // Per-light uniforms. lightType: 0 = point, 1 = directional, 2 = spot.
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i]
      const prefix = `u_lights[${i}]`
      uniforms[`${prefix}.position`] = light.position || [0, 0, 0]
      uniforms[`${prefix}.color`] = light.color || [1, 1, 1]
      uniforms[`${prefix}.intensity`] = light.intensity ?? 1
      uniforms[`${prefix}.lightType`] = LIGHT_TYPE_CODE[light.lightType] ?? 0
      uniforms[`${prefix}.direction`] = light.direction || [0, -1, 0]
      const angleRad = (light.angle ?? 45) * Math.PI / 180
      const outerRad = angleRad * (1 + (light.penumbra ?? 0.1))
      uniforms[`${prefix}.cosInner`] = Math.cos(angleRad)
      uniforms[`${prefix}.cosOuter`] = Math.cos(outerRad)
      uniforms[`${prefix}.falloff`] = light.falloff ?? 0
    }
    return uniforms
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
  }
}
