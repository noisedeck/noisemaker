// shaders/src/scene/math.js
import { vec3, mat4, quat } from 'gl-matrix'

export function degToRad(deg) {
  return deg * Math.PI / 180
}

export function radToDeg(rad) {
  return rad * 180 / Math.PI
}

export function eulerToQuat(eulerDeg) {
  const q = quat.create()
  quat.fromEuler(q, eulerDeg[0], eulerDeg[1], eulerDeg[2])
  return q
}

export function quatToEuler(q) {
  const [x, y, z, w] = q
  const sinp = 2 * (w * y - z * x)
  if (Math.abs(sinp) >= 1) {
    // Gimbal lock: pitch at +/-90 degrees
    // Convention: set yaw = 0, solve roll
    const roll = 2 * Math.atan2(x, w)
    const pitch = Math.sign(sinp) * Math.PI / 2
    return [radToDeg(roll), radToDeg(pitch), 0]
  }
  const sinr_cosp = 2 * (w * x + y * z)
  const cosr_cosp = 1 - 2 * (x * x + y * y)
  const roll = Math.atan2(sinr_cosp, cosr_cosp)
  const pitch = Math.asin(sinp)
  const siny_cosp = 2 * (w * z + x * y)
  const cosy_cosp = 1 - 2 * (y * y + z * z)
  const yaw = Math.atan2(siny_cosp, cosy_cosp)
  return [radToDeg(roll), radToDeg(pitch), radToDeg(yaw)]
}

export function composeTransform(position, rotationDeg, scale) {
  const out = mat4.create()
  const q = eulerToQuat(rotationDeg)
  mat4.fromRotationTranslationScale(out, q,
    vec3.fromValues(position[0], position[1], position[2]),
    vec3.fromValues(scale[0], scale[1], scale[2])
  )
  return out
}

export function decomposeTransform(matrix) {
  const position = vec3.create()
  const rotation = quat.create()
  const scale = vec3.create()
  mat4.getTranslation(position, matrix)
  mat4.getRotation(rotation, matrix)
  mat4.getScaling(scale, matrix)
  return {
    position: Array.from(position),
    rotation: Array.from(quatToEuler(rotation)),
    scale: Array.from(scale)
  }
}

/**
 * Float32 stand-ins for the eye/centre/up a view matrix is built from.
 *
 * The three vectors used to be `vec3.fromValues(...)`, which rounds each
 * component to float32 BEFORE gl-matrix does any arithmetic. Handing
 * `mat4.lookAt` the caller's plain (float64) arrays instead would do the
 * normalisation at double precision and round only the result, moving the
 * matrix by an ulp or two. These buffers keep the original rounding, and
 * keep the call allocation-free: it sits on the per-frame render path, which
 * is single-threaded and never yields between the copy and the call.
 */
const LOOK_EYE = new Float32Array(3)
const LOOK_CENTER = new Float32Array(3)
const LOOK_UP = new Float32Array(3)

/**
 * View matrix for an eye looking at a centre, written into `out`.
 *
 * `out` is written in every case — `mat4.lookAt` fills all sixteen elements,
 * and its degenerate eye-equals-centre branch writes an identity — so a reused
 * buffer can never carry a previous frame's value forward.
 * @param {Float32Array} out - Destination matrix
 * @param {ArrayLike<number>} eye - Eye position
 * @param {ArrayLike<number>} center - Point looked at
 * @param {ArrayLike<number>} up - Up direction
 * @returns {Float32Array} out
 */
export function lookAtMatrix(out, eye, center, up) {
  for (let i = 0; i < 3; i++) {
    LOOK_EYE[i] = eye[i]
    LOOK_CENTER[i] = center[i]
    LOOK_UP[i] = up[i]
  }
  mat4.lookAt(out, LOOK_EYE, LOOK_CENTER, LOOK_UP)
  return out
}

/**
 * Symmetric perspective projection, written into `out`.
 * @param {Float32Array} out - Destination matrix
 * @param {number} fovDeg - Vertical field of view in degrees
 * @param {number} aspect - Width / height of the target
 * @param {number} near - Near plane distance
 * @param {number} far - Far plane distance
 * @returns {Float32Array} out
 */
export function perspectiveMatrix(out, fovDeg, aspect, near, far) {
  mat4.perspective(out, degToRad(fovDeg), aspect, near, far)
  return out
}

/**
 * The projection matrix for ONE TILE of a larger image.
 *
 * Hi-res export renders the image in tiles (Pipeline.setTileRegion). A 2D
 * effect is told the tile's pixel offset and the full image size and shifts its
 * own gl_FragCoord to recover a full-image pixel. A projected view has no such
 * coordinate to shift — its pixels come from the rasterizer — so the equivalent
 * for a camera is to restrict its frustum to the tile's sub-rectangle. That
 * renders exactly the tile's content, at the tile's full resolution, with no
 * shader change at all: the projection matrix is the only thing that moves.
 *
 * Derivation. `perspectiveMatrix(out, fov, aspect, near, far)` is, by definition,
 * the symmetric frustum
 *
 *   top = near * tan(fov / 2)      right = top * aspect
 *   frustum(-right, right, -top, top, near, far)
 *
 * The near-plane rectangle [-right, right] x [-top, top] maps onto the whole
 * image. A tile owning image pixels [x, x + width) x [y, y + height) therefore
 * owns the same fraction of that rectangle, so its bounds are the full ones
 * linearly interpolated by the tile's pixel fractions. The result is an
 * off-centre (asymmetric) frustum — mat4.frustum, not mat4.perspective — and
 * the four tiles of a 2x2 split tessellate the original frustum exactly.
 *
 * `aspect` is the FULL image's, not the tile's: the slicing is what gives the
 * tile its own aspect, and deriving from the tile's would stretch every tile.
 *
 * Tile offsets are measured from the BOTTOM-LEFT of the full image, matching
 * the 2D path (gl_FragCoord.y is bottom-up, and the tile-parity gate crops
 * full frames from the bottom-left on both backends).
 *
 * @param {Float32Array} out - Destination matrix
 * @param {number} fovDeg - Vertical field of view in degrees
 * @param {number} near - Near plane distance
 * @param {number} far - Far plane distance
 * @param {{x: number, y: number, width: number, height: number,
 *          fullWidth: number, fullHeight: number}} tile - Tile rectangle in
 *   full-image pixels, with the origin at the bottom-left
 * @returns {Float32Array} out, the off-centre projection matrix for the tile
 */
export function tileFrustumMatrix(out, fovDeg, near, far, tile) {
  const top = near * Math.tan(degToRad(fovDeg) * 0.5)
  const right = top * (tile.fullWidth / tile.fullHeight)

  const left = -right + 2 * right * (tile.x / tile.fullWidth)
  const tileRight = -right + 2 * right * ((tile.x + tile.width) / tile.fullWidth)
  const bottom = -top + 2 * top * (tile.y / tile.fullHeight)
  const tileTop = -top + 2 * top * ((tile.y + tile.height) / tile.fullHeight)

  mat4.frustum(out, left, tileRight, bottom, tileTop, near, far)
  return out
}

export function reflectPointAcrossPlane(out, point, planePoint, planeNormal) {
  const dx = point[0] - planePoint[0]
  const dy = point[1] - planePoint[1]
  const dz = point[2] - planePoint[2]
  const distance = dx * planeNormal[0] + dy * planeNormal[1] + dz * planeNormal[2]
  out[0] = point[0] - 2 * distance * planeNormal[0]
  out[1] = point[1] - 2 * distance * planeNormal[1]
  out[2] = point[2] - 2 * distance * planeNormal[2]
  return out
}

export function reflectDirectionAcrossPlane(out, direction, planeNormal) {
  const projection =
    direction[0] * planeNormal[0] +
    direction[1] * planeNormal[1] +
    direction[2] * planeNormal[2]
  out[0] = direction[0] - 2 * projection * planeNormal[0]
  out[1] = direction[1] - 2 * projection * planeNormal[1]
  out[2] = direction[2] - 2 * projection * planeNormal[2]
  return out
}

export function planeFromWorldMatrix(pointOut, normalOut, worldMatrix) {
  pointOut[0] = worldMatrix[12]
  pointOut[1] = worldMatrix[13]
  pointOut[2] = worldMatrix[14]

  // The local plane spans X/Z. Their transformed cross product remains a
  // valid normal even when parent non-uniform scale introduces shear.
  const nx = worldMatrix[9] * worldMatrix[2] - worldMatrix[10] * worldMatrix[1]
  const ny = worldMatrix[10] * worldMatrix[0] - worldMatrix[8] * worldMatrix[2]
  const nz = worldMatrix[8] * worldMatrix[1] - worldMatrix[9] * worldMatrix[0]
  const inverseLength = 1 / Math.max(Math.hypot(nx, ny, nz), 1e-8)
  normalOut[0] = nx * inverseLength
  normalOut[1] = ny * inverseLength
  normalOut[2] = nz * inverseLength
  return normalOut
}

export { vec3, mat4, quat }
