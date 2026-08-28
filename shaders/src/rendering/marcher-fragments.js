/**
 * marcher-fragments.js — the single textual source for the shared volumetric
 * marcher, in both shader languages.
 *
 * The legacy `render/*` effects (render3d, renderCubemap3d) are byte-for-byte
 * clones of one another outside their `main()`: twelve functions and two result
 * structs, identical in GLSL and identical in WGSL. Those functions live here,
 * once, as plain strings.
 *
 * The committed `shaders/effects/render/<effect>/{glsl,wgsl}/<program>.<ext>`
 * files are GENERATED from these fragments by
 * `shaders/scripts/generate-marcher-shaders.mjs`. Editing a fragment and
 * re-running the generator is the only supported way to change them;
 * `shaders/tests/test_generated_marcher_shaders.js` regenerates in memory and
 * byte-compares against disk, so drift fails the suite.
 *
 * Keeping the files on disk (rather than handing these strings to the runtime)
 * preserves everything the effect tooling depends on: the shader manifest, the
 * bundler's minification of file-loaded sources, the parity-attestation source
 * hash and its CI change-detector, `validateWgslTextureBindings`, the gauntlet,
 * the shade MCP source tools, and the browser's lazy per-program fetch.
 *
 * Pure strings. Zero imports. No template interpolation — the fragments are
 * verbatim shader text, so what you read here is what ships.
 */

/**
 * The shared body, in emission order: twelve functions and the two result
 * structs that two of them return. Both languages use the same order.
 */
export const MARCHER_BODY_ORDER = Object.freeze([
  'atlasIndex',
  'sampleVoxel',
  'sampleVolume',
  'getField',
  'isVoxelSolid',
  'worldToVoxel',
  'voxelToWorld',
  'voxelHitStruct',
  'voxelTrace',
  'calcNormal',
  'isoHitStruct',
  'isosurfaceTrace',
  'shade',
  'shadeVoxel'
])

export const GLSL_FRAGMENTS = Object.freeze({
  /** The FILTERING / INVERT compile-time-define note that sits above the uniform block. */
  defineNote: `// FILTERING and INVERT are compile-time #defines injected by the expander
// (see definition.js). Baking them lets the compiler eliminate the unused
// raymarching path and the per-sample invert branch.`,

  /** The two-target MRT declaration (color + geometry buffer). */
  outputs: `// MRT outputs: color and geometry buffer
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 geoOut;`,

  /** TAU, PI, MAX_STEPS, MAX_DIST. */
  constants: `const float TAU = 6.283185307179586;
const float PI = 3.141592653589793;
const int MAX_STEPS = 256;
const float MAX_DIST = 10.0;`,

  /** 3D voxel coordinate -> 2D atlas texel coordinate. */
  atlasIndex: `// Helper to convert 3D texel coords to 2D atlas texel coords
ivec2 atlasTexel(ivec3 p, int volSize) {
    return ivec2(p.x, p.y + p.z * volSize);
}`,

  /** Nearest-neighbour fetch at integer voxel coordinates. */
  sampleVoxel: `// Sample volume at integer voxel coordinates (for voxel mode)
vec4 sampleVoxel(ivec3 voxel) {
    int volSize = volumeSize;
    ivec3 clamped = clamp(voxel, ivec3(0), ivec3(volSize - 1));
    return texelFetch(volumeCache, atlasTexel(clamped, volSize), 0);
}`,

  /** Trilinear fetch at a world position in [-1, 1]^3. */
  sampleVolume: `// Sample the cached 3D volume with trilinear interpolation
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
}`,

  /** Signed scalar field: threshold - density, with the INVERT branch. */
  getField: `// Get the scalar field value at a point. INVERT is a compile-time #define;
// the optimizer drops the dead branch.
float getField(vec3 p) {
    float val = sampleVolume(p).r;
    if (INVERT) {
        val = 1.0 - val;
    }
    return threshold - val;
}`,

  /** Voxel-mode solidity test, with the INVERT branch. */
  isVoxelSolid: `bool isVoxelSolid(ivec3 voxel) {
    float val = sampleVoxel(voxel).r;
    if (INVERT) {
        val = 1.0 - val;
    }
    return val > threshold;
}`,

  /** World position -> integer voxel coordinate. */
  worldToVoxel: `// Convert world position to voxel coordinates
ivec3 worldToVoxel(vec3 worldPos) {
    int volSize = volumeSize;
    vec3 uvw = worldPos * 0.5 + 0.5;  // [-1,1] -> [0,1]
    return ivec3(floor(uvw * float(volSize)));
}`,

  /** Integer voxel coordinate -> world position at the voxel centre. */
  voxelToWorld: `// Convert voxel coordinates to world position (center of voxel)
vec3 voxelToWorld(ivec3 voxel) {
    int volSize = volumeSize;
    vec3 uvw = (vec3(voxel) + 0.5) / float(volSize);  // center of voxel in [0,1]
    return uvw * 2.0 - 1.0;  // [0,1] -> [-1,1]
}`,

  /** Result record for voxelTrace. */
  voxelHitStruct: `// DDA voxel traversal - returns hit distance and face normal
struct VoxelHit {
    float dist;
    vec3 normal;
    ivec3 voxel;
};`,

  /** DDA voxel traversal returning hit distance and face normal. */
  voxelTrace: `VoxelHit voxelTrace(vec3 ro, vec3 rd) {
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
}`,

  /** Central-difference normal of the scalar field. */
  calcNormal: `// Compute smooth normal using central differences on the SDF field
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
}`,

  /** Result record for isosurfaceTrace. */
  isoHitStruct: `// Isosurface hit result
struct IsoHit {
    float dist;
    vec3 pos;
    bool hit;
};`,

  /** Slab test + fixed-step march + 8-step bisection refinement. */
  isosurfaceTrace: `// Analytic isosurface raymarching with bisection refinement
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
}`,

  /** Forward shading for the smooth isosurface path. */
  shade: `// Shading for smooth isosurface - uses RGB from volume for coloring
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
}`,

  /** Forward shading for the blocky voxel path. */
  shadeVoxel: `// Voxel shading with flat face normals
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
}`,
})

export const WGSL_FRAGMENTS = Object.freeze({
  /** The FILTERING / INVERT compile-time-define note that sits above the uniform block. */
  defineNote: `// FILTERING and INVERT are compile-time defines injected by the expander
// (see definition.js). They eliminate the unused raymarching path and the
// per-sample invert branch respectively, dramatically reducing the work the
// SPIR-V optimizer has to do on a 14kB shader.`,

  /** TAU, PI, MAX_STEPS, MAX_DIST. */
  constants: `const TAU: f32 = 6.283185307179586;
const PI: f32 = 3.141592653589793;
const MAX_STEPS: i32 = 256;
const MAX_DIST: f32 = 10.0;`,

  /** The two-target MRT declaration (color + geometry buffer). */
  outputs: `// MRT output structure for color and geometry buffer
struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @location(1) geoOut: vec4<f32>,
}`,

  /** 3D voxel coordinate -> 2D atlas texel coordinate. */
  atlasIndex: `// Convert 3D volume coordinates to 2D atlas texel coordinates
fn volumeToAtlas(x: i32, y: i32, z: i32, volSize: i32) -> vec2<i32> {
    return vec2<i32>(x, y + z * volSize);
}`,

  /** Nearest-neighbour fetch at integer voxel coordinates. */
  sampleVoxel: `// Sample volume at integer voxel coordinates (for voxel mode)
fn sampleVoxel(voxel: vec3<i32>) -> vec4<f32> {
    let volSize = volumeSize;
    let clamped = clamp(voxel, vec3<i32>(0), vec3<i32>(volSize - 1));
    return textureLoad(volumeCache, volumeToAtlas(clamped.x, clamped.y, clamped.z, volSize), 0);
}`,

  /** Trilinear fetch at a world position in [-1, 1]^3. */
  sampleVolume: `// Sample the cached 3D volume with trilinear interpolation
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
}`,

  /** Signed scalar field: threshold - density, with the INVERT branch. */
  getField: `// Get the scalar field value at a point (what we're finding the isosurface of)
// Convention: HIGH values = SOLID, field < 0 = inside solid
fn getField(p: vec3<f32>) -> f32 {
    var val = sampleVolume(p).r;
    // INVERT is a compile-time const; the optimizer drops the dead branch.
    if (INVERT) {
        val = 1.0 - val;
    }
    return threshold - val;
}`,

  /** Voxel-mode solidity test, with the INVERT branch. */
  isVoxelSolid: `// Check if a voxel is solid (above threshold - high values = solid)
fn isVoxelSolid(voxel: vec3<i32>) -> bool {
    var val = sampleVoxel(voxel).r;
    if (INVERT) {
        val = 1.0 - val;
    }
    return val > threshold;
}`,

  /** World position -> integer voxel coordinate. */
  worldToVoxel: `// Convert world position to voxel coordinates
fn worldToVoxel(worldPos: vec3<f32>) -> vec3<i32> {
    let volSize = volumeSize;
    let uvw = worldPos * 0.5 + 0.5;  // [-1,1] -> [0,1]
    return vec3<i32>(floor(uvw * f32(volSize)));
}`,

  /** Integer voxel coordinate -> world position at the voxel centre. */
  voxelToWorld: `// Convert voxel coordinates to world position (center of voxel)
fn voxelToWorld(voxel: vec3<i32>) -> vec3<f32> {
    let volSize = volumeSize;
    let uvw = (vec3<f32>(voxel) + 0.5) / f32(volSize);  // center of voxel in [0,1]
    return uvw * 2.0 - 1.0;  // [0,1] -> [-1,1]
}`,

  /** Result record for voxelTrace. */
  voxelHitStruct: `// Voxel hit result
struct VoxelHit {
    dist: f32,
    normal: vec3<f32>,
    voxel: vec3<i32>,
}`,

  /** DDA voxel traversal returning hit distance and face normal. */
  voxelTrace: `// DDA voxel traversal - returns hit distance and face normal
fn voxelTrace(ro: vec3<f32>, rd: vec3<f32>) -> VoxelHit {
    var result: VoxelHit;
    result.dist = -1.0;
    result.normal = vec3<f32>(0.0);
    result.voxel = vec3<i32>(0);
    
    let volSize = volumeSize;
    let voxelSize = 2.0 / f32(volSize);  // world-space size of one voxel
    
    // Ray-box intersection with the volume bounds [-1, 1]
    let invRd = 1.0 / rd;
    let t0 = (-1.0 - ro) * invRd;
    let t1 = (1.0 - ro) * invRd;
    let tminV = min(t0, t1);
    let tmaxV = max(t0, t1);
    let tEnter = max(max(tminV.x, tminV.y), tminV.z);
    let tExit = min(min(tmaxV.x, tmaxV.y), tmaxV.z);
    
    if (tEnter > tExit || tExit < 0.0) {
        return result;  // No intersection with volume
    }
    
    // Start position (slightly inside the volume)
    var tStart = max(tEnter + 0.001, 0.0);
    let pos = ro + rd * tStart;
    
    // Current voxel
    var voxel = worldToVoxel(pos);
    voxel = clamp(voxel, vec3<i32>(0), vec3<i32>(volSize - 1));
    
    // Step direction
    let step = vec3<i32>(sign(rd));
    
    // Distance to next voxel boundary in each axis
    let voxelBounds = voxelToWorld(voxel + max(step, vec3<i32>(0)));
    var tMaxVec = (voxelBounds - ro) * invRd;
    
    // Distance to cross one voxel in each axis
    let tDelta = abs(vec3<f32>(voxelSize) * invRd);
    
    // Traverse voxels
    var lastNormal = vec3<f32>(0.0);
    for (var i: i32 = 0; i < MAX_STEPS * 2; i = i + 1) {
        // Check if current voxel is solid
        if (voxel.x >= 0 && voxel.x < volSize &&
            voxel.y >= 0 && voxel.y < volSize &&
            voxel.z >= 0 && voxel.z < volSize) {
            
            if (isVoxelSolid(voxel)) {
                // Hit! 
                result.dist = tStart;
                result.normal = lastNormal;
                result.voxel = voxel;
                
                // If this is the first voxel, compute entry normal
                if (lastNormal.x == 0.0 && lastNormal.y == 0.0 && lastNormal.z == 0.0) {
                    if (tminV.x > tminV.y && tminV.x > tminV.z) {
                        result.normal = vec3<f32>(-sign(rd.x), 0.0, 0.0);
                    } else if (tminV.y > tminV.z) {
                        result.normal = vec3<f32>(0.0, -sign(rd.y), 0.0);
                    } else {
                        result.normal = vec3<f32>(0.0, 0.0, -sign(rd.z));
                    }
                }
                return result;
            }
        }
        
        // Step to next voxel (DDA)
        if (tMaxVec.x < tMaxVec.y) {
            if (tMaxVec.x < tMaxVec.z) {
                tStart = tMaxVec.x;
                tMaxVec.x = tMaxVec.x + tDelta.x;
                voxel.x = voxel.x + step.x;
                lastNormal = vec3<f32>(-f32(step.x), 0.0, 0.0);
            } else {
                tStart = tMaxVec.z;
                tMaxVec.z = tMaxVec.z + tDelta.z;
                voxel.z = voxel.z + step.z;
                lastNormal = vec3<f32>(0.0, 0.0, -f32(step.z));
            }
        } else {
            if (tMaxVec.y < tMaxVec.z) {
                tStart = tMaxVec.y;
                tMaxVec.y = tMaxVec.y + tDelta.y;
                voxel.y = voxel.y + step.y;
                lastNormal = vec3<f32>(0.0, -f32(step.y), 0.0);
            } else {
                tStart = tMaxVec.z;
                tMaxVec.z = tMaxVec.z + tDelta.z;
                voxel.z = voxel.z + step.z;
                lastNormal = vec3<f32>(0.0, 0.0, -f32(step.z));
            }
        }
        
        // Check if we've exited the volume
        if (tStart > tExit) { break; }
    }
    
    return result;
}`,

  /** Central-difference normal of the scalar field. */
  calcNormal: `// Compute smooth normal using central differences on the SDF field
fn calcNormal(p: vec3<f32>) -> vec3<f32> {
    let eps = 2.0 / f32(volumeSize);
    
    let dx = getField(p + vec3<f32>(eps, 0.0, 0.0)) - getField(p - vec3<f32>(eps, 0.0, 0.0));
    let dy = getField(p + vec3<f32>(0.0, eps, 0.0)) - getField(p - vec3<f32>(0.0, eps, 0.0));
    let dz = getField(p + vec3<f32>(0.0, 0.0, eps)) - getField(p - vec3<f32>(0.0, 0.0, eps));
    
    var n = vec3<f32>(dx, dy, dz);
    
    let len = length(n);
    if (len < 0.0001) { return vec3<f32>(0.0, 1.0, 0.0); }
    
    return n / len;
}`,

  /** Result record for isosurfaceTrace. */
  isoHitStruct: `// Isosurface hit result
struct IsoHit {
    dist: f32,
    pos: vec3<f32>,
    hit: bool,
}`,

  /** Slab test + fixed-step march + 8-step bisection refinement. */
  isosurfaceTrace: `// Analytic isosurface raymarching with bisection refinement
fn isosurfaceTrace(ro: vec3<f32>, rd: vec3<f32>) -> IsoHit {
    var result: IsoHit;
    result.hit = false;
    result.dist = -1.0;
    result.pos = vec3<f32>(0.0);
    
    let invRd = 1.0 / rd;
    let t0 = (-1.0 - ro) * invRd;
    let t1 = (1.0 - ro) * invRd;
    let tminV = min(t0, t1);
    let tmaxV = max(t0, t1);
    let tEnter = max(max(tminV.x, tminV.y), tminV.z);
    let tExit = min(min(tmaxV.x, tmaxV.y), tmaxV.z);
    
    if (tEnter > tExit || tExit < 0.0) { return result; }
    
    let tStart = max(tEnter, 0.0);
    let stepSize = 1.5 / f32(volumeSize);
    
    var t = tStart;
    var prevField = getField(ro + rd * t);
    
    // If we start inside solid (e.g., inverted volume), hit the bounding box surface
    if (prevField < 0.0) {
        result.hit = true;
        result.dist = tStart;
        result.pos = ro + rd * tStart;
        return result;
    }
    
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        t = t + stepSize;
        if (t > tExit) { break; }
        
        let p = ro + rd * t;
        let field = getField(p);
        
        if (prevField * field < 0.0) {
            var tLo = t - stepSize;
            var tHi = t;
            var pf = prevField;
            
            for (var j: i32 = 0; j < 8; j = j + 1) {
                let tMid = (tLo + tHi) * 0.5;
                let fMid = getField(ro + rd * tMid);
                
                if (pf * fMid < 0.0) {
                    tHi = tMid;
                } else {
                    tLo = tMid;
                    pf = fMid;
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
}`,

  /** Forward shading for the smooth isosurface path. */
  shade: `// Shading for smooth isosurface
fn shade(p: vec3<f32>, rd: vec3<f32>) -> vec3<f32> {
    let n = calcNormal(p);
    let lightDir = normalize(vec3<f32>(1.0, 1.0, -1.0));
    
    let diff = max(dot(n, lightDir), 0.0);
    let amb: f32 = 0.15;
    
    let halfVec = normalize(lightDir - rd);
    let spec = pow(max(dot(n, halfVec), 0.0), 32.0);
    
    let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    
    // Use RGB from volume for coloring
    let volColor = sampleVolume(p);
    var baseColor = volColor.rgb;
    
    // If volume appears grayscale (R≈G≈B), use a neutral gray
    let colorVariance = length(volColor.rgb - vec3<f32>(volColor.r));
    if (colorVariance < 0.01) {
        baseColor = vec3<f32>(0.75);
    }
    
    return baseColor * (amb + diff * 0.7) + spec * 0.2 + rim * 0.15;
}`,

  /** Forward shading for the blocky voxel path. */
  shadeVoxel: `// Voxel shading with flat face normals
fn shadeVoxel(p: vec3<f32>, rd: vec3<f32>, n: vec3<f32>, voxel: vec3<i32>) -> vec3<f32> {
    let lightDir = normalize(vec3<f32>(1.0, 1.0, -1.0));
    
    let diff = max(dot(n, lightDir), 0.0);
    let amb: f32 = 0.3;
    
    // Use RGB from volume for coloring
    let volColor = sampleVoxel(voxel);
    var baseColor = volColor.rgb;
    
    // If volume appears grayscale, apply face-based shading variation
    let colorVariance = length(volColor.rgb - vec3<f32>(volColor.r));
    if (colorVariance < 0.01) {
        let faceShade = abs(n.x) * 0.9 + abs(n.y) * 1.0 + abs(n.z) * 0.85;
        baseColor = vec3<f32>(0.7 * faceShade);
    }
    
    return baseColor * (amb + diff * 0.7);
}`,
})

/**
 * Join a fragment selection into a shader body, one blank line between each.
 * @param {Readonly<Record<string, string>>} fragments GLSL_FRAGMENTS or WGSL_FRAGMENTS
 * @param {readonly string[]} keys Fragment keys, in emission order
 * @returns {string}
 */
export function joinFragments(fragments, keys) {
  return keys.map((key) => {
    const fragment = fragments[key]
    if (fragment === undefined) throw new Error(`Unknown marcher fragment: ${key}`)
    return fragment
  }).join('\n\n')
}

/**
 * The full shared marcher body in GLSL.
 * @param {readonly string[]} [keys]
 * @returns {string}
 */
export function marcherBodyGLSL(keys = MARCHER_BODY_ORDER) {
  return joinFragments(GLSL_FRAGMENTS, keys)
}

/**
 * The full shared marcher body in WGSL.
 * @param {readonly string[]} [keys]
 * @returns {string}
 */
export function marcherBodyWGSL(keys = MARCHER_BODY_ORDER) {
  return joinFragments(WGSL_FRAGMENTS, keys)
}
