#version 300 es

/*
 * Bit-effects post processor.
 * Simulates 8-bit logic chains against the input feed by masking integer operations to reproduce hardware-limited artifacts.
 * PCG jitter and temporal remapping maintain deterministic scanline motion across render targets.
 */

precision highp float;
precision highp int;

uniform float time;
// MODE is a compile-time define injected by the runtime (see definition.js
// `globals.mode.define`). Picks bitField vs bitMask at compile time so the
// unused half of the shader is dead-code-eliminated. Each mode has its own
// independent set of helpers, ~1.4s of compile each on Windows Chrome via
// ANGLE→D3D, so splitting them halves the worst-case compile time.
#ifndef MODE
#define MODE 1
#endif

// FORMULA, COLOR_SCHEME, INTERP are compile-time defines used only when
// MODE == 0 (bitField). MASK_FORMULA, MASK_COLOR_SCHEME are only used when
// MODE == 1 (bitMask). Same Knob 2 rationale as the rest of the series —
// baking these lets ANGLE DCE the unreachable branches in the now-dispatched
// functions.
#ifndef FORMULA
#define FORMULA 0
#endif
#ifndef COLOR_SCHEME
#define COLOR_SCHEME 20
#endif
#ifndef INTERP
#define INTERP 0
#endif
#ifndef MASK_FORMULA
#define MASK_FORMULA 10
#endif
#ifndef MASK_COLOR_SCHEME
#define MASK_COLOR_SCHEME 1
#endif

uniform int seed;
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float n;
uniform float scale;
uniform float rotation;
uniform float speed;
// `mode` is no longer a runtime uniform — see MODE define at top of file.
uniform float tiles;
uniform float complexity;
uniform float hueRange;
uniform float hueRotation;
uniform float baseHueRange;
out vec4 fragColor;

#define PI 3.14159265359
#define TAU 6.28318530718
#define aspectRatio fullResolution.x / fullResolution.y

float map(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
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

vec2 rotate2D(vec2 st, float rot) {
    rot = map(rot, 0.0, 360.0, 0.0, 1.0);
    float angle = rot * TAU;
    st -= fullResolution * 0.5;
    st = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * st;
    st += fullResolution * 0.5;
    return st;
}

// periodic function for looping
float periodicFunction(float p) {
    return map(sin(p * TAU), -1.0, 1.0, 0.0, 1.0);
}

// Noisemaker value noise - MIT License
// https://github.com/noisefactorllc/noisemaker/blob/main/noisemaker/value.py
vec3 randomFromLatticeWithOffset(vec2 st, float xFreq, float yFreq, float s, ivec2 offset) {
    vec2 lattice = vec2(st.x * xFreq, st.y * yFreq);
    vec2 baseFloor = floor(lattice);
    ivec2 base = ivec2(baseFloor) + offset;
    vec2 frac = lattice - baseFloor;

    int seedInt = int(floor(s));
    float seedFrac = fract(s);

    float xCombined = frac.x + seedFrac;
    int xi = base.x + seedInt + int(floor(xCombined));
    int yi = base.y;

    uint xBits = uint(xi);
    uint yBits = uint(yi);
    uint seedBits = floatBitsToUint(s);
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

float constant(vec2 st, float xFreq, float yFreq, float s) {
    vec3 randTime = randomFromLatticeWithOffset(st, xFreq, yFreq, s, ivec2(40, 0));
    float scaledTime = periodicFunction(randTime.x - time) * map(abs(speed), 0.0, 100.0, 0.0, 0.333);

    vec3 rand = randomFromLatticeWithOffset(st, xFreq, yFreq, s, ivec2(0, 0));
    return periodicFunction(rand.x - scaledTime);
}

float value(vec2 st, float xFreq, float yFreq, float s) {
    float x1y1 = constant(st, xFreq, yFreq, s);

#if INTERP == 0
    return x1y1;
#else
    // Neighbor Distance
    float ndX = 1.0 / xFreq;
    float ndY = 1.0 / yFreq;

    float x1y2 = constant(vec2(st.x, st.y + ndY), xFreq, yFreq, s);
    float x2y1 = constant(vec2(st.x + ndX, st.y), xFreq, yFreq, s);
    float x2y2 = constant(vec2(st.x + ndX, st.y + ndY), xFreq, yFreq, s);

    vec2 uv = vec2(st.x * xFreq, st.y * yFreq);

    float a = mix(x1y1, x2y1, fract(uv.x));
    float b = mix(x1y2, x2y2, fract(uv.x));

    return mix(a, b, fract(uv.y));
#endif
}

// bitwise operations
const int BIT_COUNT = 8;
const int mask = (1 << BIT_COUNT) - 1;

int modi(int x, int y) {
    return (x % y) & mask;
}

int or(int a, int b) {
    return (a & mask) | (b & mask);
}

int and(int a, int b) {
    return (a & mask) & (b & mask);
}

int not2(int a) {
    return (a ^ 0xFFFFFFFF) & mask;
}

int xor(int a, int b) {
    return (a & mask) ^ (b & mask);
}

float or(float a, float b) {
    return float(or(int(a), int(b)));
}

float and(float a, float b) {
    return float(and(int(a), int(b)));
}

float not3(float a) {
    return float(not2(int(a)));
}

float xor(float a, float b) {
    return float(xor(int(a), int(b)));
}
// end bitwise operations

// bit fields, inspired by https://twitter.com/aemkei/status/1378106731386040322
float bitValue(vec2 st, float freq, float nForColor) {
    float blendy = nForColor + periodicFunction(value(st, freq * 0.01, freq * 0.01, nForColor) * 0.1) * 100.0;

    float v = 1.0;

#if FORMULA == 0
    // alien
    v = mod(xor(st.x * freq, st.y * freq), blendy);
#elif FORMULA == 1
    // sierpinski
    v = mod(or(st.x * freq, st.y * freq), blendy);
#elif FORMULA == 2
    // circular
    v = mod((st.x * freq) * (st.y * freq), blendy);
#elif FORMULA == 3
    // steps
    v = float(xor(st.x * freq, st.y * freq) < blendy);
#elif FORMULA == 4
    // beams
    v = mod(st.x * freq * blendy, st.y * freq);
#elif FORMULA == 5
    // perspective
    v = mod(((st.x * freq - 0.5) * 0.25), st.y * freq - 0.5);
#endif

    return v > 1.0 ? 0.0 : 1.0;
}

vec3 bitField(vec2 st) {
    st /= scale;
    st = rotate2D(st, rotation); 
    
    float freq = map(scale, 1.0, 100.0, scale, 8.0);

    vec3 color = vec3(0.0);

#if COLOR_SCHEME == 0
    // blue
    color.b = bitValue(st, freq, n);
#elif COLOR_SCHEME == 1
    // cyan
    color.gb = vec2(bitValue(st, freq, n));
#elif COLOR_SCHEME == 2
    // green
    color.g = bitValue(st, freq, n);
#elif COLOR_SCHEME == 3
    // magenta
    color.br = vec2(bitValue(st, freq, n));
#elif COLOR_SCHEME == 4
    // red
    color.r = bitValue(st, freq, n);
#elif COLOR_SCHEME == 5
    // white
    color.rgb = vec3(bitValue(st, freq, n));
#elif COLOR_SCHEME == 6
    // yellow
    color.rg = vec2(bitValue(st, freq, n));
#elif COLOR_SCHEME == 10
    // blue green
    color.b = bitValue(st, freq, n);
    color.g = bitValue(st, freq, n + 1.0);
#elif COLOR_SCHEME == 11
    // blue red
    color.b = bitValue(st, freq, n);
    color.r = bitValue(st, freq, n + 1.0);
#elif COLOR_SCHEME == 12
    // blue yellow
    color.b = bitValue(st, freq, n);
    color.rg = vec2(bitValue(st, freq, n + 1.0));
#elif COLOR_SCHEME == 13
    // green magenta
    color.g = bitValue(st, freq, n);
    color.rb = vec2(bitValue(st, freq, n + 1.0));
#elif COLOR_SCHEME == 14
    // green red
    color.g = bitValue(st, freq, n);
    color.r = bitValue(st, freq, n + 1.0);
#elif COLOR_SCHEME == 15
    // red cyan
    color.r = bitValue(st, freq, n);
    color.bg = vec2(bitValue(st, freq, n + 1.0));
#elif COLOR_SCHEME == 20
    // rgb
    color.r = bitValue(st, freq, n);
    color.g = bitValue(st, freq, n + 1.0);
    color.b = bitValue(st, freq, n + 2.0);
#endif

    return color;
}

// from bit-mask
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

float maskValue(vec2 st, float xFreq, float yFreq, float s) {
    return constant(st, xFreq, yFreq, s);
}

float maskValue(vec2 st, float freq, float s) {
    return maskValue(st, freq, freq, s);
}

float arecibo(vec2 st, float xFreq, float yFreq, float _seed) {
    float xMod = mod(floor(st.x * xFreq), xFreq);
    float yMod = mod(floor(st.y * yFreq), yFreq);

    float v = 1.0;

    if (xMod == 0.0 || yMod == 0.0 || xMod == (xFreq - 1.0) || yMod == (yFreq - 1.0)) {
        v = 0.0;
    } else if (yMod == 1.0) {
        v = xMod == 1.0 ? 1.0 : 0.0;
    } else {
        v = maskValue(st, xFreq, yFreq, _seed);
    }

    return v;
}

float areciboNum(vec2 st, float freq, float _seed) {
    return arecibo(st, floor(freq * 0.5) + 1.0, floor(freq), _seed);
}

float glyphs(vec2 st, float freq, float _seed) {
    float xFreq = floor(freq * 0.75);

    float xMod = mod(floor(st.x * xFreq), xFreq);
    float yMod = mod(floor(st.y * freq), freq);

    float v = 1.0;

    if (xMod == 0.0 || yMod == 0.0 || xMod == (xFreq - 1.0) || yMod == (freq - 1.0)) {
        v = 0.0;
    } else {
        v = maskValue(st, xFreq, freq, _seed);
    }

    return v;
}

float invaders(vec2 st, float freq, float _seed) {
    float xMod = mod(floor(st.x * freq), freq);
    float yMod = mod(floor(st.y * freq), freq);

    float v = 1.0;

    if (xMod == 0.0 || yMod == 0.0 || xMod == (freq - 1.0) || yMod == (freq - 1.0)) {
        v = 0.0;
    } else if (xMod >= freq * 0.5) {
        v = maskValue(vec2(floor(st.x) + (1.0 - fract(st.x)), st.y), freq, _seed);
    } else {
        v = maskValue(st, freq, _seed);
    }

    return v;
}

float bitMaskValue(vec2 st, float freq, float _seed) {
    float v = 1.0;

#if MASK_FORMULA == 10 || MASK_FORMULA == 11
    v = invaders(st, freq, _seed);
#elif MASK_FORMULA == 20
    v = glyphs(st, freq, _seed);
#elif MASK_FORMULA == 30
    v = areciboNum(st, freq, _seed);
#endif

    return v;
}

vec3 bitMask(vec2 st) {
    vec3 color = vec3(0.0);

    st -= vec2(0.5 * aspectRatio, 0.5);
    st *= tiles;
    st += vec2(0.5 * aspectRatio, 0.5);

    st.x -= 0.5 * aspectRatio;

#if MASK_FORMULA == 11
    st.y *= 2.0;
#endif

    float freq = floor(map(complexity, 1.0, 100.0, 5.0, 12.0));

    float mask = bitMaskValue(st, freq, -100.0) > 0.5 ? 1.0 : 0.0;

#if MASK_COLOR_SCHEME == 0
    color.r = mask;
    color.g = mask;
    color.b = mask;
#else
    {
        float baseHue = 0.01 + maskValue(st, 1.0, -100.0) * baseHueRange * 0.01;

        color.r = fract(baseHue + bitMaskValue(st, freq, 0.0) * hueRange * 0.01 + (1.0 - (hueRotation / 360.0))) * mask;

#if MASK_COLOR_SCHEME == 3
        color.g = mask;
#else
        color.g = bitMaskValue(st, freq, 25.0) * mask;
#endif

#if MASK_COLOR_SCHEME == 2 || MASK_COLOR_SCHEME == 3
        color.b = mask;
#else
        color.b = bitMaskValue(st, freq, 50.0) * mask;
#endif

        color = hsv2rgb(color);
    }
#endif
    return color;
}

void main() {
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec4 color = vec4(0.0, 0.0, 0.0, 1.0);
    vec2 st = globalCoord;

#if MODE == 0
    // bit field
    color.rgb = bitField(st);
#else
    st = globalCoord / fullResolution.y;
    st += float(seed) + 1000.0;
    color.rgb = bitMask(st);
#endif

    st = globalCoord / fullResolution;

    fragColor = color;
}
