/**
 * G-buffer configuration and deferred lighting shader generation.
 *
 * GBufferConfig manages the G-buffer layout and generates shader source code
 * (GLSL 300 es and WGSL) for the deferred rendering pipeline. It does NOT
 * interact with the GPU directly — it produces configuration objects and
 * shader strings that the backend-specific code will consume.
 *
 * G-Buffer Layout:
 *   RT0  RGBA16F  albedo.rgb, metallic
 *   RT1  RGBA16F  normal.xyz (world space, encoded to [0,1]), roughness
 *   RT2  RGBA16F  position.xyz (world space), emission intensity
 *   RT3  R32F     depth
 */

export class GBufferConfig {
  /**
   * @param {number} width  - framebuffer width in pixels
   * @param {number} height - framebuffer height in pixels
   */
  constructor(width, height) {
    this.width = width
    this.height = height
    this.targets = [
      { name: 'albedoMetallic', format: 'rgba16float' },
      { name: 'normalRoughness', format: 'rgba16float' },
      { name: 'positionEmission', format: 'rgba16float' },
      { name: 'depth', format: 'r32float' }
    ]
  }

  /**
   * Update the G-buffer resolution.
   * @param {number} w - new width
   * @param {number} h - new height
   */
  resize(w, h) {
    this.width = w
    this.height = h
  }

  /**
   * Return the mesh vertex shader source for the geometry pass.
   * @param {'glsl'|'wgsl'} backend
   * @returns {string}
   */
  getMeshVertexShader(backend) {
    if (backend === 'wgsl') return meshVertexWGSL()
    return meshVertexGLSL()
  }

  /**
   * Return the mesh fragment shader source that writes to G-buffer MRT.
   * @param {'glsl'|'wgsl'} backend
   * @returns {string}
   */
  getMeshFragmentShader(backend) {
    if (backend === 'wgsl') return meshFragmentWGSL()
    return meshFragmentGLSL()
  }

  /**
   * Return the deferred lighting fullscreen-quad fragment shader.
   * @param {'glsl'|'wgsl'} backend
   * @param {number} numLights - number of point lights to unroll
   * @returns {string}
   */
  getDeferredLightingShader(backend, numLights) {
    if (backend === 'wgsl') return deferredLightingWGSL(numLights)
    return deferredLightingGLSL(numLights)
  }

  /**
   * Return the SSAO fullscreen fragment shader.
   * @param {'glsl'|'wgsl'} backend
   * @returns {string}
   */
  getSSAOShader(backend) {
    if (backend === 'wgsl') return ssaoWGSL()
    return ssaoGLSL()
  }

  /**
   * Return the screen-space reflection fullscreen fragment shader.
   * @param {'glsl'|'wgsl'} backend
   * @returns {string}
   */
  getSSRShader(backend) {
    if (backend === 'wgsl') return ssrWGSL()
    return ssrGLSL()
  }
}

// 12 hemisphere kernel samples (z up), lengths 0.3–1.0, shared verbatim by
// both shader languages so the backends occlude identically.
const SSAO_KERNEL = [
  [0.2024, 0.1417, 0.1932], [-0.0918, 0.2528, 0.1932], [-0.2755, -0.0654, 0.2100],
  [0.0917, -0.3170, 0.2377], [0.3677, 0.1997, 0.3134], [-0.4522, 0.2766, 0.2245],
  [-0.2600, -0.5297, 0.2705], [0.5763, -0.3179, 0.3488], [0.6119, 0.4682, 0.4218],
  [-0.7815, 0.1483, 0.3467], [-0.3624, 0.7847, 0.4212], [0.2569, -0.8093, 0.5252]
]

const SSAO_KERNEL_GLSL = SSAO_KERNEL.map(v => `vec3(${v.join(', ')})`).join(',\n  ')
const SSAO_KERNEL_WGSL = SSAO_KERNEL.map(v => `vec3f(${v.join(', ')})`).join(',\n  ')

// ---------------------------------------------------------------------------
// GLSL shaders
// ---------------------------------------------------------------------------

function meshVertexGLSL() {
  return `#version 300 es
precision highp float;

uniform mat4 u_modelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;
uniform mat4 u_normalMatrix;

uniform sampler2D u_positions;
uniform sampler2D u_normals;
uniform sampler2D u_uvs;
uniform int u_meshTexWidth;

out vec3 v_worldPos;
out vec3 v_worldNormal;
out vec2 v_texCoord;

void main() {
  int x = gl_VertexID % u_meshTexWidth;
  int y = gl_VertexID / u_meshTexWidth;
  ivec2 texCoord = ivec2(x, y);

  vec3 position = texelFetch(u_positions, texCoord, 0).xyz;
  vec3 normal = texelFetch(u_normals, texCoord, 0).xyz;
  vec2 uv = texelFetch(u_uvs, texCoord, 0).xy;

  vec4 worldPos = u_modelMatrix * vec4(position, 1.0);
  v_worldPos = worldPos.xyz;
  v_worldNormal = normalize((u_normalMatrix * vec4(normal, 0.0)).xyz);
  v_texCoord = uv;
  gl_Position = u_projectionMatrix * u_viewMatrix * worldPos;
}
`
}

function meshFragmentGLSL() {
  return `#version 300 es
precision highp float;

uniform vec4 u_baseColor;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_emissionStrength;
uniform vec2 u_uvScale;
uniform vec2 u_uvOffset;
uniform sampler2D u_albedoTexture;
uniform int u_hasAlbedoTexture;
uniform vec4 u_clipPlane;
uniform int u_clipEnabled;

in vec3 v_worldPos;
in vec3 v_worldNormal;
in vec2 v_texCoord;

layout(location = 0) out vec4 gAlbedoMetallic;
layout(location = 1) out vec4 gNormalRoughness;
layout(location = 2) out vec4 gPositionEmission;
layout(location = 3) out float gDepth;

void main() {
  if (u_clipEnabled == 1 && dot(vec4(v_worldPos, 1.0), u_clipPlane) < 0.0001) {
    discard;
  }

  vec3 albedo = u_baseColor.rgb;
  if (u_hasAlbedoTexture == 1) {
    vec2 sampleUV = fract(v_texCoord * u_uvScale + u_uvOffset);
    albedo *= texture(u_albedoTexture, sampleUV).rgb;
  }

  vec3 normal = normalize(v_worldNormal);

  gAlbedoMetallic = vec4(albedo, u_metallic);
  gNormalRoughness = vec4(normal * 0.5 + 0.5, u_roughness);
  gPositionEmission = vec4(v_worldPos, u_emissionStrength);
  gDepth = gl_FragCoord.z;
}
`
}

function deferredLightingGLSL(numLights) {
  return `#version 300 es
precision highp float;

#define NUM_LIGHTS ${numLights}
#define PI 3.14159265359

uniform sampler2D u_albedoMetallic;
uniform sampler2D u_normalRoughness;
uniform sampler2D u_positionEmission;
uniform sampler2D u_depth;
uniform sampler2D u_ssao;
uniform sampler2D u_envTexture;
uniform samplerCube u_reflectionProbe;

uniform vec3 u_cameraPos;
uniform vec3 u_backgroundColor;
uniform vec3 u_skyColor;
uniform vec3 u_groundColor;
uniform float u_ssaoStrength;
uniform float u_envIntensity;
uniform float u_probeEnabled;
uniform float u_probeCapture;

// lightType: 0 = point, 1 = directional, 2 = spot
struct Light {
  vec3 position;
  vec3 color;
  float intensity;
  float lightType;
  vec3 direction;
  float cosInner;
  float cosOuter;
  float falloff;
};

uniform Light u_lights[NUM_LIGHTS];

in vec2 v_texCoord;

out vec4 fragColor;

// GGX / Trowbridge-Reitz normal distribution
float distributionGGX(vec3 N, vec3 H, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float NdotH2 = NdotH * NdotH;
  float denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

// Schlick-GGX geometry function (single direction)
float geometrySchlickGGX(float NdotV, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

// Smith's method — combines view and light directions
float geometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
  float NdotV = max(dot(N, V), 0.0);
  float NdotL = max(dot(N, L), 0.0);
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

// Fresnel-Schlick approximation
vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Equirectangular lookup for the DSL-surface environment
vec2 equirectUV(vec3 d) {
  return vec2(atan(d.z, d.x) / 6.2831853 + 0.5, acos(clamp(d.y, -1.0, 1.0)) / 3.14159265);
}

void environmentBasis(vec3 direction, out vec3 tangent, out vec3 bitangent) {
  vec3 up = abs(direction.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  tangent = normalize(cross(up, direction));
  bitangent = cross(direction, tangent);
}

vec3 sampleEnvironmentDiffuse(vec3 normal) {
  vec3 tangent;
  vec3 bitangent;
  environmentBasis(normal, tangent, bitangent);
  const float spread = 0.65;
  vec3 color = texture(u_envTexture, equirectUV(normal)).rgb * 2.0;
  color += texture(u_envTexture, equirectUV(normalize(normal + tangent * spread))).rgb;
  color += texture(u_envTexture, equirectUV(normalize(normal - tangent * spread))).rgb;
  color += texture(u_envTexture, equirectUV(normalize(normal + bitangent * spread))).rgb;
  color += texture(u_envTexture, equirectUV(normalize(normal - bitangent * spread))).rgb;
  return color / 6.0;
}

vec3 sampleEnvironmentSpecular(vec3 direction, float roughness) {
  vec3 tangent;
  vec3 bitangent;
  environmentBasis(direction, tangent, bitangent);
  float spread = roughness * roughness * 0.9;
  const int ENV_SPECULAR_SAMPLES = 24;
  const float GOLDEN_ANGLE = 2.39996323;
  vec3 color = vec3(0.0);
  for (int i = 0; i < ENV_SPECULAR_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float radius = sqrt(fi / float(ENV_SPECULAR_SAMPLES)) * spread;
    float angle = fi * GOLDEN_ANGLE;
    vec3 sampleDirection = normalize(
      direction
      + tangent * (cos(angle) * radius)
      + bitangent * (sin(angle) * radius)
    );
    color += texture(u_envTexture, equirectUV(sampleDirection)).rgb;
  }
  return color / float(ENV_SPECULAR_SAMPLES);
}

vec4 sampleReflectionProbe(vec3 direction, float roughness) {
  vec3 tangent;
  vec3 bitangent;
  environmentBasis(direction, tangent, bitangent);
  float spread = roughness * roughness * 0.9;
  const int PROBE_SPECULAR_SAMPLES = 24;
  const float GOLDEN_ANGLE = 2.39996323;
  vec4 color = vec4(0.0);
  for (int i = 0; i < PROBE_SPECULAR_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float radius = sqrt(fi / float(PROBE_SPECULAR_SAMPLES)) * spread;
    float angle = fi * GOLDEN_ANGLE;
    vec3 sampleDirection = normalize(
      direction
      + tangent * (cos(angle) * radius)
      + bitangent * (sin(angle) * radius)
    );
    color += texture(u_reflectionProbe, sampleDirection);
  }
  return color / float(PROBE_SPECULAR_SAMPLES);
}

void main() {
  // Sample G-buffer
  float depth = texture(u_depth, v_texCoord).r;
  if (depth <= 0.0) {
    fragColor = vec4(u_backgroundColor, u_probeCapture > 0.5 ? 0.0 : 1.0);
    return;
  }
  vec4 albedoMetallic = texture(u_albedoMetallic, v_texCoord);
  vec4 normalRoughness = texture(u_normalRoughness, v_texCoord);
  vec4 positionEmission = texture(u_positionEmission, v_texCoord);

  vec3 albedo = albedoMetallic.rgb;
  float metallic = clamp(albedoMetallic.a, 0.0, 1.0);
  vec3 normal = normalize(normalRoughness.rgb * 2.0 - 1.0);
  float roughness = clamp(normalRoughness.a, 0.045, 1.0);
  vec3 worldPos = positionEmission.rgb;
  float emission = positionEmission.a;

  vec3 V = normalize(u_cameraPos - worldPos);

  // Dielectric base reflectance; blend toward albedo for metals
  vec3 F0 = mix(vec3(0.04), albedo, metallic);

  vec3 Lo = vec3(0.0);

  for (int i = 0; i < NUM_LIGHTS; i++) {
    vec3 L;
    float attenuation;
    if (u_lights[i].lightType > 0.5 && u_lights[i].lightType < 1.5) {
      // Directional: no distance falloff
      L = normalize(-u_lights[i].direction);
      attenuation = u_lights[i].intensity;
    } else {
      // Point and spot: inverse-square falloff from a position
      L = normalize(u_lights[i].position - worldPos);
      float dist = length(u_lights[i].position - worldPos);
      attenuation = u_lights[i].intensity / (1.0 + max(u_lights[i].falloff, 0.0) * dist * dist);
      if (u_lights[i].lightType > 1.5) {
        // Spot: cone factor between outer and inner cosines
        float cosAngle = dot(normalize(worldPos - u_lights[i].position), normalize(u_lights[i].direction));
        attenuation *= smoothstep(u_lights[i].cosOuter, u_lights[i].cosInner, cosAngle);
      }
    }
    vec3 H = normalize(V + L);
    vec3 radiance = u_lights[i].color * attenuation;

    // Cook-Torrance BRDF
    float NDF = distributionGGX(normal, H, roughness);
    float G = geometrySmith(normal, V, L, roughness);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    vec3 numerator = NDF * G * F;
    float denominator = 4.0 * max(dot(normal, V), 0.0) * max(dot(normal, L), 0.0) + 0.0001;
    vec3 specular = numerator / denominator;

    vec3 kS = F;
    vec3 kD = (1.0 - kS) * (1.0 - metallic);

    float NdotL = max(dot(normal, L), 0.0);
    Lo += (kD * albedo / PI + specular) * radiance * NdotL;
  }

  // Ambient: a DSL-surface environment sampled at the normal when present,
  // else hemisphere sky/ground — either way occluded by SSAO.
  float ao = mix(1.0, texture(u_ssao, v_texCoord).r, u_ssaoStrength);
  vec3 ambientLight;
  if (u_envIntensity > 0.0) {
    ambientLight = sampleEnvironmentDiffuse(normal) * u_envIntensity;
  } else {
    ambientLight = mix(u_groundColor, u_skyColor, normal.y * 0.5 + 0.5);
  }
  vec3 ambientF = fresnelSchlick(max(dot(normal, V), 0.0), F0);
  vec3 ambientKD = (1.0 - ambientF) * (1.0 - metallic);
  vec3 ambient = ambientLight * albedo * ambientKD * ao;
  vec3 ambientSpecular = vec3(0.0);
  vec3 R = reflect(-V, normal);
  if (u_probeEnabled > 0.5) {
    vec4 probe = sampleReflectionProbe(R, roughness);
    vec3 probeFallback = u_backgroundColor;
    if (u_envIntensity > 0.0) {
      probeFallback = sampleEnvironmentSpecular(R, roughness) * u_envIntensity;
    }
    ambientSpecular = mix(probeFallback, probe.rgb, clamp(probe.a, 0.0, 1.0))
      * ambientF * ao;
  } else if (u_envIntensity > 0.0) {
    ambientSpecular = sampleEnvironmentSpecular(R, roughness)
      * u_envIntensity * ambientF * ao;
  }
  vec3 color = ambient + ambientSpecular + Lo + albedo * emission;

  fragColor = vec4(color, 1.0);
}
`
}

function ssaoGLSL() {
  return `#version 300 es
precision highp float;

uniform sampler2D u_normalRoughness;
uniform sampler2D u_positionEmission;
uniform sampler2D u_depth;

uniform mat4 u_viewProj;
uniform vec3 u_cameraPos;
uniform float u_radius;

in vec2 v_texCoord;
out vec4 fragColor;

const int KERNEL_SIZE = 12;
const vec3 KERNEL[12] = vec3[](
  ${SSAO_KERNEL_GLSL}
);

// Interleaved gradient noise — cheap per-pixel rotation angle
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  float centerDepth = texture(u_depth, v_texCoord).r;
  if (centerDepth <= 0.0) { fragColor = vec4(1.0); return; }

  vec3 P = texture(u_positionEmission, v_texCoord).rgb;
  vec3 N = normalize(texture(u_normalRoughness, v_texCoord).rgb * 2.0 - 1.0);

  // Tangent basis rotated per pixel
  float angle = ign(gl_FragCoord.xy) * 6.2831853;
  vec3 randVec = vec3(cos(angle), sin(angle), 0.0);
  vec3 T = normalize(randVec - N * dot(randVec, N));
  vec3 B = cross(N, T);

  float occlusion = 0.0;
  for (int i = 0; i < KERNEL_SIZE; i++) {
    vec3 k = KERNEL[i];
    vec3 samplePos = P + (T * k.x + B * k.y + N * k.z) * u_radius;

    vec4 clip = u_viewProj * vec4(samplePos, 1.0);
    if (clip.w <= 0.0) { continue; }
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { continue; }

    if (texture(u_depth, uv).r <= 0.0) { continue; } // sky
    vec3 gbufPos = texture(u_positionEmission, uv).rgb;
    float gbufDist = length(gbufPos - u_cameraPos);
    float sampleDist = length(samplePos - u_cameraPos);

    if (gbufDist < sampleDist - 0.02) {
      occlusion += smoothstep(0.0, 1.0, u_radius / max(abs(gbufDist - sampleDist), 0.0001));
    }
  }

  float ao = pow(1.0 - occlusion / float(KERNEL_SIZE), 1.5);
  fragColor = vec4(ao, ao, ao, 1.0);
}
`
}

function ssaoWGSL() {
  return `struct SSAOUniforms {
  u_viewProj: mat4x4f,
  u_cameraPos: vec3f,
  u_radius: f32,
}

@group(0) @binding(0) var u_normalRoughness: texture_2d<f32>;
@group(0) @binding(1) var u_positionEmission: texture_2d<f32>;
@group(0) @binding(2) var u_depth: texture_2d<f32>;
@group(0) @binding(3) var u_sampler: sampler;
@group(0) @binding(4) var<uniform> params: SSAOUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_texCoord: vec2f,
}

const KERNEL = array<vec3f, 12>(
  ${SSAO_KERNEL_WGSL}
);

fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // textureSampleLevel throughout: samples occur after non-uniform returns
  // and inside loops with continue, where implicit-derivative sampling is
  // invalid WGSL.
  let centerDepth = textureSampleLevel(u_depth, u_sampler, input.v_texCoord, 0.0).r;
  if (centerDepth <= 0.0) { return vec4f(1.0); }

  let P = textureSampleLevel(u_positionEmission, u_sampler, input.v_texCoord, 0.0).rgb;
  let N = normalize(textureSampleLevel(u_normalRoughness, u_sampler, input.v_texCoord, 0.0).rgb * 2.0 - 1.0);

  let angle = ign(input.position.xy) * 6.2831853;
  let randVec = vec3f(cos(angle), sin(angle), 0.0);
  let T = normalize(randVec - N * dot(randVec, N));
  let B = cross(N, T);

  var occlusion = 0.0;
  for (var i = 0; i < 12; i++) {
    let k = KERNEL[i];
    let samplePos = P + (T * k.x + B * k.y + N * k.z) * params.u_radius;

    let clip = params.u_viewProj * vec4f(samplePos, 1.0);
    if (clip.w <= 0.0) { continue; }
    // Reprojection uses the SAME formula as GLSL: the mesh vertex stage
    // negates clip Y, so a world point lands on the same texture row on
    // both backends — GL ndc.y=-1 → row 0, and (flipped) WebGPU ndc.y=+1
    // → row 0. v = ndc.y * 0.5 + 0.5 in GL convention either way.
    let ndc = clip.xy / clip.w;
    let uv = ndc * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { continue; }

    if (textureSampleLevel(u_depth, u_sampler, uv, 0.0).r <= 0.0) { continue; }
    let gbufPos = textureSampleLevel(u_positionEmission, u_sampler, uv, 0.0).rgb;
    let gbufDist = length(gbufPos - params.u_cameraPos);
    let sampleDist = length(samplePos - params.u_cameraPos);

    if (gbufDist < sampleDist - 0.02) {
      occlusion += smoothstep(0.0, 1.0, params.u_radius / max(abs(gbufDist - sampleDist), 0.0001));
    }
  }

  let ao = pow(1.0 - occlusion / 12.0, 1.5);
  return vec4f(ao, ao, ao, 1.0);
}
`
}

function ssrGLSL() {
  return `#version 300 es
precision highp float;

uniform sampler2D u_litColor;
uniform sampler2D u_albedoMetallic;
uniform sampler2D u_normalRoughness;
uniform sampler2D u_positionEmission;
uniform sampler2D u_depth;
uniform sampler2D u_planarReflection;

uniform mat4 u_viewProj;
uniform mat4 u_reflectionViewProj;
uniform vec3 u_cameraPos;
uniform float u_reflStrength;
uniform vec3 u_planePoint;
uniform vec3 u_planeNormal;
uniform int u_planarEnabled;

in vec2 v_texCoord;
out vec4 fragColor;

// Local SSR has no roughness convolution, so ray hits on moderately rough
// materials become discrete depth bands. Above this point the environment
// fallback is both smoother and more physically plausible.
const float MAX_SSR_ROUGHNESS = 0.3;
const float HIT_THICKNESS = 0.001;
const int REFINEMENT_STEPS = 6;

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

vec3 samplePlanarReflection(vec2 uv, float roughness) {
  vec2 texel = 1.0 / vec2(textureSize(u_planarReflection, 0));
  float spread = roughness * roughness * 12.0;
  vec2 dx = vec2(texel.x * spread, 0.0);
  vec2 dy = vec2(0.0, texel.y * spread);
  vec3 color = texture(u_planarReflection, uv).rgb * 4.0;
  color += texture(u_planarReflection, uv + dx).rgb;
  color += texture(u_planarReflection, uv - dx).rgb;
  color += texture(u_planarReflection, uv + dy).rgb;
  color += texture(u_planarReflection, uv - dy).rgb;
  return color / 8.0;
}

void main() {
  vec4 lit = texture(u_litColor, v_texCoord);
  vec4 nr = texture(u_normalRoughness, v_texCoord);
  float roughness = clamp(nr.a, 0.045, 1.0);
  float centerDepth = texture(u_depth, v_texCoord).r;

  if (centerDepth <= 0.0) {
    fragColor = lit;
    return;
  }

  vec3 N = normalize(nr.rgb * 2.0 - 1.0);
  vec3 P = texture(u_positionEmission, v_texCoord).rgb;
  float planarDistance = abs(dot(P - u_planePoint, u_planeNormal));
  if (u_planarEnabled == 1
      && planarDistance < 0.025
      && abs(dot(N, u_planeNormal)) > 0.9) {
    vec4 reflectionClip = u_reflectionViewProj * vec4(P, 1.0);
    if (reflectionClip.w <= 0.0) {
      fragColor = lit;
      return;
    }
    vec2 reflectionUV = reflectionClip.xy / reflectionClip.w * 0.5 + 0.5;
    if (reflectionUV.x <= 0.0 || reflectionUV.x >= 1.0
        || reflectionUV.y <= 0.0 || reflectionUV.y >= 1.0) {
      fragColor = lit;
      return;
    }
    vec4 planarAM = texture(u_albedoMetallic, v_texCoord);
    vec3 planarV = normalize(u_cameraPos - P);
    vec3 planarF0 = mix(vec3(0.04), planarAM.rgb, planarAM.a);
    vec3 planarF = fresnelSchlick(max(dot(N, planarV), 0.0), planarF0);
    vec2 planarEdge = min(reflectionUV, 1.0 - reflectionUV);
    float planarEdgeFade = smoothstep(0.0, 0.025, min(planarEdge.x, planarEdge.y));
    vec3 reflection = samplePlanarReflection(reflectionUV, roughness);
    fragColor = vec4(lit.rgb + reflection * planarF * planarEdgeFade * u_reflStrength, lit.a);
    return;
  }
  vec3 V = normalize(u_cameraPos - P);
  vec3 R = reflect(-V, N);

  // Exponentially growing march along the reflection ray
  vec3 rayPos = P + N * 0.03;
  float stepSize = 0.1;
  bool hit = false;
  vec2 hitUV = vec2(0.0);
  bool previousDepthValid = false;
  float previousDepthDelta = 0.0;

  if (roughness < MAX_SSR_ROUGHNESS) {
    for (int i = 0; i < 24; i++) {
      vec3 prev = rayPos;
      rayPos += R * stepSize;

      vec4 clip = u_viewProj * vec4(rayPos, 1.0);
      if (clip.w <= 0.0) { break; }
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }

      float sceneDepth = texture(u_depth, uv).r;
      if (sceneDepth > 0.0) {
        float rayDepth = clip.z / clip.w * 0.5 + 0.5;
        float depthDelta = rayDepth - sceneDepth;
        bool crossedSurface = previousDepthValid && previousDepthDelta <= 0.0 && depthDelta > 0.0;
        if (crossedSurface) {
          // Binary refinement between prev and rayPos
          vec3 lo = prev;
          vec3 hi = rayPos;
          bool bracketValid = true;
          for (int r = 0; r < REFINEMENT_STEPS; r++) {
            vec3 mid = (lo + hi) * 0.5;
            vec4 mclip = u_viewProj * vec4(mid, 1.0);
            vec2 muv = mclip.xy / mclip.w * 0.5 + 0.5;
            float midDepth = mclip.z / mclip.w * 0.5 + 0.5;
            float sampledDepth = texture(u_depth, muv).r;
            if (sampledDepth <= 0.0) {
              bracketValid = false;
              break;
            }
            if (midDepth > sampledDepth) { hi = mid; } else { lo = mid; }
          }
          vec3 hitPos = (lo + hi) * 0.5;
          vec4 fclip = u_viewProj * vec4(hitPos, 1.0);
          hitUV = fclip.xy / fclip.w * 0.5 + 0.5;
          float hitSceneDepth = texture(u_depth, hitUV).r;
          float hitRayDepth = fclip.z / fclip.w * 0.5 + 0.5;
          float hitDepthDelta = abs(hitRayDepth - hitSceneDepth);
          vec3 hitSurfacePos = texture(u_positionEmission, hitUV).rgb;
          float hitWorldDistance = length(hitSurfacePos - hitPos);
          float hitWorldThickness = max(0.03, length(hitSurfacePos - u_cameraPos) * 0.003);
          vec3 hitNormal = normalize(texture(u_normalRoughness, hitUV).rgb * 2.0 - 1.0);
          if (bracketValid && hitSceneDepth > 0.0
              && hitDepthDelta <= HIT_THICKNESS
              && hitWorldDistance <= hitWorldThickness
              && dot(hitNormal, -R) > 0.05) {
            hit = true;
            break;
          }
        }
        previousDepthDelta = depthDelta;
        previousDepthValid = true;
      } else {
        previousDepthValid = false;
      }

      stepSize *= 1.35;
    }
  }

  vec3 reflColor;
  float edgeFade = 1.0;
  if (hit) {
    reflColor = texture(u_litColor, hitUV).rgb;
    vec2 edge = min(hitUV, 1.0 - hitUV);
    edgeFade = smoothstep(0.0, 0.1, min(edge.x, edge.y));
  } else {
    fragColor = lit;
    return;
  }

  vec3 F0 = mix(vec3(0.04), texture(u_albedoMetallic, v_texCoord).rgb, texture(u_albedoMetallic, v_texCoord).a);
  vec3 F = fresnelSchlick(max(dot(N, V), 0.0), F0);
  float roughFade = hit ? 1.0 - roughness / MAX_SSR_ROUGHNESS : 1.0;

  fragColor = vec4(lit.rgb + reflColor * F * roughFade * edgeFade * u_reflStrength, lit.a);
}
`
}

function ssrWGSL() {
  return `struct SSRUniforms {
  u_viewProj: mat4x4f,
  u_reflectionViewProj: mat4x4f,
  u_cameraPos: vec3f,
  u_reflStrength: f32,
  u_planePoint: vec3f,
  u_planarEnabled: i32,
  u_planeNormal: vec3f,
  _pad0: f32,
}

@group(0) @binding(0) var u_litColor: texture_2d<f32>;
@group(0) @binding(1) var u_albedoMetallic: texture_2d<f32>;
@group(0) @binding(2) var u_normalRoughness: texture_2d<f32>;
@group(0) @binding(3) var u_positionEmission: texture_2d<f32>;
@group(0) @binding(4) var u_depth: texture_2d<f32>;
@group(0) @binding(5) var u_planarReflection: texture_2d<f32>;
@group(0) @binding(6) var u_sampler: sampler;
@group(0) @binding(7) var<uniform> params: SSRUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_texCoord: vec2f,
}

// Local SSR has no roughness convolution, so ray hits on moderately rough
// materials become discrete depth bands. Above this point the environment
// fallback is both smoother and more physically plausible.
const MAX_SSR_ROUGHNESS: f32 = 0.3;
const HIT_THICKNESS: f32 = 0.001;
const REFINEMENT_STEPS: i32 = 6;

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn samplePlanarReflection(uv: vec2f, roughness: f32) -> vec3f {
  let texel = 1.0 / vec2f(textureDimensions(u_planarReflection));
  let spread = roughness * roughness * 12.0;
  let dx = vec2f(texel.x * spread, 0.0);
  let dy = vec2f(0.0, texel.y * spread);
  var color = textureSampleLevel(u_planarReflection, u_sampler, uv, 0.0).rgb * 4.0;
  color += textureSampleLevel(u_planarReflection, u_sampler, uv + dx, 0.0).rgb;
  color += textureSampleLevel(u_planarReflection, u_sampler, uv - dx, 0.0).rgb;
  color += textureSampleLevel(u_planarReflection, u_sampler, uv + dy, 0.0).rgb;
  color += textureSampleLevel(u_planarReflection, u_sampler, uv - dy, 0.0).rgb;
  return color / 8.0;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // textureSampleLevel throughout: sampling occurs after non-uniform
  // returns and inside divergent loops. Reprojection uses the same uv
  // formula as GLSL — see the SSAO shader for the derivation.
  let uv0 = input.v_texCoord;
  let litUV = vec2f(uv0.x, 1.0 - uv0.y);
  let lit = textureSampleLevel(u_litColor, u_sampler, litUV, 0.0);
  let nr = textureSampleLevel(u_normalRoughness, u_sampler, uv0, 0.0);
  let roughness = clamp(nr.a, 0.045, 1.0);
  let centerDepth = textureSampleLevel(u_depth, u_sampler, uv0, 0.0).r;

  if (centerDepth <= 0.0) {
    return lit;
  }

  let N = normalize(nr.rgb * 2.0 - 1.0);
  let P = textureSampleLevel(u_positionEmission, u_sampler, uv0, 0.0).rgb;
  let planarDistance = abs(dot(P - params.u_planePoint, params.u_planeNormal));
  if (params.u_planarEnabled == 1
      && planarDistance < 0.025
      && abs(dot(N, params.u_planeNormal)) > 0.9) {
    let reflectionClip = params.u_reflectionViewProj * vec4f(P, 1.0);
    if (reflectionClip.w <= 0.0) {
      return lit;
    }
    var reflectionUV = reflectionClip.xy / reflectionClip.w * 0.5 + 0.5;
    reflectionUV.y = 1.0 - reflectionUV.y;
    if (reflectionUV.x <= 0.0 || reflectionUV.x >= 1.0
        || reflectionUV.y <= 0.0 || reflectionUV.y >= 1.0) {
      return lit;
    }
    let planarAM = textureSampleLevel(u_albedoMetallic, u_sampler, uv0, 0.0);
    let planarV = normalize(params.u_cameraPos - P);
    let planarF0 = mix(vec3f(0.04), planarAM.rgb, planarAM.a);
    let planarF = fresnelSchlick(max(dot(N, planarV), 0.0), planarF0);
    let planarEdge = min(reflectionUV, 1.0 - reflectionUV);
    let planarEdgeFade = smoothstep(0.0, 0.025, min(planarEdge.x, planarEdge.y));
    let reflection = samplePlanarReflection(reflectionUV, roughness);
    return vec4f(lit.rgb + reflection * planarF * planarEdgeFade * params.u_reflStrength, lit.a);
  }
  let V = normalize(params.u_cameraPos - P);
  let R = reflect(-V, N);

  var rayPos = P + N * 0.03;
  var stepSize = 0.1;
  var hit = false;
  var hitUV = vec2f(0.0);
  var previousDepthValid = false;
  var previousDepthDelta = 0.0;

  if (roughness < MAX_SSR_ROUGHNESS) {
    for (var i = 0; i < 24; i++) {
      let prev = rayPos;
      rayPos += R * stepSize;

      let clip = params.u_viewProj * vec4f(rayPos, 1.0);
      if (clip.w <= 0.0) { break; }
      let uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }

      let sceneDepth = textureSampleLevel(u_depth, u_sampler, uv, 0.0).r;
      if (sceneDepth > 0.0) {
        let rayDepth = clip.z / clip.w * 0.5 + 0.5;
        let depthDelta = rayDepth - sceneDepth;
        let crossedSurface = previousDepthValid && previousDepthDelta <= 0.0 && depthDelta > 0.0;
        if (crossedSurface) {
          var lo = prev;
          var hi = rayPos;
          var bracketValid = true;
          for (var r = 0; r < REFINEMENT_STEPS; r++) {
            let mid = (lo + hi) * 0.5;
            let mclip = params.u_viewProj * vec4f(mid, 1.0);
            let muv = mclip.xy / mclip.w * 0.5 + 0.5;
            let midDepth = mclip.z / mclip.w * 0.5 + 0.5;
            let sampledDepth = textureSampleLevel(u_depth, u_sampler, muv, 0.0).r;
            if (sampledDepth <= 0.0) {
              bracketValid = false;
              break;
            }
            if (midDepth > sampledDepth) { hi = mid; } else { lo = mid; }
          }
          let hitPos = (lo + hi) * 0.5;
          let fclip = params.u_viewProj * vec4f(hitPos, 1.0);
          hitUV = fclip.xy / fclip.w * 0.5 + 0.5;
          let hitSceneDepth = textureSampleLevel(u_depth, u_sampler, hitUV, 0.0).r;
          let hitRayDepth = fclip.z / fclip.w * 0.5 + 0.5;
          let hitDepthDelta = abs(hitRayDepth - hitSceneDepth);
          let hitSurfacePos = textureSampleLevel(u_positionEmission, u_sampler, hitUV, 0.0).rgb;
          let hitWorldDistance = length(hitSurfacePos - hitPos);
          let hitWorldThickness = max(0.03, length(hitSurfacePos - params.u_cameraPos) * 0.003);
          let hitNormal = normalize(textureSampleLevel(u_normalRoughness, u_sampler, hitUV, 0.0).rgb * 2.0 - 1.0);
          if (bracketValid && hitSceneDepth > 0.0
              && hitDepthDelta <= HIT_THICKNESS
              && hitWorldDistance <= hitWorldThickness
              && dot(hitNormal, -R) > 0.05) {
            hit = true;
            break;
          }
        }
        previousDepthDelta = depthDelta;
        previousDepthValid = true;
      } else {
        previousDepthValid = false;
      }

      stepSize *= 1.35;
    }
  }

  var reflColor = vec3f(0.0);
  var edgeFade = 1.0;
  if (hit) {
    let hitLitUV = vec2f(hitUV.x, 1.0 - hitUV.y);
    reflColor = textureSampleLevel(u_litColor, u_sampler, hitLitUV, 0.0).rgb;
    let edge = min(hitUV, 1.0 - hitUV);
    edgeFade = smoothstep(0.0, 0.1, min(edge.x, edge.y));
  } else {
    return lit;
  }

  let am = textureSampleLevel(u_albedoMetallic, u_sampler, uv0, 0.0);
  let F0 = mix(vec3f(0.04), am.rgb, am.a);
  let F = fresnelSchlick(max(dot(N, V), 0.0), F0);
  let roughFade = select(1.0, 1.0 - roughness / MAX_SSR_ROUGHNESS, hit);

  return vec4f(lit.rgb + reflColor * F * roughFade * edgeFade * params.u_reflStrength, lit.a);
}
`
}

// ---------------------------------------------------------------------------
// WGSL shaders
// ---------------------------------------------------------------------------

function meshVertexWGSL() {
  return `struct Uniforms {
  u_modelMatrix: mat4x4f,
  u_viewMatrix: mat4x4f,
  u_projectionMatrix: mat4x4f,
  u_normalMatrix: mat4x4f,
  u_meshTexWidth: i32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var u_positions: texture_2d<f32>;
@group(0) @binding(2) var u_normals: texture_2d<f32>;
@group(0) @binding(3) var u_uvs: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_worldPos: vec3f,
  @location(1) v_worldNormal: vec3f,
  @location(2) v_texCoord: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let idx = i32(vertexIndex);
  let x = idx % uniforms.u_meshTexWidth;
  let y = idx / uniforms.u_meshTexWidth;
  let texCoord = vec2i(x, y);

  let pos = textureLoad(u_positions, texCoord, 0).xyz;
  let norm = textureLoad(u_normals, texCoord, 0).xyz;
  let uv = textureLoad(u_uvs, texCoord, 0).xy;

  let worldPos = uniforms.u_modelMatrix * vec4f(pos, 1.0);

  var output: VertexOutput;
  output.v_worldPos = worldPos.xyz;
  output.v_worldNormal = normalize((uniforms.u_normalMatrix * vec4f(norm, 0.0)).xyz);
  output.v_texCoord = uv;
  output.position = uniforms.u_projectionMatrix * uniforms.u_viewMatrix * worldPos;
  // The projection matrix is GL-convention. WebGPU differs two ways:
  // clip-space Y is down (flip it so the G-buffer matches WebGL2), and
  // clip-space Z spans [0, w] instead of [-w, w] (remap, or everything
  // nearer than the frustum midpoint is clipped away).
  output.position.y = -output.position.y;
  output.position.z = (output.position.z + output.position.w) * 0.5;
  return output;
}
`
}

function meshFragmentWGSL() {
  return `struct MaterialUniforms {
  u_baseColor: vec4f,
  u_metallic: f32,
  u_roughness: f32,
  u_emissionStrength: f32,
  u_hasAlbedoTexture: i32,
  u_uvScale: vec2f,
  u_uvOffset: vec2f,
  u_clipPlane: vec4f,
  u_clipEnabled: i32,
}

// Bindings 0-3 belong to the vertex stage (transform uniforms + geometry
// textures). WebGPU merges both stages' bindings into one @group(0) layout,
// so the fragment stage starts at 4 — colliding indices with different
// resource kinds (texture vs sampler) fail pipeline creation, and colliding
// same-kind indices silently drop one side's binding.
@group(0) @binding(4) var<uniform> material: MaterialUniforms;
@group(0) @binding(5) var u_albedoTexture: texture_2d<f32>;
@group(0) @binding(6) var u_sampler: sampler;

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
}

@fragment
fn fs_main(input: FragmentInput, @builtin(position) fragCoord: vec4f) -> GBufferOutput {
  if (material.u_clipEnabled == 1 && dot(vec4f(input.v_worldPos, 1.0), material.u_clipPlane) < 0.0001) {
    discard;
  }

  var albedo = material.u_baseColor.rgb;
  if (material.u_hasAlbedoTexture == 1) {
    let sampleUV = fract(input.v_texCoord * material.u_uvScale + material.u_uvOffset);
    albedo *= textureSample(u_albedoTexture, u_sampler, sampleUV).rgb;
  }

  let normal = normalize(input.v_worldNormal);

  var output: GBufferOutput;
  output.albedoMetallic = vec4f(albedo, material.u_metallic);
  output.normalRoughness = vec4f(normal * 0.5 + 0.5, material.u_roughness);
  output.positionEmission = vec4f(input.v_worldPos, material.u_emissionStrength);
  output.depth = fragCoord.z;
  return output;
}
`
}

function deferredLightingWGSL(numLights) {
  return `const NUM_LIGHTS: u32 = ${numLights}u;
const PI: f32 = 3.14159265359;

// lightType: 0 = point, 1 = directional, 2 = spot
struct Light {
  position: vec3f,
  intensity: f32,
  color: vec3f,
  lightType: f32,
  direction: vec3f,
  cosInner: f32,
  cosOuter: f32,
  falloff: f32,
  _pad0: f32,
  _pad1: f32,
}

struct SceneUniforms {
  u_cameraPos: vec3f,
  u_ssaoStrength: f32,
  u_skyColor: vec3f,
  u_envIntensity: f32,
  u_groundColor: vec3f,
  _pad2: f32,
  u_backgroundColor: vec3f,
  u_probeEnabled: f32,
  u_probeCapture: f32,
  _pad3: vec3f,
  u_lights: array<Light, ${numLights}>,
}

@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(0) @binding(1) var u_albedoMetallic: texture_2d<f32>;
@group(0) @binding(2) var u_normalRoughness: texture_2d<f32>;
@group(0) @binding(3) var u_positionEmission: texture_2d<f32>;
@group(0) @binding(4) var u_depth: texture_2d<f32>;
@group(0) @binding(5) var u_ssao: texture_2d<f32>;
@group(0) @binding(6) var u_envTexture: texture_2d<f32>;
@group(0) @binding(7) var u_reflectionProbe: texture_cube<f32>;
@group(0) @binding(8) var u_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_texCoord: vec2f,
}

fn distributionGGX(N: vec3f, H: vec3f, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH = max(dot(N, H), 0.0);
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(N: vec3f, V: vec3f, L: vec3f, roughness: f32) -> f32 {
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Equirectangular lookup for the DSL-surface environment. Pipeline surface
// textures store rows flipped on WebGPU relative to GL (their own present
// path compensates), so v is inverted here to sample the same sky the GLSL
// shader sees.
fn equirectUV(d: vec3f) -> vec2f {
  return vec2f(atan2(d.z, d.x) / 6.2831853 + 0.5, 1.0 - acos(clamp(d.y, -1.0, 1.0)) / 3.14159265);
}

fn environmentTangent(direction: vec3f) -> vec3f {
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(direction.y) < 0.999);
  return normalize(cross(up, direction));
}

fn sampleEnvironmentDiffuse(normal: vec3f) -> vec3f {
  let tangent = environmentTangent(normal);
  let bitangent = cross(normal, tangent);
  let spread = 0.65;
  var color = textureSampleLevel(u_envTexture, u_sampler, equirectUV(normal), 0.0).rgb * 2.0;
  color += textureSampleLevel(u_envTexture, u_sampler, equirectUV(normalize(normal + tangent * spread)), 0.0).rgb;
  color += textureSampleLevel(u_envTexture, u_sampler, equirectUV(normalize(normal - tangent * spread)), 0.0).rgb;
  color += textureSampleLevel(u_envTexture, u_sampler, equirectUV(normalize(normal + bitangent * spread)), 0.0).rgb;
  color += textureSampleLevel(u_envTexture, u_sampler, equirectUV(normalize(normal - bitangent * spread)), 0.0).rgb;
  return color / 6.0;
}

fn sampleEnvironmentSpecular(direction: vec3f, roughness: f32) -> vec3f {
  let tangent = environmentTangent(direction);
  let bitangent = cross(direction, tangent);
  let spread = roughness * roughness * 0.9;
  const ENV_SPECULAR_SAMPLES: i32 = 24;
  const GOLDEN_ANGLE: f32 = 2.39996323;
  var color = vec3f(0.0);
  for (var i = 0; i < ENV_SPECULAR_SAMPLES; i++) {
    let fi = f32(i) + 0.5;
    let radius = sqrt(fi / f32(ENV_SPECULAR_SAMPLES)) * spread;
    let angle = fi * GOLDEN_ANGLE;
    let sampleDirection = normalize(
      direction
      + tangent * (cos(angle) * radius)
      + bitangent * (sin(angle) * radius)
    );
    color += textureSampleLevel(u_envTexture, u_sampler, equirectUV(sampleDirection), 0.0).rgb;
  }
  return color / f32(ENV_SPECULAR_SAMPLES);
}

fn sampleReflectionProbe(direction: vec3f, roughness: f32) -> vec4f {
  let tangent = environmentTangent(direction);
  let bitangent = cross(direction, tangent);
  let spread = roughness * roughness * 0.9;
  const PROBE_SPECULAR_SAMPLES: i32 = 24;
  const GOLDEN_ANGLE: f32 = 2.39996323;
  var color = vec4f(0.0);
  for (var i = 0; i < PROBE_SPECULAR_SAMPLES; i++) {
    let fi = f32(i) + 0.5;
    let radius = sqrt(fi / f32(PROBE_SPECULAR_SAMPLES)) * spread;
    let angle = fi * GOLDEN_ANGLE;
    let sampleDirection = normalize(
      direction
      + tangent * (cos(angle) * radius)
      + bitangent * (sin(angle) * radius)
    );
    color += textureSampleLevel(u_reflectionProbe, u_sampler, sampleDirection, 0.0);
  }
  return color / f32(PROBE_SPECULAR_SAMPLES);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let depth = textureSampleLevel(u_depth, u_sampler, input.v_texCoord, 0.0).r;
  if (depth <= 0.0) {
    let alpha = select(1.0, 0.0, scene.u_probeCapture > 0.5);
    return vec4f(scene.u_backgroundColor, alpha);
  }
  let albedoMetallic = textureSampleLevel(u_albedoMetallic, u_sampler, input.v_texCoord, 0.0);
  let normalRoughness = textureSampleLevel(u_normalRoughness, u_sampler, input.v_texCoord, 0.0);
  let positionEmission = textureSampleLevel(u_positionEmission, u_sampler, input.v_texCoord, 0.0);

  let albedo = albedoMetallic.rgb;
  let metallic = clamp(albedoMetallic.a, 0.0, 1.0);
  let normal = normalize(normalRoughness.rgb * 2.0 - 1.0);
  let roughness = clamp(normalRoughness.a, 0.045, 1.0);
  let worldPos = positionEmission.rgb;
  let emission = positionEmission.a;

  let V = normalize(scene.u_cameraPos - worldPos);
  let F0 = mix(vec3f(0.04), albedo, metallic);

  var Lo = vec3f(0.0);

  for (var i: u32 = 0u; i < NUM_LIGHTS; i++) {
    let light = scene.u_lights[i];
    var L: vec3f;
    var attenuation: f32;
    if (light.lightType > 0.5 && light.lightType < 1.5) {
      // Directional: no distance falloff
      L = normalize(-light.direction);
      attenuation = light.intensity;
    } else {
      // Point and spot: inverse-square falloff from a position
      L = normalize(light.position - worldPos);
      let dist = length(light.position - worldPos);
      attenuation = light.intensity / (1.0 + max(light.falloff, 0.0) * dist * dist);
      if (light.lightType > 1.5) {
        // Spot: cone factor between outer and inner cosines
        let cosAngle = dot(normalize(worldPos - light.position), normalize(light.direction));
        attenuation *= smoothstep(light.cosOuter, light.cosInner, cosAngle);
      }
    }
    let H = normalize(V + L);
    let radiance = light.color * attenuation;

    let NDF = distributionGGX(normal, H, roughness);
    let G = geometrySmith(normal, V, L, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let numerator = NDF * G * F;
    let denominator = 4.0 * max(dot(normal, V), 0.0) * max(dot(normal, L), 0.0) + 0.0001;
    let specular = numerator / denominator;

    let kS = F;
    let kD = (1.0 - kS) * (1.0 - metallic);

    let NdotL = max(dot(normal, L), 0.0);
    Lo += (kD * albedo / PI + specular) * radiance * NdotL;
  }

  // Ambient: a DSL-surface environment sampled at the normal when present,
  // else hemisphere sky/ground — either way occluded by SSAO.
  let ao = mix(1.0, textureSampleLevel(u_ssao, u_sampler, input.v_texCoord, 0.0).r, scene.u_ssaoStrength);
  var ambientLight: vec3f;
  if (scene.u_envIntensity > 0.0) {
    ambientLight = sampleEnvironmentDiffuse(normal) * scene.u_envIntensity;
  } else {
    ambientLight = mix(scene.u_groundColor, scene.u_skyColor, normal.y * 0.5 + 0.5);
  }
  let ambientF = fresnelSchlick(max(dot(normal, V), 0.0), F0);
  let ambientKD = (1.0 - ambientF) * (1.0 - metallic);
  let ambient = ambientLight * albedo * ambientKD * ao;
  var ambientSpecular = vec3f(0.0);
  let R = reflect(-V, normal);
  if (scene.u_probeEnabled > 0.5) {
    let probe = sampleReflectionProbe(R, roughness);
    var probeFallback = scene.u_backgroundColor;
    if (scene.u_envIntensity > 0.0) {
      probeFallback = sampleEnvironmentSpecular(R, roughness) * scene.u_envIntensity;
    }
    ambientSpecular = mix(probeFallback, probe.rgb, clamp(probe.a, 0.0, 1.0))
      * ambientF * ao;
  } else if (scene.u_envIntensity > 0.0) {
    ambientSpecular = sampleEnvironmentSpecular(R, roughness)
      * scene.u_envIntensity * ambientF * ao;
  }
  let color = ambient + ambientSpecular + Lo + albedo * emission;

  return vec4f(color, 1.0);
}
`
}
