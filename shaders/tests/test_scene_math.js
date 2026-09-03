// shaders/tests/test_scene_math.js
import assert from 'assert'
import {
  mat4,
  degToRad,
  radToDeg,
  eulerToQuat,
  quatToEuler,
  composeTransform,
  decomposeTransform,
  lookAtMatrix,
  perspectiveMatrix,
  tileFrustumMatrix,
  reflectPointAcrossPlane,
  reflectDirectionAcrossPlane,
  planeFromWorldMatrix
} from '../src/scene/math.js'

function approx(a, b, eps = 1e-5) {
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
}

function vecApprox(a, b, eps = 1e-5) {
  assert.strictEqual(a.length, b.length)
  for (let i = 0; i < a.length; i++) approx(a[i], b[i], eps)
}

// degToRad / radToDeg
approx(degToRad(180), Math.PI)
approx(degToRad(90), Math.PI / 2)
approx(radToDeg(Math.PI), 180)
approx(radToDeg(Math.PI / 2), 90)

// eulerToQuat round-trip
{
  const euler = [45, 90, 0] // degrees
  const q = eulerToQuat(euler)
  assert.strictEqual(q.length, 4)
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])
  approx(len, 1.0)
  const back = quatToEuler(q)
  vecApprox(back, euler, 0.1)
}

// composeTransform: identity
{
  const m = composeTransform([0, 0, 0], [0, 0, 0], [1, 1, 1])
  assert.strictEqual(m.length, 16)
  approx(m[0], 1); approx(m[5], 1); approx(m[10], 1); approx(m[15], 1)
}

// composeTransform: translation
{
  const m = composeTransform([3, 4, 5], [0, 0, 0], [1, 1, 1])
  approx(m[12], 3); approx(m[13], 4); approx(m[14], 5)
}

// composeTransform: scale
{
  const m = composeTransform([0, 0, 0], [0, 0, 0], [2, 3, 4])
  approx(m[0], 2); approx(m[5], 3); approx(m[10], 4)
}

// decomposeTransform round-trip
{
  const pos = [1, 2, 3]
  const rot = [30, 45, 60]
  const scl = [1, 1, 1]
  const m = composeTransform(pos, rot, scl)
  const { position, scale } = decomposeTransform(m)
  vecApprox(position, pos)
  vecApprox(scale, scl)
}

// lookAtMatrix writes into the caller's buffer and hands it back, so a render
// loop can keep one matrix per view instead of minting one per call.
{
  const out = mat4.create()
  const m = lookAtMatrix(out, [0, 0, 5], [0, 0, 0], [0, 1, 0])
  assert.strictEqual(m, out, 'lookAtMatrix returns the buffer it was given')
  assert.strictEqual(m.length, 16)
}

// Every matrix helper writes all sixteen elements, which is what makes a reused
// buffer safe: none of them can carry a previous call's value forward.
{
  const dirty = () => mat4.fromValues(
    9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9)

  assert.deepStrictEqual(
    Array.from(lookAtMatrix(dirty(), [0, 0, 5], [0, 0, 0], [0, 1, 0])),
    Array.from(lookAtMatrix(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0])),
    'lookAtMatrix overwrites a dirty buffer completely')
  // Its degenerate eye-equals-centre branch takes a different path out.
  assert.deepStrictEqual(
    Array.from(lookAtMatrix(dirty(), [1, 2, 3], [1, 2, 3], [0, 1, 0])),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    'the degenerate lookAt writes a full identity, not a partial one')
  assert.deepStrictEqual(
    Array.from(perspectiveMatrix(dirty(), 60, 4 / 3, 0.1, 100)),
    Array.from(perspectiveMatrix(mat4.create(), 60, 4 / 3, 0.1, 100)),
    'perspectiveMatrix overwrites a dirty buffer completely')
  const tile = { x: 50, y: 50, width: 50, height: 50, fullWidth: 100, fullHeight: 100 }
  assert.deepStrictEqual(
    Array.from(tileFrustumMatrix(dirty(), 90, 1, 1000, tile)),
    Array.from(tileFrustumMatrix(mat4.create(), 90, 1, 1000, tile)),
    'tileFrustumMatrix overwrites a dirty buffer completely')
}

// lookAtMatrix rounds eye/centre/up to float32 before the arithmetic, exactly
// as the vec3.fromValues it replaced did. Pinned against a hand-rolled
// float32-in / float64-math reference so the reused scratch cannot silently
// start computing at double precision.
{
  const eye = [0.1, 0.2, 5.3]
  const center = [0.7, 0.30000000000000004, 0.1]
  const up = [0.1, 0.9, 0.2]
  const f32 = v => Array.from(new Float32Array(v))
  const expected = mat4.lookAt(mat4.create(), f32(eye), f32(center), f32(up))
  assert.deepStrictEqual(
    Array.from(lookAtMatrix(mat4.create(), eye, center, up)),
    Array.from(expected),
    'the view matrix is built from float32 inputs, not the raw float64 arrays')
}

// Planar reflection camera math
{
  const planePoint = [0, -0.6, 0]
  const planeNormal = [0, 1, 0]
  const reflectedPosition = new Float32Array(3)
  const reflectedTarget = new Float32Array(3)
  const reflectedUp = new Float32Array(3)

  reflectPointAcrossPlane(reflectedPosition, [0, 3.2, -8.5], planePoint, planeNormal)
  reflectPointAcrossPlane(reflectedTarget, [0, 0.6, 0], planePoint, planeNormal)
  reflectDirectionAcrossPlane(reflectedUp, [0, 1, 0], planeNormal)

  vecApprox(reflectedPosition, [0, -4.4, -8.5])
  vecApprox(reflectedTarget, [0, -1.8, 0])
  vecApprox(reflectedUp, [0, -1, 0])
}

// A plane primitive's local +Y axis and origin define its world-space plane
{
  const world = composeTransform([2, -0.6, 4], [0, 0, 0], [3, 1, 2])
  const point = new Float32Array(3)
  const normal = new Float32Array(3)
  planeFromWorldMatrix(point, normal, world)
  vecApprox(point, [2, -0.6, 4])
  vecApprox(normal, [0, 1, 0])
}

// Parent non-uniform transforms can shear a child plane; derive its normal
// from transformed tangents rather than trusting the world Y basis.
{
  const shearedWorld = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 1, 1, 0,
    0, 0, 0, 1
  ])
  const point = new Float32Array(3)
  const normal = new Float32Array(3)
  planeFromWorldMatrix(point, normal, shearedWorld)
  const invSqrt2 = 1 / Math.sqrt(2)
  vecApprox(normal, [0, invSqrt2, -invSqrt2])
}

console.log('Scene math tests passed')
