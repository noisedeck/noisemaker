MIDI & Audio Input
==================

This guide covers the ``midi()`` and ``audio()`` functions for animating shader parameters with real-time external input.

Using in the Demo
-----------------

The shader demo includes MIDI and Audio toggle buttons in the toolbar. Click **midi** or **audio** to enable external input:

- **MIDI**: Click the ``midi`` button to enable Web MIDI API access. Any connected MIDI controllers will automatically be detected.
- **Audio**: Click the ``audio`` button to enable microphone input. Your browser will request permission to access the microphone.

Once enabled, you can use ``midi()`` and ``audio()`` in your DSL programs:

.. code-block:: dsl

    search synth
    // React to MIDI velocity and audio bass at the same time
    noise(
        scale: midi(channel: 1, min: 0.1, max: 1),
        speed: audio(band: audioBand.low, min: 0.25, max: 1)
    ).write(o0)
    render(o0)

Quick Start
-----------

MIDI Input
~~~~~~~~~~

Control a parameter with MIDI velocity from channel 1:

.. code-block:: dsl

    search synth
    noise(scale: midi(channel: 1, min: 0.1, max: 1)).write(o0)

Audio Input
~~~~~~~~~~~

React to bass frequencies in the audio input:

.. code-block:: dsl

    search synth
    noise(scale: audio(band: audioBand.low, min: 0.2, max: 1)).write(o0)

``min`` and ``max`` are fractions of the parameter's own range, each in
``0..1`` — here the bass level sweeps ``scale`` across the upper four fifths
of its range. See :ref:`shader-language` for the rule.

midi() Function
---------------

The ``midi()`` function provides automation values from MIDI controller input.

Syntax
~~~~~~

.. code-block:: dsl

    midi(channel, mode?, min?, max?, sensitivity?)

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
     - number
     - 0
     - Minimum output value
   * - ``max``
     - number
     - 1
     - Maximum output value
   * - ``sensitivity``
     - number
     - 1
     - Trigger falloff rate (higher = faster decay)

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

Examples
~~~~~~~~

.. code-block:: dsl

    // Basic velocity response
    noise(scale: midi(channel: 1)).write(o0)

    // Note pitch controls rotation
    warp(rotation: midi(channel: 1, mode: midiMode.noteChange))

    // Velocity with fast decay for percussive response
    bloom(strength: midi(channel: 10, mode: midiMode.velocity, sensitivity: 5, min: 0, max: 0.5))

    // Sustained note control
    noise(scale: midi(channel: 2, mode: midiMode.gateVelocity, min: 0.1, max: 1))

audio() Function
----------------

The ``audio()`` function provides automation values from audio input analysis.

Syntax
~~~~~~

.. code-block:: dsl

    audio(band, min?, max?)

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
     - number
     - 0
     - Minimum output value
   * - ``max``
     - number
     - 1
     - Maximum output value

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

Examples
~~~~~~~~

.. code-block:: dsl

    // React to bass
    noise(scale: audio(band: audioBand.low, min: 0.2, max: 1)).write(o0)

    // Hi-hat triggers brightness
    bloom(strength: audio(band: audioBand.high, min: 0, max: 0.5))

    // Overall volume controls speed
    warp(speed: audio(band: audioBand.vol, min: 0.25, max: 0.75))

Combining with Other Automation
-------------------------------

``midi()`` and ``audio()`` work alongside ``osc()`` for oscillator-based animation:

.. code-block:: dsl

    search synth
    // MIDI controls scale, audio controls speed, oscillator controls rotation
    noise(
        scale: midi(channel: 1, min: 0.1, max: 1),
        speed: audio(band: audioBand.low, min: 0.25, max: 1)
    ).warp(
        rotation: osc(type: oscKind.sine)
    ).write(o0)

All three descriptors also drive :ref:`scene graph <shader-scene>` nodes:
``midi()`` and ``audio()`` are accepted in place of a number in a node's
``pos``, ``rot`` and ``scale`` components and in a light's ``intensity`` (not
in a camera or in a light's position), resolved from the same ``MidiState``
and ``AudioState`` as effect uniforms, so 3D motion and 2D automation respond
to one performance. A scene ``rot`` component spans ``0..360`` degrees;
``pos``, ``scale`` and ``intensity`` receive the ``0..1`` value directly, and
a ``min`` or ``max`` outside ``0..1`` is a compile error in a scene.

.. code-block:: dsl

    light(type: "point", intensity: midi(channel: 1, mode: midiMode.velocity))
    group(pos: [0, 1, 0], mesh("sphere", pos: [0, audio(band: audioBand.low), 0]))

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

MidiState API
~~~~~~~~~~~~~

.. code-block:: javascript

    class MidiState {
        channels: MidiChannelState[]  // 16 channels

        getChannel(n: number): MidiChannelState  // Get channel 1-16
        handleMessage(data: number[]): void      // Process raw MIDI message
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
        fft: Float32Array | null  // Raw FFT data (optional)
        smoothing: number         // Smoothing factor (0-1)
    }

Technical Notes
---------------

- MIDI channels are 1-indexed (1-16) matching standard MIDI conventions
- Audio values are normalized to 0-1 range before mapping to min/max
- Trigger decay is calculated in real-time using ``Date.now()`` for frame-independent animation
- Values are clamped to the min/max range
