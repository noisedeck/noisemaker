import assert from 'assert'
import { volumeFragmentGLSL, volumeFragmentWGSL } from '../src/rendering/volume-shaders.js'
import { GBufferConfig } from '../src/rendering/gbuffer.js'

const glsl = volumeFragmentGLSL()
const wgsl = volumeFragmentWGSL()

// Both variants fill the SAME four G-buffer targets the mesh pass fills.
// Anything less and the deferred lighting pass reads an undefined channel for
// every pixel the volume covers.
{
  assert.ok(glsl.includes('layout(location = 0) out vec4 gAlbedoMetallic;'), 'GLSL RT0 albedo+metallic')
  assert.ok(glsl.includes('layout(location = 1) out vec4 gNormalRoughness;'), 'GLSL RT1 normal+roughness')
  assert.ok(glsl.includes('layout(location = 2) out vec4 gPositionEmission;'), 'GLSL RT2 worldPos+emission')
  assert.ok(glsl.includes('layout(location = 3) out float gDepth;'), 'GLSL RT3 depth')

  assert.ok(wgsl.includes('@location(0) albedoMetallic: vec4f,'), 'WGSL RT0 albedo+metallic')
  assert.ok(wgsl.includes('@location(1) normalRoughness: vec4f,'), 'WGSL RT1 normal+roughness')
  assert.ok(wgsl.includes('@location(2) positionEmission: vec4f,'), 'WGSL RT2 worldPos+emission')
  assert.ok(wgsl.includes('@location(3) depth: f32,'), 'WGSL RT3 depth')
}

// The hardware depth test composites volumes against meshes only if the
// marcher publishes the HIT distance as the fragment's depth, not the bounding
// box's. Both languages must write the frag-depth builtin.
{
  assert.ok(glsl.includes('gl_FragDepth = '), 'GLSL writes gl_FragDepth')
  assert.ok(wgsl.includes('@builtin(frag_depth)'), 'WGSL declares frag_depth')
  assert.ok(wgsl.includes('output.fragDepth = '), 'WGSL writes frag_depth')
}

// The value in RT3 must be the same window-space nonlinear depth the mesh pass
// stores (gl_FragCoord.z), because SSR reconstructs exactly this expression to
// compare against it. Identical text in both languages, no per-backend branch.
{
  const DEPTH_EXPR = 'clamp(clip.z / clip.w * 0.5 + 0.5, 1e-6, 1.0)'
  assert.ok(glsl.includes(DEPTH_EXPR), `GLSL depth expression: ${DEPTH_EXPR}`)
  assert.ok(wgsl.includes(DEPTH_EXPR), `WGSL depth expression: ${DEPTH_EXPR}`)

  // ...and it is the same expression SSR builds from a world position.
  const config = new GBufferConfig(64, 64)
  assert.ok(
    config.getSSRShader('glsl').includes('clip.z / clip.w * 0.5 + 0.5'),
    'precondition: SSR compares against clip.z / clip.w * 0.5 + 0.5'
  )
  assert.ok(
    config.getSSRShader('wgsl').includes('clip.z / clip.w * 0.5 + 0.5'),
    'precondition: WGSL SSR compares against the same expression'
  )
}

// A miss must leave no trace: the box is scaffolding, not geometry. RT3 stays
// at its cleared 0, which every downstream pass already reads as sky.
{
  assert.ok(glsl.includes('discard;'), 'GLSL discards on miss')
  assert.ok(wgsl.includes('discard;'), 'WGSL discards on miss')
  // Three discards each: the ray missing the box entirely, the march reaching
  // the exit without crossing the threshold, and the hit landing inside the
  // near plane (see the near-plane clip test below).
  assert.strictEqual((glsl.match(/discard;/g) || []).length, 3, 'GLSL: box miss, march miss, near-plane reject')
  assert.strictEqual((wgsl.match(/discard;/g) || []).length, 3, 'WGSL: box miss, march miss, near-plane reject')
}

// A hit INSIDE the near plane must be discarded, not clamped to the front of
// the depth range.
//
// The clamp alone turns every such fragment into depth 1e-6 — nearer than
// anything else in the scene — so a volume body enclosing the camera occludes
// the whole scene. That is the exact opposite of a same-extent mesh, which the
// rasterizer near-clips away. clip.w <= 0 is reachable too (camera exactly on
// the isosurface gives tHit 0 and, with a hit at the eye, w 0 -> 0/0 NaN into
// frag depth), and NaN depth is undefined behaviour on both backends.
//
// `clip.w <= 0.0 || clip.z < -clip.w` IS the near-plane test in clip space:
// both backends' projection matrices are GL-convention here (the WGSL vertex
// stage remaps z to [0,w] afterwards), so the near plane is z == -w and a point
// in front of it has z < -w. Identical text in both languages.
{
  const NEAR_CLIP_EXPR = 'clip.w <= 0.0 || clip.z < -clip.w'
  assert.ok(glsl.includes(NEAR_CLIP_EXPR), `GLSL near-plane reject: ${NEAR_CLIP_EXPR}`)
  assert.ok(wgsl.includes(NEAR_CLIP_EXPR), `WGSL near-plane reject: ${NEAR_CLIP_EXPR}`)

  // ...and it must come BEFORE the depth is computed, or the clamp has already
  // manufactured the bogus value the test exists to prevent.
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    const rejectAt = src.indexOf(NEAR_CLIP_EXPR)
    const depthAt = src.indexOf('clamp(clip.z / clip.w * 0.5 + 0.5, 1e-6, 1.0)')
    assert.ok(rejectAt > 0 && depthAt > 0, `${lang} precondition: both expressions present`)
    assert.ok(rejectAt < depthAt, `${lang} rejects the near-plane hit before writing depth`)
  }
}

// The scene renderer supplies no u_time to G-buffer passes and the marcher must
// not want one: the volume atlas is animated by the pipeline, not by this pass.
{
  assert.ok(!glsl.includes('u_time'), 'GLSL marcher is time-independent')
  assert.ok(!wgsl.includes('u_time'), 'WGSL marcher is time-independent')
}

// Ray setup: derived from the interpolated world position, transformed into the
// node's local box by the inverse world matrix. No inverse-VP, no fragcoord.
{
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    assert.ok(src.includes('u_invModelMatrix'), `${lang} takes the inverse world matrix`)
    assert.ok(src.includes('u_cameraPos'), `${lang} takes the camera position`)
    assert.ok(src.includes('v_worldPos'), `${lang} derives the ray from the interpolated world position`)
    assert.ok(!src.includes('gl_FragCoord'), `${lang} does not reconstruct the ray from fragcoord`)
    assert.ok(!src.includes('u_invViewProj'), `${lang} does not unproject`)
    assert.ok(src.includes('u_threshold'), `${lang} marches for the node's iso level`)
    assert.ok(src.includes('u_volumeAtlas'), `${lang} samples the bound volume atlas`)
    assert.ok(src.includes('u_normalMatrix'), `${lang} transforms the local gradient to world`)
  }
}

// Marcher constants match render3d's, so a program moved from the marcher to the
// scene graph resolves the same isosurface.
{
  assert.ok(glsl.includes('#define MAX_STEPS 256'), 'GLSL MAX_STEPS 256')
  assert.ok(wgsl.includes('const MAX_STEPS: i32 = 256;'), 'WGSL MAX_STEPS 256')
  assert.ok(glsl.includes('#define BISECTION_STEPS 8'), 'GLSL 8 bisection iterations')
  assert.ok(wgsl.includes('const BISECTION_STEPS: i32 = 8;'), 'WGSL 8 bisection iterations')
  assert.ok(glsl.includes('1.5 / float(u_volumeSize)'), 'GLSL step size 1.5/volumeSize')
  assert.ok(wgsl.includes('1.5 / f32(u.u_volumeSize)'), 'WGSL step size 1.5/volumeSize')
}

// The 2D atlas emulates a 3D texture the same way every existing marcher does:
// texel (x, y + z * volSize), trilinear by hand across the eight corners.
{
  assert.ok(glsl.includes('ivec2(p.x, p.y + p.z * u_volumeSize)'), 'GLSL atlas index')
  assert.ok(wgsl.includes('vec2i(p.x, p.y + p.z * u.u_volumeSize)'), 'WGSL atlas index')
  assert.strictEqual((glsl.match(/texelFetch\(u_volumeAtlas/g) || []).length, 8, 'GLSL fetches eight corners')
  assert.strictEqual((wgsl.match(/textureLoad\(u_volumeAtlas/g) || []).length, 8, 'WGSL loads eight corners')
  // Eight corners then three interpolation stages, in both languages.
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    for (const corner of ['c000', 'c100', 'c010', 'c110', 'c001', 'c101', 'c011', 'c111']) {
      assert.ok(src.includes(corner), `${lang} trilinear corner ${corner}`)
    }
  }
}

// WebGPU merges both stages into one @group(0) layout. The mesh vertex shader
// owns bindings 0..3, so the volume fragment stage must start at 4 or pipeline
// creation fails (or silently drops a binding).
{
  const vertex = new GBufferConfig(64, 64).getMeshVertexShader('wgsl')
  const vertexBindings = [...vertex.matchAll(/@binding\((\d+)\)/g)].map(m => Number(m[1]))
  const fragmentBindings = [...wgsl.matchAll(/@binding\((\d+)\)/g)].map(m => Number(m[1]))
  assert.deepStrictEqual(vertexBindings, [0, 1, 2, 3], 'precondition: mesh vertex owns 0..3')
  assert.ok(
    fragmentBindings.every(b => b >= 4),
    `volume fragment bindings must start at 4, got ${fragmentBindings.join(', ')}`
  )
  assert.strictEqual(
    new Set(fragmentBindings).size, fragmentBindings.length,
    'volume fragment binding indices are unique'
  )
  // textureLoad needs no sampler; declaring one would add an unused binding the
  // auto pipeline layout would then refuse to accept an entry for.
  assert.ok(!wgsl.includes(': sampler'), 'WGSL volume fragment declares no sampler')
}

// The fragment stage reads varyings the mesh vertex shader actually emits.
{
  const vertex = new GBufferConfig(64, 64).getMeshVertexShader('wgsl')
  for (const location of [0, 1, 2]) {
    const declared = new RegExp(`@location\\(${location}\\) (v_worldPos|v_worldNormal|v_texCoord)`)
    assert.ok(declared.test(vertex), `precondition: mesh vertex emits @location(${location})`)
  }
  assert.ok(wgsl.includes('@location(0) v_worldPos: vec3f,'), 'WGSL fragment input matches vertex output 0')
}

console.log('Volume shader tests passed')
