/*
 * Stipple - discrete random marks reproducing image tone. See
 * stipple.glsl for the full algorithm derivation and mode
 * mapping; this is a 1:1 port.
 *
 * tileOffset converts tile-local positions into global procedural
 * coordinates and converts each global pointillize seed back into the local
 * input texture. It is zero for ordinary full-frame renders.
 *
 * mezzoStrokes's 45-degree rotation matches GLSL's column-major
 * mat2(c,-s,s,c) multiplication numerically so the marks keep the same
 * presented slope on both backends. Every noise/hash helper below is built from WGSL's
 * `floor`/`fract`, which - like GLSL's - are floor-based (not
 * truncated) for negative inputs, so the negative positions the
 * rotation can produce need no separate floored-mod wrap.
 *
 * MODE is a compile-time const injected by the runtime via injectDefines
 * (see definition.js `globals.mode.define`). Same fix as the GLSL
 * backend - collapses the 5-way mode dispatch so it constant-folds
 * instead of branching on a runtime uniform. The old `mode` field is
 * removed from Uniforms; the packer maps the remaining fields by name to
 * recomputed byte offsets, so removal is safe.
 */

struct Uniforms {
    cellSize: f32,
    grainSize: f32,
    density: f32,
    paperColor: vec3<f32>,
    seed: i32,
    tileOffset: vec2<f32>,
}

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

// hash - hash / jitter.
fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + vec3<f32>(33.33));
    return fract((p3.x + p3.y) * p3.z);
}

// Jitter hash for the Voronoi grid. Integer-only for cross-compiler
// determinism; see stipple.glsl for why the fract-based form diverged.
fn hash22(p: vec2<i32>, sd: i32) -> vec2<f32> {
    var v = bitcast<vec2<u32>>(p + vec2<i32>(32767)) ^ vec2<u32>(bitcast<u32>(sd) * 2654435761u);
    v = v * 1664525u + vec2<u32>(1013904223u);
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= (v >> vec2<u32>(16u));
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= (v >> vec2<u32>(16u));
    return vec2<f32>(v) * (1.0 / 4294967296.0);
}

// luminance - luminance.
fn lum(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// value noise - value noise + fBm.
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash12(i + vec2<f32>(0.0, 1.0)), hash12(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

fn fbm(p_in: vec2<f32>) -> f32 {
    var p = p_in;
    var v = 0.0;
    var a = 0.5;
    for (var i = 0; i < 5; i++) {
        v += a * vnoise(p);
        p *= 2.03;
        a *= 0.5;
    }
    return v;
}

// Voronoi - jittered-grid Voronoi cell: returns xy = seed point in the same
// cell-space units as `p`, zw = integer cell id.
fn voronoiCell(p: vec2<f32>, jitter: f32, seedVal: f32) -> vec4<f32> {
    let g = floor(p);
    let f = p - g;
    var best = 1e9;
    var res = vec4<f32>(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let cell = vec2<f32>(f32(x), f32(y));
            let pt = cell + 0.5 + (hash22(vec2<i32>(g + cell), i32(seedVal)) - 0.5) * jitter;
            let d = dot(pt - f, pt - f);
            if (d < best) {
                best = d;
                res = vec4<f32>(g + pt, g + cell);
            }
        }
    }
    return res;
}

// ink/paper tonemapping - ink/paper tonemap.
fn tonemap2(t: f32, ink: vec3<f32>, paper: vec3<f32>) -> vec3<f32> {
    return mix(ink, paper, clamp(t, 0.0, 1.0));
}

// Numeric expansion of GLSL mat2(co,-si,si,co) * v.
fn rotate2D(v: vec2<f32>, angleDeg: f32) -> vec2<f32> {
    let a = radians(angleDeg);
    let co = cos(a);
    let si = sin(a);
    return vec2<f32>(co * v.x + si * v.y, -si * v.x + co * v.y);
}

@fragment
fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let texSize = vec2<f32>(textureDimensions(inputTex));
    let globalCoord = pos.xy + uniforms.tileOffset;
    let uv = pos.xy / texSize;
    let alpha = textureSample(inputTex, inputSampler, uv).a;
    var result: vec3<f32>;

    if (MODE == 0) {
        // Pointillize.
        let p = globalCoord / uniforms.cellSize;
        let cell = voronoiCell(p, 0.9, f32(uniforms.seed));
        let seedGc = cell.xy * uniforms.cellSize;
        let seedUV = clamp((seedGc - uniforms.tileOffset) / texSize,
            vec2<f32>(0.0), vec2<f32>(1.0));
        let seedColor = textureSample(inputTex, inputSampler, seedUV).rgb;
        let radius = 0.35 + 0.4 * (1.0 - lum(seedColor));
        let d = length(p - cell.xy);
        let aa = max(fwidth(d) * 1.5, 0.00001);
        let inside = 1.0 - smoothstep(radius - aa, radius + aa, d);
        result = mix(uniforms.paperColor, seedColor, inside);
    } else if (MODE == 1 || MODE == 2 || MODE == 3) {
        // Mezzotint dots/lines/strokes.
        var gc = globalCoord;
        if (MODE == 3) {
            gc = rotate2D(gc, 45.0);
        }
        var noiseP: vec2<f32>;
        if (MODE == 1) {
            noiseP = gc / uniforms.grainSize;
        } else {
            // See stipple.glsl: Y keeps the coarse scale, X the fine
            // scale, so streaks run vertically.
            noiseP = gc * vec2<f32>(1.0 / uniforms.grainSize, 1.0 / (uniforms.grainSize * 8.0));
        }
        var n = vnoise(noiseP + f32(uniforms.seed) * 101.7);
        n = n + (uniforms.density - 50.0) / 100.0;
        let src = textureSample(inputTex, inputSampler, uv).rgb;
        result = vec3<f32>(step(n, src.r), step(n, src.g), step(n, src.b));
    } else {
        // Reticulation.
        let src = textureSample(inputTex, inputSampler, uv).rgb;
        let l = lum(src);
        var clumpNoise = fbm(globalCoord / (uniforms.grainSize * 4.0) + f32(uniforms.seed) * 101.7) * mix(1.2, 0.6, l);
        clumpNoise = clumpNoise + (uniforms.density - 50.0) / 100.0;
        result = tonemap2(step(clumpNoise, l), vec3<f32>(0.05), vec3<f32>(0.97));
    }

    return vec4<f32>(result, alpha);
}
