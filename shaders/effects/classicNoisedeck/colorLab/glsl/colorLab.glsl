#version 300 es

/*
 * Color lab shader.
 * Offers HSL, RGB, and curve adjustments in a single pass for rapid color grading.
 * Curves are remapped to normalized control points to ensure predictable broadcast-safe output.
 */

precision highp float;
precision highp int;

uniform sampler2D inputTex;
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform float renderScale;
uniform float time;
uniform float levels;
uniform int dither;
uniform float hueRotation;
uniform float hueRange;
uniform bool invert;
uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform int colorMode;
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

// PCG PRNG from https://github.com/riccardoscalco/glsl-pcg-prng, MIT license
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
    return prng(vec3(st, 1.0)).x;
}

float map(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

vec3 posterize(vec3 color, float lev) {
    if (lev == 0.0) {
        return color;
    } else if (lev == 1.0) {
        lev = 2.0;
    }

    float gamma = 0.65;
    color = pow(color, vec3(gamma));
    color = floor(color * lev) / lev;
    color = pow(color, vec3(1.0 / gamma));

    return color;
}

vec3 brightnessContrast(vec3 color) {
    float bright = map(brightness, -100.0, 100.0, -1.0, 1.0);
    float cont = map(contrast, 0.0, 100.0, 0.0, 2.0);

    color = (color - 0.5) * cont + 0.5 + bright;
    return color;
}

vec3 saturate(vec3 color) {
    float sat = map(saturation, -100.0, 100.0, -1.0, 1.0);
    float avg = (color.r + color.g + color.b) / 3.0;
    color -= (avg - color) * sat;
    return color;
}

vec3 desaturate(vec3 color) {
    float avg = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    return vec3(avg);
}

float periodicFunction(float p) {
    float x = TAU * p;
    float func = sin(x);
    return map(func, -1.0, 1.0, 0.0, 1.0);
}

float offsets(vec2 st) {
    return distance(st, vec2(0.5));
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

vec3 srgbToLinear(vec3 srgb) {
    vec3 linear;
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
        color = linearToSrgb(color.rgb);
    } 

    return color;
}

void main() {
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec2 uv = globalCoord / fullResolution;

    vec4 color = vec4(0.0);

    float blendy = periodicFunction(time - offsets(uv));

    color = texture(inputTex, gl_FragCoord.xy / vec2(textureSize(inputTex, 0)));

    if (levels != 0.0) {
        color.rgb = posterize(color.rgb, levels);
    }

    float bright = rgb2hsv(color.rgb)[2];

    if (dither == 1) {
        // threshold
        color.rgb *= vec3(step(0.5, bright));

    } else if (dither == 2) {
        // random
        color.rgb *= vec3(step(random(globalCoord), bright));

    } else if (dither == 3) {
        // random + time
        color.rgb *= vec3(step(periodicFunction(random(globalCoord) + time), bright));

    } else if (dither == 4) {
        // bayer
        vec2 coord = mod(globalCoord / renderScale, 4.0).xy - 0.5;

        if (bright < 0.12) {
            color.rgb = vec3(0.0);
        } else if (bright < 0.24) {
            color.rgb *= (coord.xy == vec2(1.0)) ? vec3(1.0) : vec3(0.0);
        } else if (bright < 0.36) {
            color.rgb *= (coord.xy == vec2(1.0) || coord.xy == vec2(3.0)) ? vec3(1.0) : vec3(0.0);
        } else if (bright < 0.48) {
            color.rgb *= ((coord.x == 1.0 || coord.x == 3.0) && (coord.y == 1.0 || coord.y == 3.0)) ? vec3(1.0) : vec3(0.0);
        } else if (bright < 0.60) {
            color.rgb *= ((coord.x == 1.0 || coord.x == 3.0) && (coord.y == 1.0 || coord.y == 3.0)) ? vec3(0.0) : vec3(1.0);
        } else if (bright < 0.72) {
            color.rgb *= (coord.xy == vec2(1.0) || coord.xy == vec2(3.0)) ? vec3(0.0) : vec3(1.0);
        } else if (bright < 0.84) {
            color.rgb *= (coord.xy == vec2(1.0)) ? vec3(0.0) : vec3(1.0);
        }
    }

    // color fun
    if (colorMode == 0) {
        // grayscale
        color.rgb = vec3(rgb2hsv(color.rgb).b);
    } else if (colorMode == 1) {
        // linear rgb
        color.rgb = srgbToLinear(color.rgb);
    } else if (colorMode == 3) {
        // oklab
        // magic values from py-noisemaker - MIT License
        // https://github.com/noisefactorllc/noisemaker/blob/main/noisemaker/generators.py
        color.g = color.g * -.509 + .276;
        color.b = color.b * -.509 + .198;

        color.rgb = linear_srgb_from_oklab(color.rgb);
        color.rgb = linearToSrgb(color.rgb);
    } else if (colorMode == 4) {
        // palette
        float d = rgb2hsv(color.rgb).b;
        if (cyclePalette == -1) {
            d += time;
        } else if (cyclePalette == 1) {
            d -= time;
        }
        color.rgb = pal(d);
    }

    vec3 hsv = rgb2hsv(color.rgb);
    hsv[0] = mod(hsv[0] * map(hueRange, 0.0, 200.0, 0.0, 2.0)
                 + (hueRotation / 360.0), 1.0);
    color.rgb = hsv2rgb(hsv);

    if (invert) {
        color.rgb = 1.0 - color.rgb;
    }

    // brightness/contrast/saturation
    color.rgb = brightnessContrast(color.rgb);
    color.rgb = saturate(color.rgb);

    fragColor = color;
}
