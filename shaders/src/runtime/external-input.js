/**
 * External Input State Classes for MIDI and Audio
 *
 * These classes manage state for real-time MIDI and audio input.
 * The host application updates these states, and the Pipeline
 * reads them during uniform resolution for midi() and audio() functions.
 */

/**
 * MIDI channel state for a single channel.
 * Tracks note number, velocity, gate state, and timing for trigger modes.
 */
export class MidiChannelState {
    constructor() {
        /** @type {number} Last note number (0-127) */
        this.key = 0
        /** @type {number} Last velocity (0-127) */
        this.velocity = 0
        /** @type {number} Gate state: 1 = note on, 0 = note off */
        this.gate = 0
        /** @type {number} Timestamp of last note-on (Date.now()) */
        this.time = 0
        /** @type {Uint8Array} Per-key velocity tracking (128 keys) */
        this.keys = new Uint8Array(128)
    }

    /**
     * Handle a note-on event.
     * @param {number} key - MIDI note number (0-127)
     * @param {number} velocity - Note velocity (0-127)
     */
    noteOn(key, velocity) {
        this.key = key
        this.velocity = velocity
        this.gate = 1
        this.time = Date.now()
        this.keys[key] = velocity
    }

    /**
     * Handle a note-off event.
     * Preserves the last key and velocity for reference.
     * @param {number} [key] - MIDI note number to clear (optional)
     */
    noteOff(key) {
        this.gate = 0
        if (key !== undefined) {
            this.keys[key] = 0
        }
    }

    /**
     * Reset the channel state.
     */
    reset() {
        this.key = 0
        this.velocity = 0
        this.gate = 0
        this.time = 0
        this.keys.fill(0)
    }
}

/**
 * Complete MIDI state for all 16 MIDI channels.
 * Provides per-channel state tracking for the Pipeline.
 */
export class MidiState {
    constructor({ portRegistry = true } = {}) {
        /** @type {Object.<number, MidiChannelState>} Per-channel state (1-16) */
        this.channels = {}
        for (let i = 1; i <= 16; i++) {
            this.channels[i] = new MidiChannelState()
        }
        /** @type {number} MIDI clock pulse count (24 PPQ) */
        this.clockCount = 0
        /** @type {Float32Array} Note grid texture data (128 keys x 16 channels x 4 RGBA) */
        this.noteGrid = new Float32Array(128 * 16 * 4)
        /** @type {Map<string, {id: string, name: string, connected: boolean, state: MidiState}>|null} */
        this._ports = portRegistry ? new Map() : null
        /** @type {Map<string, MidiState|null>|null} Connected name lookup; null means ambiguous. */
        this._portsByName = portRegistry ? new Map() : null
    }

    /**
     * Register or reconnect one Web MIDI input port.
     * @param {{id: string, name: string}} port
     * @returns {MidiState|null} Isolated state for this port
     */
    registerPort(port) {
        if (!this._ports || !port || typeof port.id !== 'string' || !port.id) return null
        const name = typeof port.name === 'string' ? port.name : ''
        let entry = this._ports.get(port.id)
        let topologyChanged = false
        if (!entry) {
            entry = {
                id: port.id,
                name,
                connected: true,
                state: new MidiState({ portRegistry: false })
            }
            this._ports.set(port.id, entry)
            topologyChanged = true
        } else {
            topologyChanged = entry.name !== name || !entry.connected
            entry.name = name
            entry.connected = true
        }
        if (topologyChanged) this._rebuildPortNameIndex()
        return entry.state
    }

    /**
     * Mark one Web MIDI port unavailable without losing its identity record.
     * @param {string} id
     */
    disconnectPort(id) {
        const entry = this._ports?.get(id)
        if (!entry) return
        entry.connected = false
        entry.state.reset()
        this._rebuildPortNameIndex()
    }

    /**
     * Resolve the MIDI state selected by a compiled midi() descriptor.
     * An id is authoritative; a name-only selector must match exactly once.
     * @param {{name?: string, id?: string}} selector
     * @returns {MidiState|null}
     */
    getPortState(selector = {}) {
        if (!selector.name && !selector.id) return this
        if (selector.id) {
            const entry = this._ports?.get(selector.id)
            return entry?.connected ? entry.state : null
        }
        return this._portsByName?.get(selector.name) ?? null
    }

    _rebuildPortNameIndex() {
        if (!this._ports || !this._portsByName) return
        this._portsByName.clear()
        for (const entry of this._ports.values()) {
            if (!entry.connected || !entry.name) continue
            if (this._portsByName.has(entry.name)) {
                this._portsByName.set(entry.name, null)
            } else {
                this._portsByName.set(entry.name, entry.state)
            }
        }
    }

    /**
     * Return structured port identity and connection state for host UIs.
     * @returns {Array<{id: string, name: string, connected: boolean}>}
     */
    getPorts() {
        return [...(this._ports?.values() || [])].map(({ id, name, connected }) => ({
            id,
            name,
            connected
        }))
    }

    /**
     * Get the state for a specific MIDI channel.
     * @param {number} n - Channel number (1-16)
     * @returns {MidiChannelState} The channel state
     */
    getChannel(n) {
        const channel = this.channels[n]
        if (channel) return channel
        // Fallback to channel 1 for invalid channel numbers
        return this.channels[1]
    }

    /**
     * Process a raw MIDI message.
     * Parses the status byte and routes to appropriate channel.
     * @param {Uint8Array} data - Raw MIDI message data [status, key, velocity]
     * @param {{id: string, name: string}} [port] - Originating Web MIDI port
     */
    handleMessage(data, port) {
        if (!data || data.length < 1) return

        if (port && this._ports) {
            this.registerPort(port)?.handleMessage(data)
        }

        const status = data[0]

        // System real-time: MIDI clock pulse (0xF8, single byte)
        if (status === 0xF8) { this.clockCount++; return }

        if (data.length < 3) return

        const key = data[1]
        const velocity = data[2]
        const channel = (status & 0x0F) + 1  // Extract channel (1-16)
        const messageType = status & 0xF0     // Extract message type

        const channelState = this.getChannel(channel)

        // Note On (0x90) with velocity > 0
        if (messageType === 0x90 && velocity > 0) {
            channelState.noteOn(key, velocity)
        }
        // Note Off (0x80) or Note On with velocity 0
        else if (messageType === 0x80 || (messageType === 0x90 && velocity === 0)) {
            channelState.noteOff(key)
        }
    }

    /**
     * Pack all 128 keys x 16 channels into noteGrid Float32Array for GPU upload.
     * Layout: 128-wide x 16-tall RGBA texture.
     * R = velocity (0-1), G = gate (0 or 1), B = 0, A = 0.
     */
    updateNoteGrid() {
        for (let ch = 0; ch < 16; ch++) {
            const keys = this.channels[ch + 1].keys
            const rowOffset = ch * 128 * 4
            for (let k = 0; k < 128; k++) {
                const v = keys[k]
                const offset = rowOffset + k * 4
                this.noteGrid[offset] = v > 0 ? v / 127 : 0      // R: velocity
                this.noteGrid[offset + 1] = v > 0 ? 1 : 0         // G: gate
                // B and A stay 0
            }
        }
    }

    /**
     * Reset all channel states.
     */
    reset() {
        for (let i = 1; i <= 16; i++) {
            this.channels[i].reset()
        }
        this.clockCount = 0
        this.noteGrid.fill(0)
        if (this._ports) {
            for (const entry of this._ports.values()) entry.state.reset()
        }
    }
}

/** Average a range of FFT bins, normalized to 0-1. */
function _avgBins(buf, from, to) {
    const end = Math.min(to, buf.length)
    if (end <= from) return 0
    let sum = 0
    for (let i = from; i < end; i++) sum += buf[i]
    return sum / (end - from) / 255
}

/**
 * Audio analysis state.
 * Provides frequency band data extracted from an AnalyserNode.
 */
export class AudioState {
    constructor() {
        /** @type {number} Low frequency band level (0-1) */
        this.low = 0
        /** @type {number} Mid frequency band level (0-1) */
        this.mid = 0
        /** @type {number} High frequency band level (0-1) */
        this.high = 0
        /** @type {number} Overall volume level (0-1) */
        this.vol = 0
        /** @type {Float32Array} Raw FFT bins (16 bins, normalized 0-1) */
        this.fft = new Float32Array(16)
        /** @type {Float32Array} Full-resolution FFT spectrum (128 bins, normalized 0-1) */
        this.spectrum = new Float32Array(128)
        /** @type {Float32Array} Time-domain waveform samples (128 samples, normalized 0-1, 0.5 = silence) */
        this.waveform = new Float32Array(128)
        this.waveform.fill(0.5)

        // Internal buffer for smoothing
        this._smoothingBuffers = {
            low: [],
            mid: [],
            high: []
        }
        this._maxBufferLength = 5
    }

    /**
     * Update audio state from a Web Audio AnalyserNode.
     * Extracts frequency bands and calculates overall volume.
     *
     * @param {AnalyserNode} analyser - Web Audio AnalyserNode
     * @param {number} [smoothing=5] - Number of frames to average (1-10)
     */
    updateFromAnalyser(analyser, smoothing = 5) {
        if (!analyser) return

        this._maxBufferLength = Math.max(1, Math.min(10, smoothing))

        const buf = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(buf)

        // Extract frequency bands by averaging across bin ranges.
        // With fftSize=256 at 44.1kHz: 128 bins, each ~172Hz wide.
        // Low  (~80-340Hz):    bins 1-2   (skip DC at bin 0)
        // Mid  (~340-2000Hz):  bins 2-12
        // High (~2000-8000Hz): bins 12-47
        const rawLow = _avgBins(buf, 1, 2)
        const rawMid = _avgBins(buf, 2, 12)
        const rawHigh = _avgBins(buf, 12, 47)

        // Apply smoothing via rolling average
        this.low = this._smooth('low', rawLow)
        this.mid = this._smooth('mid', rawMid)
        this.high = this._smooth('high', rawHigh)

        // Calculate FFT bins and overall volume
        const step = Math.max(1, Math.floor(buf.length / 16))
        let sum = 0
        for (let i = 0; i < 16; i++) {
            const v = buf[i * step] / 255
            this.fft[i] = v
            sum += v
        }
        this.vol = sum / 16
    }

    /**
     * Directly set frequency band values.
     * Useful for testing or non-Web Audio sources.
     *
     * @param {number} low - Low band level (0-1)
     * @param {number} mid - Mid band level (0-1)
     * @param {number} high - High band level (0-1)
     */
    setBands(low, mid, high) {
        this.low = Math.max(0, Math.min(1, low))
        this.mid = Math.max(0, Math.min(1, mid))
        this.high = Math.max(0, Math.min(1, high))
        this.vol = (this.low + this.mid + this.high) / 3
    }

    /**
     * Set spectrum data from raw FFT frequency bytes.
     * @param {Uint8Array} frequencyData - Raw bytes from AnalyserNode.getByteFrequencyData() (0-255)
     */
    setSpectrum(frequencyData) {
        const len = Math.min(frequencyData.length, 128)
        for (let i = 0; i < len; i++) {
            this.spectrum[i] = frequencyData[i] / 255
        }
    }

    /**
     * Set waveform data from raw time-domain bytes.
     * @param {Uint8Array} timeDomainData - Raw bytes from AnalyserNode.getByteTimeDomainData() (0-255, 128 = silence)
     */
    setWaveform(timeDomainData) {
        const len = Math.min(timeDomainData.length, 128)
        for (let i = 0; i < len; i++) {
            this.waveform[i] = timeDomainData[i] / 255
        }
    }

    /**
     * Apply smoothing to a value using a rolling buffer.
     * @private
     */
    _smooth(band, value) {
        const buffer = this._smoothingBuffers[band]
        buffer.push(value)
        if (buffer.length > this._maxBufferLength) {
            buffer.shift()
        }
        return buffer.reduce((a, b) => a + b, 0) / buffer.length
    }

    /**
     * Reset audio state to zero.
     */
    reset() {
        this.low = 0
        this.mid = 0
        this.high = 0
        this.vol = 0
        this.fft.fill(0)
        this.spectrum.fill(0)
        this.waveform.fill(0.5)
        this._smoothingBuffers.low = []
        this._smoothingBuffers.mid = []
        this._smoothingBuffers.high = []
    }
}

// =============================================================================
// Input Managers (Browser-side integration)
// =============================================================================

/**
 * Manages MIDI input connection and state updates
 */
export class MidiInputManager {
    constructor(renderer) {
        this._renderer = renderer
        this._midiState = null
        this._midiAccess = null
        this._enabled = false
        this._onStatusChange = null
        this._onPortsChange = null
        this._status = { state: 'idle', message: '', deviceCount: 0 }
        this._enablePromise = null
        this._generation = 0
    }

    /**
     * Check if Web MIDI API is available
     * @returns {boolean}
     */
    static isSupported() {
        return !!(typeof navigator !== 'undefined' && navigator.requestMIDIAccess)
    }

    /**
     * Enable MIDI input
     * @returns {Promise<boolean>} Whether MIDI was successfully enabled
     */
    enable() {
        if (this._enabled) return Promise.resolve(true)
        if (this._enablePromise) return this._enablePromise

        const generation = ++this._generation
        const operation = this._enable(generation)
        let wrapped
        wrapped = operation.finally(() => {
            if (this._enablePromise === wrapped) {
                this._enablePromise = null
            }
        })
        this._enablePromise = wrapped
        return wrapped
    }

    async _enable(generation) {

        if (!MidiInputManager.isSupported()) {
            console.warn('Web MIDI API not supported')
            this._notifyStatus('MIDI not supported', { state: 'unsupported', deviceCount: 0 })
            return false
        }

        try {
            const midiAccess = await navigator.requestMIDIAccess()
            if (generation !== this._generation) return false
            this._midiAccess = midiAccess
            const midiState = this._renderer.setMidiState()
            this._midiState = midiState

            // Connect all input devices
            let openFailures = 0
            for (const input of this._midiAccess.inputs.values()) {
                if (!await this._connectInput(input, generation, midiState)) openFailures++
                if (generation !== this._generation) return false
            }
            this._notifyPortsChange()

            // Listen for new devices
            this._midiAccess.onstatechange = async (event) => {
                if (generation !== this._generation) return
                if (event.port.type === 'input') {
                    if (event.port.state === 'connected') {
                        const opened = await this._connectInput(event.port, generation, midiState)
                        if (generation !== this._generation) return
                        if (opened) {
                            this._notifyStatus(`MIDI connected: ${event.port.name}`, {
                                state: 'connected',
                                deviceCount: this._midiAccess.inputs.size,
                                port: { id: event.port.id, name: event.port.name || '' }
                            })
                        }
                    } else {
                        event.port.onmidimessage = null
                        this._midiState?.disconnectPort(event.port.id)
                        this._notifyStatus(`MIDI disconnected: ${event.port.name}`, {
                            state: 'disconnected',
                            deviceCount: this._midiAccess.inputs.size,
                            port: { id: event.port.id, name: event.port.name || '' }
                        })
                    }
                    this._notifyPortsChange()
                }
            }

            if (generation !== this._generation) return false
            this._enabled = true
            const inputCount = this._midiAccess.inputs.size
            if (openFailures === 0) {
                this._notifyStatus(`MIDI enabled (${inputCount} device${inputCount !== 1 ? 's' : ''})`, {
                    state: 'enabled',
                    deviceCount: inputCount
                })
            }
            return true
        } catch (err) {
            if (generation !== this._generation) return false
            const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
            const message = denied ? 'MIDI access denied' : 'MIDI access failed'
            console.error(`${message}:`, err)
            this._notifyStatus(message, { state: denied ? 'denied' : 'error', deviceCount: 0 })
            return false
        }
    }

    /**
     * Disable MIDI input
     */
    disable() {
        this._generation++
        this._enablePromise = null

        if (this._midiAccess) {
            for (const input of this._midiAccess.inputs.values()) {
                input.onmidimessage = null
                this._midiState?.disconnectPort(input.id)
            }
            this._midiAccess.onstatechange = null
        }

        this._enabled = false
        this._notifyPortsChange()
        this._notifyStatus('MIDI disabled', { state: 'disabled', deviceCount: 0 })
    }

    /**
     * Toggle MIDI input
     * @returns {Promise<boolean>} New enabled state
     */
    async toggle() {
        if (this._enabled) {
            this.disable()
            return false
        } else {
            return await this.enable()
        }
    }

    /**
     * Check if MIDI is currently enabled
     * @returns {boolean}
     */
    get enabled() {
        return this._enabled
    }

    /**
     * Set status change callback
     * @param {function(string)} callback
     */
    onStatusChange(callback) {
        this._onStatusChange = callback
    }

    /**
     * Set structured MIDI port inventory callback.
     * @param {function(Array<{id: string, name: string, connected: boolean}>)} callback
     */
    onPortsChange(callback) {
        this._onPortsChange = callback
    }

    /**
     * Return every port encountered by this manager, including disconnected
     * entries retained so host UIs can keep selected devices visible.
     */
    getPorts() {
        return this._midiState?.getPorts() || []
    }

    /**
     * Return the latest structured MIDI access or connection status.
     */
    getStatus() {
        return { ...this._status }
    }

    async _connectInput(input, generation = this._generation, midiState = this._midiState) {
        const port = { id: input.id, name: input.name || '' }
        try {
            if (input.connection !== 'open') await input.open()
            if (generation !== this._generation) return false
            midiState?.registerPort(port)
            input.onmidimessage = (event) => this._handleMidiMessage(event, port)
            return true
        } catch (err) {
            if (generation !== this._generation) return false
            input.onmidimessage = null
            midiState?.disconnectPort(input.id)
            this._notifyStatus(`MIDI device failed to open: ${port.name}`, {
                state: 'error',
                deviceCount: this.getPorts().filter(candidate => candidate.connected).length,
                port,
                error: err?.message || String(err)
            })
            return false
        }
    }

    _handleMidiMessage(event, port) {
        if (!this._midiState) return
        this._midiState.handleMessage(event.data, port)
    }

    _notifyStatus(message, detail = {}) {
        this._status = { ...detail, message }
        if (this._onStatusChange) {
            // Keep the message as the first argument for existing consumers.
            this._onStatusChange(message, this.getStatus())
        }
    }

    _notifyPortsChange() {
        if (this._onPortsChange) {
            this._onPortsChange(this.getPorts())
        }
    }
}

/**
 * Manages audio input connection and FFT analysis
 */
export class AudioInputManager {
    constructor(renderer) {
        this._renderer = renderer
        this._audioState = null
        this._audioContext = null
        this._analyser = null
        this._source = null
        this._stream = null
        this._fftData = null
        this._animationId = null
        this._enabled = false
        this._onStatusChange = null
        this._smoothing = 0.8
    }

    /**
     * Check if Web Audio API with microphone is available
     * @returns {boolean}
     */
    static isSupported() {
        return !!(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof AudioContext !== 'undefined')
    }

    /**
     * Enable audio input (requests microphone permission)
     * @returns {Promise<boolean>} Whether audio was successfully enabled
     */
    async enable() {
        if (this._enabled) return true

        if (!AudioInputManager.isSupported()) {
            console.warn('Web Audio API or getUserMedia not supported')
            this._notifyStatus('Audio input not supported')
            return false
        }

        try {
            // Request microphone access
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            })

            // Create audio context and analyser
            this._audioContext = new AudioContext()
            this._analyser = this._audioContext.createAnalyser()
            this._analyser.fftSize = 256
            this._analyser.smoothingTimeConstant = this._smoothing

            // Connect microphone to analyser
            this._source = this._audioContext.createMediaStreamSource(this._stream)
            this._source.connect(this._analyser)

            // Create FFT buffer
            this._fftData = new Uint8Array(this._analyser.frequencyBinCount)
            this._timeDomainData = new Uint8Array(this._analyser.fftSize)

            // Set up audio state
            this._audioState = this._renderer.setAudioState()

            // Start update loop
            this._enabled = true
            this._updateLoop()

            this._notifyStatus('Audio input enabled')
            return true
        } catch (err) {
            console.error('Audio access denied:', err)
            this._notifyStatus('Audio access denied')
            return false
        }
    }

    /**
     * Disable audio input
     */
    disable() {
        if (!this._enabled) return

        // Stop update loop
        if (this._animationId) {
            cancelAnimationFrame(this._animationId)
            this._animationId = null
        }

        // Disconnect and stop stream
        if (this._source) {
            this._source.disconnect()
            this._source = null
        }
        if (this._stream) {
            this._stream.getTracks().forEach(track => track.stop())
            this._stream = null
        }
        if (this._audioContext) {
            this._audioContext.close()
            this._audioContext = null
        }

        this._analyser = null
        this._fftData = null
        this._timeDomainData = null
        this._enabled = false

        // Reset audio state values
        if (this._audioState) {
            this._audioState.low = 0
            this._audioState.mid = 0
            this._audioState.high = 0
            this._audioState.vol = 0
            this._audioState.spectrum.fill(0)
            this._audioState.waveform.fill(0.5)
        }

        this._notifyStatus('Audio input disabled')
    }

    /**
     * Toggle audio input
     * @returns {Promise<boolean>} New enabled state
     */
    async toggle() {
        if (this._enabled) {
            this.disable()
            return false
        } else {
            return await this.enable()
        }
    }

    /**
     * Check if audio is currently enabled
     * @returns {boolean}
     */
    get enabled() {
        return this._enabled
    }

    /**
     * Set smoothing factor (0-1)
     * @param {number} value
     */
    set smoothing(value) {
        this._smoothing = Math.max(0, Math.min(1, value))
        if (this._analyser) {
            this._analyser.smoothingTimeConstant = this._smoothing
        }
    }

    /**
     * Set status change callback
     * @param {function(string)} callback
     */
    onStatusChange(callback) {
        this._onStatusChange = callback
    }

    _updateLoop() {
        if (!this._enabled) return

        // Get frequency data
        this._analyser.getByteFrequencyData(this._fftData)
        this._audioState.setSpectrum(this._fftData)

        // Get time-domain waveform data
        this._analyser.getByteTimeDomainData(this._timeDomainData)
        this._audioState.setWaveform(this._timeDomainData)

        // Sample frequency bands (similar to noisedeck-pro)
        // Low: bins 0-3 (~0-200Hz at 44.1kHz)
        // Mid: bins 4-15 (~200-2000Hz)
        // High: bins 16-31 (~2000-4000Hz)
        const low = (this._fftData[0] + this._fftData[1] + this._fftData[2] + this._fftData[3]) / 4 / 255
        const mid = (this._fftData[4] + this._fftData[6] + this._fftData[8] + this._fftData[10]) / 4 / 255
        const high = (this._fftData[16] + this._fftData[20] + this._fftData[24] + this._fftData[28]) / 4 / 255
        const vol = (low + mid + high) / 3

        // Update audio state
        this._audioState.low = low
        this._audioState.mid = mid
        this._audioState.high = high
        this._audioState.vol = vol

        // Continue loop
        this._animationId = requestAnimationFrame(() => this._updateLoop())
    }

    _notifyStatus(message) {
        if (this._onStatusChange) {
            this._onStatusChange(message)
        }
    }
}

/**
 * Combined manager for both MIDI and Audio input
 */
export class ExternalInputManager {
    constructor(renderer) {
        this.midi = new MidiInputManager(renderer)
        this.audio = new AudioInputManager(renderer)
    }

    /**
     * Set status change callback for both managers
     * @param {function(string)} callback
     */
    onStatusChange(callback) {
        this.midi.onStatusChange(callback)
        this.audio.onStatusChange(callback)
    }
}
