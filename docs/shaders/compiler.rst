.. _shader-compiler:

Compiler Spec
=============

The Noisemaker Rendering Pipeline compiler transforms high-level Polymorphic
DSL code into a compiled render graph. The runtime then creates a Pipeline from
that graph and asks the selected backend to compile its shader programs.

Compilation Pipeline
--------------------

The compilation process occurs in four distinct stages:


#. **Parsing:** Source Code → Abstract Syntax Tree (AST)
#. **Analysis:** AST → Validated Planned Chains
#. **Expansion:** Planned Chains → Ordered Render Passes and Program Specs
#. **Allocation and Assembly:** Passes → Compiled Render Graph

.. code-block:: text

   graph TD
       A[Source Code] -->|Lexer/Parser| B[AST]
       B -->|Semantic Analyzer| C[Planned Chains]
       C -->|Effect Expander| D[Passes and Program Specs]
       D -->|Resource Allocator| E[Compiled Render Graph]

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
* **Keywords:** ``render``, ``write``, ``write3d``, ``let``, ``if``,
  ``search``, ``subchain``, etc.

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


* **Flat Chains:** The parser represents chains as a flat array of operation
  nodes, not nested ``CallExpression`` objects.
* **Explicit Output:** A ``.write()`` directive is a ``Write`` node in the
  chain. The parser also summarizes the terminal write target in the statement's
  ``write`` property for downstream validation.
* **Separated State:** The parser tracks variable assignments, render
  instructions, and chain plans separately at the root. ``plans`` is an array of
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
  namespace search order for the program. The parser rejects programs without it.
* **Namespace Lookup:** Resolves function names (e.g., ``noise``) to Effect Definitions by searching namespaces in order until it finds a match.
* **Variable Scope:** Tracks ``let`` assignments and resolves variable references.

2.2 Chain Analysis
^^^^^^^^^^^^^^^^^^

Since the AST already represents chains as flat arrays, the analyzer iterates sequentially through the ``chain`` list.


#. **Root Identification:** Identifies the first element of the ``chain`` array as the generator or source.
#. **Operation Creation:** Resolves each ``Call`` node to a namespaced effect
   operation.
#. **Parameter Binding:**

   * Validates arguments against the Effect's ``globals`` schema.
   * Resolves named arguments (``scaleX: 10``) vs positional (``10``).
   * Resolves numeric and boolean literal values and clamps declared ranges.

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

Stage 3: Expansion (Planned Chains → Ordered Passes)
-----------------------------------------------------

This stage lowers the high-level Effects into their constituent GPU Passes.


* **Input:** validated planned chains
* **Output:** ordered passes, program specs, texture specs, and render surface

3.1 Pass Expansion
^^^^^^^^^^^^^^^^^^

For each planned effect operation, the compiler looks up the ``passes`` array
in the Effect Definition.


#. 
   **Texture Mapping:**


   * Maps pipeline references such as ``inputTex`` and ``outputTex`` to virtual
     texture IDs.
   * Prefixes node-local texture names and scopes shared state textures to the
     relevant chain or particle pipeline.
   * Preserves effect texture specifications for runtime dimension resolution.

#. 
   **Pass Generation:**


   * Creates an expanded pass for each entry in ``passes``.
   * Adds passes in planned-chain order and records their virtual texture
     dependencies.
   * Attaches uniforms and compile-time ``defines`` derived from effect globals.

3.2 Program Collection
^^^^^^^^^^^^^^^^^^^^^^

Expansion also collects the GLSL or WGSL source specifications referenced by
each pass. The expander scopes program names to the effect instance. Compile-time
define values form part of the program key so distinct variants do not collide.

The compiler does not compile GPU programs. During Pipeline initialization,
the runtime walks the graph's pass list, resolves each program specification,
and calls the selected backend's ``compileProgram()`` implementation.

----

Stage 4: Allocation and Graph Assembly
--------------------------------------

The final compiler stage assigns reusable logical texture-slot IDs and packages
the ordered pass data for the runtime.


* **Input:** ordered render passes, program specs, and texture specs
* **Output:** compiled render graph

4.1 Resource Allocation
^^^^^^^^^^^^^^^^^^^^^^^

The resource allocator computes each virtual texture's first and last use, then
applies linear-scan allocation to assign ``phys_N`` identifiers. The allocator can reuse a logical slot ID if its prior virtual texture's
lifetime ended in an earlier pass. This produces only a virtual-to-slot map.
It does not create GPU textures or a runtime texture pool.

The allocator omits texture IDs beginning with ``global_`` from the allocation map.

4.2 Graph Assembly
^^^^^^^^^^^^^^^^^^

``compileGraph()`` returns an object with these fields:

- Source hash and original source
- Ordered ``passes`` and collected ``programs``
- Virtual-to-physical ``allocations`` and resolved texture specs
- Selected render surface and compilation timestamp

It does not topologically sort passes or generate a separate GPU command
list. The Pipeline executes passes in the compiler-produced order.

----

Failures and Diagnostics
------------------------

The front end reports semantic issues with the ``S001``–``S008`` diagnostics
documented in :ref:`Polymorphic DSL <shader-language>`. Lexer and parser
failures are JavaScript ``SyntaxError`` instances. The parser rejects a missing
mandatory ``search`` directive. Validation also checks for this directive.

The following structured codes cross the compiler/runtime boundary. This is a
focused list rather than an inventory of every backend-specific capability
error.

.. list-table::
   :header-rows: 1

   * - Code
     - Stage
     - Description
   * - ``ERR_COMPILATION_FAILED``
     - Validation
     - One or more semantic diagnostics have error severity
   * - ``ERR_EXPANSION_FAILED``
     - Expansion
     - Planned chains could not be lowered into passes
   * - ``ERR_PROGRAM_SPEC_MISSING``
     - Pipeline initialization
     - A pass references a program absent from the compiled graph
   * - ``ERR_SHADER_COMPILE``
     - Backend
     - A WebGL or WebGPU shader failed to compile
   * - ``ERR_SHADER_LINK``
     - WebGL backend
     - Compiled WebGL shaders failed to link into a program
