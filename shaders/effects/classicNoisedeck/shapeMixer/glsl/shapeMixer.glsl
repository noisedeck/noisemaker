#version 300 es

/*
 * Shape mixer shader.
 * Combines procedural shapes and mixes them with the input feed under configurable blend modes.
 * Thresholds and rotations are normalized against aspect ratio to avoid distortions when layering.
 */

precision highp float;
precision highp int;

uniform sampler2D inputTex;
uniform sampler2D tex;
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float time;
// LOOP_OFFSET is a compile-time define injected by the runtime (see
// definition.js `globals.LOOP_OFFSET.define`). Same fix as kaleido/shapes.
#ifndef LOOP_OFFSET
#define LOOP_OFFSET 10
#endif

uniform int seed;
uniform int blendMode;
uniform float loopScale;
uniform int paletteMode;
uniform vec3 paletteOffset;
uniform vec3 paletteAmp;
uniform vec3 paletteFreq;
uniform vec3 palettePhase;
uniform int animate;
uniform int cyclePalette;
uniform float rotatePalette;
uniform float repeatPalette;
uniform float levels;
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
	return vec3(pcg(uvec3(p))) / float(uint(0xffffffff));
}
// end PCG PRNG


vec3 hsv2rgb(vec3 hsv) {
    float h = fract(hsv.x);
    float s = hsv.y;
    float v = hsv.z;
    
    float c = v * s; // Chroma
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = v - c;

    vec3 rgb;

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
    vec3 srgb;
    for (int i = 0; i < 3; ++i) {
        if (linear[i] <= 0.0031308) {
            srgb[i] = linear[i] * 12.92;
        } else {
            srgb[i] = 1.055 * pow(linear[i], 1.0 / 2.4) - 0.055;
        }
    }
    return srgb;
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

float posterize(float d, float lev) {
    if (lev == 0.0) {
        return d;
    } else if (lev == 1.0) {
        lev = 2.0;
    }

    d = clamp(d, 0.0, 0.99);
    d *= lev;
    d = floor(d) + 0.5;
    d = d / lev;
    return d;
}

float posterize2(float d, float lev) {
    if (lev == 0.0) {
        return d;
    } else {
        lev += 0.1;
    }

    return floor(d * lev) / lev;
}

vec3 posterize2(vec3 c, float lev) {
    c.r = posterize2(c.r, lev);
    c.g = posterize2(c.g, lev);
    c.b = posterize2(c.b, lev);
    return c;
}

bool isNan(float val) {
    return (val <= 0.0 || 0.0 <= val) ? false : true;
}

 bool isInf(float val) {
    return (val != 0.0 && val * 2.0 == val) ? true : false;
}

vec3 pal(float t) {
    if (isNan(t)) {
        //return vec3(0.0, 1.0, 0.0);
        return vec3(0.0);
        //t = 0.0;
    } else if (isInf(t)) {
        //return vec3(1.0, 0.0, 0.0);
        return vec3(0.0);
        //t = 0.0;
    }

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

float luminance(vec3 color) {
    return rgb2hsv(color).b;
}

float map(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

float rings(vec2 st, float freq) {
    float dist = length(st - vec2(0.5 * aspectRatio, 0.5));
    return cos(dist * PI * freq);
}

float circles(vec2 st, float freq) {
    float dist = length(st - vec2(0.5 * aspectRatio, 0.5));
    return dist * freq;
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

float random(vec2 st) {
    return prng(vec3(st, 0.0)).x;
}

float f(vec2 st) {
    return random(floor(st));
}

float periodicFunction(float p) {
    return map(sin(p * TAU), -1.0, 1.0, 0.0, 1.0);
}

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
vec3 mod289(vec3 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec2 mod289(vec2 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec3 permute(vec3 x) {
    return mod289(((x*34.0)+1.0)*x);
}

float simplexValue(vec2 st, float freq, float s, float blend) {
    const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                        0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                       -0.577350269189626,  // -1.0 + 2.0 * C.x
                        0.024390243902439); // 1.0 / 41.0

    vec2 uv = st * freq;
    st.x *= aspectRatio;
    uv.x += s;

    // First corner
    vec2 i  = floor(uv + dot(uv, C.yy) );
    vec2 x0 = uv -   i + dot(i, C.xx);

    // Other corners
    vec2 i1;
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

// end simplex

// Noisemaker value noise - MIT License
// https://github.com/noisefactorllc/noisemaker/blob/main/noisemaker/value.py
int positiveModulo(int value, int modulus) {
    if (modulus == 0) {
        return 0;
    }

    int r = value % modulus;
    return (r < 0) ? r + modulus : r;
}

vec3 randomFromLatticeWithOffset(vec2 st, float freq, ivec2 offset) {
    vec2 lattice = st * freq;
    vec2 baseFloor = floor(lattice);
    ivec2 base = ivec2(baseFloor) + offset;
    vec2 frac = lattice - baseFloor;

    int seedInt = seed;
    float seedFrac = 0.0;

    float xCombined = frac.x + seedFrac;
    int xi = base.x + seedInt + int(floor(xCombined));
    int yi = base.y;

    if (wrap) {
        int freqInt = int(freq + 0.5);

        if (freqInt > 0) {
            xi = positiveModulo(xi, freqInt);
            yi = positiveModulo(yi, freqInt);
        }
    }

    uint xBits = uint(xi);
    uint yBits = uint(yi);
    uint seedBits = uint(seed);
    uint fracBits = floatBitsToUint(seedFrac);

    uvec3 jitter = uvec3(
        (fracBits * 374761393u) ^ 0x9E3779B9u,
        (fracBits * 668265263u) ^ 0x7F4A7C15u,
        (fracBits * 2246822519u) ^ 0x94D049B4u
    );

    uvec3 state = uvec3(xBits, yBits, seedBits) ^ jitter;
    uvec3 prngState = pcg(state);
    float denom = float(0xffffffffu);
    return vec3(
        float(prngState.x) / denom,
        float(prngState.y) / denom,
        float(prngState.z) / denom
    );
}

float constant(vec2 st, float freq) {
    vec3 randTime = randomFromLatticeWithOffset(st, freq, ivec2(40, 0));

    float scaledTime = 1.0;
    if (animate == -1) {
        scaledTime = periodicFunction(randTime.x - time);
    } else if (animate == 1) {
        scaledTime = periodicFunction(randTime.x + time);
    }

    vec3 rand = randomFromLatticeWithOffset(st, freq, ivec2(0, 0));
    return periodicFunction(rand.x - scaledTime);
}

// ---- 3×3 quadratic B-spline interpolation ----
// Replaces legacy bicubic 4×4 (16 taps) with 3×3 kernel (9 taps)
// Performance: ~1.8× faster
// Quality: Quadratic B-spline (degree 2), C¹ continuous, smoothing

// Quadratic B-spline interpolation for 3 samples (degree 2, C¹ continuous)
float quadratic3(float p0, float p1, float p2, float t) {
    // B-spline basis functions for quadratic (3 control points)
    // Does NOT pass through control points (smoothing, not interpolating)
    float t2 = t * t;
    
    float B0 = 0.5 * (1.0 - t) * (1.0 - t);
    float B1 = 0.5 * (-2.0 * t2 + 2.0 * t + 1.0);
    float B2 = 0.5 * t2;
    
    return p0 * B0 + p1 * B1 + p2 * B2;
}

float quadratic3x3Value(vec2 st, float freq) {
    vec2 lattice = st * freq;
    vec2 f = fract(lattice);
    
    float nd = 1.0 / freq;
    
    // Sample 3×3 grid (9 taps)
    // Row -1 (y-1)
    float v00 = constant(st + vec2(-nd, -nd), freq);
    float v10 = constant(st + vec2(0.0, -nd), freq);
    float v20 = constant(st + vec2(nd, -nd), freq);
    
    // Row 0 (y)
    float v01 = constant(st + vec2(-nd, 0.0), freq);
    float v11 = constant(st, freq);
    float v21 = constant(st + vec2(nd, 0.0), freq);
    
    // Row 1 (y+1)
    float v02 = constant(st + vec2(-nd, nd), freq);
    float v12 = constant(st + vec2(0.0, nd), freq);
    float v22 = constant(st + vec2(nd, nd), freq);
    
    // Quadratic B-spline interpolation along x for each row
    float y0 = quadratic3(v00, v10, v20, f.x);
    float y1 = quadratic3(v01, v11, v21, f.x);
    float y2 = quadratic3(v02, v12, v22, f.x);
    
    // Quadratic B-spline interpolation along y
    return quadratic3(y0, y1, y2, f.y);
}

float blendLinearOrCosine(float a, float b, float amount, int interp) {
    if (interp == 1) {
        return mix(a, b, amount);
    }

    return mix(a, b, smoothstep(0.0, 1.0, amount));
}

float value(vec2 st, float freq, int interp) {
    vec2 st2 = st - vec2(0.5 * aspectRatio, 0.5);
    float scaledTime = 1.0;
    float d = 0.0;

    if (interp == 5) {
        // 3×3 quadratic B-spline (9 taps)
        d = quadratic3x3Value(st, freq);
    } else if (interp == 10) {
        if (animate == -1) {
            scaledTime = simplexValue(st, freq, float(seed) + 40.0, time);
        } else if (animate == 1) {
            scaledTime = simplexValue(st, freq, float(seed) + 40.0, -time);
        }
        d = simplexValue(st, freq, float(seed), scaledTime);
    } else {
        float x1y1 = constant(st, freq);

        if (interp == 0) {
            d = x1y1;
        } else {

            // Neighbor Distance
            float ndX = 1.0 / freq;
            float ndY = 1.0 / freq;

            float x1y2 = constant(vec2(st.x, st.y + ndY), freq);
            float x2y1 = constant(vec2(st.x + ndX, st.y), freq);
            float x2y2 = constant(vec2(st.x + ndX, st.y + ndY), freq);

            vec2 uv = st * freq;

            float a = blendLinearOrCosine(x1y1, x2y1, fract(uv.x), interp);
            float b = blendLinearOrCosine(x1y2, x2y2, fract(uv.x), interp);

            d = blendLinearOrCosine(a, b, fract(uv.y), interp);
        }
    }
    return d;
}

float sineNoise(vec2 st, float freq) {
    st -= vec2(aspectRatio * 0.5, 0.5);
    st *= freq;
    st += vec2(aspectRatio * 0.5, 0.5);

    vec3 r1 = prng(vec3(float(seed)));
    vec3 r2 = prng(vec3(float(seed) + 10.0));

    float scaleA = r1.x * TAU; 
    float scaleC = r1.y * TAU;
    float scaleB = r1.z * TAU;
    float scaleD = r2.x * TAU;

    float offA = r2.y * TAU;
    float offB = r2.z * TAU;
    return sin(scaleA * st.x + sin(scaleB * st.y + offA)) + sin(scaleC * st.y + sin(scaleD * st.x + offB)) * 0.5 + 0.5;
}


float offset(vec2 st, float freq) {
    st.x *= aspectRatio;

    float d = 0.0;
    if (LOOP_OFFSET == 10) {
        // circle
        d = circles(st, freq);
    } else if (LOOP_OFFSET == 20) {
        d = shape(st, 3, freq * 0.5);
    } else if (LOOP_OFFSET == 30) {
        d = (abs(st.x - 0.5 * aspectRatio) + abs(st.y - 0.5)) * freq * 0.5;
    } else if (LOOP_OFFSET >= 40 && LOOP_OFFSET <= 80) {
        int sides = LOOP_OFFSET / 10;
        d = shape(st, sides, freq * 0.5);
    } else if (LOOP_OFFSET == 200) {
        d = st.x * freq * 0.5;
    } else if (LOOP_OFFSET == 210) {
        d = st.y * freq * 0.5;
    } else if (LOOP_OFFSET == 380) {
        return 1.0 - sineNoise(st, freq);
    } else if (LOOP_OFFSET >= 300 && LOOP_OFFSET <= 370) {
        int idx = (LOOP_OFFSET - 300) / 10;
        int interp = idx <= 6 ? idx : idx + 3;
        d = 1.0 - value(st, freq, interp);
    } else if (LOOP_OFFSET == 400) {
        // rings
        d = 1.0 - rings(st, freq);
    } else if (LOOP_OFFSET == 410) {
        // sine
        d = 1.0 - diamonds(st, freq) * 0.5 + 0.5;
    }
    
    return d;
}


vec3 blend(vec3 color1, vec3 color2, int mode, float factor) {
    vec3 color = vec3(0.0);

    factor = 1.0 - factor;

    if (mode == 0) {
        // add
        color = color1 + color2 * factor;
    } else if (mode == 1) {
        // divide
        color = color1 / color2 * factor;
    } else if (mode == 2) {
        // max
        color =  max(color1, color2 * factor);
    } else if (mode == 3) {
        // min
        color = min(color1, color2 * factor);
    } else if (mode == 4) {
        // mix
        factor = clamp(factor, 0.0, 1.0);
        color = mix(color1, color2, factor);
    } else if (mode == 5) {
        // mod
        color = mod(color1, color2 * factor);
    } else if (mode == 6) {
        // multiply
        color = color1 * color2 * factor;
    } else if (mode == 7) {
        // reflect
        color = reflect(color1, color2 * factor);
    } else if (mode == 8) {
        // refract
        color = refract(color1, color2, factor);
    } else if (mode == 9) {
        // subtract
        color = color1 - color2 * factor;
    } else {
        factor = clamp(factor, 0.0, 1.0);
        color = mix(color1, color2, factor);
    }

    return color;
}


float blend(float color1, float color2, int mode, float factor) {
    float color = 0.0;

    factor = 1.0 - factor;

    if (mode == 0) {
        // add
        color = color1 + color2 * factor;
    } else if (mode == 1) {
        // divide
        color2 = max(0.1, color2 * factor);
        color = color1 / color2;
    } else if (mode == 2) {
        // max
        color =  max(color1, color2 * factor);
    } else if (mode == 3) {
        // min
        color = min(color1, color2 * factor);
    } else if (mode == 4) {
        // mix
        factor = clamp(factor, 0.0, 1.0);
        color = mix(color1, color2, factor);
    } else if (mode == 5) {
        // mod
        color2 = max(0.1, color2 * factor);
        color = mod(color1, color2);
    } else if (mode == 6) {
        // multiply
        color = color1 * color2 * factor;
    } else if (mode == 7) {
        // reflect
        color = reflect(color1, color2 * factor);
    } else if (mode == 8) {
        // refract
        color = refract(color1, color2, factor);
    } else if (mode == 9) {
        // subtract
        color = color1 - color2 * factor;
    } else {
        factor = clamp(factor, 0.0, 1.0);
        color = mix(color1, color2, factor);
    }

    return color;
}

void main() {
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec4 color = vec4(0.0, 0.0, 1.0, 1.0);
    vec2 st = globalCoord / fullResolution;

    vec4 color1 = texture(inputTex, gl_FragCoord.xy / vec2(textureSize(inputTex, 0)));
    vec4 color2 = texture(tex, gl_FragCoord.xy / vec2(textureSize(tex, 0)));

    float freq = 1.0;
    if (LOOP_OFFSET == 350) {
        freq = map(loopScale, 1.0, 100.0, 12.0, 0.5);
    } else {
        freq = map(loopScale, 1.0, 100.0, 10.0, 2.0);
    }
    if (LOOP_OFFSET >= 300 && LOOP_OFFSET < 340 && wrap) {
        freq = floor(freq);  // for seamless noise
        freq *= 2.0;
    }

    float t = 1.0;
    if (animate == -1) {
        t = time + offset(st, freq);
    } else if (animate == 1) {
        t = time - offset(st, freq);
    } else {
        t = offset(st, freq);
    }
    float blendy = periodicFunction(t);

    if (LOOP_OFFSET == 0) {
        blendy = 0.5;
    }

    // avg color of 1 and 2 and blend with float version of blend, then apply palette
    float avg1 = luminance(color1.rgb);
    float avg2 = luminance(color2.rgb);
    float avgMix = blend(avg1, avg2, blendMode, blendy);
    float d = posterize(avgMix, levels);

    if (paletteMode == 4) {
        color.rgb = blend(color1.rgb, color2.rgb, blendMode, blendy * 0.5);

        color.rgb = rgb2hsv(color.rgb);
        color.r += rotatePalette * 0.01;

        if (cyclePalette == -1) {
            color.r = mod(color.r + time, 1.0);
        } else if (cyclePalette == 1) {
            color.r = mod(color.r - time, 1.0);
        } 

        color.rgb = hsv2rgb(color.rgb);
        color.rgb = posterize2(color.rgb, levels);
    } else {
        if (cyclePalette == -1) {
            color.rgb = pal(d + time);
        } else if (cyclePalette == 1) { 
            color.rgb = pal(d - time);
        } else {
            color.rgb = pal(d);
        }
    }

    color.a = max(color1.a, color2.a);
    
    fragColor = color;
}
