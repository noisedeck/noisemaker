MIDI & Audio Input
==================

This guide covers the ``midi()`` and ``audio()`` functions for animating shader parameters with real-time external input.

Using in the Demo
-----------------

The shader demo includes MIDI and Audio toggle buttons in the toolbar. It also
attempts to enable the relevant manager when applying a program that uses live
input. Click **midi** or **audio** to control access:

- **MIDI**: Click the ``midi`` button to enable Web MIDI API access. The demo will automatically detect connected MIDI controllers.
- **Audio**: Click the ``audio`` button to enable microphone input. Your browser will request permission to access the microphone.

The demo's audio toggle supplies the aggregate frequency analyser. Selecting
individual audio devices/channels and supplying ``audioBand.raw`` require a
host with those capture paths, such as Noisedeck. The language does not open
devices or create operating-system audio ports by itself.

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

    midi(channel, mode?, min?, max?, sensitivity?, cc: N, nrpn: N, name: "...", id: "...")
    midi(zone: midiZone.lower, members: N, mode: midiMode.pressure, name: "...", id: "...")

``cc``, ``nrpn``, ``zone``, ``members``, ``name``, and ``id`` are keyword-only.
Use either ``channel`` or ``zone``. ``members`` is optional and requires
``zone``; ``nrpn`` is required only for ``midiMode.nrpn``. Existing positional
arguments retain their order.

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
     - required without ``zone``
     - Fixed MIDI channel to listen to. Cannot be combined with ``zone``.
   * - ``zone``
     - ``midiZone.*``
     - none
     - ``lower`` or ``upper`` MPE zone. Selects the newest held note's member
       channel instead of a fixed channel.
   * - ``members``
     - int (1-15)
     - automatic
     - Manual member-channel count for the selected zone. Omit to follow
       received MPE zone configuration, or use 15 until configured.
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
   * - ``cc``
     - integer
     - 1
     - Controller number for CC modes. Keyword-only. 0–127 for ``cc``;
       0–31 for the most significant controller of a ``cc14`` pair.
   * - ``nrpn``
     - int (0-16382)
     - required for NRPN mode
     - NRPN parameter address. Address 16383 is reserved for null selection.
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
   * - ``midiMode.cc``
     - Last 7-bit value of the selected controller, normalized from 0–127
   * - ``midiMode.cc14``
     - Last paired 14-bit controller value, normalized from 0–16383
   * - ``midiMode.nrpn``
     - Last value of the selected NRPN parameter, normalized from 0–16383
   * - ``midiMode.pitchBend``
     - 14-bit pitch-bend position divided by 16383; neutral is 8192
   * - ``midiMode.pressure``
     - Channel pressure divided by 127
   * - ``midiMode.polyPressure``
     - Polyphonic key pressure divided by 127, for the selected note key

Numeric mode values 0–6 retain their existing meanings. The added modes are
``nrpn: 7``, ``pitchBend: 8``, ``pressure: 9``, and ``polyPressure: 10``.
Use the enum names in programs for readability.

Control Change (CC)
~~~~~~~~~~~~~~~~~~~

Use CC modes for knobs and faders. Select the device, MIDI channel, controller,
and resolution independently:

.. code-block:: dsl

    search synth
    let knob = midi(channel: 1, mode: midiMode.cc, cc: 74,
        name: "Controller", id: "browser-port-id")
    let fader = midi(channel: 2, mode: midiMode.cc14, cc: 1,
        name: "Controller", id: "browser-port-id")
    noise(scaleX: knob, speed: fader).write(o0)

For ``midiMode.cc14``, ``cc: N`` selects the most significant byte (MSB)
controller, and controller ``N + 32`` supplies the least significant byte
(LSB). For example, ``cc: 1`` pairs controllers 1 and 33. The normalized value
is ``(MSB * 128 + LSB) / 16383``. This follows the
`MIDI 1.0 Control Change pairing convention <https://midi.org/midi-1-0-control-change-messages>`_.
Use the separate NRPN and pitch-bend modes for those message formats.

Each device and MIDI channel retains its own bytes. Either byte updates the
value immediately using the retained other byte; a byte not yet received is
zero. Messages from different devices or channels never form a pair. An
unselected aggregate source uses the complete value from the input that most
recently updated that controller pair.

Updating on either byte also supports sources that omit unchanged bytes. If an
MSB arrives before its new LSB, the intermediate value still contains the old
LSB and can produce a brief step. The runtime does not wait for an LSB or apply
a pairing timeout. Hosts normally sample the latest value once per frame.

CC values hold until another matching message or a state reset/disconnection.
Notes and note-off messages do not change them, and ``sensitivity`` has no
effect on CC modes. Initially the value resolves to ``min``; controller
resets can set protocol defaults without receiving that controller directly
(for example, CC11 becomes 127). MPE zone changes also initialize CC74 to 64.
Invalid CC numbers or CC-mode channels produce diagnostics and resolve to
``min``. Use channels 1–16; the older note modes retain their legacy channel
handling.

NRPN parameters
~~~~~~~~~~~~~~~

NRPN uses CC99/98 to select a 14-bit parameter address, followed by Data Entry
CC6/38 for its value. Select the address with ``nrpn``:

.. code-block:: dsl

    search synth
    let parameter = midi(channel: 3, mode: midiMode.nrpn, nrpn: 4097,
        name: "Controller", id: "browser-port-id")
    noise(scaleX: parameter).write(o0)

Selectors and stored values are isolated by physical port, MIDI channel, and
parameter address. Both selector bytes must arrive before the first write;
later changes to one selector byte retain the other. Selecting another
parameter does not erase the previous value. CC6 sets the coarse byte and
clears that parameter's fine byte; CC38 updates its fine byte using its own
retained coarse byte. This differs from the hold-other-byte policy for
ordinary ``cc14``. The normalized value is ``(MSB * 128 + LSB) / 16383``.

CC101/100 switch Data Entry to RPN, so an RPN transaction cannot overwrite
the previously selected NRPN. Null address 16383 disables parameter writes.
CC96/97 increment/decrement the selected NRPN by one, saturating at 0 and
16383 and ignoring the message's value byte. This is the scalar adapter's
step policy: the MIDI specification leaves NRPN step units to the device
manufacturer. See the `MIDI 1.0 addenda <https://midi.org/midi-1-0-addenda>`_
(RP-018).

Before a matching parameter value arrives, the binding returns ``min``.
Values survive note-off, selector changes, and Reset All Controllers (CC121).
CC121 nulls parameter selectors, centers pitch bend, and clears pressure,
while preserving Sound Controllers 70–79, including MPE CC74. Full state
reset or port disconnection clears stored parameter values. See
`Reset All Controllers <https://midi.org/response-to-reset-all-controllers>`_.

``midiMode.cc14`` with ``cc: 6`` still reads the ordinary Data Entry byte
pair without regard to the selected parameter. Use ``midiMode.nrpn`` when
the parameter address matters.

MPE and pressure
~~~~~~~~~~~~~~~~

MPE assigns notes to member channels. Use ``zone: midiZone.lower`` or
``zone: midiZone.upper`` to follow a held note as the controller allocates
channels. The lower zone's manager is channel 1 and its members ascend from
channel 2; the upper manager is channel 16 and its members descend from
channel 15. Device identity remains independent of zone selection.

.. code-block:: dsl

    search synth
    let pressure = midi(zone: midiZone.lower, mode: midiMode.pressure,
        name: "MPE Controller", id: "browser-port-id")
    let bend = midi(zone: midiZone.lower, mode: midiMode.pitchBend,
        name: "MPE Controller", id: "browser-port-id")
    let slide = midi(zone: midiZone.lower, mode: midiMode.cc, cc: 74,
        name: "MPE Controller", id: "browser-port-id")
    noise(scaleX: pressure, scaleY: bend, speed: slide).write(o0)

Without ``members``, each port follows received MPE Configuration Messages:
RPN 6 (CC101=0, CC100=6), followed by CC6 count 0–15 on manager channel 1 or
16. CC38 has no effect on this configuration. Count 0 disables that zone;
the newest configuration takes overlapping members from the other zone.
Until configuration is received, a binding uses all 15 possible members of
its selected zone. An explicit ``members: 1`` through ``members: 15`` overrides
discovery for that binding. The enum values are ``midiZone.lower = 0`` and
``midiZone.upper = 1``. See the
`MPE specification <https://midi.org/midi-polyphonic-expression-mpe-specification-adopted>`_.

When zone configuration changes a channel's membership or manager role, the
runtime clears its held notes and resets expression. It initializes CC74 to
64 as a neutral timbre default for this adapter. This is separate from
CC121, which preserves the existing CC74 value. Configuration therefore can
end the currently selected gesture; later Note On messages select new notes.

Each binding returns one scalar. It selects the newest held note by Note On
arrival order across eligible members and ports. Controller messages do not
change note priority. Releasing that note immediately falls back to the
newest remaining held note; no held note returns ``min`` in every mode.
Sustain does not retain released notes for this selection. Distinct keys on
one member remain tracked; a repeated Note On for the same port/channel/key
replaces that key's previous note. An old key's Note Off cannot release a
different key that later reused the member channel.

The selected note supplies note number, velocity, and trigger time to note
modes, and its member supplies CC, NRPN, bend, and pressure. Expression
received before Note On remains available. Polyphonic pressure uses that
note's key. Without a zone, ``polyPressure`` uses the fixed channel's latest
note key; ``pitchBend`` and ``pressure`` read the fixed channel directly.

These are raw member gestures. Pitch bend is a normalized controller
position, not a semitone value; RPN 0 pitch sensitivity does not rescale it.
The adapter does not combine manager and member expression or synthesize a
polyphonic instrument. Read manager controls separately with ``channel: 1``
or ``channel: 16``. On a connected fixed channel, bend starts at its neutral
8192/16383 position and pressure starts at zero. ``sensitivity`` affects
only the existing trigger modes.

Protocol boundaries
~~~~~~~~~~~~~~~~~~~

MIDI 2.0 controllers and general RPN parameter automation are not exposed.
MPE zone configuration uses RPN 6 internally.

Choose CC mode according to the controller's transmitted messages. Encoder
sensitivity settings described as high resolution do not by themselves prove
that the device sends paired 14-bit CC. These modes interpret absolute values;
they do not accumulate relative encoder increments.

Trigger Modes
~~~~~~~~~~~~~

The ``triggerNote`` and ``velocity`` modes include automatic decay from the note-on event. The ``sensitivity`` parameter controls how quickly the value fades:

- ``sensitivity: 1`` - Decays over ~1 second
- ``sensitivity: 5`` - Decays over ~200ms
- ``sensitivity: 0.5`` - Decays over ~2 seconds

Both modes return to ``min`` when the channel's gate closes, even if the decay
has not finished. Fixed-channel note modes summarize that channel's most
recent note state. MPE zone bindings use the held-note selection described
above. Neither creates a separate automation output for every held key.

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

Device selection and MIDI channel selection are independent: several bindings
can listen to different channels on one input, or the same channel number on
different inputs. IDs are opaque host-provided values; copy them from the
host's device selection UI rather than inventing or deriving them from names.

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

``channel``, ``name``, and ``id`` are optional, keyword-only arguments.

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
     - integer (1–32)
     - none
     - One-based capture channel. Without ``name``, selects a channel on the
       default device. The channel must actually be supplied by the host.
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
     - Low-frequency level supplied by the host (bass/kick)
   * - ``audioBand.mid``
     - Mid-frequency level supplied by the host
   * - ``audioBand.high``
     - High-frequency level supplied by the host (for example, hi-hats)
   * - ``audioBand.vol``
     - Overall level supplied by the host
   * - ``audioBand.raw``
     - Bipolar time-domain signal. Maps -1…1 onto the normalized 0…1 range.

Frequency boundaries depend on the host's analyser, FFT size, and sample rate.
``band`` chooses an analysis value; it does not select an input channel.

Selecting an audio input
~~~~~~~~~~~~~~~~~~~~~~~~

``audio()`` reads the legacy aggregate analyser when no selector is present.
Use ``channel`` alone to select one channel on the default input. For a named
device, supply both ``name`` and ``channel``; include ``id`` when the host
exposes one. This distinguishes devices with duplicate names:

.. code-block:: dsl

    audio(
        band: audioBand.raw,
        channel: 2,
        name: "USB Audio Interface",
        id: "browser-device-id"
    )

The ID is authoritative. Without an ID, the name must match exactly one
connected device in the complete device inventory, including devices that are
not currently being captured. A disconnected, missing, ambiguous, or
unavailable channel resolves to ``min`` without falling back to another input.
``audioBand.raw`` also resolves to ``min`` until the host has supplied a real
time-domain sample. Once ready, raw silence (zero) maps to the midpoint between
``min`` and ``max``.

Device and channel are separate dimensions. These bindings select two channels
from one device, a channel from another device, and a default-device channel:

.. code-block:: dsl

    search synth
    let left = audio(audioBand.low, channel: 1,
        name: "Interface A", id: "device-a")
    let right = audio(audioBand.high, channel: 2,
        name: "Interface A", id: "device-a")
    let second = audio(audioBand.vol, channel: 1,
        name: "Interface B", id: "device-b")
    let defaultRight = audio(audioBand.vol, channel: 2)
    noise(scaleX: left, scaleY: right, speed: second, loopScale: defaultRight).write(o0)

Capture capabilities and channel limits
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The language accepts channels 1–32. This is the Web Audio processing ceiling,
not a promise that a physical input exposes 32 capture channels. The host must
use the delivered stream's channel count, and expose only channels it can
actually process. Noisedeck shows that count after capture or a device probe;
unknown counts remain marked unknown, and unavailable authored selections
remain visible as unavailable.

The Chromium 152 Linux PulseAudio and ALSA input implementations request
**two channels per device**. The PulseAudio compatibility path also applies
when PipeWire provides that service. Chromium's shared native input manager
additionally enforces a three-channel stream guard and a browser-wide limit
of 16 native input streams. Neither limit guarantees a particular number of
simultaneously usable devices. See the pinned
`PulseAudio input implementation <https://github.com/chromium/chromium/blob/152.0.7977.82/media/audio/pulse/audio_manager_pulse.cc#L135>`_,
`ALSA input implementation <https://github.com/chromium/chromium/blob/152.0.7977.82/media/audio/alsa/audio_manager_alsa.cc#L91>`_,
`native capture limits <https://github.com/chromium/chromium/blob/152.0.7977.82/media/audio/audio_manager_base.cc#L44>`_,
and `Web Audio channel limit <https://github.com/chromium/chromium/blob/152.0.7977.82/third_party/blink/renderer/modules/webaudio/base_audio_context.h#L353>`_.

A 240-channel mixer therefore cannot expose all of its inputs through this
capture path. Higher channel counts require a different capture integration.
Repeated requests for the same physical device reuse Chromium's native source;
they do not create independently patchable virtual input ports. See
`Chromium device reuse <https://github.com/chromium/chromium/blob/148.0.7778.180/content/browser/renderer_host/media/media_stream_manager.cc#L3650>`_.
Other hosts and backends must report their own delivered capabilities.

Validating a control-voltage input
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Noisedeck's raw capture uses the signed mean of each audio render quantum per channel.
Browser tests with generated constant signals verify that this path preserves
positive and negative offsets. They do not certify DC preservation through an
operating-system virtual device or a physical interface.

Validate the exact capture route before relying on it for control voltages:

1. Send a constant offset and observe the selected ``audioBand.raw`` value for
   several seconds. It should hold steady; decay toward zero indicates that
   the route is filtering out DC.
2. Repeat with the opposite polarity, then a very slow bipolar LFO to check
   that its shape and sign survive.
3. Repeat for the selected channels on every device, with simultaneous inputs
   active. Record the browser/desktop version, OS, audio backend, delivered
   channel counts, and processing settings.

When testing with VCV Rack's Audio-2 module, disable **DC blocker** in the
module's context menu. It is enabled by default and applies a 10 Hz high-pass
filter, which removes a constant offset before the virtual audio device
receives it. See the
`Rack Audio implementation <https://github.com/VCVRack/Rack/blob/v2/src/core/Audio.cpp>`_.

Check source and virtual-device volume controls when comparing amplitudes.
For example, BlackHole 0.5.0 applies its master volume to captured samples.
Record that gain independently of the measured signal, or use a known unity
gain, before comparing expected DC levels and LFO amplitudes. See the
`BlackHole capture implementation <https://github.com/ExistentialAudio/BlackHole/blob/v0.5.0/BlackHole/BlackHole.c#L4260-L4286>`_.

Digital routing from an application such as VCV Rack avoids an analog
converter, but the complete route still needs measurement. Physical modular
signals require an interface that passes DC. Conversion between volts and
normalized samples depends on the source and interface; ``audioBand.raw`` is
not a voltage measurement.

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

Enum selectors, channel numbers, and MIDI ``cc``, ``nrpn``, and ``members`` are static: they accept
literals or ``let`` aliases that resolve to valid literals, not live
automation. Device names and IDs must remain quoted string literals. For
example, ``let controller = 74`` can be used as ``cc: controller``.
The compiler rejects cycles and supports up to eight
nested levels beneath the outer descriptor. The evaluator integrates
oscillator rate modulation over normalized time.
This integration does not depend on previously rendered frames. Live MIDI and
audio still use the current input state, and note decay uses wall-clock time;
seeking does not replay an earlier external signal.

Nested results map onto the receiving field's range: 0–1 for ``min``/``max``,
0–10 for MIDI ``sensitivity``, −20–20 for oscillator ``speed``, −1–1 for
``offset``, and 1–9999 for ``seed``. A literal ``sensitivity: 1`` is a direct
value; an automation result of 1 feeding ``sensitivity`` maps to 10.

Host Integration
----------------

For application developers integrating MIDI/Audio input with the pipeline.
Capture and device discovery belong to the host; writing a DSL selector alone
does not create a stream. See :doc:`integration` for renderer setup.

Setting Up External State
~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: javascript

    // With an initialized CanvasRenderer, create and attach shared state.
    const midiState = renderer.setMidiState()
    const audioState = renderer.setAudioState()

Updating MIDI State
~~~~~~~~~~~~~~~~~~~

.. code-block:: javascript

    // DSL/API channels are 1–16; the wire status nibble is 0–15.
    const midiChannel = 1
    const statusChannel = midiChannel - 1

    // Handle MIDI note on and note off.
    midiState.handleMessage([0x90 | statusChannel, 60, 100])
    midiState.handleMessage([0x80 | statusChannel, 60, 0])

    // Controller 74, 7-bit value 100.
    midiState.handleMessage([0xb0 | statusChannel, 74, 100])

    // A 14-bit pair: controller 1 = MSB, controller 33 = LSB.
    midiState.handleMessage([0xb0 | statusChannel, 1, 64])
    midiState.handleMessage([0xb0 | statusChannel, 33, 1]) // 8193 / 16383

    // Legacy fixed-channel aggregate state can also be updated directly.
    midiState.getChannel(1).noteOn(60, 100)

Direct mutation of a root channel does not identify a physical source and
does not feed MPE zone selection. Use ``handleMessage(data, port)`` for normal
host integration, including MPE, so aggregate and per-port state stay aligned.

For per-input selectors, supply the full browser inventory before opening
ports. Register each port after it opens successfully and pass its identity
with each message. The root state still receives the message for unselected
``midi()`` calls, while the registered port keeps isolated channel state:

.. code-block:: javascript

    midiState.setPortInventory(Array.from(access.inputs.values(), input => ({
        id: input.id, name: input.name, connected: input.state !== 'disconnected'
    })))

    await input.open()
    const port = { id: input.id, name: input.name }
    midiState.registerPort(port)
    midiState.handleMessage(message.data, port)
    const ports = midiState.getPorts()

Inventory must include physically connected inputs whose opens are pending
or failed, so name-only selection can detect ambiguity. These inputs have no
live state until registered; exact selectors remain at ``min``. Refresh the
inventory on device changes and call ``disconnectPort(input.id)`` when an
operational port disconnects. Install lifecycle handling before awaiting
opens so a disconnect during startup cannot leave stale state.

``MidiState.getPorts()`` returns registered ports, including their disconnected
history. ``MidiInputManager.getPorts()`` returns the complete physical
inventory, including failed opens and retained disconnected entries. Its
``connected`` flag describes physical presence, not successful opening.

Feed each received message once to the root state with its identity; do not
also feed it directly to the isolated port state. This keeps aggregate CC14
pairing consistent with per-port values.

The same message entry point decodes NRPN, bend, both pressure formats, and
MPE configuration. For example, after registering ``port``:

.. code-block:: javascript

    // Channel 3: NRPN address 4097, value 8193.
    for (const [controller, value] of [[99, 32], [98, 1], [6, 64], [38, 1]]) {
        midiState.handleMessage([0xb2, controller, value], port)
    }

    // Lower MPE zone with eight members (channels 2-9).
    for (const [controller, value] of [[101, 0], [100, 6], [6, 8]]) {
        midiState.handleMessage([0xb0, controller, value], port)
    }
    midiState.handleMessage([0xe1, 0, 64], port)   // Member 2: neutral bend.
    midiState.handleMessage([0xd1, 100], port)     // Channel pressure has two bytes.
    midiState.handleMessage([0xb1, 74, 96], port)  // Member slide before Note On.
    midiState.handleMessage([0x91, 60, 100], port)
    midiState.handleMessage([0xa1, 60, 80], port)  // Key pressure for note 60.

Updating Audio State
~~~~~~~~~~~~~~~~~~~~

.. code-block:: javascript

    // The host has connected its aggregate source to this analyser.
    function updateAudio() {
        audioState.updateFromAnalyser(analyser)
        requestAnimationFrame(updateAudio)
    }

``updateFromAnalyser()`` updates the bands, overall level, and 16-bin ``fft``.
Supply full ``spectrum`` and ``waveform`` data through ``setSpectrum()`` and
``setWaveform()`` when needed. Neither waveform data nor direct assignment to
``raw`` marks raw input ready; use ``setRaw()`` for that.

For selected-device capture:

1. Supply the complete discovered device inventory for name resolution.
2. Open each requested device and inspect the delivered channel count.
3. Register each captured device and publish analyzed values per channel.
4. Supply bipolar ``raw`` samples for ``audioBand.raw``.

.. code-block:: javascript

    audioState.setDeviceInventory(discoveredDevices.map(device => ({
        id: device.deviceId, name: device.label, connected: true
    })))
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

The example registers a stream that actually delivers two channels. Do not
substitute the mixer's advertised channel count. Split the captured stream
before analyzing individual channels. ``registerDevice()`` only registers
state; it does not capture audio.

Default-device channels have separate state from the legacy aggregate:

.. code-block:: javascript

    audioState.registerDefaultChannels(2) // Actual delivered count.
    const right = audioState.getDefaultChannelState(2)
    right.updateFromAnalyser(rightChannelAnalyser)
    right.setRaw(-0.2)

    // When the raw processor stops or loses its input:
    right.setRawUnavailable()
    audioState.setDeviceRawUnavailable(device.deviceId)

    // When captures end:
    audioState.disconnectDefaultInput()
    audioState.disconnectDevice(device.deviceId)

``reset()`` clears values and raw readiness while retaining device identities
and connection flags. Use the disconnect methods when a capture ends.
``resetAggregate()`` clears only the aggregate bands, raw readiness, sample
arrays, and smoothing history. Use it when stopping or replacing the legacy
source while selected-device and default-channel captures remain active.

Refresh the full inventory on device changes. Use
``pipeline.getAudioInputRequirements()`` after compilation to collect selected
device/channel demands, including static aliases and nested automation. It
returns ``{ needsLegacy, needsLegacyRaw, selected }``; selected entries contain
``{ name, id, channel, needsRaw }``. Entries without an identity select default
device channels. The host can share one capture among all bindings for a device.

MidiState API
~~~~~~~~~~~~~

.. code-block:: javascript

    class MidiState {
        channels: Record<number, MidiChannelState>  // keys 1-16
        mpeZones: { lower: number | null, upper: number | null }  // per-port discovery

        getChannel(n: number): MidiChannelState  // Get channel 1-16
        handleMessage(data: Uint8Array, port?: { id, name }): void
        setPortInventory(ports: Array<{ id, name, connected? }>): void
        registerPort({ id, name }): MidiState | null
        disconnectPort(id: string): void
        getPortState({ id?, name? }): MidiState | null
        getPorts(): Array<{ id, name, connected }>
        getZoneVoice({ zone, members? }): object | null  // newest held member note
        reset(): void
    }

    class MidiChannelState {
        key: number       // Current note (0-127)
        velocity: number  // Current velocity (0-127)
        gate: number      // 1 if note on, 0 if off
        time: number      // Timestamp of last note on (Date.now())
        cc: Uint8Array    // 128 retained 7-bit controller values
        cc14: Uint16Array // 32 retained paired 14-bit values
        pitchBend: number // Unsigned 14-bit position; neutral 8192
        pressure: number // Channel pressure (0-127)
        polyPressure: Uint8Array // Pressure for each of 128 keys
        nrpn: Map<number, number> // Parameter address to unsigned 14-bit value

        noteOn(key: number, velocity: number): void
        noteOff(key?: number): void
        controlChange(controller: number, value: number): void
        reset(): void
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
        setRawUnavailable(): void
        updateFromAnalyser(analyser, smoothing?): void
        setSpectrum(frequencyData: Uint8Array): void
        setWaveform(timeDomainData: Uint8Array): void
        setDeviceInventory(devices: Array<{ id, name, connected? }>): void
        registerDevice({ id, name, channelCount }): object | null
        setChannelValues(id, channel, { low?, mid?, high?, vol?, raw? }): boolean
        disconnectDevice(id: string): void
        setDeviceRawUnavailable(id: string): void
        getDeviceChannelState({ id?, name?, channel }): AudioState | null
        getDevices(): Array<{ id, name, connected, channelCount }>
        registerDefaultChannels(channelCount: number): Map<number, AudioState> | null
        getDefaultChannelState(channel: number): AudioState | null
        disconnectDefaultInput(): void
        resetAggregate(): void
        reset(): void
    }

Technical Notes
---------------

- MIDI channels are 1-indexed (1-16) matching standard MIDI conventions
- MIDI and audio ``min``/``max`` values are normalized percentages of the
  receiving effect parameter's range. Bounds are clamped to 0–1; ``max: 10``
  does not request an absolute effect value of 10.
- Audio band values use the normalized 0–1 range. The ``audioBand.raw`` band
  first maps its bipolar -1…1 signal onto that range.
- The runtime calculates trigger decay with ``Date.now()`` for frame-independent animation.
- A nested automation result maps onto the receiving numeric field's declared
  range, just as it maps onto an effect parameter's range.
