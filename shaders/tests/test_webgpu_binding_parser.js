import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'

function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
        fn()
        console.log(`PASS: ${name}`)
    } catch (error) {
        console.error(`FAIL: ${name}`)
        console.error(error)
        process.exit(1)
    }
}

function parseBindings(source) {
    const backend = Object.create(WebGPUBackend.prototype)
    return backend.parseShaderBindings(source)
}

test('WebGPU binding parser classifies cube textures as sampled textures', () => {
    const source = `
@group(0) @binding(0) var reflectionProbe: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn main() -> @location(0) vec4<f32> {
    return textureSampleLevel(reflectionProbe, samp, vec3f(0.0, 1.0, 0.0), 0.0);
}
`
    const bindings = parseBindings(source)
    const probe = bindings.find((binding) => binding.name === 'reflectionProbe')
    if (!probe || probe.type !== 'texture') {
        throw new Error(`cube binding was not classified as a texture: ${JSON.stringify(probe)}`)
    }
})

test('WebGPU binding parser ignores dead bindings mentioned only in block comments', () => {
    const source = `
@group(0) @binding(0) var liveTex: texture_2d<f32>;
@group(0) @binding(1) var deadTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

/*
 * deadTex used to be sampled here, but this pass no longer needs it.
 */
@fragment
fn main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = fragCoord.xy / vec2<f32>(64.0, 64.0);
    return textureSample(liveTex, samp, uv);
}
`

    const names = parseBindings(source).map((binding) => binding.name)

    if (names.includes('deadTex')) {
        throw new Error(`dead block-comment-only binding was retained: ${names.join(', ')}`)
    }
    if (!names.includes('liveTex') || !names.includes('samp')) {
        throw new Error(`live bindings were not preserved: ${names.join(', ')}`)
    }
})

test('WebGPU binding parser handles nested block comments', () => {
    const source = `
@group(0) @binding(0) var liveTex: texture_2d<f32>;
@group(0) @binding(1) var deadTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

/*
 * Outer comment start.
 * /*
 *  Nested comment mentions deadTex.
 * */
 * Outer comment also mentions deadTex.
 */
@fragment
fn main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = fragCoord.xy / vec2<f32>(64.0, 64.0);
    return textureSample(liveTex, samp, uv);
}
`

    const names = parseBindings(source).map((binding) => binding.name)

    if (names.includes('deadTex')) {
        throw new Error(`nested block-comment-only binding was retained: ${names.join(', ')}`)
    }
    if (!names.includes('liveTex') || !names.includes('samp')) {
        throw new Error(`live bindings were not preserved: ${names.join(', ')}`)
    }
})

test('WebGPU binding parser ignores block delimiters inside line comments', () => {
    const source = `
@group(0) @binding(0) var liveTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

// /* This is only a line comment and must not start a block comment.
@fragment
fn main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = fragCoord.xy / vec2<f32>(64.0, 64.0);
    return textureSample(liveTex, samp, uv);
}
// */ This is also only a line comment.
`

    const names = parseBindings(source).map((binding) => binding.name)

    if (!names.includes('liveTex') || !names.includes('samp')) {
        throw new Error(`line-comment block delimiters stripped live bindings: ${names.join(', ')}`)
    }
})

test('WebGPU binding parser ignores storage bindings declared only in comments', () => {
    const source = `
@group(0) @binding(0) var<uniform> volumeSize: i32;
/*
@group(0) @binding(1) var deadStorageTex: texture_storage_2d<rgba16float, write>;
*/
@group(0) @binding(2) var stateTex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u32(volumeSize) || id.y >= u32(volumeSize)) {
        return;
    }
    textureStore(stateTex, vec2<i32>(id.xy), vec4<f32>(1.0));
}
`

    const names = parseBindings(source).map((binding) => binding.name)

    if (names.includes('deadStorageTex')) {
        throw new Error(`commented-out storage texture binding was retained: ${names.join(', ')}`)
    }
    if (!names.includes('volumeSize') || !names.includes('stateTex')) {
        throw new Error(`live compute bindings were not preserved: ${names.join(', ')}`)
    }
})
