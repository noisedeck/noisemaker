.. _shader-compiler:

Compiler Spec
=============

The Noisemaker Rendering Pipeline compiler is responsible for transforming high-level Polymorphic DSL code into an executable GPU Render Graph. It bridges the gap between the user's intent (DSL) and the machine's execution model (Pipeline).

Compilation Pipeline
--------------------

The compilation process occurs in four distinct stages:


#. **Parsing:** Source Code → Abstract Syntax Tree (AST)
#. **Analysis:** AST → Planned Chains (Effect Operations)
#. **Expansion:** Planned Chains → Render Graph (Passes)
#. **Assembly:** Render Graph → Execution Plan (Linear Pass Schedule)

.. code-block:: text

   graph TD
       A[Source Code] -->|Lexer/Parser| B[AST]
       B -->|Semantic Analyzer| C[Planned Chains]
       C -->|Effect Expander| D[Render Graph]
       D -->|Resource Allocator| E[Execution Plan]

----

Stage 1: Parsing
----------------

The parser converts the raw string input into a structured tree representation.


* **Input:** ``string`` (e.g., ``search synth`` followed by
  ``noise(scaleX: 10).write(o0)``)
* **Output:** ``ProgramNode`` (AST Root)

1.1 Lexical Analysis
^^^^^^^^^^^^^^^^^^^^

The lexer tokenizes the input, handling:


* Identifiers (``synth``, ``noise``, ``scaleX``, ``o0``)
* Literals (``10``, ``#ff0000``, ``"string"``)
* Operators (``.``, ``(``, ``)``)
* Comments (``//``, ``/* ... */``)
* **Special Tokens:** ``OUTPUT_REF`` (``o0``), ``HEX`` (``#ff0000``).
* **Keywords:** ``out``, ``render``, ``let``, ``if``, etc.

1.2 Syntax Analysis
^^^^^^^^^^^^^^^^^^^

The parser constructs the AST based on the grammar defined in :ref:`Polymorphic DSL <shader-language>`. Unlike traditional ESTree-like structures, the Polymorphic parser produces a specialized AST optimized for the pipeline's needs.

**Abridged AST for ``search synth`` followed by
``noise(scaleX: 10).write(o0)``:**

.. code-block:: json

   {
     "type": "Program",
     "plans": [
       {
         "chain": [
           {
             "type": "Call",
             "name": "noise",
             "args": [],
             "kwargs": {
               "scaleX": { "type": "Number", "value": 10 }
             }
           },
           {
             "type": "Write",
             "surface": { "type": "OutputRef", "name": "o0" }
           }
         ],
         "write": { "type": "OutputRef", "name": "o0" },
         "write3d": null
       }
     ],
     "render": null,
     "namespace": { "searchOrder": ["synth"] }
   }

**Key Structural Differences:**


* **Flat Chains:** Chains are represented as a flat array of operation nodes,
  not nested ``CallExpression`` objects.
* **Explicit Output:** A ``.write()`` directive is a ``Write`` node in the
  chain. A terminal write target is also summarized in the statement's
  ``write`` property for downstream validation.
* **Separated State:** Variable assignments, render instructions, and chain
  plans are tracked separately at the root. ``plans`` is an array of
  ``ChainStmt`` nodes.

----

Stage 2: Analysis (AST → Planned Chains)
-----------------------------------------

This stage resolves symbols, validates types, and constructs namespaced planned
chains for expansion.


* **Input:** ``ProgramNode``
* **Output:** validated planned chains (operations linked by temporary values)

2.1 Symbol Resolution
^^^^^^^^^^^^^^^^^^^^^


* **Search Order Resolution:** The required ``search`` directive defines the
  namespace search order for the program. Programs without it are rejected.
* **Namespace Lookup:** Resolves function names (e.g., ``noise``) to Effect Definitions by walking the search order until a match is found.
* **Variable Scope:** Tracks ``let`` assignments and resolves variable references.

2.2 Chain Analysis
^^^^^^^^^^^^^^^^^^

Since the AST already represents chains as flat arrays, the analyzer iterates sequentially through the ``chain`` list.


#. **Root Identification:** The first element of the ``chain`` array is identified as the generator or source.
#. **Operation Creation:** Resolves each ``Call`` node to a namespaced effect
   operation.
#. **Parameter Binding:**

   * Validates arguments against the Effect's ``globals`` schema.
   * Resolves named arguments (``scaleX: 10``) vs positional (``10``).
   * Coerces types (e.g., ``int`` → ``float``).

2.3 Planned Chain Construction
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Each effect call becomes a planned step. Its ``from`` and ``temp`` fields
represent data flow between operations before the expander lowers them to
render passes.

**Abridged planned step (defaulted arguments omitted):**

.. code-block:: js

   {
     op: "synth.noise",
     args: { scaleX: 10 },
     from: null, // Generator has no input
     temp: 0
   }

----

Stage 3: Expansion (Planned Chains → Render Graph)
---------------------------------------------------

This stage lowers the high-level Effects into their constituent GPU Passes.


* **Input:** validated planned chains
* **Output:** ``RenderGraph`` (Nodes = Passes, Edges = Texture Dependencies)

3.1 Pass Expansion
^^^^^^^^^^^^^^^^^^

For each planned effect operation, the compiler looks up the ``passes`` array
in the Effect Definition.


#. 
   **Texture Allocation:**


   * Resolves internal textures (e.g., ``downsampled``).
   * Creates implicit ``inputColor`` and ``outputColor`` textures if not explicitly defined.
   * Calculates dimensions based on screen size and relative specifiers (e.g., ``50%``).

#. 
   **Pass Generation:**


   * Creates a Render Pass Node for each entry in ``passes``.
   * Maps logical texture names to unique resource IDs (e.g., ``tex_node1_downsampled``).
   * Injects ``defines`` based on static parameters.

3.2 Shader Program Compilation
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

This is where the "Single Effect → GPU Program" transformation happens.


#. **Source Resolution:** Locates the shader file (``.glsl`` or ``.wgsl``) based on the ``program`` key.
#. **Define Injection:** Prepend ``#define`` statements for static configuration.
#. **Backend Transpilation (WebGL only):**

   * For Compute passes, wraps the logic in a full-screen quad vertex shader.
   * Generates the fragment shader boilerplate (uniform declarations).

**Example: Compute Pass Expansion (WebGL)**


* **Input:** User GLSL snippet.
* **Output:** Full Fragment Shader.

  .. code-block:: glsl

     #version 300 es
     precision highp float;
     uniform float u_time;
     // ... injected uniforms ...
     out vec4 fragColor;
     void main() {
       // ... user code ...
     }

----

Stage 4: Assembly (Render Graph → Executable Pipeline)
------------------------------------------------------

The final stage prepares the graph for execution by the runtime.


* **Input:** ``RenderGraph``
* **Output:** ``ExecutionPlan`` (Sorted List of Commands)

4.1 Topological Sort
^^^^^^^^^^^^^^^^^^^^

Orders the passes so that all dependencies are satisfied before a pass is executed.


* **Algorithm:** Kahn's Algorithm.
* **Cycle Detection:** Identifies feedback loops. If a loop is found, it must be broken by a ``persistent`` texture (reading from the previous frame).

4.2 Resource Optimization
^^^^^^^^^^^^^^^^^^^^^^^^^

Performs liveness analysis to minimize VRAM usage.


* **Liveness Interval:** Calculates ``[first_write, last_read]`` for each texture.
* **Pooling:** Assigns physical GPU textures from a shared pool to virtual texture IDs. Two virtual textures with non-overlapping intervals can share the same physical texture.

4.3 Command Generation
^^^^^^^^^^^^^^^^^^^^^^

Generates the linear list of commands for the GPU driver.


* ``SetGlobal(time)``
* ``BindTexture(unit=0, tex=pool_A)``
* ``BindProgram(prog_Bloom)``
* ``Draw()``

----

Error Codes & Stages
--------------------

The following table maps error codes to the compilation stage where they are raised.

.. list-table::
   :header-rows: 1

   * - Code
     - Stage
     - Description
   * - ``ERR_SYNTAX``
     - Parser
     - Malformed DSL syntax (unexpected token, missing brace)
   * - ``ERR_UNKNOWN_IDENT``
     - Analysis
     - Identifier not found in scope
   * - ``ERR_ARG_TYPE``
     - Analysis
     - Argument type mismatch (e.g. string passed to float)
   * - ``ERR_SCHEMA``
     - Validation
     - Effect definition violates JSON schema
   * - ``ERR_DUP_PASS_NAME``
     - Validation
     - Duplicate pass name in Effect definition
   * - ``ERR_BAD_TEX_REF``
     - Validation
     - Input/output references unknown texture/surface
   * - ``ERR_PINGPONG_UNDECL``
     - Validation
     - Ping-pong texture undeclared
   * - ``ERR_ITER_NO_PINGPONG``
     - Validation
     - Iterative pass missing pingpong or self-read unsafe
   * - ``ERR_CYCLE``
     - Assembly
     - Cyclic dependency detected in Render Graph
   * - ``ERR_COMPUTE_UNSUPPORTED_FEATURE``
     - Validation
     - Compute feature not emulatable on WebGL
   * - ``ERR_VIEWPORT_BOUNDS``
     - Assembly
     - Viewport out of target bounds
   * - ``ERR_WORKGROUP_LIMIT``
     - Assembly
     - Workgroup size exceeds device limits
   * - ``ERR_UNIFORM_COERCE``
     - Assembly
     - Uniform value invalid/coercion failed
   * - ``ERR_SURFACE_MULTIWRITE``
     - Assembly
     - Multiple writes to same surface without extension
   * - ``ERR_COMPUTE_MRT_UNSUPPORTED``
     - Validation
     - Multi-render-target compute emulation unsupported
   * - ``ERR_READBACK_FORBIDDEN``
     - Runtime
     - Attempted GPU-to-CPU readback within frame
   * - ``ERR_TOO_MANY_TEXTURES``
     - Assembly
     - Exceeded maximum texture units for backend
   * - ``ERR_DIMENSION_INVALID``
     - Assembly
     - Texture dimension spec invalid
   * - ``ERR_FORMAT_UNSUPPORTED``
     - Assembly
     - Texture format not supported by backend
   * - ``ERR_SHADER_COMPILE``
     - Backend
     - Shader compilation failed (driver error)
   * - ``ERR_SHADER_LINK``
     - Backend
     - Shader program linking failed (driver error)
   * - ``ERR_NO_INPUT``
     - Expansion
     - Non-generator effect missing input
   * - ``ERR_ENUM_INVALID``
     - Validation
     - Unknown enum string provided
   * - ``ERR_CONDITION_SYNTAX``
     - Validation
     - Invalid pass condition entry
   * - ``ERR_CONTROL_FLOW_INVALID``
     - Analysis
     - Break/continue in invalid context
