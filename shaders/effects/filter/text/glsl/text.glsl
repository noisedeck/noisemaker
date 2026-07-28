/*
 * Text overlay shader
 * Blends pre-rendered text texture over input with matte background
 */

#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D inputTex;
uniform sampler2D textTex;
uniform vec2 resolution;
uniform vec2 tileOffset;
uniform vec2 fullResolution;
uniform vec3 matteColor;
uniform float matteOpacity;

out vec4 fragColor;

void main() {
    vec2 globalCoord = gl_FragCoord.xy + tileOffset;
    vec2 st = globalCoord / fullResolution;

    vec4 inputColor = texture(inputTex, gl_FragCoord.xy / vec2(textureSize(inputTex, 0)));

    // The text canvas is authored to cover the whole output, so sample it in
    // normalized output space (`st`) rather than in textTex's own texel space.
    // Dividing by textureSize(textTex) pinned the overlay to a 1:1 texel patch
    // in the corner whenever the canvas size lagged the render size, and made
    // every tile of a large-format export repeat the text.
    //
    // Untiled, `st` is gl_FragCoord.xy / resolution, which is what the WGSL
    // variant computes from textureDimensions(inputTex) — so the two agree.
    // Tiled, this places the text once across the whole image rather than once
    // per tile; the host still rasterizes the canvas at tile size, so its scale
    // is approximate there. WGSL has no tile uniforms and still repeats.
    vec4 text = texture(textTex, st);

    // Text presence from canvas alpha
    float textPresence = text.a;
    float matteAlpha = matteOpacity;

    // Premultiplied blend (matches pointsRender):
    // - Text contribution (not affected by matte)
    // - Input passes through where no text AND no matte
    // - Matte replaces input where matteOpacity > 0
    vec3 rgb = text.rgb * textPresence
             + inputColor.rgb * (1.0 - textPresence) * (1.0 - matteAlpha)
             + matteColor * matteAlpha * (1.0 - textPresence);

    // Alpha: text=opaque, elsewhere blend input alpha toward opaque by matte
    float alpha = max(textPresence, mix(inputColor.a, 1.0, matteAlpha));

    fragColor = vec4(rgb, alpha);
}
