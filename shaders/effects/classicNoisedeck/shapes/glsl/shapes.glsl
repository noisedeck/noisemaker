#version 300 es

/*
 * Shapes generator shader.
 * Builds layered primitives, gradients, and repeats using deterministic hashes so random shape jitter remains reproducible.
 * UI-driven booleans toggle stroke, fill, and transform operations that are normalized to the current aspect ratio.
 */

precision highp float;
precision highp int;

// LOOP_A_OFFSET and LOOP_B_OFFSET are compile-time defines injected by the
// runtime (see definition.js `globals.loopAOffset.define` and
// `globals.loopBOffset.define`). Each unique (loopA, loopB) combination
// produces its own compiled program. The default (40 = square, 30 = diamond)
// doesn't reach the noise variants, so the entire 9-way value() dispatch and
// the variant function bodies get dead-code-eliminated by the GLSL→HLSL
// translator before ANGLE drives the D3D backend. This avoids the ~35s
// compile hang on Windows Chrome — see HANDOFF-shader-compile.md.
#ifndef LOOP_A_OFFSET
#define LOOP_A_OFFSET 40
#endif
#ifndef LOOP_B_OFFSET
#define LOOP_B_OFFSET 30
#endif

uniform float time;
uniform int seed;
uniform bool wrap;
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float loopAScale;
uniform float loopBScale;
uniform float speedA;
uniform float speedB;
uniform int paletteMode;
uniform vec3 paletteOffset;
uniform vec3 paletteAmp;
uniform vec3 paletteFreq;
uniform vec3 palettePhase;
uniform int cyclePalette;
uniform float rotatePalette;
uniform float repeatPalette;
out vec4 fragColor;

#define PI 3.14159265359
#define TAU 6.28318530718
#define aspectRatio fullResolution.x / fullResolution.y

float map(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

vec2 rotate2D(vec2 st, float rot) {
    float angle = rot *= PI;
    st -= vec2(0.5 - aspectRatio, 0.5);
    st = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * st;
    st += vec2(0.5 - aspectRatio, 0.5);
    return st;
}

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

float random(vec2 st) {
    return prng(vec3(st, 0.0)).x;
}

// periodic function for looping
float periodicFunction(float p) {
    float x = TAU * p;
    float func = sin(x);
    return map(func, -1.0, 1.0, 0.0, 1.0);
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

float constant(vec2 st, float freq, float speed) {
    vec3 randTime = randomFromLatticeWithOffset(st, freq, ivec2(40, 0));
    float scaledTime = periodicFunction(randTime.x - time) * map(abs(speed), 0.0, 100.0, 0.0, 0.33);

    vec3 rand = randomFromLatticeWithOffset(st, freq, ivec2(0, 0));
    return periodicFunction(rand.y - scaledTime);
}

// ---- 3×3 quadratic interpolation ----
// Replaces legacy bicubic 4×4 (16 taps) with 3×3 kernel (9 taps)
// Performance: ~1.8× faster
// Quality: Quadratic B-spline (degree 2) smoothing, minimum 3×3 kernel to avoid lattice artifacts

// Quadratic B-spline basis functions for 3 samples
float quadratic3(float p0, float p1, float p2, float t) {
    float t2 = t * t;
    return p0 * 0.5 * (1.0 - t) * (1.0 - t) +
           p1 * 0.5 * (-2.0 * t2 + 2.0 * t + 1.0) +
           p2 * 0.5 * t2;
}

// Catmull-Rom 3-point interpolation (degree 3, C⁰ continuous)
float catmullRom3(float p0, float p1, float p2, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    
    return p1 + 0.5 * t * (p2 - p0) + 
           0.5 * t2 * (2.0*p0 - 5.0*p1 + 4.0*p2 - p0) +
           0.5 * t3 * (-p0 + 3.0*p1 - 3.0*p2 + p0);
}

float quadratic3x3Value(vec2 st, float freq, float speed) {
    vec2 lattice = st * freq;
    vec2 f = fract(lattice);
    
    float nd = 1.0 / freq;
    
    // Sample 3×3 grid (9 taps)
    // Row -1 (y-1)
    float v00 = constant(st + vec2(-nd, -nd), freq, speed);
    float v10 = constant(st + vec2(0.0, -nd), freq, speed);
    float v20 = constant(st + vec2(nd, -nd), freq, speed);
    
    // Row 0 (y)
    float v01 = constant(st + vec2(-nd, 0.0), freq, speed);
    float v11 = constant(st, freq, speed);
    float v21 = constant(st + vec2(nd, 0.0), freq, speed);
    
    // Row 1 (y+1)
    float v02 = constant(st + vec2(-nd, nd), freq, speed);
    float v12 = constant(st + vec2(0.0, nd), freq, speed);
    float v22 = constant(st + vec2(nd, nd), freq, speed);
    
    // Quadratic interpolation along x for each row
    float y0 = quadratic3(v00, v10, v20, f.x);
    float y1 = quadratic3(v01, v11, v21, f.x);
    float y2 = quadratic3(v02, v12, v22, f.x);
    
    // Quadratic interpolation along y
    return quadratic3(y0, y1, y2, f.y);
}

float catmullRom3x3Value(vec2 st, float freq, float speed) {
    vec2 lattice = st * freq;
    vec2 f = fract(lattice);
    
    float nd = 1.0 / freq;
    
    // Sample 3×3 grid (9 taps)
    float v00 = constant(st + vec2(-nd, -nd), freq, speed);
    float v10 = constant(st + vec2(0.0, -nd), freq, speed);
    float v20 = constant(st + vec2(nd, -nd), freq, speed);
    
    float v01 = constant(st + vec2(-nd, 0.0), freq, speed);
    float v11 = constant(st, freq, speed);
    float v21 = constant(st + vec2(nd, 0.0), freq, speed);
    
    float v02 = constant(st + vec2(-nd, nd), freq, speed);
    float v12 = constant(st + vec2(0.0, nd), freq, speed);
    float v22 = constant(st + vec2(nd, nd), freq, speed);
    
    // Catmull-Rom interpolation along x for each row
    float y0 = catmullRom3(v00, v10, v20, f.x);
    float y1 = catmullRom3(v01, v11, v21, f.x);
    float y2 = catmullRom3(v02, v12, v22, f.x);
    
    return catmullRom3(y0, y1, y2, f.y);
}

// ---- End 3×3 interpolation ----

// cubic B-spline interpolation (degree 3, C² continuous)
float blendBicubic(float p0, float p1, float p2, float p3, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    
    float b0 = (1.0 - t) * (1.0 - t) * (1.0 - t) / 6.0;
    float b1 = (3.0 * t3 - 6.0 * t2 + 4.0) / 6.0;
    float b2 = (-3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0) / 6.0;
    float b3 = t3 / 6.0;
    
    return p0 * b0 + p1 * b1 + p2 * b2 + p3 * b3;
}

// Catmull-Rom 4-point interpolation (standard, tension=0.5)
float catmullRom4(float p0, float p1, float p2, float p3, float t) {
    return p1 + 0.5 * t * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + 
           t * (3.0 * (p1 - p2) + p3 - p0)));
}

float blendLinearOrCosine(float a, float b, float amount, int interp) {
    if (interp == 1) {
        return mix(a, b, amount);
    }

    return mix(a, b, smoothstep(0.0, 1.0, amount));
}

// Simplex 2D - MIT License
// https://github.com/ashima/webgl-noise/blob/master/src/noise2D.glsl
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
    const vec4 C = vec4(0.211324865405187,
                        0.366025403784439,
                       -0.577350269189626,
                        0.024390243902439);

    vec2 uv = st * freq;
    uv.x += s;

    vec2 i  = floor(uv + dot(uv, C.yy));
    vec2 x0 = uv - i + dot(i, C.xx);

    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;

    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
          + i.x + vec3(0.0, i1.x, 1.0));

    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m;
    m = m*m;

    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;

    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;

    float v = 130.0 * dot(m, g);

    return periodicFunction(map(v, -1.0, 1.0, 0.0, 1.0) - blend);
}

float sineNoise(vec2 st, float freq, float s, float blend) {
    st *= freq;
    st.x += s;

    float a = blend;
    float b = blend;
    float c = 1.0 - blend;

    vec3 r1 = prng(vec3(s)) * 0.75 + 0.125;
    vec3 r2 = prng(vec3(s + 10.0)) * 0.75 + 0.125;
    float x = sin(r1.x * st.y + sin(r1.y * st.x + a) + sin(r1.z * st.x + b) + c);
    float y = sin(r2.x * st.x + sin(r2.y * st.y + b) + sin(r2.z * st.y + c) + a);

    return (x + y) * 0.5 + 0.5;
}

float bicubicValue(vec2 st, float freq, float speed) {
    // Neighbor Distance
    float ndX = 1.0 / freq;
    float ndY = 1.0 / freq;

    float u0 = st.x - ndX;
    float u1 = st.x;
    float u2 = st.x + ndX;
    float u3 = st.x + ndX + ndX;

    float v0 = st.y - ndY;
    float v1 = st.y;
    float v2 = st.y + ndY;
    float v3 = st.y + ndY + ndY;

    float x0y0 = constant(vec2(u0, v0), freq, speed);
    float x0y1 = constant(vec2(u0, v1), freq, speed);
    float x0y2 = constant(vec2(u0, v2), freq, speed);
    float x0y3 = constant(vec2(u0, v3), freq, speed);

    float x1y0 = constant(vec2(u1, v0), freq, speed);
    float x1y1 = constant(st, freq, speed);
    float x1y2 = constant(vec2(u1, v2), freq, speed);
    float x1y3 = constant(vec2(u1, v3), freq, speed);

    float x2y0 = constant(vec2(u2, v0), freq, speed);
    float x2y1 = constant(vec2(u2, v1), freq, speed);
    float x2y2 = constant(vec2(u2, v2), freq, speed);
    float x2y3 = constant(vec2(u2, v3), freq, speed);

    float x3y0 = constant(vec2(u3, v0), freq, speed);
    float x3y1 = constant(vec2(u3, v1), freq, speed);
    float x3y2 = constant(vec2(u3, v2), freq, speed);
    float x3y3 = constant(vec2(u3, v3), freq, speed);

    vec2 uv = st * freq;

    float y0 = blendBicubic(x0y0, x1y0, x2y0, x3y0, fract(uv.x));
    float y1 = blendBicubic(x0y1, x1y1, x2y1, x3y1, fract(uv.x));
    float y2 = blendBicubic(x0y2, x1y2, x2y2, x3y2, fract(uv.x));
    float y3 = blendBicubic(x0y3, x1y3, x2y3, x3y3, fract(uv.x));

    return blendBicubic(y0, y1, y2, y3, fract(uv.y));
}

float catmullRom4x4Value(vec2 st, float freq, float speed) {
    // Neighbor Distance
    float ndX = 1.0 / freq;
    float ndY = 1.0 / freq;

    float u0 = st.x - ndX;
    float u1 = st.x;
    float u2 = st.x + ndX;
    float u3 = st.x + ndX + ndX;

    float v0 = st.y - ndY;
    float v1 = st.y;
    float v2 = st.y + ndY;
    float v3 = st.y + ndY + ndY;

    float x0y0 = constant(vec2(u0, v0), freq, speed);
    float x0y1 = constant(vec2(u0, v1), freq, speed);
    float x0y2 = constant(vec2(u0, v2), freq, speed);
    float x0y3 = constant(vec2(u0, v3), freq, speed);

    float x1y0 = constant(vec2(u1, v0), freq, speed);
    float x1y1 = constant(st, freq, speed);
    float x1y2 = constant(vec2(u1, v2), freq, speed);
    float x1y3 = constant(vec2(u1, v3), freq, speed);

    float x2y0 = constant(vec2(u2, v0), freq, speed);
    float x2y1 = constant(vec2(u2, v1), freq, speed);
    float x2y2 = constant(vec2(u2, v2), freq, speed);
    float x2y3 = constant(vec2(u2, v3), freq, speed);

    float x3y0 = constant(vec2(u3, v0), freq, speed);
    float x3y1 = constant(vec2(u3, v1), freq, speed);
    float x3y2 = constant(vec2(u3, v2), freq, speed);
    float x3y3 = constant(vec2(u3, v3), freq, speed);

    vec2 uv = st * freq;

    float y0 = catmullRom4(x0y0, x1y0, x2y0, x3y0, fract(uv.x));
    float y1 = catmullRom4(x0y1, x1y1, x2y1, x3y1, fract(uv.x));
    float y2 = catmullRom4(x0y2, x1y2, x2y2, x3y2, fract(uv.x));
    float y3 = catmullRom4(x0y3, x1y3, x2y3, x3y3, fract(uv.x));

    return catmullRom4(y0, y1, y2, y3, fract(uv.y));
}

float value(vec2 st, float freq, int interp, float speed) {
    if (interp == 3) {
        // 3×3 Catmull-Rom (9 taps)
        return catmullRom3x3Value(st, freq, speed);
    } else if (interp == 4) {
        // 4×4 Catmull-Rom (16 taps)
        return catmullRom4x4Value(st, freq, speed);
    } else if (interp == 5) {
        // 3×3 quadratic B-spline (9 taps)
        return quadratic3x3Value(st, freq, speed);
    } else if (interp == 6) {
        // 4×4 cubic B-spline (16 taps)
        return bicubicValue(st, freq, speed);
    } else if (interp == 10) {
        // simplex
        float scaledTime = periodicFunction(time) * map(abs(speed), 0.0, 100.0, 0.0, 0.333);
        return simplexValue(st, freq, float(seed), scaledTime);
    } else if (interp == 11) {
        // sine
        float scaledTime = periodicFunction(time) * map(abs(speed), 0.0, 100.0, 0.0, 0.333);
        return sineNoise(st, freq, float(seed), scaledTime);
    }

    float x1y1 = constant(st, freq, speed);

    if (interp == 0) {
        return x1y1;
    }

    // Neighbor Distance
    float ndX = 1.0 / freq;
    float ndY = 1.0 / freq;

    float x1y2 = constant(vec2(st.x, st.y + ndY), freq, speed);
    float x2y1 = constant(vec2(st.x + ndX, st.y), freq, speed);
    float x2y2 = constant(vec2(st.x + ndX, st.y + ndY), freq, speed);

    vec2 uv = st * freq;

    float a = blendLinearOrCosine(x1y1, x2y1, fract(uv.x), interp);
    float b = blendLinearOrCosine(x1y2, x2y2, fract(uv.x), interp);

    return blendLinearOrCosine(a, b, fract(uv.y), interp);
}
// end value noise

float circles(vec2 st, float freq) {
    float dist = length(st - vec2(0.5 * aspectRatio, 0.5));
    return dist * freq;
}

float rings(vec2 st, float freq) {
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

float offset(vec2 st, float freq, int loopOffset, float speed, float seed) {
    if (loopOffset == 10) {
        // circle
        return circles(st, freq);
    } else if (loopOffset == 20) {
        return shape(st, 3, freq * 0.5);
    } else if (loopOffset == 30) {
        return (abs(st.x - 0.5 * aspectRatio) + abs(st.y - 0.5)) * freq * 0.5;
    } else if (loopOffset >= 40 && loopOffset <= 120) {
        int sides = loopOffset / 10;
        return shape(st, sides, freq * 0.5);
    } else if (loopOffset == 200) {
        return st.x * freq * 0.5;
    } else if (loopOffset == 210) {
        return st.y * freq * 0.5;
    } else if (loopOffset >= 300 && loopOffset <= 380) {
        int idx = (loopOffset - 300) / 10;
        int interp = idx <= 6 ? idx : idx + 3;
        float f = loopOffset == 300 ? map(freq, 1.0, 6.0, 1.0, 20.0) : freq;
        return 1.0 - value(st + seed, f, interp, speed);
    } else if (loopOffset == 400) {
        // rings
        return 1.0 - rings(st, freq);
    } else if (loopOffset == 410) {
        // sine
        return 1.0 - diamonds(st, freq);
    }
    return 0.0;
}


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

void main() {
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec4 color = vec4(0.0, 0.0, 1.0, 1.0);
    vec2 st = globalCoord / fullResolution.y;

    float lf1 = map(loopAScale, 1.0, 100.0, 6.0, 1.0);
    if (wrap) {
        lf1 = floor(lf1);  // for seamless noise
#if LOOP_A_OFFSET >= 200 && LOOP_A_OFFSET < 300
        lf1 *= 2.0;
#endif
    }
    float amp1 = map(abs(speedA), 0.0, 100.0, 0.0, 1.0);
	float t1 = 1.0;
	if (speedA < 0.0) {
	    t1 = time + offset(st, lf1, LOOP_A_OFFSET, amp1, float(seed));
	} else if (speedA > 0.0) {
		t1 = time - offset(st, lf1, LOOP_A_OFFSET, amp1, float(seed));
	}
    float lf2 = map(loopBScale, 1.0, 100.0, 6.0, 1.0);
    if (wrap) {
        lf2 = floor(lf2);  // for seamless noise
#if LOOP_B_OFFSET >= 200 && LOOP_B_OFFSET < 300
        lf2 *= 2.0;
#endif
    }
    float amp2 = map(abs(speedB), 0.0, 100.0, 0.0, 1.0);
	float t2 = 1.0;
	if (speedB < 0.0) {
	    t2 = time + offset(st, lf2, LOOP_B_OFFSET, amp2, float(seed) + 10.0);
	} else if (speedB > 0.0) {
		t2 = time - offset(st, lf2, LOOP_B_OFFSET, amp2, float(seed) + 10.0);
	}

    float a = periodicFunction(t1) * amp1;
    float b = periodicFunction(t2) * amp2;

    float d = (abs((a + b) - 1.0));
    if (cyclePalette == -1) {
        d += time;
    } else if (cyclePalette == 1) {
        d -= time;
    }
    color.rgb = pal(d);

    st = globalCoord / fullResolution;

    fragColor = color;
}
