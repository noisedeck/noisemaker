// shaders/src/rendering/mesh-renderer.js
import { createSphere, createBox, createPlane, createCylinder, createTorus } from '../geometry/primitives.js'
import { mat4 } from '../scene/math.js'

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
    this._meshIdCounter = 0
  }

  /**
   * Get or create expanded (non-indexed) geometry for a mesh type,
   * upload to GPU as textures, return handle with metadata.
   */
  getGeometry(meshType, meshParams) {
    const key = meshType + JSON.stringify(meshParams)
    if (this._geometryCache.has(key)) return this._geometryCache.get(key)

    const geo = this._createPrimitive(meshType, meshParams)
    if (!geo) return null

    // Expand indexed geometry to non-indexed (backend uses drawArrays)
    const expanded = this._expandIndices(geo)

    // Pack into 2D texture grid
    const vertexCount = expanded.positions.length / 3
    const texWidth = Math.ceil(Math.sqrt(vertexCount))
    const texHeight = Math.ceil(vertexCount / texWidth)
    const totalTexels = texWidth * texHeight

    // Pad to fill texture (RGBA32F: xyz + w=0)
    const posData = new Float32Array(totalTexels * 4)
    const normData = new Float32Array(totalTexels * 4)
    const uvData = new Float32Array(totalTexels * 4)

    for (let i = 0; i < vertexCount; i++) {
      posData[i * 4] = expanded.positions[i * 3]
      posData[i * 4 + 1] = expanded.positions[i * 3 + 1]
      posData[i * 4 + 2] = expanded.positions[i * 3 + 2]
      posData[i * 4 + 3] = 1.0 // valid flag

      normData[i * 4] = expanded.normals[i * 3]
      normData[i * 4 + 1] = expanded.normals[i * 3 + 1]
      normData[i * 4 + 2] = expanded.normals[i * 3 + 2]

      if (expanded.uvs) {
        uvData[i * 4] = expanded.uvs[i * 2]
        uvData[i * 4 + 1] = expanded.uvs[i * 2 + 1]
      }
    }

    const meshId = `scene_mesh_${this._meshIdCounter++}`

    if (this.backend) {
      this.backend.uploadMeshData(meshId, posData, normData, uvData, texWidth, texHeight, vertexCount)
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
    const passes = []
    const aspect = width / height
    const viewMatrix = camera.getViewMatrix()
    const projMatrix = camera.getProjectionMatrix(aspect)
    const albedoFallback = opts.albedoFallbackTexture ?? null
    const outputs = opts.outputs ?? DEFAULT_OUTPUTS
    const passId = opts.passId ?? 'scene_mesh_gbuf_pass'
    const clipPlane = opts.clipPlane ?? DEFAULT_CLIP_PLANE
    const clipEnabled = opts.clipPlane ? 1 : 0

    for (let i = 0; i < meshNodes.length; i++) {
      const node = meshNodes[i]
      if (node === opts.excludeNode) continue
      const handle = this.getGeometry(node.meshType, node.meshParams || {})
      if (!handle) continue

      const modelMatrix = node.getWorldMatrix()
      const normalMatrix = mat4.create()
      mat4.invert(normalMatrix, modelMatrix)
      mat4.transpose(normalMatrix, normalMatrix)

      // Resolve material
      const mat = (node.materialId && materials[node.materialId]) || {}
      const pbr = mat.pbr || {}
      const baseColor = finiteVector(mat.baseColor, 3, DEFAULT_COLOR)
      const uvScale = finiteVector(mat.uvScale, 2, DEFAULT_UV_SCALE)
      const uvOffset = finiteVector(mat.uvOffset, 2, DEFAULT_UV_OFFSET)
      const metallic = boundedNumber(pbr.metallic, 0, 0, 1)
      const roughness = boundedNumber(pbr.roughness, 1, 0.045, 1)
      const emission = boundedNumber(mat.emission, 0, 0, Number.POSITIVE_INFINITY)

      const inputs = {
        u_positions: `global_${handle.meshId}_positions`,
        u_normals: `global_${handle.meshId}_normals`,
        u_uvs: `global_${handle.meshId}_uvs`
      }
      let hasAlbedoTexture = 0
      if (mat.albedoSurface) {
        // A DSL surface as albedo: sampled by mesh UV. Content is the
        // surface's previous-frame read side (the scene renders before the
        // pipeline each frame) — standard feedback semantics.
        inputs.u_albedoTexture = `global_${mat.albedoSurface}`
        hasAlbedoTexture = 1
      } else if (albedoFallback) {
        inputs.u_albedoTexture = albedoFallback
      }

      passes.push({
        // All mesh passes share one MRT FBO + depth buffer
        id: passId,
        program: 'scene_mesh_gbuf',
        drawMode: 'triangles',
        cullMode: opts.cullMode,
        count: handle.vertexCount,
        inputs,
        outputs,
        drawBuffers: 4,
        clear: passes.length === 0,  // only first included mesh clears G-buffer
        uniforms: {
          u_modelMatrix: modelMatrix,
          u_viewMatrix: viewMatrix,
          u_projectionMatrix: projMatrix,
          u_normalMatrix: normalMatrix,
          u_baseColor: [...baseColor, 1.0],
          u_uvScale: uvScale,
          u_uvOffset: uvOffset,
          u_metallic: metallic,
          u_roughness: roughness,
          u_emissionStrength: emission,
          u_hasAlbedoTexture: hasAlbedoTexture,
          u_clipPlane: clipPlane,
          u_clipEnabled: clipEnabled,
          u_meshTexWidth: handle.texWidth
        }
      })
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

  _expandIndices(geometry) {
    const { positions, normals, uvs, indices } = geometry
    if (!indices || indices.length === 0) {
      return { positions, normals, uvs }
    }

    const vertexCount = indices.length
    const expandedPos = new Float32Array(vertexCount * 3)
    const expandedNorm = new Float32Array(vertexCount * 3)
    const expandedUv = uvs ? new Float32Array(vertexCount * 2) : null

    for (let i = 0; i < vertexCount; i++) {
      const idx = indices[i]
      expandedPos[i * 3] = positions[idx * 3]
      expandedPos[i * 3 + 1] = positions[idx * 3 + 1]
      expandedPos[i * 3 + 2] = positions[idx * 3 + 2]
      expandedNorm[i * 3] = normals[idx * 3]
      expandedNorm[i * 3 + 1] = normals[idx * 3 + 1]
      expandedNorm[i * 3 + 2] = normals[idx * 3 + 2]
      if (expandedUv && uvs) {
        expandedUv[i * 2] = uvs[idx * 2]
        expandedUv[i * 2 + 1] = uvs[idx * 2 + 1]
      }
    }

    return { positions: expandedPos, normals: expandedNorm, uvs: expandedUv }
  }
}
