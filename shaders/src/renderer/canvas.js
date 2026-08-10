/**
 * CanvasRenderer - Reusable shader rendering pipeline manager
 *
 * Handles the rendering loop, pipeline lifecycle, lazy effect loading,
 * and all rendering-related state. Designed to be vendored and embedded
 * independently of the demo UI.
 *
 * @example
 * const renderer = new CanvasRenderer({
 *     canvas: document.getElementById('canvas'),
 *     width: 1024,
 *     height: 1024,
 *     basePath: '../../shaders',
 *     preferWebGPU: false
 * });
 *
 * await renderer.loadManifest();
 * await renderer.compile('search synth\nnoise().write(o0)\nrender(o0)');
 * renderer.start();
 */

import { registerOp } from '../lang/ops.js'
import { registerParamAliases } from '../lang/paramAliases.js'
import { registerEffectAlias } from '../lang/effectAliases.js'
import { registerStarterOps } from '../lang/validator.js'
import { createRuntime, recompile, compileGraph } from '../runtime/compiler.js'
import { registerEffect, getEffect } from '../runtime/registry.js'
import { mergeIntoEnums } from '../lang/enums.js'
import { stdEnums } from '../lang/std_enums.js'
import { MidiState, AudioState, MidiInputManager, AudioInputManager, ExternalInputManager } from '../runtime/external-input.js'
import { expandPalette } from '../runtime/palette-expansion.js'
import { SCENE_COLOR_TEXTURE } from '../rendering/scene-compiler.js'

// Scene modules depend on gl-matrix, a bare module specifier that only
// resolves where an import map provides it. Loading them lazily keeps
// ordinary 2D effect programs — and the pages that host them — free of that
// requirement; they are pulled in only when a scene() program compiles.
let sceneModules = null
async function loadSceneModules() {
    if (!sceneModules) {
        const [tree, renderer, clock, bindings] = await Promise.all([
            import('../scene/tree.js'),
            import('../rendering/scene-renderer.js'),
            import('../scene/clock.js'),
            import('../scene/bindings.js')
        ])
        sceneModules = {
            SceneTree: tree.SceneTree,
            SceneRenderer: renderer.SceneRenderer,
            Clock: clock.Clock,
            collectBindings: bindings.collectBindings,
            evaluateBindings: bindings.evaluateBindings
        }
    }
    return sceneModules
}

// Re-export for convenience
export { MidiState, AudioState, MidiInputManager, AudioInputManager, ExternalInputManager }

/**
 * Check if a value represents an automation-controlled parameter
 * (oscillator, midi, audio) that should not be overwritten by UI values.
 */
function isAutomationControlled(value) {
    if (!value || typeof value !== 'object') return false
    if (value._varRef) return true
    const type = value.type || value._ast?.type
    return type === 'Oscillator' || type === 'Midi' || type === 'Audio'
}

// Known 3D generator effects (self-initialize volumes)
const KNOWN_3D_GENERATORS = ['noise3d', 'cell3d', 'shape3d', 'fractal3d', 'flythrough3d', 'cellularAutomata3d', 'reactionDiffusion3d']

// Known 3D processor effects (modify volumes, need inputTex3d)
const KNOWN_3D_PROCESSORS = ['flow3d', 'palette3d', 'render3d', 'renderLit3d', 'renderCubemap3d', 'renderCubemapSurface']

/**
 * Deep clone a parameter value
 * @param {*} value - Value to clone
 * @returns {*} Cloned value
 */
export function cloneParamValue(value) {
    if (Array.isArray(value)) {
        return value.slice()
    }
    if (value && typeof value === 'object') {
        try {
            return JSON.parse(JSON.stringify(value))
        } catch (_err) {
            return value
        }
    }
    return value
}

/**
 * Check if a name is a valid DSL identifier (can be used unquoted)
 * @param {string} name - Name to check
 * @returns {boolean}
 */
export function isValidIdentifier(name) {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
}

/**
 * Sanitize a name to be a valid identifier
 * @param {string} name - Name to sanitize
 * @returns {string|null} Sanitized name or null if not possible
 */
export function sanitizeEnumName(name) {
    // Convert spaces to camelCase: "Cell Scale" -> "CellScale"
    let result = name.replace(/\s+(.)/g, (_, c) => c.toUpperCase()).replace(/\s+/g, '')
    // Remove any invalid characters
    result = result.replace(/[^a-zA-Z0-9_]/g, '')
    // Check if result is a valid identifier
    if (!isValidIdentifier(result)) {
        return null
    }
    return result
}

/**
 * Check if effect has a 'tex' surface parameter (mixer-type effects)
 * @param {object} effect - Effect object
 * @returns {boolean}
 */
export function hasTexSurfaceParam(effect) {
    const texSpec = effect?.instance?.globals?.tex
    return texSpec?.type === 'surface'
}

/**
 * Check if effect needs inputTex3d (3D consumer effects)
 * @param {object} effect - Effect object
 * @returns {boolean}
 */
export function needsInputTex3d(effect) {
    if (!effect?.instance) return false
    const passes = effect.instance.passes || []
    return passes.some(pass =>
        pass.inputs && Object.values(pass.inputs).includes('inputTex3d')
    )
}

/**
 * Check if effect is a 3D generator
 * @param {object} effect - Effect object
 * @returns {boolean}
 */
export function is3dGenerator(effect) {
    if (!effect || !effect.instance) return false
    const func = effect.instance.func
    return effect.instance.outputTex3d && KNOWN_3D_GENERATORS.includes(func)
}

/**
 * Check if effect is a 3D processor
 * @param {object} effect - Effect object
 * @returns {boolean}
 */
export function is3dProcessor(effect) {
    if (!effect || !effect.instance) return false
    const func = effect.instance.func
    return effect.instance.outputTex3d && KNOWN_3D_PROCESSORS.includes(func)
}

/**
 * Check if effect has a tex surface param that does NOT default to inputTex
 * (i.e., requires explicit surface binding, not pipeline chaining)
 * @param {object} effect - Effect object
 * @returns {boolean}
 */
export function hasExplicitTexParam(effect) {
    const texSpec = effect?.instance?.globals?.tex
    return texSpec?.type === 'surface' && texSpec.default !== 'inputTex'
}

/**
 * Check if effect has volume and geometry type parameters
 * @param {object} effect - Effect object
 * @returns {{volParam: string|null, geoParam: string|null}} Parameter names or null
 */
export function getVolGeoParams(effect) {
    if (!effect?.instance?.globals) {
        return { volParam: null, geoParam: null }
    }
    let volParam = null
    let geoParam = null
    for (const [key, spec] of Object.entries(effect.instance.globals)) {
        if (spec.type === 'volume' && !volParam) {
            volParam = key
        }
        if (spec.type === 'geometry' && !geoParam) {
            geoParam = key
        }
    }
    return { volParam, geoParam }
}

/**
 * Check if effect is a starter (doesn't need pipeline input)
 * @param {object} effect - Effect object
 * @returns {boolean}
 */
export function isStarterEffect(effect) {
    if (!effect.instance) return false

    const passes = effect.instance.passes || []
    if (passes.length === 0) return true

    const pipelineInputs = new Set([
        'inputTex', 'inputTex3d',
        'o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'
    ])

    return !passes.some(pass =>
        pass.inputs && Object.values(pass.inputs).some(val => pipelineInputs.has(val))
    )
}

/**
 * CanvasRenderer class - manages shader rendering pipeline
 */
export class CanvasRenderer {
    /**
     * Create a new CanvasRenderer
     * @param {object} options - Configuration options
     * @param {HTMLCanvasElement} options.canvas - Target canvas element
     * @param {HTMLElement} [options.canvasContainer] - Container element for canvas reset
     * @param {number} [options.width=1024] - Render width
     * @param {number} [options.height=1024] - Render height
     * @param {string} [options.basePath='../../shaders'] - Base path for shader assets
     * @param {boolean} [options.preferWebGPU=false] - Use WebGPU backend
     * @param {boolean} [options.useBundles=false] - Load effects from pre-built bundles
     * @param {string} [options.bundlePath='../../dist/effects'] - Base path for effect bundles
     * @param {function} [options.onFrame] - Callback after each frame (receives frameCount)
     * @param {function} [options.onFPS] - Callback when FPS updates (receives fps value)
     * @param {function} [options.onError] - Callback on render error
     * @param {function} [options.onLoadingStart] - Callback when loading starts
     * @param {function} [options.onLoadingProgress] - Callback for loading progress
     * @param {function} [options.onLoadingEnd] - Callback when loading ends
     * @param {function} [options.onContextLost] - Callback when WebGL context is lost
     * @param {function} [options.onContextRestored] - Callback when WebGL context is restored and pipeline rebuilt
     */
    constructor(options = {}) {
        this._canvas = options.canvas
        this._canvasContainer = options.canvasContainer || null
        this._width = options.width || 1024
        this._height = options.height || 1024
        this._basePath = options.basePath || '../../shaders'
        this._preferWebGPU = options.preferWebGPU || false

        // Bundle loading mode
        this._useBundles = options.useBundles || false
        this._bundlePath = options.bundlePath || '../../dist/effects'

        // Callbacks
        this._onFrame = options.onFrame || null
        this._onFPS = options.onFPS || null
        this._onError = options.onError || null
        this._onLoadingStart = options.onLoadingStart || null
        this._onLoadingProgress = options.onLoadingProgress || null
        this._onLoadingEnd = options.onLoadingEnd || null
        this._onContextLost = options.onContextLost || null
        this._onContextRestored = options.onContextRestored || null

        // Pipeline state
        this._pipeline = null
        this._currentDsl = ''
        this._currentEffect = null
        this._uniformBindings = new Map()

        // Animation loop state
        this._animationFrameId = null
        this._loopDuration = 10
        this._lastFrameTime = performance.now()
        this._loopStartTime = performance.now()
        this._isRunning = false

        // Frame counting and FPS measurement
        this._frameCount = 0
        this._fpsFrameCount = 0
        this._fpsLastUpdateTime = performance.now()
        this._currentFPS = 0

        this._lastPassCount = 0

        // Lazy loading infrastructure
        this._manifest = {}
        this._loadedEffects = new Map()
        this._effectLoadingPromises = new Map()

        // Effect-string localization (opt-in; English unless a locale is set)
        this._locale = null
        this._strings = {}

        // Enum registry (shared with lang system)
        this._enums = {}

        // External input state (MIDI and Audio)
        this._midiState = null
        this._audioState = null

        // Cached mesh data for re-upload after backend switch
        // Map<meshId, {positionData, normalData, uvData, width, height, vertexCount}>
        this._meshCache = new Map()

        // Scene rendering state (for scene() DSL programs)
        this._isScene = false
        this._sceneTree = null
        this._sceneRenderer = null
        this._sceneBackend = null
        this._clock = null

        // Bound render loop for proper `this` context
        this._boundRenderLoop = this._renderLoop.bind(this)

        // Context loss state
        this._isContextLost = false
        this._wasRunningBeforeContextLoss = false
        this._lifecycleGeneration = 0
        this._lastBackendInvalidationGeneration = -1

        // Set up canvas dimension observation for auto-resize
        this._setupCanvasObserver()

        // Set up WebGL context loss/restore listeners
        this._setupContextLossHandlers()
    }

    /**
     * Set up observation of canvas dimension changes.
     * Intercepts canvas.width and canvas.height setters to detect resizing.
     * @private
     */
    _setupCanvasObserver() {
        if (!this._canvas) return

        const self = this
        const canvas = this._canvas

        // Store original property descriptors from prototype
        const widthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')
        const heightDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')

        // Debounce resize to handle width+height being set together
        let resizeScheduled = false

        function scheduleResize() {
            if (resizeScheduled) return
            resizeScheduled = true
            // Use microtask to batch width+height changes set in same synchronous block
            queueMicrotask(() => {
                resizeScheduled = false
                self._onCanvasDimensionsChanged()
            })
        }

        // Define intercepting properties on this specific canvas instance
        function interceptDimension(prop, desc) {
            Object.defineProperty(canvas, prop, {
                get() { return desc.get.call(this) },
                set(value) {
                    const old = desc.get.call(this)
                    desc.set.call(this, value)
                    if (desc.get.call(this) !== old) {
                        scheduleResize()
                    }
                },
                configurable: true,
                enumerable: true
            })
        }

        interceptDimension('width', widthDesc)
        interceptDimension('height', heightDesc)
    }

    /**
     * Called when canvas dimensions change.
     * Updates the pipeline to match new dimensions.
     * @private
     */
    _onCanvasDimensionsChanged() {
        const newWidth = this._canvas.width
        const newHeight = this._canvas.height

        // Only resize if dimensions actually changed from what we have
        if (newWidth !== this._width || newHeight !== this._height) {
            this.resize(newWidth, newHeight)
        }
    }

    /**
     * Set up WebGL context loss and restore event handlers.
     * On context loss: stops the render loop and notifies the host.
     * On context restore: recompiles the current DSL and resumes rendering.
     * @private
     */
    _setupContextLossHandlers() {
        if (!this._canvas) return

        this._boundContextLost = (e) => {
            e.preventDefault() // Signal browser we will handle restore
            this._isContextLost = true
            this._wasRunningBeforeContextLoss = this._isRunning

            if (this._pipeline?.backend) {
                this._pipeline.backend.isContextLost = true
            }

            this.stop()

            console.warn('[Canvas] WebGL context lost')
            if (this._onContextLost) {
                this._onContextLost()
            }
        }

        this._boundContextRestored = async () => {
            console.log('[Canvas] WebGL context restored, rebuilding pipeline...')

            const restorationGeneration = this._advanceLifecycle({ backendLost: true })

            // The restored context made resources owned by the old backend
            // invalid. Close its sinks and cancel CPU work without issuing GPU
            // cleanup calls against that dead backend.
            const deadPipeline = this._pipeline
            this._pipeline = null
            this._uniformBindings = new Map()
            try {
                deadPipeline?.dispose?.({ backendLost: true })
            } catch (err) {
                console.warn('Failed to dispose context-lost pipeline', err)
            }

            this._isContextLost = false

            // Recompile current DSL if we had one
            if (this._currentDsl) {
                try {
                    const restoredPipeline = await this.compile(this._currentDsl)
                    if (!this._isLifecycleCurrent(restorationGeneration) ||
                        !restoredPipeline || this._pipeline !== restoredPipeline) {
                        return
                    }
                    await this._reuploadCachedMeshes()
                    if (!this._isLifecycleCurrent(restorationGeneration) ||
                        this._pipeline !== restoredPipeline) {
                        return
                    }

                    if (this._wasRunningBeforeContextLoss) {
                        this.start()
                    }

                    console.log('[Canvas] Pipeline rebuilt successfully after context restore')
                } catch (err) {
                    if (!this._isLifecycleCurrent(restorationGeneration)) return
                    console.error(`[Canvas] Failed to rebuild pipeline after context restore: ${err.detail || err.message || JSON.stringify(err)}`)
                    if (this._onError) {
                        this._onError(err)
                    }
                }
            }

            if (!this._isLifecycleCurrent(restorationGeneration)) return
            if (this._onContextRestored) {
                this._onContextRestored()
            }
        }

        this._canvas.addEventListener('webglcontextlost', this._boundContextLost)
        this._canvas.addEventListener('webglcontextrestored', this._boundContextRestored)
    }

    /**
     * Remove WebGL context loss/restore event handlers.
     * @private
     */
    _removeContextLossHandlers() {
        if (!this._canvas) return
        if (this._boundContextLost) {
            this._canvas.removeEventListener('webglcontextlost', this._boundContextLost)
        }
        if (this._boundContextRestored) {
            this._canvas.removeEventListener('webglcontextrestored', this._boundContextRestored)
        }
    }

    // =========================================================================
    // Public Getters
    // =========================================================================

    /** @returns {boolean} Whether the WebGL context is currently lost */
    get isContextLost() {
        return this._isContextLost
    }

    /** @returns {string} Current backend ('glsl' or 'wgsl') */
    get backend() {
        return this._preferWebGPU ? 'wgsl' : 'glsl'
    }

    /** @returns {object|null} Current pipeline object */
    get pipeline() {
        return this._pipeline
    }

    /**
     * Register an output sink on the active compiled pipeline.
     * The returned removal function is scoped to that concrete pipeline.
     * @param {{configure: Function, submit: Function, close: Function}} sink
     * @returns {() => void}
     */
    addSink(sink) {
        if (!this._pipeline) {
            throw new Error('CanvasRenderer has no active pipeline; compile before adding a sink')
        }
        if (typeof this._pipeline.addSink !== 'function') {
            throw new Error('Active Noisemaker pipeline does not support output sinks')
        }
        return this._pipeline.addSink(sink)
    }

    /**
     * Create an asynchronous frame-export queue for the active backend.
     * Returns null when the concrete backend does not support frame export.
     * @param {object} [options]
     * @returns {object|null}
     */
    createFrameExportQueue(options = {}) {
        if (!this._pipeline) {
            throw new Error('CanvasRenderer has no active pipeline; compile before creating a frame export queue')
        }
        const backend = this._pipeline.backend
        if (typeof backend?.createFrameExportQueue !== 'function') {
            return null
        }
        return backend.createFrameExportQueue(options)
    }

    /** @returns {number} Total frames rendered */
    get frameCount() {
        return this._frameCount
    }

    /** @returns {number} Current measured FPS */
    get currentFPS() {
        return this._currentFPS
    }

    /** @returns {boolean} Whether render loop is running */
    get isRunning() {
        return this._isRunning
    }

    /** @returns {boolean} Whether current program is a scene() program */
    get isScene() {
        return this._isScene
    }

    /** @returns {SceneTree|null} Current scene tree (if scene program) */
    get sceneTree() {
        return this._sceneTree
    }

    /** @returns {SceneRenderer|null} Current scene renderer (if scene program) */
    get sceneRenderer() {
        return this._sceneRenderer
    }

    /** @returns {Clock|null} Scene clock (if scene program) */
    get clock() {
        return this._clock
    }

    /** @returns {number} Loop duration in seconds */
    get loopDuration() {
        return this._loopDuration
    }

    /** @returns {number} Number of render passes in last frame */
    get lastPassCount() {
        return this._lastPassCount
    }

    /** @returns {string} Current DSL source */
    get currentDsl() {
        return this._currentDsl
    }

    /** @returns {object|null} Current effect object */
    get currentEffect() {
        return this._currentEffect
    }

    /** @returns {object} Shader manifest */
    get manifest() {
        return this._manifest
    }

    /** @returns {Map} Loaded effects cache */
    get loadedEffects() {
        return this._loadedEffects
    }

    /** @returns {object} Enum registry */
    get enums() {
        return this._enums
    }

    /** @returns {HTMLCanvasElement} Canvas element */
    get canvas() {
        return this._canvas
    }

    /** @returns {boolean} Whether using bundle mode */
    get useBundles() {
        return this._useBundles
    }

    /** @returns {string} Bundle path */
    get bundlePath() {
        return this._bundlePath
    }

    /**
     * Get the last normalized time value rendered by the pipeline.
     * @returns {number} Normalized time (0-1)
     */
    get lastTime() {
        return this._pipeline?.lastTime || 0
    }

    /**
     * Get device capabilities from the current pipeline.
     * Returns default capabilities if no pipeline is active.
     * @returns {{isMobile: boolean, floatBlend: boolean, floatLinear: boolean, colorBufferFloat: boolean, maxDrawBuffers: number, maxTextureSize: number, maxColorBytesPerSample: number, maxStateSize: number}}
     */
    get capabilities() {
        return this._pipeline?.getCapabilities() || {
            isMobile: false,
            floatBlend: true,
            floatLinear: true,
            colorBufferFloat: true,
            maxDrawBuffers: 8,
            maxTextureSize: 4096,
            maxColorBytesPerSample: 64,
            maxStateSize: 2048
        }
    }

    // =========================================================================
    // Public Setters
    // =========================================================================

    /** @param {object|null} effect - Set current effect */
    set currentEffect(effect) {
        this._currentEffect = effect
    }

    /** @param {string} dsl - Set current DSL */
    set currentDsl(dsl) {
        this._currentDsl = dsl
    }

    // =========================================================================
    // Configuration
    // =========================================================================

    /**
     * Set loop duration
     * @param {number} duration - Duration in seconds
     */
    setLoopDuration(duration) {
        this._loopDuration = duration
        this._loopStartTime = performance.now() // Reset loop
    }

    /**
     * Set a uniform value across all passes
     * @param {string} name - Uniform name
     * @param {*} value - Uniform value
     */
    setUniform(name, value) {
        if (this._pipeline && this._pipeline.setUniform) {
            this._pipeline.setUniform(name, value)
        }
    }

    /**
     * Set tile region for tiled large-resolution rendering.
     * @param {{offset: number[], fullResolution: number[]}} region
     */
    setTileRegion(region) {
        if (this._pipeline) this._pipeline.setTileRegion(region)
    }

    /**
     * Clear tile region, returning to normal rendering.
     */
    clearTileRegion() {
        if (this._pipeline) this._pipeline.clearTileRegion()
    }

    /**
     * Render the active effect into 6 cubemap faces. See Pipeline.renderCubemap.
     * The returned array is reused on each call — copy the faces if retaining.
     * @returns {Promise<Array<{width,height,data}>>} reused buffer — copy if retaining
     */
    renderCubemap(config) {
        if (this._pipeline) return this._pipeline.renderCubemap(config)
        return Promise.resolve([])
    }

    /**
     * Resize the renderer
     * @param {number} width - New width
     * @param {number} height - New height
     */
    resize(width, height) {
        this._width = width
        this._height = height
        if (this._sceneRenderer) {
            this._sceneRenderer.resize(width, height)
        }
        if (this._pipeline && this._pipeline.resize) {
            this._pipeline.resize(width, height)
        }
    }

    /**
     * Set the MIDI state for midi() function resolution.
     * Creates a new MidiState if not provided.
     * @param {MidiState} [midiState] - MidiState instance (creates new if not provided)
     * @returns {MidiState} The MIDI state instance
     */
    setMidiState(midiState) {
        this._midiState = midiState || new MidiState()
        if (this._pipeline) {
            this._pipeline.setMidiState(this._midiState)
        }
        return this._midiState
    }

    /**
     * Get the current MIDI state
     * @returns {MidiState|null}
     */
    get midiState() {
        return this._midiState
    }

    /**
     * Set the audio state for audio() function resolution.
     * Creates a new AudioState if not provided.
     * @param {AudioState} [audioState] - AudioState instance (creates new if not provided)
     * @returns {AudioState} The audio state instance
     */
    setAudioState(audioState) {
        this._audioState = audioState || new AudioState()
        if (this._pipeline) {
            this._pipeline.setAudioState(this._audioState)
        }
        return this._audioState
    }

    /**
     * Get the current audio state
     * @returns {AudioState|null}
     */
    get audioState() {
        return this._audioState
    }

    // =========================================================================
    // Render Loop
    // =========================================================================

    /**
     * Start the animation loop
     */
    start() {
        if (this._isRunning) return
        this._isRunning = true
        this._lastFrameTime = performance.now()
        this._animationFrameId = requestAnimationFrame(this._boundRenderLoop)
    }

    /**
     * Stop the animation loop
     */
    stop() {
        this._isRunning = false
        if (this._animationFrameId !== null) {
            cancelAnimationFrame(this._animationFrameId)
            this._animationFrameId = null
        }
    }

    /**
     * Sync the pipeline's internal time reference.
     * Call this when pausing to ensure subsequent paused renders have deltaTime = 0.
     * @param {number} normalizedTime - The normalized time value (0-1) to sync to
     */
    syncTime(normalizedTime) {
        if (this._pipeline) {
            this._pipeline.syncTime(normalizedTime)
        }
    }

    /**
     * Render a single frame at a specific time
     * @param {number} normalizedTime - Time value 0-1
     */
    render(normalizedTime) {
        // Scene programs draw into SCENE_COLOR_TEXTURE first; the pipeline
        // below then blits that into its surface and runs any 2D effects.
        this._renderScene(normalizedTime * this._loopDuration * 1000, normalizedTime)

        if (this._pipeline && !this._isContextLost) {
            try {
                this._pipeline.render(normalizedTime)
                this._lastPassCount = this._pipeline.lastPassCount
                this._frameCount++
            } catch (err) {
                console.error('Render error:', err)
                if (this._onError) {
                    this._onError(err)
                }
            }
        }
    }

    /**
     * Draw the scene tree into SCENE_COLOR_TEXTURE, if this is a scene
     * program. No-op otherwise. Runs before pipeline execution so the
     * pipeline's blit carries the result into its surface the same frame.
     * @private
     * @param {number} timeMs - Timestamp to advance the scene clock with
     * @param {number} normalizedTime - Shared animation loop position in [0, 1]
     */
    _renderScene(timeMs, normalizedTime) {
        if (!this._isScene || !this._sceneRenderer || !this._sceneTree) return
        try {
            if (this._clock) {
                this._clock.tick(timeMs)
            }
            if (this._sceneBindings && this._sceneBindings.length > 0 && sceneModules) {
                sceneModules.evaluateBindings(this._sceneBindings, normalizedTime)
            }
            this._sceneTree.updateWorldMatrices()
            // render() is async (shader compilation on light-count change);
            // an async throw surfaces as a rejected promise, not a sync
            // throw, so route it explicitly or it becomes an invisible
            // unhandled rejection.
            this._sceneRenderer.render(this._sceneTree, this._clock, SCENE_COLOR_TEXTURE)
                .catch(err => {
                    console.error('Scene render error:', err)
                    if (this._onError) {
                        this._onError(err)
                    }
                })
        } catch (err) {
            console.error('Scene render error:', err)
            if (this._onError) {
                this._onError(err)
            }
        }
    }

    /** @private Main render loop */
    _renderLoop(time) {
        if (!this._isRunning) return

        this._animationFrameId = requestAnimationFrame(this._boundRenderLoop)

        const elapsedSeconds = (time - this._loopStartTime) / 1000
        const normalizedTime = (elapsedSeconds % this._loopDuration) / this._loopDuration

        // Scene programs draw into SCENE_COLOR_TEXTURE before the pipeline
        // runs, so the pipeline's blit picks the result up this frame.
        this._renderScene(time, normalizedTime)

        if (this._pipeline) {
            // Normal effect pipeline rendering path
            try {
                this._pipeline.render(normalizedTime)
                this._lastPassCount = this._pipeline.lastPassCount

                this._frameCount++

                if (this._onFrame) {
                    this._onFrame(this._frameCount)
                }
            } catch (err) {
                console.error('Render loop error:', err)
                if (this._onError) {
                    this._onError(err)
                }
            }
        }

        // FPS measurement
        this._fpsFrameCount++
        const fpsElapsed = time - this._fpsLastUpdateTime
        if (fpsElapsed >= 1000) {
            this._currentFPS = Math.round((this._fpsFrameCount * 1000) / fpsElapsed)
            this._fpsFrameCount = 0
            this._fpsLastUpdateTime = time

            if (this._onFPS) {
                this._onFPS(this._currentFPS)
            }
        }

        this._lastFrameTime = time
    }

    // =========================================================================
    // Pipeline Lifecycle
    // =========================================================================

    /** @private Invalidate pending lifecycle work and record unsafe backend generations. */
    _advanceLifecycle({ backendLost = false } = {}) {
        this._lifecycleGeneration = (this._lifecycleGeneration ?? 0) + 1
        if (backendLost) {
            this._lastBackendInvalidationGeneration = this._lifecycleGeneration
        }
        return this._lifecycleGeneration
    }

    /** @private */
    _isLifecycleCurrent(generation) {
        return (this._lifecycleGeneration ?? 0) === generation
    }

    /** @private Dispose a runtime result that completed after its lifecycle was invalidated. */
    _disposeStalePipeline(pipeline, generation) {
        if (!pipeline || pipeline === this._pipeline) return
        const backendLost = (this._lastBackendInvalidationGeneration ?? -1) > generation
        try {
            pipeline.dispose?.(backendLost ? { backendLost: true } : {})
        } catch (err) {
            console.warn('Failed to dispose stale pipeline', err)
        }
    }

    /**
     * Reset the canvas element (for backend switching)
     */
    resetCanvas() {
        if (!this._canvasContainer || !this._canvas) {
            return
        }

        // Remove context loss listeners from old canvas
        this._removeContextLossHandlers()

        const newCanvas = this._canvas.cloneNode(false)
        newCanvas.id = this._canvas.id
        newCanvas.width = this._canvas.width
        newCanvas.height = this._canvas.height

        this._canvasContainer.replaceChild(newCanvas, this._canvas)
        this._canvas = newCanvas

        // A lost context belonged to the canvas we just discarded, and its
        // webglcontextrestored event can never fire now. Without this reset,
        // render() stays a silent no-op on every future backend — the render
        // loop keeps drawing but single-frame renders (exports) stay black.
        this._isContextLost = false

        // Re-attach context loss listeners to new canvas
        this._setupContextLossHandlers()
    }

    /**
     * Dispose of the current pipeline
     * @param {object} [options] - Disposal options
     * @param {boolean} [options.loseContext=false] - Force context loss
     * @param {boolean} [options.resetCanvas=false] - Reset canvas element
     */
    async dispose(options = {}) {
        const { loseContext = false, resetCanvas = false } = options
        this._advanceLifecycle({ backendLost: loseContext || resetCanvas })

        // Clean up scene rendering state
        this._isScene = false
        this._sceneTree = null
        this._sceneRenderer = null
        if (this._sceneBackend) {
            try {
                this._sceneBackend.destroy({ loseContext })
            } catch (_) {
                // Ignore cleanup errors for scene backend
            }
            this._sceneBackend = null
        }
        if (this._clock) {
            this._clock.reset()
            this._clock = null
        }

        if (!this._pipeline) {
            if (resetCanvas) {
                this.resetCanvas()
            }
            return
        }

        const oldPipeline = this._pipeline
        this._pipeline = null
        this._uniformBindings = new Map()

        try {
            oldPipeline.dispose({ loseContext })
        } catch (err) {
            console.warn('Failed to dispose pipeline', err)
        }

        if (resetCanvas) {
            this.resetCanvas()
        }
    }

    /** @private Create a fresh runtime pipeline. */
    _createRuntime(dsl, options) {
        return createRuntime(dsl, options)
    }

    /**
     * Compile DSL and create pipeline
     * @param {string} dsl - DSL source code
     * @param {object} [options] - Compilation options
     * @param {object} [options.shaderOverrides] - Per-step shader overrides
     * @returns {Promise<object>} The created pipeline
     */
    async compile(dsl, options = {}) {
        const shaderOverrides = options.shaderOverrides
        const lifecycleGeneration = this._lifecycleGeneration ?? 0

        this._currentDsl = dsl

        // Check if this is a scene program by compiling the graph first
        const graph = compileGraph(dsl, { shaderOverrides })

        // A scene program still builds a normal pipeline: the scene renders
        // into SCENE_COLOR_TEXTURE, and the pipeline's blit carries it into a
        // surface where 2D effects can consume it. Only the scene objects are
        // set up here; the renderer needs the pipeline's backend and is built
        // once that exists.
        if (graph._isScene) {
            const { SceneTree, Clock, collectBindings } = await loadSceneModules()
            this._isScene = true
            this._sceneTree = SceneTree.fromIR(graph.sceneIR)
            this._sceneBindings = collectBindings(this._sceneTree)
            this._clock = new Clock()
        } else {
            this._isScene = false
            this._sceneTree = null
            this._sceneRenderer = null
            this._sceneBindings = null
            this._clock = null
        }

        if (!this._pipeline) {
            let initialPipeline
            try {
                initialPipeline = await this._createRuntime(dsl, {
                    canvas: this._canvas,
                    width: this._width,
                    height: this._height,
                    preferWebGPU: this._preferWebGPU,
                    shaderOverrides
                })
            } catch (err) {
                if (!this._isLifecycleCurrent(lifecycleGeneration)) return null
                throw err
            }
            if (!this._isLifecycleCurrent(lifecycleGeneration) || this._pipeline) {
                this._disposeStalePipeline(initialPipeline, lifecycleGeneration)
                return null
            }
            this._pipeline = initialPipeline
            // Apply external input state to new pipeline
            if (this._midiState) {
                this._pipeline.setMidiState(this._midiState)
            }
            if (this._audioState) {
                this._pipeline.setAudioState(this._audioState)
            }
        } else {
            const compilationPipeline = this._pipeline
            // Set isCompiling flag BEFORE recompile swaps the graph
            // This prevents the render loop from trying to execute passes
            // with programs that haven't been compiled yet
            compilationPipeline.isCompiling = true

            try {
                const newGraph = recompile(compilationPipeline, dsl, { shaderOverrides })
                if (!newGraph) {
                    // Recompile failed, need to create a new pipeline from scratch
                    compilationPipeline.isCompiling = false
                    const previousPipeline = compilationPipeline
                    const replacementPipeline = await this._createRuntime(dsl, {
                        canvas: this._canvas,
                        width: this._width,
                        height: this._height,
                        preferWebGPU: this._preferWebGPU,
                        shaderOverrides
                    })
                    if (!this._isLifecycleCurrent(lifecycleGeneration) ||
                        this._pipeline !== previousPipeline) {
                        this._disposeStalePipeline(replacementPipeline, lifecycleGeneration)
                        return null
                    }
                    this._pipeline = replacementPipeline
                    try {
                        previousPipeline?.dispose?.()
                    } catch (err) {
                        console.warn('Failed to dispose previous pipeline', err)
                    }
                } else {
                    // Recompile succeeded, now compile the programs
                    // compilePrograms will clear the isCompiling flag when done
                    await compilationPipeline.compilePrograms()
                    if (!this._isLifecycleCurrent(lifecycleGeneration) ||
                        this._pipeline !== compilationPipeline) {
                        return null
                    }
                }
            } catch (err) {
                // Ensure flag is cleared on error
                compilationPipeline.isCompiling = false
                if (!this._isLifecycleCurrent(lifecycleGeneration)) return null
                throw err
            }
        }

        const compiledPipeline = this._pipeline
        if (!this._isLifecycleCurrent(lifecycleGeneration) || !compiledPipeline) return null

        // Reset frame count on recompile so simulations restart properly
        this._frameCount = 0

        this._uniformBindings = new Map()

        // Re-upload cached mesh data to new backend
        await this._reuploadCachedMeshes()
        if (!this._isLifecycleCurrent(lifecycleGeneration) ||
            this._pipeline !== compiledPipeline) {
            return null
        }

        // The scene renderer needs the pipeline's backend, so it is built (or
        // rebuilt, after a backend swap) once the pipeline is in place.
        if (this._isScene && this._pipeline?.backend) {
            const { SceneRenderer } = await loadSceneModules()
            if (this._sceneRenderer?.backend !== this._pipeline.backend) {
                this._sceneRenderer?.dispose?.()
                this._sceneRenderer = new SceneRenderer(this._pipeline.backend, this._pipeline)
                await this._sceneRenderer.initialize(this._width, this._height)
            }
        }

        // A context loss stops the render loop. When the loss was resolved by
        // replacing the canvas (backend switch) rather than a restore event,
        // this fresh pipeline is the recovery point — resume the loop here.
        if (this._wasRunningBeforeContextLoss && !this._isRunning && !this._isContextLost) {
            this._wasRunningBeforeContextLoss = false
            this.start()
        }

        return compiledPipeline
    }

    /**
     * Re-upload cached mesh data to the current backend.
     * Called after backend switch or pipeline recreation.
     * @private
     */
    async _reuploadCachedMeshes() {
        if (!this._pipeline?.backend || this._meshCache.size === 0) {
            return
        }

        for (const [meshId, cached] of this._meshCache) {
            try {
                this._pipeline.backend.uploadMeshData(
                    meshId,
                    cached.positionData,
                    cached.normalData,
                    cached.uvData,
                    cached.width,
                    cached.height,
                    cached.vertexCount
                )

            } catch (err) {
                console.warn(`[Canvas] Failed to re-upload mesh ${meshId}:`, err)
            }
        }
    }

    /**
     * Switch rendering backend
     * @param {string} backend - 'glsl' or 'wgsl'
     */
    async switchBackend(backend) {
        const preferWebGPU = backend === 'wgsl'
        if (preferWebGPU === this._preferWebGPU) {
            return
        }

        const previousBackend = this._preferWebGPU ? 'wgsl' : 'glsl'
        this._preferWebGPU = preferWebGPU

        await this.dispose({
            loseContext: previousBackend === 'glsl',
            resetCanvas: true
        })
    }

    // =========================================================================
    // Lazy Effect Loading
    // =========================================================================

    /**
     * Load the shader manifest
     * @returns {Promise<object>} The loaded manifest
     */
    async loadManifest() {
        try {
            const manifestRes = await fetch(`${this._basePath}/effects/manifest.json`)
            if (manifestRes.ok) {
                this._manifest = await manifestRes.json()
            }
        } catch (e) {
            console.warn('Failed to load shader manifest')
            throw new Error('Could not load shader manifest - lazy loading requires manifest.json')
        }

        // Register starter ops from manifest
        const starterNames = []
        for (const [effectId, entry] of Object.entries(this._manifest)) {
            if (entry.starter) {
                const parts = effectId.split('/')
                if (parts.length === 2) {
                    starterNames.push(parts[1])
                    starterNames.push(`${parts[0]}.${parts[1]}`)
                }
            }
        }
        registerStarterOps(starterNames)

        // Initialize enums
        this._enums = await mergeIntoEnums(stdEnums)

        return this._manifest
    }

    /**
     * Initialize standard enums (call after loadManifest or standalone)
     */
    async initEnums() {
        this._enums = await mergeIntoEnums(stdEnums)
    }

    /**
     * Get effect names from manifest for a namespace
     * @param {string} namespace - Effect namespace
     * @returns {string[]} Effect names
     */
    getEffectsFromManifest(namespace, { includeHidden = false } = {}) {
        const prefix = `${namespace}/`
        return Object.keys(this._manifest)
            .filter(key => key.startsWith(prefix) && (includeHidden || !this._manifest[key].hidden))
            .map(key => key.slice(prefix.length))
            .sort()
    }

    /**
     * Get effect description (localized when a locale is set, else from manifest).
     * @param {string} effectId - Effect ID (namespace/name)
     * @returns {string|null} Description or null if not found
     */
    getEffectDescription(effectId) {
        const entry = this._manifest?.[effectId]
        return this.localize(`${effectId}#desc`, entry?.description ?? null)
    }

    /**
     * Set the active locale for effect-facing strings (display names,
     * descriptions, parameter labels, enum option labels). Opt-in: until this is
     * called, all strings stay English and no catalog is fetched. Lazily fetches
     * `${basePath}/effects/strings.<locale>.json` (plus the English base) and
     * caches it. Pass a falsy value to return to the default (English) behavior.
     * @param {string|null} locale
     * @returns {Promise<string|null>} the active locale
     */
    async setLocale(locale) {
        this._locale = locale || null
        if (!this._locale) return this._locale
        if (!this._strings.en) this._strings.en = await this._fetchStrings('en')
        if (this._locale !== 'en' && !this._strings[this._locale]) {
            this._strings[this._locale] = await this._fetchStrings(this._locale)
        }
        return this._locale
    }

    /** @returns {string|null} the active effect-string locale */
    getLocale() {
        return this._locale
    }

    /**
     * Resolve an effect-string id to the active locale, falling back to the
     * English base catalog, then to `fallback`. With no locale set (the default)
     * this returns `fallback` unchanged, so existing callers get today's English.
     * @param {string} id - e.g. "filter/adjust", "filter/adjust#desc", "filter/adjust.rotation"
     * @param {string|null} [fallback]
     * @returns {string|null}
     */
    localize(id, fallback = null) {
        if (this._locale) {
            // Treat null/missing/empty as "no translation" so a blank locale
            // value falls back to English rather than rendering an empty label.
            const hit = this._strings[this._locale]?.[id]
            if (hit) return hit
            const base = this._strings.en?.[id]
            if (base) return base
        }
        return fallback
    }

    /**
     * Fetch a string catalog for a locale; returns {} on any failure so a
     * missing locale file degrades gracefully to English fallbacks.
     * @param {string} locale
     * @returns {Promise<object>}
     */
    async _fetchStrings(locale) {
        try {
            const res = await fetch(`${this._basePath}/effects/strings.${locale}.json`)
            if (res.ok) return await res.json()
        } catch {
            // fall through to empty catalog
        }
        return {}
    }

    /**
     * Load effect definition
     * @param {string} namespace - Effect namespace
     * @param {string} effectName - Effect name
     * @returns {Promise<object>} Effect object
     */
    async loadEffectDefinition(namespace, effectName) {
        const effectId = `${namespace}/${effectName}`
        const basePath = `${this._basePath}/effects/${namespace}/${effectName}`

        try {
            const module = await import(`${basePath}/definition.js`)
            const exported = module.default

            if (!exported) {
                throw new Error(`No default export in ${effectId}/definition.js`)
            }

            // Support both patterns:
            // 1. new Effect({...}) - exported is already an Effect instance (has state property)
            // 2. class Foo extends Effect - exported is a class to instantiate (is a function)
            const instance = (typeof exported === 'function') ? new exported() : exported
            return { namespace, name: effectName, instance }
        } catch (err) {
            console.error(`Failed to load definition for ${effectId}:`, err)
            throw err
        }
    }

    /**
     * Load effect shaders
     * @param {object} effect - Effect object
     * @returns {Promise<void>}
     */
    async loadEffectShaders(effect) {
        const { namespace, name: effectName, instance } = effect
        const effectId = `${namespace}/${effectName}`
        const basePath = `${this._basePath}/effects/${namespace}/${effectName}`
        const effectManifest = this._manifest[effectId]

        if (!instance.passes || !effectManifest) return

        if (!instance.shaders) instance.shaders = {}

        const shaderPromises = []

        for (const pass of instance.passes) {
            if (!pass.program) continue

            const prog = pass.program
            const shaderBucket = instance.shaders[prog] ?? (instance.shaders[prog] = {})

            // GLSL loading
            const glslInfo = effectManifest.glsl?.[prog]
            if (glslInfo === 'combined') {
                shaderPromises.push(
                    fetch(`${basePath}/glsl/${prog}.glsl`)
                        .then(res => res.ok ? res.text() : null)
                        .then(text => { if (text) shaderBucket.glsl = text })
                )
            } else if (glslInfo) {
                if (glslInfo.v) {
                    shaderPromises.push(
                        fetch(`${basePath}/glsl/${prog}.vert`)
                            .then(res => res.ok ? res.text() : null)
                            .then(text => { if (text) shaderBucket.vertex = text })
                    )
                }
                if (glslInfo.f) {
                    shaderPromises.push(
                        fetch(`${basePath}/glsl/${prog}.frag`)
                            .then(res => res.ok ? res.text() : null)
                            .then(text => { if (text) shaderBucket.fragment = text })
                    )
                }
            }

            // WGSL loading
            if (effectManifest.wgsl?.[prog]) {
                shaderPromises.push(
                    fetch(`${basePath}/wgsl/${prog}.wgsl`)
                        .then(res => res.ok ? res.text() : null)
                        .then(text => { if (text) shaderBucket.wgsl = text })
                )
            }
        }

        await Promise.all(shaderPromises)
    }

    /**
     * Register effect with the runtime
     * @param {object} effect - Effect object
     * @returns {object|null} Choices to register as enums
     */
    registerEffectWithRuntime(effect) {
        const { namespace, name: effectName, instance } = effect

        // Register effect with multiple names for lookup flexibility
        registerEffect(instance.func, instance)
        registerEffect(`${namespace}.${instance.func}`, instance)
        registerEffect(`${namespace}/${effectName}`, instance)
        registerEffect(`${namespace}.${effectName}`, instance)

        // Register as operator
        if (instance.func) {
            const choicesToRegister = {}

            const args = Object.entries(instance.globals || {}).map(([key, spec]) => {
                let enumPath = spec.enum || spec.enumPath
                if (spec.choices && !enumPath) {
                    enumPath = `${namespace}.${instance.func}.${key}`

                    if (!choicesToRegister[namespace]) {
                        choicesToRegister[namespace] = {}
                    }
                    if (!choicesToRegister[namespace][instance.func]) {
                        choicesToRegister[namespace][instance.func] = {}
                    }
                    choicesToRegister[namespace][instance.func][key] = {}

                    for (const [name, val] of Object.entries(spec.choices)) {
                        if (name.endsWith(':')) continue
                        choicesToRegister[namespace][instance.func][key][name] = { type: 'Number', value: val }
                        const sanitized = sanitizeEnumName(name)
                        if (sanitized && sanitized !== name) {
                            choicesToRegister[namespace][instance.func][key][sanitized] = { type: 'Number', value: val }
                        }
                    }
                }
                return {
                    name: key,
                    type: spec.type === 'vec4' ? 'color' : spec.type,
                    default: spec.default,
                    enum: enumPath,
                    enumPath: enumPath,
                    min: spec.min,
                    max: spec.max,
                    uniform: spec.uniform,
                    choices: spec.choices
                }
            })

            const opSpec = {
                name: instance.func,
                args: args
            }
            registerOp(`${namespace}.${instance.func}`, opSpec)

            if (instance.paramAliases) {
                registerParamAliases(`${namespace}.${instance.func}`, instance.paramAliases)
            }

            if (instance.hidden && instance.deprecatedBy) {
                registerEffectAlias(`${namespace}.${instance.func}`, instance.deprecatedBy)
            }

            return choicesToRegister
        }
        return null
    }

    /**
     * Register a starter op for an effect
     * @param {object} effect - Effect object
     */
    registerStarterOpForEffect(effect) {
        if (!effect.instance || !isStarterEffect(effect)) return

        const func = effect.instance.func || effect.name
        const namespace = effect.namespace
        const starterNames = []

        if (func) {
            starterNames.push(func)
            if (namespace) {
                starterNames.push(`${namespace}.${func}`)
            }
        }

        if (starterNames.length > 0) {
            registerStarterOps(starterNames)
        }
    }

    /**
     * Load effect from a pre-built bundle (definition + shaders inlined)
     * @param {string} namespace - Effect namespace
     * @param {string} effectName - Effect name
     * @returns {Promise<object>} Effect object with shaders already attached
     */
    async loadEffectFromBundle(namespace, effectName) {
        const effectId = `${namespace}/${effectName}`
        const bundleUrl = `${this._bundlePath}/${namespace}/${effectName}.js`

        try {
            const module = await import(bundleUrl)
            const exported = module.default

            if (!exported) {
                throw new Error(`No default export in bundle ${effectId}`)
            }

            // The bundle exports an Effect instance with shaders already attached
            // For class-based definitions, shaders are added as a static property
            // on the class, so we need to copy them to the instance
            let instance
            if (typeof exported === 'function') {
                instance = new exported()
                // Copy shaders from class static property to instance
                if (exported.shaders && !instance.shaders) {
                    instance.shaders = exported.shaders
                }
                // Copy help from class static property to instance
                if (exported.help && !instance.help) {
                    instance.help = exported.help
                }
            } else {
                instance = exported
            }

            // Also check named export for help (bundles export help separately)
            if (module.help && !instance.help) {
                instance.help = module.help
            }

            return { namespace, name: effectName, instance }
        } catch (err) {
            console.error(`Failed to load bundle for ${effectId}:`, err)
            throw err
        }
    }

    /**
     * Load a single effect on demand (with caching)
     * @param {string} effectId - Effect ID (namespace/name)
     * @param {object} [options] - Loading options
     * @param {function} [options.onProgress] - Progress callback
     * @returns {Promise<object>} Loaded effect
     */
    async loadEffect(effectId, options = {}) {
        // Check cache first
        if (this._loadedEffects.has(effectId)) {
            return this._loadedEffects.get(effectId)
        }

        // Check if already loading (deduplication)
        if (this._effectLoadingPromises.has(effectId)) {
            return this._effectLoadingPromises.get(effectId)
        }

        const [namespace, effectName] = effectId.split('/')
        if (!namespace || !effectName) {
            throw new Error(`Invalid effect ID: ${effectId}`)
        }

        const onProgress = options.onProgress || null

        const loadPromise = (async () => {
            try {
                let effect

                if (this._useBundles) {
                    // Bundle mode: single import with shaders inlined
                    if (onProgress) onProgress({ effectId, stage: 'bundle', status: 'loading' })
                    effect = await this.loadEffectFromBundle(namespace, effectName)
                    if (onProgress) onProgress({ effectId, stage: 'bundle', status: 'done' })
                } else {
                    // Hot-load mode: separate definition and shader fetches
                    if (onProgress) onProgress({ effectId, stage: 'definition', status: 'loading' })
                    effect = await this.loadEffectDefinition(namespace, effectName)
                    if (onProgress) onProgress({ effectId, stage: 'definition', status: 'done' })

                    if (onProgress) onProgress({ effectId, stage: 'shaders', status: 'loading' })
                    await this.loadEffectShaders(effect)
                    if (onProgress) onProgress({ effectId, stage: 'shaders', status: 'done' })
                }

                // Register with runtime
                const choicesToRegister = this.registerEffectWithRuntime(effect)
                if (choicesToRegister && Object.keys(choicesToRegister).length > 0) {
                    this._enums = await mergeIntoEnums(choicesToRegister)
                }

                // Register as starter op
                this.registerStarterOpForEffect(effect)

                // Cache the loaded effect
                this._loadedEffects.set(effectId, effect)

                return effect
            } catch (err) {
                if (onProgress) onProgress({ effectId, stage: 'error', status: 'error', error: err })
                throw err
            } finally {
                this._effectLoadingPromises.delete(effectId)
            }
        })()

        this._effectLoadingPromises.set(effectId, loadPromise)
        return loadPromise
    }

    /**
     * Load multiple effects in parallel
     * @param {string[]} effectIds - Array of effect IDs
     * @param {object} [options] - Loading options
     * @param {function} [options.onProgress] - Progress callback
     * @returns {Promise<object[]>} Loaded effects
     */
    async loadEffects(effectIds, options = {}) {
        if (effectIds.length === 0) return []

        // Filter out already loaded effects
        const needsLoading = effectIds.filter(id => !this._loadedEffects.has(id))

        if (needsLoading.length === 0) {
            return effectIds.map(id => this._loadedEffects.get(id))
        }

        if (this._onLoadingStart) {
            this._onLoadingStart(needsLoading)
        }

        try {
            const loadPromises = needsLoading.map(effectId =>
                this.loadEffect(effectId, options)
                    .catch(err => {
                        console.error(`Failed to load ${effectId}:`, err)
                        return null
                    })
            )

            await Promise.all(loadPromises)

            if (this._onLoadingEnd) {
                this._onLoadingEnd()
            }

            return effectIds.map(id => this._loadedEffects.get(id)).filter(Boolean)
        } catch (err) {
            if (this._onLoadingEnd) {
                this._onLoadingEnd()
            }
            throw err
        }
    }

    // =========================================================================
    // Bundle Loading
    // =========================================================================

    /**
     * Register effects from a pre-bundled namespace module.
     *
     * Use this as an alternative to lazy-loading when you've imported
     * a namespace bundle (e.g., noisemaker-shaders-filter.esm.js).
     *
     * @example
     * import filterBundle from './noisemaker-shaders-filter.esm.js';
     * await renderer.registerEffectsFromBundle(filterBundle);
     *
     * @param {object} bundle - Bundle module with { namespace, effects, registerAll }
     * @returns {number} Number of effects registered
     */
    registerEffectsFromBundle(bundle) {
        if (!bundle || !bundle.effects || !bundle.namespace) {
            console.warn('[registerEffectsFromBundle] Invalid bundle format')
            return 0
        }

        const namespace = bundle.namespace
        let count = 0

        for (const [effectName, effectDef] of Object.entries(bundle.effects)) {
            const effectId = `${namespace}/${effectName}`

            // Skip if already loaded
            if (this._loadedEffects.has(effectId)) {
                continue
            }

            // Create effect wrapper matching lazy-load structure
            const effect = {
                namespace,
                name: effectName,
                instance: effectDef
            }

            // Register with runtime
            const choicesToRegister = this.registerEffectWithRuntime(effect)
            if (choicesToRegister && Object.keys(choicesToRegister).length > 0) {
                // Synchronously update enums (async merge deferred)
                this._pendingEnumMerges = this._pendingEnumMerges || []
                this._pendingEnumMerges.push(choicesToRegister)
            }

            // Register as starter op if applicable
            this.registerStarterOpForEffect(effect)

            // Cache the loaded effect
            this._loadedEffects.set(effectId, effect)
            count++
        }

        // Process any pending enum merges
        if (this._pendingEnumMerges && this._pendingEnumMerges.length > 0) {
            const merges = this._pendingEnumMerges
            this._pendingEnumMerges = []
            Promise.all(merges.map(m => mergeIntoEnums(m)))
                .then(results => {
                    for (const result of results) {
                        if (result) this._enums = result
                    }
                })
        }

        return count
    }

    /**
     * Register effects from multiple bundles.
     *
     * @example
     * import filterBundle from './noisemaker-shaders-filter.esm.js';
     * import synthBundle from './noisemaker-shaders-synth.esm.js';
     * renderer.registerEffectsFromBundles([filterBundle, synthBundle]);
     *
     * @param {object[]} bundles - Array of bundle modules
     * @returns {number} Total number of effects registered
     */
    registerEffectsFromBundles(bundles) {
        let total = 0
        for (const bundle of bundles) {
            total += this.registerEffectsFromBundle(bundle)
        }
        return total
    }

    /**
     * Check if an effect is available (loaded from bundle or lazy-loaded).
     * @param {string} effectId - Effect ID (namespace/name)
     * @returns {boolean}
     */
    hasEffect(effectId) {
        return this._loadedEffects.has(effectId)
    }

    /**
     * Get all loaded effect IDs.
     * @returns {string[]}
     */
    getLoadedEffectIds() {
        return Array.from(this._loadedEffects.keys())
    }

    /**
     * Get loaded effect IDs for a specific namespace.
     * @param {string} namespace - Namespace to filter by
     * @returns {string[]}
     */
    getLoadedEffectIdsByNamespace(namespace) {
        const prefix = `${namespace}/`
        return Array.from(this._loadedEffects.keys())
            .filter(id => id.startsWith(prefix))
    }

    // =========================================================================
    // External Texture Handling (for media input effects)
    // =========================================================================

    /**
     * Update a texture from an external source (video, image, canvas).
     * This is used for media input effects that need to display camera/video content.
     * @param {string} texId - Texture ID from effect's externalTexture property
     * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap} source - Media source
     * @param {object} [options] - Update options
     * @param {boolean} [options.flipY=true] - Whether to flip the Y axis
     * @returns {{ width: number, height: number }} Source dimensions
     */
    updateTextureFromSource(texId, source, options = {}) {
        if (!this._pipeline || !this._pipeline.backend) {
            console.warn('[updateTextureFromSource] Pipeline not ready')
            return { width: 0, height: 0 }
        }

        return this._pipeline.backend.updateTextureFromSource(texId, source, options)
    }

    // =========================================================================
    // Mesh Loading (for meshLoader effect OBJ import)
    // =========================================================================

    /** @private Pack mesh data, cache it, and upload to backend */
    _packCacheAndUploadMesh(meshId, meshData, packMeshDataForTextures) {
        const texWidth = 256
        const texHeight = 256
        const packed = packMeshDataForTextures(
            meshData.positions, meshData.normals, meshData.uvs,
            texWidth, texHeight
        )
        this._meshCache.set(meshId, {
            positionData: packed.positionData,
            normalData: packed.normalData,
            uvData: packed.uvData,
            width: texWidth,
            height: texHeight,
            vertexCount: packed.vertexCount
        })
        return this._pipeline.backend.uploadMeshData(
            meshId, packed.positionData, packed.normalData, packed.uvData,
            texWidth, texHeight, packed.vertexCount
        )
    }

    /**
     * Load an OBJ mesh file from URL and upload to a mesh surface.
     * @param {string} url - URL to OBJ file
     * @param {string} [meshId='mesh0'] - Target mesh surface (mesh0-mesh7)
     * @returns {Promise<{success: boolean, vertexCount: number, error?: string}>}
     */
    async loadOBJFromURL(url, meshId = 'mesh0') {
        if (!this._pipeline || !this._pipeline.backend) {
            console.warn('[loadOBJFromURL] Pipeline not ready')
            return { success: false, vertexCount: 0, error: 'Pipeline not ready' }
        }

        try {
            // Dynamic import to avoid loading parser until needed
            const { loadOBJ, packMeshDataForTextures } = await import('../runtime/obj-parser.js')

            const meshData = await loadOBJ(url)

            const result = this._packCacheAndUploadMesh(meshId, meshData, packMeshDataForTextures)
            return { success: true, vertexCount: result.vertexCount }
        } catch (err) {
            console.error('[Canvas] Failed to load OBJ:', err)
            return { success: false, vertexCount: 0, error: err.message }
        }
    }

    /**
     * Load OBJ mesh directly from string content.
     * @param {string} objText - Raw OBJ file content
     * @param {string} [meshId='mesh0'] - Target mesh surface (mesh0-mesh7)
     * @returns {Promise<{success: boolean, vertexCount: number, error?: string}>}
     */
    async loadOBJFromString(objText, meshId = 'mesh0') {
        if (!this._pipeline || !this._pipeline.backend) {
            console.warn('[loadOBJFromString] Pipeline not ready')
            return { success: false, vertexCount: 0, error: 'Pipeline not ready' }
        }

        try {
            const { parseOBJ, packMeshDataForTextures } = await import('../runtime/obj-parser.js')

            const meshData = parseOBJ(objText)
            const result = this._packCacheAndUploadMesh(meshId, meshData, packMeshDataForTextures)
            return { success: true, vertexCount: result.vertexCount }
        } catch (err) {
            console.error('[Canvas] Failed to parse OBJ:', err)
            return { success: false, vertexCount: 0, error: err.message }
        }
    }

    // =========================================================================
    // Uniform/Parameter Handling
    // =========================================================================

    /**
     * Resolve an enum value from a path
     * @param {string} path - Enum path (e.g., "color.mono")
     * @returns {*} Resolved value or null
     */
    resolveEnumValue(path) {
        if (path === undefined || path === null) return null
        if (typeof path === 'number' || typeof path === 'boolean') return path
        if (typeof path !== 'string') return null

        const segments = path.split('.').filter(Boolean)
        let node = this._enums

        for (const segment of segments) {
            if (!node || node[segment] === undefined) {
                return null
            }
            node = node[segment]
        }

        if (typeof node === 'number' || typeof node === 'boolean') {
            return node
        }
        if (node && typeof node === 'object' && node.value !== undefined) {
            return node.value
        }

        return null
    }

    /**
     * Convert a parameter value for use as a uniform
     * @param {*} value - Parameter value
     * @param {object} spec - Parameter spec
     * @returns {*} Converted value
     */
    convertParameterForUniform(value, spec) {
        if (!spec) {
            return value
        }

        if ((spec.enum || spec.enumPath || spec.type === 'member') && typeof value === 'string') {
            let enumValue = this.resolveEnumValue(value)
            if ((enumValue === null || enumValue === undefined) && (spec.enum || spec.enumPath)) {
                const base = spec.enum || spec.enumPath
                enumValue = this.resolveEnumValue(`${base}.${value}`)
            }
            if (enumValue !== null && enumValue !== undefined) {
                return enumValue
            }
        }

        switch (spec.type) {
            case 'boolean':
            case 'button':
                return !!value
            case 'int':
                // Handle boolean values (from checkbox controls) by converting to 0/1
                if (typeof value === 'boolean') {
                    return value ? 1 : 0
                }
                return typeof value === 'number' ? Math.round(value) : parseInt(value, 10)
            case 'float':
                return typeof value === 'number' ? value : parseFloat(value)
            case 'color':
                // Color type: convert hex strings to vec3 array, pass arrays through
                if (Array.isArray(value)) {
                    // Already an array - ensure it's a vec3 (take first 3 components)
                    const result = value.slice(0, 3).map((component) =>
                        typeof component === 'number' ? component : parseFloat(component)
                    )
                    // Pad to 3 components if needed
                    while (result.length < 3) result.push(0)
                    return result
                }
                if (typeof value === 'string' && value.startsWith('#')) {
                    // Hex string to vec3
                    const hex = value.slice(1)
                    return [
                        parseInt(hex.slice(0, 2), 16) / 255,
                        parseInt(hex.slice(2, 4), 16) / 255,
                        parseInt(hex.slice(4, 6), 16) / 255
                    ]
                }
                break
            case 'vec3':
            case 'vec4':
                if (Array.isArray(value)) {
                    return value.map((component) => (typeof component === 'number' ? component : parseFloat(component)))
                }
                break
            default:
                break
        }

        return value
    }

    /**
     * Build uniform bindings for the current effect
     * @param {object} effect - Effect object
     */
    buildUniformBindings(effect) {
        this._uniformBindings = new Map()

        if (!this._pipeline || !this._pipeline.graph || !Array.isArray(this._pipeline.graph.passes)) {
            return
        }

        if (!effect || !effect.instance || !effect.instance.globals) {
            return
        }

        // Build reverse map from passes[].uniforms bridges: paramName → Set<shaderVarName>
        // Pass definitions map { shaderVarName: paramName } when the shader variable
        // differs from the DSL param name (e.g. GLSL builtins like mix, smooth, layout)
        const bridges = new Map()
        if (effect.instance.passes) {
            for (const passDef of effect.instance.passes) {
                if (!passDef.uniforms) continue
                for (const [shaderName, paramRef] of Object.entries(passDef.uniforms)) {
                    if (shaderName === paramRef) continue
                    if (!bridges.has(paramRef)) bridges.set(paramRef, new Set())
                    bridges.get(paramRef).add(shaderName)
                }
            }
        }

        const targetFunc = effect.instance.func
        const targetNamespace = effect.instance.namespace || effect.namespace || null

        this._pipeline.graph.passes.forEach((pass, index) => {
            if (!pass) return

            const passFunc = pass.effectFunc || pass.effectKey || null
            const passNamespace = pass.effectNamespace || null

            if (!passFunc || passFunc !== targetFunc) return
            if (targetNamespace && passNamespace && passNamespace !== targetNamespace) return

            for (const [paramName, spec] of Object.entries(effect.instance.globals)) {
                if (spec.type === 'surface') continue
                if (!pass.uniforms) continue
                const uniformName = spec.uniform || paramName

                // Direct match: uniform name exists as key in pass.uniforms
                if (uniformName in pass.uniforms) {
                    if (!this._uniformBindings.has(paramName)) {
                        this._uniformBindings.set(paramName, [])
                    }
                    this._uniformBindings.get(paramName).push({
                        passIndex: index,
                        uniformName
                    })
                    continue
                }

                // Bridge match: shader uses a different variable name for this param
                const paramBridges = bridges.get(paramName)
                if (paramBridges) {
                    for (const shaderName of paramBridges) {
                        if (shaderName in pass.uniforms) {
                            if (!this._uniformBindings.has(paramName)) {
                                this._uniformBindings.set(paramName, [])
                            }
                            this._uniformBindings.get(paramName).push({
                                passIndex: index,
                                uniformName: shaderName
                            })
                        }
                    }
                }
            }
        })
    }

    /**
     * Apply parameter values to the pipeline
     * @param {object} effect - Current effect
     * @param {object} parameterValues - Parameter values to apply
     */
    applyParameterValues(effect, parameterValues) {
        if (!this._pipeline || !effect || !effect.instance) {
            return
        }

        if (!this._uniformBindings.size) {
            this.buildUniformBindings(effect)
        }

        const globals = effect.instance.globals || {}

        // Track whether any chain-scoped param changed so dependent texture
        // dimensions (e.g. screenDivide:'zoom_chain_N') get re-resolved.
        // The three runtime UI paths (this method, applyStepParameterValues,
        // program-state._applyToPipeline) share the same (gate, propagate,
        // broadcast) pattern for chain-scoped params — if you change one,
        // change all three. The gate currently fires only for volumeSize
        // (via pass.inheritsVolumeSize) because that's the only param with
        // upstream-inherit semantics today.
        let scopedParamChanged = false

        for (const [paramName, spec] of Object.entries(globals)) {
            if (spec.type === 'surface') {
                continue
            }
            const bindings = this._uniformBindings.get(paramName)
            if (!bindings || bindings.length === 0) {
                continue
            }

            const currentValue = parameterValues[paramName]
            if (currentValue === undefined) {
                continue
            }

            if (isAutomationControlled(currentValue)) continue

            const converted = this.convertParameterForUniform(currentValue, spec)

            for (const binding of bindings) {
                const pass = this._pipeline.graph.passes[binding.passIndex]
                if (!pass || !pass.uniforms) {
                    continue
                }
                // Consumer passes inherit volumeSize from upstream — skip the
                // write so a stale local value doesn't clobber the chain's
                // source via the scopedParams propagation below.
                if (binding.uniformName === 'volumeSize' && pass.inheritsVolumeSize) continue
                pass.uniforms[binding.uniformName] = Array.isArray(converted) ? converted.slice() : converted

                // Propagate to chain-scoped variant so resolveDimension() sees the update,
                // and broadcast to other chain members for consistent atlas sizing.
                if (pass.scopedParams && pass.scopedParams[binding.uniformName]) {
                    const scopedName = pass.scopedParams[binding.uniformName]
                    pass.uniforms[scopedName] = pass.uniforms[binding.uniformName]
                    scopedParamChanged = true
                    this._pipeline.broadcastChainScopedParam(pass, binding.uniformName, scopedName)
                }
            }
        }

        if (scopedParamChanged && this._pipeline.recreateTextures) {
            this._pipeline.recreateTextures(this._pipeline.collectDefaultUniforms())
        }
    }

    /**
     * Apply per-step parameter values to the pipeline.
     * This allows different instances of the same effect to have different uniform values.
     * Recreates simulation textures if a chain-scoped param (e.g. zoom) changed.
     * @param {object} stepParameterValues - Map of step_N -> {paramName: value}
     */
    applyStepParameterValues(stepParameterValues) {
        if (!this._pipeline || !this._pipeline.graph || !Array.isArray(this._pipeline.graph.passes)) {
            return
        }

        // Track whether any pass updated a chain-scoped param so we know to
        // re-resolve dependent texture dimensions (e.g. screenDivide:'zoom').
        // Shares the (gate, propagate, broadcast) pattern with
        // applyParameterValues and program-state._applyToPipeline; keep them
        // in sync. The pass.inheritsVolumeSize gate covers consumer passes
        // whose volumeSize comes from the upstream emitter.
        let scopedParamChanged = false

        for (const pass of this._pipeline.graph.passes) {
            if (!pass || pass.stepIndex === undefined) continue

            const stepKey = `step_${pass.stepIndex}`
            const stepParams = stepParameterValues[stepKey]
            if (!stepParams) continue

            const effectKey = pass.effectKey
            const effectDef = effectKey ? getEffect(effectKey) : null
            if (!effectDef || !effectDef.globals) continue

            // Build set of uniforms controlled by colorModeUniform
            // These should not be overwritten by UI parameter values
            const colorModeControlledUniforms = new Set()
            for (const globalSpec of Object.values(effectDef.globals)) {
                if (globalSpec.colorModeUniform) {
                    colorModeControlledUniforms.add(globalSpec.colorModeUniform)
                }
            }

            // Track palette expansion so it can be applied AFTER per-param writes —
            // otherwise paletteOffset/Amp/Freq/Phase/Mode in stepParams (which carry
            // the spec defaults from ProgramState) would clobber the expanded values.
            let paletteExpansion = null

            for (const [paramName, value] of Object.entries(stepParams)) {
                if (paramName === '_skip') continue  // Skip internal flags

                if (isAutomationControlled(value)) continue

                const spec = effectDef.globals[paramName]
                if (!spec || spec.type === 'surface') continue

                const uniformName = spec.uniform || paramName

                // Skip uniforms controlled by colorModeUniform (they're set by expander based on surface)
                if (colorModeControlledUniforms.has(uniformName)) continue

                if (!pass.uniforms || !(uniformName in pass.uniforms)) continue

                // Consumer passes inherit volumeSize from the upstream source
                // emitter — their own step-state default is stale. Writing it
                // would clobber the chain-scoped variant via the scopedParams
                // propagation below, breaking atlas sizing for the whole chain.
                if (uniformName === 'volumeSize' && pass.inheritsVolumeSize) continue

                const converted = this.convertParameterForUniform(value, spec)
                pass.uniforms[uniformName] = Array.isArray(converted) ? converted.slice() : converted

                // Propagate to chain-scoped variant so resolveDimension() sees the update,
                // and broadcast to other chain members so collectDefaultUniforms() merges
                // consistently and consumer shaders pick up the new size.
                if (pass.scopedParams && pass.scopedParams[uniformName]) {
                    const scopedName = pass.scopedParams[uniformName]
                    pass.uniforms[scopedName] = pass.uniforms[uniformName]
                    scopedParamChanged = true
                    this._pipeline.broadcastChainScopedParam(pass, uniformName, scopedName)
                }

                if (spec.type === 'palette') {
                    paletteExpansion = expandPalette(converted)
                }
            }

            if (paletteExpansion) {
                for (const [uName, uValue] of Object.entries(paletteExpansion)) {
                    if (uName in pass.uniforms) {
                        pass.uniforms[uName] = Array.isArray(uValue) ? uValue.slice() : uValue
                    }
                }
            }

            // Mirror the demo program-state path: a changed non-alpha param on
            // an asyncInit effect (fibers/scratches/strayHair CPU overlays)
            // must re-render its overlay texture. checkAsyncRegen caches
            // per-node param values and debounces, so unchanged params no-op.
            if (pass.nodeId) {
                this._pipeline.checkAsyncRegen?.(pass.nodeId, effectKey, stepParams)
            }
        }

        // A chain-scoped param (e.g. zoom_chain_N) drives screenDivide-sized
        // simulation buffers. When one changes, recompute affected texture
        // dimensions; recreateTextures is a no-op for unchanged sizes.
        if (scopedParamChanged && this._pipeline.recreateTextures) {
            this._pipeline.recreateTextures(this._pipeline.collectDefaultUniforms())
        }
    }
}

// Re-export getEffect for convenience
export { getEffect }
