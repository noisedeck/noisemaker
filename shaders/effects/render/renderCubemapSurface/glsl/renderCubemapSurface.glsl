/*
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
 */

#version 300 es
precision highp float;

uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform int volumeSize;
uniform mat3 cubeBasis;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;
uniform float density;
uniform float absorption;
uniform float emission;

// MRT outputs: color and geometry buffer
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 geoOut;

const int MAX_STEPS = 256;

// Helper to convert 3D texel coords to 2D atlas texel coords
ivec2 atlasTexel(ivec3 p, int volSize) {
    return ivec2(p.x, p.y + p.z * volSize);
}

// Sample the cached 3D volume with trilinear interpolation
// World position p is in [-1, 1]^3 (bounding box coordinates)
vec4 sampleVolume(vec3 worldPos) {
    int volSize = volumeSize;
    float volSizeF = float(volSize);

    // Convert world position [-1, 1] to normalized volume coords [0, 1]
    vec3 uvw = worldPos * 0.5 + 0.5;
    uvw = clamp(uvw, 0.0, 1.0);

    // Convert to texel coordinates
    vec3 texelPos = uvw * (volSizeF - 1.0);
    vec3 texelFloor = floor(texelPos);
    vec3 frac = texelPos - texelFloor;

    ivec3 i0 = ivec3(texelFloor);
    ivec3 i1 = min(i0 + 1, volSize - 1);

    // Trilinear filtering - sample all 8 corners
    vec4 c000 = texelFetch(volumeCache, atlasTexel(ivec3(i0.x, i0.y, i0.z), volSize), 0);
    vec4 c100 = texelFetch(volumeCache, atlasTexel(ivec3(i1.x, i0.y, i0.z), volSize), 0);
    vec4 c010 = texelFetch(volumeCache, atlasTexel(ivec3(i0.x, i1.y, i0.z), volSize), 0);
    vec4 c110 = texelFetch(volumeCache, atlasTexel(ivec3(i1.x, i1.y, i0.z), volSize), 0);
    vec4 c001 = texelFetch(volumeCache, atlasTexel(ivec3(i0.x, i0.y, i1.z), volSize), 0);
    vec4 c101 = texelFetch(volumeCache, atlasTexel(ivec3(i1.x, i0.y, i1.z), volSize), 0);
    vec4 c011 = texelFetch(volumeCache, atlasTexel(ivec3(i0.x, i1.y, i1.z), volSize), 0);
    vec4 c111 = texelFetch(volumeCache, atlasTexel(ivec3(i1.x, i1.y, i1.z), volSize), 0);

    // Trilinear interpolation
    vec4 c00 = mix(c000, c100, frac.x);
    vec4 c10 = mix(c010, c110, frac.x);
    vec4 c01 = mix(c001, c101, frac.x);
    vec4 c11 = mix(c011, c111, frac.x);

    vec4 c0 = mix(c00, c10, frac.y);
    vec4 c1 = mix(c01, c11, frac.y);

    return mix(c0, c1, frac.z);
}

// Ray-box intersection against [-1,1]^3. Returns vec2(tEnter, tExit).
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
}

void main() {
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
}
