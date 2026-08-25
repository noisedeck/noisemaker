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

    // Stage 2b: A scene volume() can only read a 64-cube atlas.
    const volumeSizeErrors = checkSceneVolumeAtlasSizes(sceneIR, passes)
    if (volumeSizeErrors.length > 0) {
        throw {
            code: 'ERR_VOLUME_ATLAS_SIZE',
            errors: volumeSizeErrors
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
    // Callers that have already compiled the source — CanvasRenderer.compile()
    // builds a graph to detect scene programs — pass it in rather than paying
    // for a second parse, validate, expand and allocation pass on every edit.
    const graph = options.graph ?? compileGraph(source, options)
    const pipeline = await createPipeline(graph, options)
    return pipeline
}

/**
 * Slice size of the vol0..vol7 global atlases.
 *
 * Hardwired in three places that must agree: `volumeSliceSize` in pipeline.js
 * createSurfaces (which allocates them 64 x 4096), VOLUME_ATLAS_SIZE in
 * volume-renderer.js (which binds u_volumeSize), and the `y + z * u_volumeSize`
 * decode in volume-shaders.js.
 */
const VOLUME_ATLAS_SIZE = 64

/**
 * Reject a scene volume() whose atlas is produced at a size it cannot decode.
 *
 * write3d into a volN global is a plain 2D blit (expander.js
 * `_write3d_vol_blit`), so a producer chain at, say, volumeSize x32 emits a
 * 32 x 1024 atlas that is STRETCHED into the 64 x 4096 global. The marcher then
 * decodes it at the 64-slice stride and reads slices straddling the stretched
 * boundaries — a sheared volume that still renders something plausible and
 * signals nothing. Measured: 75% duplicate rows, IoU 0.935.
 *
 * Both halves are known here, so it is a compile error rather than a surprise.
 * The producer is reached by correlating the blit's source texture back to the
 * pass that writes it; the chain's resolved volumeSize rides on that pass's
 * uniforms (the expander propagates it through `pipelineUniforms`).
 *
 * KNOWN GAP — the runtime path is not covered. The volN globals are created
 * once by pipeline.createSurfaces() and never resized, but a runtime volumeSize
 * edit (canvas.applyStepParameterValues / applyParameterValues,
 * ProgramState._applyToPipeline) patches pass uniforms in place and recreates
 * only the node-local atlases. A program that compiles clean at x64 and is then
 * dragged to x32 by a slider reaches the same sheared state without passing
 * through here again. Closing that needs a guard in the runtime update path,
 * which is outside this module.
 * @param {object|null} sceneIR - Scene IR, or null for a non-scene program
 * @param {Array} passes - Expanded render passes
 * @returns {Array<{message: string, surface: string, volumeSize: number}>} One entry per offending surface
 */
function checkSceneVolumeAtlasSizes(sceneIR, passes) {
    const errors = []
    if (!sceneIR?.nodes) return errors

    // Only the surfaces a volume() node actually marches are constrained;
    // render3d reads the same globals with its own u_volumeSize and is fine.
    const marched = new Set()
    for (const node of sceneIR.nodes) {
        if (node.type === 'volume' && node.surface) marched.add(node.surface)
    }
    if (marched.size === 0) return errors

    // Texture id -> the pass that produces it, so a blit's source resolves to
    // the effect pass whose uniforms carry the chain's resolved volumeSize.
    const producerOf = new Map()
    for (const pass of passes) {
        for (const texId of Object.values(pass.outputs || {})) {
            if (!producerOf.has(texId)) producerOf.set(texId, pass)
        }
    }

    for (const surface of [...marched].sort()) {
        const blit = passes.find(p => p.outputs?.color === `global_${surface}`)
        // No write3d into this surface: nothing was produced at any size, which
        // is an empty volume, not a decode mismatch.
        if (!blit) continue

        const producer = producerOf.get(blit.inputs?.src)
        const volumeSize = producer?.uniforms?.volumeSize
        // A producer that declares no volumeSize is not making a claim about
        // the atlas layout, so there is nothing to contradict.
        if (typeof volumeSize !== 'number') continue
        if (volumeSize === VOLUME_ATLAS_SIZE) continue

        errors.push({
            surface,
            volumeSize,
            message:
                `volume(${surface}) marches a ${VOLUME_ATLAS_SIZE}-cube atlas, but ${surface} is ` +
                `written by a chain at volumeSize x${volumeSize}. The write3d blit would stretch ` +
                `${volumeSize}x${volumeSize * volumeSize} into ${VOLUME_ATLAS_SIZE}x` +
                `${VOLUME_ATLAS_SIZE * VOLUME_ATLAS_SIZE} and the marcher would decode the result ` +
                `at the wrong slice stride. Set volumeSize: x${VOLUME_ATLAS_SIZE} on the chain ` +
                `writing ${surface}.`
        })
    }
    return errors
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
    if ((err.code === 'ERR_EXPANSION_FAILED' || err.code === 'ERR_VOLUME_ATLAS_SIZE')
        && Array.isArray(err.errors)) {
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
