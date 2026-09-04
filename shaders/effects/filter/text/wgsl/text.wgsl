/*
 * Text overlay shader
 * Blends pre-rendered text texture over input with matte background
 */

@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var textTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> matteColor: vec3<f32>;
@group(0) @binding(4) var<uniform> matteOpacity: f32;
@group(0) @binding(5) var<uniform> tileOffset: vec2<f32>;
@group(0) @binding(6) var<uniform> fullResolution: vec2<f32>;

@fragment
fn main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let size = max(textureDimensions(inputTex, 0), vec2<u32>(1, 1));
    let localUV = position.xy / vec2<f32>(size);
    var fullSize = vec2<f32>(size);
    if (fullResolution.x > 0.0) { fullSize = fullResolution; }
    let globalUV = (position.xy + tileOffset) / fullSize;

    let inputColor = textureSample(inputTex, texSampler, localUV);
    let text = textureSample(textTex, texSampler, globalUV);

    // Text presence from canvas alpha (1.0 where text exists, 0.0 elsewhere)
    let textPresence = text.a;
    let matteAlpha = matteOpacity;

    // Premultiplied blend (matches pointsRender):
    // - Text contribution (not affected by matte)
    // - Input passes through where no text AND no matte
    // - Matte replaces input where matteOpacity > 0
    let rgb = text.rgb * textPresence
            + inputColor.rgb * (1.0 - textPresence) * (1.0 - matteAlpha)
            + matteColor * matteAlpha * (1.0 - textPresence);

    // Alpha: text=opaque, elsewhere blend input alpha toward opaque by matte
    let alpha = max(textPresence, mix(inputColor.a, 1.0, matteAlpha));

    return vec4<f32>(rgb, alpha);
}
