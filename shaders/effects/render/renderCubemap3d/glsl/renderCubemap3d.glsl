/*
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
 */

#version 300 es
precision highp float;

// FILTERING and INVERT are compile-time #defines injected by the expander
// (see definition.js). Baking them lets the compiler eliminate the unused
// raymarching path and the per-sample invert branch.
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float threshold;
uniform int volumeSize;
uniform mat3 cubeBasis;
uniform vec3 bgColor;
uniform float bgAlpha;
uniform sampler2D volumeCache;

// MRT outputs: color and geometry buffer
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 geoOut;

const float TAU = 6.283185307179586;
const float PI = 3.141592653589793;
const int MAX_STEPS = 256;
const float MAX_DIST = 10.0;

// Helper to convert 3D texel coords to 2D atlas texel coords
ivec2 atlasTexel(ivec3 p, int volSize) {
    return ivec2(p.x, p.y + p.z * volSize);
}

// Sample volume at integer voxel coordinates (for voxel mode)
vec4 sampleVoxel(ivec3 voxel) {
    int volSize = volumeSize;
    ivec3 clamped = clamp(voxel, ivec3(0), ivec3(volSize - 1));
    return texelFetch(volumeCache, atlasTexel(clamped, volSize), 0);
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

// Get the scalar field value at a point. INVERT is a compile-time #define;
// the optimizer drops the dead branch.
float getField(vec3 p) {
    float val = sampleVolume(p).r;
    if (INVERT) {
        val = 1.0 - val;
    }
    return threshold - val;
}

bool isVoxelSolid(ivec3 voxel) {
    float val = sampleVoxel(voxel).r;
    if (INVERT) {
        val = 1.0 - val;
    }
    return val > threshold;
}

// Convert world position to voxel coordinates
ivec3 worldToVoxel(vec3 worldPos) {
    int volSize = volumeSize;
    vec3 uvw = worldPos * 0.5 + 0.5;  // [-1,1] -> [0,1]
    return ivec3(floor(uvw * float(volSize)));
}

// Convert voxel coordinates to world position (center of voxel)
vec3 voxelToWorld(ivec3 voxel) {
    int volSize = volumeSize;
    vec3 uvw = (vec3(voxel) + 0.5) / float(volSize);  // center of voxel in [0,1]
    return uvw * 2.0 - 1.0;  // [0,1] -> [-1,1]
}

// DDA voxel traversal - returns hit distance and face normal
struct VoxelHit {
    float dist;
    vec3 normal;
    ivec3 voxel;
};

VoxelHit voxelTrace(vec3 ro, vec3 rd) {
    VoxelHit result;
    result.dist = -1.0;
    result.normal = vec3(0.0);
    result.voxel = ivec3(0);

    int volSize = volumeSize;
    float voxelSize = 2.0 / float(volSize);  // world-space size of one voxel

    // Ray-box intersection with the volume bounds [-1, 1]
    vec3 invRd = 1.0 / rd;
    vec3 t0 = (-1.0 - ro) * invRd;
    vec3 t1 = (1.0 - ro) * invRd;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tEnter = max(max(tmin.x, tmin.y), tmin.z);
    float tExit = min(min(tmax.x, tmax.y), tmax.z);

    if (tEnter > tExit || tExit < 0.0) {
        return result;  // No intersection with volume
    }

    // Start position (slightly inside the volume)
    float tStart = max(tEnter + 0.001, 0.0);
    vec3 pos = ro + rd * tStart;

    // Current voxel
    ivec3 voxel = worldToVoxel(pos);
    voxel = clamp(voxel, ivec3(0), ivec3(volSize - 1));

    // Step direction
    ivec3 step = ivec3(sign(rd));

    // Distance to next voxel boundary in each axis
    vec3 voxelBounds = voxelToWorld(voxel + max(step, ivec3(0)));
    vec3 tMaxVec = (voxelBounds - ro) * invRd;

    // Distance to cross one voxel in each axis
    vec3 tDelta = abs(voxelSize * invRd);

    // Traverse voxels
    vec3 lastNormal = vec3(0.0);
    for (int i = 0; i < MAX_STEPS * 2; i++) {
        // Check if current voxel is solid
        if (voxel.x >= 0 && voxel.x < volSize &&
            voxel.y >= 0 && voxel.y < volSize &&
            voxel.z >= 0 && voxel.z < volSize) {

            if (isVoxelSolid(voxel)) {
                // Hit! Calculate exact intersection distance
                result.dist = tStart;
                result.normal = lastNormal;
                result.voxel = voxel;

                // If this is the first voxel, compute entry normal
                if (lastNormal == vec3(0.0)) {
                    // Determine which face we entered through
                    if (tmin.x > tmin.y && tmin.x > tmin.z) {
                        result.normal = vec3(-sign(rd.x), 0.0, 0.0);
                    } else if (tmin.y > tmin.z) {
                        result.normal = vec3(0.0, -sign(rd.y), 0.0);
                    } else {
                        result.normal = vec3(0.0, 0.0, -sign(rd.z));
                    }
                }
                return result;
            }
        }

        // Step to next voxel (DDA)
        if (tMaxVec.x < tMaxVec.y) {
            if (tMaxVec.x < tMaxVec.z) {
                tStart = tMaxVec.x;
                tMaxVec.x += tDelta.x;
                voxel.x += step.x;
                lastNormal = vec3(-float(step.x), 0.0, 0.0);
            } else {
                tStart = tMaxVec.z;
                tMaxVec.z += tDelta.z;
                voxel.z += step.z;
                lastNormal = vec3(0.0, 0.0, -float(step.z));
            }
        } else {
            if (tMaxVec.y < tMaxVec.z) {
                tStart = tMaxVec.y;
                tMaxVec.y += tDelta.y;
                voxel.y += step.y;
                lastNormal = vec3(0.0, -float(step.y), 0.0);
            } else {
                tStart = tMaxVec.z;
                tMaxVec.z += tDelta.z;
                voxel.z += step.z;
                lastNormal = vec3(0.0, 0.0, -float(step.z));
            }
        }

        // Check if we've exited the volume
        if (tStart > tExit) break;
    }

    return result;
}

// Compute smooth normal using central differences on the SDF field
vec3 calcNormal(vec3 p) {
    float eps = 2.0 / float(volumeSize);

    float dx = getField(p + vec3(eps, 0.0, 0.0)) - getField(p - vec3(eps, 0.0, 0.0));
    float dy = getField(p + vec3(0.0, eps, 0.0)) - getField(p - vec3(0.0, eps, 0.0));
    float dz = getField(p + vec3(0.0, 0.0, eps)) - getField(p - vec3(0.0, 0.0, eps));

    vec3 n = vec3(dx, dy, dz);

    // Handle degenerate case
    float len = length(n);
    if (len < 0.0001) return vec3(0.0, 1.0, 0.0);

    return n / len;
}

// Isosurface hit result
struct IsoHit {
    float dist;
    vec3 pos;
    bool hit;
};

// Analytic isosurface raymarching with bisection refinement
IsoHit isosurfaceTrace(vec3 ro, vec3 rd) {
    IsoHit result;
    result.hit = false;
    result.dist = -1.0;
    result.pos = vec3(0.0);

    // Ray-box intersection with volume bounds [-1, 1]
    vec3 invRd = 1.0 / rd;
    vec3 t0 = (-1.0 - ro) * invRd;
    vec3 t1 = (1.0 - ro) * invRd;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tEnter = max(max(tmin.x, tmin.y), tmin.z);
    float tExit = min(min(tmax.x, tmax.y), tmax.z);

    if (tEnter > tExit || tExit < 0.0) return result;

    float tStart = max(tEnter, 0.0);

    // Step size based on volume resolution
    float stepSize = 1.5 / float(volumeSize);

    // March through volume
    float t = tStart;
    float prevField = getField(ro + rd * t);

    // If we start inside solid (e.g., inverted volume), hit the bounding box surface
    if (prevField < 0.0) {
        result.hit = true;
        result.dist = tStart;
        result.pos = ro + rd * tStart;
        return result;
    }

    for (int i = 0; i < MAX_STEPS; i++) {
        t += stepSize;
        if (t > tExit) break;

        vec3 p = ro + rd * t;
        float field = getField(p);

        // Check for sign change (threshold crossing)
        if (prevField * field < 0.0) {
            // Found crossing - refine with bisection
            float tLo = t - stepSize;
            float tHi = t;

            // Bisection iterations for precise surface location
            for (int j = 0; j < 8; j++) {
                float tMid = (tLo + tHi) * 0.5;
                float fMid = getField(ro + rd * tMid);

                if (prevField * fMid < 0.0) {
                    tHi = tMid;
                } else {
                    tLo = tMid;
                    prevField = fMid;
                }
            }

            result.hit = true;
            result.dist = (tLo + tHi) * 0.5;
            result.pos = ro + rd * result.dist;
            return result;
        }

        prevField = field;
    }

    return result;
}

// Shading for smooth isosurface - uses RGB from volume for coloring
vec3 shade(vec3 p, vec3 rd) {
    vec3 n = calcNormal(p);
    vec3 lightDir = normalize(vec3(1.0, 1.0, -1.0));

    // Diffuse lighting
    float diff = max(dot(n, lightDir), 0.0);
    float amb = 0.15;

    // Specular highlight
    vec3 halfVec = normalize(lightDir - rd);
    float spec = pow(max(dot(n, halfVec), 0.0), 32.0);

    // Fresnel rim lighting
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    // Use RGB from volume for coloring
    vec4 volColor = sampleVolume(p);
    vec3 baseColor = volColor.rgb;

    // If volume appears grayscale (R≈G≈B), use a neutral gray
    float colorVariance = length(volColor.rgb - vec3(volColor.r));
    if (colorVariance < 0.01) {
        baseColor = vec3(0.75);
    }

    return baseColor * (amb + diff * 0.7) + spec * 0.2 + rim * 0.15;
}

// Voxel shading with flat face normals
vec3 shadeVoxel(vec3 p, vec3 rd, vec3 n, ivec3 voxel) {
    vec3 lightDir = normalize(vec3(1.0, 1.0, -1.0));

    float diff = max(dot(n, lightDir), 0.0);
    float amb = 0.3;  // Higher ambient for voxel look

    // Use RGB from volume for coloring
    vec4 volColor = sampleVoxel(voxel);
    vec3 baseColor = volColor.rgb;

    // If volume appears grayscale, apply face-based shading variation
    float colorVariance = length(volColor.rgb - vec3(volColor.r));
    if (colorVariance < 0.01) {
        float faceShade = abs(n.x) * 0.9 + abs(n.y) * 1.0 + abs(n.z) * 0.85;
        baseColor = vec3(0.7 * faceShade);
    }

    return baseColor * (amb + diff * 0.7);
}

void main() {
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
}
