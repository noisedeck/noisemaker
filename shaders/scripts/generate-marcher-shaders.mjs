#!/usr/bin/env node
/**
 * generate-marcher-shaders.mjs — emit the legacy volumetric marcher shaders.
 *
 * `render/render3d` and `render/renderCubemap3d` share twelve functions and two
 * result structs, verbatim, in both shader languages; `render/renderCubemapSurface`
 * shares the atlas sampling pair out of that same set. That shared text lives in
 * `shaders/src/rendering/marcher-fragments.js`. This script assembles it with
 * each effect's bespoke parts — the file header, the uniform/binding block, its
 * own functions and `main()` — and writes the committed `.glsl` / `.wgsl` files.
 *
 * Emitter-owned effects, and why the fourth is not one. Shares are measured as
 * fragment lines present verbatim over total file lines, GLSL then WGSL:
 *
 *   render/render3d              337/441 and 332/429 — the emitter's template
 *   render/renderCubemap3d       337/431 and 332/423; only main() is its own
 *   render/renderCubemapSurface  46/128 and 48/130: atlasTexel, sampleVolume and
 *                                the MRT output block. It samples the raw field
 *                                along a ray and never traces an isosurface, so
 *                                the marcher-trace functions are not its to share
 *   render/renderLit3d           NOT emitter-owned. Measured verbatim overlap is
 *                                50/399 GLSL and 4/436 WGSL: its WGSL uses a
 *                                `Uniforms` struct with a `u.` accessor, the short
 *                                vec3f/vec3i spellings and its own vertex stage, so
 *                                not even atlasTexel or sampleVolume match the
 *                                shared text byte for byte. Bringing it under the
 *                                emitter would move ~830 bespoke lines into this
 *                                file to share 54, and would need a third
 *                                `getField` (its `invert` is a runtime uniform, not
 *                                a define) plus accessor interpolation in the
 *                                fragments — which would cost the verbatim property
 *                                the byte-compare gate rests on. The shell is
 *                                larger than the duplication it removes.
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

/** Every emitted GLSL file opens with this, directly under its header comment. */
const GLSL_PREAMBLE = `#version 300 es
precision highp float;`

/**
 * Per-effect recipe. `sections` is the file in order, one blank line between
 * each entry: shared entries are `GLSL_FRAGMENTS` / `WGSL_FRAGMENTS` values (or
 * a `marcherBody*` selection of them), bespoke entries are literal text. What
 * is not listed here is not in the file.
 * @type {ReadonlyArray<{effect: string, program: string, glsl: {header: string, sections: string[]}, wgsl: {header: string, sections: string[]}}>}
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
      sections: [
        `${GLSL_FRAGMENTS.defineNote}
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float time;
uniform float threshold;
uniform int volumeSize;
uniform int orbitSpeed;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;`,
        GLSL_FRAGMENTS.outputs,
        GLSL_FRAGMENTS.constants,
        marcherBodyGLSL(),
        `void main() {
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
      ],
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
      sections: [
        `${WGSL_FRAGMENTS.defineNote}
@group(0) @binding(0) var<uniform> resolution: vec2<f32>;
@group(0) @binding(1) var<uniform> time: f32;
@group(0) @binding(2) var<uniform> threshold: f32;
@group(0) @binding(3) var<uniform> volumeSize: i32;
@group(0) @binding(4) var<uniform> orbitSpeed: i32;
@group(0) @binding(5) var<uniform> bgColor: vec3<f32>;
@group(0) @binding(6) var<uniform> bgAlpha: f32;
@group(0) @binding(7) var volumeCache: texture_2d<f32>;
@group(0) @binding(8) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(9) var<uniform> fullResolution: vec2<f32>;`,
        WGSL_FRAGMENTS.constants,
        WGSL_FRAGMENTS.outputs,
        marcherBodyWGSL(),
        `@fragment
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
      ],
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
      sections: [
        `${GLSL_FRAGMENTS.defineNote}
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float threshold;
uniform int volumeSize;
uniform mat3 cubeBasis;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;`,
        GLSL_FRAGMENTS.outputs,
        GLSL_FRAGMENTS.constants,
        marcherBodyGLSL(),
        `void main() {
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
      ],
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
      sections: [
        `${WGSL_FRAGMENTS.defineNote}
@group(0) @binding(0) var<uniform> resolution: vec2<f32>;
@group(0) @binding(1) var<uniform> threshold: f32;
@group(0) @binding(2) var<uniform> volumeSize: i32;
@group(0) @binding(3) var<uniform> cubeBasis: mat3x3<f32>;
@group(0) @binding(4) var<uniform> bgColor: vec3<f32>;
@group(0) @binding(5) var<uniform> bgAlpha: f32;
@group(0) @binding(6) var volumeCache: texture_2d<f32>;
@group(0) @binding(7) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(8) var<uniform> fullResolution: vec2<f32>;`,
        WGSL_FRAGMENTS.constants,
        WGSL_FRAGMENTS.outputs,
        marcherBodyWGSL(),
        `@fragment
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
      ],
    },
  },
  {
    effect: 'render/renderCubemapSurface',
    program: 'renderCubemapSurface',
    glsl: {
      header: `/*
 * Cubemap surface sampler (GLSL) — renderCubemapSurface
 *
 * Samples a 3D volume (inputTex3d) along the per-face cube camera rays and shows
 * the RAW, TRUE color of the field exactly as sampled — front-to-back
 * emission/absorption, with NO lighting and NO gamma. (The lit isosurface/voxel
 * "blob in space" view lives in the sibling renderCubemap3d.)
 *
 * The volume's red channel drives per-step opacity; RGB is the emitted color.
 *
 * GENERATED FILE — do not edit. The atlas sampling below is the same text
 * render3d marches with, from shaders/src/rendering/marcher-fragments.js; edit a
 * fragment (or this effect's bespoke parts in
 * shaders/scripts/generate-marcher-shaders.mjs), then re-run the generator:
 * node shaders/scripts/generate-marcher-shaders.mjs
 */`,
      sections: [
        `uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform int volumeSize;
uniform mat3 cubeBasis;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;
uniform float density;
uniform float absorption;
uniform float emission;`,
        GLSL_FRAGMENTS.outputs,
        // No TAU/PI/MAX_DIST: this effect neither orbits nor reports a hit
        // distance, so it takes only the march's iteration count.
        `const int MAX_STEPS = 256;`,
        marcherBodyGLSL(['atlasIndex', 'sampleVolume']),
        // The same slab test isosurfaceTrace opens with, as a standalone vec2
        // return: nothing here marches a field, so the trace itself is not shared.
        `// Ray-box intersection against [-1,1]^3. Returns vec2(tEnter, tExit).
// result.y < 0 or result.x > result.y means no intersection.
vec2 intersectBox(vec3 ro, vec3 rd) {
    vec3 invRd = 1.0 / rd;
    vec3 t0 = (-1.0 - ro) * invRd;
    vec3 t1 = (1.0 - ro) * invRd;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tEnter = max(max(tmin.x, tmin.y), tmin.z);
    float tExit = min(min(tmax.x, tmax.y), tmax.z);
    if (tEnter > tExit || tExit < 0.0) {
        return vec2(-1.0);
    }
    return vec2(tEnter, tExit);
}`,
        `void main() {
    // Square face: uv in [-1,1], 90-degree frustum. Camera at the volume center.
    vec2 res = (fullResolution.x > 0.0) ? fullResolution : resolution;
    vec2 uv = ((gl_FragCoord.xy + tileOffset) - 0.5 * res) / (0.5 * res.y);
    vec3 ro = vec3(0.0);
    vec3 rd = normalize(cubeBasis * vec3(uv.x, -uv.y, 1.0));

    // Front-to-back emission/absorption. NO gamma, NO lighting: the raw field
    // color shows through exactly as sampled.
    vec3 col = vec3(0.0);
    float trans = 1.0;
    vec2 tb = intersectBox(ro, rd);
    if (tb.y > 0.0) {
        float t0 = max(tb.x, 0.0);
        float dt = (tb.y - t0) / float(MAX_STEPS);
        float t = t0;
        for (int i = 0; i < MAX_STEPS; i++) {
            vec4 s = sampleVolume(ro + rd * t);
            float a = 1.0 - exp(-s.r * density * absorption * dt);
            col += trans * a * s.rgb * emission;
            trans *= (1.0 - a);
            if (trans < 0.01) break;
            t += dt;
        }
    }
    vec3 outc = col + bgColor * trans;
    fragColor = vec4(outc, 1.0 - trans + bgAlpha * trans);
    geoOut = vec4(0.5, 0.5, 0.5, 1.0);
}`,
      ],
    },
    wgsl: {
      header: `/*
 * Cubemap surface sampler (WGSL) — renderCubemapSurface
 *
 * Samples a 3D volume (inputTex3d) along the per-face cube camera rays and shows
 * the RAW, TRUE color of the field exactly as sampled — front-to-back
 * emission/absorption, with NO lighting and NO gamma. (The lit isosurface/voxel
 * "blob in space" view lives in the sibling renderCubemap3d.)
 *
 * The volume's red channel drives per-step opacity; RGB is the emitted color.
 *
 * GENERATED FILE — do not edit. The atlas sampling below is the same text
 * render3d marches with, from shaders/src/rendering/marcher-fragments.js; edit a
 * fragment (or this effect's bespoke parts in
 * shaders/scripts/generate-marcher-shaders.mjs), then re-run the generator:
 * node shaders/scripts/generate-marcher-shaders.mjs
 */`,
      sections: [
        `@group(0) @binding(0) var<uniform> resolution: vec2<f32>;
@group(0) @binding(1) var<uniform> volumeSize: i32;
@group(0) @binding(2) var<uniform> cubeBasis: mat3x3<f32>;
@group(0) @binding(3) var<uniform> bgColor: vec3<f32>;
@group(0) @binding(4) var<uniform> bgAlpha: f32;
@group(0) @binding(5) var volumeCache: texture_2d<f32>;
@group(0) @binding(6) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(7) var<uniform> fullResolution: vec2<f32>;
@group(0) @binding(8) var<uniform> density: f32;
@group(0) @binding(9) var<uniform> absorption: f32;
@group(0) @binding(10) var<uniform> emission: f32;`,
        // No TAU/PI/MAX_DIST: this effect neither orbits nor reports a hit
        // distance, so it takes only the march's iteration count.
        `const MAX_STEPS: i32 = 256;`,
        WGSL_FRAGMENTS.outputs,
        marcherBodyWGSL(['atlasIndex', 'sampleVolume']),
        // The same slab test isosurfaceTrace opens with, as a standalone vec2
        // return: nothing here marches a field, so the trace itself is not shared.
        `// Ray-box intersection against [-1,1]^3. Returns vec2(tEnter, tExit).
// tb.y < 0 or tb.x > tb.y means no intersection.
fn intersectBox(ro: vec3<f32>, rd: vec3<f32>) -> vec2<f32> {
    let invRd = 1.0 / rd;
    let t0 = (-1.0 - ro) * invRd;
    let t1 = (1.0 - ro) * invRd;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let tEnter = max(max(tmin.x, tmin.y), tmin.z);
    let tExit = min(min(tmax.x, tmax.y), tmax.z);
    if (tEnter > tExit || tExit < 0.0) {
        return vec2<f32>(-1.0);
    }
    return vec2<f32>(tEnter, tExit);
}`,
        `@fragment
fn main(@builtin(position) position: vec4<f32>) -> FragmentOutput {
    // Square face: uv in [-1, 1], 90-degree frustum. Camera at the volume center.
    let res = select(resolution, fullResolution, fullResolution.x > 0.0);
    let uv = ((position.xy + tileOffset) - 0.5 * res) / (0.5 * res.y);
    let ro = vec3<f32>(0.0, 0.0, 0.0);
    let rd = normalize(cubeBasis * vec3<f32>(uv.x, -uv.y, 1.0));

    // Front-to-back emission/absorption. NO gamma, NO lighting: the raw field
    // color shows through exactly as sampled.
    var col = vec3<f32>(0.0);
    var trans = 1.0;
    let tb = intersectBox(ro, rd);
    if (tb.y > 0.0) {
        let t0 = max(tb.x, 0.0);
        let dt = (tb.y - t0) / f32(MAX_STEPS);
        var t = t0;
        for (var i = 0; i < MAX_STEPS; i = i + 1) {
            let s = sampleVolume(ro + rd * t);
            let a = 1.0 - exp(-s.r * density * absorption * dt);
            col = col + trans * a * s.rgb * emission;
            trans = trans * (1.0 - a);
            if (trans < 0.01) { break; }
            t = t + dt;
        }
    }
    let outc = col + bgColor * trans;
    var output: FragmentOutput;
    output.color = vec4<f32>(outc, 1.0 - trans + bgAlpha * trans);
    output.geoOut = vec4<f32>(0.5, 0.5, 0.5, 1.0);
    return output;
}`,
      ],
    },
  },
])

/**
 * Assemble one effect's GLSL file: header, preamble, then its sections.
 * @param {{header: string, sections: string[]}} recipe
 * @returns {string}
 */
export function emitGLSL(recipe) {
  return [recipe.header, GLSL_PREAMBLE, ...recipe.sections].join('\n\n') + '\n'
}

/**
 * Assemble one effect's WGSL file: header, then its sections. WGSL has no
 * version/precision preamble.
 * @param {{header: string, sections: string[]}} recipe
 * @returns {string}
 */
export function emitWGSL(recipe) {
  return [recipe.header, ...recipe.sections].join('\n\n') + '\n'
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
