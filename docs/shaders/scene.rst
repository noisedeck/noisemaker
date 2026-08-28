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
   terminate in ordinary surfaces, so they can be composited together, and
   `Volumes`_ brings a ``vol`` surface into the scene graph as a node.

Structure
---------

.. code-block:: none

   SceneCall      ::= 'scene' '(' SceneArg ( ',' SceneArg )* ')'
   SceneArg       ::= Setting | CameraCall | LightCall | EnvironmentCall | NodeChain
   NodeChain      ::= ( MeshCall | VolumeCall | GroupCall ) ( '.' NodeLink )*
   VolumeCall     ::= 'volume' '(' ArgList ')'
   NodeLink       ::= MaterialCall | 'reflector' '(' ')'
   MaterialCall   ::= 'material' '(' MaterialSpec ')'
   MaterialSpec   ::= ( 'solid' | 'surface' ) '(' ArgList? ')' ( '.' MaterialTerm )*
   MaterialTerm   ::= 'pbr' '(' ArgList? ')' | 'emit' '(' ArgList? ')'

Only one ``scene()`` is permitted per program. Scene children are positional
arguments; settings are keyword arguments, and the two may be interleaved.

Permitted direct children are ``camera``, ``light``, ``environment``, ``mesh``,
``volume`` and ``group``. Anything else raises ``Unknown scene child '<name>'``.

``mesh()``, ``volume()`` and ``group()`` accept exactly the two chain links in
``NodeLink`` — ``.material()`` and ``.reflector()``. Any other link raises
``Unknown link '<name>()' on <kind>()``; transforms are keyword arguments on the
node itself, so ``mesh("sphere").pos([0, 0, -4])`` is that error and not a
placement.

Name resolution
^^^^^^^^^^^^^^^

The validator first resolves every chain call against the registered effects in
the active :ref:`search order <shader-language>`. ``solid`` is both a scene
material source and the ``synth/solid`` generator, and a top-level ``solid()``
under ``search synth`` still compiles to the 2D effect.

Only ``scene`` falls through to the scene layer when no effect matches. The
other eleven names — ``camera``, ``light``, ``environment``, ``mesh``,
``volume``, ``group``, ``material``, ``solid``, ``surface``, ``pbr`` and
``emit`` — are children
*inside* a ``scene()`` call and never reach the chain. Written as a chain
element with no effect behind them they raise
``Unknown effect: '<name>'. Scene nodes like <name>() are only valid inside
scene().`` Passing them through instead turned a typo into a no-op that compiled
clean and rendered nothing.

``scene()`` is a generator: it must start its chain. ``noise().scene(...)`` has
no meaning — the incoming surface would simply be discarded — and raises
``scene() is a generator and must start a chain``.

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

``camera()`` is optional. Every keyword has a default, so the node as a whole
does too: a scene that declares no camera gets ``fov: 60``, ``near: 0.1``,
``far: 1000``, ``pos: [0, 0, 5]`` and ``target: [0, 0, 0]``. Declaring
``camera()`` with no keywords is the same thing written out.

Unknown keywords are errors. ``near`` and ``far`` must both be greater than
zero, and ``far`` must be greater than ``near``.

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
placement; the rest are shape parameters, and each primitive accepts only the
ones listed below. A keyword outside both groups raises
``Unknown keyword '<name>' for mesh("<type>")`` rather than being dropped in
silence, and ``mesh()`` takes exactly one positional argument — a second one
raises ``mesh() takes one positional argument, the mesh type``.

Shape parameter values are checked before they reach the geometry builders:
``radius``, ``tube``, ``width`` and ``height`` must be greater than zero,
``segments`` and ``tubeSegments`` must be integers in ``3..512``, and ``size``
must be a vec3 of finite numbers.

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

Volumes
-------

``volume()`` places a density volume in the scene graph. Its positional
argument is one of the pipeline's eight volume surfaces, so a 3D program that
fills an atlas with ``write3d()`` becomes a node beside the meshes rather than a
separate fullscreen marcher with its own camera and lights. Like the rest of
this page it is a preview surface, and it is subject to the change policy in the
note at the top.

.. code-block:: none

   search synth3d

   noise3d().write3d(vol0, geo0)

   scene(
     camera(fov: 60, pos: [0, 2, -6]),
     light(type: "directional", dir: [1, -1, 1]),
     volume(vol0, threshold: 0.5, pos: [0, 1, 0], scale: [2, 2, 2])
       .material(solid(color: [0.9, 0.4, 0.2]).pbr(roughness: 0.7)),
     mesh("plane", width: 10, height: 10)
   ).write(o0)

   render(o0)

``volume()`` takes an ordinary argument list; the shape of it is enforced by
the scene compiler rather than by the grammar. Exactly one argument is
positional, and it must be a volume reference ``( VolRef | Ident )`` naming
``vol0``–``vol7`` — written directly as in the example above, or reached
through a ``let`` binding:

.. code-block:: none

   let density = vol0

   scene(volume(density, threshold: 0.5)).write(o0)

Every other argument is a keyword. The two may be interleaved in any order —
``volume(threshold: 0.5, vol0)`` is the same node as the example above — and a
trailing comma is permitted.

A surface reference, a string, an out-of-range index, or no positional argument
at all raises ``volume() expects a volume reference (vol0..vol7)``. A second
positional raises
``volume() takes one positional argument, the volume reference``.

.. list-table::
   :header-rows: 1
   :widths: 14 12 74

   * - Keyword
     - Default
     - Meaning
   * - ``threshold``
     - ``0.5``
     - Level, in ``0..1``. In ``smooth`` mode the isosurface is where the
       volume's density crosses this value; in ``voxel`` mode a cell is solid
       when its density exceeds it. Both are the meaning the ``threshold``
       uniform carries in the ``render3d`` family.
   * - ``mode``
     - ``"smooth"``
     - Marching mode, one of ``"smooth"`` or ``"voxel"``. Anything else raises
       ``Unknown volume mode '<name>' (expected: smooth, voxel)``.
   * - ``id``
     - —
     - Optional name, useful for locating a node from host code.
   * - ``pos``
     - ``[0, 0, 0]``
     - Translation, exactly 3 components.
   * - ``rot``
     - ``[0, 0, 0]``
     - Rotation in degrees, exactly 3 components.
   * - ``scale``
     - ``[1, 1, 1]``
     - Scale, exactly 3 components.

Anything outside that set raises ``Unknown keyword '<name>' for volume()``
rather than being dropped in silence. The transform keywords behave exactly as
they do on ``mesh()``: they compose down a ``group()`` hierarchy and accept
``osc()``, ``midi()`` and ``audio()`` descriptors in place of numbers.
``threshold`` does not — it is read as a plain number, and all three
descriptors are rejected there alike.

Marching modes
~~~~~~~~~~~~~~

``mode`` picks the algorithm that turns the density atlas into a surface. Both
fill the same G-buffer and are lit, shadowed by depth, reflected and
occlusion-tested identically; they differ only in where the surface is and
which way it faces.

``mode: "smooth"`` — the default, and what ``volume()`` has always done. The
atlas is sampled trilinearly, the ray steps until ``threshold - density``
changes sign, and bisection refines the crossing. The normal is the central
difference of the field, so the surface is continuous and curved.

``mode: "voxel"`` — a 3D-DDA walk of the atlas grid. The ray crosses one cell
wall at a time and stops at the first cell whose density exceeds ``threshold``.
The hit is on that cell's wall and the normal is the wall's own face, so the
surface is made of axis-aligned squares one cell across. With no material the
albedo is the hit cell's own colour, read without filtering.

.. code-block:: none

   volume(vol0, threshold: 0.5, mode: "voxel")
     .material(solid(color: [0.9, 0.4, 0.2]).pbr(roughness: 0.7))

Cell size follows the atlas, not the node: the ``vol0``–``vol7`` atlases are
64 cubed, so a voxel volume is 64 cells per axis whatever its ``scale``. Scaling
the node makes the cells bigger, not more numerous.

.. note::

   ``mode`` selects the marching algorithm and nothing else. The bounding volume
   is always the local ``[-1, 1]`` cube described under **Extent** below —
   ``volume()`` has no alternate bounds, and in particular no spherical bound
   like the one ``renderLit3d`` carries as a ``shape`` uniform. A volume's
   silhouette is always that of its box.

A volume takes a ``.material()`` on the same terms as a mesh — ``solid()``,
refined by ``.pbr()`` and ``.emit()`` — and inherits a group's material when it
declares none. ``surface()`` is the one exception: a raymarched isosurface has
no UVs to map a texture onto, so both ``volume(vol0).material(surface(o2))`` and
a volume inheriting such a material from its group raise ``volume() cannot take
a surface() material``.

.. note::

   The scene draws before the pipeline each tick, so a scene pass reading
   ``vol0`` samples the surface's **previous-frame** content. This is the same
   contract ``surface(oN)`` materials and ``environment(oN)`` already live
   under, and it is visible only as a one-frame lag between a volume's producer
   and the scene that draws it.

Three behaviours worth knowing:

- **Extent.** A volume's body space is the local ``[-1, 1]`` cube — the same
  space the volumetric renderers march — so a ``volume()`` at ``scale: 1``
  spans **two** world units per axis, where ``mesh("box")`` at ``scale: 1``
  spans one. Halve the scale to match a unit box.
- **Resolution.** The ``vol0``–``vol7`` atlases are fixed at 64 cubed. A
  ``volume()`` node samples a 64-cube regardless of the ``volumeSize`` the
  producing effect was configured with.
- **Reflections.** Volumes are lit by scene lights, occlude meshes through the
  shared depth buffer, and appear in planar reflections and in the reflection
  probe on the same terms a mesh does. The reflector's clip plane governs the
  marched hit, so the part of a volume behind a mirror is absent from its
  reflection rather than clipped at the bounding box. A volume in the probe
  costs one extra march per probe face: six on the frame that primes the cube,
  then one per frame as the probe amortizes.

Tiled export
------------

``setTileRegion`` tiles a scene by restricting the camera to the tile's
sub-frustum, not by shifting a fragment coordinate; offsets are bottom-left,
matching the 2D path. Geometry, volume marching, deferred lighting and the
tonemap are tile-exact — a stitched render matches the untiled one to a single
least-significant bit. Two passes are not: SSAO can seam within its kernel's
projected reach (occluders outside the tile are not in its G-buffer; its dither
phase is tile-corrected, so the seam band is the whole residual), and local
screen-space reflections cannot be tiled at all
— rays leaving the tile find nothing. For tiled exports prefer a planar
``reflector()``, whose mirrored camera inherits the same sub-frustum and is
tile-exact, or set ``reflections: 0``. The reflection probe is never tiled: it
is a world-space cubemap and captures all six full faces regardless of the
region.

Cubemap export
--------------

A ``scene()`` program exports a cubemap through the same ``renderCubemap()``
API as a cubemap-renderer program: the scene renders six times through
cube-face cameras — fov 90, square, at the scene camera's position, the full
pass stack including the tonemap per face — and the faces come back in GL
order (+X, -X, +Y, -Y, +Z, -Z) in the same orientation contract the 2D path
returns. All six faces are one instant: scene animation state advances once
per export, not per face. Faces are never tiled, and a configured reflection
probe is captured once for the first face and frozen for the rest — it is a
world-space cubemap and does not change between export faces; the live
amortization state is restored afterwards.

Groups and transforms
---------------------

``group()`` nests nodes. Its positional arguments are child ``mesh()``,
``volume()`` or ``group()`` chains, and its transform applies to the whole
subtree. Its only
keywords are the four transform keywords below; anything else raises
``Unknown keyword '<name>' for group()``.

.. code-block:: none

   group(id: "spinner", rot: [0, 45, 0],
     mesh("sphere", radius: 1.3, pos: [0, 0.7, 0]),
     mesh("box", size: [1.1, 1.1, 1.1], pos: [-3, -0.05, 0])
   )

``mesh()``, ``volume()`` and ``group()`` accept the same transform keywords:

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
supported per scene. Violating any of these raises a scene error. On a
``volume()`` or a ``group()`` the diagnostic names the node kind —
``reflector() is not supported on volume() nodes`` — rather than the plane
constraint, which was never the thing those nodes failed.

Animation
---------

Transform components and light intensity accept the same three :ref:`automation
descriptors <shader-language>` an effect uniform does, in place of numbers:
``osc()`` for a built-in waveform, ``midi()`` for a MIDI channel, and
``audio()`` for a frequency band.

.. code-block:: none

   group(id: "spinner", rot: [0, osc(type: oscKind.saw), 0], ... )
   mesh("sphere", scale: [audio(audioBand.low), 1, 1])
   light(type: "point", intensity: midi(channel: 1, mode: midiMode.velocity))

Each call means exactly what it means in an effect uniform — same arguments,
same enums, same defaults, same normalized ``[0, 1]`` sub-range from ``min``
and ``max``. Descriptors are hoisted out of the tree at compile time and
advanced in place each frame: ``osc()`` against the same normalized loop time
that drives effect automation, so scene motion and effect automation stay
locked to one clock, and ``midi()``/``audio()`` against the same live
``MidiState`` and ``AudioState`` the pipeline resolves effect uniforms from. A
scene and the effects around it therefore respond to one performance, not two.

Where no MIDI or audio input has been connected, a ``midi()`` or ``audio()``
component holds at its ``min`` rather than going undefined.

Only these three calls are accepted here; a descriptor-shaped object literal
is rejected in favour of the call that builds it.

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
``shaders/src/scene/`` — tree, nodes (including ``volume-node.js``), camera,
lights, transform math, clock and animation bindings;
``shaders/src/geometry/primitives.js`` — primitive builders;
``shaders/src/lang/validator.js`` — ``SCENE_FUNCTIONS`` passthrough.
