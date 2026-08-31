import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PARITY_ATTESTATION_SCHEMA_VERSION = 1

function assertEffectId(effectId) {
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(effectId)) {
        throw new Error(`Invalid effect ID: ${effectId}`)
    }
}

function filesRecursively(dir) {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(dir, entry.name)
        return entry.isDirectory() ? filesRecursively(entryPath) : [entryPath]
    })
}

export function effectDirectory(repoRoot, effectId) {
    assertEffectId(effectId)
    return path.join(repoRoot, 'shaders/effects', ...effectId.split('/'))
}

export function effectSourceFiles(repoRoot, effectId) {
    const dir = effectDirectory(repoRoot, effectId)
    const files = [
        path.join(dir, 'definition.js'),
        ...filesRecursively(path.join(dir, 'glsl')),
        ...filesRecursively(path.join(dir, 'wgsl')),
    ].filter((file) => fs.existsSync(file))

    if (!fs.existsSync(path.join(dir, 'definition.js')) ||
        !fs.existsSync(path.join(dir, 'glsl')) ||
        !fs.existsSync(path.join(dir, 'wgsl'))) {
        throw new Error(`${effectId} is not a dual-language shader effect`)
    }
    return files.sort()
}

export function computeEffectSourceHash(repoRoot, effectId) {
    const hash = crypto.createHash('sha256')
    for (const file of effectSourceFiles(repoRoot, effectId)) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/')
        const content = fs.readFileSync(file)
        hash.update(relative)
        hash.update('\0')
        hash.update(String(content.length))
        hash.update('\0')
        hash.update(content)
        hash.update('\0')
    }
    return hash.digest('hex')
}

export function computeParitySourceHash(repoRoot, parityCase) {
    if (!Array.isArray(parityCase?.effects) || parityCase.effects.length === 0) {
        throw new Error('parity case must list at least one effect')
    }
    const effectIds = [...new Set(parityCase.effects)].sort()
    const hash = crypto.createHash('sha256')
    for (const effectId of effectIds) {
        assertEffectId(effectId)
        hash.update(effectId)
        hash.update('\0')
        hash.update(computeEffectSourceHash(repoRoot, effectId))
        hash.update('\0')
    }
    return hash.digest('hex')
}

export function computeFileHash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function comparePixelFrames(webgl, webgpu) {
    if (webgl.width !== webgpu.width || webgl.height !== webgpu.height) {
        throw new Error('backend frame dimensions differ')
    }
    if (webgl.data.length !== webgpu.data.length) {
        throw new Error('backend frame byte lengths differ')
    }

    const rowBytes = webgl.width * 4
    let maxDiff = 0
    let mismatchCount = 0
    let totalDiff = 0
    for (let y = 0; y < webgl.height; y++) {
        const webglOffset = y * rowBytes
        const webgpuOffset = (webgpu.height - 1 - y) * rowBytes
        for (let channel = 0; channel < rowBytes; channel++) {
            const diff = Math.abs(webgl.data[webglOffset + channel] - webgpu.data[webgpuOffset + channel])
            maxDiff = Math.max(maxDiff, diff)
            totalDiff += diff
            if (diff !== 0) mismatchCount++
        }
    }
    return {
        epsilon: 0,
        maxDiff,
        meanDiff: totalDiff / webgl.data.length,
        mismatchCount,
        mismatchPercent: mismatchCount / webgl.data.length * 100,
    }
}

export function matchesTargetEffectPass(pass, effectId) {
    const separator = effectId.indexOf('/')
    const namespace = effectId.slice(0, separator)
    const func = effectId.slice(separator + 1)
    const identityMatches = pass.effectFunc === func ||
        pass.effectKey === func || pass.effectKey === effectId
    return identityMatches &&
        (pass.effectNamespace == null || pass.effectNamespace === namespace)
}

export function changedEffectIds(files) {
    const ids = new Set()
    for (const file of files) {
        const normalized = file.split(path.sep).join('/')
        const match = normalized.match(/^shaders\/effects\/([^/]+)\/([^/]+)\/(definition\.js|glsl\/|wgsl\/|parity-(?:case|attestation)\.json)/)
        if (match) ids.add(`${match[1]}/${match[2]}`)
    }
    return [...ids].sort()
}

export function affectedParityEffectIds(repoRoot, files) {
    const changed = changedEffectIds(files)
    const affected = new Set(changed)
    if (changed.length === 0) return []

    const effectsRoot = path.join(repoRoot, 'shaders/effects')
    for (const casePath of filesRecursively(effectsRoot).filter((file) => path.basename(file) === 'parity-case.json')) {
        const parityCase = JSON.parse(fs.readFileSync(casePath, 'utf8'))
        if (!Array.isArray(parityCase.effects) ||
            !parityCase.effects.some((effectId) => affected.has(effectId))) continue

        const relative = path.relative(effectsRoot, casePath).split(path.sep)
        if (relative.length === 3) affected.add(`${relative[0]}/${relative[1]}`)
    }
    return [...affected].sort()
}

export function registeredParityEffectIds(repoRoot) {
    const effectsRoot = path.join(repoRoot, 'shaders/effects')
    const effectIds = []
    for (const casePath of filesRecursively(effectsRoot).filter((file) => path.basename(file) === 'parity-case.json')) {
        const relative = path.relative(effectsRoot, casePath).split(path.sep)
        if (relative.length === 3) effectIds.push(`${relative[0]}/${relative[1]}`)
    }
    return [...new Set(effectIds)].sort()
}

export function validateParityCase(parityCase, effectId) {
    const errors = []
    if (parityCase?.schemaVersion !== 1) errors.push('parity case schemaVersion must equal 1')
    if (!Array.isArray(parityCase?.effects) || parityCase.effects.length === 0) {
        errors.push('parity case effects must be a non-empty array')
    } else {
        if (!parityCase.effects.includes(effectId)) {
            errors.push(`parity case effects must include ${effectId}`)
        }
        if (parityCase.effects.some((id) => typeof id !== 'string' ||
            !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(id))) {
            errors.push('parity case effects contain an invalid effect ID')
        }
    }
    if (typeof parityCase?.dsl !== 'string' || parityCase.dsl.trim().length === 0) {
        errors.push('parity case DSL must be non-empty')
    }
    if (typeof parityCase?.surface !== 'string' || parityCase.surface.trim().length === 0) {
        errors.push('parity case surface must be non-empty')
    }
    if (!Array.isArray(parityCase?.resolution) || parityCase.resolution.length !== 2 ||
        !parityCase.resolution.every((value) => integerInRange(value, 1, Number.MAX_SAFE_INTEGER))) {
        errors.push('parity case resolution must contain two positive integers')
    }
    if (parityCase?.epsilon !== 0) errors.push('parity case epsilon must be zero')
    if (parityCase?.requireColorVariation !== true) {
        errors.push('parity case must require color variation')
    }
    return errors
}

function stripWgslComments(source) {
    let stripped = ''
    let blockDepth = 0
    for (let index = 0; index < source.length;) {
        const char = source[index]
        const next = source[index + 1]
        if (blockDepth > 0) {
            if (char === '/' && next === '*') {
                stripped += '  '
                blockDepth++
                index += 2
            } else if (char === '*' && next === '/') {
                stripped += '  '
                blockDepth--
                index += 2
            } else {
                stripped += char === '\n' ? '\n' : ' '
                index++
            }
        } else if (char === '/' && next === '/') {
            stripped += '  '
            index += 2
            while (index < source.length && source[index] !== '\n') {
                stripped += ' '
                index++
            }
        } else if (char === '/' && next === '*') {
            stripped += '  '
            blockDepth = 1
            index += 2
        } else {
            stripped += char
            index++
        }
    }
    return stripped
}

function sampledTextureBindings(source) {
    const bindings = []
    const bindingRegex = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+)/g
    let match
    while ((match = bindingRegex.exec(stripWgslComments(source))) !== null) {
        const type = match[5].trim()
        if (Number(match[1]) === 0 && type.startsWith('texture_') &&
            !type.startsWith('texture_storage_')) {
            bindings.push(match[4])
        }
    }
    return bindings
}

export function validateWgslTextureBindings(repoRoot, effectId, effect) {
    const dir = effectDirectory(repoRoot, effectId)
    const errors = []

    for (const pass of effect?.passes || []) {
        if (typeof pass.program !== 'string') continue
        const file = path.join(dir, 'wgsl', `${pass.program}.wgsl`)
        if (!fs.existsSync(file)) {
            errors.push(`${pass.program}.wgsl is missing for pass ${pass.name || pass.program}`)
            continue
        }

        const inputNames = Object.keys(pass.inputs || {})
        for (const bindingName of sampledTextureBindings(fs.readFileSync(file, 'utf8'))) {
            let inputName = inputNames.includes(bindingName) ? bindingName : null
            if (!inputName && bindingName === 'inputColor' && inputNames.includes('inputTex')) {
                inputName = 'inputTex'
            }
            const positional = /^tex(\d+)$/.exec(bindingName)
            if (!inputName && positional && Number(positional[1]) < inputNames.length) {
                inputName = inputNames[Number(positional[1])]
            }

            if (!inputName) {
                const expected = inputNames.length > 0 ? inputNames.join(', ') : '(none)'
                errors.push(`${path.basename(file)} declares texture ${bindingName}, but pass ${pass.name || pass.program} inputs are ${expected}`)
            }
        }
    }

    return errors
}

export function validateFrameEvidence(frames, requireColorVariation = false) {
    const errors = []
    for (const [backend, label] of [['webgl2', 'WebGL2'], ['webgpu', 'WebGPU']]) {
        const frame = frames?.[backend]
        if (!frame) {
            errors.push(`${label} frame evidence is missing`)
        } else if (!(frame.nonzeroRgbPixels > 0)) {
            errors.push(`${label} frame is empty (zero non-black RGB pixels)`)
        } else if (!(frame.nonzeroAlphaPixels > 0)) {
            errors.push(`${label} frame is fully transparent`)
        } else if (requireColorVariation && !(frame.uniqueColors > 1)) {
            errors.push(`${label} frame is flat (fewer than two RGB colors)`)
        }
    }
    return errors
}

function integerInRange(value, minimum, maximum) {
    return Number.isInteger(value) && value >= minimum && value <= maximum
}

function validateFrameSchema(frame, label, width, height) {
    if (!frame) return [`${label} frame evidence is missing`]
    const errors = []
    const pixelCount = width * height
    if (frame.width !== width) errors.push(`${label} frame width must equal ${width}`)
    if (frame.height !== height) errors.push(`${label} frame height must equal ${height}`)
    if (!integerInRange(frame.nonzeroRgbPixels, 0, pixelCount)) {
        errors.push(`${label} nonzeroRgbPixels must be an integer from 0 to ${pixelCount}`)
    }
    if (!integerInRange(frame.nonzeroAlphaPixels, 0, pixelCount)) {
        errors.push(`${label} nonzeroAlphaPixels must be an integer from 0 to ${pixelCount}`)
    }
    if (!integerInRange(frame.uniqueColors, 0, pixelCount)) {
        errors.push(`${label} uniqueColors must be an integer from 0 to ${pixelCount}`)
    }
    return errors
}

export function validateParityAttestation(attestation, expected) {
    const errors = []
    if (attestation?.schemaVersion !== PARITY_ATTESTATION_SCHEMA_VERSION) {
        errors.push(`unsupported schema version ${attestation?.schemaVersion ?? 'missing'}`)
    }
    if (attestation?.effect !== expected.effectId) {
        errors.push(`effect is ${attestation?.effect ?? 'missing'}, expected ${expected.effectId}`)
    }
    if (attestation?.sourceHash !== expected.sourceHash) {
        errors.push('source hash is stale')
    }
    if (attestation?.caseHash !== expected.caseHash) {
        errors.push('parity case hash is stale')
    }
    if (errors.length > 0) return errors

    const [width, height] = expected.resolution || []
    if (!integerInRange(width, 1, Number.MAX_SAFE_INTEGER) ||
        !integerInRange(height, 1, Number.MAX_SAFE_INTEGER)) {
        return ['expected parity resolution is invalid']
    }
    if (expected.epsilon !== 0) {
        errors.push('parity case epsilon must be zero')
    }
    if (!Array.isArray(attestation.resolution) || attestation.resolution.length !== 2 ||
        attestation.resolution[0] !== width || attestation.resolution[1] !== height) {
        errors.push(`attestation resolution must equal ${width}x${height}`)
    }

    errors.push(...validateFrameSchema(attestation.frames?.webgl2, 'WebGL2', width, height))
    errors.push(...validateFrameSchema(attestation.frames?.webgpu, 'WebGPU', width, height))
    if (!integerInRange(attestation.execution?.webgl2TargetPasses, 1, Number.MAX_SAFE_INTEGER) ||
        !integerInRange(attestation.execution?.webgpuTargetPasses, 1, Number.MAX_SAFE_INTEGER)) {
        errors.push(`attestation must show ${expected.effectId} executed on WebGL2 and WebGPU`)
    }
    if (errors.length > 0) return errors

    errors.push(...validateFrameEvidence(attestation.frames, expected.requireColorVariation))
    if (errors.length > 0) return errors

    const parity = attestation.parity
    if (!parity) return ['pixel parity evidence is missing']
    if (parity.epsilon !== 0) errors.push('attestation parity epsilon must be zero')
    if (parity.maxDiff !== 0) errors.push('attestation maximum channel difference must be zero')
    if (parity.meanDiff !== 0) errors.push('attestation mean channel difference must be zero')
    if (parity.mismatchCount !== 0) errors.push('attestation mismatch count must be zero')
    if (parity.mismatchPercent !== 0) errors.push('attestation mismatch percent must be zero')
    return errors
}
