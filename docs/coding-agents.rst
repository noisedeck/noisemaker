Building with coding agents
===========================

Noisemaker is designed to be written by humans and coding agents alike.
Its Polymorphic DSL is compact and declarative: a program describes *what*
to render — effects, parameters, routing — and the engine compiles it into
a GPU render graph for WebGL2 or WebGPU. An agent generating Noisemaker
programs never needs to emit GLSL or WGSL; the engine owns the
backend-specific implementation of every effect.

This page explains how to set up an AI-assisted workflow: what context to
give a model, how the generate–compile–render loop works, and how coding
agents can drive the engine directly over MCP.

Why a DSL instead of raw GLSL?
------------------------------

Asking a language model to generate raw GLSL means asking it to get
per-pixel math, uniform plumbing, and backend quirks right in one shot —
and shader bugs are notoriously silent: the program compiles and renders
the wrong thing.

The Polymorphic DSL moves the model up a level of abstraction. Programs
compose effects from the library — generators, filters, mixers, particles,
simulations — into a render graph:

.. code-block:: text

   search synth
   noise().write(o0)
   render(o0)

The engine handles compilation, resource allocation, multi-pass
scheduling, and the differences between WebGL2 and WebGPU. Errors come
back as structured diagnostics rather than a black screen, which is
exactly what an iterating agent needs.

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
- Every effect carries a structured definition and an entry in the effect
  manifest, so the library is searchable by machine as well as by eye.

Paste ``llms.txt`` (or its URL) into Claude, ChatGPT, Cursor, or your
coding agent's context and ask for a program. That is the whole setup.

The development loop
--------------------

An effective agent workflow is a feedback loop:

1. Give the model the DSL reference and the effect library.
2. Ask for a program — "slow blue plasma with a subtle glow."
3. Compile it with the engine.
4. Render a frame and capture the result.
5. Feed compile diagnostics, image metrics, or the frame itself back to
   the model.
6. Iterate.

Steps 3–5 are the part most frameworks leave to hand-rolled glue. With
Noisemaker they are first-class tool calls — see below.

Drive the engine over MCP
-------------------------

`shade-mcp <https://github.com/noisefactorllc/shade-mcp>`_ is an MCP
server that lets a coding agent operate the engine rather than just write
code for it. Its sixteen tools cover the whole loop:

- **Search and knowledge** — ``searchEffects`` finds effects by concept,
  tag, algorithm, or visual style; ``searchShaderKnowledge`` searches
  curated docs on DSL grammar, GLSL techniques, and common errors;
  ``analyzeEffect`` returns a full definition with shader source.
- **Compile and render** — ``compileEffect`` returns pass-level
  diagnostics; ``runDslProgram`` compiles and executes arbitrary DSL;
  ``renderEffectFrame`` renders a frame and computes image metrics
  (mean RGB, variance, blank/monochrome detection) with optional PNG
  capture.
- **Verification** — ``testUniformResponsiveness``, ``testNoPassthrough``,
  ``testPixelParity``, and ``benchmarkEffectFPS`` check that programs
  actually respond, actually transform, match across backends, and hit
  frame-rate targets.

Configuration snippets for Claude Code, VS Code Copilot, Cursor, and
Windsurf are in the `shade-mcp README
<https://github.com/noisefactorllc/shade-mcp#mcp-client-configuration>`_.

Compositions are recipes
------------------------

Models are good at recombining named ideas, and the effect library is
built for that: an underwater look is a caustic over cell noise; a
fractal zoom starts from julia or mandelbrot; organic growth comes from
cellular automata and the particle simulations. Browse the `effect
library <https://noisemaker.app/demo/shaders/>`_ to see what the names
mean, then ask your model to combine them.
