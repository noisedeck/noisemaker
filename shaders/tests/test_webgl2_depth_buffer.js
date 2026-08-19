/**
 * ensureDepthBuffer must leave the framebuffer binding as it found it.
 *
 * executePass binds the target FBO, then calls ensureDepthBuffer, then draws.
 * On the creation path ensureDepthBuffer bound the FBO itself and finished by
 * binding null without restoring, so the draw that followed went to the default
 * framebuffer: the first scene frame — and every frame after a resize, since
 * SceneRenderer.resize() destroys and recreates all nine scene textures —
 * painted raw G-buffer albedo onto the canvas and left the G-buffer at clear
 * colour.
 *
 * Run: node shaders/tests/test_webgl2_depth_buffer.js
 */

import assert from 'node:assert'
import { WebGL2Backend } from '../src/runtime/backends/webgl2.js'

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

/** Minimal GL stub tracking only what this method touches. */
function stubGl() {
    return {
        FRAMEBUFFER: 'FRAMEBUFFER',
        RENDERBUFFER: 'RENDERBUFFER',
        FRAMEBUFFER_BINDING: 'FRAMEBUFFER_BINDING',
        DEPTH_ATTACHMENT: 'DEPTH_ATTACHMENT',
        DEPTH_COMPONENT24: 'DEPTH_COMPONENT24',
        FRAMEBUFFER_COMPLETE: 'COMPLETE',
        boundFramebuffer: null,
        createRenderbuffer() { return { id: 'rb' } },
        bindRenderbuffer() {},
        renderbufferStorage() {},
        bindFramebuffer(_target, fbo) { this.boundFramebuffer = fbo },
        framebufferRenderbuffer() {},
        checkFramebufferStatus() { return 'COMPLETE' },
        deletedRenderbuffers: [],
        deletedFramebuffers: [],
        deleteRenderbuffer(rb) { this.deletedRenderbuffers.push(rb) },
        deleteFramebuffer(fbo) { this.deletedFramebuffers.push(fbo) },
        deleteTexture() {},
        getParameter(p) { return p === 'FRAMEBUFFER_BINDING' ? this.boundFramebuffer : null }
    }
}

function backendWith(gl) {
    const backend = Object.create(WebGL2Backend.prototype)
    backend.gl = gl
    backend.depthBuffers = new Map()
    return backend
}

test('creation path restores the caller\'s framebuffer binding', () => {
    const gl = stubGl()
    const backend = backendWith(gl)
    const target = { id: 'mesh-fbo' }

    gl.bindFramebuffer(gl.FRAMEBUFFER, target)   // what executePass does
    backend.ensureDepthBuffer(target, 320, 240)

    assert.strictEqual(gl.boundFramebuffer, target,
        'the draw that follows must still target the mesh FBO, not the canvas')
})

test('cached path leaves the binding untouched', () => {
    const gl = stubGl()
    const backend = backendWith(gl)
    const target = { id: 'mesh-fbo' }

    backend.ensureDepthBuffer(target, 320, 240)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    backend.ensureDepthBuffer(target, 320, 240)   // cache hit

    assert.strictEqual(gl.boundFramebuffer, target, 'cache hit must not rebind')
})

test('destroying a texture releases the depth renderbuffers of its FBOs', () => {
    const gl = stubGl()
    const backend = backendWith(gl)
    backend.textures = new Map([['scene_gbuf_albedo_metallic', { handle: 't' }]])
    const mrtFbo = { id: 'mrt-fbo' }
    backend.fbos = new Map([['mrt_scene_pass_scene_gbuf_albedo_metallic', mrtFbo]])
    backend.ensureDepthBuffer(mrtFbo, 320, 240)
    assert.strictEqual(backend.depthBuffers.size, 1, 'precondition: a depth buffer exists')

    // SceneRenderer.resize() destroys and recreates every scene texture, so
    // this runs on each resize event.
    backend.destroyTexture('scene_gbuf_albedo_metallic')

    assert.strictEqual(gl.deletedRenderbuffers.length, 1,
        'the depth renderbuffer must be deleted with its FBO')
    assert.strictEqual(backend.depthBuffers.size, 0,
        'depthBuffers is keyed by the deleted framebuffer object and must not retain it')
})

console.log(`\nWebGL2 depth buffer: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
