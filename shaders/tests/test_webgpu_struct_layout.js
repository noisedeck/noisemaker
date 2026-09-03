/**
 * WGSL struct bodies must be extracted by counting braces, not by a regex.
 *
 * getBindingStructLayout used `struct\s+X\s*\{([^}]+)\}`. `[^}]+` stops at the
 * FIRST closing brace, so a struct whose body contains any inner brace — a
 * comment mentioning `{rgb}`, for instance — parses truncated: the fields after
 * that point vanish from the layout and the struct size comes out short. The
 * caller in createBindGroup then fell back to the shared program-wide uniform
 * buffer with no diagnostic, and that buffer's own comment says it cannot
 * represent scene structs. Wrong uniforms, silently.
 *
 * Run: node shaders/tests/test_webgpu_struct_layout.js
 */

import assert from 'node:assert'
import { WebGPUBackend, extractWgslStructBody } from '../src/runtime/backends/webgpu.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log(`PASS: ${name}`)
        passed++
    } catch (err) {
        console.error(`FAIL: ${name}`)
        console.error(err.message)
        failed++
    }
}

function backend() {
    return Object.create(WebGPUBackend.prototype)
}

/** A program record shaped the way compileRenderProgram builds one. */
function programWith(...sources) {
    return { _wgslSources: sources, _bindingLayoutCache: new Map() }
}

function entryNames(layout) {
    return layout ? layout.entries.map(e => e.name) : null
}

/** Capture console.warn for the duration of fn. */
function captureWarnings(fn) {
    const warnings = []
    const original = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try { fn() } finally { console.warn = original }
    return warnings
}

const COMMENT_BRACE_STRUCT = `
struct SceneUniforms {
  u_viewMatrix: mat4x4f,   // camera basis, column-major {c0,c1,c2,c3}
  u_lightCount: i32,
}

@group(0) @binding(0) var<uniform> uniforms: SceneUniforms;
`

const NESTED_COMMENT_BRACE_STRUCT = `
struct Light {
  position: vec4f,   // world space {x,y,z}, w unused
  colour: vec4f,
}

struct SceneUniforms {
  u_lights: array<Light, 2>,
  u_lightCount: i32,
}

@group(0) @binding(0) var<uniform> uniforms: SceneUniforms;
`

const UNRESOLVABLE_STRUCT = `
struct OddUniforms {
  u_weird: mat2x2f,
}

@group(0) @binding(0) var<uniform> uniforms: OddUniforms;
`

test('extractWgslStructBody keeps everything up to the matching brace', () => {
    const body = extractWgslStructBody(COMMENT_BRACE_STRUCT, 'SceneUniforms')
    assert.ok(body, 'the struct must be found')
    assert.ok(body.includes('u_lightCount'),
        `body was truncated at an inner brace: ${JSON.stringify(body)}`)
})

test('a comment containing a brace does not truncate the layout', () => {
    const layout = backend().getBindingStructLayout(programWith(COMMENT_BRACE_STRUCT), 'SceneUniforms')
    assert.ok(layout, 'the struct is declared, so a layout must be produced')
    assert.deepStrictEqual(entryNames(layout), ['u_viewMatrix', 'u_lightCount'],
        'every declared field must appear in the layout')
    const lightCount = layout.entries.find(e => e.name === 'u_lightCount')
    assert.strictEqual(lightCount.offset, 64, 'u_lightCount sits after the mat4x4')
    assert.strictEqual(lightCount.kind, 'i32')
    assert.strictEqual(layout.structSize, 80, 'struct size rounds 68 up to the 16-byte alignment')
})

test('a brace comment inside a nested element struct does not truncate it', () => {
    const layout = backend().getBindingStructLayout(programWith(NESTED_COMMENT_BRACE_STRUCT), 'SceneUniforms')
    assert.ok(layout, 'the struct is declared, so a layout must be produced')
    assert.deepStrictEqual(entryNames(layout), [
        'u_lights[0].position', 'u_lights[0].colour',
        'u_lights[1].position', 'u_lights[1].colour',
        'u_lightCount'
    ], 'the array element struct must contribute both of its fields')
    const second = layout.entries.find(e => e.name === 'u_lights[1].position')
    assert.strictEqual(second.offset, 32, 'the element stride is two vec4s, not one')
})

test('the parsed struct is cached so repeat lookups are free', () => {
    const program = programWith(COMMENT_BRACE_STRUCT)
    const b = backend()
    const first = b.getBindingStructLayout(program, 'SceneUniforms')
    const second = b.getBindingStructLayout(program, 'SceneUniforms')
    assert.strictEqual(first, second, 'the layout must come from the cache the second time')
})

test('an undeclared struct still returns null, and says so', () => {
    const program = programWith(COMMENT_BRACE_STRUCT)
    let layout
    const warnings = captureWarnings(() => {
        layout = backend().getBindingStructLayout(program, 'NoSuchUniforms')
    })
    assert.strictEqual(layout, null)
    assert.ok(warnings.some(w => w.includes('NoSuchUniforms')),
        `the fallback must name the struct it could not resolve, got: ${JSON.stringify(warnings)}`)
})

test('a declared but unlayoutable struct warns instead of falling back in silence', () => {
    const program = programWith(UNRESOLVABLE_STRUCT)
    let layout
    const warnings = captureWarnings(() => {
        layout = backend().getBindingStructLayout(program, 'OddUniforms')
    })
    assert.strictEqual(layout, null, 'an unresolvable member type still bails to the shared buffer')
    assert.ok(warnings.some(w => w.includes('OddUniforms')),
        `the fallback must name the struct it could not lay out, got: ${JSON.stringify(warnings)}`)
})

test('the warning fires once per struct, not once per frame', () => {
    const program = programWith(UNRESOLVABLE_STRUCT)
    const b = backend()
    const warnings = captureWarnings(() => {
        for (let i = 0; i < 5; i++) b.getBindingStructLayout(program, 'OddUniforms')
    })
    assert.strictEqual(warnings.length, 1,
        `a render-loop warning storm is not a diagnostic, got ${warnings.length} warnings`)
})

test('parseDeclaredUniformBufferSize sizes a struct past a brace comment', () => {
    const size = backend().parseDeclaredUniformBufferSize(COMMENT_BRACE_STRUCT)
    assert.strictEqual(size, 80,
        'the uniform buffer floor must cover u_lightCount, not stop at the comment')
})

console.log(`\nWebGPU struct layout: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
