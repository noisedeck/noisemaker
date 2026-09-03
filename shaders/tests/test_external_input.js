/**
 * Tests for External Input State Classes (MIDI & Audio)
 *
 * Tests the MidiState, MidiChannelState, and AudioState classes
 * that provide real-time input state for midi() and audio() functions.
 */

import { MidiState, MidiChannelState, MidiInputManager, AudioState } from '../src/runtime/external-input.js'

let passCount = 0
let failCount = 0

function test(name, fn) {
    try {
        fn()
        console.log(`PASS: ${name}`)
        passCount++
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e.message)
        failCount++
    }
}

async function asyncTest(name, fn) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
        passCount++
    } catch (e) {
        console.error(`FAIL: ${name}`)
        console.error(e.message)
        failCount++
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed')
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

function assertApprox(actual, expected, tolerance = 0.001, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message || 'Assertion failed'}: expected ~${expected}, got ${actual}`)
    }
}

// ============================================================================
// MidiChannelState Tests
// ============================================================================

console.log('\n=== MidiChannelState Tests ===\n')

test('MidiChannelState initializes with zeros', () => {
    const channel = new MidiChannelState()
    assertEqual(channel.key, 0, 'key should be 0')
    assertEqual(channel.velocity, 0, 'velocity should be 0')
    assertEqual(channel.gate, 0, 'gate should be 0')
    assertEqual(channel.time, 0, 'time should be 0')
})

test('MidiChannelState.noteOn sets all properties', () => {
    const channel = new MidiChannelState()
    const before = Date.now()
    channel.noteOn(60, 100)
    const after = Date.now()

    assertEqual(channel.key, 60, 'key should be 60')
    assertEqual(channel.velocity, 100, 'velocity should be 100')
    assertEqual(channel.gate, 1, 'gate should be 1')
    assert(channel.time >= before && channel.time <= after, 'time should be set to current time')
})

test('MidiChannelState.noteOff clears gate but preserves key/velocity', () => {
    const channel = new MidiChannelState()
    channel.noteOn(60, 100)
    channel.noteOff()

    assertEqual(channel.key, 60, 'key should remain 60')
    assertEqual(channel.velocity, 100, 'velocity should remain 100')
    assertEqual(channel.gate, 0, 'gate should be 0')
})

test('MidiChannelState.reset clears all properties', () => {
    const channel = new MidiChannelState()
    channel.noteOn(60, 100)
    channel.reset()

    assertEqual(channel.key, 0, 'key should be 0')
    assertEqual(channel.velocity, 0, 'velocity should be 0')
    assertEqual(channel.gate, 0, 'gate should be 0')
    assertEqual(channel.time, 0, 'time should be 0')
})

// ============================================================================
// MidiState Tests
// ============================================================================

console.log('\n=== MidiState Tests ===\n')

test('MidiState initializes 16 channels', () => {
    const midi = new MidiState()
    for (let i = 1; i <= 16; i++) {
        assert(midi.channels[i] instanceof MidiChannelState, `channel ${i} should exist`)
    }
})

test('MidiState.getChannel returns correct channel', () => {
    const midi = new MidiState()
    midi.channels[5].noteOn(64, 80)

    const ch5 = midi.getChannel(5)
    assertEqual(ch5.key, 64, 'should return channel 5')
    assertEqual(ch5.velocity, 80, 'should have correct velocity')
})

test('MidiState.getChannel falls back to channel 1 for invalid channels', () => {
    const midi = new MidiState()
    midi.channels[1].noteOn(60, 100)

    const invalid = midi.getChannel(99)
    assertEqual(invalid.key, 60, 'should fall back to channel 1')
})

test('MidiState.handleMessage processes note on', () => {
    const midi = new MidiState()
    // Note On, channel 1 (0x90), key 60, velocity 100
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))

    const ch1 = midi.getChannel(1)
    assertEqual(ch1.key, 60, 'key should be 60')
    assertEqual(ch1.velocity, 100, 'velocity should be 100')
    assertEqual(ch1.gate, 1, 'gate should be 1')
})

test('MidiState.handleMessage processes note on for channel 5', () => {
    const midi = new MidiState()
    // Note On, channel 5 (0x94), key 72, velocity 64
    midi.handleMessage(new Uint8Array([0x94, 72, 64]))

    const ch5 = midi.getChannel(5)
    assertEqual(ch5.key, 72, 'key should be 72')
    assertEqual(ch5.velocity, 64, 'velocity should be 64')
    assertEqual(ch5.gate, 1, 'gate should be 1')
})

test('MidiState.handleMessage processes note off (0x80)', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))  // Note on
    midi.handleMessage(new Uint8Array([0x80, 60, 0]))    // Note off

    const ch1 = midi.getChannel(1)
    assertEqual(ch1.gate, 0, 'gate should be 0')
    assertEqual(ch1.key, 60, 'key should remain')
})

test('MidiState.handleMessage processes note on with velocity 0 as note off', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))  // Note on
    midi.handleMessage(new Uint8Array([0x90, 60, 0]))    // Note on with vel 0

    const ch1 = midi.getChannel(1)
    assertEqual(ch1.gate, 0, 'gate should be 0')
})

test('MidiState.reset clears all channels', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))
    midi.handleMessage(new Uint8Array([0x95, 72, 80]))
    midi.reset()

    for (let i = 1; i <= 16; i++) {
        assertEqual(midi.channels[i].gate, 0, `channel ${i} gate should be 0`)
        assertEqual(midi.channels[i].key, 0, `channel ${i} key should be 0`)
    }
})

test('MidiState isolates messages by Web MIDI port while preserving the aggregate', () => {
    const midi = new MidiState()

    midi.handleMessage(new Uint8Array([0x90, 60, 40]), { id: 'left-id', name: 'Launch Control XL' })
    midi.handleMessage(new Uint8Array([0x90, 72, 100]), { id: 'right-id', name: 'Launch Control XL' })

    assertEqual(midi.getChannel(1).key, 72, 'legacy aggregate should retain the latest message')
    assertEqual(midi.getPortState({ name: 'Launch Control XL', id: 'left-id' }).getChannel(1).key,
        60, 'left port should retain only its own message')
    assertEqual(midi.getPortState({ name: 'Launch Control XL', id: 'right-id' }).getChannel(1).key,
        72, 'right port should retain only its own message')
})

test('MidiState resolves a unique readable name but rejects an ambiguous one', () => {
    const midi = new MidiState()
    midi.registerPort({ id: 'left-id', name: 'Launch Control XL' })

    assert(midi.getPortState({ name: 'Launch Control XL' }), 'one readable-name match should resolve')

    midi.registerPort({ id: 'right-id', name: 'Launch Control XL' })
    assertEqual(midi.getPortState({ name: 'Launch Control XL' }), null,
        'duplicate readable names should be ambiguous')
})

test('MidiState uses id as authority when a port name changes', () => {
    const midi = new MidiState()
    midi.registerPort({ id: 'port-id', name: 'Renamed Controller' })

    const selected = midi.getPortState({ name: 'Old Controller Name', id: 'port-id' })
    assert(selected, 'matching id should resolve despite a stale readable name')
})

test('MidiState makes a disconnected selected port unavailable and clears its held notes', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 127]), { id: 'port-id', name: 'Launch Control XL' })
    const portState = midi.getPortState({ name: 'Launch Control XL', id: 'port-id' })
    assertEqual(portState.getChannel(1).gate, 1, 'fixture should begin with a held note')

    midi.disconnectPort('port-id')

    assertEqual(portState.getChannel(1).gate, 0, 'disconnect should clear held notes')
    assertEqual(midi.getPortState({ name: 'Launch Control XL', id: 'port-id' }), null,
        'disconnected exact port should not resolve')
})

test('MidiState exposes structured connected-port inventory', () => {
    const midi = new MidiState()
    midi.registerPort({ id: 'port-id', name: 'Launch Control XL' })

    assertEqual(JSON.stringify(midi.getPorts()), JSON.stringify([
        { id: 'port-id', name: 'Launch Control XL', connected: true }
    ]), 'inventory should expose the Web MIDI identity fields and connection state')
})

console.log('\n=== MidiInputManager Tests ===\n')

await asyncTest('MidiInputManager routes messages with structured port identity and reports hot-plug state', async () => {
    const input = {
        id: 'port-id',
        manufacturer: 'Novation',
        name: 'Launch Control XL',
        type: 'input',
        version: '1',
        state: 'connected',
        connection: 'closed',
        onmidimessage: null,
        open() { this.connection = 'open'; return Promise.resolve(this) },
        close() { this.connection = 'closed'; return Promise.resolve(this) }
    }
    const access = {
        inputs: new Map([[input.id, input]]),
        outputs: new Map(),
        onstatechange: null,
        sysexEnabled: false
    }
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: async () => access }
    })

    try {
        const midiState = new MidiState()
        const manager = new MidiInputManager({ setMidiState: () => midiState })
        const inventories = []
        const statuses = []
        manager.onPortsChange(ports => inventories.push(ports))
        manager.onStatusChange((message, status) => statuses.push({ message, status }))

        assertEqual(await manager.enable(), true, 'manager should enable')
        assertEqual(manager.getStatus().state, 'enabled',
            'manager should expose a structured enabled state')
        assertEqual(manager.getStatus().message, 'MIDI enabled (1 device)',
            'manager should expose the enabled status message')
        assertEqual(manager.getStatus().deviceCount, 1,
            'manager should expose the enabled device count')
        assert(statuses.some(entry => entry.status?.state === 'enabled'),
            'status callback should include a structured enabled state')
        assertEqual(JSON.stringify(manager.getPorts()), JSON.stringify([
            { id: 'port-id', name: 'Launch Control XL', connected: true }
        ]), 'initial inventory should be structured')

        input.onmidimessage({ data: new Uint8Array([0x90, 60, 100]) })
        assertEqual(midiState.getPortState({ id: 'port-id' }).getChannel(1).key, 60,
            'input callback should retain the originating port identity')

        input.state = 'disconnected'
        access.inputs.delete(input.id)
        access.onstatechange({ port: input })
        assertEqual(manager.getStatus().state, 'disconnected',
            'disconnect should expose a structured disconnected state')
        assertEqual(manager.getStatus().port.id, 'port-id',
            'disconnect status should identify the affected port')
        assertEqual(midiState.getPortState({ id: 'port-id' }), null,
            'disconnect event should make the exact port unavailable')
        assert(inventories.some(ports => ports[0]?.connected === false),
            'port callback should report the disconnected state')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('MidiInputManager classifies non-permission access failures as operational errors', async () => {
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: async () => { throw new Error('adapter unavailable') } }
    })

    try {
        const manager = new MidiInputManager({ setMidiState: () => new MidiState() })
        assertEqual(await manager.enable(), false, 'manager should report failed enable')
        assertEqual(manager.getStatus().state, 'error',
            'non-permission access failure should not be reported as denied')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('MidiInputManager handles rejected port open without an unhandled promise', async () => {
    const input = {
        id: 'broken-port',
        name: 'Broken Controller',
        type: 'input',
        state: 'connected',
        connection: 'closed',
        onmidimessage: null,
        open: async () => { throw new Error('open failed') }
    }
    const access = {
        inputs: new Map([[input.id, input]]),
        outputs: new Map(),
        onstatechange: null
    }
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: async () => access }
    })

    try {
        const midiState = new MidiState()
        const manager = new MidiInputManager({ setMidiState: () => midiState })
        assertEqual(await manager.enable(), true, 'MIDI access itself should remain enabled')
        assertEqual(manager.getStatus().state, 'error', 'port open rejection should be an operational error')
        assertEqual(midiState.getPortState({ id: 'broken-port' }), null,
            'a port that failed to open must not be registered as connected')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('MidiInputManager coalesces concurrent enable requests', async () => {
    let requestCount = 0
    let resolveAccess
    const accessPromise = new Promise(resolve => { resolveAccess = resolve })
    const access = { inputs: new Map(), outputs: new Map(), onstatechange: null }
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            requestMIDIAccess: () => {
                requestCount++
                return accessPromise
            }
        }
    })

    try {
        let stateCount = 0
        const manager = new MidiInputManager({
            setMidiState: () => { stateCount++; return new MidiState() }
        })
        const first = manager.enable()
        const second = manager.enable()
        assertEqual(requestCount, 1, 'concurrent callers should share one permission request')
        resolveAccess(access)
        assertEqual(await first, true, 'first caller should receive successful enable')
        assertEqual(await second, true, 'second caller should share successful enable')
        assertEqual(stateCount, 1, 'renderer should receive only one MidiState')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('MidiInputManager disable cancels a pending permission request', async () => {
    let resolveAccess
    const accessPromise = new Promise(resolve => { resolveAccess = resolve })
    const access = { inputs: new Map(), outputs: new Map(), onstatechange: null }
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: () => accessPromise }
    })

    try {
        let stateCount = 0
        const manager = new MidiInputManager({
            setMidiState: () => { stateCount++; return new MidiState() }
        })
        const enabling = manager.enable()
        manager.disable()
        resolveAccess(access)

        assertEqual(await enabling, false, 'cancelled enable should report false')
        assertEqual(manager.enabled, false, 'manager must remain disabled')
        assertEqual(stateCount, 0, 'cancelled request must not install renderer state')
        assertEqual(access.onstatechange, null, 'cancelled request must not install a port listener')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('MidiInputManager disable survives a stale port-open rejection', async () => {
    let rejectOpen
    const openPromise = new Promise((resolve, reject) => { rejectOpen = reject })
    const input = {
        id: 'slow-port',
        name: 'Slow Controller',
        type: 'input',
        state: 'connected',
        connection: 'closed',
        onmidimessage: null,
        open: () => openPromise
    }
    const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null }
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: async () => access }
    })

    try {
        const manager = new MidiInputManager({ setMidiState: () => new MidiState() })
        const enabling = manager.enable()
        await Promise.resolve()
        manager.disable()
        rejectOpen(new Error('late open failure'))

        assertEqual(await enabling, false, 'stale open failure should settle as cancelled')
        assertEqual(manager.getStatus().state, 'disabled',
            'stale open failure must not overwrite disabled status')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('stale port-open rejection cannot disconnect a newer generation', async () => {
    let rejectOldOpen
    const oldOpen = new Promise((resolve, reject) => { rejectOldOpen = reject })
    const oldInput = {
        id: 'shared-port',
        name: 'Old Controller',
        type: 'input',
        state: 'connected',
        connection: 'closed',
        onmidimessage: null,
        open: () => oldOpen
    }
    const newInput = {
        id: 'shared-port',
        name: 'New Controller',
        type: 'input',
        state: 'connected',
        connection: 'open',
        onmidimessage: null
    }
    const accesses = [
        { inputs: new Map([[oldInput.id, oldInput]]), outputs: new Map(), onstatechange: null },
        { inputs: new Map([[newInput.id, newInput]]), outputs: new Map(), onstatechange: null }
    ]
    let requestIndex = 0
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: async () => accesses[requestIndex++] }
    })

    try {
        const manager = new MidiInputManager({ setMidiState: () => new MidiState() })
        const oldEnable = manager.enable()
        await Promise.resolve()
        manager.disable()
        assertEqual(await manager.enable(), true, 'new generation should enable')
        rejectOldOpen(new Error('stale failure'))
        assertEqual(await oldEnable, false, 'old generation should settle as cancelled')

        assertEqual(manager.enabled, true, 'new generation should remain enabled')
        assertEqual(JSON.stringify(manager.getPorts()), JSON.stringify([
            { id: 'shared-port', name: 'New Controller', connected: true }
        ]), 'stale failure must not mutate the new generation port state')
        assertEqual(manager.getStatus().state, 'enabled',
            'stale failure must not overwrite the new generation status')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

await asyncTest('a stale hot-plug open cannot resurrect a disconnected port', async () => {
    let resolveOpen
    const openPromise = new Promise(resolve => { resolveOpen = resolve })
    const input = {
        id: 'slow-hotplug-port',
        name: 'Slow Hotplug Controller',
        type: 'input',
        state: 'connected',
        connection: 'closed',
        onmidimessage: null,
        open: () => openPromise
    }
    const access = { inputs: new Map(), outputs: new Map(), onstatechange: null }
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { requestMIDIAccess: async () => access }
    })

    try {
        const manager = new MidiInputManager({ setMidiState: () => new MidiState() })
        assertEqual(await manager.enable(), true, 'manager should enable without initial ports')

        access.inputs.set(input.id, input)
        const connecting = access.onstatechange({ port: input })
        await Promise.resolve()

        input.state = 'disconnected'
        access.inputs.delete(input.id)
        await access.onstatechange({ port: input })
        resolveOpen(input)
        await connecting

        assertEqual(manager.getStatus().state, 'disconnected',
            'stale open completion must not overwrite disconnected status')
        assertEqual(manager.getPorts().length, 0,
            'stale open completion must not register the disconnected port')
        assertEqual(input.onmidimessage, null,
            'stale open completion must not restore the message listener')
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        })
    }
})

// ============================================================================
// AudioState Tests
// ============================================================================

console.log('\n=== AudioState Tests ===\n')

test('AudioState initializes with zeros', () => {
    const audio = new AudioState()
    assertEqual(audio.low, 0, 'low should be 0')
    assertEqual(audio.mid, 0, 'mid should be 0')
    assertEqual(audio.high, 0, 'high should be 0')
    assertEqual(audio.vol, 0, 'vol should be 0')
    assertEqual(audio.fft.length, 16, 'fft should have 16 bins')
})

test('AudioState.setBands sets frequency bands directly', () => {
    const audio = new AudioState()
    audio.setBands(0.5, 0.3, 0.8)

    assertEqual(audio.low, 0.5, 'low should be 0.5')
    assertEqual(audio.mid, 0.3, 'mid should be 0.3')
    assertEqual(audio.high, 0.8, 'high should be 0.8')
    assertApprox(audio.vol, (0.5 + 0.3 + 0.8) / 3, 0.001, 'vol should be average')
})

test('AudioState.setBands clamps values to 0-1', () => {
    const audio = new AudioState()
    audio.setBands(-0.5, 1.5, 0.5)

    assertEqual(audio.low, 0, 'low should be clamped to 0')
    assertEqual(audio.mid, 1, 'mid should be clamped to 1')
    assertEqual(audio.high, 0.5, 'high should remain 0.5')
})

test('AudioState.reset clears all values', () => {
    const audio = new AudioState()
    audio.setBands(0.5, 0.5, 0.5)
    audio.reset()

    assertEqual(audio.low, 0, 'low should be 0')
    assertEqual(audio.mid, 0, 'mid should be 0')
    assertEqual(audio.high, 0, 'high should be 0')
    assertEqual(audio.vol, 0, 'vol should be 0')
})

test('AudioState smoothing accumulates over multiple updates', () => {
    const audio = new AudioState()

    // Set smoothing to 3 frames
    audio._maxBufferLength = 3

    // First update - buffer has 1 value
    audio.setBands(0.9, 0.9, 0.9)
    audio._smoothingBuffers.low = [0.9]
    audio._smoothingBuffers.mid = [0.9]
    audio._smoothingBuffers.high = [0.9]

    // Simulate smoothing behavior
    const result = audio._smooth('low', 0.3)
    // Buffer now [0.9, 0.3], average = 0.6
    assertApprox(result, 0.6, 0.001, 'smoothed value should be average')
})

// ============================================================================
// AudioState Waveform Tests
// ============================================================================

console.log('\n=== AudioState Waveform Tests ===\n')

test('AudioState initializes waveform as 128-element Float32Array', () => {
    const audio = new AudioState()
    assert(audio.waveform instanceof Float32Array, 'waveform should be Float32Array')
    assertEqual(audio.waveform.length, 128, 'waveform should have 128 elements')
    assertApprox(audio.waveform[0], 0.5, 0.01, 'waveform should default to 0.5 (silence)')
})

test('AudioState.setWaveform populates waveform from Uint8Array', () => {
    const audio = new AudioState()
    const raw = new Uint8Array(128)
    for (let i = 0; i < 64; i++) raw[i] = 255
    for (let i = 64; i < 128; i++) raw[i] = 0
    audio.setWaveform(raw)
    assertApprox(audio.waveform[0], 1.0, 0.01, 'first sample should be 1.0')
    assertApprox(audio.waveform[63], 1.0, 0.01, 'sample 63 should be 1.0')
    assertApprox(audio.waveform[64], 0.0, 0.01, 'sample 64 should be 0.0')
    assertApprox(audio.waveform[127], 0.0, 0.01, 'last sample should be 0.0')
})

test('AudioState.reset clears waveform to silence', () => {
    const audio = new AudioState()
    const raw = new Uint8Array(128)
    raw.fill(255)
    audio.setWaveform(raw)
    audio.reset()
    assertApprox(audio.waveform[0], 0.5, 0.01, 'waveform should reset to 0.5')
})

// ============================================================================
// MidiChannelState Per-Key Tracking Tests
// ============================================================================

console.log('\n=== MidiChannelState Per-Key Tests ===\n')

test('MidiChannelState initializes keys array with 128 zeros', () => {
    const channel = new MidiChannelState()
    assert(channel.keys instanceof Uint8Array, 'keys should be Uint8Array')
    assertEqual(channel.keys.length, 128, 'keys should have 128 elements')
    assertEqual(channel.keys[60], 0, 'key 60 should be 0')
})

test('MidiChannelState.noteOn sets velocity in keys array', () => {
    const channel = new MidiChannelState()
    channel.noteOn(60, 100)
    assertEqual(channel.keys[60], 100, 'key 60 should have velocity 100')
})

test('MidiChannelState.noteOff clears specific key in keys array', () => {
    const channel = new MidiChannelState()
    channel.noteOn(60, 100)
    channel.noteOn(64, 80)
    channel.noteOff(60)
    assertEqual(channel.keys[60], 0, 'key 60 should be cleared')
    assertEqual(channel.keys[64], 80, 'key 64 should remain')
})

test('MidiChannelState.reset clears all keys', () => {
    const channel = new MidiChannelState()
    channel.noteOn(60, 100)
    channel.noteOn(64, 80)
    channel.reset()
    assertEqual(channel.keys[60], 0, 'key 60 should be 0')
    assertEqual(channel.keys[64], 0, 'key 64 should be 0')
})

// ============================================================================
// MidiState Clock & Per-Key Message Tests
// ============================================================================

console.log('\n=== MidiState Clock & Per-Key Tests ===\n')

test('MidiState initializes clockCount to 0', () => {
    const midi = new MidiState()
    assertEqual(midi.clockCount, 0, 'clockCount should be 0')
})

test('MidiState.handleMessage increments clockCount on 0xF8', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0xF8]))
    assertEqual(midi.clockCount, 1, 'clockCount should be 1')
    midi.handleMessage(new Uint8Array([0xF8]))
    assertEqual(midi.clockCount, 2, 'clockCount should be 2')
})

test('MidiState.handleMessage updates per-key velocity on note on', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))
    assertEqual(midi.getChannel(1).keys[60], 100, 'key 60 velocity should be 100')
})

test('MidiState.handleMessage clears per-key velocity on note off', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))
    midi.handleMessage(new Uint8Array([0x80, 60, 0]))
    assertEqual(midi.getChannel(1).keys[60], 0, 'key 60 should be cleared')
})

test('MidiState.handleMessage clears per-key on note on velocity 0', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))
    midi.handleMessage(new Uint8Array([0x90, 60, 0]))
    assertEqual(midi.getChannel(1).keys[60], 0, 'key 60 should be cleared')
})

test('MidiState.reset clears clockCount', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0xF8]))
    midi.handleMessage(new Uint8Array([0xF8]))
    midi.reset()
    assertEqual(midi.clockCount, 0, 'clockCount should be 0 after reset')
})

// ============================================================================
// MidiState Note Grid Tests
// ============================================================================

console.log('\n=== MidiState Note Grid Tests ===\n')

test('MidiState.noteGrid is a pre-allocated Float32Array(128 * 16 * 4)', () => {
    const midi = new MidiState()
    assert(midi.noteGrid instanceof Float32Array, 'noteGrid should be Float32Array')
    assertEqual(midi.noteGrid.length, 128 * 16 * 4, 'noteGrid should have 128*16*4 elements')
})

test('MidiState.updateNoteGrid packs active notes into grid', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))  // Ch1, key 60, vel 100
    midi.updateNoteGrid()

    // Channel 1 = row 0, key 60 = column 60
    // Pixel at (60, 0): offset = (0 * 128 + 60) * 4
    const offset = 60 * 4
    assertApprox(midi.noteGrid[offset], 100 / 127, 0.01, 'R should be velocity/127')
    assertEqual(midi.noteGrid[offset + 1], 1, 'G should be 1 (gate on)')
})

test('MidiState.updateNoteGrid clears released notes', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))
    midi.handleMessage(new Uint8Array([0x80, 60, 0]))
    midi.updateNoteGrid()

    const offset = 60 * 4
    assertEqual(midi.noteGrid[offset], 0, 'R should be 0 (note off)')
    assertEqual(midi.noteGrid[offset + 1], 0, 'G should be 0 (gate off)')
})

test('MidiState.updateNoteGrid handles multiple channels', () => {
    const midi = new MidiState()
    midi.handleMessage(new Uint8Array([0x90, 60, 100]))  // Ch1
    midi.handleMessage(new Uint8Array([0x95, 72, 80]))   // Ch6
    midi.updateNoteGrid()

    // Ch1, key 60: row 0
    const offset1 = 60 * 4
    assertApprox(midi.noteGrid[offset1], 100 / 127, 0.01, 'Ch1 key 60 velocity')

    // Ch6, key 72: row 5
    const offset6 = (5 * 128 + 72) * 4
    assertApprox(midi.noteGrid[offset6], 80 / 127, 0.01, 'Ch6 key 72 velocity')
})

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== Test Summary ===')
console.log(`Passed: ${passCount}`)
console.log(`Failed: ${failCount}`)

if (failCount > 0) {
    process.exit(1)
}
