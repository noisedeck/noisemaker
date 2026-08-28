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
  // Four discards each: the ray missing the box entirely, the march reaching
  // the exit without crossing the threshold, the hit landing behind the planar
  // reflector's clip plane, and the hit landing inside the near plane (see the
  // two clip tests below).
  assert.strictEqual((glsl.match(/discard;/g) || []).length, 4, 'GLSL: box miss, march miss, clip-plane reject, near-plane reject')
  assert.strictEqual((wgsl.match(/discard;/g) || []).length, 4, 'WGSL: box miss, march miss, clip-plane reject, near-plane reject')
}

// The planar reflection renders from a mirrored camera and must not show
// anything behind the reflector's own plane. The mesh pass discards such a
// fragment on its interpolated surface point (gbuffer.js). The marcher's
// surface point is the ray HIT, not the rasterized bounding-box face, so the
// same test applied to v_worldPos would clip the scaffolding and leave the
// isosurface unclipped. Same uniforms, same epsilon, same comparison as the
// mesh path — identical text in both languages.
{
  const CLIP_EXPR = 'dot(vec4(worldHit.xyz, 1.0), u_clipPlane) < 0.0001'
  const CLIP_EXPR_WGSL = 'dot(vec4f(worldHit.xyz, 1.0), u.u_clipPlane) < 0.0001'
  assert.ok(glsl.includes(`u_clipEnabled == 1 && ${CLIP_EXPR}`), `GLSL clip-plane reject: ${CLIP_EXPR}`)
  assert.ok(wgsl.includes(`u.u_clipEnabled == 1 && ${CLIP_EXPR_WGSL}`), `WGSL clip-plane reject: ${CLIP_EXPR_WGSL}`)

  // It tests the hit, not the box face — v_worldPos must never reach the clip
  // comparison.
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    assert.ok(!/dot\(vec4f?\(\s*(input\.)?v_worldPos/.test(src),
      `${lang} must clip the marched hit, not the bounding box surface`)
  }

  // Both languages declare the pair the mesh material struct carries, so the
  // renderer supplies one uniform set for both programs.
  assert.ok(glsl.includes('uniform vec4 u_clipPlane;'), 'GLSL declares u_clipPlane')
  assert.ok(glsl.includes('uniform int u_clipEnabled;'), 'GLSL declares u_clipEnabled')
  assert.ok(wgsl.includes('u_clipPlane: vec4f,'), 'WGSL declares u_clipPlane')
  assert.ok(wgsl.includes('u_clipEnabled: i32,'), 'WGSL declares u_clipEnabled')
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
//
// The corner fetches are counted by their own call shape rather than by the
// texture name: the voxel branch fetches the atlas too, and it must NOT be
// counted among the trilinear corners — nor must a trilinear corner ever be
// lost to it.
{
  assert.ok(glsl.includes('ivec2(p.x, p.y + p.z * u_volumeSize)'), 'GLSL atlas index')
  assert.ok(wgsl.includes('vec2i(p.x, p.y + p.z * u.u_volumeSize)'), 'WGSL atlas index')
  assert.strictEqual((glsl.match(/texelFetch\(u_volumeAtlas, atlasTexel\(ivec3\(/g) || []).length, 8,
    'GLSL fetches eight corners')
  assert.strictEqual((wgsl.match(/textureLoad\(u_volumeAtlas, atlasTexel\(vec3i\(/g) || []).length, 8,
    'WGSL loads eight corners')
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

// ---------------------------------------------------------------------------
// Voxel mode.
//
// render3d carries two marching modes behind a compile-time `FILTERING` define
// the expander injects per effect instance. The scene renderer has no define
// machinery — it compiles named programs directly — and mode is a per-NODE
// property, so two volumes in one scene can want different ones. So it is a
// uniform, which is also this pair's own established convention for selecting
// behaviour: u_hasMaterial and u_clipEnabled already do exactly this, and
// renderLit3d selects its bounding shape from a runtime `shape` uniform the
// same way. One program, one branch.
// ---------------------------------------------------------------------------
{
  // One source serves both modes. A source function that took a mode argument
  // would mean two compiled programs and two pass variants per node.
  assert.strictEqual(volumeFragmentGLSL.length, 0, 'the GLSL source takes no mode argument')
  assert.strictEqual(volumeFragmentWGSL.length, 0, 'the WGSL source takes no mode argument')

  assert.ok(glsl.includes('uniform int u_mode;'), 'GLSL declares the mode selector')
  assert.ok(wgsl.includes('u_mode: i32,'), 'WGSL declares the mode selector')
  assert.ok(glsl.includes('#define MODE_VOXEL 1'), 'GLSL names the voxel mode value')
  assert.ok(wgsl.includes('const MODE_VOXEL: i32 = 1;'), 'WGSL names the voxel mode value')

  // The branch is on the named constant, not a bare literal, and it is what
  // selects the DDA.
  assert.ok(glsl.includes('if (u_mode == MODE_VOXEL) {'), 'GLSL branches on the mode selector')
  assert.ok(wgsl.includes('if (u.u_mode == MODE_VOXEL) {'), 'WGSL branches on the mode selector')
}

// The DDA itself: an Amanatides & Woo walk over the atlas grid, in both
// languages. Per-axis next-wall distances, per-axis crossing costs, an integer
// step, and a bounded loop.
{
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    assert.ok(/fn voxelTrace|VoxelHit voxelTrace/.test(src), `${lang} declares the DDA traversal`)
    assert.ok(src.includes('tMax'), `${lang} tracks the per-axis distance to the next wall`)
    assert.ok(src.includes('tDelta'), `${lang} tracks the per-axis cost of crossing one cell`)
    assert.ok(src.includes('VOXEL_MAX_STEPS'), `${lang} bounds the DDA loop`)
    // All three axes step, and each advances its own cell index.
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(src.includes(`cell.${axis} = cell.${axis} + step.${axis}`) ||
                src.includes(`cell.${axis} += step.${axis}`),
        `${lang} steps the cell index on ${axis}`)
    }
  }
  assert.ok(glsl.includes('#define VOXEL_MAX_STEPS 512'), 'GLSL DDA step bound')
  assert.ok(wgsl.includes('const VOXEL_MAX_STEPS: i32 = 512;'), 'WGSL DDA step bound')
}

// The next wall is a cell BOUNDARY, not a cell centre.
//
// render3d builds it with voxelToWorld(voxel + max(step, 0)), which returns the
// centre of that cell — half a cell past the wall on every axis. In a shader
// that only shades and writes dist/MAX_DIST the bias is invisible; here the hit
// point becomes the G-buffer's world position and the fragment's depth, so the
// wall must be the wall. Cell c spans [-1 + 2c/N, -1 + 2(c+1)/N].
{
  assert.ok(glsl.includes('vec3(cell + max(step, ivec3(0))) / n * 2.0 - 1.0'),
    'GLSL next wall is the cell boundary')
  assert.ok(wgsl.includes('vec3f(cell + max(step, vec3i(0))) / n * 2.0 - 1.0'),
    'WGSL next wall is the cell boundary')
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    assert.ok(!/\+ 0\.5\) \/ n/.test(src), `${lang} must not take the wall from a cell centre`)
  }
}

// A voxel hit's normal is the face of the wall it entered through: the axis
// just stepped, pointing back along the step. The first cell has no such step,
// so its face is the box face the ray entered by — the slab whose tmin won
// tEnter, facing back along the ray.
{
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(glsl.includes(`-float(step.${axis})`), `GLSL face normal on ${axis} opposes the step`)
    assert.ok(wgsl.includes(`-f32(step.${axis})`), `WGSL face normal on ${axis} opposes the step`)
    assert.ok(glsl.includes(`-sign(rd.${axis})`), `GLSL entry face on ${axis} opposes the ray`)
    assert.ok(wgsl.includes(`-sign(rd.${axis})`), `WGSL entry face on ${axis} opposes the ray`)
  }
}

// The face normal goes to world through u_normalMatrix, exactly as the smooth
// branch's gradient does — one transform, applied after the branch, so neither
// mode can acquire its own.
//
// It is not decorative. u_normalMatrix is transpose(inverse(model)), the only
// transform that preserves perpendicularity: a normal is defined by n.v = 0 for
// every surface tangent v, and under v' = Mv only n' = (M^-1)^T n keeps
// n'.(Mv) = n.v = 0. For an axis-aligned face under a bare T*R*S the naive
// model matrix happens to agree, because the axis vectors are eigenvectors of
// both S and S^-1 — but a volume parented to a non-uniformly scaled, rotated
// group has a SHEARED world matrix, and there the two diverge.
{
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    assert.strictEqual((src.match(/u_normalMatrix \* vec4f?\(/g) || []).length, 1,
      `${lang} carries exactly one local normal to world`)
    assert.ok(src.includes('nLocal'), `${lang} names the local-space normal both branches produce`)
  }
  assert.ok(glsl.includes('normalize((u_normalMatrix * vec4(nLocal, 0.0)).xyz)'),
    'GLSL transforms the shared local normal')
  assert.ok(wgsl.includes('normalize((u.u_normalMatrix * vec4f(nLocal, 0.0)).xyz)'),
    'WGSL transforms the shared local normal')
}

// The voxel branch reads whole cells. Trilinear filtering across cell centres
// is precisely the blockiness this mode exists to keep, so the cell colour and
// the solidity test go through a nearest-neighbour fetch — exactly one each.
{
  assert.strictEqual((glsl.match(/texelFetch\(u_volumeAtlas, atlasTexel\(clamp/g) || []).length, 1,
    'GLSL has one nearest-neighbour cell fetch')
  assert.strictEqual((wgsl.match(/textureLoad\(u_volumeAtlas, atlasTexel\(clamp/g) || []).length, 1,
    'WGSL has one nearest-neighbour cell fetch')
  // render3d's voxel threshold semantics: a cell is solid when its density
  // EXCEEDS the threshold. Same sense as the smooth branch's signed field
  // (threshold - density < 0 inside), read as a hard per-cell predicate.
  assert.ok(glsl.includes('sampleVoxel(cell).r > u_threshold'), 'GLSL cell solidity test')
  assert.ok(wgsl.includes('sampleVoxel(cell).r > u.u_threshold'), 'WGSL cell solidity test')
}

// Both branches feed ONE tail. The clip-plane reject, the near-plane reject and
// the depth write each appear once and after the mode branch closes, so a voxel
// hit is clipped, near-rejected and depth-composited on exactly the same terms
// as an isosurface hit. The discard count staying at four is the same fact from
// the other side: voxel mode added no exit of its own.
{
  for (const [lang, src] of [['GLSL', glsl], ['WGSL', wgsl]]) {
    const branchAt = src.indexOf('MODE_VOXEL) {')
    const missAt = src.indexOf('if (!hit)')
    const clipAt = src.indexOf('u_clipEnabled == 1')
    const nearAt = src.indexOf('clip.w <= 0.0 || clip.z < -clip.w')
    assert.ok(branchAt > 0 && missAt > branchAt, `${lang}: the miss test follows the mode branch`)
    assert.ok(clipAt > missAt, `${lang}: the clip-plane reject follows the mode branch`)
    assert.ok(nearAt > clipAt, `${lang}: the near-plane reject follows the clip-plane reject`)
    assert.strictEqual((src.match(/u_clipEnabled == 1/g) || []).length, 1,
      `${lang} tests the clip plane once, for both modes`)
    assert.strictEqual((src.match(/clip\.w <= 0\.0 \|\| clip\.z < -clip\.w/g) || []).length, 1,
      `${lang} tests the near plane once, for both modes`)
  }
}

console.log('Volume shader tests passed')
