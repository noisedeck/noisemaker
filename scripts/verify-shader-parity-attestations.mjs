#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
    affectedParityEffectIds,
    computeFileHash,
    computeParitySourceHash,
    effectDirectory,
    registeredParityEffectIds,
    validateParityAttestation,
    validateParityCase,
    validateWgslTextureBindings,
} from './lib/shader-parity-attestation.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function argumentValue(name) {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : null
}

function git(args, required = true) {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    if (required && result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)
    }
    return result.status === 0 ? result.stdout.trim() : null
}

function resolveBase() {
    const requested = process.env.SHADER_PARITY_BASE?.trim()
    if (requested && !/^0+$/.test(requested)) {
        if (git(['cat-file', '-e', `${requested}^{commit}`], false) === null) {
            throw new Error(`SHADER_PARITY_BASE commit is unavailable: ${requested}`)
        }
        return requested
    }
    return process.env.CI ? git(['rev-parse', 'HEAD^'], false) : null
}

function changedFiles() {
    const explicit = argumentValue('--files')
    if (explicit) return explicit.split(',').map((file) => file.trim()).filter(Boolean)

    const base = resolveBase()
    const tracked = base
        ? git(['diff', '--name-only', base, 'HEAD', '--', 'shaders/effects']).split('\n').filter(Boolean)
        : process.env.CI
            ? git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD', '--', 'shaders/effects']).split('\n').filter(Boolean)
            : git(['diff', '--name-only', 'HEAD', '--', 'shaders/effects']).split('\n').filter(Boolean)
    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'shaders/effects'])
        .split('\n').filter(Boolean)
    return [...new Set([...tracked, ...untracked])]
}

const verifyAll = /^(1|true)$/i.test(process.env.SHADER_PARITY_ALL || '')
const effectIds = verifyAll
    ? registeredParityEffectIds(repoRoot)
    : affectedParityEffectIds(repoRoot, changedFiles())
if (effectIds.length === 0) {
    console.log('No changed dual-language shader sources require parity evidence')
    process.exit(0)
}

let failed = false
for (const effectId of effectIds) {
    const dir = effectDirectory(repoRoot, effectId)
    if (!fs.existsSync(dir)) {
        console.log(`${effectId}: effect deleted; no parity evidence required`)
        continue
    }

    const casePath = path.join(dir, 'parity-case.json')
    const attestationPath = path.join(dir, 'parity-attestation.json')
    const missing = [casePath, attestationPath].filter((file) => !fs.existsSync(file))
    if (missing.length > 0) {
        failed = true
        console.error(`${effectId}: missing ${missing.map((file) => path.basename(file)).join(' and ')}`)
        continue
    }

    try {
        const parityCase = JSON.parse(fs.readFileSync(casePath, 'utf8'))
        const attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'))
        const caseErrors = validateParityCase(parityCase, effectId)
        if (caseErrors.length > 0) throw new Error(caseErrors.join('; '))
        const sourceHash = computeParitySourceHash(repoRoot, parityCase)
        const errors = validateParityAttestation(attestation, {
            effectId,
            sourceHash,
            caseHash: computeFileHash(casePath),
            resolution: parityCase.resolution,
            epsilon: parityCase.epsilon,
            requireColorVariation: parityCase.requireColorVariation === true,
        })
        const definitionUrl = pathToFileURL(path.join(dir, 'definition.js'))
        definitionUrl.searchParams.set('paritySource', sourceHash)
        const definition = (await import(definitionUrl.href)).default
        errors.push(...validateWgslTextureBindings(repoRoot, effectId, definition))
        if (errors.length > 0) {
            failed = true
            console.error(`${effectId}: ${errors.join('; ')}`)
        } else {
            console.log(`${effectId}: parity evidence is current`)
        }
    } catch (error) {
        failed = true
        console.error(`${effectId}: ${error.message}`)
    }
}

if (failed) process.exit(1)
