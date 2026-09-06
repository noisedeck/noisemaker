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
let midiNoteOrder = 0
const unscopedMidiOrigin = Symbol('unscoped MIDI input')
const retainedResetControllers = new Set([0, 32, 7, 10, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 91, 92, 93, 94, 95])

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
        /** Last value for every 7-bit control change. */
        this.cc = new Uint8Array(128)
        /** Complete paired values, never assembled from different ports. */
        this.cc14 = new Uint16Array(32)
        this._ccPorts = new Array(128).fill(null)
        this._cc14Ports = new Array(32).fill(null)
        this.pitchBend = 8192
        this.pressure = 0
        this.polyPressure = new Uint8Array(128)
        this.nrpn = new Map()
        this.rpn = new Map()
        this.heldNotes = new Map()
        this._selectors = { nrpn: [null, null], rpn: [null, null] }
        this._parameterFamily = null
        this._nrpnPorts = new Map()
        this._rpnPorts = new Map()
        this._pitchBendPort = null
        this._pressurePort = null
        this._polyPressurePorts = new Array(128).fill(null)
    }

    /**
     * Handle a note-on event.
     * @param {number} key - MIDI note number (0-127)
     * @param {number} velocity - Note velocity (0-127)
     */
    noteOn(key, velocity, sourceNote, origin = null) {
        this.key = key
        this.velocity = velocity
        this.gate = 1
        this.time = sourceNote?.time ?? Date.now()
        this.keys[key] = velocity
        // Repeated NoteOn for one port/channel/key retriggers that identity.
        this.heldNotes.set(key, { key, velocity, time: this.time, order: sourceNote?.order ?? ++midiNoteOrder, origin })
    }

    /** Store a control change and update its pair using this channel's bytes. */
    controlChange(controller, value) {
        if (!Number.isInteger(controller) || controller < 0 || controller > 127 ||
            !Number.isInteger(value) || value < 0 || value > 127) return
        this.cc[controller] = value
        if (controller < 64) {
            const msb = controller & 31
            this.cc14[msb] = (this.cc[msb] << 7) | this.cc[msb + 32]
        }
        if (controller === 121) {
            this.resetControllers()
        } else if (controller === 120 || controller === 123) {
            this.clearNotes()
        } else if ([99, 98, 101, 100].includes(controller)) {
            const family = controller < 100 ? 'nrpn' : 'rpn'
            this._parameterFamily = family
            this._selectors[family][controller === 99 || controller === 101 ? 0 : 1] = value
        } else if ([6, 38, 96, 97].includes(controller) && this._parameterFamily) {
            const family = this._parameterFamily
            const [msb, lsb] = this._selectors[family]
            if (msb === null || lsb === null || (msb === 127 && lsb === 127)) return
            const parameter = (msb << 7) | lsb
            const previous = this[family].get(parameter) ?? 0
            const next = controller === 6 ? value << 7
                : controller === 38 ? (previous & 0x3f80) | value
                    : Math.max(0, Math.min(16383, previous + (controller === 96 ? 1 : -1)))
            this[family].set(parameter, next)
            return { family, parameter, value: next }
        }
    }

    /** RP-015 resets controllers without erasing notes or stored parameters. */
    resetControllers() {
        for (let cc = 0; cc < 128; cc++) {
            if (!retainedResetControllers.has(cc)) this.cc[cc] = cc === 11 || (cc >= 98 && cc <= 101) ? 127 : 0
        }
        for (let cc = 0; cc < 32; cc++) this.cc14[cc] = (this.cc[cc] << 7) | this.cc[cc + 32]
        this.pitchBend = 8192
        this.pressure = 0
        this.polyPressure.fill(0)
        this._parameterFamily = null
        this._selectors = { nrpn: [null, null], rpn: [null, null] }
    }

    clearNotes() {
        this.gate = 0
        this.keys.fill(0)
        this.heldNotes.clear()
        this.polyPressure.fill(0)
    }

    /**
     * Handle a note-off event.
     * Preserves the last key and velocity for reference.
     * @param {number} [key] - MIDI note number to clear (optional)
     */
    noteOff(key) {
        this.gate = 0
        if (key === undefined) {
            this.clearNotes()
            return
        }
        if (key !== undefined) {
            this.keys[key] = 0
            this.heldNotes.delete(key)
            this.polyPressure[key] = 0
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
        this.cc.fill(0)
        this.cc14.fill(0)
        this._ccPorts.fill(null)
        this._cc14Ports.fill(null)
        this.pitchBend = 8192
        this.pressure = 0
        this.polyPressure.fill(0)
        this.nrpn.clear()
        this.rpn.clear()
        this.heldNotes.clear()
        this._selectors = { nrpn: [null, null], rpn: [null, null] }
        this._parameterFamily = null
        this._nrpnPorts.clear()
        this._rpnPorts.clear()
        this._pitchBendPort = null
        this._pressurePort = null
        this._polyPressurePorts.fill(null)
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
        this._portInventory = null
        // Messages without a port also need isolated CC byte pairing.
        this._unscopedState = portRegistry ? new MidiState({ portRegistry: false }) : null
        this.mpeZones = { lower: null, upper: null }
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
        for (let n = 1; n <= 16; n++) {
            const channel = this.channels[n]
            for (let cc = 0; cc < 128; cc++) {
                if (channel._ccPorts[cc] === id) {
                    channel.cc[cc] = 0
                    channel._ccPorts[cc] = null
                }
            }
            for (let cc = 0; cc < 32; cc++) {
                if (channel._cc14Ports[cc] === id) {
                    channel.cc14[cc] = 0
                    channel._cc14Ports[cc] = null
                }
            }
        }
        for (let n = 1; n <= 16; n++) {
            const channel = this.channels[n]
            this._clearNoteOrigin(channel, id)
            for (const family of ['nrpn', 'rpn']) {
                for (const [parameter, origin] of channel[`_${family}Ports`]) {
                    if (origin !== id) continue
                    channel[family].delete(parameter)
                    channel[`_${family}Ports`].delete(parameter)
                }
            }
            if (channel._pitchBendPort === id) {
                channel.pitchBend = 8192
                channel._pitchBendPort = null
            }
            if (channel._pressurePort === id) {
                channel.pressure = 0
                channel._pressurePort = null
            }
            for (let key = 0; key < 128; key++) {
                if (channel._polyPressurePorts[key] !== id) continue
                channel.polyPressure[key] = 0
                channel._polyPressurePorts[key] = null
            }
        }
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
        if (this._portInventory) {
            const entry = this._ports?.get(this._portInventory.get(selector.name))
            return entry?.connected ? entry.state : null
        }
        return this._portsByName?.get(selector.name) ?? null
    }

    /** Physical discovery is independent of which inputs could be opened. */
    setPortInventory(ports) {
        const names = new Map()
        for (const port of ports || []) {
            if (port.connected === false || typeof port.id !== 'string' || !port.id ||
                typeof port.name !== 'string' || !port.name) continue
            const previous = names.get(port.name)
            names.set(port.name, previous === undefined || previous === port.id ? port.id : null)
        }
        this._portInventory = names
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

    /** Newest physically held note; each port resolves its own zone first. */
    getZoneVoice({ zone, members } = {}) {
        if ((zone !== 0 && zone !== 1) || (members !== undefined &&
            (!Number.isInteger(members) || members < 1 || members > 15))) return null
        let newest = null
        if (this._ports) {
            const scopes = [this._unscopedState,
                ...[...this._ports.values()].filter(port => port.connected).map(port => port.state)]
            for (const scope of scopes) {
                const voice = scope.getZoneVoice({ zone, members })
                if (voice && (!newest || voice.order > newest.order)) newest = voice
            }
            return newest
        }
        const count = members ?? this.mpeZones[zone === 0 ? 'lower' : 'upper'] ?? 15
        const first = zone === 0 ? 2 : 16 - count
        const last = zone === 0 ? 1 + count : 15
        for (let index = first; index <= last; index++) {
            const channel = this.channels[index]
            for (const note of channel.heldNotes.values()) {
                if (!newest || note.order > newest.order) newest = { ...note, channel, channelNumber: index }
            }
        }
        return newest
    }

    _configureMpeZone(master, count) {
        if ((master !== 1 && master !== 16) || count > 15) return []
        const previous = { ...this.mpeZones }
        const zone = master === 1 ? 'lower' : 'upper'
        const other = master === 1 ? 'upper' : 'lower'
        this.mpeZones[zone] = count
        this.mpeZones[other] ??= 0
        if (count > 0 && count + this.mpeZones[other] > 14) {
            this.mpeZones[other] = Math.max(0, 14 - count)
        }
        const owner = (zones, channel) => {
            if (zones.lower > 0 && channel === 1) return 'lowerManager'
            if (zones.upper > 0 && channel === 16) return 'upperManager'
            if (zones.lower > 0 && channel >= 2 && channel <= zones.lower + 1) return 'lower'
            if (zones.upper > 0 && channel >= 16 - zones.upper && channel <= 15) return 'upper'
            return null
        }
        const changed = []
        for (let channel = 1; channel <= 16; channel++) {
            if (owner(previous, channel) === owner(this.mpeZones, channel)) continue
            changed.push(channel)
            const state = this.channels[channel]
            const selectors = state._selectors
            const family = state._parameterFamily
            const selectorBytes = state.cc.slice(98, 102)
            state.clearNotes()
            state.resetControllers()
            // MCM is not CC121: keep parameter selection, including the active
            // configuration transaction, so further Data Entry remains valid.
            state._selectors = selectors
            state._parameterFamily = family
            state.cc.set(selectorBytes, 98)
            // Neutral timbre is an adapter default, not a mandated CC74 reset.
            this.channels[channel].cc[74] = 64
        }
        return changed
    }

    _clearNoteOrigin(channel, origin) {
        for (const [key, note] of channel.heldNotes) {
            if (note.origin !== origin) continue
            channel.keys[key] = 0
            channel.heldNotes.delete(key)
        }
        if (!channel.heldNotes.has(channel.key)) channel.gate = 0
    }

    _copyControllerReset(channel, source, origin, resetTimbre = false) {
        for (let cc = 0; cc < 128; cc++) {
            if ((retainedResetControllers.has(cc) && !(resetTimbre && cc === 74)) ||
                (channel._ccPorts[cc] !== origin && channel._ccPorts[cc] !== null)) continue
            channel.cc[cc] = source.cc[cc]
            channel._ccPorts[cc] = origin
        }
        for (let cc = 0; cc < 32; cc++) {
            if (channel._cc14Ports[cc] !== origin && channel._cc14Ports[cc] !== null) continue
            channel.cc14[cc] = source.cc14[cc]
            channel._cc14Ports[cc] = origin
        }
        if (channel._pitchBendPort === origin || channel._pitchBendPort === null) channel.pitchBend = 8192
        if (channel._pressurePort === origin || channel._pressurePort === null) channel.pressure = 0
        for (let key = 0; key < 128; key++) {
            if (channel._polyPressurePorts[key] === origin) channel.polyPressure[key] = 0
        }
    }

    /**
     * Process a raw MIDI message.
     * Parses the status byte and routes to appropriate channel.
     * @param {Uint8Array} data - Raw MIDI message data [status, key, velocity]
     * @param {{id: string, name: string}} [port] - Originating Web MIDI port
     */
    handleMessage(data, port) {
        if (!data || data.length < 1) return
        const sourceState = this._ports
            ? (port ? this.registerPort(port) : this._unscopedState)
            : null
        if (port && this._ports && !sourceState) return
        const parameterChange = sourceState?.handleMessage(data)
        const status = data[0]
        if (status === 0xf8) { this.clockCount++; return }
        const key = data[1]
        const velocity = data[2]
        const channel = (status & 0x0f) + 1
        const messageType = status & 0xf0
        if (!Number.isInteger(key) || key < 0 || key > 127) return
        if (messageType !== 0xd0 && (!Number.isInteger(velocity) || velocity < 0 || velocity > 127)) return
        const channelState = this.getChannel(channel)
        const source = sourceState?.getChannel(channel)
        const origin = port?.id ?? unscopedMidiOrigin
        if (messageType === 0xe0) {
            channelState.pitchBend = key | (velocity << 7)
            channelState._pitchBendPort = origin
            return
        }
        if (messageType === 0xd0) {
            channelState.pressure = key
            channelState._pressurePort = origin
            return
        }
        if (messageType === 0xa0) {
            channelState.polyPressure[key] = velocity
            channelState._polyPressurePorts[key] = origin
            return
        }
        if (messageType === 0xb0) {
            if (!source) {
                const change = channelState.controlChange(key, velocity)
                if (change?.family === 'rpn' && change.parameter === 6 && key === 6) {
                    change.resetChannels = this._configureMpeZone(channel, velocity)
                }
                return change
            }
            channelState.cc[key] = source.cc[key]
            channelState._ccPorts[key] = origin
            if (key < 64) {
                const msb = key & 31
                channelState.cc14[msb] = source.cc14[msb]
                channelState._cc14Ports[msb] = origin
            }
            if (parameterChange) {
                const { family, parameter, value } = parameterChange
                channelState[family].set(parameter, value)
                channelState[`_${family}Ports`].set(parameter, origin)
                for (const index of parameterChange.resetChannels || []) {
                    this._clearNoteOrigin(this.channels[index], origin)
                    this._copyControllerReset(this.channels[index], sourceState.channels[index], origin, true)
                }
            }
            if (key === 120 || key === 123) {
                this._clearNoteOrigin(channelState, origin)
                for (let note = 0; note < 128; note++) {
                    if (channelState._polyPressurePorts[note] === origin) channelState.polyPressure[note] = 0
                }
            }
            if (key === 121) {
                this._copyControllerReset(channelState, source, origin)
            }
            return parameterChange
        }
        if (messageType === 0x90 && velocity > 0) {
            channelState.noteOn(key, velocity, source?.heldNotes.get(key), origin)
        } else if (messageType === 0x80 || (messageType === 0x90 && velocity === 0)) {
            if (!source) {
                channelState.noteOff(key)
            } else {
                // Preserve legacy aggregate gate behavior without erasing a
                // same-key held note or pressure supplied by another port.
                channelState.gate = 0
                if (channelState.heldNotes.get(key)?.origin === origin) {
                    channelState.keys[key] = 0
                    channelState.heldNotes.delete(key)
                }
                if (channelState._polyPressurePorts[key] === origin) channelState.polyPressure[key] = 0
            }
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
        this.mpeZones = { lower: null, upper: null }
        this._unscopedState?.reset()
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
    constructor({ deviceRegistry = true } = {}) {
        /** @type {number} Low frequency band level (0-1) */
        this.low = 0
        /** @type {number} Mid frequency band level (0-1) */
        this.mid = 0
        /** @type {number} High frequency band level (0-1) */
        this.high = 0
        /** @type {number} Overall volume level (0-1) */
        this.vol = 0
        /** @type {number} Bipolar time-domain/DC signal (-1 to 1) */
        this.raw = 0
        /** True only after the raw capture path has supplied a real sample. */
        this.rawReady = false
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
        this._frequencyData = null
        this._maxBufferLength = 5
        /** @type {Map<string, {id: string, name: string, connected: boolean, channelCount: number, channels: Map<number, AudioState>}>|null} */
        this._devices = deviceRegistry ? new Map() : null
        /** @type {Map<string, object|null>|null} Connected name lookup; null means ambiguous. */
        this._devicesByName = deviceRegistry ? new Map() : null
        this._deviceInventory = null
        this._defaultChannels = deviceRegistry ? new Map() : null
        this._defaultConnected = false
    }

    /** Supply complete device discovery independently of the devices being captured. */
    setDeviceInventory(devices) {
        const names = new Map()
        for (const device of devices || []) {
            if (device.connected === false || typeof device.id !== 'string' || !device.id ||
                typeof device.name !== 'string' || !device.name) continue
            const previous = names.get(device.name)
            names.set(device.name, previous === undefined || previous === device.id ? device.id : null)
        }
        this._deviceInventory = names
    }

    /** Register the independently analyzed channels of the default device. */
    registerDefaultChannels(channelCount) {
        if (!this._defaultChannels || !Number.isInteger(channelCount) ||
            channelCount < 1 || channelCount > 32) return null
        this._defaultConnected = true
        for (let channel = 1; channel <= channelCount; channel++) {
            if (!this._defaultChannels.has(channel)) {
                this._defaultChannels.set(channel, new AudioState({ deviceRegistry: false }))
            }
        }
        for (const [channel, state] of this._defaultChannels) {
            if (channel > channelCount) {
                state.reset()
                this._defaultChannels.delete(channel)
            }
        }
        return this._defaultChannels
    }

    getDefaultChannelState(channel) {
        if (!this._defaultConnected || !Number.isInteger(channel) || channel < 1 || channel > 32) return null
        return this._defaultChannels?.get(channel) ?? null
    }

    disconnectDefaultInput() {
        this._defaultConnected = false
        for (const state of this._defaultChannels?.values() || []) state.reset()
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

        if (!this._frequencyData || this._frequencyData.length !== analyser.frequencyBinCount) {
            this._frequencyData = new Uint8Array(analyser.frequencyBinCount)
        }
        const buf = this._frequencyData
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
     * Store one signed time-domain control value.
     * @param {number} value - Bipolar input sample mean (-1 to 1)
     */
    setRaw(value) {
        this.raw = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
        this.rawReady = true
    }

    /** Mark raw input unavailable without representing it as a real zero sample. */
    setRawUnavailable() {
        this.raw = 0
        this.rawReady = false
    }

    /**
     * Register or reconnect one browser audio input device.
     * @param {{id: string, name: string, channelCount: number}} device
     * @returns {object|null}
     */
    registerDevice(device) {
        if (!this._devices || !device || typeof device.id !== 'string' || !device.id) return null
        const name = typeof device.name === 'string' ? device.name : ''
        const channelCount = Number.isInteger(device.channelCount) && device.channelCount >= 1
            ? device.channelCount
            : 1
        let entry = this._devices.get(device.id)
        let topologyChanged = false
        if (!entry) {
            entry = {
                id: device.id,
                name,
                connected: true,
                channelCount,
                channels: new Map()
            }
            this._devices.set(device.id, entry)
            topologyChanged = true
        } else {
            topologyChanged = entry.name !== name || !entry.connected || entry.channelCount !== channelCount
            entry.name = name
            entry.connected = true
            entry.channelCount = channelCount
        }
        for (let channel = 1; channel <= channelCount; channel++) {
            if (!entry.channels.has(channel)) {
                entry.channels.set(channel, new AudioState({ deviceRegistry: false }))
            }
        }
        for (const [channel, state] of entry.channels) {
            if (channel > channelCount) {
                state.reset()
                entry.channels.delete(channel)
            }
        }
        if (topologyChanged) this._rebuildDeviceNameIndex()
        return entry
    }

    /**
     * Update analyzed values for one selected device channel.
     * @param {string} id
     * @param {number} channel - One-based channel number
     * @param {{low?: number, mid?: number, high?: number, vol?: number, raw?: number}} values
     * @returns {boolean}
     */
    setChannelValues(id, channel, values = {}) {
        const entry = this._devices?.get(id)
        const state = entry?.connected ? entry.channels.get(channel) : null
        if (!state) return false
        for (const key of ['low', 'mid', 'high', 'vol']) {
            if (Number.isFinite(values[key])) {
                state[key] = Math.max(0, Math.min(1, values[key]))
            }
        }
        if (Number.isFinite(values.raw)) state.setRaw(values.raw)
        return true
    }

    /** Mark raw samples unavailable for every channel on one device. */
    setDeviceRawUnavailable(id) {
        const entry = this._devices?.get(id)
        if (!entry) return
        for (const state of entry.channels.values()) state.setRawUnavailable()
    }

    /**
     * Resolve a selected device and one-based channel. Exact id is
     * authoritative; a name-only selector must match one connected device.
     * @param {{name?: string, id?: string, channel?: number}} selector
     * @returns {AudioState|null}
     */
    getDeviceChannelState(selector = {}) {
        if (!selector.name && !selector.id && selector.channel === undefined) return this
        if (!Number.isInteger(selector.channel) || selector.channel < 1 || selector.channel > 32) return null
        if (!selector.name && !selector.id) return this.getDefaultChannelState(selector.channel)
        let entry
        if (selector.id) {
            entry = this._devices?.get(selector.id)
        } else if (selector.name) {
            entry = this._deviceInventory
                ? this._devices?.get(this._deviceInventory.get(selector.name))
                : this._devicesByName?.get(selector.name)
        }
        if (!entry?.connected) return null
        return entry.channels.get(selector.channel) || null
    }

    /** Mark one audio device unavailable while retaining its identity. */
    disconnectDevice(id) {
        const entry = this._devices?.get(id)
        if (!entry) return
        entry.connected = false
        for (const state of entry.channels.values()) state.reset()
        this._rebuildDeviceNameIndex()
    }

    _rebuildDeviceNameIndex() {
        if (!this._devices || !this._devicesByName) return
        this._devicesByName.clear()
        for (const entry of this._devices.values()) {
            if (!entry.connected || !entry.name) continue
            if (this._devicesByName.has(entry.name)) {
                this._devicesByName.set(entry.name, null)
            } else {
                this._devicesByName.set(entry.name, entry)
            }
        }
    }

    /** Return structured device identity, connection state, and channel count. */
    getDevices() {
        return [...(this._devices?.values() || [])].map(({ id, name, connected, channelCount }) => ({
            id,
            name,
            connected,
            channelCount
        }))
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

    /** Clear the legacy aggregate without disturbing independently captured channels. */
    resetAggregate() {
        this.low = 0
        this.mid = 0
        this.high = 0
        this.vol = 0
        this.raw = 0
        this.rawReady = false
        this.fft.fill(0)
        this.spectrum.fill(0)
        this.waveform.fill(0.5)
        this._smoothingBuffers.low = []
        this._smoothingBuffers.mid = []
        this._smoothingBuffers.high = []
    }

    /** Reset aggregate and all independently captured channel samples. */
    reset() {
        this.resetAggregate()
        for (const state of this._defaultChannels?.values() || []) state.reset()
        if (this._devices) {
            for (const entry of this._devices.values()) {
                for (const state of entry.channels.values()) state.reset()
            }
        }
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
        this._portOperationTokens = new Map()
        this._knownInputs = new Map()
        this._portInventory = new Map()
        this._openingInputs = new Map()
        this._activeInputs = new Map()
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

            this._knownInputs.clear()
            this._portInventory.clear()
            this._openingInputs.clear()
            this._activeInputs.clear()
            // Install lifecycle tracking before any input.open() can yield.
            this._midiAccess.onstatechange = async (event) => {
                if (generation !== this._generation) return
                if (event.port.type === 'input') {
                    this._syncPortInventory()
                    const currentInput = this._midiAccess.inputs.get(event.port.id)
                    if (currentInput && currentInput !== event.port) return
                    if (event.port.state === 'connected' && this._midiAccess.inputs.get(event.port.id) === event.port) {
                        const opened = await this._connectInput(event.port, generation, midiState)
                        if (generation !== this._generation) return
                        if (opened) {
                            this._notifyStatus(`MIDI connected: ${event.port.name}`, {
                                state: 'connected',
                                deviceCount: this.getPorts().filter(port => port.connected).length,
                                port: { id: event.port.id, name: event.port.name || '' }
                            })
                        }
                    } else {
                        event.port.onmidimessage = null
                        this._notifyStatus(`MIDI disconnected: ${event.port.name}`, {
                            state: 'disconnected',
                            deviceCount: this.getPorts().filter(port => port.connected).length,
                            port: { id: event.port.id, name: event.port.name || '' }
                        })
                    }
                    this._notifyPortsChange()
                }
            }

            this._syncPortInventory()
            this._notifyPortsChange()
            let openFailures = 0
            for (const input of [...this._midiAccess.inputs.values()]) {
                if (input.state === 'disconnected') continue
                if (!await this._connectInput(input, generation, midiState)) openFailures++
                if (generation !== this._generation) return false
            }
            this._syncPortInventory()
            this._notifyPortsChange()

            if (generation !== this._generation) return false
            this._enabled = true
            const inputCount = this.getPorts().filter(port => port.connected).length
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
        this._portOperationTokens.clear()
        this._openingInputs.clear()
        this._activeInputs.clear()

        if (this._midiAccess) {
            for (const input of this._knownInputs.values()) {
                input.onmidimessage = null
                this._midiState?.disconnectPort(input.id)
                this._portInventory.set(input.id, { id: input.id, name: input.name || '', connected: false })
            }
            this._midiAccess.onstatechange = null
            this._midiState?.setPortInventory(this.getPorts())
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
        return [...this._portInventory.values()].map(port => ({ ...port }))
    }

    /**
     * Return the latest structured MIDI access or connection status.
     */
    getStatus() {
        return { ...this._status }
    }

    _syncPortInventory() {
        const currentInputs = this._midiAccess?.inputs
        if (!currentInputs) return
        for (const [id, input] of this._knownInputs) {
            if (currentInputs.get(id) === input && input.state !== 'disconnected') continue
            this._invalidatePortOperation(id)
            input.onmidimessage = null
            this._activeInputs.delete(id)
            this._midiState?.disconnectPort(id)
            this._portInventory.set(id, { id, name: input.name || '', connected: false })
        }
        for (const input of currentInputs.values()) {
            this._knownInputs.set(input.id, input)
            this._portInventory.set(input.id, {
                id: input.id, name: input.name || '', connected: input.state !== 'disconnected'
            })
        }
        this._midiState?.setPortInventory(this.getPorts())
    }

    _connectInput(input, generation = this._generation, midiState = this._midiState) {
        if (generation !== this._generation || this._midiAccess?.inputs.get(input.id) !== input ||
            input.state === 'disconnected') return Promise.resolve(false)
        const pending = this._openingInputs.get(input.id)
        if (pending?.input === input && pending.generation === generation) return pending.promise
        if (this._activeInputs.get(input.id) === input && input.connection === 'open') return Promise.resolve(true)
        const operationToken = (this._portOperationTokens.get(input.id) || 0) + 1
        this._portOperationTokens.set(input.id, operationToken)
        let finish
        const operation = { input, generation, promise: new Promise(resolve => { finish = resolve }) }
        // Publish the operation before calling open: open can synchronously
        // emit a connection-state event which must share this same operation.
        this._openingInputs.set(input.id, operation)
        this._openInput(input, generation, midiState, operationToken).then(result => {
            if (this._openingInputs.get(input.id) === operation) this._openingInputs.delete(input.id)
            finish(result)
        }, error => {
            if (this._openingInputs.get(input.id) === operation) this._openingInputs.delete(input.id)
            console.error('MIDI input setup failed:', error)
            finish(false)
        })
        return operation.promise
    }

    async _openInput(input, generation, midiState, operationToken) {
        const port = { id: input.id, name: input.name || '' }
        const isCurrent = () => generation === this._generation &&
            this._portOperationTokens.get(input.id) === operationToken &&
            this._midiAccess?.inputs.get(input.id) === input && input.state !== 'disconnected'
        input.onmidimessage = null
        this._activeInputs.delete(input.id)
        midiState?.disconnectPort(input.id)
        try {
            if (input.connection !== 'open') await input.open()
            if (generation !== this._generation) return false
            this._syncPortInventory()
            if (!isCurrent()) return false
            midiState?.registerPort(port)
            this._activeInputs.set(input.id, input)
            input.onmidimessage = (event) => {
                if (!isCurrent() || this._activeInputs.get(input.id) !== input) return
                this._handleMidiMessage(event, port)
            }
            return true
        } catch (err) {
            if (generation !== this._generation) return false
            this._syncPortInventory()
            if (!isCurrent()) return false
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

    _invalidatePortOperation(id) {
        if (!id) return
        this._portOperationTokens.set(id, (this._portOperationTokens.get(id) || 0) + 1)
        this._openingInputs.delete(id)
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
            this._audioState.raw = 0
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
