/**
 * Full Integration Module
 * Ties together compiler, expander, resources, and pipeline executor
 */

import { compile } from '../lang/index.js'
import { expand } from './expander.js'
import { allocateResources } from './resources.js'
import { createPipeline } from './pipeline.js'
import { compileScene } from '../rendering/scene-compiler.js'

/**
 * Compile DSL source into an executable graph
 * @param {string} source - DSL source code
 * @param {object} options - Compilation options
 * @param {object} [options.shaderOverrides] - Per-step shader overrides, keyed by step index
 * @returns {object} Compiled graph ready for execution
 */
export function compileGraph(source, options = {}) {
    // Stage 1: Parse and validate DSL
    const compilationResult = compile(source)

    if (compilationResult.diagnostics?.length > 0) {
        const warnings = compilationResult.diagnostics.filter(d => d.severity === 'warning')
        for (const w of warnings) {
            console.warn(`[noisemaker] ${w.code}: ${w.message}`)
        }
        const errors = compilationResult.diagnostics.filter(d => d.severity === 'error')
        if (errors.length > 0) {
            throw {
                code: 'ERR_COMPILATION_FAILED',
                diagnostics: compilationResult.diagnostics
            }
        }
    }

    // Stage 1b: Compile any scene() program into scene IR. Null for ordinary
    // effect programs, which are unaffected.
    const sceneIR = compileScene(compilationResult)

    // Stage 2: Expand logical graph into render passes
    const { passes, errors: expandErrors, programs, textureSpecs, renderSurface } = expand(
        compilationResult,
        { shaderOverrides: options.shaderOverrides }
    )

    if (expandErrors?.length > 0) {
        throw {
            code: 'ERR_EXPANSION_FAILED',
            errors: expandErrors
        }
    }

    // Stage 3: Allocate resources (texture pooling)
    const allocations = allocateResources(passes)

    // Stage 4: Build execution graph
    const graph = {
        id: hashSource(source),
        source,
        passes,
        programs,
        allocations,
        textures: extractTextureSpecs(passes, options, textureSpecs),
        renderSurface, // Which surface to present to screen (e.g., 'o0', 'o2')
        _isScene: sceneIR !== null,
        sceneIR,
        compiledAt: Date.now()
    }

    return graph
}

/**
 * Create a complete runtime from DSL source
 * @param {string} source - DSL source code
 * @param {object} options - Runtime options { canvas, width, height, preferWebGPU }
 * @returns {Promise<Pipeline>} Initialized pipeline ready to render
 */
export async function createRuntime(source, options = {}) {
    const graph = compileGraph(source, options)
    const pipeline = await createPipeline(graph, options)
    return pipeline
}

/**
 * Extract texture specifications from passes
 * @param {Array} passes - Render passes
 * @param {object} options - Runtime options with width/height
 * @param {object} textureSpecs - Effect-defined texture specs from expander
 */
function extractTextureSpecs(passes, options, textureSpecs = {}) {
    const textures = new Map()

    // First, add all effect-defined texture specs (including global_ textures)
    // This ensures custom dimensions are available for pipeline surface creation
    for (const [texId, effectSpec] of Object.entries(textureSpecs)) {
        const spec = {
            // Preserve original dimension specs - use 'screen' as default for dynamic resizing
            width: effectSpec.width || 'screen',
            height: effectSpec.height || 'screen',
            format: effectSpec.format || 'rgba16f',
            // copyDst is required so the chain-handoff path can target this texture
            // via copyTextureToTexture, and so updateTextureFromSource /
            // copyExternalImageToTexture can write into it without Dawn rejecting
            // with "Destination texture needs to have CopyDst usage".
            usage: ['render', 'sample', 'copySrc', 'copyDst']
        }
        // Handle 3D textures
        if (effectSpec.is3D) {
            spec.depth = effectSpec.depth || effectSpec.width || 64
            spec.is3D = true
            spec.usage = ['storage', 'sample', 'copySrc', 'copyDst']
        }
        textures.set(texId, spec)
    }

    // Then collect output textures from passes that aren't already defined
    for (const pass of passes) {
        if (pass.outputs) {
            for (const texId of Object.values(pass.outputs)) {
                // Skip global_ textures (handled via surfaces) and already-defined textures
                if (texId.startsWith('global_')) continue
                if (textures.has(texId)) continue

                // Use 'screen' to enable dynamic resizing
                textures.set(texId, {
                    width: 'screen',
                    height: 'screen',
                    format: 'rgba16f',
                    usage: ['render', 'sample', 'copySrc', 'copyDst']
                })
            }
        }
    }

    return textures
}

/**
 * Simple hash function for source code
 */
function hashSource(source) {
    let hash = 0
    for (let i = 0; i < source.length; i++) {
        const char = source.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash // Convert to 32bit integer
    }
    return hash.toString(36)
}

/**
 * Format a compilation error object as readable text.
 */
function formatError(err) {
    if (err.code === 'ERR_COMPILATION_FAILED' && Array.isArray(err.diagnostics)) {
        return err.diagnostics
            .filter(d => d.severity === 'error')
            .map(d => {
                let msg = d.message || 'Unknown error'
                if (d.location) msg += ` (line ${d.location.line}, col ${d.location.column})`
                return msg
            })
            .join('; ') || 'Unknown compilation error'
    }
    if (err.code === 'ERR_EXPANSION_FAILED' && Array.isArray(err.errors)) {
        return err.errors.map(e => e.message || String(e)).join('; ')
    }
    if (err.code === 'ERR_SHADER_COMPILE') {
        return err.detail || 'Shader compile error'
    }
    return err.message || err.detail || (typeof err === 'object' ? JSON.stringify(err) : String(err))
}

/**
 * Hot reload support - recompile and swap graph
 * @param {Pipeline} pipeline - Existing pipeline
 * @param {string} newSource - New DSL source
 * @param {object} [options] - Recompilation options
 * @param {object} [options.shaderOverrides] - Per-step shader overrides
 * @returns {object} New graph (pipeline will update on next frame)
 */
export function recompile(pipeline, newSource, options = {}) {
    try {
        const newGraph = compileGraph(newSource, {
            width: pipeline.width,
            height: pipeline.height,
            shaderOverrides: options.shaderOverrides
        })

        // Swap graph on pipeline
        pipeline.graph = newGraph

        // Recreate global surfaces and textures to reflect new graph requirements
        pipeline.createSurfaces()

        // Recreate textures with default uniforms from passes
        // This ensures parameter-based texture sizing (e.g., stateSize) works correctly
        const defaultUniforms = pipeline.collectDefaultUniforms()
        pipeline.recreateTextures(defaultUniforms)

        // Re-render CPU-generated overlay textures (asyncInit effects such as
        // filter/fibers, filter/scratches, filter/strayHair). recreateTextures
        // just allocated their overlay textures empty, and initAsyncEffects
        // otherwise only runs from resize() — so a hot-recompiled program
        // containing an asyncInit effect rendered a blank overlay (the effect
        // silently passed its input through unchanged).
        pipeline.initAsyncEffects()

        return newGraph
    } catch (error) {
        console.error('Recompilation failed:', formatError(error))
        return null
    }
}
