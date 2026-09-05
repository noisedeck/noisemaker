Layers
======

`layers.noisefactor.io <https://layers.noisefactor.io/>`_

Layers is a non-destructive image and video editor that runs in the browser. Users import their own media, stack it with GPU effects and blend modes, and export the result. We shipped the first version in a week. It has zero lines of GPU rendering code.

Layers uploads users' images and videos to GPU textures through ``updateTextureFromSource()``. The application manages a stack of layer objects as plain data. On every change, it generates a Noisemaker DSL program from that stack. Noisemaker compiles and renders the pipeline. Layers never calls WebGL.

Suppose a user creates three rendering layers in the UI:

- A photo at the bottom
- A blur filter
- A noise texture blended on top at 60% opacity

Layers generates this program:

.. code-block:: text

    search synth, filter, mixer

    solid(color: #000000, alpha: 0).write(o0)    // hidden transparent base
    media().write(o1)
    read(o0).blendMode(tex: read(o1), mode: normal, mixAmt: 1.0).write(o2)

    read(o2).blur(radius: 0.3).write(o3)

    noise(scale: 4).write(o4)
    read(o3).blendMode(tex: read(o4), mode: overlay, mixAmt: 0.6).write(o5)

    render(o5)

The ``solid()`` at the top is a hidden transparent base layer that Layers inserts automatically. Every visible layer composites onto the accumulated result via ``blendMode``.

That's the entire rendering pipeline, a text string. Adding a layer, toggling visibility, changing a blend mode: these regenerate the program and recompile the pipeline. Parameter changes (slider drags, color picks) update GPU uniforms directly through ``ProgramState`` without recompilation.

Every effect in the Noisemaker library is available to the app without any additional graphics processing code. When we add a new effect upstream, Layers loads it from the CDN automatically. We built the whole thing in a week with Claude as our coding partner.
