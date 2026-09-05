.. _shader-pipeline:

Pipeline Spec
=============

This document specifies the Noisemaker Rendering Pipeline and effect definition format. The pipeline supports declarative, multi-pass effects on WebGL 2 and WebGPU backends.

1. Core Philosophy
------------------


#. **Declarative Effects:** Effects are ``Effect`` configuration objects that
   declare parameters, textures, shader programs, and passes.
#. **Ordered Execution:** Expansion appends passes in DSL plan, effect-step, and
   definition order. The Pipeline executes that array in the same order.
#. **Multi-Pass By Design:** Effect definitions expand into explicit multi-pass schedules with direct support for layering and feedback.
#. **Backend Agnostic:** The definition format is abstract. The runtime handles WebGL 2 and WebGPU details.
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

Compilation occurs when the DSL code changes. See :ref:`Compiler Specification <shader-compiler>` for the detailed specification of this phase.


#. **Parse DSL:** Generate the AST.
#. **Analyze:** Resolve namespaces and parameters into validated planned chains.
#. **Expand Effects:** Append each planned effect's constituent passes and
   collect its program and texture specifications.
#. **Scope State Textures:** Effects maintain simulation state in ``global_*`` textures, such as ``global_rd_state``, ``global_ca_state``, and ``global_accum``.
   Expansion scopes these textures per chain, for example ``global_rd_state_chain_0``.
   Instances of the same stateful effect in separate chains therefore have independent state.
   Expansion further scopes particle textures (``global_xyz``, ``global_vel``, etc.) per pipeline to their creating node.
   Effects within a chain share state. Patterns such as ``loopBegin``/``loopEnd`` require this sharing for ``global_accum``.
#. **Resource Analysis:** Determine the first and last use of each non-global
   virtual texture and compute a linear-scan allocation map.
#. **Assemble:** Package the ordered passes, programs, allocation map, texture
   specs, render surface, source, source hash, and timestamp.

Phase 2: Pipeline Initialization
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

The Pipeline initializes before execution and revisits texture allocation when dimensions change.


#. **Backend Initialization:** Initialize WebGL 2 or WebGPU.
#. **Program Compilation:** Resolve each unique program referenced by the pass list.
   Compile it with the selected backend.
#. **Texture Creation:** Resolve graph texture dimensions.
   Create ordinary textures and double-buffered global surfaces.
   The current Pipeline creates textures by virtual ID. It does not use the
   compiler's allocation map as a backend texture pool.

Phase 3: Execution (GPU Driver)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

The Pipeline executes every frame.


#. **Update Globals:** Refresh these runtime uniforms from the implementation:

   - ``time``: seconds since start
   - ``deltaTime``: frame-to-frame delta
   - ``frame``: integer tick
   - ``resolution``: ``vec2`` pixels
   - ``aspect``: width ÷ height

#. **Iterate Passes:** Walk ``graph.passes`` in compiler-produced order.
#. **Dispatch:**

   * **WebGL 2:**

     * Activate the compiled ``WebGLProgram`` for the pass.
       Resolve the target framebuffer. Global surfaces map to the current write buffer.
     * Derive the viewport from the target texture dimensions or the pass override.
       Bind the viewport before issuing work.
     * Bind each declared input texture to successive texture units.
       Upload merged uniforms from ``globalUniforms`` + pass uniforms through ``gl.uniform*``.
     * Configure blending if the pass requests it.
       Issue ``gl.drawArrays(gl.TRIANGLES, 0, 3)`` for the default full-screen triangle.
       When ``drawMode == 'points'``, issue ``gl.drawArrays(gl.POINTS, ...)`` instead.

   * **WebGPU:**

     * Create a command encoder at frame start.
       For each pass, resolve the output texture view with the current double-buffer swaps.
     * Reflect the program's supported group-0 bindings.
       Create entries for its declared textures, selected samplers, and storage resources.
       Create entries for a packed struct buffer or individual uniform buffers, as applicable.
     * Render passes load an existing target by default and clear it only when
       ``pass.clear`` is set. They then bind the pipeline/group and issue the
       requested draw.
     * For a compute pass, begin the pass.
       Set the compute pipeline/bind group.
       Dispatch ``passEncoder.dispatchWorkgroups(...)`` with explicit ``workgroups`` or dimensions derived from the output texture.

----

3. Backend Specifics
--------------------

3.1 WebGL 2 Implementation
^^^^^^^^^^^^^^^^^^^^^^^^^^


* **Render Passes:** Standard ``drawArrays`` into Framebuffer Objects (FBOs).
* **GPGPU Fallbacks:** Effects that use native WebGPU compute provide separate
  GLSL fragment programs for WebGL. The backend remaps storage-texture or ``outputBuffer`` passes to framebuffer
  outputs before drawing the fallback program.

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
* Dispatch shape uses ``workgroups: [x,y,z]`` when supplied. Otherwise, the backend tries dimensions in this order:

  1. The pass ``size``
  2. The first output texture's dimensions
  3. The screen dimensions

  Dimension-derived dispatches use ``[ceil(width/8), ceil(height/8), 1]``. The backend raises
  ``ERR_COMPUTE_DISPATCH_UNRESOLVED`` if none is available.
* Bindings:

  * The backend binds reflected ``@group(0)`` resources by name from the pass
    and frame state. Resources include sampled textures, samplers, uniform
    buffers, storage buffers, and storage textures.
  * Uniform bindings use the WGSL reflection and per-binding buffer paths
    described in Section 7.

5.2 WebGL 2 Fallback
^^^^^^^^^^^^^^^^^^^^


* WebGL has no WGSL entry-point detection, compute dispatch, or ``workgroups``
  handling. The effect's GLSL program must implement the equivalent operation
  as a renderable fragment-shader pass.
* Passes using ``storageTextures`` or an ``outputBuffer`` output use the
  backend's GPGPU conversion path. This path remaps those outputs to framebuffer
  color attachments and draws the GLSL fallback program. It does not translate
  WGSL invocation built-ins into GLSL.
* Multiple outputs use MRT. Capability and framebuffer failures surface from
  the backend rather than from a compiler-side MRT validator.

5.3 Cross‑Backend Restrictions
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^


* WebGPU capabilities come from the WGSL source and active device. There is no
  ``effect.version`` feature gate. WebGL fallback programs remain limited to
  operations expressible through its render-based path.
* A source-detected WebGPU compute program may precede or follow render
  programs. Definition and DSL order determine execution order.
* ``repeat`` may be a fixed number or a uniform name. Repeated writes to global
  surfaces use the Pipeline's frame-local read/write bindings between
  iterations.

----

6. Validation Rules
--------------------

The current implementation validates at these stages:


#. **DSL Parsing:** The parser enforces syntax and the mandatory ``search``
   directive, throwing ``SyntaxError`` for parse failures.
#. **DSL Semantics:** The validator resolves names, chain structure, arguments,
   enums, and automation. It returns ``S001``–``S008`` diagnostics. Error-level
   diagnostics become ``ERR_COMPILATION_FAILED`` in ``compileGraph()``.
#. **Expansion:** Missing registered effects or a program with no render/write
   target become ``ERR_EXPANSION_FAILED``.
#. **Effect Harness Validation:** ``validateEffectDefinition()`` checks only the
   required effect name, a non-empty pass list, each pass's program and object
   inputs/outputs, and global parameter types. The structure harness uses its returned strings. This function is not a
   complete JSON-schema validator.
#. **Backend Validation:** The Pipeline detects failures when it compiles or
   executes programs. These include shader source, binding, program, texture,
   device-limit, and dispatch failures.

6.1 Shader Compilation Lifecycle
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``Pipeline.init()`` initializes the backend, walks the ordered pass list, and
compiles each distinct program name once. The expander gives programs
effect-instance-scoped names and includes sorted compile-time define values in
the name, so different define variants receive different backend entries.

During recompilation, CanvasRenderer pauses rendering with ``isCompiling``.
The ``recompile()`` method replaces the graph and recreates graph-dependent
textures. CanvasRenderer then invokes ``compilePrograms()`` before rendering resumes. A DSL or
expansion failure returns ``null`` before the graph swap.

----

7. Resource Lifetime Analysis
-----------------------------

``analyzeLiveness()`` scans the ordered pass array. Every non-global texture
mentioned by an input or output receives a ``{start, end}`` interval spanning
its first and last mention. The analysis excludes IDs beginning with ``global_``.

``allocateResources()`` then walks the same pass order. It assigns ``phys_N``
slots to previously unseen outputs and releases an input's slot after its last
use. A released slot can be reused only by an output in a later pass. The compiled graph stores the resulting ``Map<virtualId, physicalId>``.

The current Pipeline does not use that map to pool backend textures: it creates
textures from ``graph.textures`` by virtual ID. Consequently the allocator does
not group by dimensions or formats and has no runtime compaction cycle.

7.1 Binding Slot Assignment
^^^^^^^^^^^^^^^^^^^^^^^^^^^^

**WebGL Texture Units:**


* The backend assigns slots 0..N sequentially in pass input declaration order.
* The backend resolves global surface IDs through the current frame state and
  binds either 2D or 3D texture targets as required.
* The backend checks the available-unit limit while binding. Overflow raises
  ``ERR_TOO_MANY_TEXTURES`` with the pass id and device limit.

**WebGPU Bind Groups:**

The backend parses WGSL resource declarations and entry-point usage, then
builds entries for supported ``@group(0)`` bindings. It handles sampled
textures, storage textures, storage buffers, samplers, and uniforms according
to each declaration's binding index. It currently skips other groups.

7.2 Uniform Transport
^^^^^^^^^^^^^^^^^^^^^

Uniform transport is backend-specific. WebGL uploads ordinary active uniforms.
If an effect provides ``uniformLayout`` metadata for an active uniform block,
WebGL packs that block into the declared 16-byte slots. For WebGPU, a
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

Surfaces ``o0``..``o7``, ``vol0``..``vol7``, and ``geo0``..``geo7`` are **reserved exclusively for user composition**.
Effect definitions **MUST NOT** hardwire these surfaces. Hardwiring them will
corrupt the user's composition graph.

Effects that need internal feedback or temporary storage must allocate their
own internal surfaces in ``textures``. Examples include ``_feedbackBuffer``
and ``_temp0``.

**Terminology:**


* ``doubleBuffered``: The surface has read and write texture IDs. Frame-local
  bindings advance after writes. Display surfaces swap at frame end, while
  recognized state surfaces retain their final bindings.

8.0.1 Global Surface Behavior
"""""""""""""""""""""""""""""

At frame start, each surface's current read and write IDs seed frame-local
maps. A chain writing ``.write(o0)`` targets the current write ID. The Pipeline
advances the frame-local binding after the pass, so later reads and writes in
the same frame see the newest content. This ordered binding update supports multiple writes. There is no separate
multiwrite validator.

8.1 Resize Behavior
^^^^^^^^^^^^^^^^^^^^

``Pipeline.resize(width, height)`` updates the output-sink descriptor, then
calls ``createSurfaces()`` and ``recreateTextures()``. The Pipeline resolves dimension specifications against the new screen size
and current pass uniforms. It reuses a backend texture when its resolved
dimensions still match. Otherwise, it destroys and recreates the texture. Resizing also restarts asynchronous effect
initialization. The current resize path does not blit old surface content into
newly sized textures or recompile shader programs.

----

9. Execution Order
------------------

There is no dependency DAG or topological sort. ``expand()`` appends passes in
DSL plan order, effect-step order, and each definition's ``passes`` array order.
The expander inserts built-in read, write, and final blit passes where it
encounters them. ``Pipeline.render()`` walks ``graph.passes`` from
index zero to the end.

For global surfaces, the Pipeline maintains frame-local read and write
bindings. A write updates those bindings so a later pass in the same frame sees
the fresh result. At frame end, the Pipeline swaps or preserves the surface record.

**Dynamic Pass Skipping:**
The Pipeline can evaluate ``conditions`` with ``skipIf`` and/or ``runIf`` on a
pass already present in a graph. The effect expander does not currently copy
``conditions`` from effect pass definitions, so this mechanism is unavailable
to ordinary DSL-compiled effects. For a graph pass with this field, the runtime compares each condition's named
uniform with ``equals`` before dispatch. It skips the pass when the condition
says not to run.

9.1 Repeated Passes
^^^^^^^^^^^^^^^^^^^

The expander copies ``repeat`` from the pass definition into the expanded pass.
A number is clamped to an integer of at least one. A string names a global or
pass uniform whose current value supplies that count. The Pipeline executes the same
pass object that many times. After each repeated write to a global surface, it
adopts the new frame-local read/write bindings before the next iteration.

----

10. Uniform & Binding Conventions
---------------------------------


* An effect global's ``uniform`` field names the shader value populated by the
  expander. A pass's resolved uniforms take precedence over same-named runtime
  globals.
* Semantic validation resolves enum members to their registered numeric values.
* Ordinary uniforms, uniform blocks, samplers, storage buffers, and storage
  textures follow the backend-specific reflection paths described in Section
  7. The runtime does not apply a generic ``u_`` prefix rewrite.

10.1 Pipeline Texture References
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``inputTex`` is the canonical 2D reference to the previous effect's output.
During expansion it resolves to the current virtual input texture. A
non-starter effect cannot begin a chain. The DSL validator reports diagnostic
``S005`` before expansion.

``outputTex`` is the canonical 2D output reference. It resolves to the current node's virtual output. If the last pass of a writing
chain can target the terminal global surface, it resolves directly to that
surface instead. An ordinary undeclared output
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

Graph compilation is synchronous. The implementation does not enforce a timing
target by pass count or emit compile-time pool metrics. Normal rendering keeps
intermediate textures on the GPU. Readback occurs only through explicit APIs
such as frame export, cubemap capture, or backend ``readPixels()``.

----

13. Extensibility
-----------------

The current ``Effect`` constructor copies the supported configuration fields
described in :ref:`Effect Definition Spec <shader-effects>`. It does not expose
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

The Pipeline holds these runtime resources and state:

- The compiled graph and selected backend
- Output sinks and double-buffered global surfaces
- Global uniforms and dimensions
- Frame-local surface bindings
- External MIDI/audio state
- Async-effect cancellation handles

The ``isCompiling`` flag prevents rendering while the backend rebuilds
programs. There is no separate effect lifecycle state machine.

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

CanvasRenderer sets ``isCompiling`` before invoking ``recompile()``. If source compilation or expansion fails, the method logs the failure.
It returns ``null`` before replacing the existing graph. On success, ``recompile()`` assigns ``pipeline.graph`` and
recreates graph-dependent surfaces and textures. CanvasRenderer then awaits
``compilePrograms()`` before rendering resumes.

16.2 Error Recovery
^^^^^^^^^^^^^^^^^^^

``Pipeline.render()`` logs a pass execution failure with the pass id and
rethrows it. It does not substitute a fallback texture or continue later
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
