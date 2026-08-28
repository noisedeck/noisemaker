/**
 * Volume G-buffer fill: the fragment half of the scene's density-volume pass.
 *
 * The vertex half is the mesh vertex shader, verbatim
 * (GBufferConfig.getMeshVertexShader) — including the WGSL clip-space fixups.
 * What it rasterizes here is not geometry but scaffolding: the node's unit
 * bounding box, drawn back-faces-only (`cullMode: 'front'`) so one fragment
 * lands per covered pixel and the box survives the camera being inside it.
 *
 * Each fragment then marches a ray through the density atlas and either
 * publishes an isosurface hit into the SAME four G-buffer targets a mesh pass
 * fills, or discards. Deferred lighting, SSAO and SSR need no change: they read
 * the G-buffer and cannot tell a marched surface from a rasterized one.
 *
 * Ray construction, once, for both languages:
 *
 *   ro_world = u_cameraPos
 *   rd_world = normalize(v_worldPos - u_cameraPos)     // interpolated box surface
 *   ro_local = (u_invModelMatrix * vec4(ro_world, 1)).xyz
 *   rd_local = normalize((u_invModelMatrix * vec4(rd_world, 0)).xyz)
 *
 * There is no unprojection and no gl_FragCoord, so the fragcoord-origin
 * divergence the legacy marchers carry (bottom-left in GLSL, top-left in WGSL)
 * cannot recur: v_worldPos is orientation-independent.
 *
 * Local space is the [-1,1]^3 body space every existing marcher uses, which is
 * exactly what `createBox({ size: [2, 2, 2] })` spans, so the slab test, step
 * size and trilinear atlas sampling are copied from render3d unchanged.
 *
 * ---------------------------------------------------------------------------
 * Relationship to shaders/src/rendering/marcher-fragments.js
 * ---------------------------------------------------------------------------
 *
 * That module is the single textual source for the legacy render/* marchers —
 * render3d, renderCubemap3d and renderCubemapSurface, whose committed .glsl and
 * .wgsl files are generated from it. This file does NOT assemble itself from
 * those fragments, and the reason is mechanical rather than a matter of taste.
 *
 * The fragments are verbatim shader text with no interpolation, which is what
 * makes the generator's byte-compare gate mean anything: what you read there is
 * what ships. That text reads `volumeSize`, `threshold` and `volumeCache` at
 * module scope. This pass reads `u_volumeSize`, `u_threshold` and
 * `u_volumeAtlas`, and in WGSL reads them out of the `VolumeUniforms` struct
 * behind a `u.` accessor, because bindings 0-3 belong to the shared mesh vertex
 * stage. No reformatting closes that gap; only turning the fragments into
 * name-parameterized templates would, at the cost of the property the byte
 * gate rests on. WGSL has no preprocessor to alias the names around, either.
 *
 * What the two implementations do owe each other, measured against the
 * fragments with comments stripped, whitespace collapsed and those uniform
 * names canonicalized:
 *
 *   calcNormal       IDENTICAL (in WGSL, modulo `let n` here for the fragment's
 *                    `var n` — n is never reassigned in either)
 *   sampleVolume     identical but for three cosmetic deltas and one merged
 *                    statement: the fragment keeps a redundant `volSize` local,
 *                    names the fraction `frac`, takes `worldPos`, and splits
 *                    `uvw = p * 0.5 + 0.5; uvw = clamp(uvw, 0, 1);` where this
 *                    file merges the two
 *   atlasTexel       same index arithmetic; the fragment takes volSize as a
 *                    parameter (in WGSL, three scalars, named volumeToAtlas),
 *                    this file reads the uniform
 *   sampleVoxel      same clamped nearest-neighbour fetch, inlined here
 *   getField         the fragment carries render3d's compile-time INVERT
 *                    branch, which this pass has no define machinery to supply
 *   isosurfaceTrace  same constants (MAX_STEPS, stepSize 1.5/N, the bisection
 *                    count), same camera-inside `max(tEnter, 0.0)`, same
 *                    enters-already-inside early hit — but not the same shape.
 *                    The fragment is self-contained: it runs its own slab test
 *                    and returns an IsoHit. Here BOTH modes share one slab test
 *                    done in main(), and the smooth march is inlined against
 *                    it, so adopting the function would run the slab test twice
 *                    on the smooth path and hand the voxel branch a second
 *                    tmin.
 *   voxelTrace       DELIBERATELY DIVERGENT and must stay so — the wall
 *                    derivation at its site below is a fix to render3d's
 *                    half-cell bias, not a copy of it.
 *
 * The numeric constants ARE single-sourced, by assertion rather than by shared
 * text: test_volume_shaders.js parses MAX_STEPS, the bisection count and the
 * step-size factor out of the shared fragments and fails if this file drifts
 * from them. That test also pins each row above, so a fragment edit that leaves
 * this file behind fails the suite instead of quietly changing one of the two.
 *
 * The gradient comes out of the field in LOCAL space and is carried to world by
 * u_normalMatrix. That is the correct matrix and not a coincidence:
 * u_normalMatrix is transpose(inverse(worldMatrix)) — the local-to-world normal
 * transform — which is precisely how the mesh vertex shader carries its own
 * local vertex normals to world.
 *
 * Depth is written twice on purpose: to RT3, because that is the channel every
 * downstream pass reads, and to the frag-depth builtin, so the hardware depth
 * test composites the HIT distance against meshes rather than the depth of the
 * bounding box's back face. `clamp(clip.z / clip.w * 0.5 + 0.5, 1e-6, 1.0)` is
 * the same window-space value the mesh pass stores as gl_FragCoord.z (the WGSL
 * vertex stage's z remap makes the two agree), and is literally the expression
 * SSR reconstructs to compare against. The 1e-6 floor keeps a near-plane hit
 * from writing an exact 0 and being read back as sky by the `depth <= 0`
 * sentinel.
 *
 * A hit in front of the near plane is DISCARDED rather than clamped, in both
 * languages, before that expression runs — the rasterizer near-clips a mesh and
 * the marcher must do the same for its hits or a volume enclosing the camera
 * hides the whole scene. See the test at the site.
 *
 * u_clipPlane / u_clipEnabled are the mesh pass's own pair, carrying the same
 * meaning: the planar reflection renders from a mirrored camera and must not
 * publish anything behind the reflector's plane. The one difference is WHERE
 * the test applies — against the marched hit, not the rasterized box face.
 *
 * ---------------------------------------------------------------------------
 * Two modes, one program
 * ---------------------------------------------------------------------------
 *
 * volume(mode: "smooth" | "voxel") selects between the two marching modes
 * render3d carries. Smooth is the trilinear isosurface described above. Voxel
 * is a 3D-DDA (Amanatides & Woo) walk of the atlas grid that stops at the first
 * CELL whose density exceeds the threshold and takes its normal from the wall
 * it entered through — render3d's FILTERING == 1 branch.
 *
 * render3d selects between them with a compile-time `#define FILTERING` the
 * expander injects per effect instance. That machinery does not exist here: the
 * scene renderer compiles named programs directly, and mode is a per-NODE
 * property, so two volumes in one scene can want different ones. It is
 * therefore a `u_mode` int uniform and one branch — which is also this pair's
 * own convention for selecting behaviour (u_hasMaterial, u_clipEnabled), and
 * renderLit3d's for selecting its bounding shape.
 *
 * Both branches produce a local hit distance and a LOCAL-space normal, and then
 * share one tail: the same clip-plane reject, the same near-plane discard, the
 * same clamped window-space depth, the same G-buffer writes. There is nothing
 * mode-specific after the branch closes.
 *
 * The face normal takes the same u_normalMatrix path the gradient does, and
 * that is a derivation rather than a convenience. A normal is defined by
 * n . v == 0 for every surface tangent v; under v' = M v, only
 * n' = (M^-1)^T n keeps n' . (M v) = n^T M^-1 M v = n . v == 0. For an
 * axis-aligned face under a bare T*R*S world matrix the naive M happens to
 * agree — the axis vectors are eigenvectors of both S and S^-1, so M n and
 * M^-T n are parallel and normalization hides the difference. But a volume
 * parented to a non-uniformly scaled, ROTATED group has a sheared world matrix
 * (S_parent R_child is not of the form R S), and there the two genuinely
 * diverge: only the inverse-transpose keeps the normal perpendicular to the
 * face it came from.
 */

/** Marcher constants, matching render3d so the same iso level resolves alike. */
const MAX_STEPS = 256
const BISECTION_STEPS = 8

/**
 * Iteration bound for the DDA walk.
 *
 * A DDA crosses at most one cell wall per axis per step, so a ray through an
 * N-cube visits at most 3N cells — 192 at the atlases' N = 64. 512 is that
 * bound with room, and is render3d's own MAX_STEPS * 2.
 */
const VOXEL_MAX_STEPS = 512

export function volumeFragmentGLSL() {
  return `#version 300 es
precision highp float;

#define MAX_STEPS ${MAX_STEPS}
#define BISECTION_STEPS ${BISECTION_STEPS}
#define VOXEL_MAX_STEPS ${VOXEL_MAX_STEPS}
// u_mode: 0 is the smooth isosurface, 1 the voxel DDA.
#define MODE_VOXEL 1

uniform mat4 u_modelMatrix;
uniform mat4 u_invModelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;
uniform mat4 u_normalMatrix;
uniform vec3 u_cameraPos;

uniform sampler2D u_volumeAtlas;
uniform int u_volumeSize;
uniform float u_threshold;
uniform int u_mode;

uniform vec4 u_baseColor;
uniform int u_hasMaterial;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_emissionStrength;

uniform vec4 u_clipPlane;
uniform int u_clipEnabled;

in vec3 v_worldPos;
in vec3 v_worldNormal;
in vec2 v_texCoord;

layout(location = 0) out vec4 gAlbedoMetallic;
layout(location = 1) out vec4 gNormalRoughness;
layout(location = 2) out vec4 gPositionEmission;
layout(location = 3) out float gDepth;

// The atlas is a 2D texture emulating a 3D one: volumeSize slices of
// volumeSize x volumeSize, stacked down the Y axis.
ivec2 atlasTexel(ivec3 p) {
  return ivec2(p.x, p.y + p.z * u_volumeSize);
}

// Trilinear by hand across the eight corners — a 2D atlas cannot filter across
// a slice boundary, so hardware filtering would blend neighbouring Z slices.
vec4 sampleVolume(vec3 p) {
  float volSizeF = float(u_volumeSize);
  vec3 uvw = clamp(p * 0.5 + 0.5, 0.0, 1.0);
  vec3 texelPos = uvw * (volSizeF - 1.0);
  vec3 texelFloor = floor(texelPos);
  vec3 f = texelPos - texelFloor;

  ivec3 i0 = ivec3(texelFloor);
  ivec3 i1 = min(i0 + 1, u_volumeSize - 1);

  vec4 c000 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i0.x, i0.y, i0.z)), 0);
  vec4 c100 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i1.x, i0.y, i0.z)), 0);
  vec4 c010 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i0.x, i1.y, i0.z)), 0);
  vec4 c110 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i1.x, i1.y, i0.z)), 0);
  vec4 c001 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i0.x, i0.y, i1.z)), 0);
  vec4 c101 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i1.x, i0.y, i1.z)), 0);
  vec4 c011 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i0.x, i1.y, i1.z)), 0);
  vec4 c111 = texelFetch(u_volumeAtlas, atlasTexel(ivec3(i1.x, i1.y, i1.z)), 0);

  vec4 c00 = mix(c000, c100, f.x);
  vec4 c10 = mix(c010, c110, f.x);
  vec4 c01 = mix(c001, c101, f.x);
  vec4 c11 = mix(c011, c111, f.x);

  vec4 c0 = mix(c00, c10, f.y);
  vec4 c1 = mix(c01, c11, f.y);

  return mix(c0, c1, f.z);
}

// Signed field: negative inside the solid, so a sign change between two steps
// brackets the isosurface.
float getField(vec3 p) {
  return u_threshold - sampleVolume(p).r;
}

vec3 calcNormal(vec3 p) {
  float eps = 2.0 / float(u_volumeSize);
  float dx = getField(p + vec3(eps, 0.0, 0.0)) - getField(p - vec3(eps, 0.0, 0.0));
  float dy = getField(p + vec3(0.0, eps, 0.0)) - getField(p - vec3(0.0, eps, 0.0));
  float dz = getField(p + vec3(0.0, 0.0, eps)) - getField(p - vec3(0.0, 0.0, eps));
  vec3 n = vec3(dx, dy, dz);
  float len = length(n);
  if (len < 0.0001) return vec3(0.0, 1.0, 0.0);
  return n / len;
}

// Nearest-neighbour cell fetch. The voxel branch reads whole cells and must NOT
// go through sampleVolume(): trilinear filtering across cell centres is exactly
// the blockiness this mode exists to keep.
vec4 sampleVoxel(ivec3 cell) {
  return texelFetch(u_volumeAtlas, atlasTexel(clamp(cell, ivec3(0), ivec3(u_volumeSize - 1))), 0);
}

// render3d's voxel threshold semantics: a cell is solid when its density
// EXCEEDS the threshold. The same sense as the smooth branch's signed field
// (threshold - density < 0 inside), read as a hard per-cell predicate rather
// than an interpolated crossing.
bool isCellSolid(ivec3 cell) {
  return sampleVoxel(cell).r > u_threshold;
}

struct VoxelHit {
  bool hit;
  float t;
  vec3 normal;
  ivec3 cell;
};

// 3D-DDA (Amanatides & Woo) over the atlas grid, in the local [-1,1] box.
//
// The grid is u_volumeSize cells per axis, so cell c spans
// [-1 + 2c/N, -1 + 2(c+1)/N] and the wall the ray crosses next on an axis is
// the one at index c + (step > 0 ? 1 : 0).
//
// render3d derives that wall with voxelToWorld(), which returns a cell CENTRE —
// half a cell past the wall on every axis. In a shader that only shades and
// writes dist/MAX_DIST the bias is invisible; here the hit point becomes the
// G-buffer's world position and the fragment's depth, so the wall is taken from
// the boundary directly.
//
// tmin/tEnter/tExit come from the caller's slab test: the two modes intersect
// the same box, so it is done once.
VoxelHit voxelTrace(vec3 ro, vec3 rd, vec3 invRd, vec3 tmin, float tEnter, float tExit) {
  VoxelHit result;
  result.hit = false;
  result.t = 0.0;
  result.normal = vec3(0.0);
  result.cell = ivec3(0);

  float n = float(u_volumeSize);
  // Nudged strictly inside: an entry landing exactly on a wall floors into the
  // cell behind the ray, which is outside the box.
  float t = max(tEnter + 1e-3, 0.0);
  ivec3 cell = clamp(ivec3(floor(((ro + rd * t) * 0.5 + 0.5) * n)), ivec3(0), ivec3(u_volumeSize - 1));

  ivec3 step = ivec3(sign(rd));
  vec3 wall = vec3(cell + max(step, ivec3(0))) / n * 2.0 - 1.0;
  vec3 tMax = (wall - ro) * invRd;
  vec3 tDelta = abs(2.0 / n * invRd);

  // The first cell was entered through a box face, not through a wall the walk
  // crossed: it is the slab whose tmin won tEnter, facing back along the ray.
  vec3 normal = vec3(0.0, 0.0, -sign(rd.z));
  if (tmin.x > tmin.y && tmin.x > tmin.z) normal = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tmin.y > tmin.z) normal = vec3(0.0, -sign(rd.y), 0.0);

  for (int i = 0; i < VOXEL_MAX_STEPS; i++) {
    if (isCellSolid(cell)) {
      result.hit = true;
      result.t = t;
      result.normal = normal;
      result.cell = cell;
      return result;
    }
    // Cross the nearest wall. t becomes the distance at which the NEW cell is
    // entered, and the normal is that wall's own face — the axis just stepped,
    // pointing back along the step.
    if (tMax.x < tMax.y && tMax.x < tMax.z) {
      t = tMax.x;
      tMax.x += tDelta.x;
      cell.x += step.x;
      normal = vec3(-float(step.x), 0.0, 0.0);
    } else if (tMax.y < tMax.z) {
      t = tMax.y;
      tMax.y += tDelta.y;
      cell.y += step.y;
      normal = vec3(0.0, -float(step.y), 0.0);
    } else {
      t = tMax.z;
      tMax.z += tDelta.z;
      cell.z += step.z;
      normal = vec3(0.0, 0.0, -float(step.z));
    }
    if (t > tExit) break;
    if (cell.x < 0 || cell.y < 0 || cell.z < 0 ||
        cell.x >= u_volumeSize || cell.y >= u_volumeSize || cell.z >= u_volumeSize) break;
  }
  return result;
}

void main() {
  vec3 rdWorld = normalize(v_worldPos - u_cameraPos);
  vec3 ro = (u_invModelMatrix * vec4(u_cameraPos, 1.0)).xyz;
  vec3 rd = normalize((u_invModelMatrix * vec4(rdWorld, 0.0)).xyz);

  // Slab test against the local [-1,1] box.
  vec3 invRd = 1.0 / rd;
  vec3 t0 = (-1.0 - ro) * invRd;
  vec3 t1 = (1.0 - ro) * invRd;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tEnter = max(max(tmin.x, tmin.y), tmin.z);
  float tExit = min(min(tmax.x, tmax.y), tmax.z);
  if (tEnter > tExit || tExit < 0.0) discard;

  // Clamping to 0 is what makes the camera-inside-the-box case work.
  float tStart = max(tEnter, 0.0);

  bool hit = false;
  float tHit = tStart;
  // The local-space normal both branches produce. The voxel branch fills it
  // with the entered cell's face; the smooth branch leaves it and takes its
  // gradient below, after the clip test.
  vec3 nLocal = vec3(0.0);
  ivec3 cell = ivec3(0);

  if (u_mode == MODE_VOXEL) {
    VoxelHit v = voxelTrace(ro, rd, invRd, tmin, tEnter, tExit);
    hit = v.hit;
    tHit = v.t;
    nLocal = v.normal;
    cell = v.cell;
  } else {
    float stepSize = 1.5 / float(u_volumeSize);
    float prevField = getField(ro + rd * tStart);
    if (prevField < 0.0) {
      // The ray enters already inside the solid: the bounding box face is the
      // surface. Matches render3d's isosurfaceTrace.
      hit = true;
    } else {
      float t = tStart;
      for (int i = 0; i < MAX_STEPS; i++) {
        t += stepSize;
        if (t > tExit) break;
        float field = getField(ro + rd * t);
        if (prevField * field < 0.0) {
          float tLo = t - stepSize;
          float tHi = t;
          for (int j = 0; j < BISECTION_STEPS; j++) {
            float tMid = (tLo + tHi) * 0.5;
            float fMid = getField(ro + rd * tMid);
            if (prevField * fMid < 0.0) {
              tHi = tMid;
            } else {
              tLo = tMid;
              prevField = fMid;
            }
          }
          hit = true;
          tHit = (tLo + tHi) * 0.5;
          break;
        }
        prevField = field;
      }
    }
  }

  if (!hit) discard;

  vec3 pLocal = ro + rd * tHit;
  vec4 worldHit = u_modelMatrix * vec4(pLocal, 1.0);

  // The planar reflection renders from a mirrored camera and must not publish
  // anything behind the reflector's plane. The mesh pass applies the same test
  // to its own interpolated surface point; the marcher's surface point is the
  // ray HIT, not the rasterized bounding-box face, so testing v_worldPos would
  // clip the scaffolding and leave the isosurface unclipped. Before calcNormal
  // because a clipped fragment needs none of its six field samples.
  if (u_clipEnabled == 1 && dot(vec4(worldHit.xyz, 1.0), u_clipPlane) < 0.0001) discard;

  // The smooth branch's gradient is taken here, not above, so a clipped
  // fragment costs none of its six field samples. The voxel branch already
  // carries its face normal.
  if (u_mode != MODE_VOXEL) nLocal = calcNormal(pLocal);
  // u_normalMatrix is transpose(inverse(model)) — the transform that preserves
  // perpendicularity, and the one the mesh vertex shader carries its own local
  // normals with. It is what a face normal needs too: under a sheared world
  // matrix (a volume inside a non-uniformly scaled, rotated group) the model
  // matrix would tilt the face normal off its own face.
  vec3 normal = normalize((u_normalMatrix * vec4(nLocal, 0.0)).xyz);

  vec3 albedo = u_baseColor.rgb;
  if (u_hasMaterial == 0) {
    // No material(): keep the legacy marchers' look — the atlas RGB, or a
    // neutral grey when the volume is monochrome and carries no colour. Voxel
    // mode reads the hit CELL, not an interpolated point.
    //
    // render3d's shadeVoxel additionally darkens the grey per face. That is
    // shading, which the deferred lighting pass now owns, so it has no place in
    // an albedo channel.
    vec3 volColor = sampleVoxel(cell).rgb;
    if (u_mode != MODE_VOXEL) volColor = sampleVolume(pLocal).rgb;
    albedo = length(volColor - vec3(volColor.r)) < 0.01 ? vec3(0.75) : volColor;
  }

  vec4 clip = u_projectionMatrix * u_viewMatrix * worldHit;
  // The near-plane test, in clip space. The projection matrix is GL-convention
  // in both languages, so the near plane is z == -w and a hit in FRONT of it
  // has z < -w. Such a hit has no window-space depth: clamping it would pin it
  // to the front of the depth range and let a volume body enclosing the camera
  // occlude the entire scene, where a same-extent mesh is near-clipped away by
  // the rasterizer. w <= 0 covers the hit landing at or behind the eye, whose
  // z/w is a division by zero and would put a NaN into frag depth.
  if (clip.w <= 0.0 || clip.z < -clip.w) discard;
  float depth = clamp(clip.z / clip.w * 0.5 + 0.5, 1e-6, 1.0);

  gAlbedoMetallic = vec4(albedo, u_metallic);
  gNormalRoughness = vec4(normal * 0.5 + 0.5, u_roughness);
  gPositionEmission = vec4(worldHit.xyz, u_emissionStrength);
  gDepth = depth;
  gl_FragDepth = depth;
}
`
}

export function volumeFragmentWGSL() {
  return `const MAX_STEPS: i32 = ${MAX_STEPS};
const BISECTION_STEPS: i32 = ${BISECTION_STEPS};
const VOXEL_MAX_STEPS: i32 = ${VOXEL_MAX_STEPS};
// u_mode: 0 is the smooth isosurface, 1 the voxel DDA.
const MODE_VOXEL: i32 = 1;

struct VolumeUniforms {
  u_modelMatrix: mat4x4f,
  u_invModelMatrix: mat4x4f,
  u_viewMatrix: mat4x4f,
  u_projectionMatrix: mat4x4f,
  u_normalMatrix: mat4x4f,
  u_baseColor: vec4f,
  u_clipPlane: vec4f,
  u_cameraPos: vec3f,
  u_threshold: f32,
  u_volumeSize: i32,
  u_hasMaterial: i32,
  u_metallic: f32,
  u_roughness: f32,
  u_emissionStrength: f32,
  u_clipEnabled: i32,
  u_mode: i32,
}

// Bindings 0-3 belong to the vertex stage (the mesh vertex shader's transform
// uniforms and geometry textures). WebGPU merges both stages into one @group(0)
// layout, so the fragment stage starts at 4. The atlas is read with
// textureLoad, which takes no sampler — declaring one would leave an unused
// binding the 'auto' pipeline layout then refuses an entry for.
@group(0) @binding(4) var<uniform> u: VolumeUniforms;
@group(0) @binding(5) var u_volumeAtlas: texture_2d<f32>;

struct FragmentInput {
  @location(0) v_worldPos: vec3f,
  @location(1) v_worldNormal: vec3f,
  @location(2) v_texCoord: vec2f,
}

struct GBufferOutput {
  @location(0) albedoMetallic: vec4f,
  @location(1) normalRoughness: vec4f,
  @location(2) positionEmission: vec4f,
  @location(3) depth: f32,
  @builtin(frag_depth) fragDepth: f32,
}

// The atlas is a 2D texture emulating a 3D one: volumeSize slices of
// volumeSize x volumeSize, stacked down the Y axis.
fn atlasTexel(p: vec3i) -> vec2i {
  return vec2i(p.x, p.y + p.z * u.u_volumeSize);
}

// Trilinear by hand across the eight corners — a 2D atlas cannot filter across
// a slice boundary, so hardware filtering would blend neighbouring Z slices.
fn sampleVolume(p: vec3f) -> vec4f {
  let volSizeF = f32(u.u_volumeSize);
  let uvw = clamp(p * 0.5 + 0.5, vec3f(0.0), vec3f(1.0));
  let texelPos = uvw * (volSizeF - 1.0);
  let texelFloor = floor(texelPos);
  let f = texelPos - texelFloor;

  let i0 = vec3i(texelFloor);
  let i1 = min(i0 + 1, vec3i(u.u_volumeSize - 1));

  let c000 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i0.x, i0.y, i0.z)), 0);
  let c100 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i1.x, i0.y, i0.z)), 0);
  let c010 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i0.x, i1.y, i0.z)), 0);
  let c110 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i1.x, i1.y, i0.z)), 0);
  let c001 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i0.x, i0.y, i1.z)), 0);
  let c101 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i1.x, i0.y, i1.z)), 0);
  let c011 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i0.x, i1.y, i1.z)), 0);
  let c111 = textureLoad(u_volumeAtlas, atlasTexel(vec3i(i1.x, i1.y, i1.z)), 0);

  let c00 = mix(c000, c100, f.x);
  let c10 = mix(c010, c110, f.x);
  let c01 = mix(c001, c101, f.x);
  let c11 = mix(c011, c111, f.x);

  let c0 = mix(c00, c10, f.y);
  let c1 = mix(c01, c11, f.y);

  return mix(c0, c1, f.z);
}

// Signed field: negative inside the solid, so a sign change between two steps
// brackets the isosurface.
fn getField(p: vec3f) -> f32 {
  return u.u_threshold - sampleVolume(p).r;
}

fn calcNormal(p: vec3f) -> vec3f {
  let eps = 2.0 / f32(u.u_volumeSize);
  let dx = getField(p + vec3f(eps, 0.0, 0.0)) - getField(p - vec3f(eps, 0.0, 0.0));
  let dy = getField(p + vec3f(0.0, eps, 0.0)) - getField(p - vec3f(0.0, eps, 0.0));
  let dz = getField(p + vec3f(0.0, 0.0, eps)) - getField(p - vec3f(0.0, 0.0, eps));
  let n = vec3f(dx, dy, dz);
  let len = length(n);
  if (len < 0.0001) {
    return vec3f(0.0, 1.0, 0.0);
  }
  return n / len;
}

// Nearest-neighbour cell fetch. The voxel branch reads whole cells and must NOT
// go through sampleVolume(): trilinear filtering across cell centres is exactly
// the blockiness this mode exists to keep.
fn sampleVoxel(cell: vec3i) -> vec4f {
  return textureLoad(u_volumeAtlas, atlasTexel(clamp(cell, vec3i(0), vec3i(u.u_volumeSize - 1))), 0);
}

// render3d's voxel threshold semantics: a cell is solid when its density
// EXCEEDS the threshold. The same sense as the smooth branch's signed field
// (threshold - density < 0 inside), read as a hard per-cell predicate rather
// than an interpolated crossing.
fn isCellSolid(cell: vec3i) -> bool {
  return sampleVoxel(cell).r > u.u_threshold;
}

struct VoxelHit {
  hit: bool,
  t: f32,
  normal: vec3f,
  cell: vec3i,
}

// 3D-DDA (Amanatides & Woo) over the atlas grid, in the local [-1,1] box.
//
// The grid is u_volumeSize cells per axis, so cell c spans
// [-1 + 2c/N, -1 + 2(c+1)/N] and the wall the ray crosses next on an axis is
// the one at index c + (step > 0 ? 1 : 0).
//
// render3d derives that wall with voxelToWorld(), which returns a cell CENTRE —
// half a cell past the wall on every axis. In a shader that only shades and
// writes dist/MAX_DIST the bias is invisible; here the hit point becomes the
// G-buffer's world position and the fragment's depth, so the wall is taken from
// the boundary directly.
//
// tmin/tEnter/tExit come from the caller's slab test: the two modes intersect
// the same box, so it is done once.
fn voxelTrace(ro: vec3f, rd: vec3f, invRd: vec3f, tmin: vec3f, tEnter: f32, tExit: f32) -> VoxelHit {
  var result: VoxelHit;
  result.hit = false;
  result.t = 0.0;
  result.normal = vec3f(0.0);
  result.cell = vec3i(0);

  let n = f32(u.u_volumeSize);
  // Nudged strictly inside: an entry landing exactly on a wall floors into the
  // cell behind the ray, which is outside the box.
  var t = max(tEnter + 1e-3, 0.0);
  var cell = clamp(vec3i(floor(((ro + rd * t) * 0.5 + 0.5) * n)), vec3i(0), vec3i(u.u_volumeSize - 1));

  let step = vec3i(sign(rd));
  let wall = vec3f(cell + max(step, vec3i(0))) / n * 2.0 - 1.0;
  var tMax = (wall - ro) * invRd;
  let tDelta = abs(2.0 / n * invRd);

  // The first cell was entered through a box face, not through a wall the walk
  // crossed: it is the slab whose tmin won tEnter, facing back along the ray.
  var normal = vec3f(0.0, 0.0, -sign(rd.z));
  if (tmin.x > tmin.y && tmin.x > tmin.z) {
    normal = vec3f(-sign(rd.x), 0.0, 0.0);
  } else if (tmin.y > tmin.z) {
    normal = vec3f(0.0, -sign(rd.y), 0.0);
  }

  for (var i = 0; i < VOXEL_MAX_STEPS; i = i + 1) {
    if (isCellSolid(cell)) {
      result.hit = true;
      result.t = t;
      result.normal = normal;
      result.cell = cell;
      return result;
    }
    // Cross the nearest wall. t becomes the distance at which the NEW cell is
    // entered, and the normal is that wall's own face — the axis just stepped,
    // pointing back along the step.
    if (tMax.x < tMax.y && tMax.x < tMax.z) {
      t = tMax.x;
      tMax.x = tMax.x + tDelta.x;
      cell.x = cell.x + step.x;
      normal = vec3f(-f32(step.x), 0.0, 0.0);
    } else if (tMax.y < tMax.z) {
      t = tMax.y;
      tMax.y = tMax.y + tDelta.y;
      cell.y = cell.y + step.y;
      normal = vec3f(0.0, -f32(step.y), 0.0);
    } else {
      t = tMax.z;
      tMax.z = tMax.z + tDelta.z;
      cell.z = cell.z + step.z;
      normal = vec3f(0.0, 0.0, -f32(step.z));
    }
    if (t > tExit) { break; }
    if (cell.x < 0 || cell.y < 0 || cell.z < 0 ||
        cell.x >= u.u_volumeSize || cell.y >= u.u_volumeSize || cell.z >= u.u_volumeSize) { break; }
  }
  return result;
}

@fragment
fn fs_main(input: FragmentInput) -> GBufferOutput {
  // WGSL zero-initializes a var without an initializer, so the discard paths
  // below still return a well-formed (and ignored) value.
  var output: GBufferOutput;

  let rdWorld = normalize(input.v_worldPos - u.u_cameraPos);
  let ro = (u.u_invModelMatrix * vec4f(u.u_cameraPos, 1.0)).xyz;
  let rd = normalize((u.u_invModelMatrix * vec4f(rdWorld, 0.0)).xyz);

  // Slab test against the local [-1,1] box.
  let invRd = 1.0 / rd;
  let t0 = (-1.0 - ro) * invRd;
  let t1 = (1.0 - ro) * invRd;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tEnter = max(max(tmin.x, tmin.y), tmin.z);
  let tExit = min(min(tmax.x, tmax.y), tmax.z);
  if (tEnter > tExit || tExit < 0.0) {
    discard;
    return output;
  }

  // Clamping to 0 is what makes the camera-inside-the-box case work.
  let tStart = max(tEnter, 0.0);

  var hit = false;
  var tHit = tStart;
  // The local-space normal both branches produce. The voxel branch fills it
  // with the entered cell's face; the smooth branch leaves it and takes its
  // gradient below, after the clip test.
  var nLocal = vec3f(0.0);
  var cell = vec3i(0);

  if (u.u_mode == MODE_VOXEL) {
    let v = voxelTrace(ro, rd, invRd, tmin, tEnter, tExit);
    hit = v.hit;
    tHit = v.t;
    nLocal = v.normal;
    cell = v.cell;
  } else {
    let stepSize = 1.5 / f32(u.u_volumeSize);
    var prevField = getField(ro + rd * tStart);
    if (prevField < 0.0) {
      // The ray enters already inside the solid: the bounding box face is the
      // surface. Matches render3d's isosurfaceTrace.
      hit = true;
    } else {
      var t = tStart;
      for (var i = 0; i < MAX_STEPS; i = i + 1) {
        t = t + stepSize;
        if (t > tExit) { break; }
        let field = getField(ro + rd * t);
        if (prevField * field < 0.0) {
          var tLo = t - stepSize;
          var tHi = t;
          for (var j = 0; j < BISECTION_STEPS; j = j + 1) {
            let tMid = (tLo + tHi) * 0.5;
            let fMid = getField(ro + rd * tMid);
            if (prevField * fMid < 0.0) {
              tHi = tMid;
            } else {
              tLo = tMid;
              prevField = fMid;
            }
          }
          hit = true;
          tHit = (tLo + tHi) * 0.5;
          break;
        }
        prevField = field;
      }
    }
  }

  if (!hit) {
    discard;
    return output;
  }

  let pLocal = ro + rd * tHit;
  let worldHit = u.u_modelMatrix * vec4f(pLocal, 1.0);

  // The planar reflection renders from a mirrored camera and must not publish
  // anything behind the reflector's plane. The mesh pass applies the same test
  // to its own interpolated surface point; the marcher's surface point is the
  // ray HIT, not the rasterized bounding-box face, so testing v_worldPos would
  // clip the scaffolding and leave the isosurface unclipped. Before calcNormal
  // because a clipped fragment needs none of its six field samples.
  if (u.u_clipEnabled == 1 && dot(vec4f(worldHit.xyz, 1.0), u.u_clipPlane) < 0.0001) {
    discard;
    return output;
  }

  // The smooth branch's gradient is taken here, not above, so a clipped
  // fragment costs none of its six field samples. The voxel branch already
  // carries its face normal.
  if (u.u_mode != MODE_VOXEL) {
    nLocal = calcNormal(pLocal);
  }
  // u_normalMatrix is transpose(inverse(model)) — the transform that preserves
  // perpendicularity, and the one the mesh vertex shader carries its own local
  // normals with. It is what a face normal needs too: under a sheared world
  // matrix (a volume inside a non-uniformly scaled, rotated group) the model
  // matrix would tilt the face normal off its own face.
  let normal = normalize((u.u_normalMatrix * vec4f(nLocal, 0.0)).xyz);

  var albedo = u.u_baseColor.rgb;
  if (u.u_hasMaterial == 0) {
    // No material(): keep the legacy marchers' look — the atlas RGB, or a
    // neutral grey when the volume is monochrome and carries no colour. Voxel
    // mode reads the hit CELL, not an interpolated point.
    //
    // render3d's shadeVoxel additionally darkens the grey per face. That is
    // shading, which the deferred lighting pass now owns, so it has no place in
    // an albedo channel.
    var volColor = sampleVoxel(cell).rgb;
    if (u.u_mode != MODE_VOXEL) {
      volColor = sampleVolume(pLocal).rgb;
    }
    if (length(volColor - vec3f(volColor.r)) < 0.01) {
      albedo = vec3f(0.75);
    } else {
      albedo = volColor;
    }
  }

  let clip = u.u_projectionMatrix * u.u_viewMatrix * worldHit;
  // The near-plane test, in clip space. The projection matrix is GL-convention
  // in both languages (the mesh vertex stage remaps z to [0,w] only AFTER its
  // own projection), so the near plane is z == -w and a hit in FRONT of it has
  // z < -w. Such a hit has no window-space depth: clamping it would pin it to
  // the front of the depth range and let a volume body enclosing the camera
  // occlude the entire scene, where a same-extent mesh is near-clipped away by
  // the rasterizer. w <= 0 covers the hit landing at or behind the eye, whose
  // z/w is a division by zero and would put a NaN into frag depth.
  if (clip.w <= 0.0 || clip.z < -clip.w) {
    discard;
    return output;
  }
  let depth = clamp(clip.z / clip.w * 0.5 + 0.5, 1e-6, 1.0);

  output.albedoMetallic = vec4f(albedo, u.u_metallic);
  output.normalRoughness = vec4f(normal * 0.5 + 0.5, u.u_roughness);
  output.positionEmission = vec4f(worldHit.xyz, u.u_emissionStrength);
  output.depth = depth;
  output.fragDepth = depth;
  return output;
}
`
}
