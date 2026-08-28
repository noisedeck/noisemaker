#!/usr/bin/env node
/**
 * generate-marcher-shaders.mjs — emit the legacy volumetric marcher shaders.
 *
 * `render/render3d` and `render/renderCubemap3d` share twelve functions and two
 * result structs, verbatim, in both shader languages. That shared body lives in
 * `shaders/src/rendering/marcher-fragments.js`. This script assembles it with
 * each effect's bespoke parts — the file header, the uniform/binding block, and
 * `main()` — and writes the committed `.glsl` / `.wgsl` files.
 *
 * The files stay on disk on purpose: the shader manifest, the bundler's
 * minification, the parity-attestation source hash and its CI change-detector,
 * `validateWgslTextureBindings`, the gauntlet, the shade MCP source tools and
 * the browser's lazy per-program fetch all read them from there.
 *
 *   node shaders/scripts/generate-marcher-shaders.mjs              # write in place
 *   node shaders/scripts/generate-marcher-shaders.mjs --check      # fail on drift
 *   node shaders/scripts/generate-marcher-shaders.mjs --out-dir X  # write elsewhere
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GLSL_FRAGMENTS,
  WGSL_FRAGMENTS,
  marcherBodyGLSL,
  marcherBodyWGSL,
} from '../src/rendering/marcher-fragments.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Per-effect bespoke source. Everything not listed here is shared and comes
 * from marcher-fragments.js.
 * @type {ReadonlyArray<{effect: string, program: string, glsl: {header: string, uniforms: string, main: string}, wgsl: {header: string, uniforms: string, main: string}}>}
 */
export const MARCHER_RECIPES = Object.freeze([
  {
    effect: 'render/render3d',
    program: 'render3d',
    glsl: {
      header: `/*
 * Universal 3D volume renderer (GLSL)
 * 
 * This shader provides common raymarching logic extracted from all 3D effects.
 * It supports both isosurface (smooth) and voxel (blocky) rendering modes.
 * 
 * The volume is sampled from the red channel (.r) for the density/SDF field.
 * RGB channels are used for coloring in non-mono modes.
 *
 * GENERATED FILE — do not edit. The shared marcher body below comes from
 * shaders/src/rendering/marcher-fragments.js; edit a fragment (or this effect's
 * bespoke parts in shaders/scripts/generate-marcher-shaders.mjs), then re-run
 * the generator: node shaders/scripts/generate-marcher-shaders.mjs
 */`,
      uniforms: `uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float time;
uniform float threshold;
uniform int volumeSize;
uniform int orbitSpeed;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;`,
      main: `void main() {
    vec2 fullRes = fullResolution.x > 0.0 ? fullResolution : resolution;
    if (fullRes.x < 1.0) fullRes = vec2(1024.0, 1024.0);

    // Use global pixel coord so each tile casts the correct view ray
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec2 uv = (globalCoord - 0.5 * fullRes) / fullRes.y;
    
    // Camera setup - orbiting view
    float camDist = 3.5;
    float angle = time * TAU * float(orbitSpeed);
    vec3 ro = vec3(sin(angle) * camDist, 0.5, cos(angle) * camDist);
    vec3 lookAt = vec3(0.0);
    
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
    vec3 up = cross(forward, right);
    
    vec3 rd = normalize(forward + uv.x * right + uv.y * up);
    
    vec3 color;
    vec3 normal = vec3(0.0, 0.0, 1.0);  // Default normal (facing camera)
    float depth = 1.0;  // Default depth (far)
    float alpha = 1.0;
    
    // FILTERING is a compile-time #define; the optimizer eliminates the
    // unused raymarching path.
    if (FILTERING == 1) {
        // Voxel mode - use DDA traversal
        VoxelHit hit = voxelTrace(ro, rd);
        if (hit.dist > 0.0) {
            vec3 p = ro + rd * hit.dist;
            color = shadeVoxel(p, rd, hit.normal, hit.voxel);
            normal = hit.normal;
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    } else {
        // Smooth mode - analytic isosurface raymarching
        IsoHit hit = isosurfaceTrace(ro, rd);
        if (hit.hit) {
            color = shade(hit.pos, rd);
            normal = calcNormal(hit.pos);
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    }
    
    // Gamma correction
    color = pow(color, vec3(1.0 / 2.2));
    
    fragColor = vec4(color, alpha);
    // Geometry buffer: RGB = normal (remapped to 0-1), A = depth
    geoOut = vec4(normal * 0.5 + 0.5, depth);
}`,
    },
    wgsl: {
      header: `/*
 * Universal 3D volume renderer (WGSL)
 * 
 * This shader provides common raymarching logic extracted from all 3D effects.
 * It supports both isosurface (smooth) and voxel (blocky) rendering modes.
 * 
 * The volume is sampled from the red channel (.r) for the density/SDF field.
 * RGB channels are used for coloring.
 *
 * GENERATED FILE — do not edit. The shared marcher body below comes from
 * shaders/src/rendering/marcher-fragments.js; edit a fragment (or this effect's
 * bespoke parts in shaders/scripts/generate-marcher-shaders.mjs), then re-run
 * the generator: node shaders/scripts/generate-marcher-shaders.mjs
 */`,
      uniforms: `@group(0) @binding(0) var<uniform> resolution: vec2<f32>;
@group(0) @binding(1) var<uniform> time: f32;
@group(0) @binding(2) var<uniform> threshold: f32;
@group(0) @binding(3) var<uniform> volumeSize: i32;
@group(0) @binding(4) var<uniform> orbitSpeed: i32;
@group(0) @binding(5) var<uniform> bgColor: vec3<f32>;
@group(0) @binding(6) var<uniform> bgAlpha: f32;
@group(0) @binding(7) var volumeCache: texture_2d<f32>;
@group(0) @binding(8) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(9) var<uniform> fullResolution: vec2<f32>;`,
      main: `@fragment
fn main(@builtin(position) position: vec4<f32>) -> FragmentOutput {
    var fullRes = select(resolution, fullResolution, fullResolution.x > 0.0);
    if (fullRes.x < 1.0) { fullRes = vec2<f32>(1024.0, 1024.0); }

    let uv = ((position.xy + tileOffset) - 0.5 * fullRes) / fullRes.y;

    let camAngle = time * TAU * f32(orbitSpeed);
    let camDist: f32 = 3.5;
    let ro = vec3<f32>(sin(camAngle) * camDist, 0.5, cos(camAngle) * camDist);
    let lookAt = vec3<f32>(0.0);
    
    let forward = normalize(lookAt - ro);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), forward));
    let up = cross(forward, right);
    
    let rd = normalize(forward + uv.x * right + uv.y * up);
    
    var color: vec3<f32>;
    var normal = vec3<f32>(0.0, 0.0, 1.0);
    var depth: f32 = 1.0;
    var alpha: f32 = 1.0;
    
    // FILTERING is a compile-time const; the optimizer eliminates the
    // unused raymarching path entirely.
    if (FILTERING == 1) {
        let hit = voxelTrace(ro, rd);
        if (hit.dist > 0.0) {
            let p = ro + rd * hit.dist;
            color = shadeVoxel(p, rd, hit.normal, hit.voxel);
            normal = hit.normal;
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    } else {
        let hit = isosurfaceTrace(ro, rd);
        if (hit.hit) {
            color = shade(hit.pos, rd);
            normal = calcNormal(hit.pos);
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    }
    
    color = pow(color, vec3<f32>(1.0 / 2.2));
    
    var output: FragmentOutput;
    output.color = vec4<f32>(color, alpha);
    output.geoOut = vec4<f32>(normal * 0.5 + 0.5, depth);
    return output;
}`,
    },
  },
  {
    effect: 'render/renderCubemap3d',
    program: 'renderCubemap3d',
    glsl: {
      header: `/*
 * Cubemap 3D volume renderer (GLSL) — renderCubemap3d
 *
 * A multi-face clone of render3d: the lit "blob in space" projected onto cube
 * faces. Same isosurface/voxel raymarching and shading as render3d (including
 * gamma) — only the orbit camera is replaced by the per-face cube camera
 * (cubeBasis, 90-degree frustum from the volume center).
 *
 * The volume is sampled from the red channel (.r) for the density/SDF field.
 * RGB channels are used for coloring in non-mono modes.
 *
 * GENERATED FILE — do not edit. The shared marcher body below comes from
 * shaders/src/rendering/marcher-fragments.js; edit a fragment (or this effect's
 * bespoke parts in shaders/scripts/generate-marcher-shaders.mjs), then re-run
 * the generator: node shaders/scripts/generate-marcher-shaders.mjs
 */`,
      uniforms: `uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float threshold;
uniform int volumeSize;
uniform mat3 cubeBasis;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;`,
      main: `void main() {
    // Square face: uv in [-1,1], 90-degree frustum. Camera at the volume center,
    // looking out along the per-face basis (cubeBasis). Replaces render3d's orbit.
    vec2 fullRes = fullResolution.x > 0.0 ? fullResolution : resolution;
    if (fullRes.x < 1.0) fullRes = vec2(1024.0, 1024.0);
    vec2 uv = ((gl_FragCoord.xy + tileOffset) - 0.5 * fullRes) / (0.5 * fullRes.y);
    vec3 ro = vec3(0.0);
    vec3 rd = normalize(cubeBasis * vec3(uv.x, -uv.y, 1.0));
    
    vec3 color;
    vec3 normal = vec3(0.0, 0.0, 1.0);  // Default normal (facing camera)
    float depth = 1.0;  // Default depth (far)
    float alpha = 1.0;
    
    // FILTERING is a compile-time #define; the optimizer eliminates the
    // unused raymarching path.
    if (FILTERING == 1) {
        // Voxel mode - use DDA traversal
        VoxelHit hit = voxelTrace(ro, rd);
        if (hit.dist > 0.0) {
            vec3 p = ro + rd * hit.dist;
            color = shadeVoxel(p, rd, hit.normal, hit.voxel);
            normal = hit.normal;
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    } else {
        // Smooth mode - analytic isosurface raymarching
        IsoHit hit = isosurfaceTrace(ro, rd);
        if (hit.hit) {
            color = shade(hit.pos, rd);
            normal = calcNormal(hit.pos);
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    }
    
    // Gamma correction
    color = pow(color, vec3(1.0 / 2.2));
    
    fragColor = vec4(color, alpha);
    // Geometry buffer: RGB = normal (remapped to 0-1), A = depth
    geoOut = vec4(normal * 0.5 + 0.5, depth);
}`,
    },
    wgsl: {
      header: `/*
 * Cubemap 3D volume renderer (WGSL) — renderCubemap3d
 *
 * A multi-face clone of render3d: the lit "blob in space" projected onto cube
 * faces. Same isosurface/voxel raymarching and shading as render3d (including
 * gamma) — only the orbit camera is replaced by the per-face cube camera
 * (cubeBasis, 90-degree frustum from the volume center).
 *
 * The volume is sampled from the red channel (.r) for the density/SDF field.
 * RGB channels are used for coloring.
 *
 * GENERATED FILE — do not edit. The shared marcher body below comes from
 * shaders/src/rendering/marcher-fragments.js; edit a fragment (or this effect's
 * bespoke parts in shaders/scripts/generate-marcher-shaders.mjs), then re-run
 * the generator: node shaders/scripts/generate-marcher-shaders.mjs
 */`,
      uniforms: `@group(0) @binding(0) var<uniform> resolution: vec2<f32>;
@group(0) @binding(1) var<uniform> threshold: f32;
@group(0) @binding(2) var<uniform> volumeSize: i32;
@group(0) @binding(3) var<uniform> cubeBasis: mat3x3<f32>;
@group(0) @binding(4) var<uniform> bgColor: vec3<f32>;
@group(0) @binding(5) var<uniform> bgAlpha: f32;
@group(0) @binding(6) var volumeCache: texture_2d<f32>;
@group(0) @binding(7) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(8) var<uniform> fullResolution: vec2<f32>;`,
      main: `@fragment
fn main(@builtin(position) position: vec4<f32>) -> FragmentOutput {
    // Square face: uv in [-1,1], 90-degree frustum. Camera at the volume center,
    // looking out along the per-face basis (cubeBasis). Replaces render3d's orbit.
    var fullRes = select(resolution, fullResolution, fullResolution.x > 0.0);
    if (fullRes.x < 1.0) { fullRes = vec2<f32>(1024.0, 1024.0); }

    let uv = ((position.xy + tileOffset) - 0.5 * fullRes) / (0.5 * fullRes.y);
    let ro = vec3<f32>(0.0);
    let rd = normalize(cubeBasis * vec3<f32>(uv.x, -uv.y, 1.0));
    
    var color: vec3<f32>;
    var normal = vec3<f32>(0.0, 0.0, 1.0);
    var depth: f32 = 1.0;
    var alpha: f32 = 1.0;
    
    // FILTERING is a compile-time const; the optimizer eliminates the
    // unused raymarching path entirely.
    if (FILTERING == 1) {
        let hit = voxelTrace(ro, rd);
        if (hit.dist > 0.0) {
            let p = ro + rd * hit.dist;
            color = shadeVoxel(p, rd, hit.normal, hit.voxel);
            normal = hit.normal;
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    } else {
        let hit = isosurfaceTrace(ro, rd);
        if (hit.hit) {
            color = shade(hit.pos, rd);
            normal = calcNormal(hit.pos);
            depth = hit.dist / MAX_DIST;
        } else {
            color = bgColor;
            alpha = bgAlpha;
        }
    }
    
    color = pow(color, vec3<f32>(1.0 / 2.2));
    
    var output: FragmentOutput;
    output.color = vec4<f32>(color, alpha);
    output.geoOut = vec4<f32>(normal * 0.5 + 0.5, depth);
    return output;
}`,
    },
  },
])

/**
 * Assemble one effect's GLSL file.
 * @param {{header: string, uniforms: string, main: string}} bespoke
 * @returns {string}
 */
export function emitGLSL(bespoke) {
  return [
    bespoke.header,
    '',
    '#version 300 es',
    'precision highp float;',
    '',
    GLSL_FRAGMENTS.defineNote,
    bespoke.uniforms,
    '',
    GLSL_FRAGMENTS.outputs,
    '',
    GLSL_FRAGMENTS.constants,
    '',
    marcherBodyGLSL(),
    '',
    bespoke.main,
  ].join('\n') + '\n'
}

/**
 * Assemble one effect's WGSL file.
 * @param {{header: string, uniforms: string, main: string}} bespoke
 * @returns {string}
 */
export function emitWGSL(bespoke) {
  return [
    bespoke.header,
    '',
    WGSL_FRAGMENTS.defineNote,
    bespoke.uniforms,
    '',
    WGSL_FRAGMENTS.constants,
    '',
    WGSL_FRAGMENTS.outputs,
    '',
    marcherBodyWGSL(),
    '',
    bespoke.main,
  ].join('\n') + '\n'
}

/**
 * Every file this generator owns, with its emitted content.
 * @returns {Array<{path: string, source: string}>} paths are repo-relative, POSIX-separated
 */
export function generatedMarcherShaders() {
  const files = []
  for (const recipe of MARCHER_RECIPES) {
    files.push({
      path: `shaders/effects/${recipe.effect}/glsl/${recipe.program}.glsl`,
      source: emitGLSL(recipe.glsl),
    })
    files.push({
      path: `shaders/effects/${recipe.effect}/wgsl/${recipe.program}.wgsl`,
      source: emitWGSL(recipe.wgsl),
    })
  }
  return files
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const checkOnly = process.argv.includes('--check')
  const outDirIndex = process.argv.indexOf('--out-dir')
  const outDir = outDirIndex === -1 ? repoRoot : path.resolve(process.argv[outDirIndex + 1])
  let drift = 0

  for (const file of generatedMarcherShaders()) {
    const target = path.join(outDir, file.path)
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
    if (checkOnly) {
      if (current !== file.source) {
        console.error(`DRIFT: ${file.path} differs from the generator output`)
        drift++
      }
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.source)
    console.log(`${current === file.source ? 'unchanged' : 'wrote    '} ${file.path}`)
  }

  if (checkOnly) {
    if (drift > 0) {
      console.error(`${drift} generated shader file(s) are out of date. Run: node shaders/scripts/generate-marcher-shaders.mjs`)
      process.exit(1)
    }
    console.log('All generated marcher shaders match the fragments.')
  }
}
