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
 */

/** Marcher constants, matching render3d so the same iso level resolves alike. */
const MAX_STEPS = 256
const BISECTION_STEPS = 8

export function volumeFragmentGLSL() {
  return `#version 300 es
precision highp float;

#define MAX_STEPS ${MAX_STEPS}
#define BISECTION_STEPS ${BISECTION_STEPS}

uniform mat4 u_modelMatrix;
uniform mat4 u_invModelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;
uniform mat4 u_normalMatrix;
uniform vec3 u_cameraPos;

uniform sampler2D u_volumeAtlas;
uniform int u_volumeSize;
uniform float u_threshold;

uniform vec4 u_baseColor;
uniform int u_hasMaterial;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_emissionStrength;

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
  float stepSize = 1.5 / float(u_volumeSize);

  bool hit = false;
  float tHit = tStart;
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

  if (!hit) discard;

  vec3 pLocal = ro + rd * tHit;
  vec4 worldHit = u_modelMatrix * vec4(pLocal, 1.0);
  vec3 normal = normalize((u_normalMatrix * vec4(calcNormal(pLocal), 0.0)).xyz);

  vec3 albedo = u_baseColor.rgb;
  if (u_hasMaterial == 0) {
    // No material(): keep the legacy marchers' look — the atlas RGB, or a
    // neutral grey when the volume is monochrome and carries no colour.
    vec3 volColor = sampleVolume(pLocal).rgb;
    albedo = length(volColor - vec3(volColor.r)) < 0.01 ? vec3(0.75) : volColor;
  }

  vec4 clip = u_projectionMatrix * u_viewMatrix * worldHit;
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

struct VolumeUniforms {
  u_modelMatrix: mat4x4f,
  u_invModelMatrix: mat4x4f,
  u_viewMatrix: mat4x4f,
  u_projectionMatrix: mat4x4f,
  u_normalMatrix: mat4x4f,
  u_baseColor: vec4f,
  u_cameraPos: vec3f,
  u_threshold: f32,
  u_volumeSize: i32,
  u_hasMaterial: i32,
  u_metallic: f32,
  u_roughness: f32,
  u_emissionStrength: f32,
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
  let stepSize = 1.5 / f32(u.u_volumeSize);

  var hit = false;
  var tHit = tStart;
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

  if (!hit) {
    discard;
    return output;
  }

  let pLocal = ro + rd * tHit;
  let worldHit = u.u_modelMatrix * vec4f(pLocal, 1.0);
  let normal = normalize((u.u_normalMatrix * vec4f(calcNormal(pLocal), 0.0)).xyz);

  var albedo = u.u_baseColor.rgb;
  if (u.u_hasMaterial == 0) {
    // No material(): keep the legacy marchers' look — the atlas RGB, or a
    // neutral grey when the volume is monochrome and carries no colour.
    let volColor = sampleVolume(pLocal).rgb;
    if (length(volColor - vec3f(volColor.r)) < 0.01) {
      albedo = vec3f(0.75);
    } else {
      albedo = volColor;
    }
  }

  let clip = u.u_projectionMatrix * u.u_viewMatrix * worldHit;
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
