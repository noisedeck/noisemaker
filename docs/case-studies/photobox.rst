Photobox
========

`photobox.noisefactor.io <https://photobox.noisefactor.io/>`_

Photobox is a Photo Booth clone that runs in the browser. We built it in four hours with Claude. It captures your camera feed, runs it through GPU shader effects in real-time, and lets you take photos and record video. It provides 18 effects across two tabs, a 3x3 live preview grid, and a persistent gallery.

The camera feed enters the shader pipeline through an external texture. The browser's ``getUserMedia`` API gives you a ``<video>`` element. Noisemaker's ``CanvasRenderer`` can accept any image source as an external texture. The bridge between them is one call per frame:

.. code-block:: javascript

    this._renderer.updateTextureFromSource('imageTex_step_0', this._videoSource)

That's it. The render loop calls this in ``requestAnimationFrame``, uploading the current video frame to the GPU. The DSL program handles the rest. Every effect in Photobox is a one-line DSL string:

.. code-block:: text

    media().bulge().write(o0)
    media().grade(preset: noir).write(o0)
    media().celShading(mix: 0.75, edgeThreshold: 0.25).write(o0)
    media().waves(strength: 9.25, speed: 5, rotation: -45).write(o0)

The ``media()`` step reads the external texture. Whatever comes after it is a GPU filter chain. Adding a new effect means adding one line to an array.

The 3x3 grid works by creating nine ``CanvasRenderer`` instances that all read from the same ``<video>`` element. Each one compiles a different DSL program. Switching tabs recompiles all nine in parallel with a different set of effects.

The whole app is 1,200 lines of vanilla JavaScript. The Noisemaker integration wrapper is 130 lines.
