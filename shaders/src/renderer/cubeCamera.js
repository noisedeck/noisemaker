// Cube-face camera math for seamless cubemap rendering.
// Pure functions — no GPU, no DOM. Shared by the render driver, export, preview.
//
// Camera sits at the origin looking OUT along each of the 6 axes. A face has an
// orthonormal basis (forward, right, up); a face pixel at (u, v) ∈ [-1,1]^2 maps to
//     dir = normalize(forward + u*right + v*up)        // 90-degree frustum
// Adjacent faces share identical edge directions — the source of cube seamlessness.

export const FACE_PX = 0, FACE_NX = 1, FACE_PY = 2, FACE_NY = 3, FACE_PZ = 4, FACE_NZ = 5

// forward = view direction; up = face "up". Order: +X,-X,+Y,-Y,+Z,-Z (GL cubemap order).
export const CUBE_FACES = [
  { name: 'px', forward: [1, 0, 0], up: [0, -1, 0] },
  { name: 'nx', forward: [-1, 0, 0], up: [0, -1, 0] },
  { name: 'py', forward: [0, 1, 0], up: [0, 0, 1] },
  { name: 'ny', forward: [0, -1, 0], up: [0, 0, -1] },
  { name: 'pz', forward: [0, 0, 1], up: [0, -1, 0] },
  { name: 'nz', forward: [0, 0, -1], up: [0, -1, 0] },
]

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (v) => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

// right = cross(up, forward) so (right, up, forward) is right-handed.
export function faceRight(face) {
  const f = CUBE_FACES[face]
  return cross(f.up, f.forward)
}

export function faceDirection(face, u, v) {
  const f = CUBE_FACES[face]
  const r = faceRight(face)
  return normalize([
    f.forward[0] + u * r[0] + v * f.up[0],
    f.forward[1] + u * r[1] + v * f.up[1],
    f.forward[2] + u * r[2] + v * f.up[2],
  ])
}

// Inverse, correct by construction: choose the face whose forward axis is most
// aligned with dir, then recover (u, v) by projecting onto that face's basis.
export function directionToFaceUV(dir) {
  let best = 0, bestDot = -Infinity
  for (let face = 0; face < 6; face++) {
    const d = dot(dir, CUBE_FACES[face].forward)
    if (d > bestDot) { bestDot = d; best = face }
  }
  const f = CUBE_FACES[best]
  const r = faceRight(best)
  return { face: best, u: dot(dir, r) / bestDot, v: dot(dir, f.up) / bestDot }
}

// Column-major [right | up | forward] for a mat3 uniform. The shader computes
// dir = normalize(basis * vec3(u, v, 1)).
export function faceBasisMat3(face) {
  const f = CUBE_FACES[face]
  const r = faceRight(face)
  return [r[0], r[1], r[2], f.up[0], f.up[1], f.up[2], f.forward[0], f.forward[1], f.forward[2]]
}

// Precomputed once at import — avoids per-frame allocation in renderCubemap.
export const CUBE_FACE_BASES = [0, 1, 2, 3, 4, 5].map(faceBasisMat3)
