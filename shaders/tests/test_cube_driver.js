import { Pipeline } from '../src/runtime/pipeline.js'
import { Backend } from '../src/runtime/backend.js'
import { faceBasisMat3, CUBE_FACE_BASES } from '../src/renderer/cubeCamera.js'
import { CanvasRenderer } from '../src/renderer/canvas.js'
import { SCENE_COLOR_TEXTURE } from '../src/rendering/scene-compiler.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
async function runTests() {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`PASS: ${name}`) }
        catch (e) { console.error(`FAIL: ${name}`); console.error(e); process.exit(1) }
    }
    console.log('All cube driver tests passed')
}

const SIZE = 2

class MockBackend extends Backend {
    constructor() {
        super(null)
        this.basesSeen = []
        this.faceIndex = 0
    }

    async init() {}

    createTexture(id, spec) {
        this.textures.set(id, { handle: id, width: spec.width, height: spec.height, format: spec.format })
        return this.textures.get(id)
    }

    destroyTexture(id) { this.textures.delete(id) }

    async compileProgram(id, spec) {
        this.programs.set(id, { handle: id, type: spec.type || 'render' })
        return this.programs.get(id)
    }

    executePass(pass, state) {
        const b = state.globalUniforms && state.globalUniforms.cubeBasis
        if (b) this.basesSeen.push(Array.from(b))
        if (this.onExecutePass) this.onExecutePass(pass, state)
    }

    beginFrame() { this.faceIndex++ }
    endFrame() {}
    resize() {}

    readPixels() {
        const n = SIZE * SIZE * 4
        const data = new Uint8Array(n)
        data[0] = this.basesSeen.length
        data[3] = 255
        return { width: SIZE, height: SIZE, data }
    }

    getName() { return 'Mock' }
    static isAvailable() { return true }
}

test('CUBE_FACE_BASES is precomputed and matches faceBasisMat3', () => {
    if (!CUBE_FACE_BASES || CUBE_FACE_BASES.length !== 6) {
        throw new Error(`Expected CUBE_FACE_BASES to be array of 6, got ${CUBE_FACE_BASES?.length}`)
    }
    for (let f = 0; f < 6; f++) {
        const want = faceBasisMat3(f)
        const got = CUBE_FACE_BASES[f]
        for (let i = 0; i < 9; i++) {
            if (Math.abs(got[i] - want[i]) > 1e-9) {
                throw new Error(`CUBE_FACE_BASES[${f}][${i}] ${got[i]} != ${want[i]}`)
            }
        }
    }
})

test('renderCubemap renders 6 faces with the 6 distinct bases', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [{ id: 'p0', program: 'renderCubemapSurface' }],
        textures: new Map(),
        programs: { renderCubemapSurface: { fragment: 'void main() {}' } },
        renderSurface: 'o0'
    }
    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(SIZE, SIZE)

    const faces = await pipeline.renderCubemap({ size: SIZE, outputSurface: 'o0' })

    if (faces.length !== 6) throw new Error(`expected 6 faces, got ${faces.length}`)

    for (let f = 0; f < 6; f++) {
        if (!faces[f] || !faces[f].data) throw new Error(`face ${f} has no data`)
        if (faces[f].data.length !== SIZE * SIZE * 4) {
            throw new Error(`face ${f} data length ${faces[f].data.length} != ${SIZE * SIZE * 4}`)
        }
    }

    if (backend.basesSeen.length !== 6) {
        throw new Error(`expected 6 cubeBasis captures, got ${backend.basesSeen.length}`)
    }

    for (let f = 0; f < 6; f++) {
        const want = faceBasisMat3(f)
        const got = backend.basesSeen[f]
        for (let i = 0; i < 9; i++) {
            if (Math.abs(got[i] - want[i]) > 1e-9) {
                throw new Error(`face ${f} basis[${i}] got ${got[i]} != want ${want[i]}`)
            }
        }
    }
})

test('renderCubemap runs the per-face hook before each face render', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [{ id: 'p0', program: 'renderCubemapSurface' }],
        textures: new Map(),
        programs: { renderCubemapSurface: { fragment: 'void main() {}' } },
        renderSurface: 'o0'
    }
    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(SIZE, SIZE)

    const events = []
    backend.onExecutePass = () => events.push('render')
    const faces = await pipeline.renderCubemap({
        size: SIZE,
        outputSurface: 'o0',
        onFace: async (face) => {
            // Asynchronous on purpose: a scene face render spans awaits, and
            // the pipeline must not run the face's passes until it resolves.
            await Promise.resolve()
            events.push(`hook:${face}`)
        }
    })

    if (faces.length !== 6) throw new Error(`expected 6 faces, got ${faces.length}`)
    // The leading render is the priming one the hook path takes — see 'the
    // scene export primes the chain before the first face'.
    const want = ['render', 'hook:0', 'render', 'hook:1', 'render', 'hook:2', 'render',
        'hook:3', 'render', 'hook:4', 'render', 'hook:5', 'render']
    if (events.join(',') !== want.join(',')) {
        throw new Error(`hook/render interleave ${events.join(',')} != ${want.join(',')}`)
    }
})

/**
 * A scene program has no cubemap-renderer shader to set `cubeBasis` on: the
 * faces come from six renders of the scene through cube-face cameras. The
 * export entry is the same one, so the readback, the face order and the
 * returned buffers stay the 2D path's.
 */
function sceneRendererStub(events) {
    return {
        width: 0,
        height: 0,
        exports: 0,
        openExports: 0,
        faces: [],
        targets: [],
        resizes: [],
        // A scene render — loop frame or export face — spans awaits. Two of them
        // overlapping is the hazard the export guard exists to prevent, so the
        // stub measures overlap rather than merely counting calls.
        inFlight: 0,
        maxConcurrent: 0,
        /**
         * Set by a test to hold a render open across the export's start. Held
         * per label, so a test can pin the loop render open while leaving the
         * export's own faces free to run — which is what makes "the export did
         * not start" an observation rather than an artefact of the gate.
         */
        gate: null,
        gateLabel: null,
        /** Set by a test to run something between two export faces. */
        onFaceRendered: null,
        async _enter(label) {
            this.inFlight++
            this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight)
            events.push(label)
            if (this.gate && (this.gateLabel === null || this.gateLabel === label)) await this.gate
            await Promise.resolve()
        },
        resize(width, height) {
            this.width = width
            this.height = height
            this.resizes.push([width, height])
        },
        beginCubemapExport() {
            this.exports++
            this.openExports++
            events.push('begin')
        },
        async render() {
            await this._enter('scene:loop')
            this.inFlight--
        },
        async renderCubemapFace(sceneTree, clock, face, target) {
            await this._enter(`scene:${face}`)
            this.faces.push(face)
            this.targets.push(target)
            this.inFlight--
            if (this.onFaceRendered) this.onFaceRendered(face)
        },
        endCubemapExport() {
            this.openExports--
            events.push('end')
        }
    }
}

async function cubeExportRenderer(isScene, events) {
    const backend = new MockBackend()
    backend.onExecutePass = () => events.push('pipeline')
    const graph = {
        passes: [{ id: 'p0', program: 'blit' }],
        textures: new Map(),
        programs: { blit: { fragment: 'void main() {}' } },
        renderSurface: 'o0'
    }
    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(8, 8)

    const renderer = Object.create(CanvasRenderer.prototype)
    renderer._pipeline = pipeline
    renderer._isScene = isScene
    renderer._sceneRenderer = isScene ? sceneRendererStub(events) : null
    renderer._sceneTree = isScene ? { updateWorldMatrices() { events.push('matrices') } } : null
    renderer._sceneBindings = null
    renderer._clock = null
    renderer._loopDuration = 4
    renderer._sceneRenderPending = null
    renderer._tileRegion = null
    renderer._isContextLost = false
    renderer._frameCount = 0
    return { renderer, pipeline, backend }
}

/** Let the microtask queue drain, so anything that WOULD start has started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a scene program exports six faces through the scene renderer', async () => {
    const events = []
    const { renderer, pipeline } = await cubeExportRenderer(true, events)
    const scene = renderer._sceneRenderer

    const faces = await renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })

    if (faces.length !== 6) throw new Error(`expected 6 faces, got ${faces.length}`)
    if (scene.faces.join(',') !== '0,1,2,3,4,5') {
        throw new Error(`face order ${scene.faces.join(',')} != 0,1,2,3,4,5`)
    }
    if (scene.targets.some((t) => t !== SCENE_COLOR_TEXTURE)) {
        throw new Error(`faces must present into ${SCENE_COLOR_TEXTURE}, got ${scene.targets.join(',')}`)
    }
    if (scene.exports !== 1 || scene.openExports !== 0) {
        throw new Error(`export must be bracketed exactly once, got ${scene.exports}/${scene.openExports}`)
    }
    // One priming pipeline render precedes face 0, then every face draws
    // BEFORE the pipeline blits and reads it back. See the priming test below
    // for why the first render is there.
    const order = events.filter((e) => e.startsWith('scene:') || e === 'pipeline')
    const want = ['pipeline', 'scene:0', 'pipeline', 'scene:1', 'pipeline', 'scene:2',
        'pipeline', 'scene:3', 'pipeline', 'scene:4', 'pipeline', 'scene:5', 'pipeline']
    if (order.join(',') !== want.join(',')) {
        throw new Error(`export order ${order.join(',')} != ${want.join(',')}`)
    }
    // The scene renderer's G-buffer is the export size while the faces render,
    // and back to the pipeline's size afterwards.
    if (scene.resizes.length !== 2) throw new Error(`expected 2 resizes, got ${scene.resizes.length}`)
    if (scene.resizes[0].join('x') !== `${SIZE}x${SIZE}`) {
        throw new Error(`first resize ${scene.resizes[0].join('x')} != ${SIZE}x${SIZE}`)
    }
    if (scene.resizes[1].join('x') !== `${pipeline.width}x${pipeline.height}`) {
        throw new Error(`restored to ${scene.resizes[1].join('x')} != ${pipeline.width}x${pipeline.height}`)
    }
})

test('a non-scene program exports through the pipeline alone', async () => {
    const events = []
    const { renderer, backend } = await cubeExportRenderer(false, events)

    const faces = await renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })

    if (faces.length !== 6) throw new Error(`expected 6 faces, got ${faces.length}`)
    if (backend.basesSeen.length !== 6) {
        throw new Error(`expected 6 cubeBasis captures, got ${backend.basesSeen.length}`)
    }
    if (events.some((e) => e.startsWith('scene:') || e === 'begin' || e === 'end')) {
        throw new Error(`non-scene export must not touch the scene renderer: ${events.join(',')}`)
    }
    // The priming render below belongs to the scene path alone: a 2D graph
    // renders exactly once per face, as it always has.
    const renders = events.filter((e) => e === 'pipeline').length
    if (renders !== 6) throw new Error(`2D export must render once per face, got ${renders}`)
})

/**
 * Face 0 must not march a stale volume atlas.
 *
 * The pipeline runs onFace (the scene's face render) BEFORE its own passes, so
 * without a priming render face 0's scene draw reads whatever the volume atlas
 * and surface chain held at the last pre-export frame, while faces 1-5 read the
 * state this export's own renders produced. Six faces of two different instants
 * do not close into a cube.
 *
 * One render before the face loop puts every face on the same footing.
 */
test('the scene export primes the chain before the first face', async () => {
    const events = []
    const { renderer } = await cubeExportRenderer(true, events)

    await renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })

    const first = events.filter((e) => e.startsWith('scene:') || e === 'pipeline')[0]
    if (first !== 'pipeline') {
        throw new Error(`a priming render must precede face 0, got ${first} first`)
    }
    // Seven renders for six faces: the priming one, then one per face.
    const renders = events.filter((e) => e === 'pipeline').length
    if (renders !== 7) throw new Error(`expected 6 face renders plus one priming, got ${renders}`)
})

/**
 * An export and a loop render must never be in flight together.
 *
 * They share the backend's frame brackets (one command encoder on WebGPU), the
 * scene renderer's pass state, and the pipeline's size — which the export
 * changes underneath anything that captured it before an await. The loop's own
 * skip-and-present rule already covers this shape: a frame that finds a scene
 * render in flight presents the last completed one instead of starting a
 * second. The export takes that same guard, and waits for anything already
 * holding it.
 */
test('an export never overlaps an in-flight loop render', async () => {
    const events = []
    const { renderer } = await cubeExportRenderer(true, events)
    const scene = renderer._sceneRenderer

    let releaseLoop
    scene.gate = new Promise((resolve) => { releaseLoop = resolve })
    scene.gateLabel = 'scene:loop'

    const loop = renderer.render(0.25)
    await settle()
    if (scene.inFlight !== 1) throw new Error('precondition: a loop render is in flight')

    const exportPromise = renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })
    await settle()
    if (scene.faces.length !== 0) {
        throw new Error(`export started ${scene.faces.length} faces while a loop render was in flight`)
    }

    scene.gate = null
    releaseLoop()
    await loop
    const faces = await exportPromise

    if (faces.length !== 6) throw new Error(`expected 6 faces, got ${faces.length}`)
    if (scene.maxConcurrent !== 1) {
        throw new Error(`scene renders overlapped: maxConcurrent ${scene.maxConcurrent} != 1`)
    }
    if (events.indexOf('scene:loop') > events.indexOf('scene:0')) {
        throw new Error('the loop render must finish before the export begins')
    }
})

/**
 * A second export while one is running would overwrite the first's saved probe
 * state with the first's own forced state, so the live loop's amortization
 * would never be restored — the probe would re-capture all six faces every
 * frame from then on. There is one right answer and it is not "interleave".
 */
test('a second export while one is running is rejected', async () => {
    const events = []
    const { renderer } = await cubeExportRenderer(true, events)
    const scene = renderer._sceneRenderer

    let releaseFace
    scene.gate = new Promise((resolve) => { releaseFace = resolve })

    const first = renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })
    await settle()

    // Raced against a turn of the event loop: an implementation that lets the
    // second export through leaves it pending behind the first's gate rather
    // than rejecting, and hanging the suite would report nothing useful.
    const second = renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })
    const rejected = await Promise.race([
        second.then(() => 'resolved', (err) => err),
        settle().then(() => 'still running')
    ])

    if (!(rejected instanceof Error)) {
        throw new Error(`a reentrant export must reject, got: ${rejected}`)
    }
    if (!/in flight/.test(rejected.message)) {
        throw new Error(`reentrant rejection must say why: ${rejected.message}`)
    }

    scene.gate = null
    releaseFace()
    const faces = await first
    if (faces.length !== 6) throw new Error(`the first export must still complete, got ${faces.length}`)
    if (scene.exports !== 1 || scene.openExports !== 0) {
        throw new Error(`one export bracket only, got ${scene.exports}/${scene.openExports}`)
    }
})

/**
 * dispose() and compile() both null _sceneRenderer, and either can land while
 * an export is between faces. An export that reaches back through `this` for
 * its teardown throws a TypeError out of its own finally at that point, losing
 * the real outcome. It holds the renderer it started with instead.
 */
test('a dispose mid-export does not break the export teardown', async () => {
    const events = []
    const { renderer } = await cubeExportRenderer(true, events)
    const scene = renderer._sceneRenderer

    scene.onFaceRendered = (face) => {
        if (face !== 2) return
        // What dispose()/compile() do to the fields the export path reads.
        renderer._sceneRenderer = null
        renderer._sceneTree = null
    }

    const faces = await renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })

    if (faces.length !== 6) throw new Error(`expected 6 faces, got ${faces.length}`)
    if (scene.openExports !== 0) throw new Error('the export bracket must still close')
    if (scene.resizes.length !== 2) {
        throw new Error(`the size restore must still run, got ${scene.resizes.length} resizes`)
    }
})

/** ...and a dispose during the wait for an in-flight render exports nothing. */
test('a dispose while the export waits its turn exports nothing', async () => {
    const events = []
    const { renderer } = await cubeExportRenderer(true, events)
    const scene = renderer._sceneRenderer

    let releaseLoop
    scene.gate = new Promise((resolve) => { releaseLoop = resolve })
    scene.gateLabel = 'scene:loop'

    const loop = renderer.render(0.25)
    await settle()
    const exportPromise = renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })
    await settle()

    renderer._sceneRenderer = null
    renderer._sceneTree = null
    scene.gate = null
    releaseLoop()
    await loop
    const faces = await exportPromise

    if (faces.length !== 0) throw new Error(`expected no faces, got ${faces.length}`)
    if (scene.exports !== 0) throw new Error('a torn-down export must not open a bracket')
})

/**
 * A tile region belongs to the live 2D view, not to a cube face. The scene
 * renderer already ignores it for a face; the pipeline does not, so any 2D
 * effect downstream of scene() would shade all six faces as one tile of a
 * larger image. Cleared for the export, restored after — a tiled hi-res render
 * that exports mid-run keeps its tile.
 */
test('an export clears the pipeline tile region and restores it', async () => {
    const events = []
    const { renderer, pipeline } = await cubeExportRenderer(true, events)
    const region = { offset: [16, 32], fullResolution: [64, 64], renderScale: 2 }
    renderer.setTileRegion(region)

    const duringFaces = []
    renderer._sceneRenderer.onFaceRendered = () => duringFaces.push(pipeline._tileOffset)

    await renderer.renderCubemap({ size: SIZE, outputSurface: 'o0' })

    if (duringFaces.length !== 6 || duringFaces.some((offset) => offset !== null)) {
        throw new Error(`faces must render untiled, saw offsets ${JSON.stringify(duringFaces)}`)
    }
    if (pipeline._tileOffset !== region.offset || pipeline._fullResolution !== region.fullResolution) {
        throw new Error('the live tile region must be restored after the export')
    }
    if (pipeline._renderScale !== region.renderScale) {
        throw new Error(`renderScale restored as ${pipeline._renderScale}, want ${region.renderScale}`)
    }
})

/**
 * A face that throws must not strand the pipeline at export resolution: the
 * canvas would keep rendering 512x512 into a 1920x1080 element until something
 * else resized it.
 */
test('a throwing face still restores the pipeline size', async () => {
    const backend = new MockBackend()
    const graph = {
        passes: [{ id: 'p0', program: 'blit' }],
        textures: new Map(),
        programs: { blit: { fragment: 'void main() {}' } },
        renderSurface: 'o0'
    }
    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(8, 8)

    let threw = null
    await pipeline.renderCubemap({
        size: 32,
        outputSurface: 'o0',
        onFace: (face) => { if (face === 3) throw new Error('face exploded') }
    }).then(() => { throw new Error('the export must propagate the face failure') },
        (err) => { threw = err })

    if (!/face exploded/.test(threw.message)) throw new Error(`wrong error: ${threw.message}`)
    if (pipeline.width !== 8 || pipeline.height !== 8) {
        throw new Error(`pipeline stranded at ${pipeline.width}x${pipeline.height}, want 8x8`)
    }
})

runTests()
