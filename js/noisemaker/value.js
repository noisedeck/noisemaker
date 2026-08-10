import { Tensor } from './tensor.js'
import {
  ValueDistribution,
  DistanceMetric,
  InterpolationType,
  isNativeSize,
} from './constants.js'
import { maskValues } from './masks.js'
import {
  random,
  setSeed as setRNGSeed,
  withTensorData,
  withTensorDatas,
} from './util.js'
import {
  simplex as simplexNoise,
  setSeed as setSimplexSeed,
  getSeed as getSimplexSeed,
} from './simplex.js'
import { rgbToOklab } from './oklab.js'

export function setSeed(s) {
  setRNGSeed(s)
  setSimplexSeed(s)
}

const TAU = Math.PI * 2

function fract(x) {
  return x - Math.floor(x)
}

function rand2D(x, y, seed = 0, time = 0, speed = 1) {
  const sx = Math.floor(x)
  const sy = Math.floor(y)
  const s =
    sx * 12.9898 +
    sy * 78.233 +
    seed * 37.719 +
    time * speed * 0.1
  return fract(Math.sin(s) * 43758.5453)
}

function periodicValue(t, v) {
  const delta = Math.fround(Math.fround(t) - Math.fround(v))
  const angle = Math.fround(delta * Math.fround(TAU))
  return Math.fround((Math.fround(Math.sin(angle)) + 1) * 0.5)
}

function offsetTensor(tensor, shape, x = 0, y = 0) {
  const [h, w, c] = shape
  if (x === 0 && y === 0) return tensor
  return withTensorData(tensor, (src) => {
    const out = new Float32Array(h * w * c)
    for (let yy = 0; yy < h; yy++) {
      const sy = (yy + y + h) % h
      for (let xx = 0; xx < w; xx++) {
        const sx = (xx + x + w) % w
        const dst = (yy * w + xx) * c
        const sIdx = (sy * w + sx) * c
        for (let k = 0; k < c; k++) {
          out[dst + k] = src[sIdx + k]
        }
      }
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, c])
  })
}

function pinCorners(tensor, shape, freq, corners) {
  if (
    (!corners && freq[0] % 2 === 0) ||
    (corners && freq[0] % 2 === 1)
  ) {
    const xOff = Math.floor((shape[1] / freq[1]) * 0.5)
    const yOff = Math.floor((shape[0] / freq[0]) * 0.5)
    return offsetTensor(tensor, shape, xOff, yOff)
  }
  return tensor
}

const CENTER_DISTRIBUTIONS = new Set([
  ValueDistribution.center_circle,
  ValueDistribution.center_triangle,
  ValueDistribution.center_diamond,
  ValueDistribution.center_square,
  ValueDistribution.center_pentagon,
  ValueDistribution.center_hexagon,
  ValueDistribution.center_heptagon,
  ValueDistribution.center_octagon,
  ValueDistribution.center_nonagon,
  ValueDistribution.center_decagon,
  ValueDistribution.center_hendecagon,
  ValueDistribution.center_dodecagon,
])

function centerDistributionConfig(distrib) {
  let metric = DistanceMetric.euclidean
  let sdfSides = 3
  switch (distrib) {
    case ValueDistribution.center_triangle:
      metric = DistanceMetric.triangular
      break
    case ValueDistribution.center_diamond:
      metric = DistanceMetric.manhattan
      break
    case ValueDistribution.center_square:
      metric = DistanceMetric.chebyshev
      break
    case ValueDistribution.center_pentagon:
      metric = DistanceMetric.sdf
      sdfSides = 5
      break
    case ValueDistribution.center_hexagon:
      metric = DistanceMetric.hexagram
      break
    case ValueDistribution.center_heptagon:
      metric = DistanceMetric.sdf
      sdfSides = 7
      break
    case ValueDistribution.center_octagon:
      metric = DistanceMetric.octagram
      break
    case ValueDistribution.center_nonagon:
      metric = DistanceMetric.sdf
      sdfSides = 9
      break
    case ValueDistribution.center_decagon:
      metric = DistanceMetric.sdf
      sdfSides = 10
      break
    case ValueDistribution.center_hendecagon:
      metric = DistanceMetric.sdf
      sdfSides = 11
      break
    case ValueDistribution.center_dodecagon:
      metric = DistanceMetric.sdf
      sdfSides = 12
      break
    default:
      metric = DistanceMetric.euclidean
      break
  }
  return { metric, sdfSides }
}

function generateCenterDistribution(
  ctx,
  initHeight,
  initWidth,
  channels,
  freq,
  distrib,
  time,
  speed,
) {
  const { metric, sdfSides } = centerDistributionConfig(distrib)
  let downHeight = Math.max(1, Math.floor(initHeight * 0.5))
  let downWidth = Math.max(1, Math.floor(initWidth * 0.5))
  if (initHeight >= 2) {
    downHeight = Math.max(2, downHeight)
  }
  if (initWidth >= 2) {
    downWidth = Math.max(2, downWidth)
  }
  downHeight = Math.min(initHeight, downHeight)
  downWidth = Math.min(initWidth, downWidth)
  const totalDown = downHeight * downWidth
  const dist = new Float32Array(totalDown)
  const centerX = Math.fround(downWidth / 2)
  const centerY = Math.fround(downHeight / 2)
  const invWidth = downWidth > 0 ? Math.fround(1 / downWidth) : 1
  const invHeight = downHeight > 0 ? Math.fround(1 / downHeight) : 1
  for (let y = 0; y < downHeight; y++) {
    const dy = Math.fround((y - centerY) * invHeight)
    for (let x = 0; x < downWidth; x++) {
      const dx = Math.fround((x - centerX) * invWidth)
      const idx = y * downWidth + x
      dist[idx] = Math.fround(distance(dx, dy, metric, sdfSides))
    }
  }
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < totalDown; i++) {
    const v = dist[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  const minF = Math.fround(min)
  const range = Math.fround(max - min) || Math.fround(1)
  for (let i = 0; i < totalDown; i++) {
    const norm = Math.fround((dist[i] - minF) / range)
    dist[i] = Math.fround(Math.sqrt(Math.max(0, Math.min(1, norm))))
  }
  const downTensor = Tensor.fromArray(ctx, dist, [downHeight, downWidth, 1])
  const finalize = (resized) => {
    const baseDataMaybe = resized.read()
    const build = (baseData) => {
      const total = initHeight * initWidth
      const out = new Float32Array(total * channels)
      const tau = Math.fround(Math.PI * 2)
      const freqScale = Math.max(freq[0] ?? freq, freq[1] ?? freq[0] ?? freq)
      const freqF = Math.fround(freqScale || 1)
      const roundedSpeed = speed > 0 ? Math.floor(1 + speed) : Math.ceil(-1 + speed)
      const offset = Math.fround(tau * Math.fround(time) * Math.fround(roundedSpeed))
      for (let i = 0; i < total; i++) {
        const angle = Math.fround(Math.fround(baseData[i]) * freqF * tau - offset)
        const sine = Math.fround(Math.sin(angle))
        const value = Math.fround(Math.fround(sine + 1) * 0.5)
        const base = i * channels
        for (let c = 0; c < channels; c++) {
          out[base + c] = value
        }
      }
      return Tensor.fromArray(ctx, out, [initHeight, initWidth, channels])
    }
    if (baseDataMaybe && typeof baseDataMaybe.then === 'function') {
      return baseDataMaybe.then(build)
    }
    return build(baseDataMaybe)
  }
  const resized = resample(
    downTensor,
    [initHeight, initWidth, 1],
    InterpolationType.bicubic,
  )
  if (resized && typeof resized.then === 'function') {
    return resized.then(finalize)
  }
  return finalize(resized)
}

export function valueNoise(count, freq = 8) {
  // RNG: freq+1 calls to random for lattice points 0..freq
  const lattice = Array.from({ length: freq + 1 }, () => random())
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const x = (i / count) * freq
    const xi = Math.floor(x)
    const xf = x - xi
    const t = xf * xf * (3 - 2 * xf)
    out[i] = lattice[xi] * (1 - t) + lattice[xi + 1] * t
  }
  return out
}

export function freqForShape(freq, shape) {
  const [height, width] = shape

  // Validate inputs to prevent NaN
  if (!Number.isFinite(freq) || freq <= 0) {
    throw new Error(`Invalid frequency: ${freq}. Frequency must be a positive finite number.`)
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid height: ${height}. Height must be a positive finite number.`)
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid width: ${width}. Width must be a positive finite number.`)
  }

  if (height === width) {
    return [freq, freq]
  }
  if (height < width) {
    return [freq, Math.floor((freq * width) / height)]
  }
  return [Math.floor((freq * height) / width), freq]
}

/**
 * Generate value noise or other simple distributions.
 *
 * @param {number|[number, number]} freq Frequency of the grid (scalar or `[fx, fy]`).
 * @param {[number, number, number]} shape Output tensor shape `[height,width,channels]`.
 * @param {Object} opts Options object.
 * @param {ValueDistribution} [opts.distrib=ValueDistribution.simplex] Distribution type.
 * @param {boolean} [opts.corners=false] Wrap noise coordinates for seamless tiling.
 * @param {ValueMask} [opts.mask] Optional mask to multiply the result with.
 * @param {boolean} [opts.maskInverse=false] Invert the mask values.
 * @param {boolean} [opts.maskStatic=false] Ignore time/speed when generating masks.
 * @param {InterpolationType} [opts.splineOrder=InterpolationType.bicubic]
 *   Interpolation type.
 * @param {number} [opts.time=0] Animation time value.
 * @param {number} [opts.seed=0] Random seed.
 * @param {number} [opts.speed=1] Time multiplier for animation.
 * @returns {Tensor} Generated tensor.
 */
export function values(freq, shape, opts = {}) {
  const [height, width, channels = 1] = shape
  let freqX, freqY
  if (Array.isArray(freq)) {
    // Python's freq argument is [height, width]; mirror that here
    [freqY, freqX] = freq
  } else {
    // Match Python's freq_for_shape behavior for scalar input
    [freqY, freqX] = freqForShape(freq, [height, width])
  }
  const {
    ctx = null,
    distrib = ValueDistribution.simplex,
    corners = false,
    mask,
    maskInverse = false,
    maskStatic = false,
    splineOrder = InterpolationType.bicubic,
    time = 0,
    seed,
    speed = 1,
  } = opts
  const chainTensor = (maybeTensor, fn) => {
    if (maybeTensor && typeof maybeTensor.then === 'function') {
      return maybeTensor.then(fn)
    }
    return fn(maybeTensor)
  }
  let maskData = null
  let maskWidth = 0
  let maskHeight = 0
  let maskChannels = 0
  if (mask !== undefined && mask !== null) {
    const maskShape = [
      Math.max(1, Math.floor(freqY)),
      Math.max(1, Math.floor(freqX)),
      1,
    ]
    const [maskTensor] = maskValues(mask, maskShape, {
      inverse: maskInverse,
      time: maskStatic ? 0 : time,
      speed,
    });
    [maskHeight, maskWidth, maskChannels] = maskTensor.shape
    maskData = maskTensor.data
  }

  const fx = Math.max(1, Math.floor(freqX))
  const fy = Math.max(1, Math.floor(freqY))
  const needsFullSize = isNativeSize(distrib)
  const initWidth = needsFullSize ? width : fx
  const initHeight = needsFullSize ? height : fy
  const size = initHeight * initWidth * channels
  const freqPair = [fy, fx]
  let tensor
  if (CENTER_DISTRIBUTIONS.has(distrib)) {
    tensor = generateCenterDistribution(
      ctx,
      initHeight,
      initWidth,
      channels,
      freqPair,
      distrib,
      time,
      speed,
    )
  } else if (distrib === ValueDistribution.simplex || distrib === ValueDistribution.exp) {
    const baseSeed = (seed ?? getSimplexSeed()) >>> 0
    // Static value field; periodicValue below provides the animation. Passing
    // an animated noise here would double-animate and produce frame-over-frame
    // spikes (lattice crossings on top of the sine cycle).
    const baseNoise = simplexNoise([initHeight, initWidth, channels], {
      time: 0,
      seed: baseSeed,
      speed: 1,
    })
    if (speed === 0) {
      // Only skip periodic wrapping if speed is exactly 0 (no animation)
      tensor = baseNoise
      if (distrib === ValueDistribution.exp) {
        tensor = withTensorData(tensor, (data) => {
          const out = new Float32Array(data.length)
          for (let i = 0; i < data.length; i++) {
            out[i] = Math.pow(data[i], 4)
          }
          return Tensor.fromArray(ctx, out, [initHeight, initWidth, channels])
        })
      }
    } else {
      const timeSeed = (baseSeed + 0x9e3779b1) >>> 0
      const timeField = simplexNoise([initHeight, initWidth, channels], {
        time: 0,
        seed: timeSeed,
        speed: 1,
      })
      const makeTensor = (valueData, timeData) => {
        const out = new Float32Array(size)
        for (let i = 0; i < size; i++) {
          const scaledTime = periodicValue(time, timeData[i]) * speed
          let val = periodicValue(scaledTime, valueData[i])
          if (distrib === ValueDistribution.exp) {
            val = Math.pow(val, 4)
          }
          out[i] = val
        }
        return Tensor.fromArray(ctx, out, [initHeight, initWidth, channels])
      }
      tensor = withTensorDatas([baseNoise, timeField], makeTensor)
    }
  } else {
    const data = new Float32Array(size)
    for (let y = 0; y < initHeight; y++) {
      for (let x = 0; x < initWidth; x++) {
        let val = 0
        switch (distrib) {
          case ValueDistribution.ones:
            val = 1
            break
          case ValueDistribution.mids:
            val = 0.5
            break
          case ValueDistribution.zeros:
            val = 0
            break
          case ValueDistribution.column_index:
            val = initHeight === 1 ? 0 : y / (initHeight - 1)
            break
          case ValueDistribution.row_index:
            val = initWidth === 1 ? 0 : x / (initWidth - 1)
            break
          default:
            val = rand2D(x, y, seed, time, speed)
            break
        }
        const idx = (y * initWidth + x) * channels
        for (let c = 0; c < channels; c++) {
          data[idx + c] = val
        }
      }
    }
    tensor = Tensor.fromArray(ctx, data, [initHeight, initWidth, channels])
  }

  if (maskData) {
    const maskOutShape = needsFullSize
      ? [height, width, maskChannels]
      : [maskHeight, maskWidth, maskChannels]
    let mTensor = Tensor.fromArray(ctx, maskData, [maskHeight, maskWidth, maskChannels])
    if (needsFullSize) {
      mTensor = chainTensor(
        mTensor,
        (mt) => resample(mt, [height, width, maskChannels], splineOrder),
      )
      mTensor = chainTensor(
        mTensor,
        (mt) =>
          pinCorners(mt, [height, width, maskChannels], [freqY, freqX], corners),
      )
    }
    const combine = (t) =>
      withTensorDatas([mTensor, t], (mArr, tArr) => {
        const [mh, mw] = maskOutShape
        const total = mh * mw
        if (channels === 2) {
          const out = new Float32Array(total * 2)
          for (let i = 0; i < total; i++) {
            out[i * 2] = tArr[i * channels]
            out[i * 2 + 1] = mArr[i]
          }
          return Tensor.fromArray(ctx, out, [mh, mw, 2])
        } else if (channels === 4) {
          const out = new Float32Array(total * 4)
          for (let i = 0; i < total; i++) {
            out[i * 4] = tArr[i * channels]
            out[i * 4 + 1] = tArr[i * channels + 1]
            out[i * 4 + 2] = tArr[i * channels + 2]
            out[i * 4 + 3] = mArr[i]
          }
          return Tensor.fromArray(ctx, out, [mh, mw, 4])
        }
        for (let i = 0; i < total; i++) {
          for (let c = 0; c < channels; c++) {
            tArr[i * channels + c] *= mArr[i]
          }
        }
        return Tensor.fromArray(ctx, tArr, [mh, mw, channels])
      })
    tensor = tensor && typeof tensor.then === 'function' ? tensor.then(combine) : combine(tensor)
  }

  if (!needsFullSize) {
    tensor = chainTensor(
      tensor,
      (t) => resample(t, [height, width, channels], splineOrder),
    )
    tensor = chainTensor(
      tensor,
      (t) => pinCorners(t, [height, width, channels], [freqY, freqX], corners),
    )
  }

  if (
    distrib !== ValueDistribution.ones &&
    distrib !== ValueDistribution.mids &&
    distrib !== ValueDistribution.zeros
  ) {
    tensor = normalize(tensor)
  }

  return tensor
}



/**
 * Resample a tensor to a new shape.
 *
 * Returns a Promise when the source tensor resolves asynchronously so callers
 * can `await` the result. Pure CPU paths resolve synchronously when data is
 * already available.
 *
 * @param {Tensor} tensor
 * @param {number[]} shape
 * @param {number} [splineOrder=InterpolationType.bicubic]
 * @returns {Tensor|Promise<Tensor>}
 */
export function resample(tensor, shape, splineOrder = InterpolationType.bicubic) {
  const [h, w, c] = tensor.shape
  const [nh, nw, nc = c] = shape

  const cpuResample = (src) => {
    const out = new Float32Array(nh * nw * nc)
    const f32 = Math.fround

    const sampleWrapped = (ix, iy, k) => {
      ix = ((ix % w) + w) % w
      iy = ((iy % h) + h) % h
      const idx = (iy * w + ix) * c + Math.min(k, c - 1)
      return f32(src[idx])
    }

    const blendLinear = (a, b, g) => {
      const gg = f32(g)
      const oneMinus = f32(1 - gg)
      const termA = f32(f32(a) * oneMinus)
      const termB = f32(f32(b) * gg)
      return f32(termA + termB)
    }

    const blendCosine = (a, b, g) => {
      const gg = f32(g)
      const angle = f32(gg * Math.PI)
      const cos = f32(Math.cos(angle))
      const g2 = f32((1 - cos) / 2)
      const oneMinus = f32(1 - g2)
      const termA = f32(f32(a) * oneMinus)
      const termB = f32(f32(b) * g2)
      return f32(termA + termB)
    }

    const blendCubic = (a, b, c1, d, g) => {
      const gg = f32(g)
      const g2 = f32(gg * gg)
      const a0 = (() => {
        const step1 = f32(d - c1)
        const step2 = f32(step1 - a)
        return f32(step2 + b)
      })()
      const a1 = (() => {
        const step1 = f32(a - b)
        return f32(step1 - a0)
      })()
      const a2 = f32(c1 - a)
      const a3 = f32(b)
      const term1 = (() => {
        const mul = f32(a0 * gg)
        return f32(mul * g2)
      })()
      const term2 = f32(a1 * g2)
      const term3 = (() => {
        const mul = f32(a2 * gg)
        return f32(mul + a3)
      })()
      return f32(f32(term1 + term2) + term3)
    }

    const scaleY = f32(h / nh)
    const scaleX = f32(w / nw)

    for (let y = 0; y < nh; y++) {
      const gy = f32(y * scaleY)
      const y0 = Math.floor(gy)
      const yf = f32(gy - y0)
      for (let x = 0; x < nw; x++) {
        const gx = f32(x * scaleX)
        const x0 = Math.floor(gx)
        const xf = f32(gx - x0)
        for (let k = 0; k < nc; k++) {
          let val
          if (splineOrder === InterpolationType.constant) {
            const sampleX = Math.floor(gx)
            const sampleY = Math.floor(gy)
            val = sampleWrapped(sampleX, sampleY, k)
          } else if (
            splineOrder === InterpolationType.linear ||
            splineOrder === InterpolationType.cosine
          ) {
            const v00 = sampleWrapped(x0, y0, k)
            const v10 = sampleWrapped(x0 + 1, y0, k)
            const v01 = sampleWrapped(x0, y0 + 1, k)
            const v11 = sampleWrapped(x0 + 1, y0 + 1, k)
            const blend =
              splineOrder === InterpolationType.cosine ? blendCosine : blendLinear
            const mx0 = blend(v00, v10, xf)
            const mx1 = blend(v01, v11, xf)
            val = blend(mx0, mx1, yf)
          } else {
            const rows = []
            for (let m = -1; m < 3; m++) {
              rows[m + 1] = blendCubic(
                sampleWrapped(x0 - 1, y0 + m, k),
                sampleWrapped(x0, y0 + m, k),
                sampleWrapped(x0 + 1, y0 + m, k),
                sampleWrapped(x0 + 2, y0 + m, k),
                xf,
              )
            }
            val = blendCubic(rows[0], rows[1], rows[2], rows[3], yf)
          }
          out[(y * nw + x) * nc + k] = f32(val)
        }
      }
    }

    return Tensor.fromArray(tensor.ctx, out, [nh, nw, nc])
  }

  const srcMaybe = tensor.read()
  if (srcMaybe && typeof srcMaybe.then === 'function') {
    return srcMaybe.then(cpuResample)
  }
  return cpuResample(srcMaybe)
}
export function downsample(tensor, factor) {
  const [h, w, c] = tensor.shape
  const ctx = tensor.ctx
  const nh = Math.floor(h / factor)
  const nw = Math.floor(w / factor)
  const cpuDownsample = (src) => {
    const out = new Float32Array(nh * nw * c)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        for (let k = 0; k < c; k++) {
          let sum = 0
          for (let yy = 0; yy < factor; yy++) {
            for (let xx = 0; xx < factor; xx++) {
              const idx = ((y * factor + yy) * w + (x * factor + xx)) * c + k
              sum += src[idx]
            }
          }
          out[(y * nw + x) * c + k] = sum / (factor * factor)
        }
      }
    }
    return Tensor.fromArray(ctx, out, [nh, nw, c])
  }
  return withTensorData(tensor, cpuDownsample)
}
export function proportionalDownsample(tensor, shape, newShape) {
  if (tensor && typeof tensor.then === 'function') {
    return tensor.then((t) => proportionalDownsample(t, shape, newShape))
  }
  const [h, w, c] = shape
  const [nh, nw] = newShape
  const kH = Math.max(1, Math.floor(h / nh))
  const kW = Math.max(1, Math.floor(w / nw))
  const outH = Math.floor((h - kH) / kH + 1)
  const outW = Math.floor((w - kW) / kW + 1)
  const ctx = tensor.ctx
  return withTensorData(tensor, (src) => {
    const out = new Float32Array(outH * outW * c)
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        for (let k = 0; k < c; k++) {
          let sum = 0
          for (let yy = 0; yy < kH; yy++) {
            for (let xx = 0; xx < kW; xx++) {
              const iy = y * kH + yy
              const ix = x * kW + xx
              const idx = (iy * w + ix) * c + k
              sum += src[idx]
            }
          }
          out[(y * outW + x) * c + k] = sum / (kH * kW)
        }
      }
    }
    const down = Tensor.fromArray(ctx, out, [outH, outW, c])
    return resample(down, [nh, nw, c])
  })
}

export function upsample(tensor, factor, splineOrder = InterpolationType.bicubic) {
  const [h, w, c] = tensor.shape
  return resample(tensor, [h * factor, w * factor, c], splineOrder)
}

function cubicInterpolate(a, b, c, d, t) {
  const t2 = t * t
  const a0 = d - c - a + b
  const a1 = a - b - a0
  const a2 = c - a
  const a3 = b
  return a0 * t * t2 + a1 * t2 + a2 * t + a3
}

export function warp(tensor, flow, amount = 1, splineOrder = InterpolationType.bicubic) {
  const [h, w, c] = tensor.shape
  return withTensorDatas([tensor, flow], (src, flowData) => {
    const out = new Float32Array(h * w * c)

    const wrap = (v, max) => {
      v %= max
      return v < 0 ? v + max : v
    }

    function sample(x, y, k) {
      x = wrap(x, w)
      y = wrap(y, h)
      if (splineOrder === InterpolationType.constant) {
        const ix = wrap(Math.round(x), w)
        const iy = wrap(Math.round(y), h)
        return src[(iy * w + ix) * c + k]
      }

      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = x - x0
      const fy = y - y0

      if (splineOrder === InterpolationType.bicubic) {
        const get = (ix, iy) => {
          ix = wrap(ix, w)
          iy = wrap(iy, h)
          return src[(iy * w + ix) * c + k]
        }
        const col = new Array(4)
        for (let m = -1; m < 3; m++) {
          const row = new Array(4)
          for (let n = -1; n < 3; n++) {
            row[n + 1] = get(x0 + n, y0 + m)
          }
          col[m + 1] = cubicInterpolate(row[0], row[1], row[2], row[3], fx)
        }
        return cubicInterpolate(col[0], col[1], col[2], col[3], fy)
      }

      const x1 = wrap(x0 + 1, w)
      const y1 = wrap(y0 + 1, h)
      const interp = splineOrder === InterpolationType.cosine
        ? (t) => 0.5 - Math.cos(t * Math.PI) * 0.5
        : (t) => t
      const tx = interp(fx)
      const ty = interp(fy)
      const s00 = src[(y0 * w + x0) * c + k]
      const s10 = src[(y0 * w + x1) * c + k]
      const s01 = src[(y1 * w + x0) * c + k]
      const s11 = src[(y1 * w + x1) * c + k]
      const x_y0 = s00 * (1 - tx) + s10 * tx
      const x_y1 = s01 * (1 - tx) + s11 * tx
      return x_y0 * (1 - ty) + x_y1 * ty
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = flowData[(y * w + x) * 2] * amount * w
        const dy = flowData[(y * w + x) * 2 + 1] * amount * h
        for (let k = 0; k < c; k++) {
          out[(y * w + x) * c + k] = sample(x + dx, y + dy, k)
        }
      }
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, c])
  })
}

export const OctaveCombineMode = Object.freeze({
  falloff: 0,
  reduceMax: 1,
  alpha: 2,
})

export function combineOctaves(base, layer, mode = OctaveCombineMode.falloff, weight = 0) {
  if (
    (base && typeof base.then === 'function') ||
    (layer && typeof layer.then === 'function')
  ) {
    return Promise.all([base, layer]).then(([a, b]) =>
      combineOctaves(a, b, mode, weight),
    )
  }

  if (!base || !layer) {
    throw new Error('combineOctaves requires two tensors')
  }

  const [h, w, c] = base.shape
  const ctx = base.ctx || layer.ctx || null

  const cpuCombine = (dataA, dataB) => {
    const out = new Float32Array(dataA.length)
    if (mode === OctaveCombineMode.falloff) {
      for (let i = 0; i < out.length; i++) {
        out[i] = dataA[i] + dataB[i] * weight
      }
    } else if (mode === OctaveCombineMode.reduceMax) {
      for (let i = 0; i < out.length; i++) {
        out[i] = Math.max(dataA[i], dataB[i])
      }
    } else if (mode === OctaveCombineMode.alpha && c > 0) {
      for (let i = 0; i < h * w; i++) {
        const baseIdx = i * c
        const alpha = dataB[baseIdx + c - 1]
        for (let k = 0; k < c; k++) {
          out[baseIdx + k] =
            dataA[baseIdx + k] * (1 - alpha) + dataB[baseIdx + k] * alpha
        }
      }
    } else {
      out.set(dataB)
    }
    return Tensor.fromArray(ctx, out, [h, w, c])
  }

  const dataAMaybe = base.read()
  const dataBMaybe = layer.read()
  if (
    (dataAMaybe && typeof dataAMaybe.then === 'function') ||
    (dataBMaybe && typeof dataBMaybe.then === 'function')
  ) {
    return Promise.all([dataAMaybe, dataBMaybe]).then(([da, db]) =>
      cpuCombine(da, db),
    )
  }

  return cpuCombine(dataAMaybe, dataBMaybe)
}

export function blend(a, b, t) {
  if (
    (a && typeof a.then === 'function') ||
    (b && typeof b.then === 'function') ||
    (typeof t !== 'number' && t && typeof t.then === 'function')
  ) {
    const promises = [a, b]
    if (typeof t !== 'number' && t) promises.push(t)
    return Promise.all(promises).then((arr) =>
      blend(arr[0], arr[1], typeof t === 'number' ? t : arr[2])
    )
  }

  const [h, w, c] = a.shape
  const ctx = a.ctx

  if (typeof t === 'number') {
    if (t <= 0) return a
    if (t >= 1) return b
  }

  const cpuBlend = (da, db, dt) => {
    const [bh, bw, bc] = b.shape
    const [th, tw, tc] = dt ? t.shape : [0, 0, 0]
    const out = new Float32Array(h * w * c)
    for (let y = 0; y < h; y++) {
      const by = y % bh
      const ty = dt ? y % th : 0
      for (let x = 0; x < w; x++) {
        const bx = x % bw
        const tx = dt ? x % tw : 0
        const baseA = (y * w + x) * c
        const baseB = (by * bw + bx) * bc
        const baseT = dt ? (ty * tw + tx) * tc : 0
        for (let k = 0; k < c; k++) {
          const aVal = da[baseA + k]
          const bVal = db[baseB + (k < bc ? k : 0)]
          const tVal = dt ? dt[baseT + (k < tc ? k : 0)] : t
          out[baseA + k] = Math.fround(aVal * (1 - tVal) + bVal * tVal)
        }
      }
    }
    return Tensor.fromArray(ctx, out, [h, w, c])
  }

  const daMaybe = a.read()
  const dbMaybe = b.read()
  const dtMaybe = typeof t === 'number' ? null : t.read()
  if (
    (daMaybe && typeof daMaybe.then === 'function') ||
    (dbMaybe && typeof dbMaybe.then === 'function') ||
    (dtMaybe && typeof dtMaybe.then === 'function')
  ) {
    const promises = [daMaybe, dbMaybe]
    if (dtMaybe) promises.push(dtMaybe)
    return Promise.all(promises).then((arr) => {
      const da = arr[0]
      const db = arr[1]
      const dt = dtMaybe ? arr[2] : null
      return cpuBlend(da, db, dt)
    })
  }
  return cpuBlend(daMaybe, dbMaybe, dtMaybe)
}

export function normalize(tensor) {
  if (tensor && typeof tensor.then === 'function') {
    return tensor.then(normalize)
  }
  const [h, w, c] = tensor.shape
  const ctx = tensor.ctx
  const compute = (src) => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < src.length; i++) {
      const v = src[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error(`normalize input contains ${!Number.isFinite(min) ? min : max}`)
    }
    if (min === max) {
      return Tensor.fromArray(ctx, src.slice(), [h, w, c])
    }
    const range = Math.fround(max - min) || Math.fround(1)
    const out = new Float32Array(src.length)
    const minF = Math.fround(min)
    for (let i = 0; i < src.length; i++) {
      out[i] = Math.fround((src[i] - minF) / range)
    }
    return Tensor.fromArray(ctx, out, [h, w, c])
  }
  const srcMaybe = tensor.read()
  if (srcMaybe && typeof srcMaybe.then === 'function') {
    return srcMaybe.then(compute)
  }
  return compute(srcMaybe)
}

export function clamp01(tensor) {
  const compute = (src) => {
    const out = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) {
      out[i] = Math.min(1, Math.max(0, src[i]))
    }
    return Tensor.fromArray(tensor.ctx, out, tensor.shape)
  }
  const srcMaybe = tensor.read()
  if (srcMaybe && typeof srcMaybe.then === 'function') {
    return srcMaybe.then(compute)
  }
  return compute(srcMaybe)
}

export function distance(
  dx,
  dy,
  metric = DistanceMetric.euclidean,
  sdfSides = 5,
) {
  switch (metric) {
    case DistanceMetric.manhattan:
      return Math.abs(dx) + Math.abs(dy)
    case DistanceMetric.chebyshev:
      return Math.max(Math.abs(dx), Math.abs(dy))
    case DistanceMetric.octagram:
      return Math.max(
        (Math.abs(dx) + Math.abs(dy)) / Math.SQRT2,
        Math.max(Math.abs(dx), Math.abs(dy))
      )
    case DistanceMetric.triangular:
      return Math.max(Math.abs(dx) - dy * 0.5, dy)
    case DistanceMetric.hexagram:
      return Math.max(
        Math.max(Math.abs(dx) - dy * 0.5, dy),
        Math.max(Math.abs(dx) + dy * 0.5, -dy)
      )
    case DistanceMetric.sdf: {
      const arctan = Math.atan2(dx, -dy) + Math.PI
      const r = (Math.PI * 2) / sdfSides
      return (
        Math.cos(Math.floor(0.5 + arctan / r) * r - arctan) *
        Math.sqrt(dx * dx + dy * dy)
      )
    }
    case DistanceMetric.euclidean:
    default: {
      const sum = Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy))
      return Math.fround(Math.sqrt(sum))
    }
  }
}

export function sobel(tensor) {
  if (tensor && typeof tensor.then === 'function') {
    return tensor.then(sobel)
  }
  const [h, w, c] = tensor.shape
  const ctx = tensor.ctx
  const cpuSobel = (src) => {
    const out = new Float32Array(src.length)
    const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
    const gyKernel = [-1, -2, -1, 0, 0, 0, 1, 2, 1]
    function get(x, y, k) {
      x = Math.max(0, Math.min(w - 1, x))
      y = Math.max(0, Math.min(h - 1, y))
      return src[(y * w + x) * c + k]
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let k = 0; k < c; k++) {
          let gx = 0,
            gy = 0,
            idx = 0
          for (let yy = -1; yy <= 1; yy++) {
            for (let xx = -1; xx <= 1; xx++) {
              const v = get(x + xx, y + yy, k)
              gx += gxKernel[idx] * v
              gy += gyKernel[idx] * v
              idx++
            }
          }
          out[(y * w + x) * c + k] = Math.sqrt(gx * gx + gy * gy)
        }
      }
    }
    return Tensor.fromArray(ctx, out, [h, w, c])
  }
  return withTensorData(tensor, cpuSobel)
}

export function hsvToRgb(tensor) {
  const [h, w, c] = tensor.shape
  const ctx = tensor.ctx
  const cpuHsvToRgb = (src) => {
    const out = new Float32Array(h * w * 3)
    const f32buf = new Float32Array(1)
    const f32 = (x) => {
      f32buf[0] = x
      return f32buf[0]
    }
    const clamp01 = (x) => {
      if (x <= 0) {
        return f32(0)
      }
      if (x >= 1) {
        return f32(1)
      }
      return f32(x)
    }
    for (let i = 0; i < h * w; i++) {
      const base = i * c
      const H = f32(src[base])
      const S = f32(src[base + 1])
      const V = f32(src[base + 2])
      const dh = f32(f32(H) * f32(6))
      const dhMinus3 = f32(dh - 3)
      const dhMinus2 = f32(dh - 2)
      const dhMinus4 = f32(dh - 4)
      const dr = clamp01(f32(Math.abs(dhMinus3) - 1))
      const dg = clamp01(f32(f32(-Math.abs(dhMinus2)) + 2))
      const db = clamp01(f32(f32(-Math.abs(dhMinus4)) + 2))
      const oneMinusS = f32(f32(1) - S)
      const sr = f32(S * dr)
      const sg = f32(S * dg)
      const sb = f32(S * db)
      const r = f32(f32(oneMinusS + sr) * V)
      const g = f32(f32(oneMinusS + sg) * V)
      const b = f32(f32(oneMinusS + sb) * V)
      out[i * 3] = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
    }
    return Tensor.fromArray(ctx, out, [h, w, 3])
  }
  return withTensorData(tensor, cpuHsvToRgb)
}

export function rgbToHsv(tensor) {
  const [h, w, c] = tensor.shape
  const ctx = tensor.ctx
  const cpuRgbToHsv = (src) => {
    const out = new Float32Array(h * w * 3)
    const f32buf = new Float32Array(1)
    const f32 = (x) => {
      f32buf[0] = x
      return f32buf[0]
    }
    for (let i = 0; i < h * w; i++) {
      const r = f32(src[i * c])
      const g = f32(src[i * c + 1])
      const b = f32(src[i * c + 2])
      const max = f32(Math.max(r, g, b))
      const min = f32(Math.min(r, g, b))
      const d = f32(max - min)
      let hVal
      if (d === 0) {
        hVal = f32(0)
      } else if (max === r) {
        const numer = f32(g - b)
        const div = f32(numer / d)
        let raw = f32(div % 6)
        if (raw < 0) raw = f32(raw + 6)
        hVal = raw
      } else if (max === g) {
        const numer = f32(b - r)
        hVal = f32(numer / d + 2)
      } else {
        const numer = f32(r - g)
        hVal = f32(numer / d + 4)
      }
      hVal = f32(hVal / 6)
      if (hVal < 0) hVal = f32(hVal + 1)
      const sVal = max === 0 ? f32(0) : f32(d / max)
      out[i * 3] = f32(hVal)
      out[i * 3 + 1] = f32(sVal)
      out[i * 3 + 2] = max
    }
    return Tensor.fromArray(ctx, out, [h, w, 3])
  }

  return withTensorData(tensor, cpuRgbToHsv)
}

export function adjustHue(tensor, amount) {
  const shape = tensor.shape || [0, 0, 0]
  const [h, w, c] = shape
  if (c < 3) {
    return tensor
  }
  const cpuAdjust = (inputTensor) => {
    const hsvMaybe = rgbToHsv(inputTensor)
    const process = (hsv) => {
      const dataMaybe = hsv.read()
      const shift = (data) => {
        for (let i = 0; i < data.length; i += 3) {
          let hue = data[i] + amount
          hue = hue - Math.floor(hue)
          if (hue < 0) hue += 1
          data[i] = hue
        }
        return hsvToRgb(Tensor.fromArray(hsv.ctx, data, hsv.shape))
      }
      if (dataMaybe && typeof dataMaybe.then === 'function') {
        return dataMaybe.then(shift)
      }
      return shift(dataMaybe)
    }
    if (hsvMaybe && typeof hsvMaybe.then === 'function') {
      return hsvMaybe.then(process)
    }
    return process(hsvMaybe)
  }
  return cpuAdjust(tensor)
}

export function randomHue(tensor, range = 0.05) {
  const shift = random() * range * 2 - range
  return adjustHue(tensor, shift)
}

export function valueMap(tensor, palette) {
  const [h, w, c] = tensor.shape
  if (c !== 1) throw new Error('valueMap expects single-channel tensor')
  const compute = (src) => {
    const out = new Float32Array(h * w * 3)
    const n = palette.length
    for (let i = 0; i < h * w; i++) {
      const idx = Math.min(n - 1, Math.max(0, Math.floor(src[i] * (n - 1))))
      const [r, g, b] = palette[idx]
      out[i * 3] = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, 3])
  }
  const srcMaybe = tensor.read()
  if (srcMaybe && typeof srcMaybe.then === 'function') {
    return srcMaybe.then(compute)
  }
  return compute(srcMaybe)
}

export function toValueMap(tensor) {
  const convert = (t) => {
    if (!t) return t
    const [h, w, c] = t.shape
    if (c === 1) {
      return t
    }
    if (c === 2) {
      return withTensorData(t, (src) => {
        const out = new Float32Array(h * w)
        for (let i = 0; i < h * w; i++) {
          out[i] = src[i * 2]
        }
        return Tensor.fromArray(t.ctx, out, [h, w, 1])
      })
    }
    const buildLuminance = (rgbTensor) => {
      const maybeLab = rgbToOklab(rgbTensor)
      const toL = (labTensor) =>
        withTensorData(labTensor, (lab) => {
          const out = new Float32Array(h * w)
          for (let i = 0; i < h * w; i++) {
            out[i] = lab[i * 3]
          }
          return Tensor.fromArray(rgbTensor.ctx, out, [h, w, 1])
        })
      if (maybeLab && typeof maybeLab.then === 'function') {
        return maybeLab.then(toL)
      }
      return toL(maybeLab)
    }
    const toRgb = (clamped) => {
      if (!clamped) return clamped
      const [, , channels] = clamped.shape
      if (channels === 3) {
        return buildLuminance(clamped)
      }
      return withTensorData(clamped, (src) => {
        const rgbData = new Float32Array(h * w * 3)
        for (let i = 0; i < h * w; i++) {
          const base = i * channels
          const base3 = i * 3
          rgbData[base3] = src[base]
          rgbData[base3 + 1] = src[base + 1]
          rgbData[base3 + 2] = src[base + 2]
        }
        const rgbTensor = Tensor.fromArray(clamped.ctx, rgbData, [h, w, 3])
        return buildLuminance(rgbTensor)
      })
    }
    const maybeClamped = clamp01(t)
    if (maybeClamped && typeof maybeClamped.then === 'function') {
      return maybeClamped.then(toRgb)
    }
    return toRgb(maybeClamped)
  }
  if (tensor && typeof tensor.then === 'function') {
    return tensor.then(convert)
  }
  return convert(tensor)
}

export function ridge(tensor) {
  return withTensorData(tensor, (data) => {
    const out = new Float32Array(data.length)
    for (let i = 0; i < data.length; i++) {
      out[i] = 1 - Math.abs(data[i] * 2 - 1)
    }
    return Tensor.fromArray(tensor.ctx, out, tensor.shape)
  })
}

export function convolution(tensor, kernel, opts = {}) {
  const { normalize: doNormalize = true, alpha = 1 } = opts

  const handle = (t) => {
    const [h, w, c] = t.shape
    const finish = (tensorOut) => {
      if (!tensorOut) return tensorOut
      const applyAlpha = (normalized) => {
        if (alpha === 1) return normalized
        const blended = blend(t, normalized, alpha)
        if (blended && typeof blended.then === 'function') {
          return blended
        }
        return blended
      }
      if (!doNormalize) {
        if (tensorOut && typeof tensorOut.then === 'function') {
          return tensorOut.then(applyAlpha)
        }
        return applyAlpha(tensorOut)
      }
      const normalized = normalize(tensorOut)
      if (normalized && typeof normalized.then === 'function') {
        return normalized.then(applyAlpha)
      }
      return applyAlpha(normalized)
    }
    const kh = kernel.length
    const kw = kernel[0].length

    const cpuCompute = (src) => {
      const tileH = h * 2
      const tileW = w * 2
      const kernel32 = kernel.map((row) => row.map((v) => Math.fround(v)))
      const tile = new Float32Array(tileH * tileW * c)
      for (let y = 0; y < tileH; y++) {
        const sy = y % h
        for (let x = 0; x < tileW; x++) {
          const sx = x % w
          const dst = (y * tileW + x) * c
          const srcIdx = (sy * w + sx) * c
          for (let k = 0; k < c; k++) {
            tile[dst + k] = src[srcIdx + k]
          }
        }
      }

      const halfImageH = Math.floor(h / 2)
      const halfImageW = Math.floor(w / 2)
      const offset = new Float32Array(tile.length)
      for (let y = 0; y < tileH; y++) {
        const sy = (y + halfImageH) % tileH
        for (let x = 0; x < tileW; x++) {
          const sx = (x + halfImageW) % tileW
          const dst = (y * tileW + x) * c
          const srcIdx = (sy * tileW + sx) * c
          for (let k = 0; k < c; k++) {
            offset[dst + k] = tile[srcIdx + k]
          }
        }
      }

      const outH = tileH - kh + 1
      const outW = tileW - kw + 1
      if (outH <= 0 || outW <= 0) {
        return finish(t)
      }
      const conv = new Float32Array(outH * outW * c)
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          for (let k = 0; k < c; k++) {
            let sum = 0
            for (let j = 0; j < kh; j++) {
              for (let i = 0; i < kw; i++) {
                const val = offset[((y + j) * tileW + (x + i)) * c + k]
                const contrib = Math.fround(kernel32[j][i] * val)
                sum = Math.fround(sum + contrib)
              }
            }
            conv[(y * outW + x) * c + k] = Math.fround(sum)
          }
        }
      }

      const cropY = Math.max(0, Math.floor((outH - h) / 2))
      const cropX = Math.max(0, Math.floor((outW - w) / 2))
      const padY = Math.max(0, Math.floor((h - outH) / 2))
      const padX = Math.max(0, Math.floor((w - outW) / 2))
      const out = new Float32Array(h * w * c)
      for (let y = 0; y < h; y++) {
        const srcY = y + cropY - padY
        for (let x = 0; x < w; x++) {
          const srcX = x + cropX - padX
          const dst = (y * w + x) * c
          if (srcY < 0 || srcY >= outH || srcX < 0 || srcX >= outW) {
            for (let k = 0; k < c; k++) {
              out[dst + k] = 0
            }
            continue
          }
          const srcBase = (srcY * outW + srcX) * c
          for (let k = 0; k < c; k++) {
            out[dst + k] = conv[srcBase + k]
          }
        }
      }

      const result = Tensor.fromArray(t.ctx, out, [h, w, c])
      return finish(result)
    }

    return withTensorData(t, cpuCompute)
  }

  if (tensor && typeof tensor.then === 'function') {
    return tensor.then(handle)
  }
  return handle(tensor)
}

export function refract(
  tensor,
  referenceX = null,
  referenceY = null,
  displacement = 0.5,
  splineOrder = InterpolationType.bicubic,
  signedRange = true,
) {
  const quadDirectional = !!signedRange
  const run = (t, rx, ry) => {
    let [h, w, c] = t.shape

    const rxChannels = rx?.shape?.[2] || 1
    const ryChannels = ry?.shape?.[2] || 1
    const widthF = Math.fround(w)
    const heightF = Math.fround(h)
    const baseScaleX = Math.fround(displacement * widthF)
    const baseScaleY = Math.fround(displacement * heightF)
    const scaleX = quadDirectional ? baseScaleX : Math.fround(baseScaleX * 2)
    const scaleY = quadDirectional ? baseScaleY : Math.fround(baseScaleY * 2)

    const floormod = (value, limit) => {
      if (limit === 0) return 0
      const div = Math.floor(value / limit)
      let result = Math.fround(value - div * limit)
      if (result < 0) {
        result = Math.fround(result + limit)
      }
      return result
    }

    const cpuRefract = (src, refx, refy) => {
      const out = new Float32Array(h * w * c)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x
          let vx = refx[idx * rxChannels]
          let vy = refy[idx * ryChannels]
          if (quadDirectional) {
            vx = Math.fround(vx * 2 - 1)
            vy = Math.fround(vy * 2 - 1)
          }
          const dx = Math.fround(vx * scaleX)
          const dy = Math.fround(vy * scaleY)
          const sampleX = Math.fround(x + dx)
          const sampleY = Math.fround(y + dy)
          const wrappedX = floormod(sampleX, widthF)
          const wrappedY = floormod(sampleY, heightF)
          let x0 = Math.floor(wrappedX)
          let y0 = Math.floor(wrappedY)
          if (x0 < 0) x0 = 0
          else if (x0 >= w) x0 = w - 1
          if (y0 < 0) y0 = 0
          else if (y0 >= h) y0 = h - 1
          const x1 = (x0 + 1) % w
          const y1 = (y0 + 1) % h
          let fx = Math.fround(wrappedX - x0)
          let fy = Math.fround(wrappedY - y0)
          if (fx < 0) fx = 0
          else if (fx > 1) fx = 1
          if (fy < 0) fy = 0
          else if (fy > 1) fy = 1
          const tx = splineOrder === InterpolationType.cosine
            ? Math.fround(0.5 - Math.cos(fx * Math.PI) * 0.5)
            : fx
          const ty = splineOrder === InterpolationType.cosine
            ? Math.fround(0.5 - Math.cos(fy * Math.PI) * 0.5)
            : fy
          const outBase = idx * c
          for (let k = 0; k < c; k++) {
            const base00 = (y0 * w + x0) * c + k
            const base10 = (y0 * w + x1) * c + k
            const base01 = (y1 * w + x0) * c + k
            const base11 = (y1 * w + x1) * c + k
            const s00 = src[base00]
            const s10 = src[base10]
            const s01 = src[base01]
            const s11 = src[base11]
            const x_y0 = Math.fround(s00 * (1 - tx) + s10 * tx)
            const x_y1 = Math.fround(s01 * (1 - tx) + s11 * tx)
            out[outBase + k] = Math.fround(x_y0 * (1 - ty) + x_y1 * ty)
          }
        }
      }
      return Tensor.fromArray(t.ctx, out, [h, w, c])
    }

    return withTensorDatas([t, rx, ry], cpuRefract)
  }

  const prepare = (t, rx, ry) => {
    const rxMaybe = toValueMap(rx)
    const ryMaybe = toValueMap(ry)
    const rxIsPromise = rxMaybe && typeof rxMaybe.then === 'function'
    const ryIsPromise = ryMaybe && typeof ryMaybe.then === 'function'
    if (rxIsPromise || ryIsPromise) {
      return Promise.all([
        rxIsPromise ? rxMaybe : Promise.resolve(rxMaybe),
        ryIsPromise ? ryMaybe : Promise.resolve(ryMaybe),
      ]).then(([rxResolved, ryResolved]) => run(t, rxResolved, ryResolved))
    }
    return run(t, rxMaybe, ryMaybe)
  }

  if (
    (tensor && typeof tensor.then === 'function') ||
    (referenceX && typeof referenceX.then === 'function') ||
    (referenceY && typeof referenceY.then === 'function')
  ) {
    return Promise.all([tensor, referenceX, referenceY]).then(([t, rx, ry]) =>
      prepare(t, rx || t, ry || t),
    )
  }
  return prepare(tensor, referenceX || tensor, referenceY || tensor)
}

export function fft(tensor) {
  const [h, w, c] = tensor.shape
  return withTensorData(tensor, (src) => {
    const out = new Float32Array(h * w * c * 2)
    for (let k = 0; k < c; k++) {
      for (let u = 0; u < h; u++) {
        for (let v = 0; v < w; v++) {
          let re = 0, im = 0
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const angle = -2 * Math.PI * ((u * y) / h + (v * x) / w)
              const val = src[(y * w + x) * c + k]
              re += val * Math.cos(angle)
              im += val * Math.sin(angle)
            }
          }
          const idx = (u * w + v) * c * 2 + k * 2
          out[idx] = re
          out[idx + 1] = im
        }
      }
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, c * 2])
  })
}

export function ifft(tensor) {
  const [h, w, c2] = tensor.shape
  const c = c2 / 2
  return withTensorData(tensor, (src) => {
    const out = new Float32Array(h * w * c)
    for (let k = 0; k < c; k++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let re = 0
          for (let u = 0; u < h; u++) {
            for (let v = 0; v < w; v++) {
              const idx = (u * w + v) * c * 2 + k * 2
              const real = src[idx]
              const imag = src[idx + 1]
              const angle = 2 * Math.PI * ((u * y) / h + (v * x) / w)
              re += real * Math.cos(angle) - imag * Math.sin(angle)
            }
          }
          out[(y * w + x) * c + k] = re / (h * w)
        }
      }
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, c])
  })
}

export function rotate(tensor, angle) {
  const [h, w, c] = tensor.shape
  return withTensorData(tensor, (src) => {
    const out = new Float32Array(h * w * c)
    const cx = (w - 1) / 2
    const cy = (h - 1) / 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const rx = (x - cx) * cos + (y - cy) * sin + cx
        const ry = -(x - cx) * sin + (y - cy) * cos + cy
        const ix = Math.round(rx)
        const iy = Math.round(ry)
        for (let k = 0; k < c; k++) {
          let val = 0
          if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
            val = src[(iy * w + ix) * c + k]
          }
          out[(y * w + x) * c + k] = val
        }
      }
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, c])
  })
}

export function zoom(tensor, factor) {
  const [h, w, c] = tensor.shape
  return withTensorData(tensor, (src) => {
    const out = new Float32Array(h * w * c)
    const cx = (w - 1) / 2
    const cy = (h - 1) / 2
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const rx = (x - cx) / factor + cx
        const ry = (y - cy) / factor + cy
        const ix = Math.round(rx)
        const iy = Math.round(ry)
        for (let k = 0; k < c; k++) {
          let val = 0
          if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
            val = src[(iy * w + ix) * c + k]
          }
          out[(y * w + x) * c + k] = val
        }
      }
    }
    return Tensor.fromArray(tensor.ctx, out, [h, w, c])
  })
}

export function fxaa(tensor) {
  const [h, w, c] = tensor.shape
  const ctx = tensor.ctx
  const cpuFxaa = (src) => {
    const out = new Float32Array(h * w * c)
    const lumWeights = [0.299, 0.587, 0.114]
    function reflect(i, n) {
      if (n === 1) return 0
      const m = 2 * n - 2
      i = ((i % m) + m) % m
      return i < n ? i : m - i
    }
    function idx(x, y, k) {
      x = reflect(x, w)
      y = reflect(y, h)
      return (y * w + x) * c + k
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (c === 1) {
          const lC = src[idx(x, y, 0)]
          const lN = src[idx(x, y - 1, 0)]
          const lS = src[idx(x, y + 1, 0)]
          const lW = src[idx(x - 1, y, 0)]
          const lE = src[idx(x + 1, y, 0)]
          const wC = 1.0
          const wN = Math.exp(-Math.abs(lC - lN))
          const wS = Math.exp(-Math.abs(lC - lS))
          const wW = Math.exp(-Math.abs(lC - lW))
          const wE = Math.exp(-Math.abs(lC - lE))
          const sum = wC + wN + wS + wW + wE + 1e-10
          out[idx(x, y, 0)] =
            (lC * wC + lN * wN + lS * wS + lW * wW + lE * wE) / sum
        } else if (c === 2) {
          const lum = src[idx(x, y, 0)]
          const alpha = src[idx(x, y, 1)]
          const lN = src[idx(x, y - 1, 0)]
          const lS = src[idx(x, y + 1, 0)]
          const lW = src[idx(x - 1, y, 0)]
          const lE = src[idx(x + 1, y, 0)]
          const wC = 1.0
          const wN = Math.exp(-Math.abs(lum - lN))
          const wS = Math.exp(-Math.abs(lum - lS))
          const wW = Math.exp(-Math.abs(lum - lW))
          const wE = Math.exp(-Math.abs(lum - lE))
          const sum = wC + wN + wS + wW + wE + 1e-10
          out[idx(x, y, 0)] =
            (lum * wC + lN * wN + lS * wS + lW * wW + lE * wE) / sum
          out[idx(x, y, 1)] = alpha
        } else if (c === 3 || c === 4) {
          const rgbC = [src[idx(x, y, 0)], src[idx(x, y, 1)], src[idx(x, y, 2)]]
          const rgbN = [
            src[idx(x, y - 1, 0)],
            src[idx(x, y - 1, 1)],
            src[idx(x, y - 1, 2)],
          ]
          const rgbS = [
            src[idx(x, y + 1, 0)],
            src[idx(x, y + 1, 1)],
            src[idx(x, y + 1, 2)],
          ]
          const rgbW = [
            src[idx(x - 1, y, 0)],
            src[idx(x - 1, y, 1)],
            src[idx(x - 1, y, 2)],
          ]
          const rgbE = [
            src[idx(x + 1, y, 0)],
            src[idx(x + 1, y, 1)],
            src[idx(x + 1, y, 2)],
          ]
          const lC = rgbC[0] * lumWeights[0] + rgbC[1] * lumWeights[1] + rgbC[2] * lumWeights[2]
          const lN = rgbN[0] * lumWeights[0] + rgbN[1] * lumWeights[1] + rgbN[2] * lumWeights[2]
          const lS = rgbS[0] * lumWeights[0] + rgbS[1] * lumWeights[1] + rgbS[2] * lumWeights[2]
          const lW = rgbW[0] * lumWeights[0] + rgbW[1] * lumWeights[1] + rgbW[2] * lumWeights[2]
          const lE = rgbE[0] * lumWeights[0] + rgbE[1] * lumWeights[1] + rgbE[2] * lumWeights[2]
          const wC = 1.0
          const wN = Math.exp(-Math.abs(lC - lN))
          const wS = Math.exp(-Math.abs(lC - lS))
          const wW = Math.exp(-Math.abs(lC - lW))
          const wE = Math.exp(-Math.abs(lC - lE))
          const sum = wC + wN + wS + wW + wE + 1e-10
          for (let k = 0; k < 3; k++) {
            out[idx(x, y, k)] =
              (rgbC[k] * wC + rgbN[k] * wN + rgbS[k] * wS + rgbW[k] * wW + rgbE[k] * wE) / sum
          }
          if (c === 4) out[idx(x, y, 3)] = src[idx(x, y, 3)]
        } else {
          for (let k = 0; k < c; k++) out[idx(x, y, k)] = src[idx(x, y, k)]
        }
      }
    }
    return Tensor.fromArray(ctx, out, [h, w, c])
  }
  const srcMaybe = tensor.read()
  if (srcMaybe && typeof srcMaybe.then === 'function') {
    return srcMaybe.then(cpuFxaa)
  }
  return cpuFxaa(srcMaybe)
}

export function gaussianBlur(tensor, radius = 1) {
  const sigma = radius / 2 || 1
  const kernel = []
  for (let y = -radius; y <= radius; y++) {
    const row = []
    for (let x = -radius; x <= radius; x++) {
      row.push(Math.exp(-(x * x + y * y) / (2 * sigma * sigma)))
    }
    kernel.push(row)
  }
  return convolution(tensor, kernel, { normalize: false })
}
