#version 300 es

/*
 * Noise synthesizer shader.
 */

precision highp float;
precision highp int;

// NOISE_TYPE is a compile-time define injected by the runtime (see
// definition.js `globals.type.define`). Wrapping the variant dispatch in #if
// blocks instead of a runtime if-else avoids ANGLE→D3D inlining the entire
// 9-way decision tree at every call site, which produced ~85 second compiles
// (and ANGLE link timeouts) on Windows Chrome — see HANDOFF-shader-compile.md.
#ifndef NOISE_TYPE
#define NOISE_TYPE 10
#endif

// COLOR_MODE, REFRACT_MODE, LOOP_OFFSET, and METRIC are also compile-time
// defines. Same rationale as NOISE_TYPE: each is a multi-way dispatch on a
// uniform that ANGLE inlines into large function bodies, and wrapping the
// variants in #if blocks lets dead-code elimination drop the unreachable paths
// before HLSL emission.
#ifndef COLOR_MODE
#define COLOR_MODE 6
#endif
#ifndef REFRACT_MODE
#define REFRACT_MODE 2
#endif
#ifndef LOOP_OFFSET
#define LOOP_OFFSET 300
#endif
#ifndef METRIC
#define METRIC 0
#endif
uniform float time;
uniform int seed;
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float xScale;
uniform float yScale;
uniform int octaves;
uniform bool ridges;
uniform float refractAmt;
uniform float kaleido;
uniform float loopScale;
uniform float speed;
uniform int paletteMode;
uniform vec3 paletteOffset;
uniform vec3 paletteAmp;
uniform vec3 paletteFreq;
uniform vec3 palettePhase;
uniform int cyclePalette;
uniform float rotatePalette;
uniform float repeatPalette;
uniform float hueRange;
uniform float hueRotation;
uniform bool wrap;
out vec4 fragColor;

#define PI 3.14159265359
#define TAU 6.28318530718
#define aspectRatio fullResolution.x / fullResolution.y

// PCG PRNG - MIT License
// https://github.com/riccardoscalco/glsl-pcg-prng
uvec3 pcg(uvec3 v) {
	v = v * uint(1664525) + uint(1013904223);

	v.x += v.y * v.z;
	v.y += v.z * v.x;
	v.z += v.x * v.y;

	v ^= v >> uint(16);

	v.x += v.y * v.z;
	v.y += v.z * v.x;
	v.z += v.x * v.y;

	return v;
}

vec3 prng (vec3 p) {
    p.x = p.x >= 0.0 ? p.x * 2.0 : -p.x * 2.0 + 1.0;
    p.y = p.y >= 0.0 ? p.y * 2.0 : -p.y * 2.0 + 1.0;
    p.z = p.z >= 0.0 ? p.z * 2.0 : -p.z * 2.0 + 1.0;
    return vec3(pcg(uvec3(p))) / float(uint(0xffffffff));
}
// end PCG PRNG

float random(vec2 st) {
    return prng(vec3(st, 0.0)).x;
}

float map(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

float periodicFunction(float p) {
    return map(cos(p * TAU), -1.0, 1.0, 0.0, 1.0);
}

// Noisemaker value noise - MIT License
// https://github.com/noisefactorllc/noisemaker/blob/main/noisemaker/value.py
int positiveModulo(int value, int modulus) {
    if (modulus == 0) {
        return 0;
    }

    int r = value % modulus;
    return (r < 0) ? r + modulus : r;
}

float constantFromLatticeWithOffset(vec2 lattice, vec2 freq, float s, float blend, ivec2 offset) {
    vec2 baseFloor = floor(lattice);
    ivec2 base = ivec2(baseFloor) + offset;
    vec2 frac = lattice - baseFloor;

    int seedInt = int(floor(s));
    float sFrac = fract(s);

    float xCombined = frac.x + sFrac;
    int xi = base.x + int(floor(xCombined));
    int yi = base.y;

    if (wrap) {
        int freqX = int(freq.x + 0.5);
        int freqY = int(freq.y + 0.5);

        if (freqX > 0) {
            xi = positiveModulo(xi, freqX);
        }
        if (freqY > 0) {
            yi = positiveModulo(yi, freqY);
        }
    }

    uint xBits = uint(xi);
    uint yBits = uint(yi);
    uint seedBits = uint(seedInt);
    uint fracBits = floatBitsToUint(sFrac);

    uvec3 jitter = uvec3(
        (fracBits * 374761393u) ^ 0x9E3779B9u,
        (fracBits * 668265263u) ^ 0x7F4A7C15u,
        (fracBits * 2246822519u) ^ 0x94D049B4u
    );

    uvec3 state = uvec3(xBits, yBits, seedBits) ^ jitter;
    uvec3 prngState = pcg(state);
    float noiseValue = float(prngState.x) / float(0xffffffffu);

    return periodicFunction(noiseValue - blend);
}

float constantFromLattice(vec2 lattice, vec2 freq, float s, float blend) {
    return constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(0, 0));
}

float constant(vec2 st, vec2 freq, float s, float blend) {
    vec2 lattice = st * freq;
    return constantFromLattice(lattice, freq, s, blend);
}

// ---- 3×3 quadratic interpolation ----
// Replaces legacy bicubic 4×4 (16 taps) with 3×3 kernel (9 taps)
// Performance: ~1.8× faster in fBm chains
// Quality: Quadratic (degree 2) interpolation, minimum 3×3 kernel to avoid lattice artifacts

// Cubic Hermite interpolation (same as smoothstep but explicit)
float cubic(float t) {
    // 3t^2 - 2t^3 (C¹ continuous, standard smoothstep curve)
    return t * t * (3.0 - 2.0 * t);
}

// Quadratic interpolation for 3 samples (degree 2 polynomial)
float quadratic3(float p0, float p1, float p2, float t) {
    // Quadratic B-spline interpolation (degree 2)
    // Smooth C¹ continuous blending between 3 control points
    // B-spline basis functions for uniform knots with t ∈ [0, 1]
    float t2 = t * t;
    
    // B-spline basis: B0 = (1-t)²/2, B1 = (-2t² + 2t + 1)/2, B2 = t²/2
    return p0 * 0.5 * (1.0 - t) * (1.0 - t) +
           p1 * 0.5 * (-2.0 * t2 + 2.0 * t + 1.0) +
           p2 * 0.5 * t2;
}

// Get random value at lattice point (value noise source for interpolated noise)
float latticeValue(vec2 lattice, vec2 freq, float s, float blend) {
    return constantFromLattice(lattice, freq, s, blend);
}

#if NOISE_TYPE == 5
float cubic3x3ValueNoise(vec2 st, vec2 freq, float s, float blend) {
    vec2 lattice = st * freq;
    vec2 f = fract(lattice);

    // Sample 3×3 grid (9 taps)
    float v00 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(-1, -1));
    float v10 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 0, -1));
    float v20 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 1, -1));
    float v01 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(-1,  0));
    float v11 = constantFromLattice(lattice, freq, s, blend);
    float v21 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 1,  0));
    float v02 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(-1,  1));
    float v12 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 0,  1));
    float v22 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 1,  1));

    float y0 = quadratic3(v00, v10, v20, f.x);
    float y1 = quadratic3(v01, v11, v21, f.x);
    float y2 = quadratic3(v02, v12, v22, f.x);

    return quadratic3(y0, y1, y2, f.y);
}
#endif

// ---- End 3×3 quadratic ----

// Cubic B-spline interpolation (degree 3)
float blendBicubic(float p0, float p1, float p2, float p3, float t) {
    // Cubic B-spline basis functions for uniform knots
    // Provides C² continuous smoothing
    float t2 = t * t;
    float t3 = t2 * t;
    
    float b0 = (1.0 - t) * (1.0 - t) * (1.0 - t) / 6.0;
    float b1 = (3.0 * t3 - 6.0 * t2 + 4.0) / 6.0;
    float b2 = (-3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0) / 6.0;
    float b3 = t3 / 6.0;
    
    return p0 * b0 + p1 * b1 + p2 * b2 + p3 * b3;
}

// Catmull-Rom 3-point cubic interpolation (degree 3)
float catmullRom3(float p0, float p1, float p2, float t) {
    // Catmull-Rom-esque cubic through 3 points
    // Interpolating (passes through control points)
    float t2 = t * t;
    float t3 = t2 * t;
    
    return p1 + 0.5 * t * (p2 - p0) + 
           0.5 * t2 * (2.0*p0 - 5.0*p1 + 4.0*p2 - p0) +
           0.5 * t3 * (-p0 + 3.0*p1 - 3.0*p2 + p0);
}

// Catmull-Rom 4-point cubic interpolation (degree 3)
float catmullRom4(float p0, float p1, float p2, float p3, float t) {
    // Standard Catmull-Rom spline with tension = 0.5
    // Interpolating (passes through p1 and p2)
    return p1 + 0.5 * t * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)));
}

float blendLinearOrCosine(float a, float b, float amount, int nType) {
    if (nType == 1) {
        return mix(a, b, amount);
    }

    return mix(a, b, smoothstep(0.0, 1.0, amount));
}

float constantOffset(vec2 lattice, vec2 freq, float s, float blend, ivec2 offset) {
    return constantFromLatticeWithOffset(lattice, freq, s, blend, offset);
}

#if NOISE_TYPE == 6
float bicubicValue(vec2 st, vec2 freq, float s, float blend) {
    vec2 lattice = st * freq;

    float x0y0 = constantOffset(lattice, freq, s, blend, ivec2(-1, -1));
    float x0y1 = constantOffset(lattice, freq, s, blend, ivec2(-1, 0));
    float x0y2 = constantOffset(lattice, freq, s, blend, ivec2(-1, 1));
    float x0y3 = constantOffset(lattice, freq, s, blend, ivec2(-1, 2));

    float x1y0 = constantOffset(lattice, freq, s, blend, ivec2(0, -1));
    float x1y1 = constantFromLattice(lattice, freq, s, blend);
    float x1y2 = constantOffset(lattice, freq, s, blend, ivec2(0, 1));
    float x1y3 = constantOffset(lattice, freq, s, blend, ivec2(0, 2));

    float x2y0 = constantOffset(lattice, freq, s, blend, ivec2(1, -1));
    float x2y1 = constantOffset(lattice, freq, s, blend, ivec2(1, 0));
    float x2y2 = constantOffset(lattice, freq, s, blend, ivec2(1, 1));
    float x2y3 = constantOffset(lattice, freq, s, blend, ivec2(1, 2));

    float x3y0 = constantOffset(lattice, freq, s, blend, ivec2(2, -1));
    float x3y1 = constantOffset(lattice, freq, s, blend, ivec2(2, 0));
    float x3y2 = constantOffset(lattice, freq, s, blend, ivec2(2, 1));
    float x3y3 = constantOffset(lattice, freq, s, blend, ivec2(2, 2));

    vec2 frac = fract(lattice);

    float y0 = blendBicubic(x0y0, x1y0, x2y0, x3y0, frac.x);
    float y1 = blendBicubic(x0y1, x1y1, x2y1, x3y1, frac.x);
    float y2 = blendBicubic(x0y2, x1y2, x2y2, x3y2, frac.x);
    float y3 = blendBicubic(x0y3, x1y3, x2y3, x3y3, frac.x);

    return blendBicubic(y0, y1, y2, y3, frac.y);
}
#endif

#if NOISE_TYPE == 3
// 3×3 Catmull-Rom value noise (9 taps)
float catmullRom3x3ValueNoise(vec2 st, vec2 freq, float s, float blend) {
    vec2 lattice = st * freq;
    vec2 f = fract(lattice);

    float v00 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(-1, -1));
    float v10 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 0, -1));
    float v20 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 1, -1));
    float v01 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(-1,  0));
    float v11 = constantFromLattice(lattice, freq, s, blend);
    float v21 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 1,  0));
    float v02 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2(-1,  1));
    float v12 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 0,  1));
    float v22 = constantFromLatticeWithOffset(lattice, freq, s, blend, ivec2( 1,  1));

    float y0 = catmullRom3(v00, v10, v20, f.x);
    float y1 = catmullRom3(v01, v11, v21, f.x);
    float y2 = catmullRom3(v02, v12, v22, f.x);
    return catmullRom3(y0, y1, y2, f.y);
}
#endif

#if NOISE_TYPE == 4
// 4×4 Catmull-Rom value noise (16 taps)
float catmullRom4x4ValueNoise(vec2 st, vec2 freq, float s, float blend) {
    vec2 lattice = st * freq;

    float x0y0 = constantOffset(lattice, freq, s, blend, ivec2(-1, -1));
    float x0y1 = constantOffset(lattice, freq, s, blend, ivec2(-1, 0));
    float x0y2 = constantOffset(lattice, freq, s, blend, ivec2(-1, 1));
    float x0y3 = constantOffset(lattice, freq, s, blend, ivec2(-1, 2));

    float x1y0 = constantOffset(lattice, freq, s, blend, ivec2(0, -1));
    float x1y1 = constantFromLattice(lattice, freq, s, blend);
    float x1y2 = constantOffset(lattice, freq, s, blend, ivec2(0, 1));
    float x1y3 = constantOffset(lattice, freq, s, blend, ivec2(0, 2));

    float x2y0 = constantOffset(lattice, freq, s, blend, ivec2(1, -1));
    float x2y1 = constantOffset(lattice, freq, s, blend, ivec2(1, 0));
    float x2y2 = constantOffset(lattice, freq, s, blend, ivec2(1, 1));
    float x2y3 = constantOffset(lattice, freq, s, blend, ivec2(1, 2));

    float x3y0 = constantOffset(lattice, freq, s, blend, ivec2(2, -1));
    float x3y1 = constantOffset(lattice, freq, s, blend, ivec2(2, 0));
    float x3y2 = constantOffset(lattice, freq, s, blend, ivec2(2, 1));
    float x3y3 = constantOffset(lattice, freq, s, blend, ivec2(2, 2));

    vec2 frac = fract(lattice);

    float y0 = catmullRom4(x0y0, x1y0, x2y0, x3y0, frac.x);
    float y1 = catmullRom4(x0y1, x1y1, x2y1, x3y1, frac.x);
    float y2 = catmullRom4(x0y2, x1y2, x2y2, x3y2, frac.x);
    float y3 = catmullRom4(x0y3, x1y3, x2y3, x3y3, frac.x);

    return catmullRom4(y0, y1, y2, y3, frac.y);
}
#endif

// Simplex 2D - MIT License
// https://github.com/ashima/webgl-noise/blob/master/src/noise2D.glsl
//
// Description : Array and textureless GLSL 2D simplex noise function.
//      Author : Ian McEwan, Ashima Arts.
//  Maintainer : stegu
//     Lastmod : 20110822 (ijm)
//     License : Copyright (C) 2011 Ashima Arts. All rights reserved.
//               Distributed under the MIT License. See LICENSE file.
//               https://github.com/ashima/webgl-noise
//               https://github.com/stegu/webgl-noise
// 
// Copyright (C) 2011 by Ashima Arts (Simplex noise)
// Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
#if NOISE_TYPE == 10
vec3 mod289(vec3 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec2 mod289(vec2 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec3 permute(vec3 x) {
    return mod289(((x*34.0)+1.0)*x);
}

float simplexValue(vec2 st, vec2 freq, float s, float blend) {
    const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                        0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                       -0.577350269189626,  // -1.0 + 2.0 * C.x
                        0.024390243902439); // 1.0 / 41.0

    vec2 uv = st * freq;
    uv.x += s;

    // First corner
    vec2 i  = floor(uv + dot(uv, C.yy) );
    vec2 x0 = uv -   i + dot(i, C.xx);

    // Other corners
    vec2 i1 = vec2(0.0);
    //i1.x = step( x0.y, x0.x ); // x0.x > x0.y ? 1.0 : 0.0
    //i1.y = 1.0 - i1.x;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    // x0 = x0 - 0.0 + 0.0 * C.xx ;
    // x1 = x0 - i1 + 1.0 * C.xx ;
    // x2 = x0 - 1.0 + 2.0 * C.xx ;
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;

    // Permutations
    i = mod289(i); // Avoid truncation effects in permutation
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
		  + i.x + vec3(0.0, i1.x, 1.0 ));

    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m ;
    m = m*m ;

    // Gradients: 41 points uniformly over a line, mapped onto a diamond.
    // The ring size 17*17 = 289 is close to a multiple of 41 (41*7 = 287)

    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;

    // Normalise gradients implicitly by scaling m
    // Approximation of: m *= inversesqrt( a0*a0 + h*h );
    m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );

    // Compute final noise value at P
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;

    float v = 130.0 * dot(m, g);

    return periodicFunction(map(v, -1.0, 1.0, 0.0, 1.0) - blend);
}
#endif
// end simplex

#if NOISE_TYPE == 11
float sineNoise(vec2 st, vec2 freq, float s, float blend) {
    st *= freq;
    st.x += s; 

    float a = blend;
    float b = blend;
    float c = 1.0 - blend;

    vec3 r1 = prng(vec3(s)) * 0.75 + 0.125;
    vec3 r2 = prng(vec3(s+ 10.0)) * 0.75 + 0.125;
    float x = sin(r1.x * st.y + sin(r1.y * st.x + a) + sin(r1.z * st.x + b) + c);
    float y = sin(r2.x * st.x + sin(r2.y * st.y + b) + sin(r2.z * st.y + c) + a);

    return (x + y) * 0.5 + 0.5;
}
#endif

float value(vec2 st, vec2 freq, float s, float blend) {
#if NOISE_TYPE == 3
    return catmullRom3x3ValueNoise(st, freq, s, blend);
#elif NOISE_TYPE == 4
    return catmullRom4x4ValueNoise(st, freq, s, blend);
#elif NOISE_TYPE == 5
    return cubic3x3ValueNoise(st, freq, s, blend);
#elif NOISE_TYPE == 6
    return bicubicValue(st, freq, s, blend);
#elif NOISE_TYPE == 10
    return simplexValue(st, freq, s, blend);
#elif NOISE_TYPE == 11
    return sineNoise(st, freq, s, blend);
#elif NOISE_TYPE == 0
    return constantFromLattice(st * freq, freq, s, blend);
#else
    // NOISE_TYPE == 1 (linear) or NOISE_TYPE == 2 (hermite/cosine)
    vec2 lattice = st * freq;
    float x1y1 = constantFromLattice(lattice, freq, s, blend);
    float x2y1 = constantOffset(lattice, freq, s, blend, ivec2(1, 0));
    float x1y2 = constantOffset(lattice, freq, s, blend, ivec2(0, 1));
    float x2y2 = constantOffset(lattice, freq, s, blend, ivec2(1, 1));
    vec2 frac = fract(lattice);
    float a = blendLinearOrCosine(x1y1, x2y1, frac.x, NOISE_TYPE);
    float b = blendLinearOrCosine(x1y2, x2y2, frac.x, NOISE_TYPE);
    return blendLinearOrCosine(a, b, frac.y, NOISE_TYPE);
#endif
}

//////////////////////////////////////////////////////////////////////

float circles(vec2 st, float freq) {
    float dist = length(st - vec2(0.5 * aspectRatio, 0.5));
    return dist * freq;
}

float rings(vec2 st, float freq) {
    float dist = length(st - vec2(0.5 * aspectRatio, 0.5));
    return cos(dist * PI * freq);
}

float concentric(vec2 st, float freq) {
    float dist = length(st - vec2(0.5 * aspectRatio, 0.5));
    return cos(dist * PI * freq);
}

float diamonds(vec2 st, float freq) {
    st = (gl_FragCoord.xy + tileOffset) / fullResolution.y;
    st -= vec2(0.5 * aspectRatio, 0.5);
    st *= freq;
    return (cos(st.x * PI) + cos(st.y * PI));
}

float shape(vec2 st, int sides, float blend) {
    st = st * 2.0 - vec2(aspectRatio, 1.0);
    float a = atan(st.x, st.y) + PI;
    float r = TAU / float(sides);
    return cos(floor(0.5 + a / r) * r - a) * length(st) * blend;
}

float getMetric(vec2 st) {
    vec2 diff = vec2(0.5 * aspectRatio, 0.5) - st;

#if METRIC == 0
    // euclidean
    return length(st - vec2(0.5 * aspectRatio, 0.5));
#elif METRIC == 1
    // manhattan
    return abs(diff.x) + abs(diff.y);
#elif METRIC == 2
    // hexagon
    return max(max(abs(diff.x) - diff.y * -0.5, -1.0 * diff.y), max(abs(diff.x) - diff.y * 0.5, 1.0 * diff.y));
#elif METRIC == 3
    // octagon
    return max((abs(diff.x) + abs(diff.y)) / sqrt(2.0), max(abs(diff.x), abs(diff.y)));
#elif METRIC == 4
    // chebychev
    return max(abs(diff.x), abs(diff.y));
#elif METRIC == 5
    // triangle
    return max(abs(diff.x) - (diff.y) * -0.5, -1.0 * (diff.y));
#else
    return 1.0;
#endif
}

vec2 rotate2D(vec2 st, float rot) {
    float angle = rot * PI;
    st = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * st;
    return st;
}

vec2 kaleidoscope(vec2 st, float sides, float blendy) {
    if (sides == 1.0) { return st; }
	// distance metric
	float r = getMetric(st) + blendy;

    // cartesian to polar coordinates
    st = st - vec2(0.5 * aspectRatio, 0.5);
    st = rotate2D(st, 0.5);
	float a = atan(st.y, st.x);

	// Repeat side according to angle
	float ma = mod(a - radians(360.0 / sides), TAU/sides);
	//float ma = mod(a + radians(90.0) - radians(360.0 / sides), TAU/sides);
	ma = abs(ma - PI/sides);

	// polar to cartesian coordinates
	st = r * vec2(cos(ma), sin(ma));
	return st;
}

float offset(vec2 st, vec2 freq) {
#if LOOP_OFFSET == 10
    return circles(st, freq.x);
#elif LOOP_OFFSET == 20
    return shape(st, 3, freq.x * 0.5);
#elif LOOP_OFFSET == 30
    return (abs(st.x - 0.5 * aspectRatio) + abs(st.y - 0.5)) * freq.x * 0.5;
#elif LOOP_OFFSET == 40
    return shape(st, 4, freq.x * 0.5);
#elif LOOP_OFFSET == 50
    return shape(st, 5, freq.x * 0.5);
#elif LOOP_OFFSET == 60
    return shape(st, 6, freq.x * 0.5);
#elif LOOP_OFFSET == 70
    return shape(st, 7, freq.x * 0.5);
#elif LOOP_OFFSET == 80
    return shape(st, 8, freq.x * 0.5);
#elif LOOP_OFFSET == 90
    return shape(st, 9, freq.x * 0.5);
#elif LOOP_OFFSET == 100
    return shape(st, 10, freq.x * 0.5);
#elif LOOP_OFFSET == 110
    return shape(st, 11, freq.x * 0.5);
#elif LOOP_OFFSET == 120
    return shape(st, 12, freq.x * 0.5);
#elif LOOP_OFFSET == 200
    return st.x * freq.x * 0.5;
#elif LOOP_OFFSET == 210
    return st.y * freq.x * 0.5;
#elif LOOP_OFFSET == 300
    // noise
    st -= vec2(aspectRatio * 0.5, 0.5);
    return value(st, freq, float(seed) + 50.0, 0.0);
#elif LOOP_OFFSET == 400
    return 1.0 - rings(st, freq.x);
#elif LOOP_OFFSET == 410
    return 1.0 - diamonds(st, freq.x);
#else
    return 0.0;
#endif
}

vec3 hsv2rgb(vec3 hsv) {
    float h = fract(hsv.x);
    float s = hsv.y;
    float v = hsv.z;
    
    float c = v * s; // Chroma
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = v - c;

    vec3 rgb = vec3(0.0);

    if (0.0 <= h && h < 1.0/6.0) {
        rgb = vec3(c, x, 0.0);
    } else if (1.0/6.0 <= h && h < 2.0/6.0) {
        rgb = vec3(x, c, 0.0);
    } else if (2.0/6.0 <= h && h < 3.0/6.0) {
        rgb = vec3(0.0, c, x);
    } else if (3.0/6.0 <= h && h < 4.0/6.0) {
        rgb = vec3(0.0, x, c);
    } else if (4.0/6.0 <= h && h < 5.0/6.0) {
        rgb = vec3(x, 0.0, c);
    } else if (5.0/6.0 <= h && h < 1.0) {
        rgb = vec3(c, 0.0, x);
    } else {
        rgb = vec3(0.0, 0.0, 0.0);
    }

    return rgb + vec3(m, m, m);
}

vec3 rgb2hsv(vec3 rgb) {
    float r = rgb.r;
    float g = rgb.g;
    float b = rgb.b;
    
    float max = max(r, max(g, b));
    float min = min(r, min(g, b));
    float delta = max - min;

    float h = 0.0;
    if (delta != 0.0) {
        if (max == r) {
            h = mod((g - b) / delta, 6.0) / 6.0;
        } else if (max == g) {
            h = ((b - r) / delta + 2.0) / 6.0;
        } else if (max == b) {
            h = ((r - g) / delta + 4.0) / 6.0;
        }
    }
    
    float s = (max == 0.0) ? 0.0 : delta / max;
    float v = max;

    return vec3(h, s, v);
}

vec3 linearToSrgb(vec3 linear) {
    vec3 srgb = vec3(0.0);
    for (int i = 0; i < 3; ++i) {
        if (linear[i] <= 0.0031308) {
            srgb[i] = linear[i] * 12.92;
        } else {
            srgb[i] = 1.055 * pow(linear[i], 1.0 / 2.4) - 0.055;
        }
    }
    return srgb;
}

vec3 srgbToLinear(vec3 srgb) {
    vec3 linear = vec3(0.0);
    for (int i = 0; i < 3; ++i) {
        if (srgb[i] <= 0.04045) {
            linear[i] = srgb[i] / 12.92;
        } else {
            linear[i] = pow((srgb[i] + 0.055) / 1.055, 2.4);
        }
    }
    return linear;
}

// oklab transform and inverse - Public Domain/MIT License
// https://bottosson.github.io/posts/oklab/

const mat3 fwdA = mat3(1.0, 1.0, 1.0,
                       0.3963377774, -0.1055613458, -0.0894841775,
                       0.2158037573, -0.0638541728, -1.2914855480);

const mat3 fwdB = mat3(4.0767245293, -1.2681437731, -0.0041119885,
                       -3.3072168827, 2.6093323231, -0.7034763098,
                       0.2307590544, -0.3411344290,  1.7068625689);

const mat3 invB = mat3(0.4121656120, 0.2118591070, 0.0883097947,
                       0.5362752080, 0.6807189584, 0.2818474174,
                       0.0514575653, 0.1074065790, 0.6302613616);

const mat3 invA = mat3(0.2104542553, 1.9779984951, 0.0259040371,
                       0.7936177850, -2.4285922050, 0.7827717662,
                       -0.0040720468, 0.4505937099, -0.8086757660);

vec3 oklab_from_linear_srgb(vec3 c) {
    vec3 lms = invB * c;

    return invA * (sign(lms)*pow(abs(lms), vec3(0.3333333333333)));
}

vec3 linear_srgb_from_oklab(vec3 c) {
    vec3 lms = fwdA * c;

    return fwdB * (lms * lms * lms);
}
// end oklab

#if COLOR_MODE == 4
vec3 pal(float t) {
    vec3 a = paletteOffset;
    vec3 b = paletteAmp;
    vec3 c = paletteFreq;
    vec3 d = palettePhase;

    t = t * repeatPalette + rotatePalette * 0.01;

    vec3 color = a + b * cos(6.28318 * (c * t + d));

    // convert to rgb if palette is in hsv or oklab mode
    // 1 = hsv, 2 = oklab, 3 = rgb
    if (paletteMode == 1) {
        color = hsv2rgb(color);
    } else if (paletteMode == 2) {
        color.g = color.g * -.509 + .276;
        color.b = color.b * -.509 + .198;
        color = linear_srgb_from_oklab(color);
        color = linearToSrgb(color);
    }

    return color;
}
#endif

vec3 generate_octave(vec2 st, vec2 freq, float s, float blend, float octave) {
    vec3 layer = vec3(
        value(st, freq, float(seed) + 10.0 * octave, blend),
        value(st, freq, float(seed) + 20.0 * octave, blend),
        value(st, freq, float(seed) + 30.0 * octave, blend));

#if COLOR_MODE == 6
    if (ridges) {
        layer.b = 1.0 - abs(layer.b * 2.0 - 1.0);
    }
#endif
    return layer;
}

vec3 multires(vec2 st, vec2 freq, int octaves, float s, float blend) {
    vec3 color = vec3(0.0);
    float multiplicand = 0.0;
#if NOISE_TYPE == 11
    // Sine noise UI maps into [40, 1]; reuse midpoint to keep axis adjustments balanced.
    float nominalBase11 = map(75.0, 1.0, 100.0, 40.0, 1.0);
    vec2 nominalFreq = vec2(nominalBase11);
#elif NOISE_TYPE == 10
    // Simplex lives in [6, 0.5]; lock distortion defaults to that midpoint.
    float nominalBase10 = map(75.0, 1.0, 100.0, 6.0, 0.5);
    vec2 nominalFreq = vec2(nominalBase10);
#else
    // Value-noise families share [20, 3]; use midpoint for consistent refract scaling.
    float nominalBaseV = map(75.0, 1.0, 100.0, 20.0, 3.0);
    vec2 nominalFreq = vec2(nominalBaseV);
#endif

    for (int i = 1; i <= octaves; i++) {
        float multiplier = pow(2.0, float(i));
        vec2 baseFreq = freq * 0.5 * multiplier;
        float nominalBase = nominalFreq.x * 0.5 * multiplier;
        multiplicand += 1.0 / multiplier;

#if REFRACT_MODE == 1 || REFRACT_MODE == 2
        {
            vec2 xRefractFreq = vec2(baseFreq.x, nominalBase);
            vec2 yRefractFreq = vec2(nominalBase, baseFreq.y);
            float xRef = value(st, xRefractFreq, s + 10.0 * float(i), blend) - 0.5;
            float yRef = value(st, yRefractFreq, s + 20.0 * float(i), blend) - 0.5;
            float ref = map(refractAmt, 0.0, 100.0, 0.0, 1.0) / multiplier;
            st = vec2(st.x + xRef * ref, st.y + yRef * ref);
        }
#endif

        vec3 layer = generate_octave(st, baseFreq, s + 10.0 * float(i), blend, float(i));

#if REFRACT_MODE == 0 || REFRACT_MODE == 2
        {
            float xOff = cos(layer.b) * 0.5 + 0.5;
            float yOff = sin(layer.b) * 0.5 + 0.5;
            vec3 ref = generate_octave(vec2(st.x + xOff, st.y + yOff), baseFreq, s + 15.0 * float(i), blend, float(i));
            layer = mix(layer, ref, map(refractAmt, 0.0, 100.0, 0.0, 1.0));
        }
#endif

        color.rgb += layer / multiplier;
    }

    color.rgb /= multiplicand;

#if COLOR_MODE == 0
    // grayscale
    if (ridges) color.b = 1.0 - abs(color.b * 2.0 - 1.0);
    return vec3(color.b);
#elif COLOR_MODE == 1
    // linear rgb
    color = srgbToLinear(color);
#elif COLOR_MODE == 2
    // srgb (no-op)
#elif COLOR_MODE == 3
    // oklab
    color.g = color.g * -.509 + .276;
    color.b = color.b * -.509 + .198;
    color = linear_srgb_from_oklab(color);
    color = linearToSrgb(color);
#elif COLOR_MODE == 4
    // palette
    if (ridges) color.b = 1.0 - abs(color.b * 2.0 - 1.0);
    {
        float d = color.b;
        if (cyclePalette == -1) {
            d += time;
        } else if (cyclePalette == 1) {
            d -= time;
        }
        color = pal(d);
    }
#else
    // hsv (default, COLOR_MODE == 6)
    color.r = color.r * hueRange * 0.01;
    color.r += 1.0 - (hueRotation / 360.0);
    color = hsv2rgb(color);
#endif

#if COLOR_MODE != 4 && COLOR_MODE != 6 && COLOR_MODE != 0
    color = rgb2hsv(color);

    color.r += 1.0 - (hueRotation / 360.0);
    color.r = fract(color.r);

#if COLOR_MODE == 1 || COLOR_MODE == 2 || COLOR_MODE == 3
    if (ridges) {
        color.b = 1.0 - abs(color.b * 2.0 - 1.0);
    }
#endif

    color = hsv2rgb(color);
#endif

    return color;
}

void main() {
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec4 color = vec4(0.0, 0.0, 0.0, 1.0);
    vec2 st = globalCoord / fullResolution.y;
    st = kaleidoscope(st, kaleido, 0.5);
    vec2 centered = st - vec2(aspectRatio * 0.5, 0.5);

    vec2 freq = vec2(1.0);
    vec2 lf = vec2(1.0);

#if NOISE_TYPE == 11
    // sine noise
    freq.x = map(xScale, 1.0, 100.0, 40.0, 1.0);
    freq.y = map(yScale, 1.0, 100.0, 40.0, 1.0);
    lf = vec2(map(loopScale, 1.0, 100.0, 10.0, 1.0));
#elif NOISE_TYPE == 10
    // simplex
    freq.x = map(xScale, 1.0, 100.0, 6.0, 0.5);
    freq.y = map(yScale, 1.0, 100.0, 6.0, 0.5);
    lf = vec2(map(loopScale, 1.0, 100.0, 6.0, 0.5));
#else
    // everything else
    freq.x = map(xScale, 1.0, 100.0, 20.0, 3.0);
    freq.y = map(yScale, 1.0, 100.0, 20.0, 3.0);
    lf = vec2(map(loopScale, 1.0, 100.0, 12.0, 3.0));
#endif

#if LOOP_OFFSET == 300
#if NOISE_TYPE == 11
    // Sine noise maps the UI slider into [40, 1]; reuse its midpoint so loop freq matches the visible field.
    float baseLoop = map(75.0, 1.0, 100.0, 40.0, 1.0);
#elif NOISE_TYPE == 10
    // Simplex noise shrinks to ~[6, 0.5]; base on its midpoint to keep loop axes in sync with main noise.
    float baseLoop = map(75.0, 1.0, 100.0, 6.0, 0.5);
#else
    // Legacy value noise families share [20, 3]; anchor to that midpoint for consistent ratios.
    float baseLoop = map(75.0, 1.0, 100.0, 20.0, 3.0);
#endif
    {
        vec2 nominalFreq = vec2(baseLoop);
        // Lock loop noise axes to the same per-axis scaling as the main field
        // so vertical tweaks do not squash the horizontal domain (and vice versa).
        lf *= freq / nominalFreq;
    }
#endif

#if NOISE_TYPE != 4 && NOISE_TYPE != 10
    if (wrap) {
        freq = floor(freq);
#if LOOP_OFFSET == 300
        lf = floor(lf);
#endif
    }
#endif

    float t = 1.0;
    if (speed < 0.0) {
        t = time + offset(st, lf);
    } else {
        t = time - offset(st, lf);
    }
    float blend = periodicFunction(t) * abs(speed) * 0.01;

    color.rgb = multires(centered, freq, octaves, float(seed), blend);

    st = globalCoord / fullResolution;

    fragColor = color;
}
