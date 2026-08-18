// GPGPU Pass 2: Find brightest pixel x-coordinate per row (optimized)
// Input: luminance texture (R = luminance)
// Output: R = brightest x (normalized), G = max luminance, B = 0, A = 1
// Uses sparse sampling for O(1) approximate result

@group(0) @binding(0) var lumTex : texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
};

@fragment
fn main(input : VertexOutput) -> @location(0) vec4<f32> {
    let coord : vec2<i32> = vec2<i32>(input.position.xy);
    let size : vec2<i32> = vec2<i32>(textureDimensions(lumTex));
    let y : i32 = coord.y;
    let width : i32 = size.x;
    
    // Use sparse sampling to find approximate brightest pixel
    const NUM_SAMPLES : i32 = 32;
    var maxLum : f32 = -1.0;
    var brightestX : i32 = 0;
    
    for (var s : i32 = 0; s < NUM_SAMPLES; s = s + 1) {
        let sampleX : i32 = (s * width) / NUM_SAMPLES;
        let lum : f32 = textureLoad(lumTex, vec2<i32>(sampleX, y), 0).r;
        if (lum > maxLum) {
            maxLum = lum;
            brightestX = sampleX;
        }
    }
    
    // Output: normalized brightest x, max luminance
    return vec4<f32>(f32(brightestX) / f32(width - 1), maxLum, 0.0, 1.0);
}
