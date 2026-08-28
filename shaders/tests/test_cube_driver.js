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
    const want = ['hook:0', 'render', 'hook:1', 'render', 'hook:2', 'render',
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
        async renderCubemapFace(sceneTree, clock, face, target) {
            await Promise.resolve()
            this.faces.push(face)
            this.targets.push(target)
            events.push(`scene:${face}`)
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
    return { renderer, pipeline, backend }
}

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
    // The scene draws the face BEFORE the pipeline blits and reads it back.
    const order = events.filter((e) => e === 'scene:0' || e === 'pipeline')
    if (order[0] !== 'scene:0' || order[1] !== 'pipeline') {
        throw new Error(`scene face must precede its pipeline render, got ${order.slice(0, 2).join(',')}`)
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
})

runTests()
