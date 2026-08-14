// Miscellaneous utilities: canvas export, logging, seeded random, shape and color helpers.

import { Tensor } from './tensor.js'
import {
  Random,
  getSeed,
  getBaseSeed,
  random,
  randomInt,
  choice,
  uniform,
  normal as rngNormal,
  setSeed as setRNGSeed,
} from './rng.js'
import { setSeed as setSimplexSeed } from './simplex.js'

export function setSeed(s) {
  setRNGSeed(s)
  setSimplexSeed(s)
}

export { Random, getSeed, getBaseSeed, random, randomInt, choice, uniform }
export const normal = (...args) => rngNormal(...args)
export const randomNormal = (mean = 0, stddev = 1) => rngNormal(undefined, mean, stddev)

export function withTensorData(tensor, fn) {
  const handle = (t) => {
    const res = t && typeof t.read === 'function' ? t.read() : t
    if (res && typeof res.then === 'function') {
      return res.then(fn)
    }
    return fn(res)
  }

  if (tensor && typeof tensor.then === 'function') {
    return tensor.then(handle)
  }
  return handle(tensor)
}

export function withTensorDatas(tensors, fn) {
  const reads = tensors.map((t) => {
    if (t && typeof t.then === 'function') {
      return t.then((tt) => (tt && typeof tt.read === 'function' ? tt.read() : tt))
    }
    return t && typeof t.read === 'function' ? t.read() : t
  })
  if (reads.some((r) => r && typeof r.then === 'function')) {
    return Promise.all(reads).then((datas) => fn(...datas))
  }
  return fn(...reads)
}

// --------------------- Logger ---------------------
let _logger = console

export function setLogger(logger) {
  _logger = logger || console
}

export const logger = {
  debug: (...args) => (_logger.debug ? _logger.debug(...args) : _logger.log(...args)),
  info: (...args) => (_logger.info ? _logger.info(...args) : _logger.log(...args)),
  warn: (...args) => (_logger.warn ? _logger.warn(...args) : _logger.log(...args)),
  error: (...args) => (_logger.error ? _logger.error(...args) : _logger.log(...args)),
}

// --------------------- Seeded random utilities ---------------------
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; --i) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// --------------------- Shape helpers ---------------------
export function shapeFromParams(width, height, colorSpace = 'rgb', withAlpha = false) {
  const channels = colorSpace === 'grayscale' ? 1 : 3
  return [height, width, withAlpha ? channels + 1 : channels]
}

// --------------------- Canvas/Tensor helpers ---------------------
export function tensorFromImage(image) {
  if (typeof document === 'undefined') {
    throw new Error('tensorFromImage requires a browser environment')
  }
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true })
  ctx2d.drawImage(image, 0, 0)
  const imgData = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data
  const arr = new Float32Array(canvas.width * canvas.height * 4)
  for (let i = 0; i < imgData.length; ++i) {
    arr[i] = imgData[i] / 255
  }
  return Tensor.fromArray(null, arr, [canvas.height, canvas.width, 4])
}

export function savePNG(tensor, filename = 'image.png') {
  if (typeof document === 'undefined') {
    throw new Error('savePNG requires a browser environment')
  }
  const [h, w, c] = tensor.shape
  const draw = (data) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true })
    const imgData = ctx2d.createImageData(w, h)
    let useAlpha = false
    if (c > 3) {
      for (let i = 0; i < h * w; ++i) {
        if (data[i * c + 3] > 0) {
          useAlpha = true
          break
        }
      }
    }
    for (let i = 0; i < h * w; ++i) {
      const idx = i * 4
      const src = i * c
      imgData.data[idx] = Math.round((data[src] || 0) * 255)
      imgData.data[idx + 1] = Math.round((data[src + 1] || 0) * 255)
      imgData.data[idx + 2] = Math.round((data[src + 2] || 0) * 255)
      const alpha = useAlpha ? data[src + 3] : 1
      imgData.data[idx + 3] = Math.round(alpha * 255)
    }
    ctx2d.putImageData(imgData, 0, 0)
    const link = document.createElement('a')
    link.download = filename
    link.href = canvas.toDataURL('image/png')
    link.click()
    return link.href
  }
  return withTensorData(tensor, draw)
}

// --------------------- Colour helpers ---------------------
export function srgbToLin(v) {
  return Math.fround(
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
  )
}

export function linToSRGB(v) {
  const f32 = Math.fround
  const value = f32(v)
  const threshold = f32(0.0031308)
  if (value <= threshold) {
    return f32(f32(value) * f32(12.92))
  }
  const gamma = f32(1 / 2.4)
  const pow = f32(Math.pow(value, gamma))
  return f32(f32(f32(1.055) * pow) - 0.055)
}

export function fromSRGB(tensor) {
  const [h, w, c] = tensor.shape
  return withTensorData(tensor, (data) => {
    const out = new Float32Array(data.length)
    const channels = Math.min(c, 3)
    for (let i = 0; i < h * w; i++) {
      const base = i * c
      for (let ch = 0; ch < channels; ch++) {
        out[base + ch] = srgbToLin(data[base + ch])
      }
      for (let ch = channels; ch < c; ch++) {
        out[base + ch] = data[base + ch]
      }
    }
    return Tensor.fromArray(tensor.ctx, out, tensor.shape)
  })
}

export function toSRGB(tensor) {
  const [h, w, c] = tensor.shape
  return withTensorData(tensor, (data) => {
    const out = new Float32Array(data.length)
    const channels = Math.min(c, 3)
    for (let i = 0; i < h * w; i++) {
      const base = i * c
      for (let ch = 0; ch < channels; ch++) {
        out[base + ch] = linToSRGB(data[base + ch])
      }
      for (let ch = channels; ch < c; ch++) {
        out[base + ch] = data[base + ch]
      }
    }
    return Tensor.fromArray(tensor.ctx, out, tensor.shape)
  })
}

export const color = { srgbToLin, linToSRGB, fromSRGB, toSRGB }

