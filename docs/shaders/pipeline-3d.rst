The 3D Pipeline
===============

Generate, filter, and render volumetric fields — a true 3D counterpart to the
2D synth/filter/render chain, on both the WebGL2 and WebGPU backends.

A 3D chain has the same shape as a 2D one: a generator produces a field, zero
or more filters transform it, and a renderer turns it into pixels. The
difference is that every intermediate value is a volume rather than an image.

.. code-block:: dsl

    search synth3d, filter3d, render

    noise3d(volumeSize: x64)
      .palette3d(index: palette.brushedMetal)
      .render3d()
      .write(o0)

    render(o0)

``volumeSize`` (on the generator) sets the volume resolution: ``x16``,
``x32``, ``x64``, or ``x128`` (16³ … 128³). Downstream effects inherit it
automatically. The runtime stores a volume in a 2D slice atlas whose dimensions
are ``volumeSize × volumeSize²``. If the requested atlas exceeds the device's
maximum texture dimension, the whole chain is stepped down to the largest
supported power-of-two size. For example, a device limited to 8192-pixel
textures renders a requested ``x128`` chain at ``x64`` instead of producing an
incomplete volume.

Generators (synth3d)
--------------------

Volume generators live in the ``synth3d`` namespace: ``noise3d``, ``cell3d``,
``fractal3d``, ``shape3d``, ``cellularAutomata3d``, ``reactionDiffusion3d``,
and ``flythrough3d``. Each one's parameters are documented in the Effect
Reference.

Volumetric filters (filter3d)
-----------------------------

Filters in the ``filter3d`` namespace transform a volume and pass it on:

- ``palette3d`` — recolors the field per voxel with the same 55 cosine
  palettes and RGB/HSV/OkLab colorspace modes as the 2D ``palette`` filter.
- ``flow3d`` — an agent-based 3D flow field that deposits trails through the
  volume.

Recoloring filters follow a shared pattern: they change a voxel's color while
passing its shape (geometry) through untouched, so any downstream renderer
sees the same surface.

Renderers
---------

A renderer consumes the volume and produces the frame:

.. list-table::
   :header-rows: 1
   :widths: 34 66

   * - Renderer
     - Output
   * - ``render3d``
     - Universal raymarcher: smooth ``isosurface`` mode (trilinear
       interpolation with bisection refinement) or ``voxel`` mode (DDA
       traversal with flat face shading)
   * - ``renderLit3d``
     - Lit variant of ``render3d``
   * - ``renderCubemapSurface`` / ``renderCubemap3d``
     - Six seamless cube faces for skyboxes and planetary surfaces — see the
       Cubemaps guide
