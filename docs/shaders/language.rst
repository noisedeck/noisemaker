.. _shader-language:

Polymorphic DSL
===============

Polymorphic is the high level language powering the Noisemaker Rendering Pipeline, enabling live-coding visuals by chaining functions that evaluate to native shader graphs. The Polymorphic DSL serves as the high-level builder for the pipeline, allowing users to define complex, multi-pass effects declaratively.

The language evaluates to a Directed Acyclic Graph (DAG) of render passes executed on the GPU. Each valid program must materialize its generator chains into explicit outputs so that the pipeline can schedule and double-buffer them deterministically.

Grammar
-------

.. code-block:: none

   Program        ::= SearchDirective? Statement* RenderDirective?
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
   SceneCall      ::= 'scene' '(' SceneArg ( ',' SceneArg )* ')'          (preview)
   SceneArg       ::= Kwarg | CameraCall | LightCall | EnvironmentCall | NodeChain
   NodeChain      ::= ( MeshCall | GroupCall ) ( '.' NodeLink )*
   NodeLink       ::= MaterialCall | 'reflector' '(' ')'
   MaterialCall   ::= 'material' '(' MaterialSpec ')'
   MaterialSpec   ::= ( 'solid' | 'surface' ) '(' ArgList? ')' ( '.' MaterialTerm )*
   MaterialTerm   ::= ( 'pbr' | 'emit' ) '(' ArgList? ')'
   Expr           ::= Chain | NumberExpr | String | Boolean | Color | Ident | Member | OutputRef | SourceRef | VolRef | GeoRef | XyzRef | VelRef | RgbaRef | MeshRef | Func | '(' Expr ')'
   Call           ::= Ident '(' ArgList? ')'
   ArgList        ::= Arg ( ',' Arg )* ','?
   Arg            ::= Kwarg | Positional
   Kwarg          ::= Ident ':' Positional
   Positional     ::= NumberExpr | String | Boolean | Color | Ident | Member | OutputRef | VolRef | GeoRef | XyzRef | VelRef | RgbaRef | MeshRef | Func | ArrayLiteral | ObjectLiteral | Chain
   ArrayLiteral   ::= '[' ( Positional ( ',' Positional )* ','? )? ']'
   ObjectLiteral  ::= '{' ( Ident ':' Positional ( ',' Ident ':' Positional )* ','? )? '}'
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

Productions marked ``(preview)`` are experimental. ``SceneCall`` and everything
reachable from it — ``SceneArg``, ``NodeChain``, ``NodeLink``, ``MaterialCall``,
``MaterialSpec``, ``MaterialTerm`` — are provisional in Noisemaker 1.5 and
scheduled to be finalized in 2.0. ``ObjectLiteral`` was added to serve them and
is likewise provisional: it is currently only meaningful inside ``scene()``.

**Precedence & Associativity:**


* ``*``, ``/`` have higher precedence than ``+``, ``-``.
* Operators are left-associative.
* Parentheses ``()`` override precedence.

**Output Materialization:**


* Any chain that begins with a generator **must** terminate with ``.write(<surface>)``; omitting the terminal ``.write()`` on a generator chain yields diagnostic ``S006``.
* Chains that extend an existing surface (e.g., reading via ``read(o0)`` and applying additional nodes) may omit ``.write()`` only when they are nested inside another chain that eventually writes to a surface.

**Chainable Writes:**


* ``.write(<surface>)`` can appear **anywhere** in a chain, including mid-chain.
* When ``.write()`` appears mid-chain, it writes the current result to the specified surface and **passes the texture through** to the next node in the chain.
* Multiple ``.write()`` calls in a single chain write to multiple surfaces.
* **Chains must still terminate with** ``.write()`` — mid-chain writes alone are not sufficient.
* Example: ``noise().write(o0).blur().write(o1)`` writes the noise to ``o0``, then blurs and writes the result to ``o1``.

**Generators:**
A chain must start with a Generator function (an effect with no inputs).


* Standard Generators: ``osc``, ``noise``, ``voronoi``, ``solid``, ``image``, ``video``, ``camera``.
* Custom Generators: Any effect defining ``inputs: {}`` or marked as generator.

**Colors:**
Hex colors support 3, 6, or 8 digits: ``#RGB``, ``#RRGGBB``, ``#RRGGBBAA``. Alpha defaults to ``FF`` (1.0) if omitted.

**Strings:**
Strings use double quotes: ``"hello"``. For multi-line strings, use triple quotes: ``"""line1\nline2\nline3"""``. Triple-quoted strings preserve embedded newlines. This is useful for the ``text`` effect:

.. code-block:: none

  noise().text(text: """Hello
  World""").write(o0)

**Arrow Functions:**
Currently restricted to zero-argument expression lambdas: ``() => expr``. Used primarily for deferred evaluation in control structures or future callbacks.

Language Features
-----------------

Functions & Arguments
^^^^^^^^^^^^^^^^^^^^^

Functions accept arguments positionally, as named keywords, or as a mix of both within a single call.

**Positional arguments:**

.. code-block:: none

  noise(10, 0.1, 1)

**Keyword arguments:**

.. code-block:: none

  noise(freq: 10, sync: 0.1, amp: 1)

**Mixed arguments:**

Positional and keyword arguments may be interleaved in any order. This is what
lets :ref:`scene() <shader-scene>` carry renderer settings as keywords alongside
its child nodes as positional arguments.

.. code-block:: none

  scene(ambient: 0.15, camera(fov: 60), background: [0, 0, 0]).write(o0)

Numeric arguments support inline arithmetic (``+``, ``-``, ``*``, ``/``) and constants like ``Math.PI``. Color arguments accept unquoted ``#RGB`` or ``#RRGGBB`` hex codes.

**Vector parameters:**

Some effects accept multi-component vector parameters. Use the built-in vector constructors:

* ``vec2(x, y)`` — 2-component vector
* ``vec3(x, y, z)`` — 3-component vector
* ``vec4(x, y, z, w)`` — 4-component vector

.. code-block:: none

  effect(param: vec2(0.5, 0.25)).write(o0)

**Array literals:**

Array literals — comma-separated numbers in square brackets — are an
additional input form for any vector-valued argument. They are parsed
and validated the same way ``vec2()`` / ``vec3()`` / ``vec4()`` are,
and round-trip through the unparser as ``[…]`` so a program written
with array literals comes back from a parse → unparse cycle in the
same form. The vector constructor calls are unchanged and remain the
canonical form for programs that already use them.

.. code-block:: none

  effect(param: [0.5, 0.25]).write(o0)
  effect(quad: [0.05, 0.05, 0.45, 0.95]).write(o0)

Elements may be any numeric expression (negative numbers, arithmetic,
``Math.PI``). Array length is not enforced by the validator — whatever
elements the source declared are passed through to the runtime.

Variables & Aliases
^^^^^^^^^^^^^^^^^^^

Programs may declare variables with ``let`` and reuse them. Variables can alias functions or capture partial applications.

.. code-block:: none

  let pattern = noise
  pattern(20).write(o0)

**Semantics:**


* ``let x = noise``: ``x`` becomes an alias for the ``noise`` function.
* ``let y = noise(10)``: ``y`` stores a **partial application** (Effect Instance with some parameters bound). It does *not* execute the effect.
* ``y(0.5)``: Creates a new Effect Instance, merging the stored parameters (``freq: 10``) with the new arguments (``sync: 0.5``). The original ``y`` remains unchanged (immutable).

Partials
^^^^^^^^

Invoking variables that store function calls merges stored arguments with call-site arguments.

.. code-block:: none

  let tuned = noise(5)
  tuned(amp:0.5).write(o0)

**Merge Rules:**


* **Positional Arguments:** Appended to the stored arguments.
* **Named Arguments:** Merged with stored arguments. **Call-site arguments override stored arguments** if keys conflict.
* **Duplicate Keys:** If a named argument is provided multiple times in a single call, the last value wins.

Control Flow
^^^^^^^^^^^^

The language supports ``if``, ``elif``, ``else`` for conditionals.

.. note::

  Control flow syntax is part of the parser and validator today, but runtime execution (branching) is not yet implemented. Programs using these constructs will not execute until the pipeline gains full support.

**Arrow Functions:**
Arrow functions (``() => expr``) are treated as **lazy expressions**. They are not evaluated immediately but are passed as-is to the effect or control structure, which determines when (or if) to evaluate them.

Subchains
^^^^^^^^^

Subchains provide a first-class mechanism for grouping contiguous effects within a chain. They create atomic encapsulations that can be identified, manipulated, and reasoned about as units.

**Syntax:**

.. code-block:: none

   .subchain(name: "group name", id: "unique_id") {
     .effect1()
     .effect2(param: value)
   }

**Arguments:**

* ``name`` (optional): A human-readable label for the subchain.
* ``id`` (optional): A unique identifier for programmatic access.

Both arguments can be omitted, or ``name`` can be passed as a positional argument.

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
* Subchains cannot be the first element in a chain; they require input from a preceding effect.
* Effects inside subchains cannot be generators (e.g., ``noise()``, ``voronoi()``).
* Subchains are chainable—the output flows through to subsequent effects after the closing brace.
* Effects inside subchains use the same argument syntax as regular chain effects.

**Use Cases:**

* Grouping related effects for organizational clarity.
* Marking effect groups for UI controls or programmatic manipulation.
* Defining reusable patterns within complex compositions.
* Enabling downstream tools to identify and operate on logical effect groups.

Scenes
^^^^^^

``scene()`` describes a 3D scene — a camera, lights, and a hierarchy of meshes
with PBR materials — which the deferred renderer resolves into a surface. It
behaves like any other generator and must terminate in ``.write(oN)``, so its
output composes with the 2D effect library.

.. note::

   **Preview feature — experimental and subject to change.** The scene
   vocabulary and its semantics ship as a preview in Noisemaker 1.5 and are
   scheduled to be finalized in Noisemaker 2.0. Names, keywords, defaults and
   rendered output may change without a deprecation period.

.. code-block:: none

  scene(
    ambient: 0.15,
    camera(fov: 60, pos: [0, 3, -8], target: [0, 0, 0]),
    light(type: "directional", dir: [1, -1, 1], intensity: 2),
    mesh("sphere", radius: 1.5, pos: [0, 1, 0])
      .material(solid(color: [0.9, 0.9, 0.95]).pbr(metallic: 0.1, roughness: 0.6))
  ).write(o0)

The scene vocabulary is ``scene``, ``camera``, ``light``, ``environment``,
``mesh``, ``group``, ``material``, ``solid``, ``surface``, ``pbr``, ``emit`` and
``reflector``.

These names are a **fallback, not a reservation**. Every call is first resolved
against the registered effects in the active search order; only when no effect
matches does a name fall through to the scene layer. ``solid`` is both a scene
material source and the ``synth/solid`` generator, and a top-level ``solid()``
under ``search synth`` still compiles to the 2D effect.

Arguments inside ``scene()`` are preserved as AST and handed to the scene
compiler rather than validated against the effect registry, which is why terms
like ``reflector()`` need no registration and why scene errors surface as
``SyntaxError`` with a line and column rather than as validator diagnostics.

Transform components and light intensity accept ``osc()`` descriptors in place
of numbers, evaluated against the same normalized loop time as effect uniforms.

See :ref:`shader-scene` for the full node, material and settings reference, and
:ref:`shader-deferred-rendering` for how the scene is drawn.

Namespaces
----------

Polymorphic supports a namespace system to organize effects and ensure compatibility.

Built-in Namespace
^^^^^^^^^^^^^^^^^^

The ``io`` namespace contains pipeline-level I/O functions that are always available without requiring a ``search`` directive. These are not effects per se, but fundamental pipeline operations:

* ``read(surface)``: Read from a 2D surface (e.g., ``read(o0)``)
* ``write(surface)``: Write to a 2D surface (e.g., ``.write(o0)``)
* ``read3d(vol, geo)``: Read from 3D volume and geometry buffers
* ``write3d(vol, geo)``: Write to 3D volume and geometry buffers
* ``render(surface)``: Set the final render output (program directive)
* ``render3d()``: Render 3D volume to 2D output

The ``io`` namespace is implicitly included in all programs. You never need to add ``io`` to your ``search`` directive—these functions are always accessible.

New Namespaces
^^^^^^^^^^^^^^

These namespaces are actively developed and maintained:

* ``synth``: 2D generator effects that create patterns from scratch (noise, shapes, fractals)
* ``filter``: 2D single-input effects that transform images (blur, color adjustment, distortion)
* ``mixer``: Two-input effects that combine images (blend modes, compositing)
* ``render``: Rendering utilities and feedback loops (pointsEmit, pointsRender, loopBegin/End)
* ``points``: Particle and agent-based simulations (physarum, life, flock, flow)
* ``synth3d``: 3D volumetric generator effects (noise3d, ca3d, rd3d)
* ``filter3d``: 3D volumetric processor effects (flow3d, render3d)

Classic Namespaces
^^^^^^^^^^^^^^^^^^

In addition to the actively developed and maintained namespaces above, the following namespaces were ported from older versions of our products. Each namespace offers a different take on how runtime composition can work.

* ``classicNoisedeck``: These are complex and often slower shaders brought over from the "Classic" Noisedeck.app shader graph.

Custom Namespaces
^^^^^^^^^^^^^^^^^

External integrations can introduce their own top-level namespace at runtime via the ``registerNamespace()`` API, alongside the built-ins listed above. Once registered, the new id is accepted by the ``search`` directive and behaves like any built-in namespace. The reserved ``user`` namespace is also available without registration for ad-hoc effects.

See :doc:`integration` for the full API: ``registerNamespace(id, descriptor)``, ``unregisterNamespace(id)``, and validation rules.

Search Order
^^^^^^^^^^^^

Every program **must** begin with a ``search`` directive that defines the namespace resolution order. There are no implicit defaults—explicit search order is required.

.. code-block:: none

  search synth, filter
  noise3d(seed: 1).translate(x: 0, y: 0).write(o0)

When a function like ``noise3d()`` is called, the runtime walks the search order (``synth``, then ``filter``) until a matching effect is found.

**Resolution Rules:**

#. **Mandatory Search Directive:** Every program must start with ``search <namespace>, ...`` to specify which namespaces to search and in what order.
#. **Unqualified Identifiers:** Calls like ``noise()`` walk the search order until a matching effect is found.
#. **Overrides:** The ``from(ns, fn())`` helper allows sourcing an operation from a specific namespace temporarily (e.g., ``from(synth, noise())``).

**Note:** Inline namespace prefixes (e.g., ``synth.noise()``) are **forbidden** in program chains. Use the ``search`` directive or ``from()`` helper instead.

Enums
-----

Many function arguments accept enumerated options defined in a global registry. Enums are defined at the top level in ``std_enums.js`` as global categories (e.g., ``color``, ``blend``, ``wrap``).

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

Oscillators are objects that generate time-varying values for animating effect parameters. They produce looping values synchronized with the animation duration, making them ideal for creating smooth, repeating animations.

Creating Oscillators
^^^^^^^^^^^^^^^^^^^^

Use the ``osc()`` function to create an oscillator:

.. code-block:: none

   osc(type: sine)

**Parameters:**

.. list-table::
   :header-rows: 1

   * - Parameter
     - Type
     - Default
     - Description
   * - type
     - oscKind
     - (required)
     - Oscillator waveform type
   * - min
     - number
     - 0
     - Minimum output value
   * - max
     - number
     - 1
     - Maximum output value
   * - speed
     - int
     - 1
     - Loop speed multiplier (divides evenly into animation duration)
   * - offset
     - number
     - 0
     - Phase offset (0..1)
   * - seed
     - number
     - 1
     - Random seed (noise type only)

**Oscillator Types (oscKind):**

* ``sine`` - Smooth sine wave: 0 → 1 → 0
* ``tri`` - Linear triangle wave: 0 → 1 → 0
* ``saw`` - Sawtooth wave: 0 → 1
* ``sawInv`` - Inverted sawtooth: 1 → 0
* ``square`` - Square wave: 0 or 1
* ``noise`` - Periodic 2D noise (seamlessly looping)

Usage Examples
^^^^^^^^^^^^^^

**Basic oscillating parameter:**

.. code-block:: none

   search synth
   noise(scale: osc(type: sine, min: 2, max: 8)).write(o0)

**Using variables for reusable oscillators:**

.. code-block:: none

   search synth
   let scaleOsc = osc(type: sine, min: 2, max: 8)
   let rotOsc = osc(type: saw, min: 0, max: 360)
   noise(scale: scaleOsc, rotation: rotOsc).write(o0)

**Speed control for synchronized loops:**

.. code-block:: none

   search synth
   // speed: 2 means the oscillator completes 2 cycles per animation loop
   noise(scale: osc(type: tri, min: 1, max: 10, speed: 2)).write(o0)

**Phase offset for staggered animations:**

.. code-block:: none

   search synth
   let osc1 = osc(type: sine, offset: 0)
   let osc2 = osc(type: sine, offset: 0.25)
   let osc3 = osc(type: sine, offset: 0.5)
   // Three oscillators at different phases create wave-like patterns

**Noise oscillator with seed:**

.. code-block:: none

   search synth
   noise(scale: osc(type: noise, min: 2, max: 8, seed: 42)).write(o0)

Runtime Behavior
^^^^^^^^^^^^^^^^

Oscillators are evaluated per-frame based on the current animation time. The pipeline normalizes time to a 0..1 range over the animation duration (default 10 seconds), then applies the speed multiplier and offset before computing the waveform value.

The resulting value is mapped from the internal 0..1 range to the specified min..max range, making oscillators suitable for any numeric parameter regardless of its expected range.

Live Input
----------

Use ``midi()`` and ``audio()`` to drive parameters from external signals. Both map incoming data to a numeric range and can be mixed with oscillators or constants.

``midi(channel, mode?, min?, max?, sensitivity?)``

* ``channel`` (required): MIDI channel 1-16
* ``mode``: midiMode value (default ``velocity``)
* ``min`` / ``max``: Output range (default 0..1)
* ``sensitivity``: Decay rate for trigger modes (default 1)

``audio(band, min?, max?)``

* ``band`` (required): ``low | mid | high | vol``
* ``min`` / ``max``: Output range (default 0..1)

Example:

.. code-block:: none

   search synth
   noise(
     scale: midi(channel: 1, min: 1, max: 10),
     speed: audio(band: low, min: 0.5, max: 2)
   ).write(o0)

For detailed behavior and host integration, see :doc:`midi-audio`.

Pipeline Integration
--------------------

The DSL acts as a high-level builder for the Render Graph defined in :ref:`Pipeline Specification <shader-pipeline>`. For a detailed look at how the DSL is compiled, see :ref:`Compiler Specification <shader-compiler>`.

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
  
  - Example: ``noise3d(10).write3d(vol0, geo0)``

* **read3d(vol, geo):** Reads from both a 3D volume and its geometry buffer (starter form).
  
  - Example: ``read3d(vol0, geo0).render3d().write(o0)``

* **read3d(vol):** Single-arg form for passing volume references to effect parameters.
  
  - Example: ``ca3d(source: read3d(vol0), geoSource: read3d(geo0))``
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
* **None:** ``none`` disables a volume/geometry parameter (e.g., ``ca3d(source: none)``).

The geometry buffers store precomputed raymarching results (xyz=surface normal, w=depth), enabling downstream post-processing effects without re-raymarching.

**Agent Particle Surfaces:**

Used by the SMRTicles particle system (see :ref:`SMRTicles <shader-smrticles>`):

* **Position Surfaces:** ``xyz0``-``xyz7`` store agent positions (xyz) and lifecycle state (w).
* **Velocity Surfaces:** ``vel0``-``vel7`` store agent velocities.
* **Color Surfaces:** ``rgba0``-``rgba7`` store agent colors.

These surfaces are managed by the ``pointsEmit`` and ``pointsRender`` wrappers. Behavior effects read and write these surfaces to update agent state each frame.

**Mesh Surfaces:**

* **Mesh Geometry Textures:** ``mesh0``-``mesh7`` are texture pairs storing mesh geometry data from loaded OBJ files.
* Each mesh surface consists of a positions texture (vertex XYZ + W) and a normals texture (normal XYZ + UV).
* **Loading:** Use ``meshLoader()`` in the pipeline and load OBJ files via the API (``canvas.loadOBJFromURL()`` or ``canvas.loadOBJFromString()``).
* **Rendering:** Use ``meshRender(mesh: mesh0)`` to render mesh geometry with lighting and transforms.

Feedback Loops
^^^^^^^^^^^^^^

If a chain reads from a Surface that hasn't been written to yet in the current frame (or reads from itself), it reads the texture content from the **previous frame**. This enables feedback effects.

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


* **S005 (Illegal chain structure):** Generator functions (like ``osc``, ``noise``) must appear at the start of a chain. They cannot consume an existing chain output.
* **S006 (Starter chain missing write):** Generator-driven chains must end with ``.write()`` to produce a reusable surface.
* **S007 (Deprecated parameter alias):** A parameter name you used still works but has been renamed. Update to the current name.
* **S008 (Deprecated effect):** An effect you used still works but has been replaced by a newer effect. Update to the current name.
