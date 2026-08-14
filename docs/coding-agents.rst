Building with coding agents
===========================

Noisemaker has two layers, and a coding agent is useful at both.

The **Polymorphic DSL** composes existing effects into a render graph.
The **effect layer** is where effects come from: your own GLSL and WGSL,
wrapped in a definition that declares parameters, passes, and UI. Neither
layer is the "real" one — most sessions move between them, and an agent
earns its keep in both places.

This page covers the workflow for each: what context to give a model, and
how to drive the engine — compile, render, measure, compare backends — as
tool calls rather than hand-rolled glue.

Composing: the DSL layer
------------------------

A DSL program names effects and wires them together. The engine compiles
it to a GPU render graph for WebGL2 or WebGPU, allocates resources, and
schedules the passes:

.. code-block:: text

   search synth
   noise().write(o0)
   render(o0)

Nothing here is shader code, and for a large class of work nothing needs
to be: the library covers generators, filters, mixers, particles, and
simulations, and models are good at recombining named ideas. Errors come
back as structured diagnostics rather than a black screen, which is what
an iterating agent needs.

Authoring: bring your own shaders
---------------------------------

When the effect you want does not exist, you write it. The unit is a
directory — a definition, a fragment shader per backend, and optional
documentation:

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
controls. Clone it, edit the effect directory, run the viewer, package
the result as a zip, and import it with **file → import effect from
zip...**. `Foundry <https://foundry.noisedeck.app/>`_ does the same job
in the browser if you would rather not clone anything. The specification
is still being finalized and may change.

The shader is ordinary fragment shader code. There is no bespoke
dialect and no transpiler in the way — GLSL ES 3.0 reading
``gl_FragCoord`` and writing ``out vec4 fragColor``, WGSL taking
``@builtin(position)`` and returning ``@location(0) vec4<f32>``:

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

The definition beside it declares what the engine cannot infer — the name
the effect takes in the language, the uniforms it binds, the range and
control type each parameter gets in the editor, and how its passes are
wired:

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

That is the entire contract. Once the directory exists,
``gradientSweep()`` is callable from the DSL like any built-in, its
parameters get UI controls, and it runs on both backends. Multi-pass
effects declare intermediate textures and chain passes through them.

Effects that ship inside this repository use the same shape with a
JavaScript definition — ``definition.js`` exporting ``new Effect({...})``
— which adds compile-time defines, global enum references, and lifecycle
hooks for state that persists across frames. The
`effect definition spec <https://docs.noisemaker.app/shaders/effects/>`_
is the reference for that variant, and the effects under
``shaders/effects/`` are two hundred-odd worked examples.

shade-mcp is a shader development harness
-----------------------------------------

`shade-mcp <https://github.com/noisefactorllc/shade-mcp>`_ is where the
authoring loop gets fast. It is not a documentation lookup — it runs a
real Chromium against a real viewer, compiles your shader, renders it,
and measures what came out. The tools exist because shader bugs are
silent: the program compiles, the frame renders, and the image is wrong.

It points at whichever effect library you are working in — this
repository's, a portable effect directory, or your own — so the same
tools serve a contributor and someone who has never cloned Noisemaker.

**Compile and see the frame**

- ``compileEffect`` — compiles an effect and returns pass-level
  diagnostics, so a failure names the pass and the line rather than
  producing a black canvas. Takes a glob or CSV to sweep a whole library.
- ``renderEffectFrame`` — renders a frame and computes image metrics:
  mean RGB, variance, blank and monochrome detection. Optional PNG
  capture. "It rendered" and "it rendered something" are different
  answers, and this gives the second one.
- ``describeEffectFrame`` — sends the rendered frame to a vision model
  and describes it. The check for "is this what I meant" that no numeric
  metric performs.
- ``runDslProgram`` — compiles and executes arbitrary DSL, for exercising
  a new effect in composition rather than in isolation.

**Keep the WebGL2 and WebGPU halves honest**

Writing an effect twice is the part of this layer that actually hurts,
and it has the most tool support:

- ``testPixelParity`` — renders the same effect on both backends and
  diffs it pixel by pixel within an epsilon you choose. A ported branch
  that reads one texel off shows up as a percentage, not as a vague sense
  that WebGPU looks different.
- ``checkEffectStructure`` — the linter for the definition layer: a GLSL
  program with no WGSL counterpart, shader files nothing references,
  uniforms declared but never bound, reserved words, names that shadow
  builtins, naming that breaks convention.
- ``compareShaders`` — static structural comparison of a GLSL/WGSL pair:
  function names, uniforms, line counts.
- ``checkAlgEquiv`` — semantic comparison of the same pair by a model,
  ignoring syntax, returning ``equivalent`` or ``divergent`` with its
  confidence and specific concerns.

**Verify behaviour, not just output**

- ``testUniformResponsiveness`` — drives every uniform and reports which
  ones changed the image. Catches the parameter that is wired to the UI
  but not to the shader.
- ``testNoPassthrough`` — asserts a filter actually modifies its input.
- ``benchmarkEffectFPS`` — frame rate, jitter, and frame timing against a
  target.
- ``analyzeBranching`` — flags branching that costs more than it saves.

**Find things**

``searchEffects`` by concept, tag, algorithm, or visual style;
``searchShaderSource`` by regex across every effect's GLSL, which is how
you find the effects that already implement the hash you were about to
write; ``analyzeEffect`` for a full definition plus shader source;
``searchShaderKnowledge`` over curated notes on DSL grammar, GLSL
techniques, and common errors; ``generateManifest`` to re-scan an effects
directory after adding one.

Client configuration for Claude Code, VS Code Copilot, Cursor, and
Windsurf, plus the environment variables that point it at your effects
directory and viewer, are in the `shade-mcp README
<https://github.com/noisefactorllc/shade-mcp#mcp-client-configuration>`_.

The development loop
--------------------

Composing and authoring run the same loop; only the artifact differs.

1. Describe what you want. For composition that is a DSL program; for a
   new effect it is the shader plus its definition.
2. Compile. Diagnostics come back structured, per pass.
3. Render a frame and capture metrics — or the image itself.
4. If the effect ships both backends, diff them.
5. Feed the diagnostics, metrics, parity report, or frame back and
   iterate.

Steps 2–4 are the part most shader work leaves to a hand-rolled test
page, a screenshot, and an eyeball. As tool calls they close the loop for
a coding agent — and they are just as usable from a terminal by someone
who writes every line of GLSL themselves.

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
context is the whole setup. For effect authoring, add the format
specification and one existing effect directory as a worked example.

Compositions are recipes
------------------------

Models are good at recombining named ideas, and the effect library is
built for that: an underwater look is a caustic over cell noise; a
fractal zoom starts from julia or mandelbrot; organic growth comes from
cellular automata and the particle simulations. Browse the `effect
library <https://noisemaker.app/demo/shaders/>`_ to see what the names
mean, then ask your model to combine them — and when the recipe runs out,
write the effect the recipe was missing.
