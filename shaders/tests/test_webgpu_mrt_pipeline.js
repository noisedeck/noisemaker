/**
 * compileRenderProgram must not eagerly build a single-target pipeline for an
 * MRT fragment shader.
 *
 * scene_mesh_gbuf's fragment stage returns a struct with FOUR @location
 * outputs. The eager pipeline built at compile time always declared exactly
 * one colour target, so interface matching failed and every scene program load
 * emitted an uncaptured WebGPU validation error. The pipeline was then never
 * used — executeMRTRenderPass resolves its own through
 * resolveMRTRenderPipeline — so the work was pure noise.
 *
 * Single-output programs (the 200+ 2D effects) must keep the eager pipeline:
 * it warms the shader before the first frame.
 *
 * Run: node shaders/tests/test_webgpu_mrt_pipeline.js
 */

import assert from 'node:assert'
import { WebGPUBackend } from '../src/runtime/backends/webgpu.js'

let passed = 0
let failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err.message)
        failed++
    }
}

/** Backend with a device that records every createRenderPipeline descriptor. */
function stubBackend() {
    const renderPipelines = []
    const backend = Object.create(WebGPUBackend.prototype)
    backend.programs = new Map()
    backend.device = {
        createShaderModule(desc) {
            return { desc, async getCompilationInfo() { return { messages: [] } } }
        },
        createRenderPipeline(desc) {
            renderPipelines.push(desc)
            return { desc, getBindGroupLayout() { return {} } }
        }
    }
    return { backend, renderPipelines }
}

const MRT_FRAGMENT = `
struct FragmentInput {
  @location(0) v_worldPos: vec3f,
  @location(1) v_worldNormal: vec3f,
  @location(2) v_texCoord: vec2f,
}

struct GBufferOutput {
  @location(0) albedoMetallic: vec4f,
  @location(1) normalRoughness: vec4f,
  @location(2) positionEmission: vec4f,
  @location(3) depth: f32,
}

@fragment
fn fs_main(input: FragmentInput, @builtin(position) fragCoord: vec4f) -> GBufferOutput {
  var output: GBufferOutput;
  output.albedoMetallic = vec4f(1.0);
  output.normalRoughness = vec4f(1.0);
  output.positionEmission = vec4f(1.0);
  output.depth = fragCoord.z;
  return output;
}
`

const MESH_VERTEX = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_worldPos: vec3f,
  @location(1) v_worldNormal: vec3f,
  @location(2) v_texCoord: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(0.0, 0.0, 0.0, 1.0);
  return output;
}
`

const SINGLE_OUTPUT_FRAGMENT = `
@fragment
fn main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`

const COMBINED_SINGLE_OUTPUT = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_texCoord: vec2f,
  @location(1) v_colour: vec4f,
}

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4f(0.0, 0.0, 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return input.v_colour;
}
`

await test('a 4-output fragment shader builds no eager single-target pipeline', async () => {
    const { backend, renderPipelines } = stubBackend()
    await backend.compileProgram('scene_mesh_gbuf', {
        vertexWGSL: MESH_VERTEX,
        fragment: MRT_FRAGMENT,
        perBindingUniforms: true
    })
    assert.strictEqual(renderPipelines.length, 0,
        `an MRT program must defer to resolveMRTRenderPipeline, but ${renderPipelines.length} ` +
        `pipeline(s) were created eagerly with ${JSON.stringify(renderPipelines[0]?.fragment?.targets)}`)
})

await test('the deferred MRT program still registers and carries its modules', async () => {
    const { backend } = stubBackend()
    const info = await backend.compileProgram('scene_mesh_gbuf', {
        vertexWGSL: MESH_VERTEX,
        fragment: MRT_FRAGMENT,
        perBindingUniforms: true
    })
    assert.ok(backend.programs.has('scene_mesh_gbuf'), 'program must still be registered')
    assert.ok(info.vertexModule, 'vertex module must be retained for the MRT resolver')
    assert.ok(info.fragmentModule, 'fragment module must be retained for the MRT resolver')
    assert.strictEqual(info.vertexEntryPoint, 'vs_main')
    assert.strictEqual(info.fragmentEntryPoint, 'fs_main')
    assert.ok(info.pipelineCache instanceof Map, 'the pipeline cache must exist for the resolver')
})

await test('a single-output fragment shader still gets its eager pipeline', async () => {
    const { backend, renderPipelines } = stubBackend()
    const info = await backend.compileProgram('effect_2d', { fragment: SINGLE_OUTPUT_FRAGMENT })
    assert.strictEqual(renderPipelines.length, 1,
        'the 2D effect path relies on the eager pipeline being warm')
    assert.strictEqual(renderPipelines[0].fragment.targets.length, 1)
    assert.ok(info.pipeline, 'programInfo.pipeline must stay populated for single-output programs')
    assert.strictEqual(info.pipelineCache.size, 1, 'the eager pipeline must be seeded into the cache')
})

await test('vertex varying @locations do not count as fragment outputs', async () => {
    const { backend, renderPipelines } = stubBackend()
    await backend.compileProgram('combined', { wgsl: COMBINED_SINGLE_OUTPUT })
    assert.strictEqual(renderPipelines.length, 1,
        'a combined shader with three vertex varyings but ONE fragment output is not MRT')
    assert.strictEqual(renderPipelines[0].fragment.targets.length, 1)
})

await test('the legacy bind group path names the program it cannot serve', async () => {
    const { backend } = stubBackend()
    const info = await backend.compileProgram('scene_mesh_gbuf', {
        vertexWGSL: MESH_VERTEX,
        fragment: MRT_FRAGMENT,
        perBindingUniforms: true
    })
    assert.strictEqual(info.pipeline, null, 'precondition: an MRT program has no eager pipeline')
    // Dereferencing the missing pipeline gives "Cannot read properties of null",
    // which says nothing about which program or why it has no pipeline.
    assert.throws(
        () => backend.createLegacyBindGroup({ id: 'gbuf_pass', program: 'scene_mesh_gbuf' }, info, {}),
        /scene_mesh_gbuf/,
        'the failure must name the program')
    assert.throws(
        () => backend.createLegacyBindGroup({ id: 'gbuf_pass', program: 'scene_mesh_gbuf' }, info, {}),
        /@location/,
        'the failure must say why there is no pipeline to take a layout from')
})

console.log(`\nWebGPU MRT pipeline: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
