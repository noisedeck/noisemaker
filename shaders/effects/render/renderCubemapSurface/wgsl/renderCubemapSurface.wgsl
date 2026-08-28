/*
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
 */

@group(0) @binding(0) var<uniform> resolution: vec2<f32>;
@group(0) @binding(1) var<uniform> volumeSize: i32;
@group(0) @binding(2) var<uniform> cubeBasis: mat3x3<f32>;
@group(0) @binding(3) var<uniform> bgColor: vec3<f32>;
@group(0) @binding(4) var<uniform> bgAlpha: f32;
@group(0) @binding(5) var volumeCache: texture_2d<f32>;
@group(0) @binding(6) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(7) var<uniform> fullResolution: vec2<f32>;
@group(0) @binding(8) var<uniform> density: f32;
@group(0) @binding(9) var<uniform> absorption: f32;
@group(0) @binding(10) var<uniform> emission: f32;

const MAX_STEPS: i32 = 256;

// MRT output structure for color and geometry buffer
struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @location(1) geoOut: vec4<f32>,
}

// Convert 3D volume coordinates to 2D atlas texel coordinates
fn volumeToAtlas(x: i32, y: i32, z: i32, volSize: i32) -> vec2<i32> {
    return vec2<i32>(x, y + z * volSize);
}

// Sample the cached 3D volume with trilinear interpolation
// World position p is in [-1, 1]^3 (bounding box coordinates)
fn sampleVolume(worldPos: vec3<f32>) -> vec4<f32> {
    let volSize = volumeSize;
    let volSizeF = f32(volSize);

    // Convert world position [-1, 1] to normalized volume coords [0, 1]
    var uvw = worldPos * 0.5 + 0.5;
    uvw = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0));

    // Convert to texel coordinates
    let texelPos = uvw * (volSizeF - 1.0);
    let texelFloor = floor(texelPos);
    let frac = texelPos - texelFloor;

    let i0 = vec3<i32>(texelFloor);
    let i1 = min(i0 + 1, vec3<i32>(volSize - 1));

    // Trilinear filtering - load 8 corners
    let c000 = textureLoad(volumeCache, volumeToAtlas(i0.x, i0.y, i0.z, volSize), 0);
    let c100 = textureLoad(volumeCache, volumeToAtlas(i1.x, i0.y, i0.z, volSize), 0);
    let c010 = textureLoad(volumeCache, volumeToAtlas(i0.x, i1.y, i0.z, volSize), 0);
    let c110 = textureLoad(volumeCache, volumeToAtlas(i1.x, i1.y, i0.z, volSize), 0);
    let c001 = textureLoad(volumeCache, volumeToAtlas(i0.x, i0.y, i1.z, volSize), 0);
    let c101 = textureLoad(volumeCache, volumeToAtlas(i1.x, i0.y, i1.z, volSize), 0);
    let c011 = textureLoad(volumeCache, volumeToAtlas(i0.x, i1.y, i1.z, volSize), 0);
    let c111 = textureLoad(volumeCache, volumeToAtlas(i1.x, i1.y, i1.z, volSize), 0);

    // Trilinear interpolation
    let c00 = mix(c000, c100, frac.x);
    let c10 = mix(c010, c110, frac.x);
    let c01 = mix(c001, c101, frac.x);
    let c11 = mix(c011, c111, frac.x);

    let c0 = mix(c00, c10, frac.y);
    let c1 = mix(c01, c11, frac.y);

    return mix(c0, c1, frac.z);
}

// Ray-box intersection against [-1,1]^3. Returns vec2(tEnter, tExit).
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
}

@fragment
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
}
