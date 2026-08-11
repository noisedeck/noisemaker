/**
 * Noisemaker Rendering Pipeline - Main Export
 *
 * This is the main entry point for the Noisemaker Rendering Pipeline.
 * It exports all the key APIs for compilation, execution, and effect management.
 */

// Language & Compiler
export { lex, parse, validate, compile, unparse, applyParameterUpdates, formatValue, unparseCall, replaceEffect, listSteps, getCompatibleReplacements } from './lang/index.js'
export { registerOp } from './lang/ops.js'
export { registerStarterOps, registerValidatorHook } from './lang/validator.js'
export { mergeIntoEnums } from './lang/enums.js'
export { default as stdEnums } from './lang/enums.js'

// Runtime Core
import { Effect, groupGlobalsByCategory, getUniformCategory, getCategories, DEFAULT_CATEGORY } from './runtime/effect.js'
export { Effect, groupGlobalsByCategory, getUniformCategory, getCategories, DEFAULT_CATEGORY }
export { registerEffect, unregisterEffect, getEffect, getAllEffects } from './runtime/registry.js'
export { expand } from './runtime/expander.js'
export { analyzeLiveness, allocateResources } from './runtime/resources.js'

// Tags & Namespaces
export {
    TAG_DEFINITIONS,
    NAMESPACE_DESCRIPTIONS,
    VALID_TAGS,
    VALID_NAMESPACES,
    BUILTIN_NAMESPACE,
    IO_FUNCTIONS,
    isValidTag,
    isValidNamespace,
    isIOFunction,
    getTagDefinition,
    getNamespaceDescription,
    validateTags,
    registerNamespace,
    unregisterNamespace
} from './runtime/tags.js'

// Backend & Pipeline
export { Backend } from './runtime/backend.js'
export { WebGL2Backend } from './runtime/backends/webgl2.js'
export { WebGPUBackend } from './runtime/backends/webgpu.js'
export { CanvasSink, SinkManager } from './runtime/sink.js'
export { FrameExportQueue } from './runtime/frame-export.js'
import { Pipeline, createPipeline } from './runtime/pipeline.js'
export { Pipeline, createPipeline }

// External Input (MIDI & Audio)
export { MidiState, MidiChannelState, AudioState, MidiInputManager, AudioInputManager, ExternalInputManager } from './runtime/external-input.js'

// Integration
import { compileGraph, createRuntime, recompile } from './runtime/compiler.js'
export { compileGraph, createRuntime, recompile }

// Renderer
export {
    CanvasRenderer,
    cloneParamValue,
    isValidIdentifier,
    sanitizeEnumName,
    hasTexSurfaceParam,
    hasExplicitTexParam,
    getVolGeoParams,
    needsInputTex3d,
    is3dGenerator,
    is3dProcessor,
    isStarterEffect
} from './renderer/canvas.js'

// ProgramState & UI Utilities
// Re-export for downstream use (noisedeck, shade, etc.)
export { ProgramState } from '../../demo/shaders/lib/program-state.js'
export { Emitter } from '../../demo/shaders/lib/emitter.js'
export { extractEffectsFromDsl } from '../../demo/shaders/lib/dsl-utils.js'

/**
 * Convenience function to create a complete rendering environment
 * @param {HTMLCanvasElement} canvas - Canvas element to render to
 * @param {string} source - DSL source code
 * @param {object} options - Options { preferWebGPU: boolean }
 * @returns {Promise<Pipeline>} Initialized pipeline
 */
export async function createNoisemakerPipeline(canvas, source, options = {}) {
    const width = canvas.width || 800
    const height = canvas.height || 600

    return createRuntime(source, {
        canvas,
        width,
        height,
        preferWebGPU: options.preferWebGPU ?? true
    })
}

/**
 * Version information
 */
export const VERSION = '0.1.0'
export const PHASE = 4

/**
 * Default export for convenience
 */
export default {
    VERSION,
    PHASE,
    createNoisemakerPipeline,
    createRuntime,
    createPipeline,
    compileGraph,
    Pipeline,
    Effect
}
