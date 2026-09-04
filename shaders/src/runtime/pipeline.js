/**
 * Pipeline Executor
 * Orchestrates frame execution using a compiled graph and backend.
 */

import { WebGL2Backend } from './backends/webgl2.js'
import { WebGPUBackend } from './backends/webgpu.js'
import { expandPalette } from './palette-expansion.js'
import { getEffect } from './registry.js'
import { Effect } from './effect.js'
import { CUBE_FACE_BASES } from '../renderer/cubeCamera.js'
import { CanvasSink, SinkManager } from './sink.js'

/**
 * Oscillator evaluation functions.
 * Each returns a value between 0 and 1 based on the time phase.
 *
 * Oscillator types:
 * 0: sine    - 0 → 1 → 0 (smooth)
 * 1: tri     - 0 → 1 → 0 (linear)
 * 2: saw     - 0 → 1
 * 3: sawInv  - 1 → 0
 * 4: square  - 0 or 1
 * 5: noise   - periodic 2D noise
 */
const TAU = Math.PI * 2

function oscSine(t) {
    // Smooth continuous sine: 0->1->0 over t=0..1, no discontinuity at wrap
    return (1.0 - Math.cos(t * TAU)) * 0.5
}

function oscTri(t) {
    // Triangle wave: 0->1->0 over t=0..1
    const tf = t - Math.floor(t)
    return 1.0 - Math.abs(tf * 2.0 - 1.0)
}

function oscSaw(t) {
    // Sawtooth: 0->1 over t=0..1
    return t - Math.floor(t)
}

function oscSawInv(t) {
    // Inverted sawtooth: 1->0 over t=0..1
    return 1.0 - (t - Math.floor(t))
}

function oscSquare(t) {
    // Square wave: 0 or 1
    return (t - Math.floor(t)) >= 0.5 ? 1.0 : 0.0
}

// Simple hash for noise
function hash21(px, py, s) {
    let x = (px * 234.34 + s) % 1
    let y = (py * 435.345 + s) % 1
    if (x < 0) x += 1
    if (y < 0) y += 1
    const p = x + y + (x + y) * 34.23
    return (x * y * p) % 1
}

// Value noise 2D
function noise2D(px, py, s) {
    const ix = Math.floor(px)
    const iy = Math.floor(py)
    let fx = px - ix
    let fy = py - iy
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)

    const a = hash21(ix, iy, s)
    const b = hash21(ix + 1, iy, s)
    const c = hash21(ix, iy + 1, s)
    const d = hash21(ix + 1, iy + 1, s)

    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

// Looping noise - samples on a circle for seamless temporal loops
function oscNoise(t, seed) {
    const temporal = t % 1
    const angle = temporal * TAU
    const radius = 2
    const loopX = Math.cos(angle) * radius
    const loopY = Math.sin(angle) * radius
    const n1 = noise2D(loopX + seed, loopY + seed, seed)
    const n2 = noise2D(loopX + seed * 2, loopY + seed * 2, seed)
    return (n1 + n2) / 2
}

/**
 * Evaluate an oscillator value based on current time and animation duration.
 *
 * @param {object} osc - Oscillator configuration
 * @param {number} osc.oscType - 0:sine, 1:tri, 2:saw, 3:sawInv, 4:square, 5:noise
 * @param {number} osc.min - Minimum output value
 * @param {number} osc.max - Maximum output value
 * @param {number} osc.speed - Speed multiplier (integer, divides evenly into loop)
 * @param {number} osc.offset - Phase offset 0..1
 * @param {number} osc.seed - Noise seed (for noise type only)
 * @param {number} normalizedTime - Time normalized to animation duration (0..1)
 * @returns {number} The evaluated oscillator value
 */
function evaluateOscillator(osc, normalizedTime) {
    const { oscType, min, max, speed, offset, seed } = osc

    // Apply speed and offset
    const t = normalizedTime * speed + offset

    // Get raw oscillator value (0..1)
    let value
    switch (oscType) {
        case 0: value = oscSine(t); break
        case 1: value = oscTri(t); break
        case 2: value = oscSaw(t); break
        case 3: value = oscSawInv(t); break
        case 4: value = oscSquare(t); break
        case 5: value = oscNoise(t, seed); break
        default: value = 0
    }

    // Map to min..max range
    return min + value * (max - min)
}

/**
 * Evaluate a MIDI automation value based on channel state.
 *
 * MIDI Modes:
 * 0: noteChange - value from note number regardless of gate
 * 1: gateNote - value from note only while gate is on
 * 2: gateVelocity - value from velocity only while gate is on
 * 3: triggerNote - note value with time-based falloff from note-on
 * 4: velocity - velocity with time-based falloff (default)
 *
 * @param {object} config - MIDI configuration
 * @param {number} config.channel - MIDI channel (1-16)
 * @param {number} config.mode - MIDI mode (0-4)
 * @param {number} config.min - Minimum output value
 * @param {number} config.max - Maximum output value
 * @param {number} config.sensitivity - Trigger falloff rate (higher = faster decay)
 * @param {import('./external-input.js').MidiState} midiState - Current MIDI state
 * @param {number} currentTime - Current time (Date.now())
 * @returns {number} The evaluated value in min..max range
 */
function evaluateMidi(config, midiState, currentTime) {
    if (!midiState) return config.min

    const channel = midiState.getChannel(config.channel)
    const { mode, min, max, sensitivity } = config

    let rawValue = 0

    switch (mode) {
        case 0: // noteChange - value from note regardless of gate
            rawValue = channel.key
            break

        case 1: // gateNote - value from note only while gate on
            if (channel.gate === 1) {
                rawValue = channel.key
            }
            break

        case 2: // gateVelocity - value from velocity only while gate on
            if (channel.gate === 1) {
                rawValue = channel.velocity
            }
            break

        case 3: // triggerNote - note value with falloff
            if (channel.gate === 1) {
                rawValue = channel.key
                const elapsed = currentTime - channel.time
                const decay = Math.min(1, elapsed * sensitivity * 0.001)
                rawValue = rawValue * (1 - decay)
            }
            break

        case 4: // velocity (default) - velocity with falloff
        default:
            if (channel.gate === 1) {
                rawValue = channel.velocity
                const elapsed = currentTime - channel.time
                const decay = Math.min(1, elapsed * sensitivity * 0.001)
                rawValue = rawValue * (1 - decay)
            }
            break
    }

    // Map 0-127 MIDI range to min-max output range
    const normalized = rawValue / 127
    return min + normalized * (max - min)
}

/**
 * Evaluate an audio automation value based on frequency band.
 *
 * Audio Bands:
 * 0: low - Low frequency band
 * 1: mid - Mid frequency band
 * 2: high - High frequency band
 * 3: vol - Overall volume
 * 4: raw - Bipolar time-domain/DC signal
 *
 * @param {object} config - Audio configuration
 * @param {number} config.band - Audio band or raw signal mode (0-4)
 * @param {number} config.min - Minimum output value
 * @param {number} config.max - Maximum output value
 * @param {import('./external-input.js').AudioState} audioState - Current audio state
 * @returns {number} The evaluated value in min..max range
 */
function evaluateAudio(config, audioState) {
    if (config._invalid) return config.min
    if (!audioState) return config.min

    const { band, min, max } = config
    const hasDeviceSelector = !!(config.name || config.id || config.channel !== undefined)
    const selectedState = hasDeviceSelector
        ? audioState.getDeviceChannelState?.(config)
        : audioState
    if (!selectedState) return min

    let rawValue = 0

    switch (band) {
        case 0: // low
            rawValue = selectedState.low
            break
        case 1: // mid
            rawValue = selectedState.mid
            break
        case 2: // high
            rawValue = selectedState.high
            break
        case 4: // raw bipolar signal
            if (selectedState.rawReady !== true) return min
            rawValue = (Math.max(-1, Math.min(1, selectedState.raw || 0)) + 1) * 0.5
            break
        case 3: // vol
            rawValue = selectedState.vol
            break
        default:
            rawValue = 0
            break
    }

    // rawValue is already 0-1, clamp and map to min-max
    rawValue = Math.max(0, Math.min(1, rawValue))
    return min + rawValue * (max - min)
}

export class Pipeline {
    constructor(graph, backend) {
        this.graph = graph
        this.backend = backend
        this.sinkManager = new SinkManager()
        this._sinkDescriptor = {
            width: 0,
            height: 0,
            format: 'rgba8unorm',
            colorSpace: 'srgb',
            alphaMode: 'premultiplied',
            fps: 60
        }
        if (typeof backend?.present === 'function') {
            this.sinkManager.add(new CanvasSink(backend))
        }
        this._disposed = false
        this.frameIndex = 0
        this.lastTime = 0
        this.surfaces = new Map()        // Global surfaces (o0-o7)
        this.globalUniforms = {}
        this.width = 0
        this.height = 0
        // Pre-allocate frame Maps to avoid per-frame allocation
        this.frameReadTextures = new Map()
        this.frameWriteTextures = new Map()
        this.animationDuration = 10  // Default animation loop duration in seconds
        // Pre-allocate frame state object to avoid per-frame allocation
        this._frameState = {
            frameIndex: 0,
            time: 0,
            globalUniforms: null,
            surfaces: {},
            writeSurfaces: {},
            graph: null,
            screenWidth: 0,
            screenHeight: 0
        }
        // Pre-allocated surface key arrays to avoid allocation during getFrameState
        this._surfaceKeys = []
        this._writeSurfaceKeys = []
        // Pre-allocated pass proxy for oscillator resolution (avoids per-frame object spread)
        this._oscillatorPassProxy = {
            uniforms: {}
        }
        this._resolvedUniforms = {}  // Reused for oscillator resolution
        // Track render passes per frame
        this.lastPassCount = 0
        // Flag to prevent rendering during async program compilation
        this.isCompiling = false
        // Tile region state for tiled large-resolution export
        this._tileOffset = null       // [x, y] pixel offset, or null when not tiling
        this._fullResolution = null   // [w, h] full image size, or null when not tiling
        // External input state (MIDI & Audio) - set by host application
        this.externalState = {
            midi: null,   // MidiState instance
            audio: null   // AudioState instance
        }

        // Track effect instances for asyncInit lifecycle
        this._asyncRenders = new Map()  // nodeId → cancel function
    }

    /**
     * Register an output sink for the selected render surface.
     * @param {{configure: Function, submit: Function, close: Function}} sink
     * @returns {() => void} Idempotent sink removal function
     */
    addSink(sink) {
        return this.sinkManager.add(sink)
    }

    /**
     * Set the MIDI state for midi() function resolution.
     * The host application should create a MidiState instance and pass it here.
     * @param {import('./external-input.js').MidiState} midiState
     */
    setMidiState(midiState) {
        this.externalState.midi = midiState
    }

    /**
     * Set the audio state for audio() function resolution.
     * The host application should create an AudioState instance and pass it here.
     * @param {import('./external-input.js').AudioState} audioState
     */
    setAudioState(audioState) {
        this.externalState.audio = audioState
    }

    /**
     * Get device capabilities from the backend.
     * Useful for UI to show/hide options or adjust defaults.
     * @returns {{isMobile: boolean, floatBlend: boolean, floatLinear: boolean, colorBufferFloat: boolean, maxDrawBuffers: number, maxTextureSize: number, maxColorBytesPerSample: number, maxStateSize: number}}
     */
    getCapabilities() {
        return this.backend?.capabilities || {
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

    /**
     * Set the animation duration for oscillators.
     * Oscillators loop evenly over this duration.
     * @param {number} seconds - Animation loop duration in seconds
     */
    setAnimationDuration(seconds) {
        this.animationDuration = seconds
    }

    /**
     * Initialize the pipeline
     * @param {number} width - Width in pixels
     * @param {number} height - Height in pixels
     */
    async init(width, height) {
        await this.backend.init()
        await this.compilePrograms()
        this.resize(width, height)
    }

    /**
     * Compile all shader programs referenced by the graph.
     * Sets isCompiling flag to prevent render loop from executing during compilation.
     */
    async compilePrograms() {
        if (!this.graph || !this.graph.passes) return

        this.isCompiling = true

        try {
            const compiled = new Set()

            for (const pass of this.graph.passes) {
                if (compiled.has(pass.program)) continue

                const spec = this.resolveProgramSpec(pass)

                if (!spec) {
                    throw {
                        code: 'ERR_PROGRAM_SPEC_MISSING',
                        program: pass.program,
                        pass: pass.id
                    }
                }

                await this.backend.compileProgram(pass.program, spec)
                compiled.add(pass.program)
            }
        } finally {
            this.isCompiling = false
        }
    }

    /**
     * Resolve the program specification for a pass
     */
    resolveProgramSpec(pass) {
        const programs = this.graph?.programs

        if (programs instanceof Map && programs.has(pass.program)) {
            return programs.get(pass.program)
        }

        if (programs && typeof programs === 'object' && programs[pass.program]) {
            return programs[pass.program]
        }

        return null
    }

    /**
     * Resize the pipeline
     * @param {number} width - Width in pixels
     * @param {number} height - Height in pixels
     */
    resize(width, height) {
        this.width = width
        this.height = height
        this._sinkDescriptor.width = width
        this._sinkDescriptor.height = height
        this.sinkManager.configure(this._sinkDescriptor)

        // Create/recreate global surfaces
        this.createSurfaces()

        // Recreate textures with screen-relative dimensions
        // Collect default uniforms from passes for parameter-based texture sizing
        const defaultUniforms = this.collectDefaultUniforms()
        this.recreateTextures(defaultUniforms)
        this.initAsyncEffects()
    }

    /**
     * Initialize effects that have asyncInit handlers.
     * Called after texture allocation and on seed change.
     */
    initAsyncEffects() {
        if (!this.graph || !this.graph.passes) return

        // Full reset before re-rendering: cancel in-flight traces (including
        // nodes no longer present in the current graph), drop pending
        // debounced regens, and clear the param cache. Without the cache
        // clear, a post-recompile checkAsyncRegen with the step's real values
        // would compare against values recorded for a PREVIOUS graph's
        // overlay and suppress the corrective re-trace, leaving the overlay
        // rendered with effect defaults while the UI reports the real value.
        for (const cancel of this._asyncRenders.values()) cancel()
        this._asyncRenders.clear()
        if (this._asyncDebounceTimers) {
            for (const timer of this._asyncDebounceTimers.values()) clearTimeout(timer)
            this._asyncDebounceTimers.clear()
        }
        this._asyncParamCache?.clear()

        // Find unique effects with asyncInit by scanning passes
        const seen = new Set()
        for (const pass of this.graph.passes) {
            if (!pass.effectKey || !pass.nodeId || seen.has(pass.nodeId)) continue
            seen.add(pass.nodeId)

            const effectDef = getEffect(pass.effectKey)
            if (!effectDef) continue

            // Check if effect has a real asyncInit (not the base class no-op)
            if (!effectDef._configAsyncInit && effectDef.asyncInit === Effect.prototype.asyncInit) continue

            this._startAsyncInit(pass.nodeId, effectDef)
        }
    }

    /**
     * Check if an async effect needs regen based on step-specific param changes.
     * Called by ProgramState._applyToPipeline with the step's own values.
     * Only regens the specific node — never touches other effects.
     */
    checkAsyncRegen(nodeId, effectKey, stepValues) {
        const effectDef = getEffect(effectKey)
        if (!effectDef) return
        if (!effectDef._configAsyncInit && effectDef.asyncInit === Effect.prototype.asyncInit) return

        // Check if any non-alpha param actually changed
        if (!this._asyncParamCache) this._asyncParamCache = new Map()
        const cache = this._asyncParamCache.get(nodeId) || {}
        let changed = false

        for (const [paramName, value] of Object.entries(stepValues)) {
            if (paramName === 'alpha' || paramName.startsWith('_')) continue
            if (value === undefined || value === null) continue
            // Automation configs (oscillator/midi/audio) and vector values are
            // object-shaped; identity comparison would flag "changed" on every
            // application and re-trace constantly. Async overlays consume only
            // scalar params, so objects are ignored here.
            if (typeof value === 'object') continue
            if (!effectDef.globals?.[paramName]) continue
            if (cache[paramName] !== value) {
                changed = true
                cache[paramName] = value
            }
        }

        this._asyncParamCache.set(nodeId, cache)
        if (changed) {
            this._startAsyncInit(nodeId, effectDef, { debounce: true, params: stepValues })
        }
    }

    _startAsyncInit(nodeId, effectDef, { debounce = false, params = null } = {}) {
        if (debounce) {
            // Debounce: wait for slider to settle before regenerating
            if (!this._asyncDebounceTimers) this._asyncDebounceTimers = new Map()
            const prevTimer = this._asyncDebounceTimers.get(nodeId)
            if (prevTimer) clearTimeout(prevTimer)
            this._asyncDebounceTimers.set(nodeId, setTimeout(() => {
                this._asyncDebounceTimers.delete(nodeId)
                this._startAsyncInit(nodeId, effectDef, { debounce: false, params })
            }, 300))
            return
        }

        // Cancel previous render for this node
        const prevCancel = this._asyncRenders.get(nodeId)
        if (prevCancel) prevCancel()

        let cancelled = false
        this._asyncRenders.set(nodeId, () => { cancelled = true })

        const context = {
            updateTexture: (texName, canvas) => {
                if (cancelled) return
                // Map effect-local texture name to graph-scoped name
                const texId = `${nodeId}_${texName}`
                this.backend.updateTextureFromSource(texId, canvas, { flipY: true })
            },
            width: this.width,
            height: this.height,
            params: params ? { ...params } : { ...this.globalUniforms },
            isCancelled: () => cancelled
        }

        effectDef.asyncInit(context).catch(err => {
            console.error(`[Pipeline] asyncInit error for ${nodeId}:`, err)
        })
    }

    /**
     * Collect uniform values from all passes for resolving parameter-based
     * texture dimensions. Per-effect uniforms (zoom, stateSize, ...) are
     * authoritative on each pass; the chain-scoped variants written by the
     * expander (e.g. `zoom_chain_0`) carry the per-effect value into a
     * unique key so different chains don't clobber each other when the
     * passes are merged here.
     */
    collectDefaultUniforms() {
        const uniforms = {}
        if (this.graph && this.graph.passes) {
            for (const pass of this.graph.passes) {
                if (pass.uniforms) {
                    Object.assign(uniforms, pass.uniforms)
                }
            }
        }
        return uniforms
    }

    /**
     * Describe the browser audio captures required by the compiled graph.
     * Hosts use this runtime view so inline and multiline DSL forms behave the
     * same as let-bound automation sources.
     *
     * @returns {{needsLegacy: boolean, needsLegacyRaw: boolean, selected: Array<{id: string|null, name: string, channel: number, needsRaw: boolean}>}}
     */
    getAudioInputRequirements() {
        let needsLegacy = false
        let needsLegacyRaw = false
        const selected = []
        const selectedKeys = new Set()
        const visited = new Set()

        const visit = (value) => {
            if (!value || typeof value !== 'object' || visited.has(value)) return
            visited.add(value)

            if (value.type === 'Audio' || value._ast?.type === 'Audio') {
                const source = value._ast?.type === 'Audio' ? value._ast : value
                const hasSelectorIntent = value.name !== undefined || value.id !== undefined ||
                    value.channel !== undefined || source.name !== undefined ||
                    source.id !== undefined || source.channel !== undefined
                const hasValidBand = value._invalid !== true &&
                    Number.isInteger(value.band) && value.band >= 0 && value.band <= 4
                if (!hasValidBand) return

                if (typeof value.name === 'string' && value.name.length > 0 &&
                    Number.isInteger(value.channel) && value.channel >= 1) {
                    const requirement = {
                        id: typeof value.id === 'string' && value.id.length > 0 ? value.id : null,
                        name: value.name,
                        channel: value.channel,
                        needsRaw: value.band === 4
                    }
                    const key = JSON.stringify([requirement.id, requirement.name, requirement.channel])
                    if (selectedKeys.has(key)) {
                        const existing = selected.find(candidate => (
                            candidate.id === requirement.id &&
                            candidate.name === requirement.name &&
                            candidate.channel === requirement.channel
                        ))
                        if (existing && requirement.needsRaw) existing.needsRaw = true
                    } else {
                        selectedKeys.add(key)
                        selected.push(requirement)
                    }
                } else if (!hasSelectorIntent) {
                    needsLegacy = true
                    if (value.band === 4) needsLegacyRaw = true
                }
                return
            }

            if (Array.isArray(value)) {
                for (const item of value) visit(item)
                return
            }
            if (ArrayBuffer.isView(value)) return
            for (const item of Object.values(value)) visit(item)
        }

        for (const pass of this.graph?.passes || []) {
            const effectDef = pass.effectKey ? getEffect(pass.effectKey) : null
            if (effectDef?.tags?.includes('audio')) needsLegacy = true
            visit(pass.uniforms)
        }
        return { needsLegacy, needsLegacyRaw, selected }
    }

    /**
     * Create global output surfaces (o0, o1, o2, o3, o4, o5, o6, o7)
     * Also scans the graph for any other required global surfaces (starting with global_)
     */
    /**
     * Check if a texture ID is a global surface reference and extract the name.
     * Supports "global_name" pattern.
     * Returns null if not a global, otherwise returns the surface name.
     */
    parseGlobalName(texId) {
        if (typeof texId !== 'string') return null

        // "global_name" (underscore separator)
        if (texId.startsWith('global_')) {
            return texId.replace('global_', '')
        }

        return null
    }

    /**
     * Check if a uniform name belongs to the volumeSize family
     * (unscoped, chain-scoped, or node-scoped).
     * @param {string} name - Uniform name
     * @returns {boolean}
     */
    isVolumeSizeUniform(name) {
        return name === 'volumeSize' ||
               name.startsWith('volumeSize_chain_') ||
               name.startsWith('volumeSize_node_')
    }

    /**
     * Clamp a volumeSize value so the volume atlas (volumeSize × volumeSize²)
     * fits the device's maximum texture size, snapping down power-of-two so
     * the clamped size matches the effects' own size choices. Mobile WebKit
     * caps WebGL2 MAX_TEXTURE_SIZE at 8192, where volumeSize 128 demands a
     * 128×16384 atlas: the allocation fails, the volume samples as zeros,
     * and 3D renders degrade to a flat gray "solid cube". No-op when the
     * backend reports no maxTextureSize (headless stubs) or the atlas fits.
     * @param {number} value - Requested volume size
     * @returns {number} A volume size whose atlas fits the device
     */
    clampVolumeSize(value) {
        const maxTextureSize = this.backend?.capabilities?.maxTextureSize
        if (typeof value !== 'number' || !maxTextureSize || value * value <= maxTextureSize) {
            return value
        }
        let clamped = 16
        while ((clamped * 2) * (clamped * 2) <= maxTextureSize && clamped * 2 < value) {
            clamped *= 2
        }
        if (!this._warnedVolumeClamps) this._warnedVolumeClamps = new Set()
        const warnKey = `${value}->${clamped}`
        if (!this._warnedVolumeClamps.has(warnKey)) {
            this._warnedVolumeClamps.add(warnKey)
            console.warn(`[Pipeline] Capping volumeSize from ${value} to ${clamped}: the ${value}x${value * value} volume atlas exceeds this device's max texture size (${maxTextureSize})`)
        }
        return clamped
    }

    /**
     * Clamp every volumeSize-family uniform baked into the graph's passes
     * (expander output) to the device limit. Runs from createSurfaces() so
     * cold init, resize, and hot recompile all pass through it before any
     * atlas is sized. Automation configs are left alone.
     */
    clampGraphVolumeSizes() {
        if (!this.graph || !this.graph.passes) return
        for (const pass of this.graph.passes) {
            if (!pass.uniforms) continue
            for (const key of Object.keys(pass.uniforms)) {
                if (!this.isVolumeSizeUniform(key)) continue
                const value = pass.uniforms[key]
                if (typeof value !== 'number') continue
                const clamped = this.clampVolumeSize(value)
                if (clamped !== value) {
                    pass.uniforms[key] = clamped
                }
            }
        }
    }

    /**
     * Byte cost per sample of a color attachment format, for the MRT
     * attachment budget. Unlisted formats (including defaulted rgba16f
     * surfaces) cost 8.
     * @param {string|undefined} format - Texture format name
     * @returns {number} Bytes per sample
     */
    mrtFormatBytes(format) {
        switch (format) {
            case 'rgba32f':
            case 'rgba32float':
                return 16
            case 'rgba8':
            case 'rgba8unorm':
                return 4
            default:
                return 8
        }
    }

    /**
     * Demote trailing rgba32f attachments of over-budget MRT passes to
     * rgba16f so the framebuffer stays within the device's color-attachment
     * byte budget. Apple GPUs enforce Metal's 32-bytes-per-sample rule on
     * WebGL2 framebuffers (FRAMEBUFFER_UNSUPPORTED past it, measured on
     * iOS 26.5), where pointsEmit's xyz+vel+rgba MRT (16+16+4 = 36 bytes)
     * fails every frame. Demoting from the last attachment backward keeps
     * the highest-precision-need attachments (agent positions) intact.
     * No-op when the backend reports no maxColorBytesPerSample or every
     * group already fits.
     */
    applyMrtFormatBudget() {
        const budget = this.backend?.capabilities?.maxColorBytesPerSample
        if (!budget || !this.graph || !this.graph.passes || !this.graph.textures) return
        for (const pass of this.graph.passes) {
            if (!pass.outputs) continue
            const texIds = Object.values(pass.outputs)
            if (texIds.length <= 1) continue
            const entries = texIds.map((texId) => ({ texId, spec: this.graph.textures.get(texId) }))
            let total = entries.reduce((sum, entry) => sum + this.mrtFormatBytes(entry.spec?.format), 0)
            if (total <= budget) continue
            for (let i = entries.length - 1; i >= 0 && total > budget; i--) {
                const spec = entries[i].spec
                if (!spec) continue
                if (spec.format === 'rgba32f' || spec.format === 'rgba32float') {
                    console.warn(`[Pipeline] Demoting MRT attachment ${entries[i].texId} from ${spec.format} to rgba16f: pass ${pass.id} needs ${total} bytes/sample, device allows ${budget}`)
                    spec.format = 'rgba16f'
                    total -= 8
                }
            }
        }
    }

    createSurfaces() {
        // Volume atlas sizing reads volumeSize out of pass uniforms — clamp
        // them to the device limit before any dimension is resolved.
        this.clampGraphVolumeSizes()

        // MRT attachment formats must fit the device's color byte budget
        // before any texture spec is read for allocation.
        this.applyMrtFormatBudget()

        const surfaceNames = new Set(['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'])

        // Global geometry buffers (geo0-geo7) - 2D textures with normals + depth
        const geoBufferNames = new Set(['geo0', 'geo1', 'geo2', 'geo3', 'geo4', 'geo5', 'geo6', 'geo7'])

        // Global 3D volume buffers (vol0-vol7)
        const volumeNames = new Set(['vol0', 'vol1', 'vol2', 'vol3', 'vol4', 'vol5', 'vol6', 'vol7'])

        // Global mesh surfaces (mesh0-mesh7) - each mesh has 3 linked textures
        const meshNames = new Set(['mesh0', 'mesh1', 'mesh2', 'mesh3', 'mesh4', 'mesh5', 'mesh6', 'mesh7'])

        // Collect default uniforms for parameter-based texture sizing
        const defaultUniforms = this.collectDefaultUniforms()

        // Scan graph for other globals
        // Mesh texture pattern: mesh0_positions, mesh1_normals, mesh2_uvs, etc.
        // These are NOT ping-pong surfaces - they're static data textures uploaded by loadOBJ
        const meshTexturePattern = /^mesh\d+_(positions|normals|uvs)$/
        if (this.graph && this.graph.passes) {
            for (const pass of this.graph.passes) {
                if (pass.inputs) {
                    for (const texId of Object.values(pass.inputs)) {
                        const globalName = this.parseGlobalName(texId)
                        if (globalName && !meshTexturePattern.test(globalName)) {
                            surfaceNames.add(globalName)
                        }
                    }
                }
                if (pass.outputs) {
                    for (const texId of Object.values(pass.outputs)) {
                        const globalName = this.parseGlobalName(texId)
                        if (globalName && !meshTexturePattern.test(globalName)) {
                            surfaceNames.add(globalName)
                        }
                    }
                }
            }
        }

        // Check if any pass references midiNoteGrid texture
        this._needsMidiNoteGrid = false
        if (this.graph && this.graph.passes) {
            for (const pass of this.graph.passes) {
                if (pass.inputs) {
                    for (const texId of Object.values(pass.inputs)) {
                        if (texId === 'midiNoteGrid') { this._needsMidiNoteGrid = true; break }
                    }
                }
                if (this._needsMidiNoteGrid) break
            }
        }

        // Create global surfaces (o0-o7 and dynamic globals).
        // Per-effect zoom (e.g. screenDivide:'zoom_chain_N') is resolved by
        // resolveDimension() reading the chain-scoped uniform out of
        // defaultUniforms. There is no pipeline-wide zoom; sizing is owned
        // by each effect via its own textures spec.
        for (const name of surfaceNames) {
            let surfaceWidth = this.width
            let surfaceHeight = this.height
            let surfaceFormat = 'rgba16f'

            const underscoreId = `global_${name}`
            let texSpec = this.graph?.textures?.get?.(underscoreId)
            if (texSpec) {
                surfaceWidth = this.resolveDimension(texSpec.width, this.width, defaultUniforms)
                surfaceHeight = this.resolveDimension(texSpec.height, this.height, defaultUniforms)
                if (texSpec.format) surfaceFormat = texSpec.format
            }

            // Check if existing surface can be reused (preserves sim state on recompile)
            const oldSurface = this.surfaces.get(name)
            if (oldSurface) {
                const existingTex = this.backend.textures?.get?.(oldSurface.read)
                if (existingTex &&
                    existingTex.width === surfaceWidth &&
                    existingTex.height === surfaceHeight) {
                    // Surface exists with correct dimensions, preserve it
                    continue
                }
                // Dimensions changed, destroy old surface
                this.backend.destroyTexture(`global_${name}_read`)
                this.backend.destroyTexture(`global_${name}_write`)
            }

            // Create double-buffered surface
            // Include 'storage' usage for compute shader output
            this.backend.createTexture(`global_${name}_read`, {
                width: surfaceWidth,
                height: surfaceHeight,
                format: surfaceFormat,
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.backend.createTexture(`global_${name}_write`, {
                width: surfaceWidth,
                height: surfaceHeight,
                format: surfaceFormat,
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.surfaces.set(name, {
                read: `global_${name}_read`,
                write: `global_${name}_write`,
                currentFrame: 0
            })
        }

        // Create geometry buffers (geo0-geo7) - 2D textures with normals + depth
        // These store precomputed raymarching results for post-processing
        for (const name of geoBufferNames) {
            const oldSurface = this.surfaces.get(name)
            if (oldSurface) {
                const existingTex = this.backend.textures?.get?.(oldSurface.read)
                if (existingTex &&
                    existingTex.width === this.width &&
                    existingTex.height === this.height) {
                    continue
                }
                this.backend.destroyTexture(`global_${name}_read`)
                this.backend.destroyTexture(`global_${name}_write`)
            }

            // Geometry buffers are screen-sized, RGBA16F (xyz=normal, w=depth)
            this.backend.createTexture(`global_${name}_read`, {
                width: this.width,
                height: this.height,
                format: 'rgba16f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.backend.createTexture(`global_${name}_write`, {
                width: this.width,
                height: this.height,
                format: 'rgba16f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.surfaces.set(name, {
                read: `global_${name}_read`,
                write: `global_${name}_write`,
                currentFrame: 0
            })
        }

        // Create 3D volume buffers (vol0-vol7) as 2D atlas textures
        // Using 64x4096 (64^3 stored as 64 slices of 64x64)
        // This matches the atlas layout used by effects like cellularAutomata3d,
        // reactionDiffusion3d, noise3d
        const volumeSliceSize = 64
        const volumeAtlasHeight = volumeSliceSize * volumeSliceSize // 64 * 64 = 4096
        for (const name of volumeNames) {
            const oldSurface = this.surfaces.get(name)
            if (oldSurface) {
                const existingTex = this.backend.textures?.get?.(oldSurface.read)
                if (existingTex &&
                    existingTex.width === volumeSliceSize &&
                    existingTex.height === volumeAtlasHeight) {
                    continue
                }
                this.backend.destroyTexture(`global_${name}_read`)
                this.backend.destroyTexture(`global_${name}_write`)
            }

            // Volume atlases are volumeSliceSize x volumeSliceSize^2, RGBA16F
            this.backend.createTexture(`global_${name}_read`, {
                width: volumeSliceSize,
                height: volumeAtlasHeight,
                format: 'rgba16f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.backend.createTexture(`global_${name}_write`, {
                width: volumeSliceSize,
                height: volumeAtlasHeight,
                format: 'rgba16f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.surfaces.set(name, {
                read: `global_${name}_read`,
                write: `global_${name}_write`,
                currentFrame: 0
            })
        }

        // Create mesh surfaces (mesh0-mesh7)
        // Each mesh surface is a linked triplet of textures: positions, normals, UVs
        for (const name of meshNames) {
            const oldSurface = this.surfaces.get(name)
            if (oldSurface) {
                // Already exists, skip
                continue
            }

            // Default mesh size: 256x256 = 65536 vertices max
            // Users can override via mesh texture dimensions in their effect
            const meshWidth = 256
            const meshHeight = 256

            // Position texture: xyz position in world space, w = vertex valid flag
            this.backend.createTexture(`global_${name}_positions`, {
                width: meshWidth,
                height: meshHeight,
                format: 'rgba32f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            // Normal texture: xyz normal vector, w unused
            // Must be rgba32f to match uploadMeshData which writes Float32Array data
            this.backend.createTexture(`global_${name}_normals`, {
                width: meshWidth,
                height: meshHeight,
                format: 'rgba32f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            // UV texture: uv coordinates, zw unused
            // Must be rgba32f to match uploadMeshData which writes Float32Array data
            this.backend.createTexture(`global_${name}_uvs`, {
                width: meshWidth,
                height: meshHeight,
                format: 'rgba32f',
                usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
            })

            this.surfaces.set(name, {
                positions: `global_${name}_positions`,
                normals: `global_${name}_normals`,
                uvs: `global_${name}_uvs`,
                width: meshWidth,
                height: meshHeight
            })
        }
    }

    /**
     * Check if a dimension spec is dynamic (screen-relative, percentage, or parameter-based)
     * Fixed numeric values return false; everything else returns true.
     * @param {number|string|object} spec - Dimension specification
     * @returns {boolean} True if the spec should be re-resolved on resize
     */
    isDynamicDimension(spec) {
        // Fixed numeric value - not dynamic
        if (typeof spec === 'number') {
            return false
        }
        // 'screen', 'auto', or percentage like '50%' - dynamic
        if (typeof spec === 'string') {
            return true
        }
        // Object specs (param-based, scale-based) - dynamic
        if (typeof spec === 'object' && spec !== null) {
            return true
        }
        // Unknown - treat as dynamic to be safe
        return true
    }

    /**
     * Recreate textures with new dimensions based on current uniform values
     * @param {object} [uniforms] - Current uniform values for parameter-based sizing
     */
    recreateTextures(uniforms = {}) {
        if (!this.graph || !this.graph.textures) return

        for (const [texId, spec] of this.graph.textures.entries()) {
            // Check if this is a global surface (double-buffered)
            // Global surfaces use naming like "global_node_X_caState" in textures map
            // but the surface is stored as "caState" with read/write variants
            const isGlobalSurface = texId.startsWith('global_') || texId.startsWith('global')

            // For global surfaces, only resize if they have dynamic dimensions
            // (screen-relative, percentage, or parameter-based)
            if (isGlobalSurface) {
                const hasDynamicWidth = this.isDynamicDimension(spec.width)
                const hasDynamicHeight = this.isDynamicDimension(spec.height)
                if (!hasDynamicWidth && !hasDynamicHeight) {
                    continue  // Fixed-size global, skip
                }
            }

            // Resolve dimensions with current uniforms
            const width = this.resolveDimension(spec.width, this.width, uniforms)
            const height = this.resolveDimension(spec.height, this.height, uniforms)

            if (isGlobalSurface) {
                // Handle double-buffered global surface
                // Extract the surface name from the texture ID
                // texId might be "global_node_0_caState" or "globalCaState"
                let surfaceName = null
                if (texId.startsWith('global_')) {
                    // "global_node_0_caState" -> find the surface name after last underscore segment
                    // Actually, we need to match against our surfaces Map
                    // Try to find matching surface - could be "caState" or "node_0_caState"
                    for (const name of this.surfaces.keys()) {
                        if (texId.includes(name) || texId.endsWith(name)) {
                            surfaceName = name
                            break
                        }
                    }
                } else if (texId.startsWith('global')) {
                    // "globalCaState" -> "caState"
                    const suffix = texId.slice(6)
                    surfaceName = suffix.charAt(0).toLowerCase() + suffix.slice(1)
                }

                if (!surfaceName || !this.surfaces.has(surfaceName)) {
                    continue  // Can't find matching surface
                }

                const surface = this.surfaces.get(surfaceName)
                const readTexId = surface.read
                const writeTexId = surface.write

                // Check if size changed
                const existingTex = this.backend.textures?.get?.(readTexId)
                if (existingTex && existingTex.width === width && existingTex.height === height) {
                    continue  // No change needed
                }

                // Destroy old textures
                this.backend.destroyTexture(readTexId)
                this.backend.destroyTexture(writeTexId)

                // Recreate double-buffered surface with new dimensions
                const format = spec.format || 'rgba16f'
                this.backend.createTexture(readTexId, {
                    width,
                    height,
                    format,
                    usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
                })
                this.backend.createTexture(writeTexId, {
                    width,
                    height,
                    format,
                    usage: ['render', 'sample', 'copySrc', 'copyDst', 'storage']
                })
            } else {
                // Handle regular (non-global) texture
                // Check if size changed
                const existingTex = this.backend.textures?.get?.(texId)
                if (existingTex && existingTex.width === width && existingTex.height === height) {
                    // For 3D textures, also check depth
                    if (!spec.is3D || existingTex.depth === this.resolveDimension(spec.depth, width, uniforms)) {
                        continue  // No change needed
                    }
                }

                // Destroy old texture
                this.backend.destroyTexture(texId)

                // Create texture (2D or 3D based on spec)
                if (spec.is3D) {
                    const depth = this.resolveDimension(spec.depth, width, uniforms)
                    this.backend.createTexture3D(texId, {
                        ...spec,
                        width,
                        height,
                        depth
                    })
                } else {
                    this.backend.createTexture(texId, {
                        ...spec,
                        width,
                        height
                    })
                }
            }
        }
    }

    /**
     * Update parameter-dependent textures when uniforms change
     * Call this when volumeSize or similar sizing parameters change
     * @param {object} uniforms - Current uniform values
     */
    updateParameterTextures(uniforms = {}) {
        this.recreateTextures(uniforms)
    }

    /**
     * Check if a value is an automation config (oscillator, midi, audio)
     * These should not be overwritten by setUniform calls
     * @param {any} value - Value to check
     * @returns {boolean} True if this is an automation config
     */
    isAutomationConfig(value) {
        return value && typeof value === 'object' &&
            (value.type === 'Oscillator' || value.type === 'Midi' || value.type === 'Audio' ||
             value._ast?.type === 'Oscillator' || value._ast?.type === 'Midi' || value._ast?.type === 'Audio')
    }

    /**
     * Set tile region for tiled large-resolution rendering.
     * When set, shaders receive tileOffset and fullResolution uniforms
     * so they can compute global coordinates across the full image.
     * @param {{offset: number[], fullResolution: number[], renderScale?: number}} region
     * @param {number[]} region.offset - [x, y] pixel offset of this tile in the full image
     * @param {number[]} region.fullResolution - [w, h] dimensions of the complete output image
     * @param {number} [region.renderScale] - scale factor vs original canvas (e.g. 5.86 for 6000px from 1024px)
     */
    setTileRegion({ offset, fullResolution, renderScale }) {
        this._tileOffset = offset
        this._fullResolution = fullResolution
        this._renderScale = renderScale ?? 1
    }

    /**
     * Clear tile region, returning to normal (non-tiled) rendering.
     */
    clearTileRegion() {
        this._tileOffset = null
        this._fullResolution = null
        this._renderScale = null
    }

    /**
     * Render the current graph once per cube face into 6 face pixel buffers.
     * Faces are ordered +X,-X,+Y,-Y,+Z,-Z (GL cubemap order).
     *
     * The returned array is reused and its entries overwritten on every call;
     * copy the faces (or their `data`) if you need to retain them across calls.
     * The render style (lit blob vs raw sample) is whichever cubemap renderer the
     * graph ends in (renderCubemap3d / renderCubemapSurface) — not a parameter here.
     * yieldBetweenFaces awaits an animation frame before each face render so a
     * host render loop keeps painting during large (e.g. 1024px) captures.
     * @param {{size?:number, outputSurface?:string, time?:number, yieldBetweenFaces?:boolean}} cfg
     * @returns {Promise<Array<{width:number,height:number,data:Uint8Array}>>} reused buffer — copy if retaining
     */
    async renderCubemap({ size = 512, outputSurface = 'o0', time = 0, yieldBetweenFaces = false } = {}) {
        const prevW = this.width, prevH = this.height
        if (this.width !== size || this.height !== size) this.resize(size, size)
        if (!this._cubeFaces) this._cubeFaces = new Array(6)
        for (let face = 0; face < 6; face++) {
            if (yieldBetweenFaces) {
                // Race rAF against a timer: rAF alone never fires in a
                // hidden/backgrounded tab, which would otherwise stall this
                // loop indefinitely instead of just yielding a paint.
                await new Promise((resolve) => {
                    let settled = false
                    const finish = () => {
                        if (settled) return
                        settled = true
                        resolve()
                    }
                    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish)
                    setTimeout(finish, 120)
                })
            }
            this.setUniform('cubeBasis', CUBE_FACE_BASES[face])
            this.render(time)
            const surface = this.surfaces.get(outputSurface)
            if (!surface) {
                throw new Error(`renderCubemap: output surface "${outputSurface}" not found — the composition must write its cubemap-renderer result to it (e.g. .renderCubemapSurface().write(${outputSurface}))`)
            }
            this._cubeFaces[face] = await this.backend.readPixels(surface.read)
        }
        if (prevW !== size || prevH !== size) this.resize(prevW, prevH)
        return this._cubeFaces
    }

    /**
     * Set a global uniform value
     * Automatically triggers texture resizing if the parameter affects texture dimensions
     * NOTE: Does not overwrite automation configs (oscillator, midi, audio) in pass uniforms
     * @param {string} name - Uniform name
     * @param {any} value - Uniform value
     */
    setUniform(name, value) {
        // Apply mobile stateSize cap for particle systems
        // This prevents OOM on mobile devices with limited GPU memory
        if ((name === 'stateSize' || name.startsWith('stateSize_node_')) && typeof value === 'number') {
            const maxStateSize = this.backend?.capabilities?.maxStateSize || 2048
            if (value > maxStateSize) {
                console.warn(`[Pipeline] Capping stateSize from ${value} to ${maxStateSize} for device compatibility`)
                value = maxStateSize
            }
        }

        // Clamp volumeSize so the 3D volume atlas (volumeSize × volumeSize²)
        // fits the device's max texture size — see clampVolumeSize().
        if (this.isVolumeSizeUniform(name) && typeof value === 'number') {
            value = this.clampVolumeSize(value)
        }

        const oldValue = this.globalUniforms[name]
        this.globalUniforms[name] = value

        // Legacy classicNoisedeck palette expansion:
        // When the 'palette' uniform is set with an integer, expand the preset
        // into the dependent vec3/int uniforms the shaders expect.
        if (name === 'palette' && typeof value === 'number') {
            const expanded = expandPalette(value)
            if (expanded) {
                for (const [uName, uValue] of Object.entries(expanded)) {
                    this.setUniform(uName, uValue)
                }
                return  // dependent calls handle pass propagation
            }
        }

        // Scoped uniforms (e.g. stateSize_node_5, volumeSize_chain_0) target
        // exactly one chain or particle pipeline; don't fan out to siblings.
        const isScopedUniform = /_node_\d+$/.test(name) || /_chain_\d+$/.test(name)

        // Update the uniform in all passes that reference it.
        //
        // For unscoped sizing names (zoom, volumeSize, stateSize), also fan
        // out to chain-scoped (`_chain_N`) and node-scoped (`_node_N`) variants.
        // This is the legacy "host wants to set this for the whole pipeline"
        // path used by docs viewer, MCP harness, foundry, etc., which work
        // with single-chain DSLs. For multi-chain DSLs the DSL itself supplies
        // per-chain values via the expander; callers that want to update one
        // chain at runtime should use applyStepParameterValues / _applyToPipeline,
        // which write the scoped names directly and never enter this branch.
        if (this.graph && this.graph.passes) {
            for (const pass of this.graph.passes) {
                if (pass.uniforms && name in pass.uniforms) {
                    // Don't overwrite automation configs (oscillators, midi, audio)
                    // These are set by the DSL and should take precedence over UI/defaults
                    const currentValue = pass.uniforms[name]
                    if (!this.isAutomationConfig(currentValue)) {
                        pass.uniforms[name] = value
                    }
                }
                if (!isScopedUniform && pass.uniforms) {
                    for (const key of Object.keys(pass.uniforms)) {
                        if (key.startsWith(name + '_node_') || key.startsWith(name + '_chain_')) {
                            const currentValue = pass.uniforms[key]
                            if (!this.isAutomationConfig(currentValue)) {
                                pass.uniforms[key] = value
                                this.globalUniforms[key] = value
                            }
                        }
                    }
                }
            }
        }

        // Check if this uniform affects any texture dimensions
        // Include both direct matches and scoped variants (e.g., stateSize_node_1)
        if (oldValue !== value && this.graph && this.graph.textures) {
            let affectsTextures = false
            for (const spec of this.graph.textures.values()) {
                if (this.dimensionReferencesParam(spec.width, name) ||
                    this.dimensionReferencesParam(spec.height, name) ||
                    (spec.depth && this.dimensionReferencesParam(spec.depth, name)) ||
                    this.dimensionReferencesScopedParam(spec.width, name) ||
                    this.dimensionReferencesScopedParam(spec.height, name) ||
                    (spec.depth && this.dimensionReferencesScopedParam(spec.depth, name))) {
                    affectsTextures = true
                    break
                }
            }

            if (affectsTextures) {
                this.updateParameterTextures(this.globalUniforms)
            }
        }
    }

    /**
     * Broadcast a runtime update to a chain-scoped param to all other passes
     * in the same chain. The scoped variant name (e.g. 'volumeSize_chain_0')
     * uniquely identifies chain membership — any pass that has it in its
     * uniforms belongs to that chain (the expander seeds it via pipelineUniforms
     * propagation, so every pass in the chain holds a copy).
     *
     * Without this broadcast, runtime updates would leave per-pass copies
     * inconsistent, and `collectDefaultUniforms()`'s last-write-wins merge
     * would pick a stale value — causing atlas sizing to ignore the source
     * emitter's new value.
     *
     * For consumer passes that inherit the unscoped uniform from upstream
     * (`pass.inheritsVolumeSize`), also update the unscoped value so the
     * shader sees the new size. Currently only volumeSize has this inherit
     * semantics; downstream 3D effects use it.
     */
    broadcastChainScopedParam(sourcePass, uniformName, scopedName) {
        if (!this.graph || !this.graph.passes || !sourcePass.uniforms) return
        let value = sourcePass.uniforms[uniformName]
        if (uniformName === 'volumeSize' && typeof value === 'number') {
            const clamped = this.clampVolumeSize(value)
            if (clamped !== value) {
                value = clamped
                // The UI paths write the raw value to the source pass before
                // broadcasting; keep the source aligned with what the chain gets.
                sourcePass.uniforms[uniformName] = clamped
                if (scopedName in sourcePass.uniforms) {
                    sourcePass.uniforms[scopedName] = clamped
                }
            }
        }
        for (const otherPass of this.graph.passes) {
            if (otherPass === sourcePass || !otherPass.uniforms) continue
            if (!(scopedName in otherPass.uniforms)) continue
            otherPass.uniforms[scopedName] = value
            if (uniformName === 'volumeSize' &&
                otherPass.inheritsVolumeSize &&
                uniformName in otherPass.uniforms) {
                otherPass.uniforms[uniformName] = value
            }
        }
    }

    /**
     * Check if a dimension spec references a specific parameter directly.
     * Matches both `{ param: 'X' }` (used by 3D atlases, particle state) and
     * `{ screenDivide: 'X' }` (used by sim surfaces).
     * @param {number|string|object} spec - Dimension specification
     * @param {string} paramName - Parameter name to check for
     * @returns {boolean} True if the spec references the parameter
     */
    dimensionReferencesParam(spec, paramName) {
        return typeof spec === 'object' && spec !== null &&
               (spec.param === paramName || spec.screenDivide === paramName)
    }

    /**
     * Check if a dimension spec references a scoped variant of a parameter.
     * Scoped params take two forms:
     *   - `paramName_node_N` (per-particle-pipeline, e.g. stateSize_node_5)
     *   - `paramName_chain_N` (per-chain, e.g. volumeSize_chain_0, zoom_chain_0)
     * @param {number|string|object} spec - Dimension specification
     * @param {string} paramName - Base parameter name to check for
     * @returns {boolean} True if the spec references a scoped version of the parameter
     */
    dimensionReferencesScopedParam(spec, paramName) {
        if (typeof spec !== 'object' || spec === null) return false
        const ref = (typeof spec.param === 'string') ? spec.param
                  : (typeof spec.screenDivide === 'string') ? spec.screenDivide
                  : null
        if (!ref) return false
        return ref.startsWith(paramName + '_node_') ||
               ref.startsWith(paramName + '_chain_')
    }

    /**
     * Resolve dimension spec to actual pixel value
     * @param {number|string|object} spec - Dimension specification
     * @param {number} screenSize - Screen dimension for relative specs
     * @param {object} [uniforms] - Current uniform values for param references
     */
    resolveDimension(spec, screenSize, uniforms = {}) {
        if (typeof spec === 'number') {
            return Math.max(1, Math.floor(spec))
        }

        if (spec === 'screen' || spec === 'auto') {
            return screenSize
        }

        if (typeof spec === 'string' && spec.endsWith('%')) {
            const percent = parseFloat(spec)
            return Math.max(1, Math.floor(screenSize * percent / 100))
        }

        if (typeof spec === 'object') {
            // Handle parameter reference: { param: 'volumeSize' }
            if (spec.param !== undefined) {
                // Get the parameter value from uniforms, or use paramDefault/64 as fallback
                // NOTE: 'default' is used as the FINAL computed fallback when power/multiply
                // are present. Use 'paramDefault' to specify the param's own default.
                const hasTransform = spec.power !== undefined || spec.multiply !== undefined
                const paramDefault = spec.paramDefault ?? 64  // Default param value

                // If param is in uniforms, use it. Otherwise use paramDefault for computation.
                let value = uniforms[spec.param] ?? paramDefault

                // Apply multiplier if specified: { param: 'volumeSize', multiply: 2 }
                if (spec.multiply !== undefined) {
                    value *= spec.multiply
                }

                // Apply power if specified: { param: 'volumeSize', power: 2 } means value^2
                if (spec.power !== undefined) {
                    value = Math.pow(value, spec.power)
                }

                // If we have a transform AND the param wasn't found in uniforms AND
                // a 'default' is specified, use 'default' as the final computed value
                // This allows specs like { param: 'volumeSize', power: 2, default: 4096 }
                // where 4096 is the intended height when volumeSize=64 (64^2=4096)
                if (hasTransform && uniforms[spec.param] === undefined && spec.default !== undefined) {
                    value = spec.default
                }

                return Math.max(1, Math.floor(value))
            }

            // Handle screen-divide spec: { screenDivide: 'zoom' }
            // Resolves to screenSize / uniforms[param], for per-effect zoom scaling
            if (spec.screenDivide !== undefined) {
                const divisor = uniforms[spec.screenDivide] ?? spec.default ?? 1
                return Math.max(1, Math.round(screenSize / divisor))
            }

            // Handle scale-based spec
            if (spec.scale !== undefined) {
                let computed = Math.floor(screenSize * spec.scale)
                if (spec.clamp) {
                    if (spec.clamp.min !== undefined) {
                        computed = Math.max(spec.clamp.min, computed)
                    }
                    if (spec.clamp.max !== undefined) {
                        computed = Math.min(spec.clamp.max, computed)
                    }
                }
                return Math.max(1, computed)
            }
        }

        return screenSize
    }

    /**
     * Sync the internal time reference to a specific value.
     * Call this when pausing to ensure subsequent paused renders have deltaTime = 0.
     * @param {number} time - The normalized time value to sync to
     */
    syncTime(time) {
        this.lastTime = time
    }

    /**
     * Execute a single frame.
     * Skips rendering if compilation is in progress to avoid race conditions
     * where passes reference programs that haven't been compiled yet.
     */
    render(time = 0, presentationTimestamp) {
        // Skip rendering if compilation is in progress
        // This prevents ERR_PROGRAM_NOT_FOUND errors when the graph has been
        // updated but programs haven't finished compiling yet
        if (this.isCompiling) {
            return
        }

        // Handle deltaTime carefully - time is normalized 0-1 and wraps
        // When time wraps from ~1 to ~0, use a small positive delta instead of negative
        let deltaTime = this.lastTime > 0 ? time - this.lastTime : 0
        if (deltaTime < 0) {
            // Time wrapped around, use a reasonable small delta
            deltaTime = 1.0 / 60.0 / 10.0  // Approximate one frame at 60fps normalized to 10s loop
        }
        this.lastTime = time

        // Update global uniforms
        this.updateGlobalUniforms(time, deltaTime)

        // Initialize per-frame surface bindings so within-frame reads see fresh writes
        // Clear and reuse Maps to avoid per-frame allocation
        this.frameReadTextures.clear()
        this.frameWriteTextures.clear()
        for (const [name, surface] of this.surfaces.entries()) {
            this.frameReadTextures.set(name, surface.read)
            this.frameWriteTextures.set(name, surface.write)  // Start by writing to write buffer
        }

        // Begin frame
        this.backend.beginFrame(this.getFrameState())

        // Track passes executed this frame
        let passCount = 0

        // Execute passes
        if (this.graph && this.graph.passes) {
            try {
                for (let i = 0; i < this.graph.passes.length; i++) {
                    const originalPass = this.graph.passes[i]
                    // Check pass conditions
                    if (this.shouldSkipPass(originalPass)) {
                        continue
                    }

                    // Resolve oscillators in pass uniforms for this frame
                    const pass = this.resolvePassUniforms(originalPass, time)

                    // Determine iteration count (repeat N times per frame)
                    const repeatCount = this.resolveRepeatCount(pass)

                    for (let iter = 0; iter < repeatCount; iter++) {
                        // Execute pass
                        try {
                            const state = this.getFrameState()
                            this.backend.executePass(pass, state)
                            passCount++
                            this.updateFrameSurfaceBindings(pass, state)
                        } catch (err) {
                            console.error(`[Pipeline.render] ERROR executing pass ${pass.id}: ${err.detail || err.message || JSON.stringify(err)}`)
                            throw err
                        }

                        // Adopt this iteration's frame-local ping-pong bindings into
                        // the cross-frame surface record (frame-local maps remain
                        // the source of truth -- see adoptIterationBindings() doc).
                        if (repeatCount > 1) {
                            this.adoptIterationBindings(pass)
                        }
                    }
                }
            } catch (loopErr) {
                console.error(`[Pipeline.render] LOOP ERROR: ${loopErr.detail || loopErr.message || JSON.stringify(loopErr)}`)
                throw loopErr
            }
        }

        // End frame
        this.backend.endFrame()

        // Present the render surface to screen
        // Use explicit render() directive or the last surface written to
        const renderSurfaceName = this.graph?.renderSurface
        if (renderSurfaceName) {
            const renderSurface = this.surfaces.get(renderSurfaceName)
            if (renderSurface) {
                const presentId = this.frameReadTextures?.get(renderSurfaceName) ?? renderSurface.read
                if (presentationTimestamp === undefined) {
                    presentationTimestamp = typeof performance !== 'undefined' && typeof performance.now === 'function'
                        ? performance.now()
                        : Date.now()
                }
                this.sinkManager.submit(presentId, presentationTimestamp)
            }
        }

        // Swap double buffers for global surfaces
        this.swapBuffers()

        // Store pass count for this frame
        this.lastPassCount = passCount

        this.frameIndex++
    }

    /**
     * Update global uniforms (time, resolution, etc.)
     * Mutates existing object to avoid per-frame allocation
     */
    updateGlobalUniforms(time, deltaTime) {
        const g = this.globalUniforms
        const aspectValue = this.width / this.height
        // Update time-varying uniforms in place
        g.time = time
        g.deltaTime = deltaTime
        g.frame = this.frameIndex
        // Reuse or create resolution array
        if (!g.resolution) {
            g.resolution = [this.width, this.height]
        } else {
            g.resolution[0] = this.width
            g.resolution[1] = this.height
        }
        // Tile region uniforms for tiled large-resolution export
        // Defaults (tileOffset=0, fullResolution=resolution) are no-ops
        if (!g.tileOffset) {
            g.tileOffset = [0, 0]
        }
        if (!g.fullResolution) {
            g.fullResolution = [this.width, this.height]
        }
        if (this._tileOffset) {
            g.tileOffset[0] = this._tileOffset[0]
            g.tileOffset[1] = this._tileOffset[1]
        } else {
            g.tileOffset[0] = 0
            g.tileOffset[1] = 0
        }
        if (this._fullResolution) {
            g.fullResolution[0] = this._fullResolution[0]
            g.fullResolution[1] = this._fullResolution[1]
            // When tiling, aspect ratio uses full image dimensions
            const fullAspect = this._fullResolution[0] / this._fullResolution[1]
            g.aspect = fullAspect
            g.aspectRatio = fullAspect
        } else {
            g.fullResolution[0] = this.width
            g.fullResolution[1] = this.height
            g.aspect = aspectValue
            g.aspectRatio = aspectValue
        }
        g.renderScale = this._renderScale || 1.0

        // Audio data (128 float arrays, 0-1)
        if (this.externalState.audio?.waveform) {
            g.audioWaveform = this.externalState.audio.waveform
        }
        if (this.externalState.audio?.spectrum) {
            g.audioSpectrum = this.externalState.audio.spectrum
        }

        // MIDI note grid (128x16 RGBA float texture)
        if (this.externalState.midi) {
            this.externalState.midi.updateNoteGrid()
            this.backend.uploadDataTexture('midiNoteGrid', this.externalState.midi.noteGrid, 128, 16)
            g.midiClockCount = this.externalState.midi.clockCount
        } else if (this._needsMidiNoteGrid) {
            if (!this._emptyNoteGrid) this._emptyNoteGrid = new Float32Array(128 * 16 * 4)
            this.backend.uploadDataTexture('midiNoteGrid', this._emptyNoteGrid, 128, 16)
        }
        g.midiClockCount = g.midiClockCount || 0
    }

    /**
     * Resolve automation values (oscillators, MIDI, audio) in a uniform value.
     * If the value is an automation configuration, evaluate it and scale by consumer range.
     * @param {any} value - The uniform value (may be an automation config)
     * @param {number} time - Current time in seconds
     * @param {Object} [paramSpec] - Consumer parameter range { min, max }
     * @returns {any} The resolved value
     */
    resolveUniformValue(value, time, paramSpec) {
        if (!value || typeof value !== 'object') return value

        let pct

        // Check if this is an oscillator configuration
        // Note: `time` is already normalized 0-1 from CanvasRenderer
        if (value.type === 'Oscillator' || value._ast?.type === 'Oscillator') {
            pct = evaluateOscillator(value, time)
        } else if (value.type === 'Midi' || value._ast?.type === 'Midi') {
            // Uses Date.now() for trigger falloff timing (real-time evaluation)
            const midiState = this.externalState.midi?.getPortState
                ? this.externalState.midi.getPortState(value)
                : this.externalState.midi
            pct = evaluateMidi(value, midiState, Date.now())
        } else if (value.type === 'Audio' || value._ast?.type === 'Audio') {
            pct = evaluateAudio(value, this.externalState.audio)
        } else {
            return value
        }

        // Scale percentage by consumer parameter range
        if (paramSpec) {
            return paramSpec.min + pct * (paramSpec.max - paramSpec.min)
        }
        return pct
    }

    /**
     * Resolve all oscillators in pass uniforms for the current frame.
     * Uses a pre-allocated proxy object to avoid per-frame allocations.
     * @param {Object} pass - The pass definition
     * @param {number} time - Current time in seconds
     * @returns {Object} Pass or proxy with resolved uniforms
     */
    resolvePassUniforms(pass, time) {
        if (!pass.uniforms) return pass

        const resolvedUniforms = this._resolvedUniforms
        let hasOscillators = false

        // Clear resolved uniforms (set to undefined to avoid delete deopt)
        for (const key in resolvedUniforms) {
            resolvedUniforms[key] = undefined
        }

        for (const name in pass.uniforms) {
            const value = pass.uniforms[name]
            const spec = pass.uniformSpecs?.[name]
            const resolved = this.resolveUniformValue(value, time, spec)
            resolvedUniforms[name] = resolved
            if (resolved !== value) {
                hasOscillators = true
            }
        }

        // If no oscillators, return original pass
        if (!hasOscillators) {
            return pass
        }

        // Use pre-allocated proxy object to avoid per-frame allocation
        // Copy all pass properties to proxy (this is rare - only for oscillator passes)
        const proxy = this._oscillatorPassProxy
        proxy.id = pass.id
        proxy.program = pass.program
        proxy.inputs = pass.inputs
        proxy.outputs = pass.outputs
        proxy.clear = pass.clear
        proxy.blend = pass.blend
        proxy.drawMode = pass.drawMode
        proxy.count = pass.count
        proxy.repeat = pass.repeat
        proxy.conditions = pass.conditions
        proxy.viewport = pass.viewport
        proxy.drawBuffers = pass.drawBuffers
        proxy.storageTextures = pass.storageTextures
        proxy.samplerTypes = pass.samplerTypes
        proxy.entryPoint = pass.entryPoint

        // Swap uniform references (avoid copying values)
        const proxyUniforms = proxy.uniforms
        proxy.uniforms = resolvedUniforms
        this._resolvedUniforms = proxyUniforms

        return proxy
    }

    /**
     * Check if a pass should be skipped based on conditions
     */
    shouldSkipPass(pass) {
        if (!pass.conditions) return false

        const { skipIf, runIf } = pass.conditions

        // Check skipIf conditions - skip if ANY condition matches
        if (skipIf) {
            for (const condition of skipIf) {
                const value = this.globalUniforms[condition.uniform] ?? pass.uniforms?.[condition.uniform]
                if (value === condition.equals) {
                    return true
                }
            }
        }

        // Check runIf conditions - skip if ANY condition doesn't match
        if (runIf) {
            let shouldRun = true
            for (const condition of runIf) {
                const value = this.globalUniforms[condition.uniform] ?? pass.uniforms?.[condition.uniform]
                if (value !== condition.equals) {
                    shouldRun = false
                    break
                }
            }
            if (!shouldRun) {
                return true
            }
        }

        return false
    }

    /**
     * Resolve the repeat count for a pass.
     * Supports static values or uniform-driven iteration counts.
     * @param {Object} pass - The pass definition
     * @returns {number} - Number of times to execute the pass
     */
    resolveRepeatCount(pass) {
        if (!pass.repeat) return 1

        // If repeat is a number, use it directly
        if (typeof pass.repeat === 'number') {
            return Math.max(1, Math.floor(pass.repeat))
        }

        // If repeat is a string, treat it as a uniform name
        if (typeof pass.repeat === 'string') {
            const value = this.globalUniforms[pass.repeat] ?? pass.uniforms?.[pass.repeat]
            if (typeof value === 'number') {
                return Math.max(1, Math.floor(value))
            }
        }

        return 1
    }

    /**
     * Adopt a repeated pass's frame-local ping-pong bindings into the
     * cross-frame surface record. Frame-local maps (frameReadTextures/
     * frameWriteTextures) are the source of truth -- updateFrameSurfaceBindings()
     * has already advanced them for this iteration; this mirrors those bindings
     * into this.surfaces so end-of-frame persistence and the surface.read/write
     * fallback stay consistent between iterations of a repeated pass. Do NOT
     * recompute the swap from this.surfaces here: a preceding non-repeat pass
     * (e.g. a seed pass) advances only the frame-local maps, so this.surfaces
     * can be stale when this first runs, and re-deriving from it would clobber
     * the correct binding.
     * @param {Object} pass - The pass that just executed
     */
    adoptIterationBindings(pass) {
        if (!pass.outputs) return

        for (const outputName of Object.values(pass.outputs)) {
            if (typeof outputName !== 'string') continue

            // Only affects global surfaces (not feedback surfaces)
            const globalName = this.parseGlobalName(outputName)
            if (!globalName) continue

            const surface = this.surfaces.get(globalName)
            if (!surface) continue

            // updateFrameSurfaceBindings() runs after every pass and has already
            // advanced this frame's within-frame ping-pong bindings
            // (frameReadTextures/frameWriteTextures) for this surface. Mirror
            // those frame-local bindings into the cross-frame surface record so
            // end-of-frame persistence and the surface.read/write fallback stay
            // consistent. Recomputing the swap from surface.read/write here would
            // desync whenever a preceding non-repeat pass (e.g. a seed pass)
            // advanced only the frame-local maps -- the stale surface record
            // would then clobber the correct read binding on the first iteration.
            const frameRead = this.frameReadTextures?.get(globalName)
            const frameWrite = this.frameWriteTextures?.get(globalName)
            if (frameRead !== undefined) surface.read = frameRead
            if (frameWrite !== undefined) surface.write = frameWrite
        }
    }

    /**
     * Swap double-buffered surfaces at end of frame.
     *
     * For state surfaces (xyz, vel, rgba, trail), we DON'T swap - we persist
     * the frame's final read/write bindings so particles continue from where they left off.
     *
     * For display surfaces (o0-o7), we swap so the next frame renders fresh.
     */
    swapBuffers() {
        // Check if a surface name is a state surface that should persist
        const isStateSurface = (name) => {
            // Exact matches
            if (name === 'xyz' || name === 'vel' || name === 'rgba' || name === 'trail') {
                return true
            }
            // Suffix matches for namespaced surfaces (e.g., points_trail, flow_trail)
            if (name.endsWith('_xyz') || name.endsWith('_vel') ||
                name.endsWith('_rgba') || name.endsWith('_trail')) {
                return true
            }
            // State texture patterns
            if (name.includes('state') || name.includes('State')) {
                return true
            }
            // Scoped particle textures: xyz_node_N, vel_node_N, rgba_node_N, points_trail_node_N
            // These are created when multiple particle pipelines coexist in the same chain
            if (/^(xyz|vel|rgba|points_trail)_node_\d+$/.test(name)) {
                return true
            }
            return false
        }

        for (const [name, surface] of this.surfaces.entries()) {
            surface.currentFrame = this.frameIndex

            if (isStateSurface(name)) {
                // State surfaces: persist the frame's final bindings
                const finalRead = this.frameReadTextures?.get(name)
                const finalWrite = this.frameWriteTextures?.get(name)

                if (finalRead && finalWrite) {
                    surface.read = finalRead
                    surface.write = finalWrite
                }
            } else {
                // Display surfaces: normal swap
                const temp = surface.read
                surface.read = surface.write
                surface.write = temp
            }
        }
    }

    /**
     * Get current frame state
     * Reuses pre-allocated objects to minimize per-frame allocations
     */
    getFrameState() {
        const state = this._frameState
        const surfaceMap = state.surfaces
        const writeSurfaceMap = state.writeSurfaces

        // Clear previous frame's surface entries by setting to undefined
        // (delete causes hidden class deoptimization)
        const oldSurfaceKeys = this._surfaceKeys
        const oldWriteSurfaceKeys = this._writeSurfaceKeys
        for (let i = 0; i < oldSurfaceKeys.length; i++) {
            surfaceMap[oldSurfaceKeys[i]] = undefined
        }
        for (let i = 0; i < oldWriteSurfaceKeys.length; i++) {
            writeSurfaceMap[oldWriteSurfaceKeys[i]] = undefined
        }
        // Reset key arrays (reuse same arrays)
        oldSurfaceKeys.length = 0
        oldWriteSurfaceKeys.length = 0

        // Build surfaces map with current read textures
        for (const [name, surface] of this.surfaces.entries()) {
            const readTextureId = this.frameReadTextures.get(name) ?? surface.read
            const tex = this.backend.textures.get(readTextureId)
            if (tex) {
                surfaceMap[name] = tex
                oldSurfaceKeys.push(name)
            }
            // Use the frame's write target (set at frame start, doesn't change during frame)
            // This ensures multiple passes writing to the same surface all write to the same buffer
            const writeTarget = this.frameWriteTextures.get(name) ?? surface.write
            writeSurfaceMap[name] = writeTarget
            oldWriteSurfaceKeys.push(name)
        }

        // Update scalar state fields
        state.frameIndex = this.frameIndex
        state.time = this.lastTime
        state.globalUniforms = this.globalUniforms
        state.graph = this.graph
        state.screenWidth = this.width
        state.screenHeight = this.height

        return state
    }

    /**
     * Get the output texture for a surface
     * @param {string} surfaceName - Surface name (defaults to graph.renderSurface)
     */
    getOutput(surfaceName) {
        const name = surfaceName || this.graph?.renderSurface
        if (!name) return null
        const surface = this.surfaces.get(name)
        if (!surface) return null

        return this.backend.textures.get(surface.read)
    }

    /**
     * Clear a surface to transparent black.
     * Used to clear surfaces when chains are deleted.
     * @param {string} surfaceName - Surface name (e.g., 'o0', 'o1')
     */
    clearSurface(surfaceName) {
        if (!surfaceName) return

        const surface = this.surfaces.get(surfaceName)
        if (!surface) return

        // Clear both read and write textures to ensure no stale data
        if (this.backend.clearTexture) {
            this.backend.clearTexture(surface.read)
            this.backend.clearTexture(surface.write)
        }
    }

    /**
     * Update frame-local surface bindings after a pass writes to a global surface.
     * This implements within-frame ping-pong: after a pass writes to a surface,
     * subsequent passes will read from that write buffer, and write to the other buffer.
     */
    updateFrameSurfaceBindings(pass, state) {
        if (!pass.outputs) return

        for (const outputName of Object.values(pass.outputs)) {
            if (typeof outputName !== 'string') continue

            // Handle global surface writes (both global_ and globalName patterns)
            const surfaceName = this.parseGlobalName(outputName)
            if (surfaceName) {
                if (!this.frameReadTextures || !this.frameWriteTextures) continue

                const writeId = state.writeSurfaces?.[surfaceName]
                if (!writeId) continue

                // Get the current read texture (will become the new write target)
                const currentReadId = this.frameReadTextures.get(surfaceName)

                // Subsequent passes in this frame should sample the freshly written texture
                this.frameReadTextures.set(surfaceName, writeId)

                // And write to the buffer we were just reading from (ping-pong)
                if (currentReadId) {
                    this.frameWriteTextures.set(surfaceName, currentReadId)
                }
            }
        }
    }

    /**
     * Dispose of all pipeline resources.
     * @param {object} [options]
     * @param {boolean} [options.loseContext=false] - Ask the backend to lose its context after cleanup
     * @param {boolean} [options.backendLost=false] - Skip unsafe GPU cleanup when the backend is already lost
     */
    dispose(options = {}) {
        if (this._disposed) return
        this._disposed = true

        const { loseContext = false, backendLost = false } = options
        let firstError

        const captureError = (error) => {
            if (!firstError) firstError = error
        }

        // Cancel all async renders
        for (const cancel of this._asyncRenders.values()) {
            try {
                cancel()
            } catch (error) {
                captureError(error)
            }
        }
        this._asyncRenders.clear()

        // Pending debounced regens would fire _startAsyncInit after dispose —
        // a full CPU worm trace whose uploads all no-op on the dead backend.
        if (this._asyncDebounceTimers) {
            for (const timer of this._asyncDebounceTimers.values()) clearTimeout(timer)
            this._asyncDebounceTimers.clear()
        }

        try {
            this.sinkManager.close(backendLost ? { backendLost: true } : undefined)
        } catch (error) {
            captureError(error)
        }

        if (!backendLost) {
            // Every texture the pipeline owns is registered with the backend:
            // global surfaces (including mesh positions/normals/uvs triplets),
            // graph textures, and runtime-managed textures such as MIDI grids,
            // media inputs, and async-init uploads. A single sweep of the backend
            // texture registry destroys each one exactly once.
            if (this.backend?.textures) {
                for (const texId of Array.from(this.backend.textures.keys())) {
                    try {
                        this.backend.destroyTexture(texId)
                    } catch (error) {
                        captureError(error)
                    }
                }
            }

            // Release the remaining backend resources — programs, buffers,
            // samplers, depth attachments, and context. Textures are already
            // gone, so skip the backend's own texture sweep.
            if (this.backend && typeof this.backend.destroy === 'function') {
                try {
                    this.backend.destroy({ skipTextures: true, loseContext })
                } catch (error) {
                    captureError(error)
                }
            }
        }

        this.surfaces.clear()

        // Clear references
        this.graph = null
        this.frameReadTextures = null
        this.frameWriteTextures = null
        this.globalUniforms = {}
        this.backend = null

        if (firstError) throw firstError
    }
}

/**
 * Create a pipeline with the appropriate backend
 * @param {object} graph - Compiled shader graph
 * @param {object} options - Options
 * @param {HTMLCanvasElement} options.canvas - Canvas element
 * @param {number} options.width - Width in pixels
 * @param {number} options.height - Height in pixels
 * @param {boolean} options.preferWebGPU - Use WebGPU if available
 */
export async function createPipeline(graph, options = {}) {
    let backend

    // Determine backend
    if (options.preferWebGPU && await WebGPUBackend.isAvailable()) {
        const adapter = await navigator.gpu.requestAdapter()
        // Request higher limits for MRT with high-precision textures
        // Default maxColorAttachmentBytesPerSample is 32, but we need 40+
        // for 2x RGBA32Float (16 bytes each) + RGBA8Unorm (4 bytes) = 40 bytes
        // Also request float32-filterable for mesh data textures (rgba32float)
        const requiredFeatures = []
        if (adapter.features.has('float32-filterable')) {
            requiredFeatures.push('float32-filterable')
        }
        const device = await adapter.requestDevice({
            requiredFeatures,
            requiredLimits: {
                maxColorAttachmentBytesPerSample: Math.min(
                    adapter.limits.maxColorAttachmentBytesPerSample,
                    128  // Request up to 128 bytes for flexibility
                )
            }
        })
        let context = null
        if (options.canvas) {
            context = options.canvas.getContext('webgpu')
            if (context) {
                context.configure({
                    device: device,
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
                    alphaMode: 'premultiplied'
                })
            }
        }
        backend = new WebGPUBackend(device, context)
    } else if (options.canvas) {
        const gl = options.canvas.getContext('webgl2', { preserveDrawingBuffer: true })
        if (!gl) {
            throw new Error('WebGL2 not available')
        }
        backend = new WebGL2Backend(gl, options.canvas)
    } else {
        throw new Error('No backend available or canvas not provided')
    }

    const pipeline = new Pipeline(graph, backend)
    await pipeline.init(options.width || 800, options.height || 600)

    return pipeline
}
