import assert from 'assert'
import { presentShader, tonemapPresentShader } from '../src/rendering/post-shaders.js'

// Present shader (GLSL)
{
  const src = presentShader('glsl')
  assert.ok(src.includes('u_texture'), 'has texture uniform')
  assert.ok(src.includes('fragColor'), 'writes fragColor')
}

// Present shader (WGSL)
{
  const src = presentShader('wgsl')
  assert.ok(src.includes('@fragment'), 'has @fragment entry point')
  assert.ok(src.includes('textureSample'), 'uses textureSample')
}

// Tonemap present shader (GLSL)
{
  const src = tonemapPresentShader('glsl')
  assert.ok(src.includes('u_texture'), 'has texture uniform')
  assert.ok(src.includes('1.0'), 'has Reinhard constant')
  assert.ok(src.includes('2.2'), 'has gamma constant')
}

// Tonemap present shader (WGSL)
{
  const src = tonemapPresentShader('wgsl')
  assert.ok(src.includes('@fragment'), 'has @fragment entry point')
  assert.ok(src.includes('2.2'), 'has gamma constant')
}

console.log('Post shader tests passed')
