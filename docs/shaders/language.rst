.. _shader-language:

Polymorphic DSL
===============

Polymorphic is the high-level language for the Noisemaker Rendering Pipeline. It supports live-coded visuals through function chains that evaluate to native shader graphs. The DSL lets users define complex, multi-pass effects declaratively.

The language compiles to an ordered array of render passes that the GPU executes.
Each valid program must write its generator chains to explicit outputs.
These outputs let the pipeline connect passes and manage double-buffered
surfaces deterministically.

Grammar
-------

.. code-block:: none

   Program        ::= SearchDirective Statement* RenderDirective?
   SearchDirective::= 'search' Ident ( ',' Ident )*
   Statement      ::= VarAssign | ChainStmt | IfStmt | Break | Continue | Return
   RenderDirective::= 'render' '(' OutputRef ')'
   Block          ::= '{' Statement* '}'
   IfStmt         ::= 'if' '(' Expr ')' Block ('elif' '(' Expr ')' Block)* ('else' Block)?
   Break          ::= 'break'
   Continue       ::= 'continue'
   Return         ::= 'return' Expr?
   VarAssign      ::= 'let' Ident '=' Expr
   ChainStmt      ::= Chain
   Chain          ::= ChainElement ( '.' ChainElement )*
   ChainElement   ::= Call | WriteCall | Write3DCall | SubchainCall
   SubchainCall   ::= 'subchain' '(' ArgList? ')' '{' ( '.' Call )+ '}'
   WriteCall      ::= 'write' '(' OutputRef ')'
   Write3DCall    ::= 'write3d' '(' ( VolRef | Ident ) ',' ( GeoRef | Ident ) ')'
   Expr           ::= Chain | NumberExpr | String | Boolean | Color | Ident | Member | OutputRef | SourceRef | VolRef | GeoRef | XyzRef | VelRef | RgbaRef | MeshRef | Func | '(' Expr ')'
   Call           ::= Ident '(' ArgList? ')'
   ArgList        ::= Arg ( ',' Arg )* ','?
   Arg            ::= NumberExpr | String | Boolean | Color | Ident | Member | OutputRef | VolRef | GeoRef | XyzRef | VelRef | RgbaRef | MeshRef | Func
   NumberExpr     ::= Number | 'Math.PI' | '(' NumberExpr ')' | NumberExpr ( '+' | '-' | '*' | '/' ) NumberExpr
   Member         ::= Ident ( '.' Ident )+
   Func           ::= '(' ')' '=>' Expr
   OutputRef      ::= 'o' Digit+
   VolRef         ::= 'vol' Digit+
   GeoRef         ::= 'geo' Digit+
   XyzRef         ::= 'xyz' Digit+
   VelRef         ::= 'vel' Digit+
   RgbaRef        ::= 'rgba' Digit+
   MeshRef        ::= 'mesh' Digit+
   SourceRef      ::= 's' Digit+
   Ident          ::= Letter ( Letter | Digit | '_' )*
   Number         ::= Digit+ ( '.' Digit+ )?
   String         ::= '"' [^"\n]* '"' | '"""' .* '"""'
   Digit          ::= '0'…'9'
   Letter         ::= 'A'…'Z' | 'a'…'z'
   Boolean        ::= 'true' | 'false'
   Color          ::= '#' HexDigit HexDigit HexDigit ( HexDigit HexDigit HexDigit )? ( HexDigit HexDigit )?
   HexDigit       ::= Digit | 'A'…'F' | 'a'…'f'

**Precedence & Associativity:**


* ``*``, ``/`` have higher precedence than ``+``, ``-``.
* Operators are left-associative.
* Parentheses ``()`` override precedence.

**Output Materialization:**


* Any chain that begins with a generator **must** terminate with ``.write(<surface>)``. Omitting the terminal ``.write()`` yields diagnostic ``S006``.
* A chain that extends an existing surface may omit ``.write()`` only inside another chain that eventually writes to a surface.
  For example, an extending chain can read through ``read(o0)`` and apply additional nodes.

**Chainable Writes:**


* ``.write(<surface>)`` can appear **anywhere** in a chain, including mid-chain.
* A mid-chain ``.write()`` writes the current result to the specified surface.
  It **passes the texture through** to the next node.
* Multiple ``.write()`` calls in a single chain write to multiple surfaces.
* **Chains must still terminate with** ``.write()`` — mid-chain writes alone are not sufficient.
* Example: ``noise().write(o0).blur().write(o1)`` writes the noise to ``o0``, then blurs and writes the result to ``o1``.

**Generators:**
An effect chain that creates new content starts with a generator. The passes in a generator consume none of the pipeline inputs that
``isStarterEffect()`` recognizes:

- ``inputTex``
- ``inputTex3d``
- Direct surface references ``o0`` through ``o7``

The ``read()`` and ``read3d()`` operations are separate
built-in ways to start from existing surfaces.


* Generator examples (non-exhaustive): ``noise``, ``solid``, ``media``.
* Pass inputs determine generator classification. An effect may declare
  explicit non-pipeline inputs and still be a generator.

**Colors:**
Hex colors support 3, 6, or 8 digits: ``#RGB``, ``#RRGGBB``, ``#RRGGBBAA``. Alpha defaults to ``FF`` (1.0) if omitted.

**Strings:**
Strings use double quotes: ``"hello"``. For multi-line strings, use triple quotes: ``"""line1\nline2\nline3"""``. Triple-quoted strings preserve embedded newlines. This is useful for the ``text`` effect:

.. code-block:: none

  noise().text(text: """Hello
  World""").write(o0)

**Arrow Functions:**
Arrow functions currently support only zero-argument expression lambdas: ``() => expr``. Their primary use is deferred evaluation in control structures or future callbacks.

Language Features
-----------------

Functions & Arguments
^^^^^^^^^^^^^^^^^^^^^

Functions accept arguments either positionally or as named keywords. The two
forms are mutually exclusive within a single call, except for the special
``midi()`` and ``audio()`` value calls documented under `Live Input`_.

**Positional arguments:**

.. code-block:: none

  noise(10, 2, 50)

**Keyword arguments:**

.. code-block:: none

  noise(type: 10, octaves: 2, scaleX: 50)

Numeric arguments support inline arithmetic (``+``, ``-``, ``*``, ``/``) and constants like ``Math.PI``. Color arguments accept unquoted ``#RGB`` or ``#RRGGBB`` hex codes.

**Vector parameters:**

Some effects accept multi-component vector parameters. Use the built-in vector constructors:

* ``vec2(x, y)`` — 2-component vector
* ``vec3(x, y, z)`` — 3-component vector
* ``vec4(x, y, z, w)`` — 4-component vector

.. code-block:: none

  effect(param: vec2(0.5, 0.25)).write(o0)

**Array literals:**

Array literals contain comma-separated numbers in square brackets. They
provide an additional input form for any vector-valued argument. The parser
and validator handle them like ``vec2()``, ``vec3()``, and ``vec4()``.
The unparser preserves the ``[…]`` form through a parse → unparse cycle.
Vector constructor calls remain unchanged. They remain the canonical form
for programs that already use them.

.. code-block:: none

  effect(param: [0.5, 0.25]).write(o0)
  effect(quad: [0.05, 0.05, 0.45, 0.95]).write(o0)

Elements may be any numeric expression (negative numbers, arithmetic,
``Math.PI``). The validator does not enforce array length. It passes every declared
element to the runtime.

Variables & Aliases
^^^^^^^^^^^^^^^^^^^

Programs may declare variables with ``let`` and reuse them. Variables can alias functions or capture partial applications.

.. code-block:: none

  let pattern = noise
  pattern(10).write(o0)

**Semantics:**


* ``let x = noise``: ``x`` becomes an alias for the ``noise`` function.
* ``let y = noise(10)``: ``y`` stores a **partial application** with ``type``
  set to ``10``. It does *not* execute the effect.
* ``y(2)``: Creates a new Effect Instance by appending ``octaves: 2`` to the
  stored positional arguments. The original ``y`` remains unchanged
  (immutable).

Partials
^^^^^^^^

Invoking variables that store function calls merges stored arguments with call-site arguments.

.. code-block:: none

  let tuned = noise(type: 10, scaleX: 25)
  tuned(scaleX: 50).write(o0)

**Merge Rules:**


* **Positional Arguments:** Appended to the stored arguments.
* **Named Arguments:** Merged with stored arguments. **Call-site arguments override stored arguments** if keys conflict.
* **Duplicate Keys:** If a call provides a named argument multiple times, the last value wins.

Control Flow
^^^^^^^^^^^^

The language supports ``if``, ``elif``, ``else`` for conditionals.

.. note::

  The parser and validator support control flow syntax, but the runtime does not yet execute branches. Programs using these constructs will not execute until the pipeline gains full support.

**Arrow Functions:**
Arrow functions (``() => expr``) are **lazy expressions**. The evaluator passes them unchanged to the effect or control structure without evaluating them immediately. That recipient determines when or whether to evaluate them.

Subchains
^^^^^^^^^

Subchains group contiguous effects within a chain. Each group forms one unit that you can identify, manipulate, and reason about.

**Syntax:**

.. code-block:: none

   .subchain(name: "group name", id: "unique_id") {
     .effect1()
     .effect2(param: value)
   }

**Arguments:**

* ``name`` (optional): A human-readable label for the subchain.
* ``id`` (optional): A unique identifier for programmatic access.

You can omit both arguments or pass ``name`` as a positional argument.

**Examples:**

.. code-block:: none

   search synth, filter, render

   noise()
     .subchain(name: "feedback loop", id: "fb1") {
       .loopBegin()
       .loopEnd()
     }
     .subchain(name: "color grading") {
       .colorspace()
       .hs(rotation: 180, saturation: 0.5)
     }
     .write(o0)

   render(o0)

**Rules:**

* Subchains cannot be empty—they must contain at least one effect.
* Subchains cannot be the first element in a chain. They require input from a preceding effect.
* Effects inside subchains cannot be generators (e.g., ``noise()``, ``solid()``).
* Subchains are chainable—the output flows through to subsequent effects after the closing brace.
* Effects inside subchains use the same argument syntax as regular chain effects.

**Use Cases:**

* Grouping related effects for organizational clarity.
* Marking effect groups for UI controls or programmatic manipulation.
* Defining reusable patterns within complex compositions.
* Enabling downstream tools to identify and operate on logical effect groups.

Namespaces
----------

Polymorphic supports a namespace system to organize effects and ensure compatibility.

Built-in I/O
^^^^^^^^^^^^

Pipeline-level I/O operations are globally available. A program still requires
a ``search`` directive, but these operations do not require an ``io`` entry in
its search order:

* ``read(surface)``: Read from a 2D surface (e.g., ``read(o0)``)
* ``write(surface)``: Write to a 2D surface (e.g., ``.write(o0)``)
* ``read3d(vol, geo)``: Read from 3D volume and geometry buffers
* ``write3d(vol, geo)``: Write to 3D volume and geometry buffers
* ``render(surface)``: Set the final render output (program directive)

``render3d()`` is an effect in the ``render`` namespace, not a built-in I/O
operation.

New Namespaces
^^^^^^^^^^^^^^

These namespaces are actively developed and maintained:

* ``synth``: 2D generator effects that create patterns from scratch (noise, shapes, fractals)
* ``filter``: 2D single-input effects that transform images (blur, color adjustment, distortion)
* ``mixer``: Two-input effects that combine images (blend modes, compositing)
* ``render``: Rendering utilities and feedback loops (render3d, pointsEmit, pointsRender, loopBegin/End)
* ``points``: Particle and agent-based simulations (physarum, life, flock, flow)
* ``synth3d``: 3D volumetric generators (noise3d, cell3d, cellularAutomata3d, reactionDiffusion3d)
* ``filter3d``: 3D volumetric processors (flow3d, palette3d)

Classic Namespaces
^^^^^^^^^^^^^^^^^^

The following namespaces contain ports from older versions of our products. They supplement the actively developed and maintained namespaces above. Each namespace offers a different approach to runtime composition.

* ``classicNoisedeck``: These are complex and often slower shaders brought over from the "Classic" Noisedeck.app shader graph.

Custom Namespaces
^^^^^^^^^^^^^^^^^

External integrations can introduce their own top-level namespace at runtime via the ``registerNamespace()`` API, alongside the built-ins listed above. After registration, the ``search`` directive accepts the new id. The namespace behaves like any built-in namespace. The reserved ``user`` namespace is also available without registration for ad-hoc effects.

See :doc:`integration` for the full API: ``registerNamespace(id, descriptor)``, ``unregisterNamespace(id)``, and validation rules.

Search Order
^^^^^^^^^^^^

Every program **must** begin with a ``search`` directive that defines the namespace resolution order. The language requires an explicit search order and has no implicit defaults.

.. code-block:: none

  search synth, filter
  noise().translate().write(o0)

For a call such as ``noise()``, the compiler searches namespaces in order
(``synth``, then ``filter``) until it finds a matching effect.

**Resolution Rules:**

#. **Mandatory Search Directive:** Every program must start with ``search <namespace>, ...`` to specify which namespaces to search and in what order.
#. **Unqualified Identifiers:** Calls like ``noise()`` search namespaces in order until they find a matching effect.
#. **Overrides:** The ``from(ns, fn())`` helper allows sourcing an operation from a specific namespace temporarily (e.g., ``from(synth, noise())``).

**Note:** Inline namespace prefixes (e.g., ``synth.noise()``) are **forbidden** in program chains. Use the ``search`` directive or ``from()`` helper instead.

Enums
-----

Many function arguments accept enumerated options defined in a global registry. The ``std_enums.js`` file defines enums at the top level as global categories (e.g., ``color``, ``blend``, ``wrap``).

For example, the ``noise`` effect accepts a ``colorMode`` parameter with values from the global ``color`` enum. You can reference enum values in three ways:


* **Shorthand identifier:** ``colorMode: rgb`` (validator auto-prefixes to ``color.rgb``)
* **Full path:** ``colorMode: color.rgb``
* **Member expression:** ``let mode = color.mono; noise(colorMode: mode).write(o0)``

The runtime resolves these enum references to their integer counterparts before binding to the shader.

Palettes
--------

The ``palette`` enum provides named color palettes for effects like ``palette()`` in the ``filter`` namespace. Palettes are cosine gradient functions that map scalar values (typically luminance) to RGB colors.

**Usage:**

.. code-block:: none

   search filter
   read(o0).palette(paletteIndex: vaporwave).write(o1)

**Available Palettes:**

.. list-table::
   :header-rows: 1

   * - Name
     - Description
   * - ``none``
     - Neutral (grayscale)
   * - ``grayscale``
     - Grayscale gradient
   * - ``afterimage``
     - Warm afterimage effect
   * - ``barstow``
     - Desert sunset tones
   * - ``bloob``
     - Cool cyan and blue
   * - ``blueSkies``
     - Sky blue gradient
   * - ``brushedMetal``
     - Metallic gray tones
   * - ``burningSky``
     - Fiery orange and purple
   * - ``california``
     - Warm sunset colors
   * - ``columbia``
     - Bright magenta and cyan
   * - ``cottonCandy``
     - Soft pink and blue pastels
   * - ``darkSatin``
     - Dark smooth gradient
   * - ``dealerHat``
     - Warm orange and brown
   * - ``dreamy``
     - Soft dream-like tones
   * - ``eventHorizon``
     - Deep space blues
   * - ``fiveG``
     - Vibrant tech colors
   * - ``ghostly``
     - Pale ethereal tones
   * - ``hazySunset``
     - Warm hazy oranges
   * - ``heatmap``
     - Thermal imaging colors
   * - ``hypercolor``
     - Bright neon colors
   * - ``jester``
     - Bold contrasting hues
   * - ``justBlue``
     - Pure blue channel
   * - ``justCyan``
     - Pure cyan (green + blue)
   * - ``justGreen``
     - Pure green channel
   * - ``justPurple``
     - Pure magenta (red + blue)
   * - ``justRed``
     - Pure red channel
   * - ``justYellow``
     - Pure yellow (red + green)
   * - ``mars``
     - Rusty red planet tones
   * - ``modesto``
     - Earthy green and purple
   * - ``moss``
     - Forest green and brown
   * - ``neptune``
     - Deep ocean blues
   * - ``netOfGems``
     - Jewel-toned purples
   * - ``organic``
     - Natural earthy tones
   * - ``papaya``
     - Tropical orange
   * - ``radioactive``
     - Toxic green glow
   * - ``royal``
     - Deep purple royalty
   * - ``santaCruz``
     - Beach sunset colors
   * - ``seventiesShirt``
     - Retro 70s colors
   * - ``sherbet``
     - Citrus orange and pink
   * - ``sherbetDouble``
     - Double-frequency sherbet
   * - ``silvermane``
     - Silver metallic (OkLab)
   * - ``skykissed``
     - Soft pink sky
   * - ``solaris``
     - Solar flare oranges
   * - ``spooky``
     - Halloween orange and black (OkLab)
   * - ``springtime``
     - Fresh spring pastels
   * - ``sproingtime``
     - Bright spring greens
   * - ``sulphur``
     - Yellow sulfur tones
   * - ``summoning``
     - Dark ritual magenta
   * - ``superhero``
     - Bold comic book colors
   * - ``toxic``
     - Poisonous green
   * - ``tropicalia``
     - Tropical paradise (OkLab)
   * - ``tungsten``
     - Cool tungsten lighting
   * - ``vaporwave``
     - 80s synthwave aesthetic
   * - ``vibrant``
     - High saturation colors
   * - ``vintage``
     - Aged photograph tones
   * - ``vintagePhoto``
     - Sepia photo effect

Oscillators
-----------

Oscillators are objects that generate deterministic, time-varying values for
animating effect parameters. When the other fields are literal or
boundary-matched, a whole-number literal ``speed`` produces a seamless repeat
at the animation boundary. Fractional or automated speeds do not guarantee one.

Creating Oscillators
^^^^^^^^^^^^^^^^^^^^

Use the ``osc()`` function to create an oscillator:

.. code-block:: none

   osc(type: oscKind.sine)

**Parameters:**

.. list-table::
   :header-rows: 1

   * - Parameter
     - Type
     - Default
     - Description
   * - type
     - oscKind
     - ``oscKind.sine``
     - Oscillator waveform type
   * - min
     - number or automation
     - 0
     - Minimum normalized output (0–1)
   * - max
     - number or automation
     - 1
     - Maximum normalized output (0–1)
   * - speed
     - number or automation
     - 1
     - Loop speed multiplier. Automated values map to -20..20.
   * - offset
     - number or automation
     - 0
     - Phase offset in cycles. Automated values map to -1..1.
   * - seed
     - number or automation
     - 1
     - Random seed (noise type only)

**Oscillator Types (oscKind):**

* ``oscKind.sine`` - Smooth sine wave: 0 → 1 → 0
* ``oscKind.tri`` - Linear triangle wave: 0 → 1 → 0
* ``oscKind.saw`` - Sawtooth wave: 0 → 1
* ``oscKind.sawInv`` - Inverted sawtooth: 1 → 0
* ``oscKind.square`` - Square wave: 0 or 1
* ``oscKind.noise`` - Periodic noise (seamlessly looping)

Usage Examples
^^^^^^^^^^^^^^

**Basic oscillating parameter:**

.. code-block:: none

   search synth
   noise(scaleX: osc(type: oscKind.sine, min: 0.1, max: 0.8)).write(o0)

**Using variables for reusable oscillators:**

.. code-block:: none

   search synth
   let horizontalScale = osc(type: oscKind.sine, min: 0.1, max: 0.8)
   let verticalScale = osc(type: oscKind.saw, min: 0.2, max: 1)
   noise(scaleX: horizontalScale, scaleY: verticalScale).write(o0)

**Speed control for synchronized loops:**

.. code-block:: none

   search synth
   // speed: 2 means the oscillator completes 2 cycles per animation loop
   noise(scaleX: osc(type: oscKind.tri, min: 0.1, max: 1, speed: 2)).write(o0)

**Phase offset for staggered animations:**

.. code-block:: none

   search synth
   let horizontalScale = osc(type: oscKind.sine, offset: 0)
   let verticalScale = osc(type: oscKind.sine, offset: 0.25)
   noise(scaleX: horizontalScale, scaleY: verticalScale).write(o0)

**Noise oscillator with seed:**

.. code-block:: none

   search synth
   noise(scaleX: osc(type: oscKind.noise, min: 0.1, max: 0.8, seed: 42)).write(o0)

Runtime Behavior
^^^^^^^^^^^^^^^^

The pipeline evaluates oscillators each frame from the current animation time. It normalizes time to a 0..1 range over the animation duration (default 10 seconds). It applies the speed multiplier and offset before computing the waveform value.

The oscillator's ``min`` and ``max`` are normalized percentages. The receiving
effect parameter maps that normalized value onto its own declared range. For
example, ``min: 0.1, max: 0.8`` traverses 10%–80% of that parameter's range.
The bounds are not absolute parameter values.

Live Input
----------

Use ``midi()`` and ``audio()`` to drive parameters from external signals. Like
``osc()``, both return normalized values that the receiving effect parameter
maps onto its own range. Their numeric fields can also contain other automation
descriptors.

``midi(channel, mode?, min?, max?, sensitivity?, name: "...", id: "...")``

* ``channel`` (required): MIDI channel 1-16
* ``mode``: ``midiMode.*`` value (default ``midiMode.velocity``)
* ``min`` / ``max``: Number or automation setting the normalized bounds (default 0..1)
* ``sensitivity``: Number or automation setting trigger falloff (default 1)
* ``name`` / ``id``: Optional keyword-only input selector. The ``id`` field requires ``name``.

``audio(band, min?, max?, channel: N, name: "...", id: "...")``

* ``band`` (required): ``audioBand.low``, ``audioBand.mid``, ``audioBand.high``,
  ``audioBand.vol``, or ``audioBand.raw``
* ``min`` / ``max``: Number or automation setting the normalized bounds (default 0..1)
* ``channel`` / ``name`` / ``id``: Optional keyword-only device selector. A
  selected source requires ``channel`` and ``name``. The ``id`` field requires
  ``name``.

Example:

.. code-block:: none

   search synth
   let floor = audio(band: audioBand.low)
   let rate = midi(channel: 1, min: floor, max: 1)
   noise(scaleX: osc(type: oscKind.sine, speed: rate)).write(o0)

These fields support nesting:

- ``osc()``: ``min``, ``max``, ``speed``, ``offset``, and ``seed``
- ``midi()``: ``min``, ``max``, and ``sensitivity``
- ``audio()``: ``min`` and ``max``

Enum values, device identity, and channel numbers remain literal. The language
supports up to eight nested levels beneath the outer descriptor. For selected-device examples, raw audio behavior, and host
integration, see :doc:`midi-audio`.

Pipeline Integration
--------------------

The DSL acts as a high-level builder for the Render Graph defined in :ref:`Pipeline Specification <shader-pipeline>`. For compiler details, see :ref:`Compiler Specification <shader-compiler>`.

Mapping DSL to Effects
^^^^^^^^^^^^^^^^^^^^^^

When the evaluator encounters a function call like ``.bloom(0.5)``:


#. **Lookup:** Retrieves the ``Bloom`` effect definition using the namespace resolution rules.
#. **Instantiation:** Creates a logical instance of the effect.
#. **Parameter Binding:** Binds arguments to the effect's ``globals``.
#. **Chain Connection:** Connects the output of the previous node to the input of the new instance.

Texture I/O
^^^^^^^^^^^

The DSL provides symmetric operations for reading and writing textures:

**2D Textures:**

* **write(surface):** Writes the chain output to a 2D surface.
  
  - Example: ``noise(10).write(o0)``
  - Surfaces: ``o0``-``o7`` (global)
  - **Chainable:** ``write()`` can appear mid-chain, passing the texture through to subsequent nodes.
  
    - Example: ``noise().write(o0).blur().write(o1)`` — writes noise to ``o0``, then blurs and writes to ``o1``.
    - Example: ``noise().write(o0).invert().write(o1)`` — ``o0`` has the original noise, ``o1`` has the inverted version.

* **read(surface):** Reads from a 2D surface. Built-in to the pipeline, no namespace required.
  
  - Example: ``read(o0).bloom(0.5).write(o1)``

**3D Textures:**

* **write3d(vol, geo):** Writes to both a 3D volume and its geometry buffer.
  
  - Example: ``noise3d().write3d(vol0, geo0)``

* **read3d(vol, geo):** Reads from both a 3D volume and its geometry buffer (starter form).
  
  - Example: ``read3d(vol0, geo0).render3d().write(o0)``

* **read3d(vol):** Single-arg form for passing volume or geometry references to effect parameters.
  
  - Example: ``cellularAutomata3d(source: read3d(vol0), geoSource: read3d(geo0))``
  - This mirrors the 2D ``read(o0)`` pattern for surface parameters.

Surfaces and Outputs
^^^^^^^^^^^^^^^^^^^^

The DSL allows writing to named outputs (Surfaces) and reading from them.

**2D Surfaces:**

* **Global Surfaces:** ``o0``-``o7`` are persistent 2D textures.
* **Output:** ``.write(o0)`` marks the chain as writing to ``o0``.
* **Input:** ``read(o0)`` creates a read dependency on ``o0``.
* **None:** ``none`` disables a surface parameter (e.g., ``effect(tex: none)``).

**3D Volume Surfaces:**

* **Global Volumes:** ``vol0``-``vol7`` are persistent 3D texture volumes (default 64³).
* **Global Geometry Buffers:** ``geo0``-``geo7`` are 2D geometry buffers storing surface normals and depth.
* **Output:** ``.write3d(vol0, geo0)`` writes 3D volume data and geometry to the specified surfaces.
* **Input (starter):** ``read3d(vol0, geo0)`` reads from a volume and its geometry buffer to start a chain.
* **Input (param):** ``read3d(vol0)`` or ``read3d(geo0)`` passes a reference to an effect parameter.
* **None:** ``none`` disables a volume/geometry parameter (e.g., ``cellularAutomata3d(source: none)``).

The geometry buffers store precomputed raymarching results (xyz=surface normal, w=depth), enabling downstream post-processing effects without re-raymarching.

**Agent Particle Surfaces:**

Used by the SMRTicles particle system (see :ref:`SMRTicles <shader-smrticles>`):

* **Position Surfaces:** ``xyz0``-``xyz7`` store agent positions (xyz) and lifecycle state (w).
* **Velocity Surfaces:** ``vel0``-``vel7`` store agent velocities.
* **Color Surfaces:** ``rgba0``-``rgba7`` store agent colors.

The ``pointsEmit`` and ``pointsRender`` wrappers manage these surfaces. Behavior effects read and write these surfaces to update agent state each frame.

**Mesh Surfaces:**

* **Mesh Geometry Textures:** ``mesh0``-``mesh7`` are texture pairs storing mesh geometry data from loaded OBJ files.
* Each mesh surface consists of a positions texture (vertex XYZ + W) and a normals texture (normal XYZ + UV).
* **Loading:** Use ``meshLoader()`` in the pipeline and load OBJ files via the API (``canvas.loadOBJFromURL()`` or ``canvas.loadOBJFromString()``).
* **Rendering:** Use ``meshRender(mesh: mesh0)`` to render mesh geometry with lighting and transforms.

Feedback Loops
^^^^^^^^^^^^^^

A chain reads texture content from the **previous frame** in either of these cases:

- The current frame has no earlier write to that Surface.
- The chain reads from itself.

This behavior enables feedback effects.

Diagnostics
-----------

.. list-table::
   :header-rows: 1

   * - Code
     - Stage
     - Severity
     - Message
   * - L001
     - Lexer
     - Error
     - Unexpected character
   * - L002
     - Lexer
     - Error
     - Unterminated string literal
   * - P001
     - Parser
     - Error
     - Unexpected token
   * - P002
     - Parser
     - Error
     - Expected closing parenthesis
   * - S001
     - Semantic
     - Error
     - Unknown identifier
   * - S002
     - Semantic
     - Warning
     - Argument out of range
   * - S003
     - Semantic
     - Error
     - Variable used before assignment
   * - S005
     - Semantic
     - Error
     - Illegal chain structure
   * - S004
     - Semantic
     - Error
     - Cannot assign null or undefined
   * - S005
     - Semantic
     - Error
     - Illegal chain structure
   * - S006
     - Semantic
     - Error
     - Starter chain missing write() call
   * - S007
     - Semantic
     - Warning
     - Deprecated parameter alias
   * - S008
     - Semantic
     - Warning
     - Deprecated effect
   * - R001
     - Runtime
     - Error
     - Runtime error


Common Errors
^^^^^^^^^^^^^


* **S005 (Illegal chain structure):** Generator functions (like ``noise`` and ``solid``) must appear at the start of a chain. They cannot consume an existing chain output.
* **S006 (Starter chain missing write):** Generator-driven chains must end with ``.write()`` to produce a reusable surface.
* **S007 (Deprecated parameter alias):** The parameter has a new name. The previous name still works. Use the current name.
* **S008 (Deprecated effect):** A newer effect replaces this effect, but the previous effect still works. Use the current name.
