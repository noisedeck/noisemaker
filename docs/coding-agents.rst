Building with coding agents
===========================

Noisemaker has two layers, and a coding agent can help with both.

The **Polymorphic DSL** composes existing effects into a render graph.
The **effect layer** contains your GLSL and WGSL shaders. Each effect has
a definition that declares its parameters, passes, and UI. Most sessions
use both layers.

This page explains the context and workflow for each layer. It covers tool
calls that compile effects, render frames, measure output, and compare backends.

Composing: the DSL layer
------------------------

A DSL program names effects and wires them together. The engine compiles
it to a GPU render graph for WebGL2 or WebGPU, allocates resources, and
schedules the passes:

.. code-block:: text

   search synth
   noise().write(o0)
   render(o0)

This program contains no shader code. Many compositions need only the
library's generators, filters, mixers, particles, and simulations. Models
can combine these named effects. The engine returns structured diagnostics
for errors, which an agent can use to revise the program.

Authoring: bring your own shaders
---------------------------------

When the effect you want does not exist, write it. An effect directory
contains a definition, a fragment shader per backend, and optional documentation:

.. code-block:: text

   myEffect/
   ├── definition.json     # parameters, passes, UI metadata
   ├── glsl/
   │   └── myEffect.glsl   # WebGL2, GLSL ES 3.0
   ├── wgsl/
   │   └── myEffect.wgsl   # WebGPU
   └── help.md             # optional, shown in the editor

This is the **Portable Effects Format**, an open standard for sharing
effects across Noise Factor applications. The
`portable <https://github.com/noisefactorllc/portable>`_ repository is
its canonical source: the
`format specification <https://github.com/noisefactorllc/portable/blob/main/docs/FORMAT.md>`_,
a `shader-writing guide
<https://github.com/noisefactorllc/portable/blob/main/docs/SHADERS.md>`_,
a working starter effect, and a standalone viewer with live parameter
controls. To use the repository:

1. Clone it.
2. Edit the effect directory.
3. Run the viewer.
4. Package the result as a zip.
5. Import the zip with **file → import effect from zip...**.

`Foundry <https://foundry.noisedeck.app/>`_ provides the same workflow
in the browser without a clone. The specification is not final and may change.

The shader uses ordinary fragment shader code, with no custom dialect or
transpiler. GLSL ES 3.0 reads ``gl_FragCoord`` and writes ``out vec4 fragColor``.
WGSL takes ``@builtin(position)`` and returns ``@location(0) vec4<f32>``:

.. code-block:: glsl

   #version 300 es
   precision highp float;

   uniform vec2 resolution;
   uniform float time;
   uniform float speed;

   out vec4 fragColor;

   #define TAU 6.28318530718

   void main() {
       vec2 uv = gl_FragCoord.xy / resolution;

       float angle = time * TAU * speed;
       vec2 dir = vec2(cos(angle), sin(angle));
       float t = dot(uv - 0.5, dir) + 0.5;

       fragColor = vec4(t, t * 0.6 + 0.2, 1.0 - t, 1.0);
   }

The definition declares the properties that the engine cannot infer:

- The effect name in the language
- The uniforms it binds
- Each parameter's editor range and control type
- The connections between passes

.. code-block:: json

   {
     "name": "Gradient Sweep",
     "func": "gradientSweep",
     "description": "A diagonal color gradient that rotates over time",
     "tags": ["color"],
     "starter": true,

     "globals": {
       "speed": {
         "type": "float",
         "default": 1.0,
         "min": 0.0,
         "max": 4.0,
         "step": 0.1,
         "uniform": "speed"
       }
     },

     "defaultProgram": "search user\n\ngradientSweep(speed: 1.0)\n  .write(o0)\n\nrender(o0)",

     "passes": [
       {
         "name": "main",
         "program": "gradientSweep",
         "inputs": {},
         "outputs": { "color": "outputTex" }
       }
     ]
   }

That is the entire contract. Once the directory exists, the DSL can call
``gradientSweep()`` like any built-in effect. Its parameters receive UI
controls, and it runs on both backends. Multi-pass
effects declare intermediate textures and chain passes through them.

Effects in this repository use the same shape with a JavaScript definition:
``definition.js`` exports ``new Effect({...})``. This form adds compile-time
defines, global enum references, and lifecycle hooks for state that persists
across frames. The
`effect definition spec <https://docs.noisemaker.app/shaders/effects/>`_
is the reference for that variant, and the effects under
``shaders/effects/`` are two hundred-odd worked examples.

shade-mcp is a shader development harness
-----------------------------------------

`shade-mcp <https://github.com/noisefactorllc/shade-mcp>`_ runs Chromium
against a viewer. It compiles your shader, renders a frame, and measures
the output. Shader bugs can occur without reported errors: a program can
compile and render an incorrect image.

The harness can use this repository's library, a portable effect directory,
or your own library. Contributors and developers without a Noisemaker
clone can use the same tools.

**Compile and see the frame**

- ``compileEffect`` — compiles an effect and returns diagnostics for each
  pass. A failure names the pass and line. The tool accepts a glob or CSV
  to check a whole library.
- ``renderEffectFrame`` — renders a frame and computes mean RGB, variance,
  and blank and monochrome detection. It can capture a PNG. These metrics
  help check whether the rendered frame contains visible output.
- ``describeEffectFrame`` — sends the rendered frame to a vision model
  for a description. It helps check whether the image matches the intended
  result, which numeric metrics cannot determine.
- ``runDslProgram`` — compiles and executes arbitrary DSL, for exercising
  a new effect in composition rather than in isolation.

**Compare WebGL2 and WebGPU**

These tools help compare the two shader implementations:

- ``testPixelParity`` — renders the same effect on both backends and
  compares pixels within an epsilon you choose. It reports the difference
  as a percentage, including errors such as reading an adjacent texel.
- ``checkEffectStructure`` — checks effect definitions for structural issues.
  These include missing WGSL counterparts, unreferenced shader files, unbound
  uniforms, reserved words, names that shadow builtins, and naming violations.
- ``compareShaders`` — static structural comparison of a GLSL/WGSL pair:
  function names, uniforms, line counts.
- ``checkAlgEquiv`` — uses a model to compare the pair's semantics while
  ignoring syntax. It returns ``equivalent`` or ``divergent`` with the model's
  confidence and specific concerns.

**Verify behaviour, not just output**

- ``testUniformResponsiveness`` — changes every uniform and reports which
  ones changed the image. It detects parameters connected to the UI but
  not to the shader.
- ``testNoPassthrough`` — asserts a filter actually modifies its input.
- ``benchmarkEffectFPS`` — frame rate, jitter, and frame timing against a
  target.
- ``analyzeBranching`` — flags branching that costs more than it saves.

**Find things**

- ``searchEffects`` searches by concept, tag, algorithm, or visual style.
- ``searchShaderSource`` searches every effect's GLSL by regex. Use it to
  find existing implementations, such as a hash function you need.
- ``analyzeEffect`` returns a full definition and shader source.
- ``searchShaderKnowledge`` searches curated notes on DSL grammar, GLSL
  techniques, and common errors.
- ``generateManifest`` scans an effects directory again after you add an effect.

The `shade-mcp README
<https://github.com/noisefactorllc/shade-mcp#mcp-client-configuration>`_
provides client configuration for Claude Code, VS Code Copilot, Cursor,
and Windsurf. It documents environment variables for the effects directory
and viewer.

The development loop
--------------------

Composition and effect authoring use the same process. A composition
produces a DSL program. A new effect produces a shader and its definition.

1. Describe the intended result.
2. Compile the artifact. Compilation returns structured diagnostics for each pass.
3. Render a frame.
4. Capture metrics or the image.
5. If the effect ships both backends, compare them.
6. Give the diagnostics, metrics, parity report, or frame to the model.
7. Repeat the process as needed.

The compile, render, and comparison steps often require a custom test
page and visual inspection. These tools let an agent run those steps.
Developers who write their own GLSL can use the same tools from a terminal.

Give your model the context pack
--------------------------------

Machine-readable references ship with the project:

- `llms.txt <https://noisemaker.app/llms.txt>`_ — the short public map:
  what Noisemaker is, where the specs live, and the agent tooling.
- `llms-full.txt <https://noisemaker.app/llms-full.txt>`_ — the full
  development contract for agents working in the codebase.
- The `language spec <https://docs.noisemaker.app/shaders/language/>`_,
  `pipeline spec <https://docs.noisemaker.app/shaders/pipeline/>`_, and
  `effect definition spec <https://docs.noisemaker.app/shaders/effects/>`_.
- The `Portable Effects specification
  <https://github.com/noisefactorllc/portable>`_ — format, shader
  requirements, parameters, and a starter effect to work from.
- Every effect carries a structured definition and an entry in the effect
  manifest, so the library is searchable by machine as well as by eye.

For the composition layer, ``llms.txt`` (or its URL) in your agent's
context is sufficient. For effect authoring, add the format
specification and one existing effect directory as a worked example.

Compositions are recipes
------------------------

Models can combine named effects from the library:

- A caustic over cell noise produces an underwater look.
- Julia or mandelbrot provides a fractal zoom.
- Cellular automata and particle simulations produce organic growth.

Browse the `effect library <https://noisemaker.app/demo/shaders/>`_ to see
what the names mean. Ask your model to combine them. If a composition needs
an effect that does not exist, write that effect.
