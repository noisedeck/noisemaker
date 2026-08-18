// Pixel Sort Pass 1: Rotate input texture based on angle
// Fragment shader version for WebGPU render pipeline

const PI : f32 = 3.141592653589793;

@group(0) @binding(0) var inputTex : texture_2d<f32>;
@group(0) @binding(1) var input_sampler : sampler;
@group(0) @binding(2) var<uniform> resolution : vec2<f32>;
@group(0) @binding(3) var<uniform> angled : f32;
@group(0) @binding(4) var<uniform> darkest : f32;
@group(0) @binding(5) var<uniform> wrap : f32;

fn applyWrap(coord: vec2<f32>, size: vec2<f32>) -> vec2<f32> {
    var uv = coord / size;
    let mode = i32(wrap);
    if (mode == 0) {
        // Mirror
        let mx = abs((uv.x + 1.0) - floor((uv.x + 1.0) * 0.5) * 2.0 - 1.0);
        let my = abs((uv.y + 1.0) - floor((uv.y + 1.0) * 0.5) * 2.0 - 1.0);
        return vec2<f32>(mx, my);
    } else if (mode == 1) {
        return fract(uv);  // repeat
    }
    return clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));  // clamp
}

struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
};

@fragment
fn main(input : VertexOutput) -> @location(0) vec4<f32> {
    let texSize : vec2<f32> = vec2<f32>(textureDimensions(inputTex));
    let center : vec2<f32> = texSize * 0.5;
    let pixelCoord : vec2<f32> = input.position.xy - center;
    
    var angle : f32 = angled;
    // Handle animation if needed
    
    let rad : f32 = angle * PI / 180.0;
    let c : f32 = cos(rad);
    let s : f32 = sin(rad);
    
    // Rotate
    var srcCoord : vec2<f32>;
    srcCoord.x = c * pixelCoord.x + s * pixelCoord.y;
    srcCoord.y = -s * pixelCoord.x + c * pixelCoord.y;
    
    srcCoord = srcCoord + center;
    
    let wrappedUV : vec2<f32> = applyWrap(srcCoord, texSize);
    var color : vec4<f32> = textureSample(inputTex, input_sampler, wrappedUV);
    
    if (darkest != 0.0) {
        color = vec4<f32>(1.0) - color;
        color.a = 1.0;
    }
    
    return color;
}
