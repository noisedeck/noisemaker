/**
 * Basic Pipeline Tests
 * Tests the pipeline executor with mock backends
 */

import { Pipeline } from '../src/runtime/pipeline.js'
import { Backend } from '../src/runtime/backend.js'
import { FrameExportQueue } from '../src/runtime/frame-export.js'

const tests = []

function test(name, fn) {
    tests.push({ name, fn })
}

async function runTests() {
    console.log('\n=== Running Pipeline Tests ===\n')
    for (const { name, fn } of tests) {
        try {
            console.log(`Running test: ${name}`)
            await fn()
            console.log(`PASS: ${name}`)
        } catch (e) {
            console.error(`FAIL: ${name}`)
            console.error(e)
            process.exit(1)
        }
    }
}

// Mock backend for testing
class MockBackend extends Backend {
    constructor() {
        super(null)
        this.initCalled = false
        this.passes = []
        this.frameCount = 0
    }

    async init() {
        this.initCalled = true
    }

    createTexture(id, spec) {
        this.textures.set(id, {
            id,
            handle: `mock_texture_${id}`,
            width: spec.width,
            height: spec.height,
            format: spec.format
        })
        return this.textures.get(id)
    }

    destroyTexture(id) {
        this.textures.delete(id)
    }

    async compileProgram(id, spec) {
        this.programs.set(id, {
            handle: `mock_program_${id}`,
            type: spec.type || 'render'
        })
        return this.programs.get(id)
    }

    executePass(pass, state) {
        // Record the resolved read/write physical texture IDs for every
        // global_ (ping-pong) surface this pass declares in inputs/outputs,
        // so tests can pin the exact per-iteration binding sequence instead
        // of only observing which passes ran. state.surfaces/writeSurfaces
        // are reused/mutated objects (see Pipeline.getFrameState), so only
        // primitive string IDs are copied out here -- never a reference.
        const surfaceBindings = {}
        for (const ioMap of [pass.inputs, pass.outputs]) {
            if (!ioMap) continue
            for (const texId of Object.values(ioMap)) {
                if (typeof texId !== 'string' || !texId.startsWith('global_')) continue
                const name = texId.slice('global_'.length)
                if (surfaceBindings[name]) continue
                const readTex = state.surfaces[name]
                surfaceBindings[name] = {
                    read: readTex ? readTex.id : undefined,
                    write: state.writeSurfaces[name]
                }
            }
        }

        this.passes.push({
            passId: pass.id,
            program: pass.program,
            frameIndex: state.frameIndex,
            uniforms: pass.uniforms ? { ...pass.uniforms } : undefined,
            operational: {
                entryPoint: pass.entryPoint,
                clear: pass.clear,
                blend: pass.blend,
                drawMode: pass.drawMode,
                drawBuffers: pass.drawBuffers,
                count: pass.count,
                countUniform: pass.countUniform,
                repeat: pass.repeat,
                conditions: pass.conditions,
                viewport: pass.viewport,
                samplerTypes: pass.samplerTypes,
                workgroups: pass.workgroups,
                size: pass.size,
                storageBuffers: pass.storageBuffers,
                storageTextures: pass.storageTextures
            },
            surfaceBindings
        })
    }

    beginFrame() {
        this.frameCount++
    }

    endFrame() {
        // no-op
    }

    resize() {
        // no-op
    }

    async readPixels(textureId) {
        const texture = this.textures.get(textureId)
        return {
            width: texture?.width ?? 1,
            height: texture?.height ?? 1,
            data: new Uint8Array(4)
        }
    }

    getName() {
        return 'Mock'
    }

    static isAvailable() {
        return true
    }
}

test('Pipeline - Initialization', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [],
        textures: new Map()
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    if (!backend.initCalled) {
        throw new Error('Backend init not called')
    }

    if (pipeline.width !== 800 || pipeline.height !== 600) {
        throw new Error('Pipeline dimensions not set correctly')
    }

    // Check that surfaces were created (o0-o7 + geo0-geo7 + vol0-vol7 + mesh0-mesh7 = 32)
    if (pipeline.surfaces.size !== 32) {
        throw new Error(`Expected 32 surfaces, got ${pipeline.surfaces.size}`)
    }

    const o0 = pipeline.surfaces.get('o0')
    if (!o0 || !o0.read || !o0.write) {
        throw new Error('Surface o0 not created correctly')
    }
})

test('Pipeline - Dispose destroys all pipeline-owned textures', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [],
        textures: new Map([
            ['tex_0', { width: 800, height: 600, format: 'rgba8' }]
        ])
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    // Mesh surfaces are positions/normals/uvs triplets (not read/write), graph
    // textures come from the compiled graph, and runtime-managed textures such
    // as MIDI grids are registered directly with the backend. Dispose must
    // destroy every one of these, each exactly once.
    const meshTriplet = ['global_mesh0_positions', 'global_mesh0_normals', 'global_mesh0_uvs']
    for (const id of meshTriplet) {
        if (!backend.textures.has(id)) {
            throw new Error(`Expected mesh texture ${id} to be created before dispose`)
        }
    }
    if (!backend.textures.has('tex_0')) {
        throw new Error('Expected graph texture to be created before dispose')
    }

    backend.createTexture('midiNoteGrid', { width: 128, height: 16, format: 'rgba32f' })

    // Record every destroyTexture call to verify coverage and that no texture
    // is destroyed more than once.
    const destroyed = []
    const realDestroy = backend.destroyTexture.bind(backend)
    backend.destroyTexture = (id) => {
        destroyed.push(id)
        realDestroy(id)
    }

    pipeline.dispose()

    if (backend.textures.size !== 0) {
        throw new Error(`Expected dispose to destroy all textures, found: ${Array.from(backend.textures.keys()).join(', ')}`)
    }

    for (const id of [...meshTriplet, 'tex_0', 'midiNoteGrid']) {
        const count = destroyed.filter((x) => x === id).length
        if (count !== 1) {
            throw new Error(`Expected ${id} to be destroyed exactly once, got ${count}`)
        }
    }
})

test('Pipeline - Frame Execution', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [
            {
                id: 'pass_0',
                program: 'test_program',
                inputs: {},
                outputs: { color: 'tex_0' }
            }
        ],
        textures: new Map([
            ['tex_0', { width: 800, height: 600, format: 'rgba8' }]
        ]),
        programs: {
            'test_program': { fragment: 'void main() {}' }
        }
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    // Render a frame
    pipeline.render(0.016)

    if (backend.frameCount !== 1) {
        throw new Error('Frame not executed')
    }

    if (backend.passes.length !== 1) {
        throw new Error('Pass not executed')
    }

    if (backend.passes[0].passId !== 'pass_0') {
        throw new Error('Wrong pass executed')
    }
})

test('Pipeline - Global Uniforms', async () => {
    const backend = new MockBackend()
    const graph = { passes: [], textures: new Map() }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    pipeline.render(1.5)

    const uniforms = pipeline.globalUniforms

    if (uniforms.time !== 1.5) {
        throw new Error(`Expected time=1.5, got ${uniforms.time}`)
    }

    if (uniforms.frame !== 0) {
        throw new Error(`Expected frame=0, got ${uniforms.frame}`)
    }

    if (!uniforms.resolution || uniforms.resolution[0] !== 800) {
        throw new Error('Resolution uniform not set correctly')
    }
})

test('Pipeline - Dimension Resolution', async () => {
    const backend = new MockBackend()
    const graph = { passes: [], textures: new Map() }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(1000, 800)

    // Test different dimension specs
    const testCases = [
        { spec: 100, expected: 100 },
        { spec: 'screen', expected: 1000 },
        { spec: '50%', expected: 500 },
        { spec: '25%', expected: 250 },
        { spec: { scale: 0.5 }, expected: 500 },
        { spec: { scale: 2.0 }, expected: 2000 },
        { spec: { scale: 0.1, clamp: { min: 200, max: 400 } }, expected: 200 }
    ]

    for (const tc of testCases) {
        const result = pipeline.resolveDimension(tc.spec, 1000)
        if (result !== tc.expected) {
            throw new Error(`Dimension ${JSON.stringify(tc.spec)}: expected ${tc.expected}, got ${result}`)
        }
    }
})

test('Pipeline - Surface Double Buffering', async () => {
    const backend = new MockBackend()
    const graph = { passes: [], textures: new Map(), renderSurface: 'o0' }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    const o0 = pipeline.surfaces.get('o0')
    const initialRead = o0.read
    const initialWrite = o0.write

    // Render a frame - should swap buffers
    pipeline.render(0)

    const afterRead = o0.read
    const afterWrite = o0.write

    if (afterRead !== initialWrite) {
        throw new Error('Read buffer not swapped correctly')
    }

    if (afterWrite !== initialRead) {
        throw new Error('Write buffer not swapped correctly')
    }
})

test('Pipeline - Repeat Pass Binding Sequence (seed -> repeat -> final)', async () => {
    // Regression test for repeat-pass ping-pong desynchronization after a
    // non-repeat seed pass. Mirrors the shape used by effects like
    // filter/median and synth/navierStokes: a non-repeat seed pass writes a
    // global_ surface, a repeat: pass reads/writes it N times, and a final
    // pass consumes the last iteration's write.
    //
    // Pre-fix, swapIterationBuffers() (renamed adoptIterationBindings()) recomputed
    // the read/write swap from the stale cross-frame `this.surfaces` record instead
    // of adopting the frame-local maps that updateFrameSurfaceBindings() had just
    // advanced -- and then clobbered those frame-local maps with the recomputed
    // (wrong) values. Because the seed pass is non-repeat, it never called
    // swapIterationBuffers(), so `this.surfaces` was still at its pre-frame value
    // when the repeat pass's first iteration finished. Tracing it through by hand
    // with physical buffers A (initial read) / B (initial write): the seed pass
    // writes B, so iteration 0 correctly read B. But the post-iteration clobber
    // then swapped the still-pre-frame `this.surfaces` record ({read: A, write: B})
    // and wrote that BACK into the frame maps as {read: B, write: A} -- undoing
    // updateFrameSurfaceBindings()'s correct advance to {read: A, write: B}. So
    // iteration 1 re-read B instead of A (iteration 0's write), silently redoing
    // iteration 0's work instead of advancing. A requested repeat: 3 therefore only
    // produced 2 distinct simulation steps (repeat of N behaved as N-1; repeat of 2
    // behaved as 1), and the final pass read B instead of A. Post-fix, the sequence
    // strictly alternates and this test's assertions hold.
    const backend = new MockBackend()
    const graph = {
        passes: [
            {
                id: 'seed',
                program: 'seed_program',
                inputs: {},
                outputs: { fragColor: 'global_state' }
            },
            {
                id: 'repeatPass',
                program: 'repeat_program',
                repeat: 3,
                inputs: { bufTex: 'global_state' },
                outputs: { fragColor: 'global_state' }
            },
            {
                id: 'final',
                program: 'final_program',
                inputs: { bufTex: 'global_state' },
                outputs: { color: 'tex_0' }
            }
        ],
        textures: new Map([
            ['tex_0', { width: 800, height: 600, format: 'rgba8' }]
        ]),
        programs: {
            'seed_program': { fragment: 'void main() {}' },
            'repeat_program': { fragment: 'void main() {}' },
            'final_program': { fragment: 'void main() {}' }
        }
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    // The two physical buffer IDs never change -- only which one is bound as
    // "read" vs "write" changes. Capture them before render() so assertions
    // below read as buffer identities rather than magic strings.
    const stateSurface = pipeline.surfaces.get('state')
    const A = stateSurface.read
    const B = stateSurface.write

    pipeline.render(0)

    // seed (1) + repeatPass (3 iterations) + final (1) = 5 executed passes
    if (backend.passes.length !== 5) {
        throw new Error(`Expected 5 executed pass iterations, got ${backend.passes.length}`)
    }

    const [seedEntry, iter0, iter1, iter2, finalEntry] = backend.passes

    if (seedEntry.surfaceBindings.state.write !== B) {
        throw new Error(`Expected seed pass to write ${B}, wrote ${seedEntry.surfaceBindings.state.write}`)
    }

    if (iter0.surfaceBindings.state.read !== B) {
        throw new Error(`Expected repeat iteration 0 to read the seed pass's write buffer (${B}), read ${iter0.surfaceBindings.state.read}`)
    }
    if (iter0.surfaceBindings.state.write !== A) {
        throw new Error(`Expected repeat iteration 0 to write ${A}, wrote ${iter0.surfaceBindings.state.write}`)
    }

    // The load-bearing assertion: this fails on the pre-fix code, where
    // iteration 1 re-reads the seed buffer (B) instead of iteration 0's
    // write (A).
    if (iter1.surfaceBindings.state.read !== A) {
        throw new Error(`Expected repeat iteration 1 to read iteration 0's write (${A}), read ${iter1.surfaceBindings.state.read} instead (pre-fix bug: re-reads the seed buffer)`)
    }
    if (iter1.surfaceBindings.state.write !== B) {
        throw new Error(`Expected repeat iteration 1 to write ${B}, wrote ${iter1.surfaceBindings.state.write}`)
    }

    if (iter2.surfaceBindings.state.read !== B) {
        throw new Error(`Expected repeat iteration 2 to read iteration 1's write (${B}), read ${iter2.surfaceBindings.state.read}`)
    }
    if (iter2.surfaceBindings.state.write !== A) {
        throw new Error(`Expected repeat iteration 2 to write ${A}, wrote ${iter2.surfaceBindings.state.write}`)
    }

    if (finalEntry.surfaceBindings.state.read !== A) {
        throw new Error(`Expected final pass to read iteration 2's write (${A}), read ${finalEntry.surfaceBindings.state.read}`)
    }
})

test('Pipeline - Repeat Pass Binding Sequence (self-seeding, persists across frames)', async () => {
    // Covers the other shipped repeat topology: a single repeat: pass that is
    // the surface's only writer (the shape used by synth/reactionDiffusion,
    // where "simulate" reads and writes global_rd_state every iteration with
    // no separate seed pass). Unlike the seed-then-repeat topology above,
    // nothing desyncs `this.surfaces` from the frame-local maps before this
    // pass's first iteration runs each frame, so -- traced by hand the same
    // way -- this sequence comes out correct both pre- and post-fix. It's
    // pinned here anyway to guard the invariant for this topology too,
    // including cross-frame persistence via swapBuffers()'s state-surface
    // path, which the single-frame test above never exercises.
    const backend = new MockBackend()
    const graph = {
        passes: [
            {
                id: 'simulate',
                program: 'rdFb',
                repeat: 2,
                inputs: { bufTex: 'global_rd_state' },
                outputs: { fragColor: 'global_rd_state' }
            }
        ],
        textures: new Map(),
        programs: {
            'rdFb': { fragment: 'void main() {}' }
        }
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    const rdState = pipeline.surfaces.get('rd_state')
    const A = rdState.read
    const B = rdState.write

    // Frame 1
    pipeline.render(0)

    if (backend.passes.length !== 2) {
        throw new Error(`Expected 2 executed pass iterations in frame 1, got ${backend.passes.length}`)
    }

    const [f1iter0, f1iter1] = backend.passes

    if (f1iter0.surfaceBindings.rd_state.read !== A || f1iter0.surfaceBindings.rd_state.write !== B) {
        throw new Error(`Expected frame 1 iteration 0 to read ${A}/write ${B}, got read ${f1iter0.surfaceBindings.rd_state.read}/write ${f1iter0.surfaceBindings.rd_state.write}`)
    }

    // Iteration 1 must read iteration 0's write, not re-read A.
    if (f1iter1.surfaceBindings.rd_state.read !== f1iter0.surfaceBindings.rd_state.write) {
        throw new Error(`Expected frame 1 iteration 1 to read iteration 0's write (${f1iter0.surfaceBindings.rd_state.write}), read ${f1iter1.surfaceBindings.rd_state.read} instead`)
    }

    const frame1LastWrite = f1iter1.surfaceBindings.rd_state.write

    // Frame 2
    backend.passes = []
    pipeline.render(0.016)

    if (backend.passes.length !== 2) {
        throw new Error(`Expected 2 executed pass iterations in frame 2, got ${backend.passes.length}`)
    }

    const [f2iter0, f2iter1] = backend.passes

    // The end-of-frame persisted record must carry frame 1's last write
    // forward as frame 2's first read.
    if (f2iter0.surfaceBindings.rd_state.read !== frame1LastWrite) {
        throw new Error(`Expected frame 2 iteration 0 to read frame 1's last write (${frame1LastWrite}), read ${f2iter0.surfaceBindings.rd_state.read} instead`)
    }

    if (f2iter1.surfaceBindings.rd_state.read !== f2iter0.surfaceBindings.rd_state.write) {
        throw new Error(`Expected frame 2 iteration 1 to read iteration 0's write (${f2iter0.surfaceBindings.rd_state.write}), read ${f2iter1.surfaceBindings.rd_state.read} instead`)
    }
})

test('Pipeline - Pass Condition Skip', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [
            {
                id: 'pass_0',
                program: 'always_run',
                inputs: {},
                outputs: { color: 'tex_0' }
            },
            {
                id: 'pass_1',
                program: 'conditional',
                inputs: {},
                outputs: { color: 'tex_1' },
                conditions: {
                    skipIf: [{ uniform: 'frame', equals: 0 }]
                }
            }
        ],
        textures: new Map(),
        programs: {
            'always_run': { fragment: 'void main() {}' },
            'conditional': { fragment: 'void main() {}' }
        }
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(800, 600)

    // First frame - pass_1 should be skipped
    pipeline.render(0)

    if (backend.passes.length !== 1) {
        throw new Error(`Expected 1 pass executed, got ${backend.passes.length}`)
    }

    if (backend.passes[0].passId !== 'pass_0') {
        throw new Error('Wrong pass executed in first frame')
    }

    // Second frame - both passes should run
    backend.passes = []
    pipeline.render(0.016)

    if (backend.passes.length !== 2) {
        throw new Error(`Expected 2 passes executed in second frame, got ${backend.passes.length}`)
    }
})

test('Pipeline - Render Surface Selection', async () => {
    // Test that graph.renderSurface determines which surface is presented

    // Track which surface was presented
    let presentedTextureId = null

    class RenderSurfaceBackend extends MockBackend {
        present(textureId) {
            presentedTextureId = textureId
        }
    }

    const backend = new RenderSurfaceBackend()

    // Create a graph that specifies o2 as the render surface
    const graph = {
        passes: [],
        textures: new Map(),
        renderSurface: 'o2'  // Explicitly render o2 instead of default o0
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(400, 300)

    // Verify o2 surface exists
    const o2 = pipeline.surfaces.get('o2')
    if (!o2) {
        throw new Error('o2 surface should exist')
    }

    // Capture the expected texture ID before render (render swaps buffers after presenting)
    const expectedTextureId = o2.read

    // Render a frame
    pipeline.render(0)

    // Verify o2 was presented (from the read texture before the swap)
    if (presentedTextureId !== expectedTextureId) {
        throw new Error(`Expected o2's read texture (${expectedTextureId}) to be presented, got ${presentedTextureId}`)
    }
})

test('Pipeline - No Render Surface Skips Present', async () => {
    // Without explicit renderSurface, present() should not be called
    // but swapBuffers and frameIndex should still advance

    let presentCalled = false

    class NoPresentBackend extends MockBackend {
        present() {
            presentCalled = true
        }
    }

    const backend = new NoPresentBackend()
    const graph = { passes: [], textures: new Map() }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(400, 300)

    const o0 = pipeline.surfaces.get('o0')
    const initialRead = o0.read
    const initialWrite = o0.write

    pipeline.render(0)

    if (presentCalled) {
        throw new Error('present() should not be called without renderSurface')
    }

    // Buffers should still swap
    if (o0.read !== initialWrite || o0.write !== initialRead) {
        throw new Error('Buffers should swap even without renderSurface')
    }
})

test('Pipeline - Sinks configure across the lifecycle and submit the pre-swap render texture', async () => {
    class PresentingBackend extends MockBackend {
        constructor() {
            super()
            this.presented = []
        }

        present(textureId) {
            this.presented.push(textureId)
        }
    }

    const backend = new PresentingBackend()
    const pipeline = new Pipeline({ passes: [], textures: new Map(), renderSurface: 'o2' }, backend)
    const configurations = []
    const descriptorKeySets = []
    const frames = []
    let earlyCloses = 0
    const earlySink = {
        configure(descriptor) {
            configurations.push({ sink: 'early', ...descriptor })
            descriptorKeySets.push(Object.keys(descriptor).sort())
        },
        submit(textureId, timestamp) { frames.push(['early', textureId, timestamp]); return true },
        close() { earlyCloses++ }
    }

    const removeEarly = pipeline.addSink(earlySink)
    if (configurations.length !== 0) {
        throw new Error('A sink registered before init must wait for the first resize')
    }

    await pipeline.init(400, 300)

    const lateSink = {
        configure(descriptor) {
            configurations.push({ sink: 'late', ...descriptor })
            descriptorKeySets.push(Object.keys(descriptor).sort())
        },
        submit(textureId, timestamp) { frames.push(['late', textureId, timestamp]); return true },
        close() {}
    }
    pipeline.addSink({ configure() {}, submit() { return false }, close() {} })
    pipeline.addSink({ configure() {}, submit() { throw new Error('sink failure') }, close() {} })
    pipeline.addSink(lateSink)

    if (configurations.length !== 2 || configurations[0].width !== 400 || configurations[1].height !== 300) {
        throw new Error('Sinks must configure on first resize and immediate post-init registration')
    }

    pipeline.resize(640, 480)
    if (configurations.length !== 4) {
        throw new Error('Resize must configure every active sink without per-frame configuration')
    }
    for (const descriptor of configurations.slice(2)) {
        if (descriptor.width !== 640 || descriptor.height !== 480 || descriptor.format !== 'rgba8unorm' || descriptor.colorSpace !== 'srgb' || descriptor.alphaMode !== 'premultiplied' || descriptor.fps !== 60) {
            throw new Error(`Unexpected sink descriptor: ${JSON.stringify(descriptor)}`)
        }
    }
    const expectedDescriptorKeys = JSON.stringify(['alphaMode', 'colorSpace', 'format', 'fps', 'height', 'width'])
    for (const keys of descriptorKeySets) {
        if (JSON.stringify(keys) !== expectedDescriptorKeys) {
            throw new Error(`Unexpected sink descriptor own-key shape: ${JSON.stringify(keys)}`)
        }
    }

    const o2 = pipeline.surfaces.get('o2')
    const preSwapTextureId = o2.read
    const timestamp = 'literal presentation timestamp'
    pipeline.render(0, timestamp)

    if (backend.presented.length !== 1 || backend.presented[0] !== preSwapTextureId) {
        throw new Error('Canvas sink must present the exact pre-swap render texture once')
    }
    if (frames.length !== 2 || frames[0][1] !== preSwapTextureId || frames[1][1] !== preSwapTextureId || frames[0][2] !== timestamp || frames[1][2] !== timestamp) {
        throw new Error('Active sinks after busy or failing sinks must receive the exact texture and timestamp')
    }
    if (o2.read === preSwapTextureId) {
        throw new Error('Render texture must be submitted before buffer swapping')
    }
    if (configurations.length !== 4) {
        throw new Error('Rendering must not reconfigure sinks')
    }

    removeEarly()
    removeEarly()
    if (earlyCloses !== 1) {
        throw new Error(`Expected idempotent sink removal to close once, got ${earlyCloses}`)
    }
})

test('Pipeline - Missing presentation timestamp uses the monotonic clock', async () => {
    const backend = new MockBackend()
    const pipeline = new Pipeline({ passes: [], textures: new Map(), renderSurface: 'o0' }, backend)
    const frames = []
    pipeline.addSink({
        configure() {},
        submit(textureId, timestamp) { frames.push([textureId, timestamp]); return true },
        close() {}
    })
    await pipeline.init(320, 240)

    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: { now() { return 12345.5 } }
    })
    const preSwapTextureId = pipeline.surfaces.get('o0').read
    try {
        pipeline.render(0)
    } finally {
        if (performanceDescriptor) {
            Object.defineProperty(globalThis, 'performance', performanceDescriptor)
        } else {
            delete globalThis.performance
        }
    }

    if (frames.length !== 1 || frames[0][0] !== preSwapTextureId || frames[0][1] !== 12345.5) {
        throw new Error(`Expected monotonic timestamp fallback, got ${JSON.stringify(frames)}`)
    }
})

test('Pipeline - Resize completes after a sink configure failure', async () => {
    class PresentingBackend extends MockBackend {
        constructor() {
            super()
            this.presented = []
        }

        present(textureId) {
            this.presented.push(textureId)
        }
    }

    const backend = new PresentingBackend()
    const pipeline = new Pipeline({ passes: [], textures: new Map(), renderSurface: 'o0' }, backend)
    await pipeline.init(320, 240)

    let shouldThrow = false
    const failed = {
        configure() {
            if (shouldThrow) throw new Error('configure failed')
        },
        submit() { return true },
        close() {}
    }
    const observedDescriptors = []
    const observed = {
        configure(descriptor) { observedDescriptors.push({ ...descriptor }) },
        submit() { return true },
        close() {}
    }
    pipeline.addSink(failed)
    pipeline.addSink(observed)
    observedDescriptors.length = 0
    shouldThrow = true

    let resizeError
    try {
        pipeline.resize(640, 480)
    } catch (error) {
        resizeError = error
    }

    if (resizeError) {
        throw new Error(`Resize must contain sink configure failures: ${resizeError.message}`)
    }
    if (observedDescriptors.length !== 1 || observedDescriptors[0].width !== 640 || observedDescriptors[0].height !== 480) {
        throw new Error(`Later sink did not receive resized dimensions: ${JSON.stringify(observedDescriptors)}`)
    }
    const resizedTexture = backend.textures.get('global_o0_read')
    if (!resizedTexture || resizedTexture.width !== 640 || resizedTexture.height !== 480) {
        throw new Error(`Resize did not complete the surface lifecycle: ${JSON.stringify(resizedTexture)}`)
    }

    pipeline.render(0, 99)
    if (backend.presented.length !== 1 || backend.presented[0] !== pipeline.surfaces.get('o0').write) {
        throw new Error('Default canvas sink must still present after an isolated configure failure')
    }
})

test('Pipeline - Sinks remain optional without a callable backend present method', async () => {
    const backend = new MockBackend()
    backend.present = true
    const pipeline = new Pipeline({ passes: [], textures: new Map(), renderSurface: 'o0' }, backend)
    const frames = []
    const sink = {
        configure() {},
        submit(textureId, timestamp) { frames.push([textureId, timestamp]); return true },
        close() {}
    }

    await pipeline.init(320, 240)
    pipeline.addSink(sink)
    const preSwapTextureId = pipeline.surfaces.get('o0').read
    pipeline.render(0, 789)

    if (frames.length !== 1 || frames[0][0] !== preSwapTextureId || frames[0][1] !== 789) {
        throw new Error('A backend without callable present must render through registered sinks safely')
    }
})

test('Pipeline - No render surface skips all sinks while advancing the frame', async () => {
    const backend = new MockBackend()
    const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
    let submissions = 0
    pipeline.addSink({
        configure() {},
        submit() { submissions++; return true },
        close() {}
    })
    await pipeline.init(320, 240)

    const o0 = pipeline.surfaces.get('o0')
    const initialRead = o0.read
    const initialWrite = o0.write
    pipeline.render(0, 123)

    if (submissions !== 0 || pipeline.frameIndex !== 1) {
        throw new Error('No render surface must not submit while the frame advances')
    }
    if (o0.read !== initialWrite || o0.write !== initialRead) {
        throw new Error('No render surface must continue swapping buffers')
    }
})

test('Pipeline - Dispose closes sinks before destroying the backend and is idempotent', async () => {
    const backend = new MockBackend()
    const events = []
    backend.destroy = () => { events.push('backend destroy') }
    const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
    pipeline.addSink({
        configure() {},
        submit() { return true },
        close() { events.push('sink close') }
    })
    await pipeline.init(320, 240)

    pipeline.dispose()
    pipeline.dispose()

    if (events.length !== 2 || events[0] !== 'sink close' || events[1] !== 'backend destroy') {
        throw new Error(`Expected one sink close before one backend destroy, got ${events.join(', ')}`)
    }
})

test('Pipeline - Dispose forwards loseContext while retaining backend texture ownership', async () => {
    const backend = new MockBackend()
    const destroyOptions = []
    backend.destroy = (options) => { destroyOptions.push(options) }
    const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
    await pipeline.init(32, 24)

    pipeline.dispose({ loseContext: true })

    if (backend.textures.size !== 0) {
        throw new Error('Pipeline must destroy its registered textures before backend teardown')
    }
    const expected = JSON.stringify([{ skipTextures: true, loseContext: true }])
    if (JSON.stringify(destroyOptions) !== expected) {
        throw new Error(`Expected loseContext forwarding with skipTextures, got ${JSON.stringify(destroyOptions)}`)
    }
})

test('Pipeline - backendLost disposal closes sinks and cancels work without backend resource calls', () => {
    const backend = new MockBackend()
    const resourceCalls = []
    backend.textures.set('lost-texture', {})
    backend.destroyTexture = (id) => { resourceCalls.push(['destroyTexture', id]) }
    backend.destroy = (options) => { resourceCalls.push(['destroy', options]) }
    const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
    const events = []
    pipeline.addSink({
        configure() {},
        submit() { return true },
        close(options) { events.push(['sink close', options]) }
    })
    pipeline._asyncRenders.set('active', () => { events.push('async cancel') })
    pipeline._asyncDebounceTimers = new Map([
        ['pending', setTimeout(() => { throw new Error('disposed timer fired') }, 60_000)]
    ])

    pipeline.dispose({ backendLost: true })
    pipeline.dispose({ backendLost: true })

    if (JSON.stringify(events) !== JSON.stringify([
        'async cancel',
        ['sink close', { backendLost: true }]
    ])) {
        throw new Error(`Expected one cancellation then one sink close, got ${JSON.stringify(events)}`)
    }
    if (resourceCalls.length !== 0) {
        throw new Error(`backendLost disposal must not touch backend resources: ${JSON.stringify(resourceCalls)}`)
    }
    if (pipeline.surfaces.size !== 0 || pipeline.graph !== null ||
        pipeline.frameReadTextures !== null || pipeline.frameWriteTextures !== null ||
        pipeline.backend !== null) {
        throw new Error('backendLost disposal must still clear pipeline-owned references')
    }
})

test('Pipeline - backendLost reaches a real queue-owning sink without adapter destruction while normal teardown still destroys slots', () => {
    function fixture() {
        const adapter = {
            slots: [],
            createSlot(index) {
                const slot = { index }
                this.slots.push(slot)
                return slot
            },
            begin() {},
            poll() { return false },
            read() { throw new Error('not ready') },
            destroySlot(slot) { slot.destroyed = (slot.destroyed || 0) + 1 }
        }
        const queue = new FrameExportQueue(adapter, { slots: 2 })
        queue.configure({ width: 4, height: 4 })
        queue.enqueue('pending', 1, () => { throw new Error('closed queue completed') })
        const backend = new MockBackend()
        const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
        pipeline.addSink({
            configure() {},
            submit() { return true },
            close(options) { queue.close(options) }
        })
        return { adapter, queue, pipeline }
    }

    const lost = fixture()
    lost.pipeline.dispose({ backendLost: true })
    if (JSON.stringify(lost.adapter.slots.map(slot => slot.destroyed || 0)) !== '[0,0]') {
        throw new Error('backendLost queue teardown invoked adapter destruction')
    }
    if (lost.queue.adapter !== null) {
        throw new Error('backendLost queue teardown retained its adapter')
    }

    const normal = fixture()
    normal.pipeline.dispose()
    if (JSON.stringify(normal.adapter.slots.map(slot => slot.destroyed || 0)) !== '[1,1]') {
        throw new Error('normal queue teardown must destroy every adapter slot once')
    }
    if (normal.queue.adapter !== null) {
        throw new Error('normal queue teardown retained its adapter')
    }
})

test('Pipeline - Dispose preserves the first sink error while completing backend cleanup', () => {
    const backend = new MockBackend()
    const events = []
    backend.textures.set('owned', {})
    backend.destroyTexture = (id) => {
        events.push(`destroy texture ${id}`)
        backend.textures.delete(id)
    }
    backend.destroy = (options) => { events.push(`destroy backend ${JSON.stringify(options)}`) }
    const pipeline = new Pipeline({ passes: [], textures: new Map() }, backend)
    const firstError = new Error('first sink close failed')
    pipeline.addSink({
        configure() {},
        submit() { return true },
        close() {
            events.push('first sink close')
            throw firstError
        }
    })
    pipeline.addSink({
        configure() {},
        submit() { return true },
        close() { events.push('second sink close') }
    })

    let thrown
    try {
        pipeline.dispose({ loseContext: true })
    } catch (error) {
        thrown = error
    }

    if (thrown !== firstError) {
        throw new Error(`Expected first sink error identity, got ${thrown?.message}`)
    }
    const expected = [
        'first sink close',
        'second sink close',
        'destroy texture owned',
        'destroy backend {"skipTextures":true,"loseContext":true}'
    ]
    if (JSON.stringify(events) !== JSON.stringify(expected)) {
        throw new Error(`Expected cleanup after the first sink error, got ${JSON.stringify(events)}`)
    }
})

test('Pipeline - renderCubemap can yield between face renders', async () => {
    const backend = new MockBackend()
    const graph = { passes: [], textures: new Map() }
    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(16, 16)

    let rafCalls = 0
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (callback) => {
        rafCalls++
        queueMicrotask(callback)
        return rafCalls
    }

    try {
        const faces = await pipeline.renderCubemap({ size: 8, yieldBetweenFaces: true })

        if (faces.length !== 6) {
            throw new Error(`Expected 6 cubemap faces, got ${faces.length}`)
        }

        if (backend.frameCount !== 6) {
            throw new Error(`Expected one render per cubemap face, got ${backend.frameCount}`)
        }

        if (rafCalls !== 6) {
            throw new Error(`Expected one yield per cubemap face, got ${rafCalls}`)
        }
    } finally {
        if (previousRaf) {
            globalThis.requestAnimationFrame = previousRaf
        } else {
            delete globalThis.requestAnimationFrame
        }
    }
})

runTests()
