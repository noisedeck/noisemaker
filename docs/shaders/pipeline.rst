.. _shader-pipeline:

Pipeline Spec
=============

This document outlines the specification for the Noisemaker Rendering Pipeline and effect definition format. It is designed to support complex, multi-pass effects defined declaratively, executed on a unified GPU pipeline supporting either WebGL 2 or WebGPU backends.

1. Core Philosophy
------------------


#. **Declarative Effects:** Effects are ``Effect`` configuration objects that
   declare parameters, textures, shader programs, and passes.
#. **Ordered Execution:** Expansion appends passes in DSL plan, effect-step, and
   definition order; the Pipeline executes that array in the same order.
#. **Multi-Pass By Design:** Effect definitions expand into explicit multi-pass schedules; layering and feedback are first-class.
#. **Backend Agnostic:** The definition format is abstract; the runtime handles the specifics of WebGL 2 vs. WebGPU.
#. **GPU-Resident Intermediates:** Normal pass-to-pass texture flow remains on
   the GPU. Explicit uploads, frame exports, and readback APIs cross the CPU/GPU
   boundary when requested.
#. **Compute First:** First-class support for compute shaders (native in WebGPU, emulated via GPGPU in WebGL 2).

----

2. Pipeline Architecture
------------------------

The pipeline consists of three main phases:

Phase 1: Compilation (Source to Compiled Graph)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Occurs when the DSL code changes. See :ref:`Compiler Specification <shader-compiler>` for the detailed specification of this phase.


#. **Parse DSL:** Generate AST.
#. **Analyze:** Resolve namespaces and parameters into validated planned chains.
#. **Expand Effects:** Append each planned effect's constituent passes and
   collect its program and texture specifications.
#. **Scope State Textures:** Effects that maintain simulation state use ``global_*`` textures (e.g., ``global_rd_state``, ``global_ca_state``, ``global_accum``). During expansion, these are scoped per-chain (e.g., ``global_rd_state_chain_0``) so that multiple instances of the same stateful effect in separate chains get independent state. Particle textures (``global_xyz``, ``global_vel``, etc.) are further scoped per-pipeline to the node that creates them. Effects within the same chain share state, which is required for patterns like ``loopBegin``/``loopEnd`` that share ``global_accum``.
#. **Resource Analysis:** Determine the first and last use of each non-global
   virtual texture and compute a linear-scan allocation map.
#. **Assemble:** Package the ordered passes, programs, allocation map, texture
   specs, render surface, source, source hash, and timestamp.

Phase 2: Pipeline Initialization
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Occurs before execution and revisits texture allocation when dimensions change.


#. **Backend Initialization:** Initialize WebGL 2 or WebGPU.
#. **Program Compilation:** Resolve each unique program referenced by the pass
   list and compile it with the selected backend.
#. **Texture Creation:** Resolve graph texture dimensions and create ordinary
   textures plus double-buffered global surfaces. The current Pipeline creates
   textures by virtual ID; it does not consume the compiler's allocation map as
   a backend texture pool.

Phase 3: Execution (GPU Driver)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Occurs every frame.


#. **Update Globals:** Refresh runtime uniforms sourced from the implementation: ``time`` (seconds since start), ``deltaTime`` (frame-to-frame delta), ``frame`` (integer tick), ``resolution`` (``vec2`` pixels), and ``aspect`` (width ÷ height).
#. **Iterate Passes:** Walk ``graph.passes`` in compiler-produced order.
#. **Dispatch:**

   * **WebGL 2:**

     * Activate the compiled ``WebGLProgram`` for the pass and resolve the target framebuffer (global surfaces map to the current write buffer).
     * Derive the viewport from the target texture dimensions (or the pass override) and bind it before issuing work.
     * Bind each declared input texture to successive texture units and upload merged uniforms from ``globalUniforms`` + pass uniforms via ``gl.uniform*``.
     * Configure blending if the pass requests it, then issue either ``gl.drawArrays(gl.TRIANGLES, 0, 3)`` for the default full-screen triangle or ``gl.drawArrays(gl.POINTS, ...)`` when ``drawMode == 'points'``.

   * **WebGPU:**

     * Create a command encoder at frame start, then for each pass resolve the output texture view (respecting double-buffer swaps).
     * Reflect the program's supported group-0 bindings and create entries for
       its declared textures, selected samplers, storage resources, and either
       a packed struct buffer or individual uniform buffers.
     * Render passes load an existing target by default and clear it only when
       ``pass.clear`` is set, then bind the pipeline/group and issue the
       requested draw.
     * Compute passes begin a compute pass, set the compute pipeline/bind group, and dispatch ``passEncoder.dispatchWorkgroups(...)`` using explicit ``workgroups`` or dimensions derived from the output texture.

----

3. Backend Specifics
--------------------

3.1 WebGL 2 Implementation
^^^^^^^^^^^^^^^^^^^^^^^^^^


* **Render Passes:** Standard ``drawArrays`` into Framebuffer Objects (FBOs).
* **GPGPU Fallbacks:** Effects that use native WebGPU compute provide separate
  GLSL fragment programs for WebGL. Storage-texture or ``outputBuffer`` passes
  are remapped to framebuffer outputs before the fallback program is drawn.

3.2 WebGPU Implementation
^^^^^^^^^^^^^^^^^^^^^^^^^


* **Render Passes:** Native ``RenderPipeline``.
* **Compute Programs:** WGSL sources containing ``@compute`` and no
  ``@fragment`` compile to native ``ComputePipeline`` objects.

  * Supports storage textures and buffers.
  * Supports arbitrary read/write (scatter/gather).

----

4. Constraints & Requirements
-----------------------------


#. **Vanilla JS:** No build steps or transpilers required for the runtime logic.
#. **Context Awareness:** The pipeline must detect ``gl`` vs ``gpu`` context and switch strategies transparently.
#. **Hot Reloading:** Changing the DSL or an Effect Definition must instantly rebuild the graph without reloading the page.
#. **Error Handling:** DSL diagnostics stop compilation, while missing programs,
   textures, or backend resources fail during Pipeline initialization or pass
   execution.

5. Compute Shader Support
-------------------------

There is no pass ``type`` switch in the effect-definition contract. WebGPU
detects a compute program from a WGSL ``@compute`` entry point when the source
has no ``@fragment`` entry point. Cross-backend effects provide both that WGSL
compute implementation and an explicit GLSL render/GPGPU implementation.

5.1 WebGPU (Native)
^^^^^^^^^^^^^^^^^^^


* Each source-detected compute program compiles into a
  ``GPUComputePipeline``. Multi-entry-point programs cache a pipeline per
  selected ``entryPoint``.
* Dispatch shape uses ``workgroups: [x,y,z]`` when supplied. Otherwise the
  backend tries a pass ``size``, the first output texture's dimensions, and
  then the screen dimensions, using ``[ceil(width/8), ceil(height/8), 1]``
  for dimension-derived dispatches. It raises
  ``ERR_COMPUTE_DISPATCH_UNRESOLVED`` if none is available.
* Bindings:

  * Reflected ``@group(0)`` sampled textures, samplers, uniform buffers,
    storage buffers, and storage textures are bound by name from the pass and
    frame state.
  * Uniform bindings use the WGSL reflection and per-binding buffer paths
    described in Section 7.

5.2 WebGL 2 Fallback
^^^^^^^^^^^^^^^^^^^^


* WebGL has no WGSL entry-point detection, compute dispatch, or ``workgroups``
  handling. The effect's GLSL program must implement the equivalent operation
  as a renderable fragment-shader pass.
* Passes using ``storageTextures`` or an ``outputBuffer`` output take the
  backend's GPGPU conversion path, which remaps those outputs to framebuffer
  color attachments and draws the GLSL fallback program. It does not translate
  WGSL invocation built-ins into GLSL.
* Multiple outputs use MRT. Capability and framebuffer failures surface from
  the backend rather than from a compiler-side MRT validator.

5.3 Cross‑Backend Restrictions
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^


* WebGPU capabilities come from the WGSL source and active device; there is no
  ``effect.version`` feature gate. WebGL fallback programs remain limited to
  operations expressible through its render-based path.
* A source-detected WebGPU compute program may precede or follow render
  programs; definition and DSL order determine execution order.
* ``repeat`` may be a fixed number or a uniform name. Repeated writes to global
  surfaces use the Pipeline's frame-local read/write bindings between
  iterations.

----

6. Validation Rules
--------------------

Validation is split across the current implementation:


#. **DSL Parsing:** The parser enforces syntax and the mandatory ``search``
   directive, throwing ``SyntaxError`` for parse failures.
#. **DSL Semantics:** The validator resolves names, chain structure, arguments,
   enums, and automation. It returns ``S001``–``S008`` diagnostics; error-level
   diagnostics become ``ERR_COMPILATION_FAILED`` in ``compileGraph()``.
#. **Expansion:** Missing registered effects or a program with no render/write
   target become ``ERR_EXPANSION_FAILED``.
#. **Effect Harness Validation:** ``validateEffectDefinition()`` checks only the
   required effect name, a non-empty pass list, each pass's program and object
   inputs/outputs, and global parameter types. It returns strings and is used by
   the structure harness; it is not a complete JSON-schema validator.
#. **Backend Validation:** Shader source, binding, program, texture, device-limit,
   and dispatch failures are detected when the Pipeline compiles or executes
   programs.

6.1 Shader Compilation Lifecycle
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``Pipeline.init()`` initializes the backend, walks the ordered pass list, and
compiles each distinct program name once. The expander gives programs
effect-instance-scoped names and includes sorted compile-time define values in
the name, so different define variants receive different backend entries.

During CanvasRenderer recompilation, rendering is paused with ``isCompiling``;
``recompile()`` replaces the graph and recreates graph-dependent textures, then
CanvasRenderer invokes ``compilePrograms()`` before rendering resumes. A DSL or
expansion failure returns ``null`` before the graph swap.

----

7. Resource Lifetime Analysis
-----------------------------

``analyzeLiveness()`` scans the ordered pass array. Every non-global texture
mentioned by an input or output receives a ``{start, end}`` interval spanning
its first and last mention. IDs beginning with ``global_`` are excluded.

``allocateResources()`` then walks the same pass order. It assigns ``phys_N``
slots to previously unseen outputs and releases an input's slot after its last
use. A released slot can be reused only by an output in a later pass. The
resulting ``Map<virtualId, physicalId>`` is stored on the compiled graph.

The current Pipeline does not use that map to pool backend textures: it creates
textures from ``graph.textures`` by virtual ID. Consequently the allocator does
not group by dimensions or formats and has no runtime compaction cycle.

7.1 Binding Slot Assignment
^^^^^^^^^^^^^^^^^^^^^^^^^^^^

**WebGL Texture Units:**


* Slots 0..N assigned sequentially in pass input declaration order.
* The backend resolves global surface IDs through the current frame state and
  binds either 2D or 3D texture targets as required.
* The available-unit limit is checked while binding; overflow raises
  ``ERR_TOO_MANY_TEXTURES`` with the pass id and device limit.

**WebGPU Bind Groups:**

The backend parses WGSL resource declarations and entry-point usage, then
builds entries for supported ``@group(0)`` bindings. It handles sampled
textures, storage textures, storage buffers, samplers, and uniforms according
to each declaration's binding index; other groups are currently skipped.

7.2 Uniform Transport
^^^^^^^^^^^^^^^^^^^^^

Uniform transport is backend-specific. WebGL uploads ordinary active uniforms
and, when an effect provides ``uniformLayout`` metadata for an active uniform
block, packs that block according to the declared 16-byte slots. For WebGPU, a
struct binding receives one packed uniform buffer, while a scalar/vector/matrix
uniform binding receives its own small buffer. The backend recycles those
buffers after submission.

----

8. Surface Management & Frame Buffering
----------------------------------------

8.0 Surface Types
^^^^^^^^^^^^^^^^^

The pipeline provides several types of global surfaces:

**2D Surfaces** (``o0``..``o7``): Standard double-buffered surfaces where reading within a frame sees any writes made earlier in that same frame.

**3D Volume Surfaces** (``vol0``..``vol7``): Persistent 3D texture volumes for volumetric effects. Default size is 64×64×64.

**Geometry Buffers** (``geo0``..``geo7``): Screen-sized 2D textures storing precomputed raymarching results (xyz=surface normal, w=depth). These enable downstream post-processing without re-raymarching.

Global 2D surfaces (``o0``.. ``o7``) defined implicitly:

.. code-block:: js

   surfaceTable = {
     o0: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o1: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o2: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o3: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o4: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o5: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o6: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     o7: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true }
   }

Global 3D volume surfaces (``vol0``.. ``vol7``) defined implicitly:

.. code-block:: js

   volumeTable = {
     vol0: { format: 'rgba16f', width: 64, height: 64, depth: 64, is3D: true },
     vol1: { format: 'rgba16f', width: 64, height: 64, depth: 64, is3D: true },
     // ... vol2 through vol7
   }

Global geometry buffers (``geo0``.. ``geo7``) defined implicitly:

.. code-block:: js

   geoBufferTable = {
     geo0: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     geo1: { format: 'rgba16f', width: 'screen', height: 'screen', doubleBuffered: true },
     // ... geo2 through geo7
   }

**CRITICAL: User-Only Surfaces**

Surfaces ``o0``..``o7``, ``vol0``..``vol7``, and ``geo0``..``geo7`` are **reserved exclusively for user composition** and **MUST NOT** be hardwired within effect definitions. Effects requiring internal feedback or temporary storage must allocate their own internal surfaces (e.g., ``_feedbackBuffer``, ``_temp0``) in their ``textures`` property. Hardwiring these surfaces within an effect definition will corrupt the user's composition graph.

**Terminology:**


* ``doubleBuffered``: The surface has read and write texture IDs. Frame-local
  bindings advance after writes; display surfaces swap at frame end, while
  recognized state surfaces retain their final bindings.

8.0.1 Global Surface Behavior
"""""""""""""""""""""""""""""

At frame start, each surface's current read and write IDs seed frame-local
maps. A chain writing ``.write(o0)`` targets the current write ID. The Pipeline
advances the frame-local binding after the pass, so later reads and writes in
the same frame see the newest content. Multiple writes are supported and are
resolved by this ordered binding update; there is no separate multiwrite
validator.

8.1 Resize Behavior
^^^^^^^^^^^^^^^^^^^^

``Pipeline.resize(width, height)`` updates the output-sink descriptor, then
calls ``createSurfaces()`` and ``recreateTextures()``. Dimension specifications
are resolved against the new screen size and current pass uniforms. A backend
texture is reused when its resolved dimensions still match; otherwise the old
texture is destroyed and recreated. Resizing also restarts asynchronous effect
initialization. The current resize path does not blit old surface content into
newly sized textures or recompile shader programs.

----

9. Execution Order
------------------

There is no dependency DAG or topological sort. ``expand()`` appends passes in
DSL plan order, effect-step order, and each definition's ``passes`` array order.
Built-in read, write, and final blit passes are inserted at the point where the
expander encounters them. ``Pipeline.render()`` walks ``graph.passes`` from
index zero to the end.

For global surfaces, the Pipeline maintains frame-local read and write
bindings. A write updates those bindings so a later pass in the same frame sees
the fresh result; the surface record is swapped or persisted at frame end.

**Dynamic Pass Skipping:**
The Pipeline can evaluate ``conditions`` with ``skipIf`` and/or ``runIf`` on a
pass already present in a graph. The effect expander does not currently copy
``conditions`` from effect pass definitions, so this mechanism is unavailable
to ordinary DSL-compiled effects. On a graph pass that does carry the field,
the runtime compares each condition's named uniform with ``equals`` before
dispatch and skips the pass when the condition says not to run.

9.1 Repeated Passes
^^^^^^^^^^^^^^^^^^^

``repeat`` is copied from the pass definition into the expanded pass. A number
is clamped to an integer of at least one; a string names a global or pass
uniform whose current value supplies that count. The Pipeline executes the same
pass object that many times. After each repeated write to a global surface, it
adopts the new frame-local read/write bindings before the next iteration.

----

10. Uniform & Binding Conventions
---------------------------------


* An effect global's ``uniform`` field names the shader value populated by the
  expander. A pass's resolved uniforms take precedence over same-named runtime
  globals.
* Enum members are resolved to their registered numeric values during semantic
  validation.
* Ordinary uniforms, uniform blocks, samplers, storage buffers, and storage
  textures follow the backend-specific reflection paths described in Section
  7; the runtime does not apply a generic ``u_`` prefix rewrite.

10.1 Pipeline Texture References
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``inputTex`` is the canonical 2D reference to the previous effect's output.
During expansion it resolves to the current virtual input texture. A
non-starter effect cannot begin a chain; the DSL validator reports diagnostic
``S005`` before expansion.

``outputTex`` is the canonical 2D output reference. It resolves to the current
node's virtual output, or directly to the terminal global surface when the last
pass of a writing chain can target that surface. An ordinary undeclared output
texture receives a screen-sized ``rgba16f`` spec in ``compileGraph()``.

The corresponding volumetric references are ``inputTex3d`` and
``outputTex3d``. Geometry and particle pipelines similarly use ``inputGeo`` /
``outputGeo``, ``inputXyz`` / ``outputXyz``, ``inputVel`` / ``outputVel``, and
``inputRgba`` / ``outputRgba``.

----

11. Runtime Error Codes
-----------------------

DSL semantic diagnostics are documented in :ref:`Polymorphic DSL
<shader-language>`. The compiler and backends currently emit these structured
codes:

.. list-table::
   :header-rows: 1

   * - Code
     - Meaning
   * - ERR_COMPILATION_FAILED
     - Semantic validation returned one or more error diagnostics
   * - ERR_EXPANSION_FAILED
     - Planned chains could not be expanded into passes
   * - ERR_PROGRAM_SPEC_MISSING
     - A pass references no program specification during Pipeline initialization
   * - ERR_NO_WGSL_SOURCE
     - A WebGPU program specification contains no usable WGSL source
   * - ERR_PROGRAM_NOT_FOUND
     - A backend cannot find the pass's compiled program
   * - ERR_TEXTURE_NOT_FOUND
     - WebGPU cannot resolve an output texture
   * - ERR_NO_MRT_OUTPUTS
     - A WebGPU MRT pass resolves no color attachments
   * - ERR_COMPUTE_DISPATCH_UNRESOLVED
     - WebGPU cannot infer compute workgroup dimensions
   * - ERR_TOO_MANY_TEXTURES
     - A WebGL pass exceeds available texture units
   * - ERR_UNIFORM_BLOCK_TOO_LARGE
     - A WebGL uniform block exceeds the device limit
   * - ERR_SHADER_COMPILE
     - WebGL or WebGPU shader compilation failed
   * - ERR_SHADER_LINK
     - WebGL shader program linking failed

----

12. Current Performance Behavior
--------------------------------

Graph compilation is synchronous; the implementation does not enforce a pass
count timing target or emit compile-time pool metrics. Normal rendering keeps
intermediate textures on the GPU. Readback occurs only through explicit APIs
such as frame export, cubemap capture, or backend ``readPixels()``.

----

13. Extensibility
-----------------

The current ``Effect`` constructor copies the supported configuration fields
described in :ref:`Effect Definition Spec <shader-effects>`; it does not expose
an ``effect.version`` feature gate. Hosts extend the available language through
effect registration and the namespace registry.

----

14. Runtime Data Structures
---------------------------

14.1 Compiled Graph
^^^^^^^^^^^^^^^^^^^

.. code-block:: typescript

   interface CompiledGraph {
     id: string
     source: string
     passes: ExpandedPass[]
     programs: Record<string, ProgramSpec>
     allocations: Map<string, string>
     textures: Map<string, RuntimeTextureSpec>
     renderSurface: string | null
     compiledAt: number
   }

   interface ExpandedPass {
     id: string
     program: string
     inputs: Record<string, string>
     outputs: Record<string, string>
     uniforms: Record<string, unknown>
     entryPoint?: string
     drawMode?: string
     drawBuffers?: number
     count?: number | string
     countUniform?: string
     repeat?: number | string
     blend?: boolean | [string | number, string | number]
     workgroups?: [number, number, number]
     storageBuffers?: Record<string, unknown>
     storageTextures?: Record<string, string>
     effectKey?: string
     effectFunc?: string
     effectNamespace?: string | null
     nodeId?: string
     stepIndex?: number
   }

14.2 Pipeline State
^^^^^^^^^^^^^^^^^^^

The Pipeline holds the compiled graph, selected backend, output sinks,
double-buffered global surfaces, global uniforms, dimensions, frame-local
surface bindings, external MIDI/audio state, and async-effect cancellation
handles. ``isCompiling`` is the render gate used while backend programs are
being rebuilt; there is no separate effect lifecycle state machine.

14.3 Frame Execution State
^^^^^^^^^^^^^^^^^^^^^^^^^^

.. code-block:: typescript

   interface FrameState {
     frameIndex: number
     time: number
     graph: CompiledGraph
     globalUniforms: Record<string, unknown>
     surfaces: Record<string, BackendTexture>
     writeSurfaces: Record<string, string>
     screenWidth: number
     screenHeight: number
   }

----

15. Determinism Guarantees
--------------------------


* The graph ``id`` is a deterministic base-36 hash of the DSL source string.
* Expansion preserves source plan order, definition pass order, and sorted
  compile-time define names.
* Liveness intervals and ``phys_N`` assignments are deterministic for the same
  expanded pass array.

----

16. Recompilation and Runtime Errors
------------------------------------

16.1 Hot Reload Protocol
^^^^^^^^^^^^^^^^^^^^^^^^

CanvasRenderer sets ``isCompiling`` before invoking ``recompile()``. A source
compile or expansion failure is logged and returns ``null`` before replacing
the existing graph. On success, ``recompile()`` assigns ``pipeline.graph`` and
recreates graph-dependent surfaces and textures; CanvasRenderer then awaits
``compilePrograms()`` before rendering resumes.

16.2 Error Recovery
^^^^^^^^^^^^^^^^^^^

``Pipeline.render()`` logs a pass execution failure with the pass id and
rethrows it; it does not substitute a fallback texture or continue later
passes. Pipeline initialization likewise propagates program compilation and
resource errors after clearing the ``isCompiling`` gate.

----

17. Glossary
-------------


* **AST (Abstract Syntax Tree):** The tree representation of the user's DSL code produced by the Parser.
* **Planned Chain:** The semantic validator's ordered effect steps, connected by
  temporary-value indices.
* **Expanded Pass:** One backend-facing pass emitted from an effect definition,
  with resolved virtual texture bindings and uniforms.
* **Compiled Graph:** The object returned by ``compileGraph()`` containing the
  source, ordered passes, program specs, allocation map, texture specs, render
  surface, and metadata. Backend-compiled programs and physical textures live
  on the Pipeline/backend rather than in this object.
