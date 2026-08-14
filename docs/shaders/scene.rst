.. _shader-scene:

Scene Graph (Preview)
=====================

``scene()`` adds a third dimension to the Polymorphic DSL. A scene program
describes a camera, lights, and a hierarchy of meshes with PBR materials. The
:ref:`deferred renderer <shader-deferred-rendering>` turns that description into
pixels and writes the result into an ordinary pipeline surface, so 3D output
composes with the existing 2D filter library rather than needing its own
post-processing stack.

.. note::

   **Preview feature — experimental and subject to change.** The entire
   ``scene()`` language surface described on this page, and the engine behind
   it, ship as a preview in Noisemaker 1.5. Node names, keywords, defaults,
   argument shapes, and rendered output may all change without a deprecation
   period. The scene vocabulary is scheduled to be finalized in Noisemaker 2.0;
   until then, do not depend on a scene program continuing to parse or render
   identically across releases.

.. code-block:: none

   search filter, synth

   scene(
     ambient: 0.15,
     background: [0.05, 0.05, 0.1],

     camera(fov: 60, pos: [0, 3, -8], target: [0, 0, 0]),
     light(type: "directional", dir: [1, -1, 1], intensity: 2),

     mesh("sphere", radius: 1.5, pos: [0, 1, 0])
       .material(solid(color: [0.9, 0.9, 0.95]).pbr(metallic: 0.1, roughness: 0.6))
   ).write(o0)

   read(o0).bloom(threshold: 0.7).vignette(brightness: 0.2).write(o1)

   render(o1)

A scene behaves like any other generator: it must terminate in ``.write(oN)``,
and everything downstream of that write is ordinary effect chaining.

.. note::

   This is mesh rendering — cameras, geometry and PBR materials. It is a
   separate subsystem from :ref:`the volumetric 3D pipeline <shader-3d-pipeline>`,
   which marches density fields held in ``vol`` and ``geo`` surfaces. Both
   terminate in ordinary surfaces, so they can be composited together.

Structure
---------

.. code-block:: none

   SceneCall      ::= 'scene' '(' SceneArg ( ',' SceneArg )* ')'
   SceneArg       ::= Setting | CameraCall | LightCall | EnvironmentCall | NodeChain
   NodeChain      ::= ( MeshCall | GroupCall ) ( '.' NodeLink )*
   NodeLink       ::= MaterialCall | 'reflector' '(' ')'
   MaterialCall   ::= 'material' '(' MaterialSpec ')'
   MaterialSpec   ::= ( 'solid' | 'surface' ) '(' ArgList? ')' ( '.' MaterialTerm )*
   MaterialTerm   ::= 'pbr' '(' ArgList? ')' | 'emit' '(' ArgList? ')'

Only one ``scene()`` is permitted per program. Scene children are positional
arguments; settings are keyword arguments, and the two may be interleaved.

Permitted direct children are ``camera``, ``light``, ``environment``, ``mesh``
and ``group``. Anything else raises ``Unknown scene child '<name>'``.

Name resolution
^^^^^^^^^^^^^^^

Scene function names are a *fallback*, not a reservation. The validator first
tries to resolve every call against the registered effects in the active
:ref:`search order <shader-language>`; only when no effect matches does the name
fall through to the scene layer. ``solid`` is both a scene material source and
the ``synth/solid`` generator, and a top-level ``solid()`` under ``search synth``
still compiles to the 2D effect.

Everything inside the parentheses of ``scene()`` is preserved as argument AST and
is never validated against the effect registry, which is why terms like
``reflector()`` need no registration.

Settings
--------

Keyword arguments on ``scene()`` configure the renderer. All are optional.

.. list-table::
   :header-rows: 1
   :widths: 22 16 62

   * - Setting
     - Default
     - Meaning
   * - ``ambient``
     - ``0.1``
     - Uniform ambient term. Supplies the default for ``sky`` and ``ground``.
   * - ``sky``
     - ``ambient``
     - Upper hemisphere ambient colour, ``[r, g, b]``.
   * - ``ground``
     - ``ambient``
     - Lower hemisphere ambient colour, ``[r, g, b]``.
   * - ``background``
     - ``[0, 0, 0]``
     - Colour where no geometry is hit.
   * - ``exposure``
     - ``1``
     - Multiplier applied before tonemapping.
   * - ``ssao``
     - ``1``
     - Strength of screen-space ambient occlusion. ``0`` disables it.
   * - ``ssaoRadius``
     - ``0.75``
     - World-space sampling radius for SSAO.
   * - ``reflections``
     - ``1``
     - Strength of screen-space and planar reflections.
   * - ``reflectionProbe``
     - none
     - ``[x, y, z]`` position to capture a cubemap probe from. Must be a finite
       vec3.
   * - ``reflectionProbeSize``
     - ``128``
     - Probe cube face resolution. Integer in ``16..512``; requires
       ``reflectionProbe``.

Camera
------

.. code-block:: none

   camera(fov: 52, pos: [0, 3.2, -8.5], target: [0, 0.6, 0])

.. list-table::
   :header-rows: 1
   :widths: 18 22 60

   * - Keyword
     - Default
     - Meaning
   * - ``fov``
     - ``60``
     - Vertical field of view in degrees.
   * - ``near``
     - ``0.1``
     - Near clip distance.
   * - ``far``
     - ``1000``
     - Far clip distance.
   * - ``pos``
     - ``[0, 0, 5]``
     - Eye position.
   * - ``target``
     - ``[0, 0, 0]``
     - Look-at point.

Lights
------

``type`` selects the light model and determines which other keywords apply. It
defaults to ``"directional"``; an unrecognised value raises
``Unknown light type``.

.. code-block:: none

   light(type: "directional", dir: [0.6, -1, 0.4], color: [1, 0.96, 0.88], intensity: 1.6)
   light(type: "point", pos: [0, 4, -6], intensity: 0.25, falloff: 0)
   light(type: "spot", pos: [-3, 6, -2], dir: [0.35, -1, 0.25], angle: 24, penumbra: 0.35)

.. list-table::
   :header-rows: 1
   :widths: 16 14 18 52

   * - Keyword
     - Default
     - Applies to
     - Meaning
   * - ``color``
     - ``[1, 1, 1]``
     - all
     - Light colour.
   * - ``intensity``
     - ``1``
     - all
     - Scalar brightness.
   * - ``dir``
     - ``[0, -1, 0]``
     - directional, spot
     - Direction the light travels.
   * - ``pos``
     - ``[0, 0, 0]``
     - point, spot
     - World position.
   * - ``falloff``
     - ``1``
     - point, spot
     - Distance attenuation. Must be non-negative; ``0`` disables falloff.
   * - ``angle``
     - ``45``
     - spot
     - Cone half-angle in degrees.
   * - ``penumbra``
     - ``0.1``
     - spot
     - Softness of the cone edge.

Any number of lights may be declared.

Environment
-----------

``environment()`` promotes a pipeline surface to an environment map, letting a
2D DSL program act as sky and reflection fallback.

.. code-block:: none

   gradient(color1: [0.5, 0.65, 0.95], color2: [0.14, 0.1, 0.2], colorCount: 2).write(o3)

   scene(
     environment(o3, intensity: 0.55),
     ...
   ).write(o0)

The positional argument must be a surface reference (``o0``–``o7``); anything
else raises ``environment() expects a surface reference``. ``intensity``
defaults to ``1``.

Meshes
------

``mesh()`` takes a primitive name as its first positional argument. Recognised
types are ``sphere``, ``box``, ``plane``, ``cylinder`` and ``torus``; anything
else raises ``Unknown mesh type``.

Keywords split into two groups. ``id``, ``pos``, ``rot`` and ``scale`` describe
placement; every other keyword is forwarded to the primitive builder as a shape
parameter.

.. list-table::
   :header-rows: 1
   :widths: 16 84

   * - Primitive
     - Shape parameters (with defaults)
   * - ``sphere``
     - ``radius: 1``, ``segments: 32``
   * - ``box``
     - ``size: [1, 1, 1]``
   * - ``plane``
     - ``width: 1``, ``height: 1``
   * - ``cylinder``
     - ``radius: 1``, ``height: 2``, ``segments: 32``
   * - ``torus``
     - ``radius: 1``, ``tube: 0.4``, ``segments: 32``, ``tubeSegments: 16``

.. code-block:: none

   mesh("torus", radius: 1, tube: 0.32, pos: [3, -0.28, 0])

Groups and transforms
---------------------

``group()`` nests nodes. Its positional arguments are child ``mesh()`` or
``group()`` chains, and its transform applies to the whole subtree.

.. code-block:: none

   group(id: "spinner", rot: [0, 45, 0],
     mesh("sphere", radius: 1.3, pos: [0, 0.7, 0]),
     mesh("box", size: [1.1, 1.1, 1.1], pos: [-3, -0.05, 0])
   )

Both ``mesh()`` and ``group()`` accept the same transform keywords:

.. list-table::
   :header-rows: 1
   :widths: 14 86

   * - Keyword
     - Meaning
   * - ``id``
     - Optional name, useful for locating a node from host code.
   * - ``pos``
     - Translation, exactly 3 components.
   * - ``rot``
     - Rotation in degrees, exactly 3 components.
   * - ``scale``
     - Scale, exactly 3 components.

A vector with the wrong arity raises ``<name> must contain exactly 3 values``.
Transforms compose down the hierarchy; world matrices are recomputed only for
nodes marked dirty.

Materials
---------

``.material()`` attaches a material to a node. It takes exactly one material
*source* — ``solid()`` or ``surface()`` — optionally refined by ``.pbr()`` and
``.emit()``.

.. code-block:: none

   .material(solid(color: [0.85, 0.2, 0.12]).pbr(metallic: 0.3, roughness: 0.35))
   .material(surface(o2, tint: [0.8, 0.95, 1], uvScale: [2.5, 1.5]).pbr(roughness: 0.65))
   .material(solid(color: [0.4, 0.9, 1.0]).emit(strength: 1.5))

.. list-table::
   :header-rows: 1
   :widths: 14 22 64

   * - Term
     - Keywords
     - Meaning
   * - ``solid``
     - ``color`` (``[1, 1, 1]``)
     - Flat base colour. Components must be non-negative.
   * - ``surface``
     - ``tint``, ``uvScale`` (``[1, 1]``), ``uvOffset`` (``[0, 0]``)
     - Uses a pipeline surface (``o0``–``o7``) as the albedo map, so a live 2D
       program becomes a texture. The positional argument is the surface.
   * - ``pbr``
     - ``metallic`` (``0``), ``roughness`` (``1``)
     - Cook-Torrance parameters. Both clamp to ``0..1``.
   * - ``emit``
     - ``strength`` (``1``)
     - Emissive output, non-negative. Pairs naturally with a downstream
       ``bloom()``.

Supplying two sources, omitting the source entirely, or using an unknown term
raises a scene error. A node accepts only one ``material()``.

Materials **inherit**: a material on a ``group()`` applies to every descendant
that does not declare its own.

Planar reflections
------------------

``.reflector()`` marks a plane as a mirror, rendering the scene a second time
from the reflected viewpoint.

.. code-block:: none

   mesh("plane", width: 22, height: 22, pos: [0, -0.6, 0])
     .reflector()
     .material(solid(color: [0.62, 0.64, 0.7]).pbr(metallic: 0.9, roughness: 0.2))

It takes no arguments, requires a ``plane`` mesh, and only one reflector is
supported per scene. Violating any of these raises a scene error.

Animation
---------

Transform components and light intensity accept :ref:`oscillators
<shader-language>` in place of numbers, using the same ``osc()`` descriptors as
effect uniforms.

.. code-block:: none

   group(id: "spinner", rot: [0, osc(type: oscKind.saw), 0], ... )

Oscillators are hoisted out of the tree at compile time and advanced in place
each frame against the same normalized loop time that drives effect automation,
so scene motion and effect automation stay locked to one clock. Only ``osc()``
calls are accepted here; an oscillator-shaped object literal is rejected.

Composition
-----------

Because a scene terminates in ``.write(oN)``, its output is an ordinary surface.
That makes the whole 2D library available as post-processing, and lets 2D
programs feed back into the scene through ``surface()`` and ``environment()``.

.. code-block:: none

   noise(scaleX: 5, scaleY: 5, octaves: 4, colorMode: 1).write(o2)

   scene(
     mesh("sphere").material(surface(o2).pbr(roughness: 0.65))
   ).write(o0)

   read(o0).bloom(threshold: 0.75).write(o1)

   render(o1)

Hosting requirements
--------------------

The scene modules depend on ``gl-matrix``, imported as a bare module specifier.
They are loaded lazily — only when a program containing ``scene()`` compiles —
so pages that render ordinary 2D effect chains never need it. A page that hosts
scenes must make the specifier resolvable, typically with an import map:

.. code-block:: html

   <script type="importmap">
   {
     "imports": {
       "gl-matrix": "../../node_modules/gl-matrix/esm/index.js"
     }
   }
   </script>

Without it, a 2D program still renders normally and the failure only appears
when a scene program is compiled.

Sources
-------

``shaders/src/rendering/scene-compiler.js`` — DSL to scene IR;
``shaders/src/scene/`` — tree, nodes, camera, lights, transform math, clock and
animation bindings; ``shaders/src/geometry/primitives.js`` — primitive builders;
``shaders/src/lang/validator.js`` — ``SCENE_FUNCTIONS`` passthrough.
