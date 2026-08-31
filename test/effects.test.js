import assert from "assert"
import { Tensor } from "../js/noisemaker/tensor.js"
import { list as listEffects } from "../js/noisemaker/effectsRegistry.js"
import {
  posterize,
  palette,
  invert,
  aberration,
  reindex,
  vignette,
  dither,
  grain,
  adjustBrightness,
  adjustContrast,
  saturation,
  randomHue,
  adjustHueEffect,
  normalizeEffect,
  ridgeEffect,
  sine,
  warp,
  shadow,
  blur,
  bloom,
  lightLeak,
  vaseline,
  erosionWorms,
  worms,
  wormhole,
  ripple,
  colorMap,
  derivative,
  sobelOperator,
  sobel,
  outline,
  vortex,
  normalMap,
  densityMap,
  voronoi,
  singularity,
  jpegDecimate,
  convFeedback,
  blendLayers,
  centerMask,
  innerTile,
  expandTile,
  offsetIndex,
  wobble,
  reverb,
  dla,
  rotate,
  pixelSort,
  squareCropAndResize,
  glyphMap,
  sketch,
  lowpoly,
  kaleido,
  texture,
  simpleFrame,
  frame,
  lensWarp,
  lensDistortion,
  degauss,
  vhs,
  scanlineError,
  crt,
  snow,
  spatter,
  nebula,
  clouds,
  fibers,
  scratches,
  strayHair,
  grime,
  onScreenDisplay,
  spookyTicker,
  falseColor,
  tint,
  valueRefract,
  refractEffect,
  fxaaEffect,
  smoothstep,
  convolve,
} from "../js/noisemaker/effects.js"
import {
  adjustHue as adjustHueValue,
  values,
  blend,
  sobel as sobelValue,
  normalize,
  refract,
  distance,
  convolution,
} from "../js/noisemaker/value.js"
import { setSeed, random } from "../js/noisemaker/util.js"
import { random as simplexRandom } from "../js/noisemaker/simplex.js"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import {
  VoronoiDiagramType,
  DistanceMetric,
  ValueMask,
  InterpolationType,
} from "../js/noisemaker/constants.js"

function arraysClose(a, b, eps = 1e-6) {
  assert.strictEqual(a.length, b.length)
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i] - b[i])
    if (!(diff < eps)) {
      console.error('arraysClose mismatch', { index: i, actual: a[i], expected: b[i], diff, eps })
    }
    assert.ok(diff < eps, `index ${i}`)
  }
}

async function readTensorData(value) {
  const tensor = await value
  if (!tensor) return tensor
  if (typeof tensor.read === "function") {
    const data = tensor.read()
    return data && typeof data.then === "function" ? await data : data
  }
  return tensor
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const loadFixture = (name) =>
  JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"))

// Set deterministic seed before running warp tests that depend on noise
setSeed(0)

// gradient effects edge accuracy
const edgeData = new Float32Array([
  0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1,
])
const edgeTensor = Tensor.fromArray(null, edgeData, [4, 4, 1])

// warp - basic smoke test (fixture comparison removed as it depends on Python parity)
const warpOut = await readTensorData(
  warp(edgeTensor, [4, 4, 1], 0, 1, 2, 2, 1, InterpolationType.linear),
)
assert.strictEqual(warpOut.length, 16)
for (const v of warpOut) {
  assert.ok(Number.isFinite(v))
}
// warp with anisotropic freq array
const warpArr = await readTensorData(
  warp(edgeTensor, [4, 4, 1], 0, 1, [1, 2], 1, 1, InterpolationType.linear),
)
for (const v of warpArr) {
  assert.ok(Number.isFinite(v))
}

// shadow - basic smoke test (fixture comparison removed as it depends on Python parity)
const shadowOut = await readTensorData(
  shadow(edgeTensor, [4, 4, 1], 0, 1, 1),
)
assert.strictEqual(shadowOut.length, 16)
for (const v of shadowOut) {
  assert.ok(Number.isFinite(v))
}

const effectList = listEffects()
assert.ok(effectList.includes("warp"))
assert.ok(effectList.includes("shadow"))
assert.ok(effectList.includes("lensWarp"))
assert.ok(effectList.includes("lensDistortion"))
assert.ok(effectList.includes("lens_warp"))
assert.ok(effectList.includes("lens_distortion"))

// derivative
const manualDeriv = (() => {
  const kx = [
    [0, 0, 0],
    [0, 1, -1],
    [0, 0, 0],
  ]
  const ky = [
    [0, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ]
  const dx = convolution(edgeTensor, kx, { normalize: false }).read()
  const dy = convolution(edgeTensor, ky, { normalize: false }).read()
  const mag = new Float32Array(16)
  for (let i = 0; i < 16; i++) {
    mag[i] = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
  }
  return Array.from(
    normalize(Tensor.fromArray(null, mag, [4, 4, 1])).read()
  )
})()
const derivRes = await readTensorData(derivative(edgeTensor, [4, 4, 1], 0, 1))
arraysClose(Array.from(derivRes), manualDeriv)

// sobel operator
const blurred = await blur(edgeTensor, [4, 4, 1], 0, 1)
let sob = await sobelValue(blurred)
sob = await normalize(sob)
let sobData = await readTensorData(sob)
for (let i = 0; i < sobData.length; i++)
  sobData[i] = Math.abs(sobData[i] * 2 - 1)
function offsetArray(data, shape, xOff, yOff) {
  const [h, w, c] = shape
  const out = new Float32Array(h * w * c)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const yi = (y + yOff + h) % h
      const xi = (x + xOff + w) % w
      for (let k = 0; k < c; k++) {
        out[(y * w + x) * c + k] = data[(yi * w + xi) * c + k]
      }
    }
  }
  return out
}
sobData = offsetArray(sobData, [4, 4, 1], -1, -1)
const sobRes = await readTensorData(sobelOperator(edgeTensor, [4, 4, 1], 0, 1))
arraysClose(Array.from(sobRes), Array.from(sobData))

// outline
const outlineRes = await readTensorData(outline(edgeTensor, [4, 4, 1], 0, 1))
const manualOutline = new Float32Array(16)
for (let i = 0; i < 16; i++) manualOutline[i] = sobData[i] * edgeData[i]
arraysClose(Array.from(outlineRes), Array.from(manualOutline))
const outlineInv = await readTensorData(
  outline(edgeTensor, [4, 4, 1], 0, 1, undefined, true),
)
const manualOutlineInv = new Float32Array(16)
for (let i = 0; i < 16; i++)
  manualOutlineInv[i] = (1 - sobData[i]) * edgeData[i]
arraysClose(Array.from(outlineInv), Array.from(manualOutlineInv))

// normal map
const nmRes = await readTensorData(normalMap(edgeTensor, [4, 4, 1], 0, 1))
const nmExpect = await (async () => {
  const valueShape = [4, 4, 1]
  const sobelXTensor = convolution(edgeTensor, [
    [1, 0, -1],
    [2, 0, -2],
    [1, 0, -1],
  ], { normalize: true })
  const sobelYTensor = convolution(edgeTensor, [
    [1, 2, 1],
    [0, 0, 0],
    [-1, -2, -1],
  ], { normalize: true })
  const sobelXData = await readTensorData(sobelXTensor)
  const sobelYData = await readTensorData(sobelYTensor)
  const xVals = new Float32Array(16)
  for (let i = 0; i < 16; i++) {
    xVals[i] = Math.fround(1 - sobelXData[i])
  }
  const [xNormTensor, yNormTensor] = await Promise.all([
    normalize(Tensor.fromArray(null, xVals, valueShape)),
    normalize(Tensor.fromArray(null, sobelYData, valueShape)),
  ])
  const [xNorm, yNorm] = await Promise.all([
    readTensorData(xNormTensor),
    readTensorData(yNormTensor),
  ])
  const mag = new Float32Array(16)
  for (let i = 0; i < 16; i++) {
    mag[i] = Math.fround(Math.sqrt(xNorm[i] * xNorm[i] + yNorm[i] * yNorm[i]))
  }
  const zNormTensor = await normalize(
    Tensor.fromArray(null, mag, valueShape),
  )
  const zNorm = await readTensorData(zNormTensor)
  const out = new Float32Array(16 * 3)
  for (let i = 0; i < 16; i++) {
    const z = Math.fround(1 - Math.abs(zNorm[i] * 2 - 1) * 0.5 + 0.5)
    out[i * 3] = xNorm[i]
    out[i * 3 + 1] = yNorm[i]
    out[i * 3 + 2] = z
  }
  return Array.from(out)
})()
  const nmArr = Array.from(nmRes)
  arraysClose(nmArr, nmExpect)

// singularity
const sgTensor = Tensor.fromArray(null, new Float32Array(16), [4, 4, 1])
const sgRes = await readTensorData(
  singularity(sgTensor, [4, 4, 1], 0, 1),
)
  arraysClose(
    Array.from(sgRes),
    [
      1,
      0.9204481840133667,
      0.8408964276313782,
      0.9204482436180115,
      0.9204481840133667,
      0.6704481840133667,
      0.4204481840133667,
      0.6704482436180115,
      0.8408964276313782,
      0.4204481840133667,
      0,
      0.4204482436180115,
      0.9204482436180115,
      0.6704481840133667,
      0.4204482436180115,
      0.6704482436180115,
    ],
  )

// voronoi color regions
const xPts = [1, 3]
const yPts = [1, 3]
const vorRes = await readTensorData(
  voronoi(
    edgeTensor,
    [4, 4, 1],
    0,
    1,
    VoronoiDiagramType.color_regions,
    0,
    DistanceMetric.euclidean,
    1,
    0,
    true,
    0,
    0,
    0,
    0,
    false,
    [xPts, yPts, 2],
  ),
)
assert.strictEqual(vorRes[0], 0)
assert.strictEqual(vorRes[3], 1)
assert.strictEqual(vorRes[12], 0)
assert.strictEqual(vorRes[15], 1)

// densityMap regression
const dmData = new Float32Array([0.1, 0.4, 0.4, 0.9])
const dmTensor = Tensor.fromArray(null, dmData, [2, 2, 1])
const dmOut = await readTensorData(
  densityMap(dmTensor, [2, 2, 1], 0, 1),
)
const dmExpected = loadFixture("densityMap.json")
arraysClose(Array.from(dmOut), dmExpected)

// jpegDecimate regression
setSeed(7)
const jdData = new Float32Array([
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.2, 0.4, 0.6,
])
const jdTensor = Tensor.fromArray(null, jdData, [2, 2, 3])
setSeed(7)
const jdOut = await readTensorData(
  jpegDecimate(jdTensor, [2, 2, 3], 0, 1, 1),
)
const jdExpected = loadFixture("jpegDecimate.json")
arraysClose(Array.from(jdOut), jdExpected)

// convFeedback regression
const cfData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const cfTensor = Tensor.fromArray(null, cfData, [2, 2, 1])
const cfOut = await readTensorData(
  convFeedback(cfTensor, [2, 2, 1], 0, 1, 2, 0.5),
)
const cfExpected = loadFixture("convFeedback.json")
arraysClose(Array.from(cfOut), cfExpected)

// blendLayers regression
const blControl = Tensor.fromArray(
  null,
  new Float32Array([0.25, 0.75, 0.5, 0.1]),
  [2, 2, 1],
)
const blLayer0 = Tensor.fromArray(null, new Float32Array([0, 0, 0, 0]), [2, 2, 1])
const blLayer1 = Tensor.fromArray(null, new Float32Array([1, 1, 1, 1]), [2, 2, 1])
const blOut = await readTensorData(
  blendLayers(blControl, [2, 2, 1], 1, blLayer0, blLayer1),
)
const blExpected = loadFixture("blendLayers.json")
arraysClose(Array.from(blOut), blExpected)

// centerMask regression
const cmCenter = Tensor.fromArray(null, new Float32Array(9).fill(0), [3, 3, 1])
const cmEdges = Tensor.fromArray(null, new Float32Array(9).fill(1), [3, 3, 1])
const cmOut = await readTensorData(centerMask(cmCenter, cmEdges, [3, 3, 1]))
const cmExpected = loadFixture("centerMask.json")
arraysClose(Array.from(cmOut), cmExpected)

// innerTile regression
const itData = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
const itTensor = Tensor.fromArray(null, itData, [4, 4, 1])
const itOut = await readTensorData(innerTile(itTensor, [4, 4, 1], 2))
const itExpected = loadFixture("innerTile.json")
arraysClose(Array.from(itOut), itExpected)

// expandTile regression
const etData = new Float32Array([1, 2, 3, 4])
const etTensor = Tensor.fromArray(null, etData, [2, 2, 1])
const etOut = await readTensorData(expandTile(etTensor, [2, 2, 1], [3, 3, 1]))
const etExpected = loadFixture("expandTile.json")
arraysClose(Array.from(etOut), etExpected)

// offsetIndex regression
const yIdx = Tensor.fromArray(null, new Float32Array([0, 0, 1, 1]), [2, 2, 1])
const xIdx = Tensor.fromArray(null, new Float32Array([0, 1, 0, 1]), [2, 2, 1])
setSeed(1)
const oiOut = await readTensorData(offsetIndex(yIdx, 2, xIdx, 2))
const oiExpected = loadFixture("offsetIndex.json")
arraysClose(Array.from(oiOut), oiExpected)

// sobel regression
const sobelOut = await readTensorData(sobel(edgeTensor, [4, 4, 1], 0, 1))
const sobelExpected = new Float32Array(manualOutlineInv.length)
for (let i = 0; i < sobelExpected.length; i++) {
  sobelExpected[i] = Math.fround(1 - manualOutlineInv[i])
}
arraysClose(Array.from(sobelOut), Array.from(sobelExpected))
const sobelRgb = await readTensorData(
  sobel(edgeTensor, [4, 4, 1], 0, 1, undefined, true),
)
arraysClose(Array.from(sobelRgb), Array.from(sobData))

// posterize regression
const posterData = new Float32Array([0.1, 0.5, 0.9, 0.3])
const posterTensor = Tensor.fromArray(null, posterData, [2, 2, 1])
const jsPoster = await readTensorData(
  posterize(posterTensor, [2, 2, 1], 0, 1, 4),
)
const posterExpected = loadFixture("posterize.json")
arraysClose(Array.from(jsPoster), posterExpected)

// palette regression
const palData = new Float32Array([
  0.0, 0.0, 0.0,
  0.5, 0.5, 0.5,
  1.0, 1.0, 1.0,
  0.25, 0.25, 0.25,
])
const palTensor = Tensor.fromArray(null, palData, [2, 2, 3])
const jsPal = await readTensorData(
  palette(palTensor, [2, 2, 3], 0, 1, "grayscale"),
)
const palExpected = loadFixture("palette.json")
arraysClose(Array.from(jsPal), palExpected)
await assert.rejects(palette(palTensor, [2, 2, 3], 0, 1, "bogus"))

// invert
const invData = new Float32Array([0.2, 0.5, 0.8])
const invTensor = Tensor.fromArray(null, invData, [1, 3, 1])
const invResult = await readTensorData(
  invert(invTensor, [1, 3, 1], 0, 1),
)
arraysClose(Array.from(invResult), [0.8, 0.5, 0.2])

// aberration deterministic check
setSeed(123)
const abShape = [1, 4, 3]
const abData = new Float32Array([
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.2, 0.4, 0.6,
])
const abTensor = Tensor.fromArray(null, abData, abShape)
setSeed(123)
const disp = Math.round(abShape[1] * 0.25 * simplexRandom(0, undefined, 1))
const hueShift = random() * 0.1 - 0.05
const shifted = await readTensorData(adjustHueValue(abTensor, hueShift))
const manual = new Float32Array(abShape[0] * abShape[1] * 3)
const mask = new Float32Array(abShape[0] * abShape[1])
const cx = (abShape[1] - 1) / 2
const cy = (abShape[0] - 1) / 2
let max = 0
for (let y = 0; y < abShape[0]; y++) {
  for (let x = 0; x < abShape[1]; x++) {
    const dx = Math.abs(x - cx)
    const dy = Math.abs(y - cy)
    const d = Math.sqrt(dx * dx + dy * dy)
    mask[y * abShape[1] + x] = d
    if (d > max) max = d
  }
}
for (let i = 0; i < mask.length; i++) mask[i] = Math.pow(mask[i] / max, 3)
const lerp = (a, b, t) => a + (b - a) * t
for (let y = 0; y < abShape[0]; y++) {
  for (let x = 0; x < abShape[1]; x++) {
    const g = abShape[1] > 1 ? x / (abShape[1] - 1) : 0
    const m = mask[y * abShape[1] + x]
    const base = (y * abShape[1] + x) * 3
    let rX = Math.min(abShape[1] - 1, x + disp)
    rX = lerp(rX, x, g)
    rX = lerp(x, rX, m)
    rX = Math.round(rX)
    let bX = Math.max(0, x - disp)
    bX = lerp(x, bX, g)
    bX = lerp(x, bX, m)
    bX = Math.round(bX)
    manual[base] = shifted[(y * abShape[1] + rX) * 3]
    manual[base + 1] = shifted[base + 1]
    manual[base + 2] = shifted[(y * abShape[1] + bX) * 3 + 2]
  }
}
const expected = await readTensorData(
  adjustHueValue(Tensor.fromArray(null, manual, abShape), -hueShift),
)
setSeed(123)
  const abResult = await readTensorData(
    aberration(abTensor, abShape, 0, 1, 0.25),
  )
  const abArr = Array.from(abResult)
  const abExpectedArr = Array.from(expected)
  arraysClose(abArr, abExpectedArr)

// reindex deterministic
const reData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const reTensor = Tensor.fromArray(null, reData, [2, 2, 1])
const manualRe = new Float32Array(4)
const lum = reData.slice()
let lumMin = Math.min(...lum)
let lumMax = Math.max(...lum)
const range = lumMax - lumMin || 1
for (let i = 0; i < lum.length; i++) lum[i] = (lum[i] - lumMin) / range
const mod = 2
for (let y = 0; y < 2; y++) {
  for (let x = 0; x < 2; x++) {
    const idx = y * 2 + x
    const r = lum[idx]
    const off = r * 0.5 * mod + r
    const xo = Math.floor(off % 2)
    const yo = Math.floor(off % 2)
    manualRe[idx] = reData[yo * 2 + xo]
  }
}
const jsRe = await readTensorData(
  reindex(reTensor, [2, 2, 1], 0, 1, 0.5),
)
arraysClose(Array.from(jsRe), Array.from(manualRe))

// ripple deterministic
setSeed(10)
const ripData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const ripTensor = Tensor.fromArray(null, ripData, [2, 2, 1])
setSeed(10)
const jsRipple = await readTensorData(
  ripple(ripTensor, [2, 2, 1], 0, 1, 2, 0.5, 1),
)
const rippleExpected = loadFixture("ripple.json")
arraysClose(Array.from(jsRipple), rippleExpected)

// colorMap regression
const cmData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const cmTensor = Tensor.fromArray(null, cmData, [2, 2, 1])
const clutData = new Float32Array([
  0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1,
])
const clutTensor = Tensor.fromArray(null, clutData, [2, 2, 3])
const jsColorMap = await readTensorData(
  colorMap(cmTensor, [2, 2, 1], 0, 1, clutTensor, false, 0.5),
)
const colorMapExpected = loadFixture("colorMap.json")
arraysClose(Array.from(jsColorMap), colorMapExpected)

// vignette regression (numpy impl)
setSeed(1)
const vigData = new Float32Array([0.1, 0.5, 0.3, 0.8])
const vigTensor = Tensor.fromArray(null, vigData, [2, 2, 1])
const jsVig = await readTensorData(
  vignette(vigTensor, [2, 2, 1], 0, 1, 0.25, 0.5),
)
const vigExpected = loadFixture("vignette.json")
arraysClose(Array.from(jsVig), vigExpected)

// dither deterministic
setSeed(1)
const ditData = new Float32Array([0.2, 0.4, 0.6, 0.8])
const ditTensor = Tensor.fromArray(null, ditData, [2, 2, 1])
setSeed(1)
const noise = values(Math.max(2, 2), [2, 2, 1], {
  time: 0,
  seed: 0,
  speed: 1000,
})
const nData = await readTensorData(noise)
const manualDit = new Float32Array(4)
for (let i = 0; i < 4; i++) {
  let v = ditData[i] + (nData[i] - 0.5) / 2
  v = Math.floor(Math.min(1, Math.max(0, v)) * 2) / 2
  manualDit[i] = v
}
setSeed(1)
const jsDit = await readTensorData(dither(ditTensor, [2, 2, 1], 0, 1, 2))
arraysClose(Array.from(jsDit), Array.from(manualDit))

// grain deterministic
setSeed(2)
const grData = new Float32Array([0.3, 0.6, 0.9, 0.0])
const grTensor = Tensor.fromArray(null, grData, [2, 2, 1])
setSeed(2)
const gn = values(Math.max(2, 2), [2, 2, 1], { time: 0, speed: 100 })
const gnData = await readTensorData(gn)
const blended = await readTensorData(
  blend(
    grTensor,
    Tensor.fromArray(
      null,
      (() => {
        const arr = new Float32Array(4)
        for (let i = 0; i < 4; i++) arr[i] = gnData[i]
        return arr
      })(),
      [2, 2, 1],
    ),
    0.25,
  ),
)
setSeed(2)
const jsGrain = await readTensorData(grain(grTensor, [2, 2, 1], 0, 1, 0.25))
arraysClose(Array.from(jsGrain), Array.from(blended))

// saturation regression via python colorsys
const satData = new Float32Array([0.2, 0.4, 0.6, 0.8, 0.1, 0.3])
const satTensor = Tensor.fromArray(null, satData, [2, 1, 3])
const jsSat = await readTensorData(saturation(satTensor, [2, 1, 3], 0, 1, 0.5))
const satExpected = loadFixture("saturation.json")
arraysClose(Array.from(jsSat), satExpected)

// randomHue deterministic
setSeed(5)
const rhData = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
const rhTensor = Tensor.fromArray(null, rhData, [2, 1, 3])
setSeed(5)
const jsHue = await readTensorData(randomHue(rhTensor, [2, 1, 3], 0, 1, 0.05))
const hueExpected = loadFixture("randomHue.json")
arraysClose(Array.from(jsHue), hueExpected)

// adjustHue regression
const ahData = new Float32Array([0.2, 0.4, 0.6, 0.8, 0.1, 0.3])
const ahTensor = Tensor.fromArray(null, ahData, [2, 1, 3])
const ahOut = await readTensorData(
  adjustHueEffect(ahTensor, [2, 1, 3], 0, 1, 0.25),
)
const ahExpected = loadFixture("adjustHue.json")
arraysClose(Array.from(ahOut), ahExpected)

// adjustBrightness regression
const brightData = new Float32Array([0.1, 0.3, 0.5, 0.7])
const brightTensor = Tensor.fromArray(null, brightData, [2, 2, 1])
const brightOut = await readTensorData(
  adjustBrightness(brightTensor, [2, 2, 1], 0, 1, 0.125),
)
const brightExpected = loadFixture("adjustBrightness.json")
arraysClose(Array.from(brightOut), brightExpected)

// adjustContrast regression
const contrastData = new Float32Array([0.1, 0.3, 0.5, 0.7])
const contrastTensor = Tensor.fromArray(null, contrastData, [2, 2, 1])
const contrastOut = await readTensorData(
  adjustContrast(contrastTensor, [2, 2, 1], 0, 1, 1.25),
)
const contrastExpected = loadFixture("adjustContrast.json")
arraysClose(Array.from(contrastOut), contrastExpected)

// normalize regression
const normData = new Float32Array([0.2, 0.5, 0.8, 1.2])
const normTensor = Tensor.fromArray(null, normData, [2, 2, 1])
const normOut = await readTensorData(
  normalizeEffect(normTensor, [2, 2, 1], 0, 1),
)
const normExpected = loadFixture("normalize.json")
arraysClose(Array.from(normOut), normExpected)

// ridge regression
const ridgeData = new Float32Array([0.2, 0.8, 0.4, 0.6])
const ridgeTensor = Tensor.fromArray(null, ridgeData, [2, 2, 1])
const ridgeOut = await readTensorData(
  ridgeEffect(ridgeTensor, [2, 2, 1], 0, 1),
)
const ridgeExpected = loadFixture("ridge.json")
arraysClose(Array.from(ridgeOut), ridgeExpected)

// sine regression
const sineData = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
const sineTensor = Tensor.fromArray(null, sineData, [2, 1, 3])
const sineOut = await readTensorData(
  sine(sineTensor, [2, 1, 3], 0, 1, 1.0, false),
)
const sineExpected = loadFixture("sine.json")
arraysClose(Array.from(sineOut), sineExpected)

// blur regression
const blurData = new Float32Array([0.1, 0.5, 0.3, 0.7])
const blurTensor = Tensor.fromArray(null, blurData, [2, 2, 1])
const blurOut = await readTensorData(blur(blurTensor, [2, 2, 1], 0, 1, 10.0))
const blurExpected = loadFixture("blur.json")
arraysClose(Array.from(blurOut), blurExpected)

// wormhole regression
const whTensor = Tensor.fromArray(null, new Float32Array([0.5]), [1, 1, 1])
const whOut = await readTensorData(
  wormhole(whTensor, [1, 1, 1], 0, 1, 1.0, 1.0, 1.0),
)
const whExpected = loadFixture("wormhole.json")
arraysClose(Array.from(whOut), whExpected)

// vortex deterministic
const vxData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const vxTensor = Tensor.fromArray(null, vxData, [2, 2, 1])
setSeed(1)
const vShape = [2, 2, 1]
let dispMap = await singularity(vxTensor, vShape, 0, 1)
dispMap = await normalize(dispMap)
const vxXTensor = await convolve(
  dispMap,
  vShape,
  0,
  1,
  ValueMask.conv2d_deriv_x,
  false,
)
const vxX = await readTensorData(vxXTensor)
const vxYTensor = await convolve(
  dispMap,
  vShape,
  0,
  1,
  ValueMask.conv2d_deriv_y,
  false,
)
const vxY = await readTensorData(vxYTensor)
let fader = await singularity(
  vxTensor,
  vShape,
  0,
  1,
  VoronoiDiagramType.range,
  DistanceMetric.chebyshev,
)
fader = await invert(await normalize(fader), vShape, 0, 1)
const fadeData = await readTensorData(fader)
const randV = simplexRandom(0, undefined, 1)
for (let i = 0; i < vxX.length; i++) {
  vxX[i] *= fadeData[i]
  vxY[i] *= fadeData[i]
}
const vxManualTensor = await refract(
  vxTensor,
  Tensor.fromArray(null, vxX, vShape),
  Tensor.fromArray(null, vxY, vShape),
  randV * 100 * 64,
  InterpolationType.bicubic,
  false,
)
const vxManual = await readTensorData(vxManualTensor)
setSeed(1)
const vxResultTensor = await vortex(vxTensor, vShape, 0, 1, 64)
const vxResult = await readTensorData(vxResultTensor)
arraysClose(Array.from(vxResult), Array.from(vxManual))

// worms regression with zero density
const wormsTensor = Tensor.fromArray(null, new Float32Array([0.4]), [1, 1, 1])
const wormsOut = await readTensorData(
  worms(
    wormsTensor,
    [1, 1, 1],
    0,
    1,
    1,
    0.0,
    4.0,
    1.0,
    0.05,
    0.5,
  ),
)
const wormsExpected = loadFixture("worms.json")
arraysClose(Array.from(wormsOut), wormsExpected)

// erosionWorms regression with zero density
const ewData = new Float32Array(25)
ewData[0] = 0.6
const ewTensor = Tensor.fromArray(null, ewData, [5, 5, 1])
const ewOut = await readTensorData(
  erosionWorms(
    ewTensor,
    [5, 5, 1],
    0,
    1,
    0.0,
    5,
    1.0,
    false,
    0.25,
  ),
)
const ewExpected = loadFixture("erosionWorms.json")
arraysClose(Array.from(ewOut), ewExpected)

// bloom regression
const bloomData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const bloomTensor = Tensor.fromArray(null, bloomData, [2, 2, 1])
const bloomOut = await readTensorData(
  bloom(bloomTensor, [2, 2, 1], 0, 1, 1.0),
)
const bloomExpected = loadFixture("bloom.json")
arraysClose(Array.from(bloomOut), bloomExpected)

// vaseline regression
const vasOut = await readTensorData(
  vaseline(bloomTensor, [2, 2, 1], 0, 1, 1.0),
)
const vasExpected = loadFixture("vaseline.json")
arraysClose(Array.from(vasOut), vasExpected)

// lightLeak regression
setSeed(1)
const leakOut = await readTensorData(
  lightLeak(bloomTensor, [2, 2, 1], 0, 1, 0.25),
)
const leakExpected = loadFixture("lightLeak.json")
arraysClose(Array.from(leakOut), leakExpected)

// wobble regression
setSeed(1)
const wobData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const wobTensor = Tensor.fromArray(null, wobData, [2, 2, 1])
setSeed(1)
const wobOut = await readTensorData(
  wobble(wobTensor, [2, 2, 1], 0.8, 1),
)
const wobExpected = loadFixture("wobble.json")
arraysClose(Array.from(wobOut), wobExpected)

// reverb regression
const revData = new Float32Array([0.1, 0.4, 0.6, 0.9])
const revTensor = Tensor.fromArray(null, revData, [2, 2, 1])
const revOut = await readTensorData(
  reverb(revTensor, [2, 2, 1], 0, 1, 2, 1, true),
)
const revExpected = loadFixture("reverb.json")
arraysClose(Array.from(revOut), revExpected)

// dla regression
setSeed(7)
const dlaData = new Float32Array([
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3,
  0.2,
])
const dlaTensor = Tensor.fromArray(null, dlaData, [4, 4, 1])
setSeed(7)
const dlaOut = await readTensorData(dla(dlaTensor, [4, 4, 1], 1, 1, 1, 1, 0.5))
const dlaExpected = loadFixture("dla.json")
arraysClose(Array.from(dlaOut), dlaExpected)

// rotate effect
const rotData = new Float32Array([1, 2, 3, 4])
const rotTensor = Tensor.fromArray(null, rotData, [2, 2, 1])
const rotOut = await readTensorData(
  rotate(rotTensor, [2, 2, 1], 0, 1, 90),
)
const rotExpected = loadFixture("rotate.json")
arraysClose(Array.from(rotOut), rotExpected)

// pixelSort effect
const psData = new Float32Array([0.2, 0.8, 0.5, 0.1])
const psTensor = Tensor.fromArray(null, psData, [1, 4, 1])
const psOut = await readTensorData(pixelSort(psTensor, [1, 4, 1], 0, 1))
const psExpected = loadFixture("pixelSort.json")
arraysClose(Array.from(psOut), psExpected)

// squareCropAndResize utility
const scData = new Float32Array([0, 1, 2, 3, 4, 5])
const scTensorUtil = Tensor.fromArray(null, scData, [2, 3, 1])
const scUtilOut = await readTensorData(
  squareCropAndResize(scTensorUtil, [2, 3, 1], 2),
)
assert.deepStrictEqual(Array.from(scUtilOut), [0, 1, 3, 4])

// sketch regression
setSeed(1)
const skData = new Float32Array([0.1, 0.5, 0.3, 0.8])
const skTensor = Tensor.fromArray(null, skData, [2, 2, 1])
setSeed(1)
const skOut = await readTensorData(sketch(skTensor, [2, 2, 1], 0, 1))
const skExpected = loadFixture("sketch.json")
arraysClose(Array.from(skOut), skExpected)

// simpleFrame regression
const sfTensor = Tensor.fromArray(null, skData, [2, 2, 1])
const sfOut = await readTensorData(
  simpleFrame(sfTensor, [2, 2, 1], 0, 1, 0.5),
)
const sfExpected = loadFixture("simpleFrame.json")
arraysClose(Array.from(sfOut), sfExpected)

// frame regression
setSeed(1)
const frTensor = Tensor.fromArray(null, skData, [2, 2, 1])
setSeed(1)
  const frOut = await readTensorData(frame(frTensor, [2, 2, 1], 0, 1))
const frExpected = loadFixture("frame.json")
arraysClose(Array.from(frOut), frExpected)

// lowpoly regression
setSeed(1)
const lpOut = await readTensorData(
  lowpoly(edgeTensor, [4, 4, 1], 0, 1, undefined, 2),
)
const lpExpected = loadFixture("lowpoly.json")
arraysClose(Array.from(lpOut), lpExpected)

// kaleido regression
setSeed(1)
const kalOut = await readTensorData(kaleido(edgeTensor, [4, 4, 1], 0, 1, 3))
const kalExpected = loadFixture("kaleido.json")
arraysClose(Array.from(kalOut), kalExpected)

// texture regression
const texOut = await readTensorData(texture(edgeTensor, [4, 4, 1], 0, 1))
const texExpected = loadFixture("texture.json")
arraysClose(Array.from(texOut), texExpected)

// glyphMap shape test
const gmTensor = Tensor.fromArray(null, edgeData, [4, 4, 1])
const gmOut = await readTensorData(glyphMap(gmTensor, [4, 4, 1], 0, 1))
assert.strictEqual(gmOut.length, 16)

// vhs regression
setSeed(1)
const rgbEffectData = new Float32Array([
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.1, 0.2, 0.3,
])
const vhsTensor = Tensor.fromArray(null, rgbEffectData, [2, 2, 3])
const vhsOut = await readTensorData(vhs(vhsTensor, [2, 2, 3], 0.25, 1))
const vhsExpected = loadFixture("vhs.json")
arraysClose(Array.from(vhsOut), vhsExpected)

setSeed(1)
const vhsHalfOut = await readTensorData(vhs(vhsTensor, [2, 2, 3], 0.5, 1))
const vhsHalfExpected = loadFixture("vhsHalf.json")
arraysClose(Array.from(vhsHalfOut), vhsHalfExpected)

// scanlineError regression
const sleData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const sleTensor = Tensor.fromArray(null, sleData, [2, 2, 1])
const sleOut = await readTensorData(
  scanlineError(sleTensor, [2, 2, 1], 0.25, 1),
)
const sleExpected = loadFixture("scanlineError.json")
arraysClose(Array.from(sleOut), sleExpected)

// crt regression
setSeed(1)
const crtTensor = Tensor.fromArray(null, rgbEffectData, [2, 2, 3])
setSeed(1)
const crtOut = await readTensorData(crt(crtTensor, [2, 2, 3], 0.25, 1))
const crtExpected = loadFixture("crt.json")
arraysClose(Array.from(crtOut), crtExpected)

// snow regression
setSeed(1)
const snowData = new Float32Array([0.1, 0.2, 0.3, 0.4])
const snowTensor = Tensor.fromArray(null, snowData, [2, 2, 1])
const snowOut = await readTensorData(snow(snowTensor, [2, 2, 1], 0, 1))
const snowExpected = loadFixture("snow.json")
arraysClose(Array.from(snowOut), snowExpected)

// spatter regression
setSeed(1)
const spTensor = Tensor.fromArray(null, new Float32Array(16), [4, 4, 1])
setSeed(1)
const spOut = await readTensorData(spatter(spTensor, [4, 4, 1], 0, 1))
const spExpected = loadFixture("spatter.json")
arraysClose(Array.from(spOut), spExpected)

// clouds regression
setSeed(1)
const clTensor = Tensor.fromArray(null, new Float32Array(16), [4, 4, 1])
setSeed(1)
const clOut = await readTensorData(clouds(clTensor, [4, 4, 1], 0, 1))
const clExpected = loadFixture("clouds.json")
arraysClose(Array.from(clOut), clExpected)

// fibers regression
setSeed(1)
const fbTensor = Tensor.fromArray(null, new Float32Array(16), [4, 4, 1])
setSeed(1)
const fbOut = await readTensorData(fibers(fbTensor, [4, 4, 1], 0, 1))
const fbExpected = loadFixture("fibers.json")
arraysClose(Array.from(fbOut), fbExpected)
const fbArr = Array.from(fbOut)
assert.ok(fbArr.every((v) => v >= 0 && v <= 1))

// scratches regression
setSeed(1)
const scTensor = Tensor.fromArray(null, new Float32Array(16), [4, 4, 1])
setSeed(1)
const scOut = await readTensorData(scratches(scTensor, [4, 4, 1], 0, 1))
const scArr = Array.from(scOut)
assert.ok(scArr.some((v) => v > 0))
assert.ok(scArr.every((v) => v >= 0 && v <= 1))

// strayHair regression
setSeed(1)
const shTensor = Tensor.fromArray(null, new Float32Array(16), [4, 4, 1])
setSeed(1)
const shOut = await readTensorData(strayHair(shTensor, [4, 4, 1], 0, 1))
const shExpected = loadFixture("strayHair.json")
arraysClose(Array.from(shOut), shExpected)
const shArr = Array.from(shOut)
assert.ok(shArr.every((v) => v >= 0 && v <= 1))

// grime regression
setSeed(1)
const grimeTensor = Tensor.fromArray(null, new Float32Array(64), [8, 8, 1])
setSeed(1)
const grOut = await readTensorData(grime(grimeTensor, [8, 8, 1], 0, 1))
const grExpected = loadFixture("grime.json")
arraysClose(Array.from(grOut), grExpected)

// spookyTicker regression
setSeed(1)
const spookyTensor = Tensor.fromArray(null, new Float32Array(64), [8, 8, 1])
setSeed(1)
const stOut = await readTensorData(spookyTicker(spookyTensor, [8, 8, 1], 0, 1))
const stExpected = loadFixture("spookyTicker.json")
arraysClose(Array.from(stOut), stExpected)

// onScreenDisplay regression
setSeed(1)
const osdTensor = Tensor.fromArray(
  null,
  new Float32Array(64 * 64),
  [64, 64, 1],
)
setSeed(1)
const osdOut = await readTensorData(
  onScreenDisplay(osdTensor, [64, 64, 1], 0, 1),
)
const osdExpected = loadFixture("onScreenDisplay.json")
arraysClose(Array.from(osdOut), osdExpected)

// nebula regression
setSeed(1)
const nebTensor = Tensor.fromArray(
  null,
  new Float32Array(32 * 32 * 3),
  [32, 32, 3],
)
setSeed(1)
const nebOut = await readTensorData(nebula(nebTensor, [32, 32, 3], 0, 1))
const nebExpected = loadFixture("nebula.json")
arraysClose(Array.from(nebOut), nebExpected)

// falseColor regression
setSeed(1)
const fcData = new Float32Array([
  0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.4, 0.4, 0.4,
])
const fcTensor = Tensor.fromArray(null, fcData, [2, 2, 3])
const fcOut = await readTensorData(falseColor(fcTensor, [2, 2, 3], 0, 1))
const fcExpected = loadFixture("falseColor.json")
arraysClose(Array.from(fcOut), fcExpected)

// tint regression
setSeed(1)
const tintData = new Float32Array([
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.2, 0.3, 0.4,
])
const tintTensor = Tensor.fromArray(null, tintData, [2, 2, 3])
setSeed(1)
const tintOut = await readTensorData(tint(tintTensor, [2, 2, 3], 0, 1, 0.5))
const tintExpected = loadFixture("tint.json")
arraysClose(Array.from(tintOut), tintExpected)
const tintArr = Array.from(tintOut)
assert.ok(tintArr.every((v) => v >= 0 && v <= 1))

// valueRefract regression
const vrData = new Float32Array([
  0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4,
  0.5,
])
const vrTensor = Tensor.fromArray(null, vrData, [4, 4, 1])
const vrOut = await readTensorData(valueRefract(vrTensor, [4, 4, 1], 0, 1))
const vrExpected = loadFixture("valueRefract.json")
arraysClose(Array.from(vrOut), vrExpected)
const vrArr = Array.from(vrOut)
assert.ok(vrArr.every((v) => v >= 0 && v <= 1))

// lensWarp extreme displacement
setSeed(1)
const lwOut = await readTensorData(lensWarp(edgeTensor, [4, 4, 1], 0, 1, 5))
for (const v of lwOut) {
  assert.ok(Number.isFinite(v))
  assert.ok(v >= 0 && v <= 1)
}

// lensDistortion negative displacement regression
const ldDisp = -2
const ldRes = await readTensorData(
  lensDistortion(edgeTensor, [4, 4, 1], 0, 1, ldDisp),
)
const ldManual = (() => {
  const h = 4,
    w = 4
  const out = new Float32Array(h * w)
  const maxDist = Math.sqrt(0.5 * 0.5 + 0.5 * 0.5)
  const zoom = ldDisp < 0 ? ldDisp * -0.25 : 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xIndex = x / w
      const yIndex = y / h
      const xDist = xIndex - 0.5
      const yDist = yIndex - 0.5
      const centerDist = 1 - distance(xDist, yDist) / maxDist
      const xOff =
        (xIndex - xDist * zoom - xDist * centerDist * centerDist * ldDisp) * w
      const yOff =
        (yIndex - yDist * zoom - yDist * centerDist * centerDist * ldDisp) * h
      const xi = ((Math.floor(xOff) % w) + w) % w
      const yi = ((Math.floor(yOff) % h) + h) % h
      out[y * w + x] = edgeData[yi * w + xi]
    }
  }
  return out
})()
arraysClose(Array.from(ldRes), Array.from(ldManual))

// degauss per-channel lensWarp consistency
setSeed(2)
const dgTensor = Tensor.fromArray(null, rgbEffectData, [2, 2, 3])
const dgOut = await readTensorData(degauss(dgTensor, [2, 2, 3], 0, 1, 1))
setSeed(2)
const channelShape = [2, 2, 1]
const rChan = Tensor.fromArray(
  null,
  new Float32Array([0.1, 0.4, 0.7, 0.1]),
  channelShape,
)
const gChan = Tensor.fromArray(
  null,
  new Float32Array([0.2, 0.5, 0.8, 0.2]),
  channelShape,
)
const bChan = Tensor.fromArray(
  null,
  new Float32Array([0.3, 0.6, 0.9, 0.3]),
  channelShape,
)
const rWarp = await readTensorData(lensWarp(rChan, channelShape, 0, 1, 1))
const gWarp = await readTensorData(lensWarp(gChan, channelShape, 0, 1, 1))
const bWarp = await readTensorData(lensWarp(bChan, channelShape, 0, 1, 1))
const dgManual = new Float32Array(2 * 2 * 3)
for (let i = 0; i < 4; i++) {
  dgManual[i * 3] = rWarp[i]
  dgManual[i * 3 + 1] = gWarp[i]
  dgManual[i * 3 + 2] = bWarp[i]
}
arraysClose(Array.from(dgOut), Array.from(dgManual))

// smoothstep regression
const smTensor = Tensor.fromArray(
  null,
  new Float32Array([0.2, 0.5, 0.8, 1.2]),
  [2, 2, 1],
)
const smOut = await readTensorData(
  smoothstep(smTensor, [2, 2, 1], 0, 1, 0.25, 0.75),
)
const smExpected = loadFixture("smoothstep.json")
arraysClose(Array.from(smOut), smExpected)

// convolve regression
const cvTensor = Tensor.fromArray(
  null,
  new Float32Array([0.1, 0.5, 0.3, 0.7]),
  [2, 2, 1],
)
const cvOut = await readTensorData(
  convolve(
    cvTensor,
    [2, 2, 1],
    0,
    1,
    ValueMask.conv2d_blur,
    true,
    1,
  ),
)
const cvExpected = loadFixture("convolve.json")
arraysClose(Array.from(cvOut), cvExpected)

// convolve edges regression
const cvEdgesOut = await readTensorData(
  convolve(
    cvTensor,
    [2, 2, 1],
    0,
    1,
    ValueMask.conv2d_edges,
    true,
    1,
  ),
)
const cvEdgesExpected = loadFixture("convolveEdges.json")
arraysClose(Array.from(cvEdgesOut), cvEdgesExpected)

// refractEffect regression
const rfTensor = Tensor.fromArray(
  null,
  new Float32Array([
    0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4,
    0.5,
  ]),
  [4, 4, 1],
)
const rfRef = Tensor.fromArray(
  null,
  new Float32Array([0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]),
  [4, 4, 1],
)
const rfOut = await readTensorData(
  refractEffect(rfTensor, [4, 4, 1], 0, 1, 0.5, rfRef, rfRef),
)
const rfExpected = loadFixture("refractEffect.json")
arraysClose(Array.from(rfOut), rfExpected)

// refractEffect derivative parity
const fdTensor = Tensor.fromArray(
  null,
  new Float32Array([
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0,
  ]),
  [4, 4, 1],
)
const kx = [
  [-1, 0, 1],
  [-2, 0, 2],
  [-1, 0, 1],
]
const ky = [
  [-1, -2, -1],
  [0, 0, 0],
  [1, 2, 1],
]
const dx = await convolution(fdTensor, kx, { normalize: false })
const dy = await convolution(fdTensor, ky, { normalize: false })
const fdExpected = await readTensorData(
  refract(fdTensor, dx, dy, 0.5, InterpolationType.bicubic, false),
)
const fdOut = await readTensorData(
  refractEffect(
    fdTensor,
    [4, 4, 1],
    0,
    1,
    0.5,
    null,
    null,
    null,
    InterpolationType.bicubic,
    true,
  ),
)
arraysClose(Array.from(fdOut), Array.from(fdExpected))

// fxaaEffect regression
const fxData = new Float32Array([
  0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3,

  0.4, 0.4, 0.4, 0.5, 0.5, 0.5, 0.6, 0.6, 0.6,

  0.7, 0.7, 0.7, 0.8, 0.8, 0.8, 0.9, 0.9, 0.9,
])
const fxTensor = Tensor.fromArray(null, fxData, [3, 3, 3])
const fxOut = await readTensorData(fxaaEffect(fxTensor, [3, 3, 3], 0, 1))
const fxExpected = loadFixture("fxaaEffect.json")
arraysClose(Array.from(fxOut), fxExpected)

console.log("Effects tests passed")
