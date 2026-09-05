MIDI & Audio Input
==================

This guide covers the ``midi()`` and ``audio()`` functions for animating shader parameters with real-time external input.

Using in the Demo
-----------------

The shader demo includes MIDI and Audio toggle buttons in the toolbar. Click **midi** or **audio** to enable external input:

- **MIDI**: Click the ``midi`` button to enable Web MIDI API access. The demo will automatically detect connected MIDI controllers.
- **Audio**: Click the ``audio`` button to enable microphone input. Your browser will request permission to access the microphone.

Once enabled, you can use ``midi()`` and ``audio()`` in your DSL programs:

.. code-block:: dsl

    search synth
    // React to MIDI velocity and audio bass at the same time
    noise(
        scaleX: midi(channel: 1, min: 0.1, max: 1),
        speed: audio(band: audioBand.low, min: 0.25, max: 0.75)
    ).write(o0)
    render(o0)

Quick Start
-----------

MIDI Input
~~~~~~~~~~

Control a parameter with MIDI velocity from channel 1:

.. code-block:: dsl

    search synth
    noise(scaleX: midi(channel: 1, min: 0.1, max: 1)).write(o0)

Audio Input
~~~~~~~~~~~

React to bass frequencies in the audio input:

.. code-block:: dsl

    search synth
    noise(scaleX: audio(band: audioBand.low, min: 0.1, max: 0.5)).write(o0)

Automation values are normalized percentages. ``min: 0.1, max: 0.5`` maps
the source across 10%–50% of the receiving effect parameter's range. Those
bounds are not absolute parameter values.

midi() Function
---------------

The ``midi()`` function provides automation values from MIDI controller input.

Syntax
~~~~~~

.. code-block:: dsl

    midi(channel, mode?, min?, max?, sensitivity?, name: "...", id: "...")

Parameters
~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 15 15 20 50

   * - Parameter
     - Type
     - Default
     - Description
   * - ``channel``
     - int (1-16)
     - **required**
     - MIDI channel to listen to
   * - ``mode``
     - ``midiMode.*``
     - ``midiMode.velocity``
     - How to interpret MIDI data
   * - ``min``
     - number or automation
     - 0
     - Minimum normalized output (0–1)
   * - ``max``
     - number or automation
     - 1
     - Maximum normalized output (0–1)
   * - ``sensitivity``
     - number or automation
     - 1
     - Trigger falloff rate (higher = faster decay)
   * - ``name``
     - quoted string
     - none
     - Readable MIDI input name. Keyword-only.
   * - ``id``
     - quoted string
     - none
     - Exact MIDI input ID. Keyword-only. Requires ``name``.

MIDI Modes
~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Mode
     - Description
   * - ``midiMode.noteChange``
     - Value from note number (0-127), ignores gate state
   * - ``midiMode.gateNote``
     - Value from note number only while key is held
   * - ``midiMode.gateVelocity``
     - Value from velocity only while key is held
   * - ``midiMode.triggerNote``
     - Note value with decay envelope from note-on
   * - ``midiMode.velocity``
     - Velocity with decay envelope (default)

Trigger Modes
~~~~~~~~~~~~~

The ``triggerNote`` and ``velocity`` modes include automatic decay from the note-on event. The ``sensitivity`` parameter controls how quickly the value fades:

- ``sensitivity: 1`` - Decays over ~1 second
- ``sensitivity: 5`` - Decays over ~200ms
- ``sensitivity: 0.5`` - Decays over ~2 seconds

Selecting a MIDI input
~~~~~~~~~~~~~~~~~~~~~~

Without ``name`` or ``id``, ``midi()`` reads the aggregate MIDI state for
backward compatibility. To bind automation to one input, persist both the
human-readable name and the browser-provided ID:

.. code-block:: dsl

    midi(
        channel: 1,
        mode: midiMode.gateVelocity,
        name: "Launchkey Mini",
        id: "browser-port-id"
    )

An ``id`` match is authoritative. A name-only selector is allowed, but it must
match exactly one connected input. Otherwise, the source resolves to its
minimum. ``name`` and ``id`` are quoted, keyword-only fields, and ``id`` is
invalid without ``name``.

Examples
~~~~~~~~

.. code-block:: dsl

    search synth, filter

    // Basic velocity response
    noise(scaleX: midi(channel: 1)).write(o0)

    // Note pitch controls warp strength
    noise().warp(strength: midi(channel: 1, mode: midiMode.noteChange, min: 0, max: 1)).write(o0)

    // Velocity with fast decay for percussive response
    noise().bloom(intensity: midi(channel: 10, mode: midiMode.velocity, sensitivity: 5, min: 0, max: 1)).write(o0)

    // Sustained note control
    noise(scaleX: midi(channel: 2, mode: midiMode.gateVelocity, min: 0.1, max: 1)).write(o0)

audio() Function
----------------

The ``audio()`` function provides automation values from audio input analysis.

Syntax
~~~~~~

.. code-block:: dsl

    audio(band, min?, max?, channel: N, name: "...", id: "...")

Parameters
~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 15 20 15 50

   * - Parameter
     - Type
     - Default
     - Description
   * - ``band``
     - ``audioBand.*``
     - **required**
     - Frequency band to sample
   * - ``min``
     - number or automation
     - 0
     - Minimum normalized output (0–1)
   * - ``max``
     - number or automation
     - 1
     - Maximum normalized output (0–1)
   * - ``channel``
     - positive integer
     - none
     - One-based channel on a selected device. Keyword-only. Requires ``name``.
   * - ``name``
     - quoted string
     - none
     - Readable audio input name. Keyword-only. Requires ``channel``.
   * - ``id``
     - quoted string
     - none
     - Exact audio device ID. Keyword-only. Requires ``name``.

Audio Bands
~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Band
     - Description
   * - ``audioBand.low``
     - Low frequencies (~0-200Hz, bass/kick)
   * - ``audioBand.mid``
     - Mid frequencies (~200-2000Hz)
   * - ``audioBand.high``
     - High frequencies (~2000Hz+, hi-hats)
   * - ``audioBand.vol``
     - Overall volume (average of all bands)
   * - ``audioBand.raw``
     - Bipolar time-domain signal. Maps -1…1 onto the normalized 0…1 range.

Selecting an audio input
~~~~~~~~~~~~~~~~~~~~~~~~

``audio()`` reads the legacy aggregate analyser when no selector is present.
A selected source requires both a device ``name`` and a one-based ``channel``.
Include ``id`` when the browser exposes one. This distinguishes devices with
duplicate names:

.. code-block:: dsl

    audio(
        band: audioBand.raw,
        channel: 2,
        name: "USB Audio Interface",
        id: "browser-device-id"
    )

The ID is authoritative. Without an ID, the name must match exactly one
connected device. A disconnected, missing, or ambiguous selected source
resolves to ``min``. ``audioBand.raw`` also resolves to ``min`` until the host
has supplied a real time-domain sample.

Examples
~~~~~~~~

.. code-block:: dsl

    search synth, filter

    // React to bass
    noise(scaleX: audio(band: audioBand.low, min: 0.1, max: 0.5)).write(o0)

    // Hi-hat triggers brightness
    noise().bloom(intensity: audio(band: audioBand.high, min: 0, max: 1)).write(o0)

    // Overall volume controls speed
    noise().warp(speed: audio(band: audioBand.vol, min: 0.25, max: 0.75)).write(o0)

Combining with Other Automation
-------------------------------

``midi()``, ``audio()``, and ``osc()`` work alongside one another, and an
automation source can drive a numeric field on another automation descriptor.
Use ``let`` bindings to keep nested programs readable:

.. code-block:: dsl

    search synth

    let floor = audio(band: audioBand.low)
    let rate = midi(channel: 1, min: floor, max: 1)
    let carrier = osc(type: oscKind.sine, speed: rate)

    noise(scaleX: carrier).write(o0)

These numeric fields support nesting:

- ``osc()``: ``min``, ``max``, ``speed``, ``offset``, and ``seed``
- ``midi()``: ``min``, ``max``, and ``sensitivity``
- ``audio()``: ``min`` and ``max``

Enum selectors, device identity, and channel numbers remain literal. The compiler rejects cycles and nesting
deeper than eight descriptors. The evaluator integrates oscillator rate modulation over normalized time.
Seeking to the same time remains deterministic and does not depend on
previously rendered frames.

Host Integration
----------------

For application developers integrating MIDI/Audio input with the pipeline.

Setting Up External State
~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: javascript

    import { Pipeline, MidiState, AudioState } from '@noisemaker/shaders'

    // Create state objects
    const midiState = new MidiState()
    const audioState = new AudioState()

    // Attach to pipeline
    pipeline.setMidiState(midiState)
    pipeline.setAudioState(audioState)

Updating MIDI State
~~~~~~~~~~~~~~~~~~~

.. code-block:: javascript

    // Handle MIDI note on
    midiState.handleMessage([0x90 | channel, note, velocity])

    // Handle MIDI note off
    midiState.handleMessage([0x80 | channel, note, 0])

    // Or set channel state directly
    midiState.getChannel(1).key = 60
    midiState.getChannel(1).velocity = 100
    midiState.getChannel(1).gate = 1
    midiState.getChannel(1).time = Date.now()

For per-input selectors, register the browser identity. Pass it with each
message. The root state still receives the message for unselected ``midi()``
calls, while the registered port keeps isolated channel state:

.. code-block:: javascript

    const port = { id: input.id, name: input.name }
    midiState.registerPort(port)
    midiState.handleMessage(message.data, port)
    const ports = midiState.getPorts()

Updating Audio State
~~~~~~~~~~~~~~~~~~~~

.. code-block:: javascript

    // From Web Audio API analyser
    const analyser = audioContext.createAnalyser()
    const fftData = new Uint8Array(analyser.frequencyBinCount)

    function updateAudio() {
        analyser.getByteFrequencyData(fftData)

        // Sample specific frequency bins
        audioState.low = fftData[0] / 255
        audioState.mid = fftData[2] / 255
        audioState.high = fftData[4] / 255
        audioState.vol = (audioState.low + audioState.mid + audioState.high) / 3

        requestAnimationFrame(updateAudio)
    }

For selected-device capture:

1. Register each device.
2. Publish analyzed values per channel.
3. Supply ``raw`` for ``audioBand.raw``.

.. code-block:: javascript

    audioState.registerDevice({
        id: device.deviceId,
        name: device.label,
        channelCount: 2
    })
    audioState.setChannelValues(device.deviceId, 2, {
        low: 0.25,
        mid: 0.1,
        high: 0.05,
        vol: 0.14,
        raw: -0.2
    })
    const devices = audioState.getDevices()

MidiState API
~~~~~~~~~~~~~

.. code-block:: javascript

    class MidiState {
        channels: Record<number, MidiChannelState>  // keys 1-16

        getChannel(n: number): MidiChannelState  // Get channel 1-16
        handleMessage(data: Uint8Array, port?: { id, name }): void
        registerPort({ id, name }): MidiState | null
        disconnectPort(id: string): void
        getPortState({ id?, name? }): MidiState | null
        getPorts(): Array<{ id, name, connected }>
    }

    class MidiChannelState {
        key: number       // Current note (0-127)
        velocity: number  // Current velocity (0-127)
        gate: number      // 1 if note on, 0 if off
        time: number      // Timestamp of last note on (Date.now())
    }

AudioState API
~~~~~~~~~~~~~~

.. code-block:: javascript

    class AudioState {
        low: number   // Low frequency band (0-1)
        mid: number   // Mid frequency band (0-1)
        high: number  // High frequency band (0-1)
        vol: number   // Overall volume (0-1)
        raw: number   // Bipolar time-domain value (-1 to 1)
        rawReady: boolean
        fft: Float32Array       // 16 normalized frequency bins
        spectrum: Float32Array  // 128 normalized frequency bins
        waveform: Float32Array  // 128 normalized time-domain samples

        setBands(low, mid, high): void
        setRaw(value): void
        registerDevice({ id, name, channelCount }): object | null
        setChannelValues(id, channel, { low?, mid?, high?, vol?, raw? }): boolean
        disconnectDevice(id: string): void
        getDeviceChannelState({ id?, name?, channel }): AudioState | null
        getDevices(): Array<{ id, name, connected, channelCount }>
    }

Technical Notes
---------------

- MIDI channels are 1-indexed (1-16) matching standard MIDI conventions
- MIDI and audio ``min``/``max`` values are normalized percentages of the
  receiving effect parameter's range
- Audio band values use the normalized 0–1 range. The ``audioBand.raw`` band
  first maps its bipolar -1…1 signal onto that range.
- The runtime calculates trigger decay with ``Date.now()`` for frame-independent animation.
- The runtime clamps values to the min/max range.
