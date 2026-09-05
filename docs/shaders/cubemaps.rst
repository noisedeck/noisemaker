Cubemaps
========

Render a 3D volume into six cube faces with matching edges on WebGL2 and WebGPU. Use the faces for skyboxes, planetary surfaces, nebulae, and stars.

Two renderers turn a volume into cube faces, differing only in how they show the field:

- ``renderCubemapSurface`` — the field's **raw true color**, sampled along each face ray (no lighting, no gamma). Same dynamic range as the field's 2D view.
- ``renderCubemap3d`` — a lit **``render3d``-style solid** (isosurface or voxel, with shading and gamma).

.. note::

   **Work in progress — not yet ready for use.** Cubemap support is under
   development as a foundation for future engine features. The API,
   parameters, and output are subject to change.

How It Works
------------

A cube camera sits at the center of the volume and looks outward through a 90-degree frustum, once per face. The six faces use the axis-aligned directions, in this order:

.. code-block:: text

   index 0  +X
   index 1  -X
   index 2  +Y
   index 3  -Y
   index 4  +Z
   index 5  -Z

Each output pixel becomes a 3D view ray that marches the volume. Adjacent faces evaluate their shared edge from the *same* 3D direction, so the edges match exactly. This construction produces matching edges without tiling 2D textures. Two tests prove continuity across every face edge: ``test/cubeCamera.test.js`` (closed-cube invariant) and ``test/cubeExport.test.js`` (cross-layout adjacency).

Generating Cube Faces
---------------------

Two cubemap renderers take a 3D volume and render the current cube face.
Drive either renderer from a 3D generator such as ``noise3d``. They show the
field differently:

.. list-table::
   :header-rows: 1
   :widths: 24 76

   * - Renderer
     - What it shows
   * - ``renderCubemapSurface``
     - The **raw, true color** of the field, sampled along the face normal (front-to-back emission/absorption). No lighting, no gamma — the same dynamic range as the field's 2D view. Use this to see the field as-is.
   * - ``renderCubemap3d``
     - The lit **"blob in space"** — a multi-face clone of ``render3d``: isosurface or voxel raymarching with shading and gamma. (A future ``renderCubemapLit3D`` will mirror ``renderLit3d``.)

.. code-block:: dsl

    search synth3d, filter3d, render

    noise3d(volumeSize: x64)
      .renderCubemapSurface()
      .write(o0)

    render(o0)

``volumeSize`` (on the generator) sets the volume resolution: ``x16``, ``x32``, ``x64``, or ``x128`` (16³ … 128³).

renderCubemapSurface parameters
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 22 18 18 42

   * - Parameter
     - Type
     - Default
     - Description
   * - ``density``
     - number (0–20)
     - 4
     - Scales the field's contribution to per-step opacity
   * - ``absorption``
     - number (0–4)
     - 1
     - How strongly the medium attenuates along the ray
   * - ``emission``
     - number (0–4)
     - 1
     - How much each sample emits
   * - ``bgColor`` / ``bgAlpha``
     - color / number
     - ``[0.02,0.02,0.02]`` / 1
     - Background behind the volume

renderCubemap3d parameters
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 22 18 18 42

   * - Parameter
     - Type
     - Default
     - Description
   * - ``filtering``
     - ``isosurface`` | ``voxel``
     - ``isosurface``
     - Smooth isosurface raymarch, or blocky voxel (DDA) traversal
   * - ``threshold``
     - number (0–1)
     - 0.5
     - Field cutoff the surface is traced to
   * - ``invert``
     - boolean
     - false
     - Flip the inside/outside test
   * - ``bgColor`` / ``bgAlpha``
     - color / number
     - ``[0.02,0.02,0.02]`` / 1
     - Background behind the volume

Examples
~~~~~~~~

.. code-block:: dsl

    // Raw field, denser
    search synth3d, filter3d, render
    noise3d(volumeSize: x64).renderCubemapSurface(density: 8, emission: 2).write(o0)
    render(o0)

    // Lit isosurface "planet shell"
    search synth3d, filter3d, render
    noise3d(volumeSize: x64).renderCubemap3d(threshold: 0.55).write(o0)
    render(o0)

Rendering All Six Faces
-----------------------

A cubemap renderer renders one face at a time, according to the driver's ``cubeBasis``. To produce all six faces, call ``renderCubemap()`` on the renderer or pipeline. It runs the compiled graph six times, once per face, and returns six pixel buffers. The graph's final cubemap renderer (``renderCubemapSurface`` or ``renderCubemap3d``) determines the render style. The driver has no render-style option.

.. code-block:: javascript

    const faces = await renderer.renderCubemap({
        size: 512,            // face edge length in pixels
        outputSurface: 'o0',  // the surface the DSL writes to
    })
    // faces: 6 × { width, height, data: Uint8Array }  (RGBA8), in +X,-X,+Y,-Y,+Z,-Z order

.. list-table::
   :header-rows: 1
   :widths: 18 14 14 54

   * - Option
     - Type
     - Default
     - Description
   * - ``size``
     - number
     - 512
     - Face edge length in pixels (the graph is rendered at ``size`` × ``size``)
   * - ``outputSurface``
     - string
     - ``o0``
     - The user surface (``o0``–``o7``) the DSL writes its cubemap-renderer result to
   * - ``time``
     - number
     - 0
     - Time value passed to the render (for animated volumes)

The graph must terminate in a cubemap renderer writing to ``outputSurface``. The ``outputSurface`` value must name a real surface that the DSL wrote to. An unknown name throws an error. A flat 2D chain without a cubemap renderer would render the same image six times.

Exporting
---------

The six faces use these canonical names, in face order:

.. code-block:: text

   px.png  nx.png  py.png  ny.png  pz.png  nz.png   (= +X,-X,+Y,-Y,+Z,-Z)

Two pure helpers live in ``shaders/src/renderer/cubeExport.js``:

- ``faceFileNames()`` → the six ``.png`` names above.
- ``crossLayout(faces)`` → a single ``{ width, height, data }`` RGBA8 buffer arranging the faces into a seam-continuous horizontal cross (4×3).

.. note::

   ``cubeExport.js`` helpers are not part of the core bundle (like the UI
   components). Import them from source, or assemble/name the faces yourself
   using the face order above. PNG encoding happens at the call site.

Host Integration
----------------

To save the six faces, use this cubemap workflow. See :doc:`integration` for renderer setup:

.. code-block:: javascript

    // 1. Compile a graph that ends in a cubemap renderer, then pause the render loop
    //    so the driver owns the per-face camera while it bakes.
    await renderer.loadEffects(['synth3d/noise3d', 'render/renderCubemapSurface'])
    await renderer.compile(`
        search synth3d, filter3d, render
        noise3d(volumeSize: x64).renderCubemapSurface().write(o0)
        render(o0)
    `)
    renderer.stop()

    // 2. Render all six faces.
    const faces = await renderer.renderCubemap({ size: 1024 })

    // 3. Encode each face to a PNG blob in the browser.
    async function faceToPng(face) {
        const canvas = new OffscreenCanvas(face.width, face.height)
        const ctx = canvas.getContext('2d')
        ctx.putImageData(new ImageData(new Uint8ClampedArray(face.data), face.width, face.height), 0, 0)
        return canvas.convertToBlob({ type: 'image/png' })
    }
    const names = ['px', 'nx', 'py', 'ny', 'pz', 'nz']
    const blobs = await Promise.all(faces.map(faceToPng))
    // → save blobs[i] as `${names[i]}.png`, or zip them, or upload.

    renderer.start()  // resume the live preview

The next ``renderCubemap()`` call reuses the returned array and its buffers. Copy a face's ``data`` if you need to retain it across calls.

Technical Notes
---------------

- **Face order is fixed**: ``+X, -X, +Y, -Y, +Z, -Z`` (indices 0–5), consistent across the camera, driver, export names, and cross layout.
- **Readback works on both backends.** The ``renderCubemap`` method reads the offscreen output surface directly (via ``copyTextureToBuffer`` on WebGPU). This avoids the canvas IOSurface readback race that affects on-screen captures.
- **Pixel rows are top-down** (``readPixels`` flips WebGL2's bottom-up rows to match WebGPU). The exported PNGs and the cross are in standard top-down image orientation.
- **Volume size limits**: ``x16``–``x128`` (128³ is the current ceiling).
- ``outputSurface`` defaults to ``o0`` and must match the surface the DSL writes to.
