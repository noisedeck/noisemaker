/**
 * WebGL2 Backend GL Error-Check Gating Tests
 *
 * gl.getError() forces a synchronous CPU/GPU pipeline flush, so per-pass
 * checks on every frame turn GPU load into main-thread stalls. These tests
 * pin the gating contract: checks run only for GL_ERROR_CHECK_FRAMES frames
 * after a program compile, and steady-state frames never call gl.getError().
 */

import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'

const tests = []

function test(name, fn) {
    tests.push({ name, fn })
}

async function runTests() {
    console.log('\n=== Running GL Error-Check Gating Tests ===\n')
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

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed')
    }
}

/**
 * Stub WebGL2 context: records gl.getError() calls, answers success for
 * compile/link queries, zero for active-resource counts, and a stable
 * number for every constant. Methods are recorded no-ops.
 */
function createStubGL() {
    const state = { getErrorCalls: 0 }
    const cache = new Map()
    let nextConst = 1

    const gl = new Proxy({}, {
        get(_target, prop) {
            if (cache.has(prop)) return cache.get(prop)

            let value
            if (prop === 'NO_ERROR') {
                value = 0
            } else if (prop === 'getError') {
                value = () => {
                    state.getErrorCalls++
                    return 0 // NO_ERROR
                }
            } else if (prop === 'getShaderParameter') {
                value = () => true
            } else if (prop === 'getProgramParameter') {
                // LINK_STATUS true; ACTIVE_UNIFORMS / ACTIVE_UNIFORM_BLOCKS 0
                value = (_program, pname) => (pname === cache.get('LINK_STATUS') ? true : 0)
            } else if (prop === 'getAttribLocation' || prop === 'getUniformLocation') {
                value = () => -1
            } else if (prop === 'checkFramebufferStatus') {
                value = () => gl.FRAMEBUFFER_COMPLETE
            } else if (prop === 'createProgram' || prop === 'createShader'
                || prop === 'createBuffer' || prop === 'createVertexArray') {
                value = () => ({})
            } else if (prop === 'canvas') {
                value = null
            } else if (prop === 'drawingBufferWidth' || prop === 'drawingBufferHeight') {
                value = 8
            } else if (typeof prop === 'string' && /^[A-Z][A-Z0-9_]*$/.test(prop)) {
                value = nextConst++ // GL constant
            } else {
                value = () => undefined // recorded no-op method
            }

            cache.set(prop, value)
            return value
        }
    })

    // Force LINK_STATUS into the cache before getProgramParameter reads it
    void gl.LINK_STATUS
    return { gl, state }
}

function createBackend() {
    const { gl, state } = createStubGL()
    const backend = new WebGL2Backend(gl, null)
    return { backend, state }
}

const PASS = { id: 'p0', program: 'prog0', outputs: { color: 'screen' } }
const FRAME_STATE = { uniforms: {}, textures: {} }

async function compileTestProgram(backend) {
    await backend.compileProgram('prog0', { source: 'void main() {}' })
}

test('executePass skips gl.getError() before any compile', () => {
    const { backend, state } = createBackend()
    backend.programs.set('prog0', { handle: {}, uniforms: {}, uniformBlocks: [], attributes: {} })

    backend.executePass(PASS, FRAME_STATE)
    assert(state.getErrorCalls === 0,
        `expected 0 getError calls with unarmed window, got ${state.getErrorCalls}`)
})

test('compileProgram arms per-pass error checking', async () => {
    const { backend, state } = createBackend()
    await compileTestProgram(backend)
    assert(backend.glErrorCheckFrames > 0, 'compile should arm the error-check window')

    const before = state.getErrorCalls
    backend.executePass(PASS, FRAME_STATE)
    assert(state.getErrorCalls > before,
        'expected getError calls during the post-compile window')
})

test('error checking disarms after the post-compile frame window', async () => {
    const { backend, state } = createBackend()
    await compileTestProgram(backend)

    // Burn down the window in real pipeline order: beginFrame latches the
    // per-frame flag, endFrame decrements the counter.
    const armedFrames = backend.glErrorCheckFrames
    for (let i = 0; i < armedFrames; i++) {
        backend.beginFrame()
        backend.executePass(PASS, FRAME_STATE)
        backend.endFrame()
    }
    assert(backend.glErrorCheckFrames === 0, 'window should be fully burned down')

    const before = state.getErrorCalls
    backend.beginFrame()
    backend.executePass(PASS, FRAME_STATE)
    backend.endFrame()
    assert(state.getErrorCalls === before,
        `expected no getError calls in steady state, got ${state.getErrorCalls - before} extra`)
})

test('present is checked on every armed frame in real pipeline order', async () => {
    // Pipeline.render() runs beginFrame -> passes -> endFrame -> present, so
    // present executes AFTER the frame counter decrements. The frame-latched
    // flag must keep present covered through the LAST armed frame — reading
    // the live counter there would silently skip it.
    const { backend, state } = createBackend()
    backend.textures.set('tex0', { handle: {}, width: 4, height: 4 })
    backend.presentProgram = { handle: {}, uniforms: { texture: 0 } }
    backend.fullscreenVAO = {}

    await compileTestProgram(backend)
    const armedFrames = backend.glErrorCheckFrames

    for (let frame = 1; frame <= armedFrames; frame++) {
        backend.beginFrame()
        backend.executePass(PASS, FRAME_STATE)
        backend.endFrame()
        const before = state.getErrorCalls
        backend.present('tex0')
        assert(state.getErrorCalls > before,
            `present should be checked on armed frame ${frame}/${armedFrames}`)
    }

    // First steady-state frame: nothing checks
    const before = state.getErrorCalls
    backend.beginFrame()
    backend.executePass(PASS, FRAME_STATE)
    backend.endFrame()
    backend.present('tex0')
    assert(state.getErrorCalls === before,
        'no getError calls anywhere on the first steady-state frame')
})

test('createTexture re-arms the window (resize/allocation path)', async () => {
    const { backend, state } = createBackend()
    await compileTestProgram(backend)

    // Reach steady state
    while (backend.glErrorCheckFrames > 0) {
        backend.beginFrame()
        backend.endFrame()
    }
    backend.beginFrame()
    const quiet = state.getErrorCalls
    backend.executePass(PASS, FRAME_STATE)
    assert(state.getErrorCalls === quiet, 'sanity: steady state is unchecked')

    // A fresh allocation (what Pipeline.resize() does per surface) re-arms
    backend.createTexture('resized_tex', { width: 8, height: 8, format: 'rgba8', usage: ['render'] })
    assert(backend.glErrorCheckFrames > 0, 'createTexture should re-arm the window')

    const before = state.getErrorCalls
    backend.beginFrame()
    backend.executePass(PASS, FRAME_STATE)
    assert(state.getErrorCalls > before, 'expected getError calls after reallocation')
})

test('present follows the same gating as executePass', async () => {
    const { backend, state } = createBackend()
    backend.textures.set('tex0', { handle: {}, width: 4, height: 4 })
    backend.presentProgram = { handle: {}, uniforms: { texture: 0 } }
    backend.fullscreenVAO = {}

    // Steady state: no checks
    let before = state.getErrorCalls
    backend.present('tex0')
    assert(state.getErrorCalls === before, 'present must not call getError when disarmed')

    // Post-compile window: checks run
    await compileTestProgram(backend)
    before = state.getErrorCalls
    backend.present('tex0')
    assert(state.getErrorCalls > before, 'present should call getError while armed')
})

test('recompile re-arms the window', async () => {
    const { backend, state } = createBackend()
    await compileTestProgram(backend)
    while (backend.glErrorCheckFrames > 0) backend.endFrame()

    await compileTestProgram(backend)
    assert(backend.glErrorCheckFrames > 0, 'recompile should re-arm the error-check window')

    const before = state.getErrorCalls
    backend.executePass(PASS, FRAME_STATE)
    assert(state.getErrorCalls > before, 'expected getError calls after recompile')
})

runTests().then(() => {
    console.log('\nAll GL error-check gating tests passed')
})
