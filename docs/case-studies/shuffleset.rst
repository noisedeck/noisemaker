Shuffleset
==========

`shuffleset.stream <https://shuffleset.stream/>`_

Shuffleset is a self-hosted media streaming platform. We added an audio-reactive shader visualizer to it by wiring the Web Audio API into Noisemaker's audio state system. The integration is 120 lines.

The browser's ``AnalyserNode`` extracts frequency and waveform data from whatever's playing. Each frame, the integration sends that data to Noisemaker's ``AudioState`` object. ``AudioState`` exposes it as shader uniforms:

.. code-block:: javascript

    connectAudio(audioElement) {
        const ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256

        const source = ctx.createMediaElementSource(audioElement)
        source.connect(analyser)
        analyser.connect(ctx.destination)

        this._audioState = this.setAudioState()
        this._audioUpdate()  // start the RAF loop
    }

    _audioUpdate() {
        this._audioState.updateFromAnalyser(this._audioAnalyser, 8)
        this._audioAnalyser.getByteFrequencyData(this._fftData)
        this._audioState.setSpectrum(this._fftData)
        this._audioAnalyser.getByteTimeDomainData(this._timeDomainData)
        this._audioState.setWaveform(this._timeDomainData)
        requestAnimationFrame(() => this._audioUpdate())
    }

That's the entire bridge. Audio flows through the analyser without interrupting playback. The per-frame update pushes 128 frequency bins and 256 time-domain samples into the pipeline, where any DSL program can reference them.

The visualizer itself is a hardcoded DSL string:

.. code-block:: text

    scope(color: #ffffffff, thickness: 3, gain: 1)
      .feedback(blendMode: lighten, mix: 42.31, scaleAmt: 112.6)
      .chromaticAberration(aberration: 25)
      .bloom(taps: 15)
      .vignette()
      .write(o0)
    render(o0)

The ``scope()`` effect reads audio state internally. Everything after it is standard filter chaining. Changing the visualizer requires changing one string.
