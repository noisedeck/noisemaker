Mashup
======

Route up to eight sources through one grayscale control. The effect posterizes
the control's luminance into bands. Each band shows a different surface.

``mixer/mashup`` reads the luminance of its ``source`` input and divides the
0…1 range into ``layers`` equal bands. Each band displays a different engine
surface: the darkest band shows the first layer, the brightest shows the
last. ``smoothness`` feathers each band boundary so adjacent sources
cross-fade instead of meeting at a hard edge.

Like ``synth/remap``, Mashup routes surfaces to regions. Remap uses polygon
zones, and Mashup uses luminance bands. Like
Remap, every input — including the control — is an explicit slot wired in
DSL with ``read(oN)``.

.. code-block:: dsl

    search synth, mixer

    noise(ridges: true).write(o0)
    solid(color: #ee3322).write(o1)
    solid(color: #2266cc).write(o2)
    gradient().write(o3)

    mashup(layers: 3, source: read(o3), layer0_tex: read(o0), layer1_tex: read(o1), layer2_tex: read(o2))
      .write(o4)

Notes
-----

- The effect normally samples only the control input's luminance. If a band's
  layer source is unwired, that band shows the control input directly, including
  its color.
- Bands run from darkest to brightest. Changing the order of the wired sources
  changes which luminance range each source occupies.
