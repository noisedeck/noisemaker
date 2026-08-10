/**
 * Integration Test - Full Pipeline Compilation
 * Tests the complete compilation flow from DSL to executable graph
 */

import { compileGraph } from '../src/runtime/compiler.js'
import { registerEffect } from '../src/runtime/registry.js'
import { registerOp } from '../src/lang/ops.js'
import { registerStarterOps } from '../src/lang/validator.js'

let failed = 0

function test(name, fn) {
    try {
        console.log(`Running test: ${name}`)
        fn()
        console.log(`PASS: ${name}`)
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e)
        failed++
    }
}

process.on('exit', () => { if (failed > 0) process.exitCode = 1 })

// Register a simple test effect
const SolidEffect = {
    name: "Solid",
    namespace: "synth",
    func: "solid",
    globals: {
        r: { type: "float", default: 0, min: 0, max: 1 },
        g: { type: "float", default: 0, min: 0, max: 1 },
        b: { type: "float", default: 0, min: 0, max: 1 }
    },
    passes: [
        {
            name: "main",
            type: "render",
            program: "solid",
            inputs: {},
            outputs: { color: "outputTex" }
        }
    ]
}

const WaveEffect = {
    name: "Wave",
    namespace: "synth",
    func: "wave",
    globals: {
        freq: { type: "float", default: 10, min: 0, max: 100 }
    },
    passes: [
        {
            name: "main",
            type: "render",
            program: "wave",
            inputs: {},
            outputs: { color: "outputTex" }
        }
    ]
}

const BlendEffect = {
    name: "Blend",
    namespace: "mixer",
    func: "blend",
    globals: {
        amount: { type: "float", default: 0.5, min: 0, max: 1 }
    },
    passes: [
        {
            name: "main",
            type: "render",
            program: "blend",
            inputs: {
                tex0: "inputColor",
                tex1: "tex"
            },
            outputs: { color: "outputTex" }
        }
    ]
}

registerOp('synth.solid', {
    name: 'solid',
    args: [
        { name: 'r', type: 'float', default: 0 },
        { name: 'g', type: 'float', default: 0 },
        { name: 'b', type: 'float', default: 0 }
    ]
})
registerOp('synth.wave', {
    name: 'wave',
    args: [{ name: 'freq', type: 'float', default: 10 }]
})
registerOp('mixer.blend', {
    name: 'blend',
    args: [{ name: 'tex', type: 'surface' }]
})
registerStarterOps(['synth.solid', 'synth.wave'])

registerEffect('synth.solid', SolidEffect)
registerEffect('synth.wave', WaveEffect)
registerEffect('mixer.blend', BlendEffect)

test('Integration - Simple Generator', () => {
    const source = 'search synth\nsolid(1, 0, 0).write(o0)'
    const graph = compileGraph(source)

    if (!graph) {
        throw new Error('Graph compilation failed')
    }

    if (!graph.passes || graph.passes.length === 0) {
        throw new Error('No passes generated')
    }
})

test('Integration - Chain with Parameters', () => {
    const source = 'search synth\nwave(20).write(o0)'
    const graph = compileGraph(source)

    if (!graph || !graph.passes) {
        throw new Error('Graph compilation failed')
    }

    const pass = graph.passes[0]
    if (!pass) {
        throw new Error('No pass generated')
    }
})

test('Integration - Texture Allocation', () => {
    const source = 'search synth\nsolid(1, 0.5, 0).write(o0)'
    const graph = compileGraph(source)

    if (!graph.textures) {
        throw new Error('No textures in graph')
    }
})

test('Integration - Resource Allocation', () => {
    const source = 'search synth\nsolid(1, 0, 0).write(o0)'
    const graph = compileGraph(source)

    if (!graph.allocations) {
        throw new Error('No resource allocations')
    }
})

test('Integration - Multiple Outputs', () => {
    const sources = [
        'search synth\nsolid(1, 0, 0).write(o0)',
        'search synth\nsolid(0, 1, 0).write(o1)',
        'search synth\nsolid(0, 0, 1).write(o2)'
    ]

    for (const source of sources) {
        const graph = compileGraph(source)
        if (!graph || !graph.passes) {
            throw new Error(`Failed to compile: ${source}`)
        }
    }
})

test('Integration - Graph Metadata', () => {
    const source = 'search synth\nsolid(1, 1, 1).write(o0)'
    const graph = compileGraph(source)

    if (!graph.id) {
        throw new Error('Graph missing ID')
    }

    if (!graph.compiledAt) {
        throw new Error('Graph missing compiledAt timestamp')
    }

    if (graph.source !== source) {
        throw new Error('Graph source mismatch')
    }
})

test('Integration - Hash Consistency', () => {
    const source = 'search synth\nsolid(1, 0, 0).write(o0)'

    const graph1 = compileGraph(source)
    const graph2 = compileGraph(source)

    if (graph1.id !== graph2.id) {
        throw new Error('Graph IDs should be identical for same source')
    }

    const differentSource = 'search synth\nsolid(0, 1, 0).write(o0)'
    const graph3 = compileGraph(differentSource)

    if (graph1.id === graph3.id) {
        throw new Error('Graph IDs should differ for different source')
    }
})

test('Integration - Render Surface from last write', () => {
    // When no render() directive, renderSurface should be the last surface written
    const source = 'search synth\nsolid(1, 0, 0).write(o2)'
    const graph = compileGraph(source)

    if (graph.renderSurface !== 'o2') {
        throw new Error(`Expected renderSurface='o2', got '${graph.renderSurface}'`)
    }
})

test('Integration - Render Surface with multiple writes', () => {
    // With multiple writes, renderSurface should be the last one
    const source = 'search synth\nsolid(1, 0, 0).write(o1)\nsolid(0, 1, 0).write(o5)'
    const graph = compileGraph(source)

    if (graph.renderSurface !== 'o5') {
        throw new Error(`Expected renderSurface='o5', got '${graph.renderSurface}'`)
    }
})

test('Integration - Render Surface default to o0', () => {
    // Default case: write to o0
    const source = 'search synth\nsolid(1, 0, 0).write(o0)'
    const graph = compileGraph(source)

    if (graph.renderSurface !== 'o0') {
        throw new Error(`Expected renderSurface='o0', got '${graph.renderSurface}'`)
    }
})

