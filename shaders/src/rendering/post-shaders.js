// Post-processing and utility shader generators for the scene renderer.
// All shaders use the default fullscreen vertex shader (receives v_texCoord).

export function presentShader(backend) {
  if (backend === 'wgsl') return presentShaderWGSL()
  return `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  fragColor = texture(u_texture, v_texCoord);
}
`
}

function presentShaderWGSL() {
  return `@group(0) @binding(0) var u_texture: texture_2d<f32>;
@group(0) @binding(1) var u_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_texCoord: vec2f,
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(u_texture, u_sampler, input.v_texCoord);
}
`
}

export function tonemapPresentShader(backend) {
  if (backend === 'wgsl') return tonemapPresentShaderWGSL()
  return `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_exposure;
out vec4 fragColor;
void main() {
  vec3 hdr = texture(u_texture, v_texCoord).rgb * u_exposure;
  // Reinhard tone mapping
  vec3 mapped = hdr / (hdr + 1.0);
  // Gamma correction (linear -> sRGB)
  mapped = pow(mapped, vec3(1.0 / 2.2));
  fragColor = vec4(mapped, 1.0);
}
`
}

function tonemapPresentShaderWGSL() {
  return `struct TonemapUniforms {
  u_exposure: f32,
}

@group(0) @binding(0) var u_texture: texture_2d<f32>;
@group(0) @binding(1) var u_sampler: sampler;
@group(0) @binding(2) var<uniform> params: TonemapUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_texCoord: vec2f,
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let hdr = textureSample(u_texture, u_sampler, input.v_texCoord).rgb * params.u_exposure;
  // Reinhard tone mapping
  let mapped = hdr / (hdr + 1.0);
  // Gamma correction (linear -> sRGB)
  let corrected = pow(mapped, vec3f(1.0 / 2.2));
  return vec4f(corrected, 1.0);
}
`
}
