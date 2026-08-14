/**
 * Demo UI Module for Noisemaker Shader Demo
 *
 * Handles all UI-specific logic: controls, dialogs, selectors, DSL editing.
 * Works in conjunction with CanvasRenderer for the rendering pipeline.
 *
 * @example
 * import { UIController } from './lib/demo-ui.js';
 * import { CanvasRenderer } from '../../shaders/src/renderer/canvas.js';
 *
 * const renderer = new CanvasRenderer({ canvas, ... });
 * const ui = new UIController(renderer, {
 *     effectSelect: document.getElementById('effect-select'),
 *     dslEditor: document.getElementById('dsl-editor'),
 *     controlsContainer: document.getElementById('effect-controls-container'),
 *     statusEl: document.getElementById('status'),
 *     ...
 * });
 */

import { unparseCall, formatValue, formatDslError, isDslSyntaxError } from '../../../shaders/src/lang/index.js'
import {
    getEffect,
    cloneParamValue,
    isStarterEffect,
    hasTexSurfaceParam,
    hasExplicitTexParam,
    getVolGeoParams,
    is3dGenerator,
    is3dProcessor,
    sanitizeEnumName
} from '../../../shaders/src/renderer/canvas.js'
import { groupGlobalsByCategory } from '../../../shaders/src/runtime/effect.js'
import { defaultControlFactory } from './control-factory.js'
// Handfish toast functions — set via setToastProvider(), falls back to console
let showSuccess = (m) => console.log(m)
let showError = (m) => console.error(m)
let showInfo = (m) => console.log(m)

export function setToastProvider(provider) {
    if (provider.showSuccess) showSuccess = provider.showSuccess
    if (provider.showError) showError = provider.showError
    if (provider.showInfo) showInfo = provider.showInfo
}

import { ProgramState } from './program-state.js'
import { extractEffectsFromDsl } from './dsl-utils.js'

// Re-export for backward compatibility
export { extractEffectsFromDsl } from './dsl-utils.js'

/**
 * Convert camelCase to space-separated lowercase words
 * @param {string} str - camelCase string
 * @returns {string} Space-separated lowercase string
 * @example
 * camelToSpaceCase('someEffectName') // 'some effect name'
 * camelToSpaceCase('posterize') // 'posterize'
 */
export function camelToSpaceCase(str) {
    if (typeof str !== 'string') return ''
    return str
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
}

/**
 * Format enum name for DSL output - quote if not a valid identifier
 * @param {string} name - Name to format
 * @returns {string} Formatted name
 */
export function formatEnumName(name) {
    const sanitized = sanitizeEnumName(name)
    if (sanitized !== null) {
        return sanitized
    }
    // Can't be an identifier - quote it as a string
    return `"${name.replace(/"/g, '\\"')}"`
}

/**
 * Create a callback for looking up effect definitions
 * Handles various naming formats: "filter.grade", "filter/grade", "grade"
 * @param {function} getEffect - Effect lookup function
 * @returns {function} Callback for getEffectDef option
 */
export function createEffectDefCallback(getEffect) {
    return (effectName, namespace) => {
        // effectName might be "filter.grade" or just "grade"
        // Try direct lookup first
        let def = getEffect(effectName)
        if (def) return def

        // Try with "/" instead of "." (e.g., "filter/grade")
        if (effectName.includes('.')) {
            def = getEffect(effectName.replace('.', '/'))
            if (def) return def
        }

        // If namespace provided separately, try combining
        if (namespace) {
            def = getEffect(`${namespace}/${effectName}`) ||
                  getEffect(`${namespace}.${effectName}`)
            if (def) return def
        }

        return null
    }
}

/**
 * Extract effect names from DSL text without compiling (for lazy loading)
 * @param {string} dsl - DSL source
 * @param {object} manifest - Shader manifest
 * @returns {Array} Array of { effectId, namespace, name }
 */
export function extractEffectNamesFromDsl(dsl, manifest) {
    const effects = []
    if (!dsl || typeof dsl !== 'string') return effects


    const lines = dsl.split('\n')
    let searchNamespaces = []

    for (const line of lines) {
        const trimmed = line.trim()

        // Handle semicolon-separated statements on one line
        // Split by semicolon and process each statement
        const statements = trimmed.split(';').map(s => s.trim()).filter(s => s)

        for (const stmt of statements) {
            if (stmt.startsWith('search ')) {
                searchNamespaces = stmt.slice(7).split(',').map(s => s.trim())
                continue
            }

            if (!stmt || stmt.startsWith('//')) continue

            // Handle from(namespace, call(...)) syntax
            // Pattern: from(namespace, effectName(...))
            const fromPattern = /\bfrom\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
            let fromMatch
            while ((fromMatch = fromPattern.exec(stmt)) !== null) {
                const namespace = fromMatch[1]
                const name = fromMatch[2]
                const effectId = `${namespace}/${name}`
                if (manifest[effectId] && !effects.find(e => e.effectId === effectId)) {
                    effects.push({ effectId, namespace, name })
                }
            }

            const callPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*\(/g
            let match

            while ((match = callPattern.exec(stmt)) !== null) {
                const fullName = match[1]
                let namespace = null
                let name = fullName

                if (fullName.includes('.')) {
                    const parts = fullName.split('.')
                    namespace = parts[0]
                    name = parts[1]
                }

                // Skip 'from' itself as it's handled above
                const builtins = ['read', 'out', 'vec2', 'vec3', 'vec4', 'from']
                if (builtins.includes(name)) continue

                if (!namespace && searchNamespaces.length > 0) {
                    for (const ns of searchNamespaces) {
                        const testId = `${ns}/${name}`
                        if (manifest[testId]) {
                            namespace = ns
                            break
                        }
                    }
                }

                if (!namespace) {
                    for (const ns of ['classicNoisedeck', 'filter', 'mixer', 'synth']) {
                        const testId = `${ns}/${name}`
                        if (manifest[testId]) {
                            namespace = ns
                            break
                        }
                    }
                }

                if (namespace) {
                    const effectId = `${namespace}/${name}`
                    if (!effects.find(e => e.effectId === effectId)) {
                        effects.push({ effectId, namespace, name })
                    }
                }
            }
        }
    }

    return effects
}

/**
 * Get backend from URL query parameter
 * @returns {string|null} Backend name or null
 */
export function getBackendFromURL() {
    const params = new URLSearchParams(window.location.search)
    return params.get('backend')
}

/**
 * Get bundle mode from URL query parameter
 * @returns {boolean} Whether to use pre-built bundles
 */
export function getUseBundlesFromURL() {
    const params = new URLSearchParams(window.location.search)
    return params.get('bundles') === '1' || params.get('bundles') === 'true'
}

/**
 * Get effect from URL query parameter
 * @returns {string|null} Effect path (namespace/name) or null
 */
export function getEffectFromURL() {
    const params = new URLSearchParams(window.location.search)
    const effectParam = params.get('effect')

    if (!effectParam) return null

    const parts = effectParam.split('.')
    if (parts.length === 2) {
        return `${parts[0]}/${parts[1]}`
    }

    return null
}

/**
 * UIController class - handles all UI interactions for the shader demo
 */
export class UIController {
    /**
     * Create a new UIController instance
     * @param {CanvasRenderer} renderer - The canvas renderer instance
     * @param {object} options - UI element references
     * @param {HTMLSelectElement} options.effectSelect - Effect selector element
     * @param {HTMLTextAreaElement} options.dslEditor - DSL editor element
     * @param {HTMLElement} options.controlsContainer - Effect controls container
     * @param {HTMLElement} options.statusEl - Status message element
     * @param {HTMLElement} [options.fpsCounterEl] - FPS counter display element
     * @param {HTMLDialogElement} [options.loadingDialog] - Loading dialog element
     * @param {HTMLElement} [options.loadingDialogTitle] - Loading dialog title
     * @param {HTMLElement} [options.loadingDialogStatus] - Loading dialog status
     * @param {HTMLElement} [options.loadingDialogProgress] - Loading dialog progress bar
     * @param {function} [options.onControlChange] - Callback when a control value changes
     * @param {function} [options.onEffectControlsReset] - Callback(stepIndex, effectElement, effectDef) after a effect's controls are rebuilt via reset button
     * @param {ControlFactory} [options.controlFactory] - Custom control factory for web components
     */
    constructor(renderer, options = {}) {
        this._renderer = renderer

        // Control factory - allows downstream projects to substitute web components
        this._controlFactory = options.controlFactory || defaultControlFactory

        // DOM elements
        this._effectSelect = options.effectSelect
        this._dslEditor = options.dslEditor
        this._controlsContainer = options.controlsContainer
        this._statusEl = options.statusEl
        this._fpsCounterEl = options.fpsCounterEl
        this._loadingDialog = options.loadingDialog
        this._loadingDialogTitle = options.loadingDialogTitle
        this._loadingDialogStatus = options.loadingDialogStatus
        this._loadingDialogProgress = options.loadingDialogProgress

        // Callbacks
        this._onControlChangeCallback = options.onControlChange || null
        this._onRequestRecompileCallback = options.onRequestRecompile || null
        this._onEffectControlsResetCallback = options.onEffectControlsReset || null

        // State
        this._parameterValues = {}
        this._dependentControls = [] // Array of {element, effectKey, paramKey, enabledBy, enabledByKey}

        // Create ProgramState instance for decoupled state management
        this._programState = new ProgramState({ renderer })

        // Subscribe to ProgramState events for backward compatibility
        this._programState.on('change', () => {
            this._onControlChangeCallback?.()
        })

        // Recompile the pipeline when ProgramState detects a mutation to a
        // compile-time-define-flagged global. The expander bakes those values
        // into the shader source, so a runtime setUniform write does nothing —
        // we have to regenerate the DSL and ask the renderer to recompile.
        // ProgramState coalesces batches into a single event so we never
        // recompile more than once per user interaction.
        this._programState.on('recompileNeeded', () => {
            this._updateDslFromEffectParams()
            this._recompilePipeline()
        })
        this._shaderOverrides = {} // Map: stepIndex -> { programName: { glsl?, wgsl?, fragment?, vertex? } }
        this._parsedDslStructure = []
        this._allEffects = []

        // Media input state per step
        // Map: stepIndex -> { source, stream, videoEl, imageEl, textureId, updateFrame }
        this._mediaInputs = new Map()
        this._mediaUpdateFrame = null

        // Text input state per step
        // Map: stepIndex -> { canvas, textureId, textContent, font, size, posX, posY, color, rotation, bgColor, bgOpacity }
        this._textInputs = new Map()

        // Mesh input state per step
        // Map: stepIndex -> { meshId, url, loaded, vertexCount }
        this._meshInputs = new Map()

        // Loading state
        this._loadingState = {
            queue: [],
            completed: 0,
            total: 0
        }

        // Bind the formatValue function with enums context
        this._boundFormatValue = (value, spec) => formatValue(value, spec, { enums: this._renderer.enums })

        // Start the media update loop
        this._startMediaUpdateLoop()
    }

    /** Push current step parameter values to the renderer pipeline */
    _applyStepParams() {
        this._renderer.applyStepParameterValues?.(this._programState.getAllStepValues())
    }

    // =========================================================================
    // ProgramState Access
    // =========================================================================

    /**
     * Get the ProgramState instance for decoupled state management
     * @returns {ProgramState}
     */
    get programState() {
        return this._programState
    }

    // =========================================================================
    // Media Input Management
    // =========================================================================

    /**
     * Start the continuous media update loop
     * @private
     */
    _startMediaUpdateLoop() {
        if (this._mediaUpdateFrame) return

        const update = () => {
            this._updateAllMediaTextures()
            this._mediaUpdateFrame = requestAnimationFrame(update)
        }

        update()
    }

    /**
     * Stop the media update loop
     * @private
     */
    _stopMediaUpdateLoop() {
        if (this._mediaUpdateFrame) {
            cancelAnimationFrame(this._mediaUpdateFrame)
            this._mediaUpdateFrame = null
        }
    }

    /**
     * Re-upload all active media textures (e.g., after backend switch destroys GPU resources)
     */
    reuploadAllMediaTextures() {
        for (const [stepIndex, media] of this._mediaInputs) {
            if (!media.source) continue
            this._updateMediaTexture(stepIndex)
        }
        this._applyStepParams()
    }

    /**
     * Update all media textures that need continuous updates (video/camera)
     * @private
     */
    _updateAllMediaTextures() {
        let anyUpdated = false
        for (const [stepIndex, media] of this._mediaInputs) {
            if (!media.source) continue

            // Only update video sources continuously
            if (media.source instanceof HTMLVideoElement) {
                if (!media.source.paused && media.source.videoWidth > 0) {
                    this._updateMediaTexture(stepIndex)
                    anyUpdated = true
                }
            }
        }

        // Apply step-specific parameter values (including imageSize) to the pipeline
        if (anyUpdated) {
            this._applyStepParams()
        }
    }

    /**
     * Update a single media texture
     * @param {number} stepIndex - Step index
     * @private
     */
    _updateMediaTexture(stepIndex) {
        const media = this._mediaInputs.get(stepIndex)
        if (!media || !media.source || !this._renderer._pipeline) return

        const texId = media.textureId
        // Don't flip Y - the mediaInput shader handles UV flipping internally (st.y = 1.0 - st.y)
        const resultOrPromise = this._renderer.updateTextureFromSource(texId, media.source, { flipY: false })

        const applySize = (result) => {
            if (result.width > 0 && result.height > 0) {
                const effectKey = `step_${stepIndex}`
                this._programState.setValue(effectKey, 'imageSize', [result.width, result.height])
            }
        }

        if (resultOrPromise && typeof resultOrPromise.then === 'function') {
            resultOrPromise.then(applySize).catch(() => {})
        } else {
            applySize(resultOrPromise)
        }
    }

    /**
     * Create media input controls section for an effect
     * @param {number} stepIndex - Step index for this effect
     * @param {string} textureId - Texture ID (e.g., 'imageTex')
     * @param {object} effectDef - Effect definition
     * @param {boolean} skipDefaultLoad - If true, skip loading the default test image
     * @returns {HTMLElement} Media input controls container
     * @private
     */
    _createMediaInputSection(stepIndex, textureId, effectDef, skipDefaultLoad = false) {
        const section = document.createElement('div')
        section.className = 'media-input-section'

        // Initialize media state for this step
        if (!this._mediaInputs.has(stepIndex)) {
            this._mediaInputs.set(stepIndex, {
                source: null,
                stream: null,
                videoEl: null,
                imageEl: null,
                textureId: textureId
            })
        }

        // Source type selector (file vs camera)
        const sourceGroup = document.createElement('div')
        sourceGroup.className = 'control-group'

        const sourceLabel = document.createElement('span')
        sourceLabel.className = 'control-label'
        sourceLabel.textContent = 'media source'
        sourceGroup.appendChild(sourceLabel)

        const sourceRadios = document.createElement('div')
        sourceRadios.className = 'media-source-radios'

        const radioName = `media-source-${stepIndex}`;

        ['file', 'camera'].forEach(type => {
            const radioLabel = document.createElement('label')

            const radio = document.createElement('input')
            radio.type = 'radio'
            radio.name = radioName
            radio.value = type
            radio.checked = type === 'file'

            radioLabel.appendChild(radio)
            radioLabel.appendChild(document.createTextNode(type))
            sourceRadios.appendChild(radioLabel)
        })

        sourceGroup.appendChild(sourceRadios)
        section.appendChild(sourceGroup)

        // File input group
        const fileGroup = document.createElement('div')
        fileGroup.className = 'control-group media-file-group'
        fileGroup.dataset.stepIndex = stepIndex

        const fileLabel = document.createElement('span')
        fileLabel.className = 'control-label'
        fileLabel.textContent = 'media file'
        fileGroup.appendChild(fileLabel)

        const fileInput = document.createElement('input')
        fileInput.type = 'file'
        fileInput.accept = 'image/*,video/*'
        fileInput.className = 'media-file-input'
        fileInput.dataset.stepIndex = stepIndex
        fileInput.dataset.textureId = textureId

        fileInput.addEventListener('change', (e) => this._handleMediaFileChange(e, stepIndex))

        fileGroup.appendChild(fileInput)
        section.appendChild(fileGroup)

        // Camera group (hidden by default)
        const cameraGroup = document.createElement('div')
        cameraGroup.className = 'control-group media-camera-group'
        cameraGroup.style.display = 'none'
        cameraGroup.dataset.stepIndex = stepIndex

        const cameraLabel = document.createElement('span')
        cameraLabel.className = 'control-label'
        cameraLabel.textContent = 'camera'
        cameraGroup.appendChild(cameraLabel)

        // Camera select starts with placeholder - populated dynamically by _enumerateCameras
        const cameraHandle = this._controlFactory.createSelect({
            choices: [{ value: '', label: 'select camera...' }],
            value: '',
            className: 'hf-input'
        })
        const cameraSelect = cameraHandle.element
        cameraSelect.dataset.stepIndex = stepIndex
        cameraGroup.appendChild(cameraSelect)

        const cameraButtons = document.createElement('div')
        cameraButtons.className = 'media-camera-buttons'

        const startBtn = document.createElement('button')
        startBtn.className = 'hf-action-btn'
        startBtn.textContent = 'start'
        startBtn.addEventListener('click', () => this._startCamera(stepIndex, cameraHandle.getValue()))

        const stopBtn = document.createElement('button')
        stopBtn.className = 'hf-action-btn'
        stopBtn.textContent = 'stop'
        stopBtn.disabled = true
        stopBtn.addEventListener('click', () => this._stopCamera(stepIndex))

        cameraButtons.appendChild(startBtn)
        cameraButtons.appendChild(stopBtn)
        cameraGroup.appendChild(cameraButtons)

        // Store button refs in the section for later access
        cameraGroup._startBtn = startBtn
        cameraGroup._stopBtn = stopBtn
        cameraGroup._select = cameraSelect
        cameraGroup._selectHandle = cameraHandle

        section.appendChild(cameraGroup)

        // Status display
        const statusGroup = document.createElement('div')
        statusGroup.className = 'control-group'

        const statusLabel = document.createElement('span')
        statusLabel.className = 'control-label'
        statusLabel.textContent = 'status'
        statusGroup.appendChild(statusLabel)

        const statusSpan = document.createElement('span')
        statusSpan.className = 'media-status'
        statusSpan.textContent = 'no media loaded'
        statusSpan.dataset.stepIndex = stepIndex

        statusGroup.appendChild(statusSpan)
        section.appendChild(statusGroup)

        // Hidden video/image elements for this step
        const video = document.createElement('video')
        video.style.display = 'none'
        video.loop = true
        video.muted = true
        video.playsInline = true
        section.appendChild(video)

        const image = document.createElement('img')
        image.style.display = 'none'
        section.appendChild(image)

        // Store refs in media state
        const mediaState = this._mediaInputs.get(stepIndex)
        mediaState.videoEl = video
        mediaState.imageEl = image
        mediaState.statusEl = statusSpan
        mediaState.cameraGroup = cameraGroup
        mediaState.fileGroup = fileGroup

        // Radio button change handler
        sourceRadios.addEventListener('change', (e) => {
            if (e.target.value === 'camera') {
                fileGroup.style.display = 'none'
                cameraGroup.style.display = 'block'
                this._populateCameraList(stepIndex, cameraHandle)
            } else {
                fileGroup.style.display = 'block'
                cameraGroup.style.display = 'none'
                this._stopCamera(stepIndex)
                // Restore previous image source if available
                const media = this._mediaInputs.get(stepIndex)
                if (media?.imageEl?.complete && media.imageEl.naturalWidth > 0) {
                    media.source = media.imageEl
                    this._updateMediaTexture(stepIndex)
                    this._applyStepParams()
                }
            }
        })

        // Load default test image (skip if we're going to restore previous state)
        if (!skipDefaultLoad) {
            this._loadDefaultMediaImage(stepIndex)
        }

        return section
    }

    /**
     * Create mesh input section for effects with externalMesh property.
     * Provides a URL input field and loads OBJ files.
     * @private
     * @param {number} stepIndex - Step index in the DSL program
     * @param {string} meshId - Target mesh surface ID (e.g., 'mesh0')
     * @returns {HTMLElement}
     */
    _createMeshInputSection(stepIndex, meshId, builtinMeshes) {
        const section = document.createElement('div')
        section.className = 'mesh-input-section'

        // Initialize mesh state for this step
        if (!this._meshInputs.has(stepIndex)) {
            this._meshInputs.set(stepIndex, {
                meshId: meshId,
                loaded: false,
                vertexCount: 0
            })
        }

        // Built-in shape dropdown (if available)
        if (builtinMeshes) {
            const shapeGroup = document.createElement('div')
            shapeGroup.className = 'control-group'

            const shapeLabel = document.createElement('span')
            shapeLabel.className = 'control-label'
            shapeLabel.textContent = 'shape'
            shapeGroup.appendChild(shapeLabel)

            const select = document.createElement('select')
            select.className = 'mesh-shape-select'

            const noneOption = document.createElement('option')
            noneOption.value = ''
            noneOption.textContent = '(custom file)'
            select.appendChild(noneOption)

            for (const name of Object.keys(builtinMeshes)) {
                const option = document.createElement('option')
                option.value = name
                option.textContent = name
                select.appendChild(option)
            }

            select.addEventListener('change', () => {
                const shapeName = select.value
                if (shapeName && builtinMeshes[shapeName]) {
                    this._loadBuiltinMesh(stepIndex, shapeName, builtinMeshes[shapeName])
                }
            })

            shapeGroup.appendChild(select)
            section.appendChild(shapeGroup)
        }

        // File input group
        const fileGroup = document.createElement('div')
        fileGroup.className = 'control-group'

        const fileLabel = document.createElement('span')
        fileLabel.className = 'control-label'
        fileLabel.textContent = 'OBJ file'
        fileGroup.appendChild(fileLabel)

        const fileInput = document.createElement('input')
        fileInput.type = 'file'
        fileInput.accept = '.obj'
        fileInput.className = 'mesh-file-input'
        fileInput.dataset.stepIndex = stepIndex
        fileInput.dataset.meshId = meshId

        fileInput.addEventListener('change', (e) => this._handleMeshFileChange(e, stepIndex))

        fileGroup.appendChild(fileInput)
        section.appendChild(fileGroup)

        // Status display
        const statusGroup = document.createElement('div')
        statusGroup.className = 'control-group'

        const statusLabel = document.createElement('span')
        statusLabel.className = 'control-label'
        statusLabel.textContent = 'status'
        statusGroup.appendChild(statusLabel)

        const statusSpan = document.createElement('span')
        statusSpan.className = 'mesh-status'
        statusSpan.textContent = 'no mesh loaded'
        statusSpan.dataset.stepIndex = stepIndex

        statusGroup.appendChild(statusSpan)
        section.appendChild(statusGroup)

        // Store refs in mesh state
        const meshState = this._meshInputs.get(stepIndex)
        meshState.statusEl = statusSpan

        // Auto-load the first built-in shape (after statusEl is set up)
        if (builtinMeshes) {
            const builtinNames = Object.keys(builtinMeshes)
            if (builtinNames.length > 0) {
                const defaultShape = builtinNames[0]
                const select = section.querySelector('.mesh-shape-select')
                if (select) select.value = defaultShape
                this._loadBuiltinMesh(stepIndex, defaultShape, builtinMeshes[defaultShape])
            }
        }

        return section
    }

    /**
     * Handle mesh file selection
     * @private
     */
    async _handleMeshFileChange(e, stepIndex) {
        const file = e.target.files[0]
        if (!file) return

        const meshState = this._meshInputs.get(stepIndex)
        if (!meshState) return

        meshState.statusEl.textContent = 'loading...'

        try {
            const text = await file.text()
            const result = await this._renderer.loadOBJFromString(text, meshState.meshId)

            if (result.success) {
                meshState.loaded = true
                meshState.vertexCount = result.vertexCount
                meshState.statusEl.textContent = `${file.name}: ${result.vertexCount} vertices`
            } else {
                meshState.statusEl.textContent = `error: ${result.error || 'unknown'}`
            }
        } catch (err) {
            meshState.statusEl.textContent = `error: ${err.message}`
        }
    }

    /**
     * Load a built-in mesh from a bundled OBJ file
     * @private
     */
    async _loadBuiltinMesh(stepIndex, shapeName, relativePath) {
        const meshState = this._meshInputs.get(stepIndex)
        if (!meshState) return

        meshState.statusEl.textContent = 'loading...'

        try {
            // Resolve relative to renderer's basePath (e.g. "../../shaders" or bundled URL)
            const basePath = this._renderer._basePath || '../../shaders'
            const url = `${basePath}/${relativePath}`
            const result = await this._renderer.loadOBJFromURL(url, meshState.meshId)

            if (result.success) {
                meshState.loaded = true
                meshState.vertexCount = result.vertexCount
                meshState.statusEl.textContent = `${shapeName}: ${result.vertexCount} vertices`
            } else {
                meshState.statusEl.textContent = `error: ${result.error || 'unknown'}`
            }
        } catch (err) {
            meshState.statusEl.textContent = `error: ${err.message}`
        }
    }

    /**
     * Handle media file change
     * @private
     */
    _handleMediaFileChange(e, stepIndex) {
        const file = e.target.files[0]
        if (!file) return

        const media = this._mediaInputs.get(stepIndex)
        if (!media) return

        const url = URL.createObjectURL(file)

        if (file.type.startsWith('video/')) {
            media.videoEl.src = url
            media.videoEl.load()

            media.videoEl.onloadedmetadata = () => {
                media.source = media.videoEl
                media.statusEl.textContent = `video: ${media.videoEl.videoWidth}x${media.videoEl.videoHeight}`
                media.videoEl.play()
                this._updateMediaTexture(stepIndex)
                this._applyStepParams()
            }
        } else if (file.type.startsWith('image/')) {
            media.imageEl.src = url
            media.imageEl.onload = () => {
                media.source = media.imageEl
                media.statusEl.textContent = `image: ${media.imageEl.naturalWidth}x${media.imageEl.naturalHeight}`
                this._updateMediaTexture(stepIndex)
                this._applyStepParams()
            }
        }
    }

    /**
     * Populate camera list for a step
     * @private
     * @param {number} stepIndex - The step index
     * @param {object} selectHandle - The ControlHandle from createSelect
     */
    async _populateCameraList(stepIndex, selectHandle) {
        const media = this._mediaInputs.get(stepIndex)

        try {
            // First, request camera permission to get proper device labels
            // This triggers the browser's permission prompt if not already granted
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
            // Stop the temp stream immediately - we just needed permission
            tempStream.getTracks().forEach(track => track.stop())

            // Now enumerate devices - labels will be available after permission granted
            const devices = await navigator.mediaDevices.enumerateDevices()
            const videoDevices = devices.filter(d => d.kind === 'videoinput')

            // Build choices array for the control factory
            const choices = [{ value: '', label: 'select camera...' }]
            videoDevices.forEach((device, idx) => {
                choices.push({
                    value: device.deviceId,
                    label: device.label || `Camera ${idx + 1}`
                })
            })

            // Update the select control via handle
            selectHandle.setChoices(choices)

            if (media?.statusEl) {
                media.statusEl.textContent = videoDevices.length > 0
                    ? `${videoDevices.length} camera(s) found`
                    : 'no cameras found'
            }
        } catch (err) {
            console.error('Failed to access camera:', err)
            if (media?.statusEl) {
                media.statusEl.textContent = `camera error: ${err.message}`
            }
            selectHandle.setChoices([{ value: '', label: 'camera access denied' }])
        }
    }

    /**
     * Start camera for a step
     * @private
     */
    async _startCamera(stepIndex, deviceId) {
        if (!deviceId) {
            const media = this._mediaInputs.get(stepIndex)
            if (media?.statusEl) {
                media.statusEl.textContent = 'please select a camera'
            }
            return
        }

        const media = this._mediaInputs.get(stepIndex)
        if (!media) return

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId } }
            })

            media.stream = stream
            media.videoEl.srcObject = stream
            await media.videoEl.play()

            media.source = media.videoEl
            media.statusEl.textContent = `camera: ${media.videoEl.videoWidth}x${media.videoEl.videoHeight}`

            // Update button states
            if (media.cameraGroup) {
                media.cameraGroup._startBtn.disabled = true
                media.cameraGroup._stopBtn.disabled = false
            }

            this._updateMediaTexture(stepIndex)
            // Apply step-specific parameters to the pipeline
            this._applyStepParams()
        } catch (err) {
            console.error('Failed to start camera:', err)
            media.statusEl.textContent = `camera error: ${err.message}`
        }
    }

    /**
     * Stop camera for a step
     * @private
     */
    _stopCamera(stepIndex) {
        const media = this._mediaInputs.get(stepIndex)
        if (!media) return

        if (media.stream) {
            media.stream.getTracks().forEach(track => track.stop())
            media.stream = null
        }

        media.videoEl.srcObject = null
        media.source = null
        media.statusEl.textContent = 'camera stopped'

        // Update button states
        if (media.cameraGroup) {
            media.cameraGroup._startBtn.disabled = false
            media.cameraGroup._stopBtn.disabled = true
        }
    }

    /**
     * Stop all cameras and clean up media state
     * @param {boolean} preserveState - If true, only stop streams but keep state for restoration
     */
    stopAllMedia(preserveState = false) {
        for (const [, media] of this._mediaInputs) {
            if (media.stream) {
                media.stream.getTracks().forEach(track => track.stop())
            }
        }
        if (!preserveState) {
            this._mediaInputs.clear()
        }
    }

    /**
     * Preserve media state keyed by occurrence for later restoration
     * @returns {Object} Map of occurrenceKey -> preserved media state
     * @private
     */
    _preserveMediaState() {
        const previousMediaByOccurrence = {}
        if (!this._parsedDslStructure || this._mediaInputs.size === 0) {
            return previousMediaByOccurrence
        }

        const occurrenceCount = {}
        for (const effectInfo of this._parsedDslStructure) {
            const effectName = effectInfo.effectKey || effectInfo.name
            const occurrence = occurrenceCount[effectName] || 0
            occurrenceCount[effectName] = occurrence + 1

            const media = this._mediaInputs.get(effectInfo.stepIndex)
            if (!media) continue

            const occurrenceKey = `${effectName}#${occurrence}`

            // Determine source type from UI state (which group is visible), not stream presence
            // This preserves camera selection even if camera was stopped
            let sourceType = 'file'
            if (media.cameraGroup && media.cameraGroup.style.display !== 'none') {
                sourceType = 'camera'
            }

            // Preserve the source type, source element, and URL
            previousMediaByOccurrence[occurrenceKey] = {
                sourceType,
                // For file sources, preserve the source element and its src
                source: media.source,
                imageSrc: media.imageEl?.src || null,
                videoSrc: media.videoEl?.src || null,
                isVideo: media.source instanceof HTMLVideoElement && !media.stream,
                // For camera, preserve the selected device ID
                cameraDeviceId: media.cameraGroup?._selectHandle?.getValue() || null
            }
        }
        return previousMediaByOccurrence
    }

    /**
     * Restore media state from preserved state
     * @param {number} stepIndex - Step index
     * @param {Object} preserved - Preserved media state
     * @private
     */
    _restoreMediaFromPreviousState(stepIndex, preserved) {
        const media = this._mediaInputs.get(stepIndex)
        if (!media || !preserved) return

        // Find the radio buttons and set the correct source type
        const radioName = `media-source-${stepIndex}`
        const radios = document.querySelectorAll(`input[name="${radioName}"]`)
        const isCameraSource = preserved.sourceType === 'camera'

        for (const radio of radios) {
            radio.checked = radio.value === preserved.sourceType
        }

        // Show/hide the appropriate groups
        if (media.fileGroup && media.cameraGroup) {
            media.fileGroup.style.display = isCameraSource ? 'none' : 'block'
            media.cameraGroup.style.display = isCameraSource ? 'block' : 'none'
        }

        // For file sources, restore the source element
        if (preserved.sourceType === 'file' && preserved.source) {
            if (preserved.isVideo && preserved.videoSrc) {
                // Restore video source
                media.videoEl.src = preserved.videoSrc
                media.videoEl.load()
                media.videoEl.onloadedmetadata = () => {
                    media.source = media.videoEl
                    media.statusEl.textContent = `video: ${media.videoEl.videoWidth}x${media.videoEl.videoHeight}`
                    media.videoEl.play()
                    this._updateMediaTexture(stepIndex)
                    this._applyStepParams()
                }
            } else if (preserved.imageSrc) {
                // Restore image source
                const completeRestore = () => {
                    media.source = media.imageEl
                    media.statusEl.textContent = `image: ${media.imageEl.naturalWidth}x${media.imageEl.naturalHeight}`
                    this._updateMediaTexture(stepIndex)
                    this._applyStepParams()
                }

                media.imageEl.onload = completeRestore
                media.imageEl.onerror = () => {
                    media.statusEl.textContent = 'failed to restore image'
                }
                media.imageEl.src = preserved.imageSrc

                // Handle already-loaded/cached images (onload won't fire)
                if (media.imageEl.complete && media.imageEl.naturalWidth > 0) {
                    completeRestore()
                }
            }
        } else if (preserved.sourceType === 'camera') {
            // For camera, populate the camera list (user must re-start manually)
            if (media.cameraGroup?._selectHandle) {
                this._populateCameraList(stepIndex, media.cameraGroup._selectHandle)
                    .then(() => {
                        // Pre-select the previous camera device if available
                        if (preserved.cameraDeviceId && media.cameraGroup._selectHandle) {
                            media.cameraGroup._selectHandle.setValue(preserved.cameraDeviceId)
                        }
                    })
            }
            media.statusEl.textContent = 'camera stopped (re-select to start)'
        }
    }

    /**
     * Load default test image for a step
     * @private
     */
    async _loadDefaultMediaImage(stepIndex) {
        const media = this._mediaInputs.get(stepIndex)
        if (!media) return

        const img = new Image()
        img.onload = () => {
            media.source = img
            media.imageEl.src = img.src
            media.statusEl.textContent = `default: ${img.naturalWidth}x${img.naturalHeight}`
            this._updateMediaTexture(stepIndex)
            // Apply step-specific parameters to the pipeline
            this._applyStepParams()
        }
        img.onerror = () => {
            media.statusEl.textContent = 'no media loaded'
        }
        img.src = 'img/testcard.png'
    }

    // =========================================================================
    // Text Input Management
    // =========================================================================

    /**
     * Initialize text canvas for effects with externalTexture = 'textTex'
     * Reads initial values from globals in definition, syncs with effectParameterValues
     * @param {number} stepIndex - Step index for this effect
     * @param {string} effectKey - Effect key (e.g., 'step_0')
     * @param {Object} effectDef - Effect definition with globals
     * @private
     */
    _initTextCanvas(stepIndex, effectKey, effectDef) {
        const stepTextureId = `${effectDef.externalTexture}_step_${stepIndex}`

        // Create hidden canvas for text rendering
        const canvas = document.createElement('canvas')
        canvas.style.display = 'none'
        document.body.appendChild(canvas)

        // Get initial values from programState
        const params = this._programState.getStepValues(effectKey) || {}

        // Initialize text state for this step
        this._textInputs.set(stepIndex, {
            canvas,
            textureId: stepTextureId,
            effectKey,
            textContent: params.text,
            font: params.font,
            size: params.size,
            posX: params.posX,
            posY: params.posY,
            color: params.color,
            rotation: params.rotation,
            bgColor: params.bgColor,
            bgOpacity: params.bgOpacity,
            justify: params.justify
        })

        // Initial render after a short delay to ensure pipeline is ready
        setTimeout(() => this._renderTextToCanvas(stepIndex), 50)
    }

    /**
     * Parse hex color to RGB array (0-1 range)
     * @private
     */
    _hexToRgb(hex) {
        // If already an array, return it directly
        if (Array.isArray(hex)) {
            return hex.slice(0, 3)
        }
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
        return result ? [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ] : [1, 1, 1]
    }

    /**
     * Render text to canvas and upload to texture
     * @param {number} stepIndex - Step index
     * @private
     */
    _renderTextToCanvas(stepIndex) {
        const textState = this._textInputs.get(stepIndex)
        if (!textState || !this._renderer?._pipeline) return

        const canvas = textState.canvas
        const resolution = this._renderer._width
        canvas.width = resolution
        canvas.height = resolution

        const ctx = canvas.getContext('2d')

        // Clear to transparent - background blending is handled by the shader
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // Get text parameters
        const text = String(textState.textContent || '')
        const lines = text.split('\n')
        const fontSize = Math.round(textState.size * canvas.height)
        const lineHeight = fontSize * 1.2
        const textColor = this._hexToRgb(textState.color)
        const rotation = textState.rotation * Math.PI / 180
        const justify = textState.justify

        // Set up text rendering
        ctx.font = `${fontSize}px ${textState.font}`
        ctx.textAlign = justify
        ctx.textBaseline = 'middle'
        ctx.fillStyle = `rgba(${Math.round(textColor[0]*255)}, ${Math.round(textColor[1]*255)}, ${Math.round(textColor[2]*255)}, 1)`

        // Position and rotation
        const x = textState.posX * canvas.width
        const y = textState.posY * canvas.height

        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(rotation)

        // Render multi-line text with justification
        const totalHeight = (lines.length - 1) * lineHeight
        const startY = -totalHeight / 2

        for (let i = 0; i < lines.length; i++) {
            const lineY = startY + i * lineHeight
            ctx.fillText(lines[i], 0, lineY)
        }

        ctx.restore()

        // Upload to texture
        this._updateTextTexture(stepIndex)
    }

    /**
     * Update text texture from canvas
     * @param {number} stepIndex - Step index
     * @private
     */
    _updateTextTexture(stepIndex) {
        const textState = this._textInputs.get(stepIndex)
        if (!textState || !textState.canvas || !this._renderer._pipeline) return

        const texId = textState.textureId
        const result = this._renderer.updateTextureFromSource(texId, textState.canvas, { flipY: true })

        if (result.width > 0 && result.height > 0) {
            // Update textSize uniform for this specific step
            const effectKey = `step_${stepIndex}`
            this._programState.setValue(effectKey, 'textSize', [result.width, result.height])
        }
    }

    /**
     * Stop all text inputs and clean up state
     */
    stopAllText() {
        this._textInputs.clear()
    }

    // =========================================================================
    // Getters
    // =========================================================================

    /** @returns {object} Current parameter values */
    get parameterValues() {
        return this._parameterValues
    }

    /** @returns {object} Effect parameter values by step */
    get effectParameterValues() {
        return this._programState.getAllStepValues()
    }

    /** @returns {object} Shader source overrides by step index */
    get shaderOverrides() {
        return this._shaderOverrides
    }

    /** @returns {Array} All effect placeholders */
    get allEffects() {
        return this._allEffects
    }

    // =========================================================================
    // Status Display
    // =========================================================================

    /**
     * Show a status message
     * @param {string} message - Message to display
     * @param {string} [type='info'] - Message type (info, success, error)
     */
    showStatus(message, type = 'info') {
        // Update hidden #status element for test harness (shade-mcp polls its textContent)
        if (this._statusEl) {
            this._statusEl.textContent = message
        }
        if (type === 'success') {
            showSuccess(message)
        } else if (type === 'error') {
            showError(message)
        } else {
            showInfo(message)
        }
    }

    /**
     * Update FPS counter display
     * @param {number} fps - Current FPS
     */
    updateFPSCounter(fps) {
        if (this._fpsCounterEl) {
            this._fpsCounterEl.textContent = `${fps} fps`
        }
    }

    // =========================================================================
    // Loading Dialog
    // =========================================================================

    /**
     * Show the loading dialog
     * @param {string} [title='loading effect...'] - Dialog title
     */
    showLoadingDialog(title = 'loading effect...') {
        if (!this._loadingDialog) return

        if (this._loadingDialogTitle) {
            this._loadingDialogTitle.textContent = title
        }
        if (this._loadingDialogStatus) {
            this._loadingDialogStatus.textContent = 'preparing...'
        }
        if (this._loadingDialogProgress) {
            this._loadingDialogProgress.style.width = '0%'
        }

        this._loadingState = { queue: [], completed: 0, total: 0 }
        this._loadingDialog.showModal()
    }

    /**
     * Hide the loading dialog
     */
    hideLoadingDialog() {
        if (this._loadingDialog) {
            this._loadingDialog.close()
        }
    }

    /**
     * Update loading status text
     * @param {string} status - Status message
     */
    updateLoadingStatus(status) {
        if (this._loadingDialogStatus) {
            this._loadingDialogStatus.textContent = status
        }
    }

    /**
     * Update loading progress
     */
    updateLoadingProgress() {
        if (!this._loadingDialogProgress) return

        const progress = this._loadingState.total > 0
            ? (this._loadingState.completed / this._loadingState.total) * 100
            : 0
        this._loadingDialogProgress.style.width = `${progress}%`
    }

    /**
     * Add item to loading queue
     * @param {string} id - Item ID
     * @param {string} label - Item label
     */
    addToLoadingQueue(id, label) {
        this._loadingState.queue.push({ id, label, status: 'pending' })
        this._loadingState.total++
    }

    /**
     * Update loading queue item status
     * @param {string} id - Item ID
     * @param {string} status - New status
     */
    updateLoadingQueueItem(id, status) {
        const item = this._loadingState.queue.find(i => i.id === id)
        if (item) {
            item.status = status
            if (status === 'done' || status === 'error') {
                this._loadingState.completed++
            }
            this.updateLoadingProgress()
        }
    }

    // =========================================================================
    // Effect Selector
    // =========================================================================

    /**
     * Populate the effect selector dropdown
     * @param {Array} effects - Array of effect objects with namespace, name, and optional description
     */
    populateEffectSelector(effects) {
        if (!this._effectSelect) return

        this._allEffects = effects

        // Check if this is a custom effect-select component
        if (typeof this._effectSelect.setEffects === 'function') {
            this._effectSelect.setEffects(effects)
        } else {
            // Fallback to native select element
            this._effectSelect.innerHTML = ''

            const grouped = {}
            effects.forEach(effect => {
                if (!grouped[effect.namespace]) {
                    grouped[effect.namespace] = []
                }
                grouped[effect.namespace].push(effect)
            })

            const sortedNamespaces = Object.keys(grouped).sort((a, b) => {
                const aIsClassic = a.startsWith('classic')
                const bIsClassic = b.startsWith('classic')
                if (aIsClassic && !bIsClassic) return 1
                if (!aIsClassic && bIsClassic) return -1
                return a.localeCompare(b)
            })

            sortedNamespaces.forEach(namespace => {
                const effectList = grouped[namespace]
                const optgroup = document.createElement('optgroup')
                optgroup.label = camelToSpaceCase(namespace)

                effectList.sort((a, b) => a.name.localeCompare(b.name)).forEach(effect => {
                    const option = document.createElement('option')
                    option.value = `${namespace}/${effect.name}`
                    const effectName = camelToSpaceCase(effect.name)
                    // Include description if available
                    if (effect.description) {
                        option.textContent = `${effectName}: ${effect.description}`
                    } else {
                        option.textContent = effectName
                    }
                    optgroup.appendChild(option)
                })

                this._effectSelect.appendChild(optgroup)
            })
        }
    }

    /**
     * Set the selected effect in the dropdown
     * @param {string} effectPath - Effect path (namespace/name)
     */
    setSelectedEffect(effectPath) {
        if (!this._effectSelect) return

        // Check if this is a custom effect-select component
        if (typeof this._effectSelect.setEffects === 'function') {
            this._effectSelect.value = effectPath
        } else {
            // Fallback to native select element
            for (let i = 0; i < this._effectSelect.options.length; i++) {
                if (this._effectSelect.options[i].value === effectPath) {
                    this._effectSelect.selectedIndex = i
                    break
                }
            }
        }
    }

    // =========================================================================
    // DSL Handling
    // =========================================================================

    /**
     * Get current DSL from editor
     * @returns {string} DSL content
     */
    getDsl() {
        return this._dslEditor ? this._dslEditor.value.trim() : ''
    }

    /**
     * Set DSL in editor
     * @param {string} dsl - DSL content
     */
    setDsl(dsl) {
        if (this._dslEditor) {
            this._dslEditor.value = dsl || ''
        }
    }

    /**
     * Format an effect call with parameters
     * @param {string} funcName - Function name
     * @param {object} kwargs - Object of parameter key-value pairs
     * @returns {string} Formatted call string
     */
    _formatEffectCall(funcName, kwargs) {
        return unparseCall({ name: funcName, kwargs, args: [] })
    }

    /**
     * Build kwargs object from effect globals and parameter values
     * @param {object} globals - Effect globals spec
     * @param {object} paramValues - Current parameter values
     * @param {function} formatValue - Value formatter function
     * @returns {object} kwargs object
     */
    _buildKwargs(globals, paramValues) {
        const kwargs = {}
        if (!globals) return kwargs

        for (const [key, spec] of Object.entries(globals)) {
            const value = paramValues[key]
            if (value === undefined || value === null) continue

            // Skip internal-only params (no UI control, set programmatically)
            if (spec.ui && spec.ui.control === false) continue

            // Skip _skip: false
            if (key === '_skip' && value === false) continue

            // Check against default value
            if (spec.default !== undefined) {
                const formattedValue = this._boundFormatValue(value, spec)
                const formattedDefault = this._boundFormatValue(spec.default, spec)
                if (formattedValue === formattedDefault) continue
            }

            kwargs[key] = value
        }
        return kwargs
    }

    /**
     * Build DSL source from an effect and parameter values
     * @param {object} effect - Effect object
     * @returns {string} Generated DSL
     */
    buildDslSource(effect) {
        if (!effect || !effect.instance) {
            return ''
        }

        // Use effect's own default program if provided
        if (effect.instance.defaultProgram) {
            return effect.instance.defaultProgram
        }

        // Build search directive (with two line breaks after)
        // Classic namespaces stay in their lane - no cross-namespace search
        let searchNs = effect.namespace
        if (effect.namespace === 'render') {
            searchNs = 'synth, filter, render'
        } else if (effect.namespace === 'points') {
            searchNs = 'synth, points, render'
        } else if (['filter', 'mixer'].includes(effect.namespace)) {
            searchNs = `${effect.namespace}, synth`
        }
        const searchDirective = searchNs ? `search ${searchNs}\n\n` : ''
        const funcName = effect.instance.func

        const starter = isStarterEffect(effect)
        const hasTex = hasTexSurfaceParam(effect)
        const hasExplicitTex = hasExplicitTexParam(effect)
        const { volParam, geoParam } = getVolGeoParams(effect)
        const hasVolGeo = volParam && geoParam

        // Helper to format a call
        const fmtCall = (name, kwargs) => this._formatEffectCall(name, kwargs)

        // Special case: pointsEmit and pointsRender must be paired together with physical()
        if (funcName === 'pointsEmit' || funcName === 'pointsRender') {
            return `search points, synth, render\n\nperlin()\n  .pointsEmit()\n  .physical()\n  .pointsRender()\n  .write(o0)\n\nrender(o0)`
        }

        // Special case: pointsBillboardRender needs polygon sprite source and full pipeline
        if (funcName === 'pointsBillboardRender') {
            return `search points, synth, render

polygon(
  radius: 0.7,
  fgAlpha: 0.1,
  bgAlpha: 0
)
  .write(o0)

perlin(ridges: true)
  .pointsEmit(stateSize: x64)
  .physical()
  .pointsBillboardRender(
    tex: read(o0),
    pointSize: 40,
    sizeVariation: 50,
    rotationVar: 50
  )
  .write(o1)

render(o1)`
        }

        // Special case: meshLoader and meshRender must be paired together
        if (funcName === 'meshLoader' || funcName === 'meshRender') {
            return `search render\n\nmeshLoader()\n  .meshRender()\n  .write(o0)\n\nrender(o0)`
        }

        // Special case: points namespace effects need pointsEmit/pointsRender wrapping
        if (effect.namespace === 'points') {
            const kwargs = this._buildKwargs(effect.instance.globals, this._parameterValues)
            const effectCall = fmtCall(funcName, kwargs)
            // Check if the effect defines viewMode (e.g., attractor defaults to 3D)
            const viewModeSpec = effect.instance.globals?.viewMode
            const viewModeDefault = viewModeSpec?.default
            const pointsRenderArgs = viewModeDefault ? `viewMode: ${viewModeDefault}` : ''
            const pointsRenderCall = pointsRenderArgs ? `pointsRender(${pointsRenderArgs})` : 'pointsRender()'
            return `search points, synth, render\n\nperlin()\n  .pointsEmit()\n  .${effectCall}\n  .${pointsRenderCall}\n  .write(o0)\n\nrender(o0)`
        }

        // Special case: loopBegin/loopEnd need paired usage with filter in between
        if (funcName === 'loopBegin' || funcName === 'loopEnd') {
            return `${searchDirective}noise(ridges: true)\n  .loopBegin(alpha: 95, intensity: 95)\n  .warp()\n  .loopEnd()\n  .write(o0)\n\nrender(o0)`
        }

        // Standard noise starter call
        const noiseCall = fmtCall('noise', { seed: 1, ridges: true })

        // 3D volume generators
        if (is3dGenerator(effect)) {
            let consumerVolumeSize = 32
            const kwargs = {}
            if (effect.instance.globals) {
                for (const [key, spec] of Object.entries(effect.instance.globals)) {
                    // Skip vol/geo params - we'll set them explicitly if present
                    if (key === volParam || key === geoParam) continue
                    const value = this._parameterValues[key]
                    if (value === undefined || value === null) continue
                    if (key === 'volumeSize') consumerVolumeSize = value

                    // Skip _skip: false
                    if (key === '_skip' && value === false) continue

                    // Check against default value
                    if (spec.default !== undefined) {
                        const formattedValue = this._boundFormatValue(value, spec)
                        const formattedDefault = this._boundFormatValue(spec.default, spec)
                        if (formattedValue === formattedDefault) continue
                    }

                    kwargs[key] = value
                }
            }

            // If generator has vol/geo params, generate 3D input for seeding
            if (hasVolGeo) {
                kwargs[volParam] = { type: 'Read3D', tex3d: { type: 'VolRef', name: 'vol0' }, geo: null }
                kwargs[geoParam] = { type: 'Read3D', tex3d: { type: 'GeoRef', name: 'geo0' }, geo: null }
                const generatorCall = fmtCall('noise3d', { volumeSize: `x${consumerVolumeSize}` })
                const effectCall = fmtCall(funcName, kwargs)
                return `search synth3d, filter3d, render\n\n${generatorCall}\n  .write3d(vol0, geo0)\n\n${effectCall}\n  .render3d()\n  .write(o0)\n\nrender(o0)`
            }

            const effectCall = fmtCall(funcName, kwargs)
            return `search synth3d, filter3d, render\n\n${effectCall}\n  .render3d()\n  .write(o0)\n\nrender(o0)`
        }

        // Effects with explicit vol/geo parameters (not pipeline inputs)
        // Generate 3D input and pass to vol/geo params
        if (hasVolGeo) {
            let consumerVolumeSize = 32
            const kwargs = {}
            if (effect.instance.globals) {
                for (const [key, spec] of Object.entries(effect.instance.globals)) {
                    // Skip vol/geo params - we'll set them explicitly
                    if (key === volParam || key === geoParam) continue
                    const value = this._parameterValues[key]
                    if (value === undefined || value === null) continue
                    if (key === 'volumeSize') consumerVolumeSize = value

                    // Skip _skip: false
                    if (key === '_skip' && value === false) continue

                    // Check against default value
                    if (spec.default !== undefined) {
                        const formattedValue = this._boundFormatValue(value, spec)
                        const formattedDefault = this._boundFormatValue(spec.default, spec)
                        if (formattedValue === formattedDefault) continue
                    }

                    kwargs[key] = value
                }
            }
            // Add vol/geo params with read3d() references
            kwargs[volParam] = { type: 'Read3D', tex3d: { type: 'VolRef', name: 'vol0' }, geo: null }
            kwargs[geoParam] = { type: 'Read3D', tex3d: { type: 'GeoRef', name: 'geo0' }, geo: null }
            const generatorCall = fmtCall('noise3d', { volumeSize: `x${consumerVolumeSize}` })
            const effectCall = fmtCall(funcName, kwargs)
            return `search synth3d, filter3d, render\n\n${generatorCall}\n  .write3d(vol0, geo0)\n\n${effectCall}\n  .render3d()\n  .write(o0)\n\nrender(o0)`
        }

        // Effects with explicit tex param (not inputTex default) - generate input
        // Starters with explicit tex can stand alone; filters need to chain from input
        if (hasExplicitTex) {
            const kwargs = this._buildKwargs(effect.instance.globals, this._parameterValues)
            // Override tex with read(o0)
            kwargs.tex = { type: 'Read', surface: 'o0' }
            const effectCall = fmtCall(funcName, kwargs)
            if (starter) {
                // Starter with explicit tex param - standalone chain
                return `${searchDirective}${noiseCall}\n  .write(o0)\n\n${effectCall}\n  .write(o1)\n\nrender(o1)`
            } else {
                // Filter with explicit tex param - chain from second noise
                const noiseCall2 = fmtCall('noise', { seed: 2, ridges: true })
                return `${searchDirective}${noiseCall}\n  .write(o0)\n\n${noiseCall2}\n  .${effectCall}\n  .write(o1)\n\nrender(o1)`
            }
        }

        if (starter) {
            const kwargs = this._buildKwargs(effect.instance.globals, this._parameterValues)

            if (hasTex) {
                // First chain writes to o0, effect reads from o0 and writes to o1
                const sourceSurface = 'o0'
                const outputSurface = 'o1'
                // Add tex as first param for effects with texture input
                const kwargsWithTex = { tex: { type: 'Read', surface: sourceSurface }, ...kwargs }
                const effectCall = fmtCall(funcName, kwargsWithTex)
                return `${searchDirective}${noiseCall}\n  .write(${sourceSurface})\n\n${effectCall}\n  .write(${outputSurface})\n\nrender(${outputSurface})`
            }
            const effectCall = fmtCall(funcName, kwargs)
            return `${searchDirective}${effectCall}\n  .write(o0)\n\nrender(o0)`
        } else if (hasTex) {
            // First chain writes to o0, second chain writes through effect to o1
            const kwargs = { tex: { type: 'Read', surface: 'o0' } }
            if (effect.instance.globals) {
                for (const [key, spec] of Object.entries(effect.instance.globals)) {
                    if (key === 'tex' && spec.type === 'surface') continue
                    const value = this._parameterValues[key]
                    if (value === undefined || value === null) continue

                    // Skip _skip: false
                    if (key === '_skip' && value === false) continue

                    // Check against default value
                    if (spec.default !== undefined) {
                        const formattedValue = this._boundFormatValue(value, spec)
                        const formattedDefault = this._boundFormatValue(spec.default, spec)
                        if (formattedValue === formattedDefault) continue
                    }

                    kwargs[key] = value
                }
            }
            const effectCall = fmtCall(funcName, kwargs)
            const noiseCall2 = fmtCall('noise', { seed: 2, ridges: true })
            return `${searchDirective}${noiseCall}\n  .write(o0)\n\n${noiseCall2}\n  .${effectCall}\n  .write(o1)\n\nrender(o1)`
        } else if (is3dProcessor(effect)) {
            let consumerVolumeSize = 32
            const kwargs = {}
            if (effect.instance.globals) {
                for (const [key, spec] of Object.entries(effect.instance.globals)) {
                    const value = this._parameterValues[key]
                    if (value === undefined || value === null) continue
                    if (key === 'volumeSize') consumerVolumeSize = value

                    // Skip _skip: false
                    if (key === '_skip' && value === false) continue

                    // Check against default value
                    if (spec.default !== undefined) {
                        const formattedValue = this._boundFormatValue(value, spec)
                        const formattedDefault = this._boundFormatValue(spec.default, spec)
                        if (formattedValue === formattedDefault) continue
                    }

                    kwargs[key] = value
                }
            }
            const generatorCall = fmtCall('noise3d', { volumeSize: `x${consumerVolumeSize}` })
            const effectCall = fmtCall(funcName, kwargs)
            // render3d, renderLit3d, and the cubemap renderers ARE renderers - don't append another .render3d() call
            const renderSuffix = (funcName === 'render3d' || funcName === 'renderLit3d' || funcName === 'renderCubemap3d' || funcName === 'renderCubemapSurface') ? '' : '\n  .render3d()'
            return `search synth3d, filter3d, render\n\n${generatorCall}\n  .${effectCall}${renderSuffix}\n  .write(o0)\n\nrender(o0)`
        } else {
            const kwargs = this._buildKwargs(effect.instance.globals, this._parameterValues)
            const effectCall = fmtCall(funcName, kwargs)
            return `${searchDirective}${noiseCall}\n  .${effectCall}\n  .write(o0)\n\nrender(o0)`
        }
    }

    // =========================================================================
    // Effect Controls
    // =========================================================================

    /**
     * Load DSL and create effect controls from it
     * Parses DSL into ProgramState, then builds controls from state
     * @param {string} dsl - DSL source
     */
    loadDslAndCreateControls(dsl) {
        if (!this._controlsContainer) return

        // Update state from DSL (single parse point)
        this._programState.fromDsl(dsl)

        // Build controls from state
        this.createEffectControlsFromState()
    }

    /**
     * Create effect controls from ProgramState
     * Uses programState.getStructure() and getStepValues() instead of parsing DSL
     */
    createEffectControlsFromState() {
        if (!this._controlsContainer) return

        const structure = this._programState.getStructure()
        const compiled = this._programState.getCompiled()

        // Handle empty structure (e.g., just "render(o0)" with no effect chain)
        if (!structure || structure.length === 0) {
            // Clean up existing controls for empty program
            this.stopAllMedia()
            this.stopAllText()
            this._controlsContainer.innerHTML = ''
            this._dependentControls = []
            this._parsedDslStructure = []
            return
        }

        if (!compiled?.plans) return

        // PRESERVE media state before stopping (keyed by occurrence)
        const previousMediaByOccurrence = this._preserveMediaState()

        // Clean up existing media and text inputs before rebuilding controls
        // Use preserveState=false since we already captured state above
        this.stopAllMedia()
        this.stopAllText()

        this._controlsContainer.innerHTML = ''
        this._dependentControls = []
        this._programState.clearRoutingOverrides()

        const effects = structure
        this._parsedDslStructure = effects

        // Build a map of stepIndex -> planIndex for write effect placement
        let globalStepIndex = 0
        const stepToPlan = new Map()
        for (let planIndex = 0; planIndex < compiled.plans.length; planIndex++) {
            const plan = compiled.plans[planIndex]
            if (!plan.chain) continue
            for (let i = 0; i < plan.chain.length; i++) {
                stepToPlan.set(globalStepIndex, planIndex)
                globalStepIndex++
            }
        }

        // Pre-compute which steps are mid-chain writes and which are followed by mid-chain writes
        const midChainWriteSteps = new Set()
        const stepsBeforeMidChainWrite = new Set()
        for (let i = 0; i < effects.length; i++) {
            const effectInfo = effects[i]
            if (effectInfo.effectKey === '_write') {
                const planIndex = stepToPlan.get(effectInfo.stepIndex)
                const isLastStepInPlan = effectInfo.stepIndex === Math.max(...effects.filter(e => stepToPlan.get(e.stepIndex) === planIndex).map(e => e.stepIndex))
                if (!isLastStepInPlan) {
                    midChainWriteSteps.add(effectInfo.stepIndex)
                    // Find the previous rendered step (skip _read builtins)
                    for (let j = i - 1; j >= 0; j--) {
                        const prev = effects[j]
                        if (prev.effectKey !== '_read' && prev.effectKey !== '_read3d') {
                            stepsBeforeMidChainWrite.add(prev.stepIndex)
                            break
                        }
                    }
                }
            }
        }

        let prevWasMidChainWrite = false

        // Track occurrence count for each effect name during iteration
        const currentOccurrenceCount = {}

        for (const effectInfo of effects) {
            // Track occurrence for ALL effects (including builtins) to keep counts consistent
            const effectName = effectInfo.effectKey || effectInfo.name
            if (currentOccurrenceCount[effectName] === undefined) {
                currentOccurrenceCount[effectName] = 0
            }

            // Handle builtin _write steps - render as write effect
            if (effectInfo.effectKey === '_write') {
                currentOccurrenceCount[effectName]++
                const planIndex = stepToPlan.get(effectInfo.stepIndex)
                // Get the write target from THIS step's args, not the plan's terminal write
                const writeTarget = effectInfo.args?.tex
                if (writeTarget) {
                    // Check if this is a mid-chain write (not the last step in the plan's chain)
                    const isLastStepInPlan = effectInfo.stepIndex === Math.max(...effects.filter(e => stepToPlan.get(e.stepIndex) === planIndex).map(e => e.stepIndex))
                    const isMidChain = !isLastStepInPlan

                    const writeEffect = this._createWriteEffect(planIndex, effectInfo.stepIndex, writeTarget, isMidChain)
                    this._controlsContainer.appendChild(writeEffect)
                    prevWasMidChainWrite = isMidChain
                }
                continue
            }

            // Handle builtin _read steps - render as read effect
            if (effectInfo.effectKey === '_read') {
                currentOccurrenceCount[effectName]++
                const readSource = effectInfo.args?.tex
                if (readSource) {
                    const readEffect = this._createReadEffect(effectInfo.stepIndex, readSource)
                    this._controlsContainer.appendChild(readEffect)
                }
                continue
            }

            // Handle builtin _read3d steps - create UI effect with vol/geo dropdowns
            if (effectInfo.effectKey === '_read3d') {
                const read3dSource = effectInfo.args || {}
                const read3dEffect = this._createRead3dEffect(effectInfo.stepIndex, read3dSource)
                this._controlsContainer.appendChild(read3dEffect)
                currentOccurrenceCount[effectName]++
                continue
            }

            // Handle builtin _write3d steps - render as write3d effect (exactly like _write)
            if (effectInfo.effectKey === '_write3d') {
                currentOccurrenceCount[effectName]++
                const planIndex = stepToPlan.get(effectInfo.stepIndex)
                const write3dArgs = effectInfo.args || {}
                if (write3dArgs.tex3d) {
                    // Check if this is a mid-chain write3d (not the last step in the plan's chain)
                    const isLastStepInPlan = effectInfo.stepIndex === Math.max(...effects.filter(e => stepToPlan.get(e.stepIndex) === planIndex).map(e => e.stepIndex))
                    const isMidChain = !isLastStepInPlan

                    const write3dEffect = this._createWrite3dEffect(planIndex, effectInfo.stepIndex, write3dArgs, isMidChain)
                    this._controlsContainer.appendChild(write3dEffect)
                }
                continue
            }

            let effectDef = getEffect(effectInfo.effectKey)
            if (!effectDef && effectInfo.namespace) {
                effectDef = getEffect(`${effectInfo.namespace}.${effectInfo.name}`)
            }
            if (!effectDef) {
                effectDef = getEffect(effectInfo.name)
            }

            if (!effectDef || !effectDef.globals) {
                // Still need to track occurrence even if no controls rendered
                currentOccurrenceCount[effectName]++
                continue
            }

            const effectDiv = document.createElement('div')
            effectDiv.className = 'shader-effect hf-panel'
            effectDiv.dataset.stepIndex = effectInfo.stepIndex
            effectDiv.dataset.effectName = effectInfo.name

            // If previous effect was a mid-chain write, remove top gap and radius
            if (prevWasMidChainWrite) {
                effectDiv.style.marginTop = '0'
                effectDiv.style.borderTopLeftRadius = '0'
                effectDiv.style.borderTopRightRadius = '0'
            }

            // If this step is followed by a mid-chain write, remove bottom gap and radius
            if (stepsBeforeMidChainWrite.has(effectInfo.stepIndex)) {
                effectDiv.style.marginBottom = '0'
                effectDiv.style.borderBottomLeftRadius = '0'
                effectDiv.style.borderBottomRightRadius = '0'
            }

            prevWasMidChainWrite = false

            const titleDiv = document.createElement('div')
            titleDiv.className = 'effect-title'

            // Title text (click to expand/collapse, but not when skipped)
            const titleText = document.createElement('span')
            titleText.className = 'effect-title-text'

            // Convert camelCase to space-separated lowercase
            const formatName = (name) => name.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
            const formattedName = formatName(effectInfo.name)

            titleText.textContent = effectInfo.namespace
                ? `${effectInfo.namespace}.${formattedName}`
                : formattedName
            titleDiv.appendChild(titleText)

            // Spacer to push buttons to the right
            const spacer = document.createElement('span')
            spacer.style.flex = '1'
            titleDiv.appendChild(spacer)

            // Code button (for shader editing) - only if effect has shaders
            let codeBtn = null
            if (effectDef.shaders) {
                codeBtn = document.createElement('button')
                codeBtn.className = 'hf-action-btn tooltip'
                codeBtn.textContent = 'code'
                codeBtn.dataset.title = 'Edit shader source code'
                codeBtn.setAttribute('aria-label', 'Edit shader source code')
                titleDiv.appendChild(codeBtn)
            }

            // Reset button
            const resetBtn = document.createElement('button')
            resetBtn.className = 'hf-action-btn tooltip'
            resetBtn.textContent = 'reset'
            resetBtn.dataset.title = 'Reset all parameters to defaults'
            resetBtn.setAttribute('aria-label', 'Reset all parameters to defaults')
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation()

                const effectKey = `step_${effectInfo.stepIndex}`
                const wasSkipped = this._programState.getValue(effectKey, '_skip')

                // Reset parameters to defaults via programState batch
                this._programState.batch(() => {
                    // Clear all values by setting to defaults
                    for (const [key, spec] of Object.entries(effectDef.globals)) {
                        if (spec.default !== undefined) {
                            this._programState.setValue(effectKey, key, cloneParamValue(spec.default))
                        }
                    }
                    // Preserve skip state if it was set
                    if (wasSkipped) {
                        this._programState.setValue(effectKey, '_skip', true)
                    }
                })

                // Update UI controls
                const controlsContainer = effectDiv.querySelector(`#controls-${effectInfo.stepIndex}`)
                if (controlsContainer) {
                    controlsContainer.innerHTML = ''

                    // Render controls grouped by category
                    const grouped = groupGlobalsByCategory(effectDef.globals)
                    const categoryNames = Object.keys(grouped)
                    const showCategoryLabels = categoryNames.length > 1

                    for (let catIdx = 0; catIdx < categoryNames.length; catIdx++) {
                        const category = categoryNames[catIdx]
                        const items = grouped[category]
                        // const isLastCategory = catIdx === categoryNames.length - 1

                        // Create category group wrapper
                        const categoryGroup = document.createElement('div')
                        categoryGroup.className = 'category-group'
                        categoryGroup.dataset.category = category

                        // Add hover label if multiple categories
                        if (showCategoryLabels) {
                            const label = document.createElement('div')
                            label.className = 'category-label'
                            label.textContent = category
                            categoryGroup.appendChild(label)
                        }

                        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
                            const [key, spec] = items[itemIdx]

                            const controlGroup = this._createControlGroup(
                                key,
                                spec,
                                { ...effectInfo, args: {} }, // Empty args forces use of defaults
                                effectKey
                            )
                            if (controlGroup) {
                                categoryGroup.appendChild(controlGroup)
                            }
                        }

                        controlsContainer.appendChild(categoryGroup)
                    }
                }

                this._updateDslFromEffectParams()
                this.showStatus(`reset ${effectInfo.name} to defaults`, 'success')

                // Notify downstream that effect controls were rebuilt
                if (this._onEffectControlsResetCallback) {
                    this._onEffectControlsResetCallback(effectInfo.stepIndex, effectDiv, effectDef)
                }
            })
            titleDiv.appendChild(resetBtn)

            // Delete button
            const deleteBtn = document.createElement('button')
            deleteBtn.className = 'hf-action-btn tooltip'
            deleteBtn.textContent = 'delete'
            deleteBtn.dataset.title = 'Remove this effect from the pipeline'
            deleteBtn.setAttribute('aria-label', 'Remove this effect from the pipeline')
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation()
                await this._deleteStepAtIndex(effectInfo.stepIndex)
            })
            titleDiv.appendChild(deleteBtn)

            // Skip button
            const skipBtn = document.createElement('button')
            skipBtn.className = 'hf-action-btn tooltip'
            skipBtn.textContent = 'skip'
            skipBtn.dataset.title = 'Skip this effect in the pipeline'
            skipBtn.setAttribute('aria-label', 'Skip this effect in the pipeline')
            skipBtn.addEventListener('click', async (e) => {
                e.stopPropagation()
                const isSkipped = effectDiv.classList.toggle('skipped')
                skipBtn.textContent = isSkipped ? 'unskip' : 'skip'
                skipBtn.classList.toggle('active', isSkipped)

                // When skipped, collapse the effect; when unskipped, expand it
                if (isSkipped) {
                    effectDiv.classList.add('collapsed')
                } else {
                    effectDiv.classList.remove('collapsed')
                }

                // Update state and regenerate DSL
                this._programState.setValue(effectKey, '_skip', isSkipped)
                this._updateDslFromEffectParams()

                // _skip requires a recompile since it changes the pass structure
                await this._recompilePipeline()
            })
            titleDiv.appendChild(skipBtn)

            // Click on title bar to expand/collapse (skip button has stopPropagation)
            titleDiv.addEventListener('click', () => {
                // Don't expand if skipped
                if (effectDiv.classList.contains('skipped')) {
                    return
                }
                effectDiv.classList.toggle('collapsed')
            })

            // Check if this effect is already skipped (from parsed DSL)
            if (effectInfo.args?._skip === true) {
                effectDiv.classList.add('skipped', 'collapsed')
                skipBtn.textContent = 'unskip'
                skipBtn.classList.add('active')
            }

            effectDiv.appendChild(titleDiv)

            const contentDiv = document.createElement('div')
            contentDiv.className = 'effect-content'

            const controlsDiv = document.createElement('div')
            controlsDiv.id = `controls-${effectInfo.stepIndex}`
            controlsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 1em 1em;'

            const effectKey = `step_${effectInfo.stepIndex}`

            // Get occurrence for this effect name (for media state restoration)
            const currentEffectName = effectInfo.effectKey || effectInfo.name
            const occurrence = currentOccurrenceCount[currentEffectName]
            currentOccurrenceCount[currentEffectName]++
            const occurrenceKey = `${currentEffectName}#${occurrence}`

            // Render controls grouped by category
            const grouped = groupGlobalsByCategory(effectDef.globals)
            const categoryNames = Object.keys(grouped)
            const showCategoryLabels = categoryNames.length > 1
            const hasMultipleCategories = categoryNames.length > 1
            const openCategories = effectDef.openCategories

            // Create tag bar for collapsed categories (only if multiple categories)
            let tagBar = null
            if (hasMultipleCategories) {
                tagBar = document.createElement('div')
                tagBar.className = 'category-tag-bar'
                controlsDiv.appendChild(tagBar)
            }

            for (let catIdx = 0; catIdx < categoryNames.length; catIdx++) {
                const category = categoryNames[catIdx]
                const items = grouped[category]
                // const isLastCategory = catIdx === categoryNames.length - 1

                // Create category group wrapper
                const categoryGroup = document.createElement('div')
                categoryGroup.className = 'category-group'
                categoryGroup.dataset.category = category

                // Multi-category effects start collapsed unless in openCategories
                const isCategoryOpen = openCategories
                    ? openCategories.includes(category)
                    : catIdx === 0
                if (hasMultipleCategories) {
                    if (!isCategoryOpen) {
                        categoryGroup.classList.add('collapsed')
                    }

                    // Create tag for this category
                    const tag = document.createElement('span')
                    tag.className = 'hf-tag'
                    tag.textContent = category + '…'
                    tag.dataset.category = category
                    // Open category tags start hidden
                    if (isCategoryOpen) {
                        tag.style.display = 'none'
                    }
                    tag.addEventListener('click', () => {
                        // Expand this category
                        categoryGroup.classList.remove('collapsed')
                        // Hide the tag
                        tag.style.display = 'none'
                        // Hide tag bar if all tags are hidden
                        const visibleTags = tagBar.querySelectorAll('.hf-tag:not([style*="display: none"])')
                        if (visibleTags.length === 0) {
                            tagBar.style.display = 'none'
                        }
                    })
                    tagBar.appendChild(tag)
                }

                // Add category label with close button (if multiple categories)
                if (showCategoryLabels) {
                    const label = document.createElement('div')
                    label.className = 'category-label'

                    if (hasMultipleCategories) {
                        const closeBtn = document.createElement('span')
                        closeBtn.className = 'category-close tooltip'
                        closeBtn.textContent = '✕'
                        closeBtn.dataset.title = 'collapse category'
                        closeBtn.setAttribute('aria-label', 'collapse category')
                        closeBtn.addEventListener('click', () => {
                            // Collapse this category
                            categoryGroup.classList.add('collapsed')
                            // Show the tag again
                            const tag = tagBar.querySelector(`[data-category="${category}"]`)
                            if (tag) tag.style.display = ''
                            // Show tag bar
                            tagBar.style.display = ''
                        })
                        label.appendChild(closeBtn)
                    }

                    const labelText = document.createElement('span')
                    labelText.textContent = category
                    label.appendChild(labelText)

                    categoryGroup.appendChild(label)
                }

                for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
                    const [key, spec] = items[itemIdx]

                    const controlGroup = this._createControlGroup(
                        key,
                        spec,
                        effectInfo,
                        effectKey
                    )
                    if (controlGroup) {
                        categoryGroup.appendChild(controlGroup)
                    }
                }

                controlsDiv.appendChild(categoryGroup)
            }

            // Add mesh input section into controls area (before "no controls" check)
            if (effectDef.externalMesh) {
                const meshSection = this._createMeshInputSection(
                    effectInfo.stepIndex,
                    effectDef.externalMesh,
                    effectDef.builtinMeshes
                )
                controlsDiv.appendChild(meshSection)
            }

            // Show message if effect has no controls
            if (controlsDiv.children.length === 0) {
                const noControlsMsg = document.createElement('div')
                noControlsMsg.className = 'no-controls-message'
                noControlsMsg.textContent = 'This effect has no controls.'
                noControlsMsg.style.cssText = 'grid-column: 1 / -1; color: var(--color5); font-size: 0.75rem; font-style: italic; padding: 0.5rem 0; text-align: center;'
                controlsDiv.appendChild(noControlsMsg)
            }

            contentDiv.appendChild(controlsDiv)

            // Add shader editor section if effect has shaders
            if (effectDef.shaders) {
                const shaderSection = this._createShaderEditorSection(effectInfo, effectDef, codeBtn)
                contentDiv.appendChild(shaderSection)
            }

            // Add external input section if effect has externalTexture (for media effects)
            if (effectDef.externalTexture && effectDef.externalTexture !== 'textTex') {
                const stepTextureId = `${effectDef.externalTexture}_step_${effectInfo.stepIndex}`
                // Check if we have previous state BEFORE creating the section
                const hasPreviousMediaState = !!previousMediaByOccurrence[occurrenceKey]
                const mediaSection = this._createMediaInputSection(
                    effectInfo.stepIndex,
                    stepTextureId,
                    effectDef,
                    hasPreviousMediaState // Skip default image load if restoring
                )
                contentDiv.appendChild(mediaSection)

                // Restore previous media state if available (keyed by occurrence)
                if (hasPreviousMediaState) {
                    this._restoreMediaFromPreviousState(
                        effectInfo.stepIndex,
                        previousMediaByOccurrence[occurrenceKey]
                    )
                }
            }

            // Initialize text canvas for textTex effects (reads settings from globals)
            if (effectDef.externalTexture === 'textTex') {
                this._initTextCanvas(effectInfo.stepIndex, effectKey, effectDef)
            }

            effectDiv.appendChild(contentDiv)
            this._controlsContainer.appendChild(effectDiv)
        }

        // Add render effect if render directive is present
        if (compiled.render) {
            const renderEffect = this._createRenderEffect(compiled.render)
            this._controlsContainer.appendChild(renderEffect)
        }

        // Update initial disabled state of dependent controls
        this._updateDependentControls()
    }

    /**
     * Check if DSL structure is compatible and apply state to pipeline
     * Returns false if structure would change (caller should rebuild controls)
     * @param {string} dsl - DSL source to check compatibility against
     * @returns {boolean} True if compatible, false if structure changed
     */
    checkStructureAndApplyState(dsl) {
        if (!this._controlsContainer || !this._parsedDslStructure) {
            return false
        }

        // Use programState to check structure compatibility
        if (this._programState.wouldChangeStructure(dsl)) {
            return false
        }

        // Check if automation bindings changed (scalar <-> oscillator/midi/audio)
        // If so, we need to rebuild controls to show "automatic" or sliders
        if (this._automationBindingsChanged(dsl)) {
            return false
        }

        // Structure is the same - update state from new DSL (may have different arg values)
        // This is critical for automation bindings (oscillator, midi, audio) which may have changed
        this._programState.fromDsl(dsl)

        // Sync UI controls from the updated state
        // This ensures controls reflect new DSL values for effects that existed before paste
        this._syncControlValuesFromState()

        return true
    }

    /**
     * Sync all UI control values from programState
     * Called after DSL is parsed to update control displays without rebuilding
     * @private
     */
    _syncControlValuesFromState() {
        if (!this._controlsContainer || !this._parsedDslStructure) return

        for (const effectInfo of this._parsedDslStructure) {
            const stepIndex = effectInfo.stepIndex
            const effectKey = `step_${stepIndex}`
            const values = this._programState.getStepValues(effectKey) || {}

            // Find the effect container
            const effectDiv = this._controlsContainer.querySelector(
                `.shader-effect[data-step-index="${stepIndex}"]`
            )
            if (!effectDiv) continue

            // Update each control group with data-param-key
            const controlGroups = effectDiv.querySelectorAll('.control-group[data-param-key]')
            for (const controlGroup of controlGroups) {
                const paramKey = controlGroup.dataset.paramKey
                const value = values[paramKey]

                if (value === undefined) continue

                // Skip automation-controlled values (they show "automatic" badge)
                if (value && typeof value === 'object' && (
                    value._varRef ||
                    value.type === 'Oscillator' || value._ast?.type === 'Oscillator' ||
                    value.type === 'Midi' || value._ast?.type === 'Midi' ||
                    value.type === 'Audio' || value._ast?.type === 'Audio'
                )) {
                    continue
                }

                // Use control handle if available (custom web components)
                if (controlGroup._controlHandle?.setValue) {
                    controlGroup._controlHandle.setValue(value)
                }
            }
        }

        // Update dependent controls' disabled state based on the new values
        this._updateDependentControls()
    }

    /**
     * Check if automation bindings changed between current state and new DSL
     * @param {string} dsl - New DSL to check
     * @returns {boolean} True if automation status of any param changed
     * @private
     */
    _automationBindingsChanged(dsl) {
        const newEffects = extractEffectsFromDsl(dsl)
        if (!newEffects || !this._parsedDslStructure) return false

        for (let i = 0; i < newEffects.length; i++) {
            const newEffect = newEffects[i]
            const oldEffect = this._parsedDslStructure[i]
            if (!oldEffect) continue

            // Check each arg for automation status change
            const allParams = new Set([
                ...Object.keys(newEffect.args || {}),
                ...Object.keys(oldEffect.args || {})
            ])

            for (const param of allParams) {
                const newVal = newEffect.args?.[param]
                const oldVal = oldEffect.args?.[param]

                const newIsAuto = newVal && typeof newVal === 'object' && (
                    newVal.type === 'Oscillator' || newVal.type === 'Midi' || newVal.type === 'Audio' ||
                    newVal._ast?.type === 'Oscillator' || newVal._ast?.type === 'Midi' || newVal._ast?.type === 'Audio'
                )
                const oldIsAuto = oldVal && typeof oldVal === 'object' && (
                    oldVal.type === 'Oscillator' || oldVal.type === 'Midi' || oldVal.type === 'Audio' ||
                    oldVal._ast?.type === 'Oscillator' || oldVal._ast?.type === 'Midi' || oldVal._ast?.type === 'Audio'
                )

                if (newIsAuto !== oldIsAuto) {
                    console.log(`[_automationBindingsChanged] ${oldEffect.name}.${param}: ${oldIsAuto} -> ${newIsAuto}`)
                    return true
                }
            }
        }

        return false
    }

    /**
     * Create a write effect for a plan
     * @private
     * @param {number} planIndex - The plan index
     * @param {number} stepIndex - The step index for this write
     * @param {object} writeTarget - The write target surface
     * @param {boolean} isMidChain - Whether this is a mid-chain write (not terminal)
     */
    _createWriteEffect(planIndex, stepIndex, writeTarget, isMidChain = false) {
        const effectDiv = document.createElement('div')
        effectDiv.className = 'shader-effect hf-panel'
        effectDiv.dataset.planIndex = planIndex
        effectDiv.dataset.stepIndex = stepIndex
        effectDiv.dataset.effectName = 'write'

        // Mark mid-chain writes with data attribute for CSS targeting
        if (isMidChain) {
            effectDiv.dataset.midChain = 'true'
        }

        const titleDiv = document.createElement('div')
        titleDiv.className = 'effect-title'
        titleDiv.textContent = 'write'
        titleDiv.addEventListener('click', () => {
            effectDiv.classList.toggle('collapsed')
        })
        effectDiv.appendChild(titleDiv)

        const contentDiv = document.createElement('div')
        contentDiv.className = 'effect-content'

        const controlsDiv = document.createElement('div')
        controlsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;'

        // Create target dropdown
        const controlGroup = document.createElement('div')
        controlGroup.className = 'control-group'

        const header = document.createElement('div')
        header.className = 'control-header'

        const label = document.createElement('span')
        label.className = 'control-label'
        label.textContent = 'surface'
        header.appendChild(label)
        controlGroup.appendChild(header)

        const surfaces = [
            { value: 'none', label: 'none' },
            { value: 'o0', label: 'o0' },
            { value: 'o1', label: 'o1' },
            { value: 'o2', label: 'o2' },
            { value: 'o3', label: 'o3' },
            { value: 'o4', label: 'o4' },
            { value: 'o5', label: 'o5' },
            { value: 'o6', label: 'o6' },
            { value: 'o7', label: 'o7' }
        ]
        const currentTarget = typeof writeTarget === 'string' ? writeTarget : writeTarget.name
        const handle = this._controlFactory.createSelect({
            choices: surfaces,
            value: currentTarget,
            className: 'hf-input'
        })
        const select = handle.element

        select.addEventListener('change', () => {
            const val = handle.getValue()
            if (isMidChain) {
                this._programState.setWriteStepTarget(stepIndex, val)
            } else {
                this._programState.setWriteTarget(planIndex, val)
            }
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        controlGroup.appendChild(select)
        controlsDiv.appendChild(controlGroup)
        contentDiv.appendChild(controlsDiv)
        effectDiv.appendChild(contentDiv)

        return effectDiv
    }

    /**
     * Create a render effect for the render directive
     * @private
     * @param {string} renderTarget - The render target surface (e.g., 'o0')
     */
    _createRenderEffect(renderTarget) {
        const effectDiv = document.createElement('div')
        effectDiv.className = 'shader-effect hf-panel'
        effectDiv.dataset.effectName = 'render'

        const titleDiv = document.createElement('div')
        titleDiv.className = 'effect-title'
        titleDiv.textContent = 'render'
        titleDiv.addEventListener('click', () => {
            effectDiv.classList.toggle('collapsed')
        })
        effectDiv.appendChild(titleDiv)

        const contentDiv = document.createElement('div')
        contentDiv.className = 'effect-content'

        const controlsDiv = document.createElement('div')
        controlsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;'

        // Create target dropdown
        const controlGroup = document.createElement('div')
        controlGroup.className = 'control-group'

        const header = document.createElement('div')
        header.className = 'control-header'

        const label = document.createElement('span')
        label.className = 'control-label'
        label.textContent = 'surface'
        header.appendChild(label)
        controlGroup.appendChild(header)

        const surfaces = [
            { value: 'o0', label: 'o0' },
            { value: 'o1', label: 'o1' },
            { value: 'o2', label: 'o2' },
            { value: 'o3', label: 'o3' },
            { value: 'o4', label: 'o4' },
            { value: 'o5', label: 'o5' },
            { value: 'o6', label: 'o6' },
            { value: 'o7', label: 'o7' }
        ]
        const currentTarget = typeof renderTarget === 'string' ? renderTarget : renderTarget.name
        const handle = this._controlFactory.createSelect({
            choices: surfaces,
            value: currentTarget,
            className: 'hf-input'
        })
        const select = handle.element

        select.addEventListener('change', () => {
            this._programState.setRenderTarget(handle.getValue())
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        controlGroup.appendChild(select)
        controlsDiv.appendChild(controlGroup)
        contentDiv.appendChild(controlsDiv)
        effectDiv.appendChild(contentDiv)

        return effectDiv
    }

    /**
     * Create a read effect for a step
     * @private
     * @param {number} stepIndex - The step index
     * @param {object} readSource - The read source surface
     */
    _createReadEffect(stepIndex, readSource) {
        const effectDiv = document.createElement('div')
        effectDiv.className = 'shader-effect hf-panel'
        effectDiv.dataset.stepIndex = stepIndex
        effectDiv.dataset.effectName = 'read'

        const titleDiv = document.createElement('div')
        titleDiv.className = 'effect-title'

        // Title text
        const titleText = document.createElement('span')
        titleText.className = 'effect-title-text'
        titleText.textContent = 'read'
        titleDiv.appendChild(titleText)

        // Spacer to push buttons to the right
        const spacer = document.createElement('span')
        spacer.style.flex = '1'
        titleDiv.appendChild(spacer)

        // Delete button
        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'hf-action-btn tooltip'
        deleteBtn.textContent = 'delete'
        deleteBtn.dataset.title = 'Remove this read from the pipeline'
        deleteBtn.setAttribute('aria-label', 'Remove this read from the pipeline')
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            await this._deleteStepAtIndex(stepIndex)
        })
        titleDiv.appendChild(deleteBtn)

        // Skip button
        const skipBtn = document.createElement('button')
        skipBtn.className = 'hf-action-btn tooltip'
        skipBtn.textContent = 'skip'
        skipBtn.dataset.title = 'Skip this read in the pipeline'
        skipBtn.setAttribute('aria-label', 'Skip this read in the pipeline')
        skipBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            const isSkipped = effectDiv.classList.toggle('skipped')
            skipBtn.textContent = isSkipped ? 'unskip' : 'skip'
            skipBtn.classList.toggle('active', isSkipped)

            // When skipped, collapse the effect; when unskipped, expand it
            if (isSkipped) {
                effectDiv.classList.add('collapsed')
            } else {
                effectDiv.classList.remove('collapsed')
            }

            // Toggle skip in DSL and recompile
            await this._toggleStepSkipAtIndex(stepIndex, isSkipped)
        })
        titleDiv.appendChild(skipBtn)

        // Click on title bar to expand/collapse
        titleDiv.addEventListener('click', () => {
            if (effectDiv.classList.contains('skipped')) {
                return
            }
            effectDiv.classList.toggle('collapsed')
        })

        effectDiv.appendChild(titleDiv)

        const contentDiv = document.createElement('div')
        contentDiv.className = 'effect-content'

        const controlsDiv = document.createElement('div')
        controlsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;'

        // Create source dropdown
        const controlGroup = document.createElement('div')
        controlGroup.className = 'control-group'

        const header = document.createElement('div')
        header.className = 'control-header'

        const label = document.createElement('span')
        label.className = 'control-label'
        label.textContent = 'surface'
        header.appendChild(label)
        controlGroup.appendChild(header)

        const surfaces = [
            { value: 'none', label: 'none' },
            { value: 'o0', label: 'o0' },
            { value: 'o1', label: 'o1' },
            { value: 'o2', label: 'o2' },
            { value: 'o3', label: 'o3' },
            { value: 'o4', label: 'o4' },
            { value: 'o5', label: 'o5' },
            { value: 'o6', label: 'o6' },
            { value: 'o7', label: 'o7' }
        ]
        const currentSource = typeof readSource === 'string' ? readSource : readSource.name
        const handle = this._controlFactory.createSelect({
            choices: surfaces,
            value: currentSource,
            className: 'hf-input'
        })
        const select = handle.element

        select.addEventListener('change', () => {
            this._programState.setReadSource(stepIndex, handle.getValue())
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        controlGroup.appendChild(select)
        controlsDiv.appendChild(controlGroup)
        contentDiv.appendChild(controlsDiv)
        effectDiv.appendChild(contentDiv)

        return effectDiv
    }

    /**
     * Create a read3d effect for a step
     * @private
     * @param {number} stepIndex - The step index
     * @param {object} read3dSource - The read3d source containing tex3d and geo
     */
    _createRead3dEffect(stepIndex, read3dSource) {
        const effectDiv = document.createElement('div')
        effectDiv.className = 'shader-effect hf-panel'
        effectDiv.dataset.stepIndex = stepIndex
        effectDiv.dataset.effectName = 'read3d'

        const titleDiv = document.createElement('div')
        titleDiv.className = 'effect-title'

        // Title text
        const titleText = document.createElement('span')
        titleText.className = 'effect-title-text'
        titleText.textContent = 'read3d'
        titleDiv.appendChild(titleText)

        // Spacer to push buttons to the right
        const spacer = document.createElement('span')
        spacer.style.flex = '1'
        titleDiv.appendChild(spacer)

        // Delete button
        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'hf-action-btn tooltip'
        deleteBtn.textContent = 'delete'
        deleteBtn.dataset.title = 'Remove this read3d from the pipeline'
        deleteBtn.setAttribute('aria-label', 'Remove this read3d from the pipeline')
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            await this._deleteStepAtIndex(stepIndex)
        })
        titleDiv.appendChild(deleteBtn)

        // Skip button
        const skipBtn = document.createElement('button')
        skipBtn.className = 'hf-action-btn tooltip'
        skipBtn.textContent = 'skip'
        skipBtn.dataset.title = 'Skip this read3d in the pipeline'
        skipBtn.setAttribute('aria-label', 'Skip this read3d in the pipeline')
        skipBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            const isSkipped = effectDiv.classList.toggle('skipped')
            skipBtn.textContent = isSkipped ? 'unskip' : 'skip'
            skipBtn.classList.toggle('active', isSkipped)

            if (isSkipped) {
                effectDiv.classList.add('collapsed')
            } else {
                effectDiv.classList.remove('collapsed')
            }

            await this._toggleStepSkipAtIndex(stepIndex, isSkipped)
        })
        titleDiv.appendChild(skipBtn)

        // Click on title bar to expand/collapse
        titleDiv.addEventListener('click', () => {
            if (effectDiv.classList.contains('skipped')) {
                return
            }
            effectDiv.classList.toggle('collapsed')
        })

        effectDiv.appendChild(titleDiv)

        const contentDiv = document.createElement('div')
        contentDiv.className = 'effect-content'

        const controlsDiv = document.createElement('div')
        controlsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;'

        // Create volume dropdown (vol0-vol7)
        const volGroup = document.createElement('div')
        volGroup.className = 'control-group'

        const volHeader = document.createElement('div')
        volHeader.className = 'control-header'

        const volLabel = document.createElement('span')
        volLabel.className = 'control-label'
        volLabel.textContent = 'volume'
        volHeader.appendChild(volLabel)
        volGroup.appendChild(volHeader)

        const volumes = [
            { value: 'none', label: 'none' },
            { value: 'vol0', label: 'vol0' },
            { value: 'vol1', label: 'vol1' },
            { value: 'vol2', label: 'vol2' },
            { value: 'vol3', label: 'vol3' },
            { value: 'vol4', label: 'vol4' },
            { value: 'vol5', label: 'vol5' },
            { value: 'vol6', label: 'vol6' },
            { value: 'vol7', label: 'vol7' }
        ]
        const currentVol = read3dSource.tex3d?.name || 'vol0'
        const volHandle = this._controlFactory.createSelect({
            choices: volumes,
            value: currentVol,
            className: 'hf-input'
        })
        const volSelect = volHandle.element

        volSelect.addEventListener('change', () => {
            this._programState.setRead3dVolume(stepIndex, volHandle.getValue())
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        volGroup.appendChild(volSelect)
        controlsDiv.appendChild(volGroup)

        // Create geometry dropdown (geo0-geo7)
        const geoGroup = document.createElement('div')
        geoGroup.className = 'control-group'

        const geoHeader = document.createElement('div')
        geoHeader.className = 'control-header'

        const geoLabel = document.createElement('span')
        geoLabel.className = 'control-label'
        geoLabel.textContent = 'geometry'
        geoHeader.appendChild(geoLabel)
        geoGroup.appendChild(geoHeader)

        const geometries = [
            { value: 'none', label: 'none' },
            { value: 'geo0', label: 'geo0' },
            { value: 'geo1', label: 'geo1' },
            { value: 'geo2', label: 'geo2' },
            { value: 'geo3', label: 'geo3' },
            { value: 'geo4', label: 'geo4' },
            { value: 'geo5', label: 'geo5' },
            { value: 'geo6', label: 'geo6' },
            { value: 'geo7', label: 'geo7' }
        ]
        const currentGeo = read3dSource.geo?.name || 'geo0'
        const geoHandle = this._controlFactory.createSelect({
            choices: geometries,
            value: currentGeo,
            className: 'hf-input'
        })
        const geoSelect = geoHandle.element

        geoSelect.addEventListener('change', () => {
            this._programState.setRead3dGeometry(stepIndex, geoHandle.getValue())
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        geoGroup.appendChild(geoSelect)
        controlsDiv.appendChild(geoGroup)

        contentDiv.appendChild(controlsDiv)
        effectDiv.appendChild(contentDiv)

        return effectDiv
    }

    /**
     * Create a write3d effect for a step
     * @private
     * @param {number} planIndex - The plan index
     * @param {number} stepIndex - The step index for this write3d
     * @param {object} write3dArgs - The write3d args containing tex3d and geo
     * @param {boolean} isMidChain - Whether this is a mid-chain write3d (not terminal)
     */
    _createWrite3dEffect(planIndex, stepIndex, write3dArgs, isMidChain = false) {
        const effectDiv = document.createElement('div')
        effectDiv.className = 'shader-effect hf-panel'
        effectDiv.dataset.planIndex = planIndex
        effectDiv.dataset.stepIndex = stepIndex
        effectDiv.dataset.effectName = 'write3d'

        // Mark mid-chain writes with data attribute for CSS targeting
        if (isMidChain) {
            effectDiv.dataset.midChain = 'true'
        }

        const titleDiv = document.createElement('div')
        titleDiv.className = 'effect-title'
        titleDiv.textContent = 'write3d'
        titleDiv.addEventListener('click', () => {
            effectDiv.classList.toggle('collapsed')
        })
        effectDiv.appendChild(titleDiv)

        const contentDiv = document.createElement('div')
        contentDiv.className = 'effect-content'

        const controlsDiv = document.createElement('div')
        controlsDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;'

        // Create volume dropdown (vol0-vol7)
        const volGroup = document.createElement('div')
        volGroup.className = 'control-group'

        const volHeader = document.createElement('div')
        volHeader.className = 'control-header'

        const volLabel = document.createElement('span')
        volLabel.className = 'control-label'
        volLabel.textContent = 'volume'
        volHeader.appendChild(volLabel)
        volGroup.appendChild(volHeader)

        const volumes = [
            { value: 'none', label: 'none' },
            { value: 'vol0', label: 'vol0' },
            { value: 'vol1', label: 'vol1' },
            { value: 'vol2', label: 'vol2' },
            { value: 'vol3', label: 'vol3' },
            { value: 'vol4', label: 'vol4' },
            { value: 'vol5', label: 'vol5' },
            { value: 'vol6', label: 'vol6' },
            { value: 'vol7', label: 'vol7' }
        ]
        const currentVol = write3dArgs.tex3d?.name || 'vol0'
        const volHandle = this._controlFactory.createSelect({
            choices: volumes,
            value: currentVol,
            className: 'hf-input'
        })
        const volSelect = volHandle.element

        volSelect.addEventListener('change', () => {
            this._programState.setWrite3dVolume(stepIndex, volHandle.getValue())
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        volGroup.appendChild(volSelect)
        controlsDiv.appendChild(volGroup)

        // Create geometry dropdown (geo0-geo7)
        const geoGroup = document.createElement('div')
        geoGroup.className = 'control-group'

        const geoHeader = document.createElement('div')
        geoHeader.className = 'control-header'

        const geoLabel = document.createElement('span')
        geoLabel.className = 'control-label'
        geoLabel.textContent = 'geometry'
        geoHeader.appendChild(geoLabel)
        geoGroup.appendChild(geoHeader)

        const geometries = [
            { value: 'none', label: 'none' },
            { value: 'geo0', label: 'geo0' },
            { value: 'geo1', label: 'geo1' },
            { value: 'geo2', label: 'geo2' },
            { value: 'geo3', label: 'geo3' },
            { value: 'geo4', label: 'geo4' },
            { value: 'geo5', label: 'geo5' },
            { value: 'geo6', label: 'geo6' },
            { value: 'geo7', label: 'geo7' }
        ]
        const currentGeo = write3dArgs.geo?.name || 'geo0'
        const geoHandle = this._controlFactory.createSelect({
            choices: geometries,
            value: currentGeo,
            className: 'hf-input'
        })
        const geoSelect = geoHandle.element

        geoSelect.addEventListener('change', () => {
            this._programState.setWrite3dGeometry(stepIndex, geoHandle.getValue())
            this._onControlChange()
            if (this._onRequestRecompileCallback) {
                this._onRequestRecompileCallback()
            }
        })

        geoGroup.appendChild(geoSelect)
        controlsDiv.appendChild(geoGroup)

        contentDiv.appendChild(controlsDiv)
        effectDiv.appendChild(contentDiv)

        return effectDiv
    }

    /**
     * Delete a step from the pipeline by its global step index.
     * Extracted for reuse by effects.
     * @private
     * @param {number} targetStepIndex - The global step index to delete
     */
    async _deleteStepAtIndex(targetStepIndex) {
        const result = this._programState.deleteStep(targetStepIndex)

        if (!result.success) {
            this.showStatus(`cannot delete: ${result.error}`, 'error')
            return
        }

        // Clear the surface that the deleted chain was writing to
        if (result.deletedSurfaceName && this._renderer.pipeline) {
            this._renderer.pipeline.clearSurface(result.deletedSurfaceName)
        }

        // Update DSL in renderer and editor
        this.setDsl(result.newDsl)
        this._renderer.currentDsl = result.newDsl

        // Rebuild controls from state (structurechange already emitted by deleteStep)
        this.createEffectControlsFromState()
        await this._recompilePipeline()
    }

    /**
     * Toggle the skip state of a step by its global step index.
     * @private
     * @param {number} targetStepIndex - The global step index to toggle
     * @param {boolean} isSkipped - Whether the step should be skipped
     */
    async _toggleStepSkipAtIndex(targetStepIndex, isSkipped) {
        const effectKey = `step_${targetStepIndex}`

        // Update state - this will trigger DSL update
        this._programState.setValue(effectKey, '_skip', isSkipped)
        this._updateDslFromEffectParams()

        // Skip requires a recompile since it changes the pass structure
        await this._recompilePipeline()
    }

    /**
     * Create the shader editor section for an effect
     * @private
     * @param {object} effectInfo - Effect info
     * @param {object} effectDef - Effect definition
     * @param {HTMLButtonElement} toggleBtn - The code button in the title bar that toggles visibility
     */
    _createShaderEditorSection(effectInfo, effectDef, toggleBtn) {
        const section = document.createElement('div')
        section.className = 'shader-editor-section'
        section.style.cssText = 'display: none; margin-top: 0.75rem; padding-top: 0.75rem;'

        // Program selector
        const programNames = Object.keys(effectDef.shaders)
        let programHandle = null
        if (programNames.length > 1) {
            const choices = programNames.map(name => ({ value: name, label: name }))
            programHandle = this._controlFactory.createSelect({
                choices,
                value: programNames[0],
                className: 'hf-input'
            })
            const programSelect = programHandle.element
            programSelect.style.cssText = 'margin-bottom: 0.5rem;'
            section.appendChild(programSelect)

            programSelect.addEventListener('change', () => {
                this._updateShaderEditorContent(effectInfo, effectDef, programHandle.getValue(), section)
            })
        }

        // Shader textarea
        const textarea = document.createElement('textarea')
        textarea.className = 'shader-source-editor'
        textarea.name = 'shader-source'
        textarea.spellcheck = false
        textarea.style.cssText = 'width: 100%; min-height: 200px; resize: vertical; background: color-mix(in srgb, var(--color1) 60%, transparent 40%); border: 1px solid color-mix(in srgb, var(--accent3) 25%, transparent 75%); border-radius: var(--ui-corner-radius-small); font-family: var(--hf-font-family-mono); font-size: 0.625rem; line-height: 1.4; color: var(--color5); padding: 0.5rem; box-sizing: border-box;'
        section.appendChild(textarea)

        // Button container
        const btnContainer = document.createElement('div')
        btnContainer.style.cssText = 'display: flex; gap: 0.5rem; margin-top: 0.5rem;'
        section.appendChild(btnContainer)

        // Apply button
        const applyBtn = document.createElement('button')
        applyBtn.textContent = 'apply shader'
        applyBtn.style.cssText = 'flex: 1; padding: 0.375rem 0.75rem; background: color-mix(in srgb, var(--accent3) 30%, transparent 70%); border: 1px solid color-mix(in srgb, var(--accent3) 50%, transparent 50%); border-radius: var(--ui-corner-radius-small); color: var(--color6); font-family: var(--hf-font-family); font-size: 0.6875rem; font-weight: 600; cursor: pointer;'
        btnContainer.appendChild(applyBtn)

        // Reset button
        const resetBtn = document.createElement('button')
        resetBtn.textContent = 'reset to original'
        resetBtn.style.cssText = 'flex: 1; padding: 0.375rem 0.75rem; background: transparent; border: 1px solid color-mix(in srgb, var(--accent3) 30%, transparent 70%); border-radius: var(--ui-corner-radius-small); color: var(--color5); font-family: var(--hf-font-family); font-size: 0.6875rem; font-weight: 600; cursor: pointer;'
        btnContainer.appendChild(resetBtn)

        // Toggle visibility via the code button in title bar
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                const isVisible = section.style.display !== 'none'
                section.style.display = isVisible ? 'none' : 'block'
                toggleBtn.textContent = isVisible ? 'code' : 'hide'
                toggleBtn.classList.toggle('active', !isVisible)

                if (!isVisible) {
                    // Load current shader source
                    const programName = programHandle
                        ? programHandle.getValue()
                        : programNames[0]
                    this._updateShaderEditorContent(effectInfo, effectDef, programName, section)
                }
            })
        }

        // Apply button handler
        applyBtn.addEventListener('click', () => {
            const programName = programHandle
                ? programHandle.getValue()
                : programNames[0]
            const backend = this._renderer.backend
            const source = textarea.value

            this._applyShaderOverride(effectInfo.stepIndex, programName, backend, source, effectDef)
        })

        // Reset button handler
        resetBtn.addEventListener('click', () => {
            const programName = programNames.length > 1
                ? section.querySelector('select')?.value
                : programNames[0]

            this._resetShaderOverride(effectInfo.stepIndex, programName)
            this._updateShaderEditorContent(effectInfo, effectDef, programName, section)
        })

        return section
    }

    /**
     * Update the shader editor content for a specific program and backend
     * @private
     */
    _updateShaderEditorContent(effectInfo, effectDef, programName, container) {
        const textarea = container.querySelector('textarea')
        const backend = this._renderer.backend

        // Check if we have an override first
        const override = this._shaderOverrides[effectInfo.stepIndex]?.[programName]
        let source = ''

        if (override) {
            // Use override source
            if (backend === 'wgsl' && override.wgsl) {
                source = override.wgsl
            } else if (override.glsl) {
                source = override.glsl
            } else if (override.fragment) {
                source = override.fragment
            }
        }

        if (!source) {
            // Use original source from effect definition
            const shaders = effectDef.shaders[programName]
            if (shaders) {
                if (backend === 'wgsl' && shaders.wgsl) {
                    source = shaders.wgsl
                } else if (shaders.glsl) {
                    source = shaders.glsl
                } else if (shaders.fragment) {
                    source = shaders.fragment
                }
            }
        }

        textarea.value = source || '// No shader source available'
    }

    /**
     * Apply a shader override for a step
     * @private
     */
    _applyShaderOverride(stepIndex, programName, backend, source, effectDef) {
        if (!this._shaderOverrides[stepIndex]) {
            this._shaderOverrides[stepIndex] = {}
        }

        // Copy original shader structure and apply override
        const originalShaders = effectDef.shaders[programName] || {}
        const override = { ...originalShaders }

        if (backend === 'wgsl') {
            override.wgsl = source
        } else {
            // For GLSL, determine if it's combined or separate
            if (originalShaders.glsl) {
                override.glsl = source
            } else if (originalShaders.fragment) {
                override.fragment = source
            } else {
                // Default to glsl
                override.glsl = source
            }
        }

        this._shaderOverrides[stepIndex][programName] = override

        // Trigger recompilation with shader overrides
        this._recompileWithShaderOverrides()
    }

    /**
     * Reset a shader override to original
     * @private
     */
    _resetShaderOverride(stepIndex, programName) {
        if (this._shaderOverrides[stepIndex]) {
            delete this._shaderOverrides[stepIndex][programName]
            if (Object.keys(this._shaderOverrides[stepIndex]).length === 0) {
                delete this._shaderOverrides[stepIndex]
            }
        }

        // Trigger recompilation
        this._recompileWithShaderOverrides()
    }

    /**
     * Recompile the pipeline with current shader overrides
     * @private
     */
    async _recompileWithShaderOverrides() {
        const dsl = this.getDsl()
        if (!dsl) return

        try {
            await this._renderer.compile(dsl, {
                shaderOverrides: this._shaderOverrides
            })
            this.showStatus('shader applied', 'success')
        } catch (err) {
            console.error('Shader compilation failed:', this.formatCompilationError(err))
            this.showStatus('shader error: ' + this.formatCompilationError(err), 'error')
        }
    }

    /**
     * Recompile the pipeline after a structural change (e.g., _skip toggle)
     * @private
     */
    async _recompilePipeline() {
        const dsl = this.getDsl()
        if (!dsl) return

        try {
            await this._renderer.compile(dsl, {
                shaderOverrides: this._shaderOverrides
            })
            this.showStatus('pipeline updated', 'success')
        } catch (err) {
            console.error('Pipeline compilation failed:', this.formatCompilationError(err))
            this.showStatus('compilation error: ' + this.formatCompilationError(err), 'error')
        }
    }

    /**
     * Create a control group for a parameter
     * @private
     */
    _createControlGroup(key, spec, effectInfo, effectKey) {
        // Skip hidden controls (control: false or hidden: true)
        if (spec.ui?.control === false || spec.ui?.hidden === true) {
            return null
        }

        const controlGroup = document.createElement('div')
        controlGroup.className = 'control-group'
        controlGroup.dataset.paramKey = key
        const label = document.createElement('span')
        label.className = 'control-label'
        label.textContent = spec.ui?.label || key

        // Add hint as tooltip if provided
        if (spec.ui?.hint) {
            label.classList.add('tooltip')
            label.dataset.title = spec.ui.hint
        }
        controlGroup.appendChild(label)

        // Track dependent controls for dynamic enable/disable
        if (spec.ui?.enabledBy) {
            this._dependentControls.push({
                element: controlGroup,
                effectKey,
                paramKey: key,
                enabledBy: spec.ui.enabledBy
            })
        }

        // Get value: prefer already-preserved value in state, then DSL args, then default
        let value
        const preservedValue = this._programState.getValue(effectKey, key)
        if (preservedValue !== undefined) {
            // Use preserved value from previous session (e.g., when adding another effect)
            value = preservedValue
        } else if (effectInfo.args[key] !== undefined) {
            value = effectInfo.args[key]
        } else {
            value = cloneParamValue(spec.default)
        }

        // Check original raw kwargs for variable reference
        const rawKwarg = effectInfo.rawKwargs?.[key]

        // If this param is controlled by an automation source (oscillator, midi, or audio),
        // show "automatic" and store the ORIGINAL variable reference if applicable.
        const automationValue = (value && typeof value === 'object') ? value : effectInfo.args?.[key]
        const isAutomated = (
            automationValue && typeof automationValue === 'object' && (
                automationValue._varRef ||
                automationValue.type === 'Oscillator' ||
                automationValue.type === 'Midi' ||
                automationValue.type === 'Audio' ||
                automationValue._ast?.type === 'Oscillator' ||
                automationValue._ast?.type === 'Midi' ||
                automationValue._ast?.type === 'Audio'
            )
        ) || (
            rawKwarg && typeof rawKwarg === 'object' && (
                rawKwarg.type === 'Oscillator' ||
                rawKwarg.type === 'Midi' ||
                rawKwarg.type === 'Audio'
            )
        )
        if (isAutomated) {
            // If the original was a variable reference (Ident), store that so we can
            // output "scale: o" instead of inlining the automation config
            if (rawKwarg && rawKwarg.type === 'Ident') {
                this._programState.setValue(effectKey, key, { _varRef: rawKwarg.name })
            }
            // Otherwise don't store anything - let the original value pass through

            const autoLabel = document.createElement('span')
            autoLabel.className = 'control-value'
            // Leading space keeps label text and status readable without relying on CSS margin
            autoLabel.textContent = ' automatic'
            autoLabel.style.fontStyle = 'italic'
            autoLabel.style.opacity = '0.7'
            controlGroup.appendChild(autoLabel)
            return controlGroup
        }

        // Initialize value in program state
        // Note: For 'color' type, _validateValue will convert hex strings to arrays
        // and ensure values are properly formatted vec3s
        this._programState.setValue(effectKey, key, value)

        // Create control based on type
        // Check for button control first (momentary boolean button)
        if (spec.ui?.control === 'button') {
            this._createButtonControl(controlGroup, key, spec)
        } else if (spec.ui?.control === 'checkbox' || spec.type === 'boolean') {
            // checkbox control for int uniforms that act as booleans (0/1)
            this._createBooleanControl(controlGroup, key, value, effectKey)
        } else if (spec.ui?.control === 'color' || spec.type === 'vec4') {
            // Color picker for vec4 or explicit color control
            this._createColorControl(controlGroup, key, value, effectKey, spec)
        } else if (spec.type === 'vec2') {
            this._createVector2dControl(controlGroup, key, value, effectKey, spec)
        } else if (spec.type === 'vec3') {
            this._createVector3dControl(controlGroup, key, value, effectKey, spec)
        } else if (spec.choices) {
            this._createChoicesControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.enum && spec.type === 'int') {
            this._createEnumIntControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'member') {
            this._createMemberControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'float' || spec.type === 'int') {
            this._createSliderControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'surface') {
            this._createSurfaceControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'volume') {
            this._createVolumeControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'geometry') {
            this._createGeometryControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'string') {
            this._createStringControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'enum') {
            this._createEnumControl(controlGroup, key, spec, value, effectKey)
        } else if (spec.type === 'color') {
            this._createHexColorControl(controlGroup, key, spec, value, effectKey)
        }

        return controlGroup
    }

    /** @private */
    _createBooleanControl(container, key, value, effectKey) {
        const handle = this._controlFactory.createToggle({
            value: !!value
        })

        const toggle = handle.element

        toggle.addEventListener('change', () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._onControlChange()
        })

        container.appendChild(toggle)

        container._controlHandle = handle
    }

    /**
     * Create a momentary button control for boolean uniforms
     * Button sets uniform to true, then resets to false after one frame
     * @private
     */
    _createButtonControl(container, key, spec) {
        const handle = this._controlFactory.createButton({
            label: spec.ui?.buttonLabel || 'reset',
            className: 'hf-action-btn tooltip',
            title: spec.ui?.label || key
        })

        const button = handle.element
        button.dataset.buttonType = spec.ui?.buttonLabel || 'reset'

        button.addEventListener('click', (e) => {
            e.stopPropagation()

            const pipeline = this._renderer.pipeline
            if (!pipeline) {
                return
            }

            const uniformName = spec.uniform || key

            // Set directly on globalUniforms (source of truth for runtime overrides)
            pipeline.globalUniforms[uniformName] = true

            // Also set on pass.uniforms for passes that have the uniform
            if (pipeline.graph && pipeline.graph.passes) {
                for (const pass of pipeline.graph.passes) {
                    if (pass.uniforms) {
                        pass.uniforms[uniformName] = true
                    }
                }
            }

            // Reset to false after render completes
            // Use 3 nested rAF to ensure: 1) sync to frame, 2) render happens, 3) reset after
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        pipeline.globalUniforms[uniformName] = false
                        if (pipeline.graph && pipeline.graph.passes) {
                            for (const pass of pipeline.graph.passes) {
                                if (pass.uniforms) {
                                    pass.uniforms[uniformName] = false
                                }
                            }
                        }
                    })
                })
            })
        })

        container.appendChild(button)

        // Buttons are momentary - no getValue/setValue needed for sync
        container._controlHandle = handle
    }

    /** @private */
    _createChoicesControl(container, key, spec, value, effectKey) {
        // Warn about spaces in enum keys (deprecated, should use camelCase)
        // Skip section headers (keys ending with ':') - they're UI-only separators
        for (const name of Object.keys(spec.choices)) {
            if (name.endsWith(':')) continue
            if (name.includes(' ')) {
                console.warn(`[Noisemaker] Deprecated: spaces in enum key "${name}" for "${key}". Use camelCase instead.`)
            }
        }

        // Build choices array for the factory
        const choices = []
        Object.entries(spec.choices).forEach(([name, val]) => {
            if (name.endsWith(':')) return
            choices.push({
                value: val,
                label: name,
                data: { paramValue: JSON.stringify(val) }
            })
        })

        // Use factory to create control
        const handle = this._controlFactory.createSelect({
            choices,
            value,
            className: 'hf-input'
        })

        const select = handle.element

        select.addEventListener('change', () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._onControlChange()
            // Note: compile-time `define:` globals trigger a recompile via the
            // ProgramState `recompileNeeded` listener wired in the constructor;
            // no per-control hook is needed.
        })

        container.appendChild(select)

        // Store control handle for pluggable sync
        container._controlHandle = handle
    }

    /** @private */
    _createEnumIntControl(container, key, spec, value, effectKey) {
        const enumPath = spec.enum
        const parts = enumPath.split('.')
        let node = this._renderer.enums
        for (const part of parts) {
            if (node && node[part]) {
                node = node[part]
            } else {
                node = null
                break
            }
        }

        if (node && typeof node === 'object') {
            // Build choices for the factory
            const choices = []
            Object.entries(node).forEach(([name, val]) => {
                const numVal = (val && typeof val === 'object' && 'value' in val) ? val.value : val
                choices.push({ value: numVal, label: name })
            })

            const handle = this._controlFactory.createSelect({
                choices,
                value,
                className: 'hf-input'
            })

            const select = handle.element

            select.addEventListener('change', () => {
                this._programState.setValue(effectKey, key, parseInt(handle.getValue(), 10))
                this._onControlChange()
            })

            container.appendChild(select)
            container._controlHandle = handle
        } else {
            // Fallback to slider
            const handle = this._controlFactory.createSlider({
                value: value,
                min: spec.min || 0,
                max: spec.max || 10,
                step: 1
            })

            const slider = handle.element

            slider.addEventListener('change', () => {
                this._programState.setValue(effectKey, key, parseInt(handle.getValue(), 10))
                this._onControlChange()
            })

            container.appendChild(slider)
            container._controlHandle = handle
        }
    }

    /** @private */
    _createMemberControl(container, key, spec, value, effectKey) {
        let enumPath = spec.enum || spec.enumPath
        if (!enumPath && typeof spec.default === 'string') {
            const parts = spec.default.split('.')
            if (parts.length > 1) {
                enumPath = parts.slice(0, -1).join('.')
            }
        }

        if (enumPath) {
            const parts = enumPath.split('.')
            let node = this._renderer.enums
            for (const part of parts) {
                if (node && node[part]) {
                    node = node[part]
                } else {
                    node = null
                    break
                }
            }

            if (node) {
                // Build choices for the factory
                const choices = []
                const enumEntries = []
                Object.keys(node).forEach(k => {
                    const fullPath = `${enumPath}.${k}`
                    const enumEntry = node[k]
                    const numericValue = (enumEntry && typeof enumEntry === 'object' && 'value' in enumEntry)
                        ? enumEntry.value
                        : enumEntry
                    choices.push({
                        value: fullPath,
                        label: k,
                        data: { enumValue: numericValue }
                    })
                    enumEntries.push({ path: fullPath, numericValue })
                })

                // Find the initial value - match by numeric or path
                let initialValue = choices[0]?.value
                for (const entry of enumEntries) {
                    if (entry.numericValue === value || entry.path === value) {
                        initialValue = entry.path
                        break
                    }
                }

                // Store resolved path in state (replaces numeric value from DSL)
                // so enabledBy conditions can match against string paths
                this._programState.setValue(effectKey, key, initialValue)

                const handle = this._controlFactory.createSelect({
                    choices,
                    value: initialValue,
                    className: 'hf-input'
                })

                const select = handle.element

                select.addEventListener('change', () => {
                    this._programState.setValue(effectKey, key, handle.getValue())
                    this._onControlChange()
                })

                container.appendChild(select)

                // Wrap handle with custom setValue that understands numeric values
                container._controlHandle = {
                    element: select,
                    getValue: handle.getValue,
                    setValue: (v) => {
                        // Match by numeric value or string path
                        for (const entry of enumEntries) {
                            if (entry.numericValue === v || entry.path === v) {
                                handle.setValue(entry.path)
                                return
                            }
                        }
                        handle.setValue(v)
                    }
                }
            }
        }
    }

    /** @private */
    _createSliderControl(container, key, spec, value, effectKey) {
        const isInt = spec.type === 'int'
        const formatVal = (v) => isInt ? v : Number(v).toFixed(2)

        const handle = this._controlFactory.createSlider({
            value: value !== null ? value : (spec.min !== undefined ? spec.min : 0),
            min: spec.min !== undefined ? spec.min : 0,
            max: spec.max !== undefined ? spec.max : 100,
            step: spec.step !== undefined ? spec.step : (isInt ? 1 : 0.01),
            className: 'control-slider'
        })

        const slider = handle.element
        container.appendChild(slider)

        // slider-value web component has a built-in value display — skip the duplicate
        const hasBuiltInDisplay = slider.tagName === 'SLIDER-VALUE'
        let valueDisplayHandle = null
        if (!hasBuiltInDisplay) {
            valueDisplayHandle = this._controlFactory.createValueDisplay({
                value: value !== null ? formatVal(value) : '',
                className: 'control-value'
            })
            container.appendChild(valueDisplayHandle.element)
        }

        slider.addEventListener('input', () => {
            const numVal = isInt ? parseInt(handle.getValue()) : parseFloat(handle.getValue())
            if (valueDisplayHandle) valueDisplayHandle.setValue(formatVal(numVal))
            this._programState.setValue(effectKey, key, numVal)
            this._syncTextInputsFromParams()
        })

        slider.addEventListener('change', () => {
            this._onControlChange()
        })

        container._controlHandle = {
            element: slider,
            getValue: () => isInt ? parseInt(handle.getValue()) : parseFloat(handle.getValue()),
            setValue: (v) => {
                handle.setValue(v)
                if (valueDisplayHandle) valueDisplayHandle.setValue(formatVal(v))
            }
        }
        container._valueDisplayHandle = valueDisplayHandle
    }

    /** @private */
    _createColorControl(container, key, value, effectKey, spec) {
        const isVec4 = spec?.type === 'vec4'

        // Convert hex string to array if needed
        let colorArray
        if (Array.isArray(value)) {
            colorArray = value
        } else if (typeof value === 'string' && value.startsWith('#')) {
            // Parse hex color to [r, g, b] array (0-1 range)
            const hex = value.slice(1)
            colorArray = [
                parseInt(hex.slice(0, 2), 16) / 255,
                parseInt(hex.slice(2, 4), 16) / 255,
                parseInt(hex.slice(4, 6), 16) / 255
            ]
        } else {
            colorArray = [0, 0, 0]
        }

        const handle = this._controlFactory.createColorPicker({
            value: colorArray,
            hasAlpha: isVec4,
            className: 'control-color'
        })

        const colorInput = handle.element

        colorInput.addEventListener('input', () => {
            const colorVal = handle.getValue()
            if (isVec4) {
                // For vec4, preserve alpha or default to 1
                const currentVal = this._programState.getValue(effectKey, key)
                const a = (Array.isArray(currentVal) && currentVal.length >= 4 && typeof currentVal[3] === 'number')
                    ? currentVal[3]
                    : 1
                this._programState.setValue(effectKey, key, [colorVal[0], colorVal[1], colorVal[2], a])
            } else {
                this._programState.setValue(effectKey, key, colorVal)
            }
            this._onControlChange()
        })

        container.appendChild(colorInput)
        container._controlHandle = handle
    }

    /**
     * Create a vector2d control for vec2 parameters.
     * @private
     */
    _createVector2dControl(container, key, value, effectKey, spec) {
        const val = Array.isArray(value) ? value : [0, 0]

        const handle = this._controlFactory.createVector2dPicker({
            value: val,
            min: spec.min,
            max: spec.max,
            step: spec.step
        })

        handle.element.addEventListener('input', () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._onControlChange()
        })

        container.appendChild(handle.element)
        container._controlHandle = handle
    }

    /**
     * Create a vector3d control for vec3 parameters (direction, position, etc.).
     * @private
     */
    _createVector3dControl(container, key, value, effectKey, spec) {
        const val = Array.isArray(value) ? value : [0, 0, 0]

        const handle = this._controlFactory.createVector3dPicker({
            value: val,
            min: spec.min,
            max: spec.max,
            step: spec.step
        })

        handle.element.addEventListener('input', () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._onControlChange()
        })

        container.appendChild(handle.element)
        container._controlHandle = handle
    }

    /** @private */
    _createSurfaceControl(container, key, spec, value, effectKey) {
        // Available surfaces: none + o0-o7 for output surfaces
        const surfaces = [
            { value: 'none', label: 'none' },
            { value: 'o0', label: 'o0' },
            { value: 'o1', label: 'o1' },
            { value: 'o2', label: 'o2' },
            { value: 'o3', label: 'o3' },
            { value: 'o4', label: 'o4' },
            { value: 'o5', label: 'o5' },
            { value: 'o6', label: 'o6' },
            { value: 'o7', label: 'o7' }
        ]

        // Parse current value to get the surface ID
        let currentSurface = spec.default || 'o1'
        if (value && typeof value === 'object' && value.name) {
            currentSurface = value.name
        } else if (typeof value === 'string') {
            const match = value.match(/read\(([^)]+)\)|^(o[0-7])$/)
            if (match) {
                currentSurface = match[1] || match[2]
            } else if (value) {
                currentSurface = value
            }
        }

        const handle = this._controlFactory.createSelect({
            choices: surfaces,
            value: currentSurface,
            className: 'hf-input'
        })

        const select = handle.element

        select.addEventListener('change', async () => {
            const val = handle.getValue()
            this._programState.setValue(effectKey, key, val === 'none' ? 'none' : `read(${val})`)
            this._updateDslFromEffectParams()
            await this._recompilePipeline()
            this._updateDependentControls()
        })

        container.appendChild(select)

        // Wrap handle with custom getValue/setValue for surface format
        container._controlHandle = {
            element: select,
            getValue: () => {
                const val = handle.getValue()
                return val === 'none' ? 'none' : `read(${val})`
            },
            setValue: (v) => {
                let surfaceId = v
                if (typeof v === 'object' && v.name) {
                    surfaceId = v.name
                } else if (typeof v === 'string') {
                    const match = v.match(/read\(([^)]+)\)|^(o[0-7])$/)
                    if (match) surfaceId = match[1] || match[2]
                }
                handle.setValue(surfaceId || 'none')
            }
        }
    }

    /** @private */
    _createVolumeControl(container, key, spec, value, effectKey) {
        const volumes = [
            { value: 'none', label: 'none' },
            { value: 'vol0', label: 'vol0' },
            { value: 'vol1', label: 'vol1' },
            { value: 'vol2', label: 'vol2' },
            { value: 'vol3', label: 'vol3' },
            { value: 'vol4', label: 'vol4' },
            { value: 'vol5', label: 'vol5' },
            { value: 'vol6', label: 'vol6' },
            { value: 'vol7', label: 'vol7' }
        ]

        let currentVolume = spec.default || 'vol0'
        if (value && typeof value === 'object' && value.name) {
            currentVolume = value.name
        } else if (typeof value === 'string') {
            const match = value.match(/^(vol[0-7])$/)
            if (match) {
                currentVolume = match[1]
            } else if (value) {
                currentVolume = value
            }
        }

        const handle = this._controlFactory.createSelect({
            choices: volumes,
            value: currentVolume,
            className: 'hf-input'
        })

        const select = handle.element

        select.addEventListener('change', async () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._updateDslFromEffectParams()
            await this._recompilePipeline()
        })

        container.appendChild(select)

        container._controlHandle = {
            element: select,
            getValue: handle.getValue,
            setValue: (v) => {
                let volId = v
                if (typeof v === 'object' && v.name) volId = v.name
                handle.setValue(volId || 'none')
            }
        }
    }

    /** @private */
    _createGeometryControl(container, key, spec, value, effectKey) {
        const geometries = [
            { value: 'none', label: 'none' },
            { value: 'geo0', label: 'geo0' },
            { value: 'geo1', label: 'geo1' },
            { value: 'geo2', label: 'geo2' },
            { value: 'geo3', label: 'geo3' },
            { value: 'geo4', label: 'geo4' },
            { value: 'geo5', label: 'geo5' },
            { value: 'geo6', label: 'geo6' },
            { value: 'geo7', label: 'geo7' }
        ]

        let currentGeometry = spec.default || 'geo0'
        if (value && typeof value === 'object' && value.name) {
            currentGeometry = value.name
        } else if (typeof value === 'string') {
            const match = value.match(/^(geo[0-7])$/)
            if (match) {
                currentGeometry = match[1]
            } else if (value) {
                currentGeometry = value
            }
        }

        const handle = this._controlFactory.createSelect({
            choices: geometries,
            value: currentGeometry,
            className: 'hf-input'
        })

        const select = handle.element

        select.addEventListener('change', async () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._updateDslFromEffectParams()
            await this._recompilePipeline()
        })

        container.appendChild(select)

        container._controlHandle = {
            element: select,
            getValue: handle.getValue,
            setValue: (v) => {
                let geoId = v
                if (typeof v === 'object' && v.name) geoId = v.name
                handle.setValue(geoId || 'none')
            }
        }
    }

    /** @private Create a text input control for string type */
    _createStringControl(container, key, spec, value, effectKey) {
        const isMultiline = spec.ui?.multiline !== false
        const input = document.createElement(isMultiline ? 'textarea' : 'input')
        if (!isMultiline) input.type = 'text'
        input.value = value || spec.default || ''
        if (isMultiline) input.rows = 3
        input.style.cssText = 'width: 100%; padding: 0.375rem 0.5rem; background: var(--color1); border: 1px solid var(--color3); border-radius: var(--ui-corner-radius-small); color: var(--color6); font-family: var(--hf-font-family); font-size: 0.75rem; resize: vertical;'

        input.addEventListener('input', () => {
            this._programState.setValue(effectKey, key, input.value)
            this._onControlChange()
        })

        container.appendChild(input)
        container._controlHandle = {
            element: input,
            getValue: () => input.value,
            setValue: (v) => { input.value = v || '' }
        }
    }

    /** @private Create a select control for enum type */
    _createEnumControl(container, key, spec, value, effectKey) {
        const options = spec.options || []
        const choices = options.map(opt => ({ value: opt, label: opt }))

        const handle = this._controlFactory.createSelect({
            choices,
            value: value || spec.default || options[0],
            className: 'hf-input'
        })

        const select = handle.element

        select.addEventListener('change', () => {
            this._programState.setValue(effectKey, key, handle.getValue())
            this._onControlChange()
        })

        container.appendChild(select)
        container._controlHandle = handle
    }

    /** @private Create a color picker for hex color string type */
    _createHexColorControl(container, key, spec, value, effectKey) {
        const colorInput = document.createElement('input')
        colorInput.type = 'color'

        // Convert array [r,g,b] (0-1 range) to hex if needed
        let hexValue = value
        if (Array.isArray(value)) {
            const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')
            hexValue = `#${toHex(value[0])}${toHex(value[1])}${toHex(value[2])}`
        }
        colorInput.value = hexValue || spec.default || '#ffffff'
        colorInput.style.cssText = 'width: 100%; height: 2rem; padding: 0; border: 1px solid var(--color3); border-radius: var(--ui-corner-radius-small); cursor: pointer;'

        colorInput.addEventListener('input', () => {
            this._programState.setValue(effectKey, key, colorInput.value)
            this._onControlChange()
        })

        container.appendChild(colorInput)
        container._controlHandle = {
            element: colorInput,
            getValue: () => colorInput.value,
            setValue: (v) => { colorInput.value = v || '#ffffff' }
        }
    }

    /** @private Called when a control value changes */
    _onControlChange() {
        this._updateDependentControls()
        this._updateDslFromEffectParams()
        this._syncTextInputsFromParams()
        if (this._onControlChangeCallback) {
            this._onControlChangeCallback()
        }
    }

    /**
     * Sync text canvas state from programState and re-render
     * Called when any control changes - only affects text effects
     * @private
     */
    _syncTextInputsFromParams() {
        for (const [stepIndex, textState] of this._textInputs.entries()) {
            const params = this._programState.getStepValues(textState.effectKey)
            if (!params) continue

            // Sync values from generic controls to text state
            textState.textContent = params.text ?? textState.textContent
            textState.font = params.font ?? textState.font
            textState.size = params.size ?? textState.size
            textState.posX = params.posX ?? textState.posX
            textState.posY = params.posY ?? textState.posY
            textState.color = params.color ?? textState.color
            textState.rotation = params.rotation ?? textState.rotation
            textState.bgColor = params.bgColor ?? textState.bgColor
            textState.bgOpacity = params.bgOpacity ?? textState.bgOpacity
            textState.justify = params.justify ?? textState.justify

            // Re-render text to canvas
            this._renderTextToCanvas(stepIndex)
        }
    }

    /**
     * Update disabled state of dependent controls based on their enabledBy values
     * @private
     */
    _updateDependentControls() {
        for (const dep of this._dependentControls) {
            const { element, effectKey, enabledBy } = dep
            const params = this._programState.getStepValues(effectKey)
            if (!params) continue

            const isEnabled = this._evaluateEnableCondition(enabledBy, params)

            if (isEnabled) {
                element.classList.remove('disabled')
            } else {
                element.classList.add('disabled')
            }
        }
    }

    /**
     * Evaluate an enabledBy condition against current parameter values
     *
     * Supports multiple formats:
     * - String (legacy): "paramName" - uses _isControlEnabled for truthy check
     * - Object with conditions:
     *   - { param: "name", eq: value } - equals
     *   - { param: "name", neq: value } - not equals
     *   - { param: "name", gt: value } - greater than
     *   - { param: "name", gte: value } - greater than or equal
     *   - { param: "name", lt: value } - less than
     *   - { param: "name", lte: value } - less than or equal
     *   - { param: "name", in: [values] } - value is member of array
     *   - { param: "name", notIn: [values] } - value is not member of array
     *   - Multiple conditions in one object are AND'd together
     * - { or: [condition1, condition2, ...] } - OR multiple conditions
     * - { and: [condition1, condition2, ...] } - AND multiple conditions (explicit)
     * - { not: condition } - negate a condition
     *
     * @param {string|object} condition - The enabledBy condition
     * @param {object} params - Current parameter values
     * @returns {boolean} Whether the control should be enabled
     * @private
     */
    _evaluateEnableCondition(condition, params) {
        // Legacy string format: just a param name
        if (typeof condition === 'string') {
            const value = params[condition]
            return this._isControlEnabled(value)
        }

        // Must be an object
        if (typeof condition !== 'object' || condition === null) {
            return true // Invalid condition, default to enabled
        }

        // Handle OR conditions
        if (Array.isArray(condition.or)) {
            return condition.or.some(c => this._evaluateEnableCondition(c, params))
        }

        // Handle AND conditions (explicit)
        if (Array.isArray(condition.and)) {
            return condition.and.every(c => this._evaluateEnableCondition(c, params))
        }

        // Handle NOT condition
        if (condition.not !== undefined) {
            return !this._evaluateEnableCondition(condition.not, params)
        }

        // Standard condition object with param and operators
        const paramName = condition.param
        if (!paramName) {
            return true // No param specified, default to enabled
        }

        const value = params[paramName]

        // If no operators specified, use legacy truthy check
        const operators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn']
        const hasOperator = operators.some(op => condition[op] !== undefined)

        if (!hasOperator) {
            return this._isControlEnabled(value)
        }

        // Evaluate all operators (AND logic for multiple operators)
        let result = true

        if (condition.eq !== undefined) {
            result = result && this._valuesEqual(value, condition.eq)
        }

        if (condition.neq !== undefined) {
            result = result && !this._valuesEqual(value, condition.neq)
        }

        if (condition.gt !== undefined) {
            result = result && (typeof value === 'number' && value > condition.gt)
        }

        if (condition.gte !== undefined) {
            result = result && (typeof value === 'number' && value >= condition.gte)
        }

        if (condition.lt !== undefined) {
            result = result && (typeof value === 'number' && value < condition.lt)
        }

        if (condition.lte !== undefined) {
            result = result && (typeof value === 'number' && value <= condition.lte)
        }

        if (condition.in !== undefined && Array.isArray(condition.in)) {
            result = result && condition.in.some(v => this._valuesEqual(value, v))
        }

        if (condition.notIn !== undefined && Array.isArray(condition.notIn)) {
            result = result && !condition.notIn.some(v => this._valuesEqual(value, v))
        }

        return result
    }

    /**
     * Compare two values for equality, handling different types
     * @private
     */
    _valuesEqual(a, b) {
        // Handle null/undefined
        if (a === b) return true
        if (a === null || a === undefined || b === null || b === undefined) return false

        // Handle arrays (vec2/vec3/vec4)
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false
            return a.every((v, i) => Math.abs(v - b[i]) < 0.0001)
        }

        // Handle numbers with tolerance
        if (typeof a === 'number' && typeof b === 'number') {
            return Math.abs(a - b) < 0.0001
        }

        // Default equality
        return a === b
    }

    /**
     * Check if a control's enabler value means the dependent control should be enabled
     * Used for legacy string-based enabledBy (truthy check)
     * @private
     */
    _isControlEnabled(value) {
        if (value === undefined || value === null) return false

        // Boolean: must be true
        if (typeof value === 'boolean') return value

        // Number: must be non-zero
        if (typeof value === 'number') return value !== 0

        // Array (vec3/vec4): check if any component differs from neutral 0.5
        if (Array.isArray(value)) {
            // For color wheels, neutral is [0.5, 0.5, 0.5] or [0.5, 0.5, 0.5, 1]
            return value.some((v, i) => {
                if (i === 3) return false // Alpha doesn't count
                return Math.abs(v - 0.5) > 0.01
            })
        }

        // String: non-empty
        if (typeof value === 'string') return value.length > 0

        // Object: truthy
        return !!value
    }

    /**
     * Update DSL from effect parameter values
     * @private
     */
    _updateDslFromEffectParams() {
        const newDsl = this._programState.toDsl()
        if (newDsl && newDsl !== this.getDsl()) {
            this.setDsl(newDsl)
            this._renderer.currentDsl = newDsl
        }
    }

    // =========================================================================
    // Effect Selection and Pipeline Management
    // =========================================================================

    /**
     * Initialize parameter values from effect defaults
     * @param {object} effect - Effect object
     */
    initParameterValues(effect) {
        this._parameterValues = {}
        this._shaderOverrides = {} // Clear shader overrides when switching effects
        if (effect.instance && effect.instance.globals) {
            for (const [key, spec] of Object.entries(effect.instance.globals)) {
                if (spec.default !== undefined) {
                    this._parameterValues[key] = cloneParamValue(spec.default)
                }
            }
        }
    }

    /**
     * Clear all shader overrides
     */
    clearShaderOverrides() {
        this._shaderOverrides = {}
        this._programState.clearRoutingOverrides()
    }

    /**
     * Format a compilation error for display
     * @param {Error} err - Error object
     * @param {string} [dslSource] - Optional DSL source for context
     * @returns {string} Formatted error message (short for status bar)
     */
    formatCompilationError(err, dslSource) {
        // For DSL syntax errors, log the nicely formatted version to console
        if (isDslSyntaxError(err)) {
            const source = dslSource || this.getDsl()
            if (source) {
                console.warn('DSL Syntax Error:\n' + formatDslError(source, err))
            }
        }

        if (err.code === 'ERR_COMPILATION_FAILED' && Array.isArray(err.diagnostics)) {
            return err.diagnostics
                .filter(d => d.severity === 'error')
                .map(d => {
                    let msg = d.message || 'Unknown error'
                    if (d.location) {
                        msg += ` (line ${d.location.line}, col ${d.location.column})`
                    }
                    return msg
                })
                .join('; ') || 'Unknown compilation error'
        }
        return err.message || err.detail || (typeof err === 'object' ? JSON.stringify(err) : String(err))
    }
}

// Re-export utilities that might be needed externally
export { cloneParamValue, isStarterEffect, hasTexSurfaceParam, hasExplicitTexParam, getVolGeoParams, is3dGenerator, is3dProcessor, getEffect }

// Re-export DSL error formatting utilities
export { formatDslError, isDslSyntaxError }

// Re-export ControlFactory for downstream customization
export { ControlFactory, defaultControlFactory } from './control-factory.js'

// Re-export ProgramState for downstream use
export { ProgramState } from './program-state.js'
export { Emitter } from './emitter.js'
