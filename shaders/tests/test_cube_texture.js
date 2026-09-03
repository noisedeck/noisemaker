import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'

const calls = []
const stubGl = new Proxy({ TEXTURE_CUBE_MAP: 34067, TEXTURE_CUBE_MAP_POSITIVE_X: 34069, RGBA: 6408, RGBA8: 32856, UNSIGNED_BYTE: 5121,
  RGBA16F: 34842, HALF_FLOAT: 5131, FRAMEBUFFER: 36160, COLOR_ATTACHMENT0: 36064,
  TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240, LINEAR: 9729, TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, CLAMP_TO_EDGE: 33071 },
  { get: (t, k) => (k in t ? t[k] : (...args) => {
    calls.push({ name: String(k), args })
    if (k === 'createTexture' || k === 'createFramebuffer') return { kind: String(k) }
    return undefined
  }) })

const b = Object.create(WebGL2Backend.prototype)
b.gl = stubGl
b.textures = new Map()
b.fbos = new Map()
b.createCubeTexture('cubeTest', { size: 64, format: 'rgba16f', usage: ['render', 'sample'] })
if (!b.textures.has('cubeTest')) throw new Error('cube texture not registered')
if (!b.fbos.has('cubeTest')) throw new Error('renderable cube texture must register a framebuffer')
const texImage2DCount = calls.filter((c) => c.name === 'texImage2D').length
if (texImage2DCount !== 6) throw new Error(`expected 6 texImage2D face allocations, got ${texImage2DCount}`)
const faceAllocations = calls.filter((c) => c.name === 'texImage2D')
if (!faceAllocations.every((c) => c.args[2] === stubGl.RGBA16F && c.args[7] === stubGl.HALF_FLOAT)) {
  throw new Error('cube faces must honor the requested HDR format')
}

const cubeTextureBinds = []
b.maxTextureUnits = 16
b.defaultTexture = {}
b.parseGlobalName = () => null
b.bindTextures(
  { id: 'sampleCube', inputs: { u_reflectionProbe: 'cubeTest' } },
  { uniforms: { u_reflectionProbe: { location: 0 } } },
  {}
)
for (const call of calls) {
  if (call.name === 'bindTexture') cubeTextureBinds.push(call.args[0])
}
if (cubeTextureBinds.at(-1) !== stubGl.TEXTURE_CUBE_MAP) {
  throw new Error('cube texture inputs must bind TEXTURE_CUBE_MAP')
}

const previousGPUTextureUsage = globalThis.GPUTextureUsage
globalThis.GPUTextureUsage = {
  TEXTURE_BINDING: 1,
  COPY_DST: 2,
  RENDER_ATTACHMENT: 4
}
const viewSpecs = []
const gpuTexture = {
  createView(spec) {
    viewSpecs.push(spec)
    return { spec }
  }
}
const gpu = Object.create(WebGPUBackend.prototype)
gpu.device = {
  createTexture(spec) {
    gpu.createdSpec = spec
    return gpuTexture
  }
}
gpu.textures = new Map()
const gpuCube = gpu.createCubeTexture('gpuCubeTest', {
  size: 32,
  format: 'rgba16f',
  usage: ['render', 'sample']
})
if (gpu.createdSpec.format !== 'rgba16float') throw new Error('WebGPU cube texture must honor HDR format')
if (gpuCube.faceViews?.length !== 6) throw new Error('WebGPU cube render target must expose six face views')
if (!viewSpecs.some((spec) => spec?.dimension === 'cube')) throw new Error('WebGPU cube sampler view missing')
if (viewSpecs.filter((spec) => spec?.dimension === '2d').length !== 6) {
  throw new Error('WebGPU cube render target must create one 2D attachment view per face')
}

const depthTextures = []
const depthBackend = Object.create(WebGPUBackend.prototype)
depthBackend.device = {
  createTexture(spec) {
    const texture = {
      spec,
      destroyed: false,
      destroy() { this.destroyed = true }
    }
    depthTextures.push(texture)
    return texture
  }
}
depthBackend.depthTextures = new Map()
const probeDepth = depthBackend.getDepthTexture(128, 128)
const screenDepth = depthBackend.getDepthTexture(640, 480)
const probeDepthAgain = depthBackend.getDepthTexture(128, 128)
if (probeDepth !== probeDepthAgain) throw new Error('depth targets must be cached by dimensions')
if (probeDepth.destroyed || screenDepth.destroyed) {
  throw new Error('switching viewport sizes in one command buffer must not destroy an encoded depth target')
}
globalThis.GPUTextureUsage = previousGPUTextureUsage

console.log('All cube texture tests passed')
