.. _shader-integration:

Shader Pipeline Integration
===========================

This guide explains how to integrate Noisemaker's shader rendering engine into your application with your own UI. Noisemaker separates rendering, state, and UI, so you can use the GPU pipeline without adopting a frontend framework.

For release artifacts and versioning, see :doc:`../releases`.

Architecture
------------

::

    ┌─────────────────────────────────────────────────────────────┐
    │                     Your Application                        │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
    │   │  Your UI     │───▶│ ProgramState │───▶│CanvasRenderer│  │
    │   │  (React,     │◀───│  (state)     │◀───│  (GPU)       │  │
    │   │   Vue, etc)  │    │              │    │              │  │
    │   └──────────────┘    └──────────────┘    └──────────────┘  │
    │                              │                    │         │
    │                              ▼                    ▼         │
    │                       ┌─────────────────────────────┐       │
    │                       │       DSL Compiler          │       │
    │                       │  (compile, unparse, etc)    │       │
    │                       └─────────────────────────────┘       │
    └─────────────────────────────────────────────────────────────┘

.. list-table::
   :header-rows: 1
   :widths: 20 40 20

   * - Component
     - Purpose
     - Required?
   * - **CanvasRenderer**
     - GPU rendering pipeline (WebGL2 or WebGPU)
     - Yes
   * - **ProgramState**
     - Centralized state with event-driven updates
     - Recommended
   * - **DSL Compiler**
     - Parse and generate effect chain text
     - For DSL workflows

Installation
------------

CDN (recommended)
^^^^^^^^^^^^^^^^^

Import directly from the Noisemaker CDN. You do not need a build step or vendored files. This is the same pattern we use for all of our production apps at Noise Factor.

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

    const { CanvasRenderer, ProgramState, compile, unparse, getEffect } =
        await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

Add a preconnect hint in your HTML for faster loading:

.. code-block:: html

    <link rel="preconnect" href="https://shaders.noisedeck.app" crossorigin>

The CDN serves per-effect bundles from ``${SHADER_CDN}/effects/``. Before each ``compile()`` call, load the required effects with ``renderer.loadEffect(effectId)`` or ``loadEffects([...])`` for multiple effects. These methods fetch bundles on demand. See Quick Start below.

Pinning levels
""""""""""""""

The CDN exposes three URL shapes for every release. Pick the one that matches how much drift your application can tolerate between deploys.

.. list-table::
   :header-rows: 1
   :widths: 35 45 20

   * - URL shape
     - Meaning
     - When to use
   * - ``shaders.noisedeck.app/1``
     - Rolling latest within **major 1**. It automatically tracks every minor and patch release (e.g., ``1.0.0`` → ``1.0.1`` → ``1.1.0``) until ``2.0`` ships. Then this URL freezes and consumers explicitly migrate to ``/2``.
     - Most integrations. No code change needed for minor upgrades.
   * - ``shaders.noisedeck.app/1.0``
     - Rolling latest within the **1.0 minor series**. Stays on the 1.0.x line even if 1.1 or 2.0 ships.
     - When you want patch-level updates but explicit control over minor-version changes.
   * - ``shaders.noisedeck.app/1.0.1``
     - **Exact pin**, immutable. This directory's contents never change once published.
     - Reproducible builds, security-audited integrations, and frozen historical versions.

Example — rolling latest within major 1 (recommended default):

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

Example — pinned to the 1.0 minor series:

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1.0'

Example — exact immutable pin:

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1.0.1'

All subsequent examples in this guide use ``shaders.noisedeck.app/1`` — substitute any pinning level above.

Vendored Bundles
^^^^^^^^^^^^^^^^

For offline or self-hosted deployments. Each release (see :doc:`../releases`) publishes ``noisemaker-shaders.tar.gz`` as an attachment on the GitHub release.

.. code-block:: bash

    mkdir -p vendor/noisemaker
    gh release download --repo noisefactorllc/noisemaker --pattern 'noisemaker-shaders.tar.gz' --dir .
    tar -xzf noisemaker-shaders.tar.gz -C vendor/noisemaker
    rm noisemaker-shaders.tar.gz

Then import from the local path instead of the CDN:

.. code-block:: javascript

    const { CanvasRenderer } =
        await import('./vendor/noisemaker/shaders/noisemaker-shaders-core.esm.min.js')

The IIFE build (``noisemaker-shaders-core.min.js``) exposes everything on ``window.NoisemakerShadersCore``.

Source Imports
^^^^^^^^^^^^^^

For development within the noisemaker repo, or when noisemaker is a git submodule.

.. code-block:: javascript

    import { CanvasRenderer, getEffect, isStarterEffect } from '../../shaders/src/renderer/canvas.js'
    import { compile, unparse } from '../../shaders/src/lang/index.js'
    import { ProgramState } from '../../demo/shaders/lib/program-state.js'

In source mode, the renderer loads effects at runtime from ``shaders/effects/``. Set ``basePath`` to point at the ``shaders/`` directory.

Quick Start
-----------

Minimal (render only)
^^^^^^^^^^^^^^^^^^^^^

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

    const { CanvasRenderer } = await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

    const canvas = document.getElementById('canvas')
    const renderer = new CanvasRenderer({
        canvas,
        width: 1024,
        height: 1024,
        basePath: SHADER_CDN,
        useBundles: true,
        bundlePath: `${SHADER_CDN}/effects`
    })

    await renderer.loadManifest()
    await renderer.loadEffect('synth/noise')

    await renderer.compile(`
        search synth
        noise().write(o0)
        render(o0)
    `)

    renderer.start()

With State Management
^^^^^^^^^^^^^^^^^^^^^

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

    const { CanvasRenderer, ProgramState } =
        await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

    const renderer = new CanvasRenderer({
        canvas: document.getElementById('canvas'),
        width: 1024, height: 1024,
        basePath: SHADER_CDN,
        useBundles: true,
        bundlePath: `${SHADER_CDN}/effects`
    })
    await renderer.loadManifest()
    await renderer.loadEffect('synth/noise')

    const dsl = `
        search synth
        noise(octaves: 4, scaleX: 50, scaleY: 50).write(o0)
        render(o0)
    `
    await renderer.compile(dsl)

    const state = new ProgramState({ renderer })
    state.fromDsl(dsl)

    renderer.start()

    // Modify parameters (automatically applied to the pipeline)
    state.setValue('step_0', 'octaves', 6)
    state.setValue('step_0', 'scaleX', 30)

Core API
--------

CanvasRenderer
^^^^^^^^^^^^^^

Creates and manages the GPU rendering pipeline.

**Constructor options:**

.. code-block:: javascript

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

    const renderer = new CanvasRenderer({
        canvas,                            // HTMLCanvasElement (required)
        width: 1024,                       // Render resolution width
        height: 1024,                      // Render resolution height
        basePath: SHADER_CDN,              // CDN or local path to shader assets
        useBundles: true,                  // Load effects from pre-built bundles
        bundlePath: `${SHADER_CDN}/effects`, // Path to effect bundles
        preferWebGPU: false,               // Use WebGPU backend if available
        onFPS: (fps) => {},                // Called each frame with current FPS
        onError: (err) => {},              // Called on pipeline errors
        onFrame: (time) => {},             // Called each frame with normalized time
        onLoadingStart: () => {},          // Called when effect loading begins
        onLoadingEnd: () => {}             // Called when effect loading finishes
    })

**Path configuration:**

``basePath``
    Root URL for shader assets. Use one of these paths:

    - A CDN URL from `Pinning levels`_, such as ``https://shaders.noisedeck.app/1``
      for rolling latest within major 1
    - A local vendor path
    - A relative path to ``shaders/`` for source mode

    The CDN provides ``/1.0`` for minor pinning and ``/1.0.1`` for an exact immutable pin.

``bundlePath``
    Directory containing per-effect bundles and ``manifest.json``. Typically ``${basePath}/effects``.

``useBundles``
    When ``true``, loads effects from pre-built JS bundles. When ``false``, loads from source directories.

**Methods:**

.. code-block:: javascript

    // Lifecycle
    await renderer.loadManifest()          // Load effect registry (call first)
    await renderer.loadEffect('synth/noise')           // Fetch one effect bundle, or...
    await renderer.loadEffects(['synth/noise', 'filter/bloom'])  // ...several at once
    await renderer.compile(dsl)            // Compile DSL string into a shader pipeline
    renderer.start()                       // Start the render loop
    renderer.stop()                        // Stop the render loop
    renderer.render(0.5)                   // Render a single frame (time 0-1)

    // Parameters
    renderer.applyStepParameterValues(values)  // Apply parameter values from state

    // Textures
    renderer.updateTextureFromSource(id, source)  // Update texture from image/video/canvas

    // Backend
    await renderer.switchBackend('wgsl')   // Switch to WebGPU
    await renderer.switchBackend('glsl')   // Switch to WebGL2

    // Output (after compile)
    const removeSink = renderer.addSink(sink)
    const exportQueue = renderer.createFrameExportQueue({ slots: 3 })

    // Effect loading
    await renderer.loadEffects(['synth/noise', 'filter/bloom'])
    renderer.getEffectsFromManifest('synth')  // List effects in a namespace

See :doc:`renderer-output` for sink lifecycle, asynchronous frame export, and
the packed RGBA8 frame contract.

ProgramState
^^^^^^^^^^^^

Manages parameter state for a compiled pipeline. Emits events so your UI can react to changes.

.. code-block:: javascript

    const state = new ProgramState({ renderer })

    // Read/write parameters
    state.getValue('step_0', 'scaleX')             // Get a single value
    state.setValue('step_0', 'scaleX', 50)         // Set a single value
    state.getStepValues('step_0')                  // All values for a step
    state.setStepValues('step_0', { scaleX: 50, octaves: 4 })

    // Batch multiple changes into a single event
    state.batch(() => {
        state.setValue('step_0', 'scaleX', 50)
        state.setValue('step_0', 'octaves', 4)
    })

    // DSL round-trip
    state.fromDsl(dslText)                         // Parse DSL into state
    state.toDsl()                                  // Generate DSL from state

    // Serialization (for undo/redo, persistence)
    const snapshot = state.serialize()
    state.deserialize(snapshot)

    // Skip/bypass an effect step
    state.setSkip('step_0', true)
    state.isSkipped('step_0')

    // Reset a step to its default values
    state.resetStep('step_0')

**Events:**

.. code-block:: javascript

    state.on('change', ({ stepKey, paramName, value }) => {
        // A parameter value changed
    })

    state.on('stepchange', ({ stepKey }) => {
        // Multiple parameters on a step changed (e.g. from setStepValues)
    })

    state.on('structurechange', () => {
        // The pipeline structure changed (steps added/removed/reordered)
    })

    state.on('reset', ({ stepKey }) => {
        // A step was reset to defaults
    })

    state.on('load', () => {
        // A new program was loaded via fromDsl or deserialize
    })

DSL Compiler
^^^^^^^^^^^^

Direct access to parsing and code generation, independent of state or rendering.

.. code-block:: javascript

    import { compile, unparse, validate } from '...'

    // Compile DSL text to a structured representation
    const compiled = compile('search synth\nnoise(octaves: 4).write(o0)\nrender(o0)')

    // Generate DSL text from a compiled structure
    const dsl = unparse(compiled)

    // Validate before compiling
    try {
        compile(userInput)
    } catch (err) {
        console.error(err.message)
    }

Effect Registry
^^^^^^^^^^^^^^^

Query effect definitions to build parameter UIs. Load effects with ``loadManifest()`` and ``loadEffects()`` before querying.

.. code-block:: javascript

    import { getEffect, getAllEffects, isStarterEffect } from '...'

    const noiseDef = getEffect('synth/noise')

    // Inspect parameters
    for (const [name, spec] of Object.entries(noiseDef.globals)) {
        console.log({ name, type: spec.type, default: spec.default, min: spec.min, max: spec.max })
    }

    // Check if this is a generator (vs a filter)
    isStarterEffect(noiseDef)  // true for generators

    // Iterate all loaded effects
    for (const [id, def] of getAllEffects()) {
        console.log(`${id}: ${def.description}`)
    }

Loading Effects from a DSL
^^^^^^^^^^^^^^^^^^^^^^^^^^

Use ``extractEffectNamesFromDsl`` for DSL from user input, saved presets, or dynamically generated chains. It checks the DSL against the manifest and collects effect IDs. Pass that list to ``loadEffects()``:

.. code-block:: javascript

    const { extractEffectNamesFromDsl } =
        await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

    await renderer.loadManifest()

    const effectIds = extractEffectNamesFromDsl(userDsl, renderer.manifest)
        .map(e => e.effectId)

    await renderer.loadEffects(effectIds)
    await renderer.compile(userDsl)

Returns ``[{ effectId, namespace, name }, ...]`` for every call site in the DSL that resolves against ``renderer.manifest``. The helper skips unknown calls, so you can safely pass the resulting list to ``loadEffects()``.

The static-DSL quickstart loads its single effect directly by ID. Use ``extractEffectNamesFromDsl`` when you do not know the DSL text while writing the application.

.. note::

   The current bundle's ``extractEffectNamesFromDsl`` uses regex. It includes inline ``//`` comments after a ``search`` directive in the namespace name.
   If your DSL uses such comments, move them to their own line. Alternatively, remove line comments before calling the helper: ``dsl.replace(/\/\/.*$/gm, '')``.

Parameter Types
---------------

Each effect's ``globals`` defines its parameters. Use these types to build UI controls.

.. list-table::
   :header-rows: 1
   :widths: 15 30 20

   * - Type
     - JS Value
     - Typical Control
   * - ``float``
     - ``number``
     - Slider
   * - ``int``
     - ``number``
     - Slider (integer step)
   * - ``color``
     - ``[r, g, b]`` (0-1) or ``"#rrggbb"``
     - Color picker
   * - ``bool``
     - ``boolean``
     - Toggle/checkbox
   * - ``choice``
     - ``string`` or ``number``
     - Dropdown/select
   * - ``surface``
     - ``string`` (``"o0"``, ``"o1"``, ...)
     - Surface picker

Each parameter spec may include ``min``, ``max``, ``step``, ``default``, and ``choices`` (for choice types).

Media Inputs
------------

Some effects accept external textures (images, video, camera). Check for this via the effect definition:

.. code-block:: javascript

    const def = getEffect('synth/media')
    if (def.externalTexture) {
        // This effect expects a texture source
    }

    // Image
    const img = new Image()
    img.src = 'photo.jpg'
    img.onload = () => renderer.updateTextureFromSource('imageTex', img)

    // Video
    const video = document.createElement('video')
    video.src = 'clip.mp4'
    video.play()
    function tick() {
        renderer.updateTextureFromSource('imageTex', video)
        requestAnimationFrame(tick)
    }
    tick()

    // Camera
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    const video = document.createElement('video')
    video.srcObject = stream
    await video.play()
    // Then feed frames via requestAnimationFrame as above

Undo/Redo
---------

Use ``serialize()``/``deserialize()`` for undo/redo:

.. code-block:: javascript

    const undoStack = []
    const redoStack = []

    function pushUndo() {
        undoStack.push(state.serialize())
        redoStack.length = 0
    }

    function undo() {
        if (!undoStack.length) return
        redoStack.push(state.serialize())
        state.deserialize(undoStack.pop())
    }

    function redo() {
        if (!redoStack.length) return
        undoStack.push(state.serialize())
        state.deserialize(redoStack.pop())
    }

Effect Chains
-------------

Build multi-effect pipelines using the DSL:

.. code-block:: javascript

    await renderer.loadEffects(['synth/noise', 'filter/posterize', 'filter/bloom'])

    const dsl = `
        search synth, filter
        noise(octaves: 4, scaleX: 50, scaleY: 50)
          .posterize(levels: 8)
          .bloom(threshold: 0.5)
          .write(o0)
        render(o0)
    `
    await renderer.compile(dsl)
    state.fromDsl(dsl)

Connect effects with ``.``. A chain follows this sequence:

1. A generator produces the initial image.
2. Filters process the image.
3. The ``.write(oN)`` call assigns the result to a surface.

The ``render(oN)`` directive displays a surface. Multiple chains can write to different surfaces for composition.

Effect Directory Structure
--------------------------

::

    shaders/effects/
      manifest.json
      synth/
        noise/
          definition.js     # Effect class (globals, tags, metadata)
          glsl/             # GLSL shader sources
          wgsl/             # WGSL shader sources
          help.md           # Per-effect documentation
        fractal/
        gradient/
        ...
      filter/
        bloom/
        blur/
        ...
      mixer/
      points/
      render/
      ...

When ``useBundles: true``, effects load from pre-built JS files that inline the shaders. When ``false``, they load from the source directories above.

Effect Namespaces
^^^^^^^^^^^^^^^^^

.. list-table::
   :header-rows: 1
   :widths: 25 50

   * - Namespace
     - Description
   * - ``synth/``
     - Generators: noise, fractal, voronoi, gradient, etc.
   * - ``synth3d/``
     - 3D volume generators
   * - ``filter/``
     - Image processing: bloom, blur, posterize, warp, etc.
   * - ``filter3d/``
     - 3D processing filters
   * - ``mixer/``
     - Blend and composition
   * - ``points/``
     - Agent-based simulations: physarum, flow, flock, particles
   * - ``render/``
     - Render utilities: render3d, loopBegin/End, pointsEmitter/Render
   * - ``classicNoisedeck/``
     - Noisedeck-original effects

Custom Namespaces
^^^^^^^^^^^^^^^^^

External integrations with their own effect collection can add a top-level namespace beside the built-ins. They need not vendor the engine or share the ``user`` namespace.

.. code-block:: javascript

    import { registerNamespace, registerEffect, registerOp } from '...'

    registerNamespace('myLib', { description: 'My effect collection' })
    registerEffect('myLib/bar', myLibBarInstance)
    registerEffect('myLib.bar', myLibBarInstance)
    registerOp    ('myLib.bar', myLibBarOpSpec)

After registration, the DSL parser accepts the new namespace in the ``search`` directive:

.. code-block:: none

    search myLib
    bar(...).write(o0)

**API:**

.. code-block:: javascript

    // Register a new namespace. Returns the frozen descriptor.
    // Throws on invalid id, reserved word, built-in collision, or
    // re-registration with a mismatched description. Same-description
    // re-registration is an idempotent no-op.
    registerNamespace(id, { description })

    // Remove a previously-registered namespace. Returns true on
    // removal, false if the id was never registered. Throws on
    // built-in ids. Effects already registered remain in the
    // registry but become unreachable via `search`.
    unregisterNamespace(id)

    // Remove an effect from the registry. Returns true on removal,
    // false if the name was never registered. Symmetric with
    // registerEffect.
    unregisterEffect(name)

**Validation rules for namespace ids:**

* Must match ``/^[a-z][a-zA-Z0-9]*$/`` (lowercase-leading identifier).
* Must not be a DSL reserved keyword (``let``, ``render``, ``write``, ``write3d``, ``if``, ``elif``, ``else``, ``break``, ``continue``, ``return``, ``search``, ``subchain``, ``true``, ``false``).
* Must not collide with an IO function name (``read``, ``write``, ``read3d``, ``write3d``, ``render``, ``render3d``).
* Must not be a reserved function name (``from``, ``osc``, ``midi``, ``audio``, ``null``, ``undefined``).
* Must not collide with a built-in namespace (``synth``, ``filter``, ``mixer``, ``render``, ``points``, ``synth3d``, ``filter3d``, ``classicNoisedeck``, ``io``, ``user``).

Integrations sharing an engine instance must choose distinct namespace ids. The ``registerNamespace`` function throws an error on collision, making the conflict visible.

Bundle Exports Reference
-------------------------

The core bundle (``noisemaker-shaders-core.esm.js``) exports:

.. list-table::
   :header-rows: 1
   :widths: 20 60

   * - Category
     - Exports
   * - **Renderer**
     - ``CanvasRenderer``, ``cloneParamValue``, ``isStarterEffect``, ``is3dGenerator``
   * - **Language**
     - ``compile``, ``unparse``, ``lex``, ``parse``, ``applyParameterUpdates``, ``formatValue``, ``validate``
   * - **Runtime**
     - ``Effect``, ``registerEffect``, ``unregisterEffect``, ``getEffect``, ``getAllEffects``, ``Pipeline``
   * - **Namespaces**
     - ``registerNamespace``, ``unregisterNamespace``, ``isValidNamespace``, ``getNamespaceDescription``, ``NAMESPACE_DESCRIPTIONS``, ``VALID_NAMESPACES``
   * - **Backends**
     - ``WebGL2Backend``, ``WebGPUBackend``
   * - **External Input**
     - ``MidiState``, ``MidiChannelState``, ``AudioState``,
       ``MidiInputManager``, ``AudioInputManager``, ``ExternalInputManager``
   * - **State**
     - ``ProgramState``, ``Emitter``, ``extractEffectsFromDsl``, ``extractEffectNamesFromDsl``

.. note::

   UI components (``UIController``, ``EffectSelect``, ``ToggleSwitch``) belong to the demo app in ``demo/shaders/lib/``. The core bundle excludes them. Import them directly from source if needed.

Example: Vanilla JS
--------------------

.. code-block:: html

    <!DOCTYPE html>
    <html>
    <head>
        <link rel="preconnect" href="https://shaders.noisedeck.app" crossorigin>
    </head>
    <body>
        <canvas id="canvas" width="512" height="512"></canvas>
        <div>
            <label>Octaves: <input type="range" id="octaves" min="1" max="8" value="4"></label>
            <label>Horizontal scale: <input type="range" id="scaleX" min="1" max="100" step="1" value="50"></label>
        </div>

        <script type="module">
            const SHADER_CDN = 'https://shaders.noisedeck.app/1'

            const { CanvasRenderer, ProgramState } =
                await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

            const renderer = new CanvasRenderer({
                canvas: document.getElementById('canvas'),
                width: 512, height: 512,
                basePath: SHADER_CDN,
                useBundles: true,
                bundlePath: `${SHADER_CDN}/effects`
            })

            await renderer.loadManifest()
            await renderer.loadEffect('synth/noise')

            const dsl = `
                search synth
                noise(octaves: 4, scaleX: 50, scaleY: 50).write(o0)
                render(o0)
            `
            await renderer.compile(dsl)

            const state = new ProgramState({ renderer })
            state.fromDsl(dsl)

            renderer.start()

            document.getElementById('octaves').addEventListener('input', e => {
                state.setValue('step_0', 'octaves', +e.target.value)
            })
            document.getElementById('scaleX').addEventListener('input', e => {
                state.setValue('step_0', 'scaleX', +e.target.value)
            })
        </script>
    </body>
    </html>

Example: React
--------------

.. code-block:: jsx

    import { useEffect, useState, useRef } from 'react'

    const SHADER_CDN = 'https://shaders.noisedeck.app/1'

    function NoiseGenerator() {
        const canvasRef = useRef(null)
        const [state, setState] = useState(null)
        const [params, setParams] = useState({ octaves: 4, scaleX: 50 })

        useEffect(() => {
            let renderer

            async function init() {
                const { CanvasRenderer, ProgramState } =
                    await import(`${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`)

                renderer = new CanvasRenderer({
                    canvas: canvasRef.current,
                    width: 512, height: 512,
                    basePath: SHADER_CDN,
                    useBundles: true,
                    bundlePath: `${SHADER_CDN}/effects`
                })

                await renderer.loadManifest()
                await renderer.loadEffect('synth/noise')

                const dsl = `
                    search synth
                    noise(octaves: 4, scaleX: 50, scaleY: 50).write(o0)
                    render(o0)
                `
                await renderer.compile(dsl)

                const programState = new ProgramState({ renderer })
                programState.fromDsl(dsl)

                renderer.start()
                setState(programState)
            }

            init()
            return () => renderer?.stop()
        }, [])

        const handleChange = (key, value) => {
            if (!state) return
            state.setValue('step_0', key, value)
            setParams(p => ({ ...p, [key]: value }))
        }

        return (
            <div>
                <canvas ref={canvasRef} width={512} height={512} />
                <label>
                    Octaves: {params.octaves}
                    <input type="range" min={1} max={8} value={params.octaves}
                        onChange={e => handleChange('octaves', +e.target.value)} />
                </label>
                <label>
                    Horizontal scale: {params.scaleX}
                    <input type="range" min={1} max={100} step={1} value={params.scaleX}
                        onChange={e => handleChange('scaleX', +e.target.value)} />
                </label>
            </div>
        )
    }

Further Reading
---------------

- :doc:`language`: DSL syntax and semantics
- :doc:`effect-reference`: per-effect documentation
- :doc:`pipeline`: how the rendering pipeline works
- :doc:`renderer-output`: sending rendered frames to sinks or CPU consumers
- :doc:`midi-audio`: connecting external controllers
- :doc:`../releases`: how and when releases are published
