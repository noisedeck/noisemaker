#!/usr/bin/env node
/**
 * Generate uniformLayouts specifications from existing WGSL shaders.
 *
 * This script parses WGSL shaders that use the uniforms.data[N] pattern
 * and generates per-program uniformLayouts objects for effect definitions.
 *
 * Multi-pass effects get a uniformLayouts object with one entry per program:
 *   uniformLayouts = {
 *       programA: { time: { slot: 0, components: 'z' }, ... },
 *       programB: { resolution: { slot: 0, components: 'xy' }, ... }
 *   };
 *
 * Single-shader effects get a simple uniformLayout object for backward compatibility.
 *
 * Usage:
 *   node scripts/generate_uniform_layouts.js [effect-id]
 *   node scripts/generate_uniform_layouts.js nd/noise
 *   node scripts/generate_uniform_layouts.js nd/cellularAutomata
 *   node scripts/generate_uniform_layouts.js --all
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const EFFECTS_ROOT = path.join(__dirname, '..', 'shaders', 'effects')

/**
 * Parse a WGSL shader and extract uniform layout from uniforms.data[N] patterns.
 */
function parseUniformLayout(source) {
    const layout = {}

    // Match swizzled access patterns:
    // - varName = uniforms.data[N].xyz;
    // - let varName: type = uniforms.data[N].xyz;
    // - varName = i32(uniforms.data[N].x);
    // - varName = uniforms.data[N].xyz > 0.5; (for booleans)
    // - varName = max(1, i32(uniforms.data[N].w)); (for clamped values)
    const swizzleRegex = /(?:let\s+)?(\w+)(?:\s*:\s*[^\n=]+)?\s*=\s*(?:max\s*\([^,]+,\s*)?(?:i32\s*\(\s*)?uniforms\.data\[(\d+)\]\.([xyzw]+)/g

    let match
    while ((match = swizzleRegex.exec(source)) !== null) {
        const name = match[1]
        const slot = parseInt(match[2], 10)
        const components = match[3]

        // Skip internal names that shouldn't be exposed as uniforms
        if (name === 'uv' || name === 'st') {
            continue
        }

        layout[name] = { slot, components }
    }

    // Match full vec4 access (no swizzle):
    // - let varName: vec4<f32> = uniforms.data[N];
    const fullVec4Regex = /let\s+(\w+)\s*:\s*vec4<f32>\s*=\s*uniforms\.data\[(\d+)\]/g

    while ((match = fullVec4Regex.exec(source)) !== null) {
        const name = match[1]
        const slot = parseInt(match[2], 10)

        layout[name] = { slot, components: 'xyzw' }
    }

    return layout
}

/**
 * Find all WGSL shaders in an effect directory.
 * Returns array of { name: string, path: string }
 */
function findWGSLShaders(effectDir) {
    const wgslDir = path.join(effectDir, 'wgsl')
    if (!fs.existsSync(wgslDir)) {
        return []
    }

    return fs.readdirSync(wgslDir)
        .filter(f => f.endsWith('.wgsl'))
        .map(f => ({
            name: f.replace('.wgsl', ''),  // Program name derived from filename
            path: path.join(wgslDir, f)
        }))
}

/**
 * Process a single effect and generate per-program uniformLayouts.
 * Returns { programs: { [name]: layout }, isSingleProgram: boolean }
 */
function processEffect(effectId) {
    const [namespace, effectName] = effectId.split('/')
    const effectDir = path.join(EFFECTS_ROOT, namespace, effectName)

    if (!fs.existsSync(effectDir)) {
        console.error(`Effect not found: ${effectId}`)
        return null
    }

    const shaders = findWGSLShaders(effectDir)
    if (shaders.length === 0) {
        console.log(`No WGSL shaders found for ${effectId}`)
        return null
    }

    // Generate per-program layouts
    const programs = {}
    let hasAnyLayout = false

    for (const shader of shaders) {
        const source = fs.readFileSync(shader.path, 'utf-8')

        // Skip shaders that don't use packed uniforms
        if (!source.includes('uniforms.data[')) {
            continue
        }

        const layout = parseUniformLayout(source)
        if (Object.keys(layout).length > 0) {
            programs[shader.name] = layout
            hasAnyLayout = true
        }
    }

    if (!hasAnyLayout) {
        console.log(`No uniforms.data[] pattern found in ${effectId}`)
        return null
    }

    // Check if all programs have identical layouts (can use single uniformLayout)
    const programNames = Object.keys(programs)
    const isSingleProgram = programNames.length === 1

    // Check if layouts are identical across programs
    let areLayoutsIdentical = true
    if (programNames.length > 1) {
        const firstLayout = JSON.stringify(programs[programNames[0]], Object.keys(programs[programNames[0]]).sort())
        for (let i = 1; i < programNames.length; i++) {
            const thisLayout = JSON.stringify(programs[programNames[i]], Object.keys(programs[programNames[i]]).sort())
            if (thisLayout !== firstLayout) {
                areLayoutsIdentical = false
                break
            }
        }
    }

    return {
        programs,
        isSingleProgram,
        areLayoutsIdentical,
        effectId
    }
}

/**
 * Find all effects in the effects directory.
 */
function findAllEffects() {
    const effects = []

    for (const namespace of fs.readdirSync(EFFECTS_ROOT)) {
        const namespaceDir = path.join(EFFECTS_ROOT, namespace)
        if (!fs.statSync(namespaceDir).isDirectory()) continue

        for (const effectName of fs.readdirSync(namespaceDir)) {
            const effectDir = path.join(namespaceDir, effectName)
            if (!fs.statSync(effectDir).isDirectory()) continue

            // Check if it has a definition.js
            if (fs.existsSync(path.join(effectDir, 'definition.js'))) {
                effects.push(`${namespace}/${effectName}`)
            }
        }
    }

    return effects
}

/**
 * Format a single layout as JavaScript object entries.
 */
function formatLayoutEntries(layout, indent = '        ') {
    const entries = Object.entries(layout)
        .sort((a, b) => {
            // Sort by slot, then by component
            if (a[1].slot !== b[1].slot) return a[1].slot - b[1].slot
            const compOrder = { x: 0, y: 1, z: 2, w: 3 }
            return compOrder[a[1].components[0]] - compOrder[b[1].components[0]]
        })

    return entries.map(([name, spec]) => {
        return `${indent}${name}: { slot: ${spec.slot}, components: '${spec.components}' }`
    }).join(',\n')
}

/**
 * Format layouts for output - chooses between single layout and per-program layouts.
 */
function formatLayouts(result) {
    const { programs, isSingleProgram, areLayoutsIdentical } = result
    const programNames = Object.keys(programs)

    // Single program or identical layouts: use simple uniformLayout
    if (isSingleProgram || areLayoutsIdentical) {
        const layout = programs[programNames[0]]
        const entries = formatLayoutEntries(layout)
        return `  // WGSL uniform packing layout\n  uniformLayout = {\n${entries}\n  };`
    }

    // Multiple programs with different layouts: use uniformLayouts
    const programSections = programNames.map(name => {
        const entries = formatLayoutEntries(programs[name], '            ')
        return `        ${name}: {\n${entries}\n        }`
    }).join(',\n')

    return `  // WGSL uniform packing layouts (per-program for multi-pass effects)\n  uniformLayouts = {\n${programSections}\n  };`
}

// Main
const args = process.argv.slice(2)

if (args.length === 0) {
    console.log('Usage:')
    console.log('  node scripts/generate_uniform_layouts.js <effect-id>')
    console.log('  node scripts/generate_uniform_layouts.js nd/noise')
    console.log('  node scripts/generate_uniform_layouts.js nd/cellularAutomata')
    console.log('  node scripts/generate_uniform_layouts.js --all')
    process.exit(1)
}

if (args[0] === '--all') {
    const effects = findAllEffects()
    let singleCount = 0
    let multiCount = 0

    for (const effectId of effects) {
        const result = processEffect(effectId)
        if (result && Object.keys(result.programs).length > 0) {
            console.log(`\n// ${effectId}`)
            console.log(formatLayouts(result))

            if (result.isSingleProgram || result.areLayoutsIdentical) {
                singleCount++
            } else {
                multiCount++
            }
        }
    }

    console.log(`\nGenerated layouts for ${singleCount + multiCount} effects`)
    console.log(`  ${singleCount} single-layout effects`)
    console.log(`  ${multiCount} multi-layout effects`)
} else {
    const effectId = args[0]
    const result = processEffect(effectId)

    if (result && Object.keys(result.programs).length > 0) {
        console.log(`\n// ${effectId}`)
        console.log(formatLayouts(result))

        // Show individual program details
        const programNames = Object.keys(result.programs)
        if (programNames.length > 1) {
            console.log(`\n// Programs: ${programNames.join(', ')}`)
            if (result.areLayoutsIdentical) {
                console.log('// Note: All programs have identical layouts, using single uniformLayout')
            }
        }
    } else {
        console.log('No layout generated')
    }
}
