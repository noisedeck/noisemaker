#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    affectedParityEffectIds,
    changedEffectIds,
    comparePixelFrames,
    computeEffectSourceHash,
    computeParitySourceHash,
    matchesTargetEffectPass,
    registeredParityEffectIds,
    validateWgslTextureBindings,
    validateFrameEvidence,
    validateParityCase,
    validateParityAttestation,
} from '../../scripts/lib/shader-parity-attestation.mjs'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noisemaker-parity-attestation-'))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const brightestSource = fs.readFileSync(path.join(
    repoRoot,
    'shaders/effects/filter/pixelSort/wgsl/findBrightest.wgsl',
), 'utf8')
const sampleBudget = brightestSource.match(/const\s+NUM_SAMPLES\s*:\s*i32\s*=\s*(\d+)\s*;/)
assert.ok(sampleBudget, 'PixelSort WGSL must declare a fixed brightest-row sample budget')
assert.equal(Number(sampleBudget[1]), 32,
    'PixelSort WGSL must cap the brightest-row search at 32 samples per output pixel')
assert.match(brightestSource, /for\s*\([^;]+;\s*[^;]+<\s*NUM_SAMPLES\s*;/,
    'PixelSort WGSL must bound the brightest-row loop by NUM_SAMPLES')

try {
    const effectDir = path.join(tempRoot, 'shaders/effects/filter/example')
    fs.mkdirSync(path.join(effectDir, 'glsl'), { recursive: true })
    fs.mkdirSync(path.join(effectDir, 'wgsl'), { recursive: true })
    fs.writeFileSync(path.join(effectDir, 'definition.js'), 'export default {}\n')
    fs.writeFileSync(path.join(effectDir, 'glsl/example.glsl'), 'uniform sampler2D originalTex;\nvoid main() {}\n')
    fs.writeFileSync(path.join(effectDir, 'wgsl/example.wgsl'), '@fragment fn main() {}\n')

    const originalHash = computeEffectSourceHash(tempRoot, 'filter/example')
    assert.match(originalHash, /^[a-f0-9]{64}$/)
    assert.equal(computeEffectSourceHash(tempRoot, 'filter/example'), originalHash,
        'effect source hashing must be deterministic')

    const dependencyDir = path.join(tempRoot, 'shaders/effects/synth/dependency')
    fs.mkdirSync(path.join(dependencyDir, 'glsl'), { recursive: true })
    fs.mkdirSync(path.join(dependencyDir, 'wgsl'), { recursive: true })
    fs.writeFileSync(path.join(dependencyDir, 'definition.js'), 'export default {}\n')
    fs.writeFileSync(path.join(dependencyDir, 'glsl/dependency.glsl'), 'void main() {}\n')
    fs.writeFileSync(path.join(dependencyDir, 'wgsl/dependency.wgsl'), '@fragment fn main() {}\n')
    const parityCase = { effects: ['synth/dependency', 'filter/example'] }
    fs.writeFileSync(path.join(effectDir, 'parity-case.json'), `${JSON.stringify(parityCase)}\n`)
    const originalParityHash = computeParitySourceHash(tempRoot, parityCase)
    fs.writeFileSync(path.join(dependencyDir, 'wgsl/dependency.wgsl'), '@fragment fn main() { let changed = 1; }\n')
    assert.notEqual(computeParitySourceHash(tempRoot, parityCase), originalParityHash,
        'changing a shader used by the parity case must invalidate its evidence')
    assert.deepEqual(affectedParityEffectIds(tempRoot, [
        'shaders/effects/synth/dependency/wgsl/dependency.wgsl',
    ]), ['filter/example', 'synth/dependency'],
    'a changed dependency must select both itself and parity cases that render it')
    assert.deepEqual(registeredParityEffectIds(tempRoot), ['filter/example'],
        'full verification must select every effect with a registered parity case')

    const completeParityCase = {
        schemaVersion: 1,
        effects: ['synth/dependency', 'filter/example'],
        dsl: 'dependency().example().write(o0)\nrender(o0)',
        surface: 'o0',
        resolution: [8, 8],
        epsilon: 0,
        requireColorVariation: true,
    }
    assert.deepEqual(validateParityCase(completeParityCase, 'filter/example'), [])
    assert.equal(matchesTargetEffectPass({
        effectKey: 'example',
        effectFunc: 'example',
        effectNamespace: null,
    }, 'filter/example'), true,
    'effects whose definitions omit namespace must still prove target execution')
    assert.equal(matchesTargetEffectPass({
        effectKey: 'example',
        effectFunc: 'example',
        effectNamespace: 'other',
    }, 'filter/example'), false,
    'an explicit conflicting namespace must not match the target effect')
    const invalidCaseErrors = validateParityCase({
        ...completeParityCase,
        effects: ['synth/dependency'],
        dsl: '   ',
        requireColorVariation: false,
    }, 'filter/example')
    assert.ok(invalidCaseErrors.includes('parity case effects must include filter/example'))
    assert.ok(invalidCaseErrors.includes('parity case DSL must be non-empty'))
    assert.ok(invalidCaseErrors.includes('parity case must require color variation'))

    fs.writeFileSync(path.join(effectDir, 'wgsl/example.wgsl'), '@fragment fn main() { let changed = 1; }\n')
    assert.notEqual(computeEffectSourceHash(tempRoot, 'filter/example'), originalHash,
        'changing either shader language must invalidate parity evidence')

    fs.writeFileSync(path.join(effectDir, 'wgsl/example.wgsl'), `
@group(0) @binding(0) var original_texture: texture_2d<f32>;
@fragment fn main() {}
`)
    assert.deepEqual(validateWgslTextureBindings(tempRoot, 'filter/example', {
        passes: [{ program: 'example', inputs: { originalTex: 'inputTex' } }],
    }), [
        'example.wgsl declares texture original_texture, but pass example inputs are originalTex',
    ], 'WGSL texture names must match the effect pass bindings')

    fs.writeFileSync(path.join(effectDir, 'wgsl/example.wgsl'), `
@group(0) @binding(0) var originalTex: texture_2d<f32>;
@fragment fn main() {}
`)
    assert.deepEqual(validateWgslTextureBindings(tempRoot, 'filter/example', {
        passes: [{ program: 'example', inputs: { originalTex: 'inputTex' } }],
    }), [])
    fs.writeFileSync(path.join(effectDir, 'glsl/example.glsl'), `
uniform sampler2D originalTex;
void main() {}
`)
    assert.deepEqual(validateWgslTextureBindings(tempRoot, 'filter/example', {
        passes: [{
            program: 'example',
            inputs: { originalTex: 'inputTex', neverBound: 'otherTex' },
        }],
    }), [], 'chain-only pass inputs that GLSL does not sample must not be required in WGSL')

    fs.writeFileSync(path.join(effectDir, 'wgsl/example.wgsl'), `
@group(0) @binding(0) var tex0: texture_2d<f32>;
@fragment fn main() {}
`)
    fs.writeFileSync(path.join(effectDir, 'glsl/example.glsl'), 'uniform sampler2D inputTex;\nvoid main() {}\n')
    assert.deepEqual(validateWgslTextureBindings(tempRoot, 'filter/example', {
        passes: [{ program: 'example', inputs: { inputTex: 'inputTex' } }],
    }), [], 'the runtime texN alias must satisfy the corresponding pass input')

    fs.rmSync(path.join(effectDir, 'glsl/example.glsl'))
    fs.writeFileSync(path.join(effectDir, 'wgsl/example.wgsl'), '@fragment fn main() {}\n')
    assert.deepEqual(validateWgslTextureBindings(tempRoot, 'filter/example', {
        passes: [{ program: 'example', inputs: { inputTex: 'inputTex' } }],
    }), [], 'backend-specific or chain-only inputs must not require a matching sampled texture')

    const oneByteDifference = comparePixelFrames(
        { width: 1, height: 1, data: Uint8Array.from([0, 0, 0, 255]) },
        { width: 1, height: 1, data: Uint8Array.from([1, 0, 0, 255]) },
    )
    assert.equal(oneByteDifference.epsilon, 0)
    assert.equal(oneByteDifference.maxDiff, 1)
    assert.equal(oneByteDifference.mismatchCount, 1,
        'a one-byte channel difference must fail strict pixel parity')

    assert.deepEqual(changedEffectIds([
        'shaders/effects/filter/example/wgsl/example.wgsl',
        'shaders/effects/filter/example/help.md',
        'shaders/effects/synth/noise/glsl/noise.glsl',
        'shaders/effects/synth/noise/parity-attestation.json',
        'shaders/src/runtime/backends/webgpu.js',
    ]), ['filter/example', 'synth/noise'])

    const validFrame = {
        width: 8,
        height: 8,
        nonzeroRgbPixels: 64,
        nonzeroAlphaPixels: 64,
        uniqueColors: 16,
    }
    const emptyBeforeMismatch = {
        schemaVersion: 1,
        effect: 'filter/example',
        sourceHash: 'source-hash',
        caseHash: 'case-hash',
        resolution: [8, 8],
        frames: {
            webgl2: validFrame,
            webgpu: { ...validFrame, nonzeroRgbPixels: 0, uniqueColors: 1 },
        },
        execution: { webgl2TargetPasses: 1, webgpuTargetPasses: 1 },
        parity: { epsilon: 0, maxDiff: 255, meanDiff: 4, mismatchCount: 128, mismatchPercent: 50 },
    }
    assert.deepEqual(validateFrameEvidence(emptyBeforeMismatch.frames, true),
        ['WebGPU frame is empty (zero non-black RGB pixels)'])
    assert.deepEqual(validateParityAttestation(emptyBeforeMismatch, {
        effectId: 'filter/example',
        sourceHash: 'source-hash',
        caseHash: 'case-hash',
        resolution: [8, 8],
        epsilon: 0,
        requireColorVariation: true,
    }), ['WebGPU frame is empty (zero non-black RGB pixels)'],
    'empty output must fail before pixel comparison is considered')

    const validAttestation = {
        ...emptyBeforeMismatch,
        frames: { webgl2: validFrame, webgpu: validFrame },
        parity: { epsilon: 0, maxDiff: 0, meanDiff: 0, mismatchCount: 0, mismatchPercent: 0 },
    }
    assert.deepEqual(validateParityAttestation(validAttestation, {
        effectId: 'filter/example',
        sourceHash: 'source-hash',
        caseHash: 'case-hash',
        resolution: [8, 8],
        epsilon: 0,
        requireColorVariation: true,
    }), [])

    const malformedAttestation = {
        ...validAttestation,
        resolution: undefined,
        frames: {
            webgl2: { ...validFrame, width: undefined },
            webgpu: validFrame,
        },
    }
    const malformedErrors = validateParityAttestation(malformedAttestation, {
        effectId: 'filter/example',
        sourceHash: 'source-hash',
        caseHash: 'case-hash',
        resolution: [8, 8],
        epsilon: 0,
        requireColorVariation: true,
    })
    assert.ok(malformedErrors.includes('attestation resolution must equal 8x8'))
    assert.ok(malformedErrors.includes('WebGL2 frame width must equal 8'))
    assert.ok(validateParityAttestation({
        ...validAttestation,
        resolution: [8, 8, 1],
    }, {
        effectId: 'filter/example',
        sourceHash: 'source-hash',
        caseHash: 'case-hash',
        resolution: [8, 8],
        epsilon: 0,
        requireColorVariation: true,
    }).includes('attestation resolution must equal 8x8'),
    'attestation resolution must contain exactly two dimensions')
    assert.ok(validateParityAttestation({
        ...validAttestation,
        execution: undefined,
    }, {
        effectId: 'filter/example',
        sourceHash: 'source-hash',
        caseHash: 'case-hash',
        resolution: [8, 8],
        epsilon: 0,
        requireColorVariation: true,
    }).includes('attestation must show filter/example executed on WebGL2 and WebGPU'))

    const verifier = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts/verify-shader-parity-attestations.mjs'),
        '--files',
        'shaders/effects/filter/pixelSort/wgsl/finalize.wgsl',
    ], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(verifier.status, 0,
        `current PixelSort evidence must pass the CPU-only verifier:\n${verifier.stdout}${verifier.stderr}`)
    assert.match(verifier.stdout, /filter\/pixelSort: parity evidence is current/)

    const allVerifier = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts/verify-shader-parity-attestations.mjs'),
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            CI: '1',
            SHADER_PARITY_ALL: '1',
            SHADER_PARITY_BASE: '',
        },
    })
    assert.equal(allVerifier.status, 0,
        `full parity-evidence verification must pass:\n${allVerifier.stdout}${allVerifier.stderr}`)
    assert.match(allVerifier.stdout, /filter\/pixelSort: parity evidence is current/,
        'full verification must select every registered parity case')

    console.log('Shader parity attestation contracts passed')
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
