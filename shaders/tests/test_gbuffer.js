import assert from 'assert'
import { GBufferConfig } from '../src/rendering/gbuffer.js'
import { presentShader, tonemapPresentShader } from '../src/rendering/post-shaders.js'

// Default config
{
  const config = new GBufferConfig(1920, 1080)
  assert.strictEqual(config.width, 1920)
  assert.strictEqual(config.height, 1080)
  assert.strictEqual(config.targets.length, 4, '4 render targets')
  assert.strictEqual(config.targets[0].name, 'albedoMetallic')
  assert.strictEqual(config.targets[1].name, 'normalRoughness')
  assert.strictEqual(config.targets[2].name, 'positionEmission')
  assert.strictEqual(config.targets[3].name, 'depth')
}

// Resize
{
  const config = new GBufferConfig(800, 600)
  config.resize(1024, 768)
  assert.strictEqual(config.width, 1024)
  assert.strictEqual(config.height, 768)
}

// getMeshVertexShader / getMeshFragmentShader return strings
{
  const config = new GBufferConfig(800, 600)
  const vs = config.getMeshVertexShader('glsl')
  assert.ok(vs.includes('gl_Position'), 'GLSL vertex shader has gl_Position')
  assert.ok(vs.includes('u_modelMatrix'), 'has model matrix uniform')
  assert.ok(vs.includes('u_viewMatrix'), 'has view matrix uniform')
  assert.ok(vs.includes('u_projectionMatrix'), 'has projection matrix uniform')

  const fs = config.getMeshFragmentShader('glsl')
  assert.ok(fs.includes('layout(location = 0)'), 'has MRT outputs')
  assert.ok(fs.includes('u_metallic'), 'has PBR uniforms')
}

// Deferred lighting shader
{
  const config = new GBufferConfig(800, 600)
  const shader = config.getDeferredLightingShader('glsl', 2)
  assert.ok(shader.includes('NUM_LIGHTS'), 'has light count define or similar')
}

// WGSL variants
{
  const config = new GBufferConfig(800, 600)
  const vs = config.getMeshVertexShader('wgsl')
  assert.ok(vs.includes('fn vs_main'), 'WGSL vertex entry point')
  assert.ok(vs.includes('@vertex') || vs.includes('fn vs_main'), 'WGSL vertex attribute')
  const fs = config.getMeshFragmentShader('wgsl')
  assert.ok(fs.includes('@fragment') || fs.includes('fn fs_main'), 'WGSL fragment entry point')
}

// Vertex shader uses texelFetch for vertex data
{
  const config = new GBufferConfig(800, 600)
  const vs = config.getMeshVertexShader('glsl')
  assert.ok(vs.includes('texelFetch'), 'vertex shader uses texelFetch')
  assert.ok(vs.includes('gl_VertexID'), 'vertex shader uses gl_VertexID')
  assert.ok(vs.includes('u_positions'), 'has positions sampler')
  assert.ok(vs.includes('u_normals'), 'has normals sampler')
  assert.ok(vs.includes('u_uvs'), 'has uvs sampler')
  assert.ok(vs.includes('u_meshTexWidth'), 'has mesh texture width uniform')
  assert.ok(!vs.includes('in vec3 a_position'), 'no attribute inputs')
}

// Deferred lighting shader uses v_texCoord (matches default vertex shader)
{
  const config = new GBufferConfig(800, 600)
  const fs = config.getDeferredLightingShader('glsl', 2)
  assert.ok(fs.includes('v_texCoord'), 'uses v_texCoord varying')
  assert.ok(!fs.includes('v_uv'), 'does not use v_uv')
}

// Empty G-buffer pixels use scene background and light falloff affects attenuation
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const shader = config.getDeferredLightingShader(backend, 1)
    assert.ok(shader.includes('u_backgroundColor'), `${backend} declares scene background`)
    assert.ok(shader.includes('falloff'), `${backend} consumes light falloff`)
    assert.ok(shader.includes('dist * dist'), `${backend} applies falloff to squared distance`)
  }
}

// Deferred lighting owns both diffuse and specular IBL. SSR only adds valid
// local ray hits, avoiding a second environment contribution.
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const lighting = config.getDeferredLightingShader(backend, 1)
    const ssr = config.getSSRShader(backend)
    assert.ok(lighting.includes('sampleEnvironmentDiffuse'), `${backend} filters diffuse environment`)
    assert.ok(lighting.includes('sampleEnvironmentSpecular'), `${backend} filters specular environment`)
    assert.ok(lighting.includes('u_reflectionProbe'), `${backend} declares a cube reflection probe`)
    assert.ok(lighting.includes('sampleReflectionProbe'), `${backend} filters cubemap specular by roughness`)
    assert.ok(lighting.includes('u_probeEnabled'), `${backend} preserves the environment fallback when no probe is configured`)
    assert.ok(lighting.includes('roughness * roughness'), `${backend} broadens reflection samples by roughness`)
    assert.ok(!ssr.includes('sampleEnvironmentSpecular'), `${backend} does not double-add environment specular`)
  }
}

// SSR intersects in raster depth space, not curved camera-distance shells
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const ssr = config.getSSRShader(backend)
    assert.ok(ssr.includes('rayDepth'), `${backend} projects the ray into depth-buffer space`)
    assert.ok(ssr.includes('sceneDepth'), `${backend} compares against rasterized scene depth`)
    assert.ok(ssr.includes('hitNormal'), `${backend} rejects back-facing reflection hits`)
    assert.ok(
      ssr.includes('previousDepthDelta <= 0.0 && depthDelta > 0.0'),
      `${backend} only refines a bracketed front-to-back depth crossing`
    )
    assert.ok(
      ssr.includes('HIT_THICKNESS'),
      `${backend} validates refined SSR hit thickness`
    )
    assert.ok(
      ssr.includes('hitSurfacePos') && ssr.includes('hitWorldDistance'),
      `${backend} rejects raster-depth hits that miss the physical surface`
    )
    assert.ok(
      ssr.includes('REFINEMENT_STEPS'),
      `${backend} refines enough to support a strict world-space hit test`
    )
  }
}

// Planar receivers use a mirrored scene projection with material response,
// while SSR explicitly leaves those pixels alone.
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const ssr = config.getSSRShader(backend)
    assert.ok(ssr.includes('u_reflectionViewProj'), `${backend} reprojects into mirrored camera`)
    assert.ok(ssr.includes('planarDistance'), `${backend} masks the designated plane`)
    assert.ok(ssr.includes('fresnelSchlick'), `${backend} uses Fresnel material response`)
    assert.ok(ssr.includes('samplePlanarReflection'), `${backend} samples the mirrored scene`)
    assert.ok(ssr.includes('u_planarEnabled'), `${backend} declares planar receiver suppression`)
    if (backend === 'wgsl') {
      assert.ok(
        ssr.includes('litUV') && ssr.includes('1.0 - uv0.y'),
        'WGSL distinguishes lit-target rows from mesh G-buffer rows'
      )
      assert.ok(
        ssr.includes('reflectionUV.y = 1.0 - reflectionUV.y'),
        'WGSL addresses mirrored lighting with WebGPU texture-row coordinates'
      )
    }
  }
}

// WGSL mesh vertex shader uses texture-based vertex fetching (matches GLSL)
{
  const config = new GBufferConfig(800, 600)
  const wgslVert = config.getMeshVertexShader('wgsl')
  assert.ok(typeof wgslVert === 'string', 'returns string')
  assert.ok(wgslVert.length > 100, 'non-trivial shader')
  assert.ok(wgslVert.includes('@vertex'), 'has @vertex entry point')
  assert.ok(wgslVert.includes('u_modelMatrix'), 'has model matrix uniform')
  assert.ok(wgslVert.includes('u_viewMatrix'), 'has view matrix uniform')
  assert.ok(wgslVert.includes('u_projectionMatrix'), 'has projection matrix uniform')
  assert.ok(wgslVert.includes('u_positions'), 'has positions texture')
  assert.ok(wgslVert.includes('u_meshTexWidth'), 'has mesh tex width')
  // Should use vertex_index, not attribute inputs
  assert.ok(wgslVert.includes('vertex_index'), 'uses vertex_index for texture fetch')
  assert.ok(!wgslVert.includes('@location(0) a_position'), 'no attribute inputs')
}

// Task 7: WGSL mesh fragment shader has proper MRT outputs
{
  const config = new GBufferConfig(800, 600)
  const wgslFrag = config.getMeshFragmentShader('wgsl')
  assert.ok(typeof wgslFrag === 'string', 'returns string')
  assert.ok(wgslFrag.length > 100, 'non-trivial shader')
  assert.ok(wgslFrag.includes('@fragment'), 'has @fragment entry point')
  assert.ok(wgslFrag.includes('u_baseColor'), 'has base color uniform')
  assert.ok(wgslFrag.includes('u_metallic'), 'has metallic uniform')
  assert.ok(wgslFrag.includes('u_roughness'), 'has roughness uniform')
  assert.ok(wgslFrag.includes('@location(0)'), 'has RT0 output')
  assert.ok(wgslFrag.includes('@location(1)'), 'has RT1 output')
  assert.ok(wgslFrag.includes('@location(2)'), 'has RT2 output')
  assert.ok(wgslFrag.includes('@location(3)'), 'has RT3 output')
}

// Surface UV transforms stay matched across the two mesh shaders
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const shader = config.getMeshFragmentShader(backend)
    assert.ok(shader.includes('u_uvScale'), `${backend} declares uvScale`)
    assert.ok(shader.includes('u_uvOffset'), `${backend} declares uvOffset`)
    assert.ok(shader.includes('fract('), `${backend} wraps transformed UVs`)
  }
}

// Mirrored geometry passes can clip fragments behind the reflector plane
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const shader = config.getMeshFragmentShader(backend)
    assert.ok(shader.includes('u_clipPlane'), `${backend} declares the world clip plane`)
    assert.ok(shader.includes('u_clipEnabled'), `${backend} can disable clipping for normal passes`)
    assert.ok(shader.includes('discard'), `${backend} discards the hidden half-space`)
  }
}

// Both lighting shaders bound roughness away from the GGX zero singularity
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const shader = config.getDeferredLightingShader(backend, 1)
    assert.ok(
      shader.includes('clamp(normalRoughness.a, 0.045, 1.0)'),
      `${backend} clamps G-buffer roughness before GGX`
    )
  }
}

// Environment lighting includes a specular IBL term. Without it, metallic
// materials have almost no ambient response and expose each direct light's
// NdotL terminator as a visible color band.
{
  const config = new GBufferConfig(800, 600)
  for (const backend of ['glsl', 'wgsl']) {
    const shader = config.getDeferredLightingShader(backend, 1)
    assert.ok(shader.includes('sampleEnvironmentSpecular'), `${backend} filters specular IBL`)
    assert.ok(shader.includes('ambientSpecular'), `${backend} adds specular IBL to ambient lighting`)
    assert.ok(shader.includes('ENV_SPECULAR_SAMPLES'), `${backend} uses a distributed specular kernel`)
  }
}

// Task 8: WGSL deferred lighting shader
{
  const config = new GBufferConfig(800, 600)
  const wgslLight = config.getDeferredLightingShader('wgsl', 2)
  assert.ok(typeof wgslLight === 'string', 'returns string')
  assert.ok(wgslLight.length > 200, 'non-trivial shader')
  assert.ok(wgslLight.includes('@fragment'), 'has @fragment entry point')
  assert.ok(wgslLight.includes('u_albedoMetallic'), 'reads albedo/metallic G-buffer')
  assert.ok(wgslLight.includes('u_normalRoughness'), 'reads normal/roughness G-buffer')
  assert.ok(wgslLight.includes('u_cameraPos'), 'has camera position')
  assert.ok(!wgslLight.includes('textureSample('),
    'WGSL lighting uses explicit LOD after the depth-dependent early return')
  // Directional light support (radius > 0.5 convention)
  assert.ok(wgslLight.includes('0.5'), 'has directional light threshold check')
}

// Task 8b: WGSL lighting shader with 1 light
{
  const config = new GBufferConfig(800, 600)
  const wgsl1 = config.getDeferredLightingShader('wgsl', 1)
  assert.ok(wgsl1.includes('@fragment'))
}

// Task 9: WGSL present shader
{
  const wgsl = presentShader('wgsl')
  assert.ok(typeof wgsl === 'string')
  assert.ok(wgsl.includes('@fragment'))
  assert.ok(wgsl.includes('textureSample'))
}

// Task 9: WGSL tonemap present shader
{
  const wgsl = tonemapPresentShader('wgsl')
  assert.ok(typeof wgsl === 'string')
  assert.ok(wgsl.includes('@fragment'))
  // Reinhard: hdr / (hdr + 1.0)
  assert.ok(wgsl.includes('1.0'), 'has tone mapping constant')
  // Gamma: pow with 2.2 or 0.4545
  assert.ok(wgsl.includes('2.2') || wgsl.includes('0.4545'), 'has gamma correction')
}

console.log('G-buffer tests passed')
