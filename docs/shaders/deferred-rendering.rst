.. _shader-deferred-rendering:

Deferred Renderer
=================

The renderer that draws :ref:`scene() <shader-scene>` programs. It fills a
G-buffer from the mesh hierarchy, lights it once in screen space with a
Cook-Torrance BRDF, adds ambient occlusion and reflections, tonemaps, and
presents into a texture the 2D pipeline then treats as an ordinary source.

Every pass is written twice — once in GLSL and once in WGSL — and both backends
are held to bit-identical output by the render tests.

Frame order
-----------

The scene renders **before** the 2D pipeline's own frame each tick. That
ordering has one visible consequence: ``surface(oN)`` materials and
``environment(oN)`` sample the surface's **previous-frame** content, because the
pipeline has not yet written this frame's.

Passes run in this order. Everything except the probe and the planar chain runs
unconditionally.

.. list-table::
   :header-rows: 1
   :widths: 6 26 30 38

   * - #
     - Pass
     - Writes
     - Runs when
   * - 1
     - Reflection probe (per cube face: G-buffer fill, then lighting)
     - ``scene_reflection_probe``
     - ``reflectionProbe`` set and ``reflections > 0``
   * - 2
     - G-buffer fill, one draw per mesh batched onto one target
     - ``scene_gbuf_*`` (MRT ×4)
     - always
   * - 3
     - Mirrored G-buffer fill, reflector excluded, clipped to the plane
     - ``scene_planar_gbuf_*``
     - a ``reflector()`` exists and ``reflections > 0``
   * - 4
     - SSAO
     - ``scene_ssao``
     - ``ssao > 0``
   * - 5
     - Mirrored deferred lighting
     - ``scene_planar_lit``
     - planar active
   * - 6
     - Deferred lighting
     - ``scene_lit_color``
     - always
   * - 7
     - Screen-space reflections and planar composite
     - ``scene_reflect_color``
     - ``reflections > 0``
   * - 8
     - Reinhard tonemap, exposure and gamma
     - ``scene_color``
     - always

The final pass reads ``scene_reflect_color`` when reflections are enabled and
``scene_lit_color`` otherwise. ``scene_color`` is the texture a trailing
``.write(oN)`` blits into a pipeline surface.

There is deliberately no ``await`` between the backend's ``beginFrame()`` and
``endFrame()``; probe sizing and shader recompilation happen before the frame
opens, so the pipeline's own frame cannot clobber the shared WebGPU command
encoder.

G-buffer
--------

Four render targets, filled by the mesh fragment shader in a single MRT pass.

.. list-table::
   :header-rows: 1
   :widths: 8 34 12 46

   * - Slot
     - Texture
     - Format
     - Contents
   * - RT0
     - ``scene_gbuf_albedo_metallic``
     - ``rgba16f``
     - ``rgb`` linear albedo, ``a`` metallic
   * - RT1
     - ``scene_gbuf_normal_roughness``
     - ``rgba16f``
     - ``rgb`` world normal encoded ``n * 0.5 + 0.5``, ``a`` roughness
   * - RT2
     - ``scene_gbuf_position_emission``
     - ``rgba16f``
     - ``rgb`` world position, ``a`` emission strength
   * - RT3
     - ``scene_gbuf_depth``
     - ``r32f``
     - ``r`` window-space depth

Albedo is ``solid()``'s colour, multiplied by the ``surface()`` texture sampled
at ``fract(uv * uvScale + uvOffset)`` when one is bound.

RT3 holds *window-space* depth, not linear or view-space depth, and every
downstream pass uses ``depth <= 0`` as the "nothing here" sentinel. Depth
*testing* uses a separate attachment that is never sampled; RT3 is the readable
copy.

Three further target sets exist: ``scene_planar_gbuf_*`` mirrors the layout
above for the reflected view and is allocated at full resolution whether or not
a scene has a reflector; ``PROBE_GBUF_*`` mirrors it again at probe resolution
and is allocated lazily; and the work textures ``scene_lit_color``,
``scene_ssao``, ``scene_planar_lit`` and ``scene_reflect_color`` carry
intermediate results. A fifth, ``scene_albedo_fallback``, exists only so every
declared binding has something bound — its contents are never sampled.

Lighting
--------

One fullscreen Cook-Torrance pass over the G-buffer.

.. list-table::
   :header-rows: 1
   :widths: 12 30 58

   * - Term
     - Function
     - Form
   * - D
     - ``distributionGGX``
     - GGX / Trowbridge-Reitz, ``a = roughness²``
   * - G
     - ``geometrySmith``
     - Smith, Schlick-GGX per direction, ``k = (roughness + 1)² / 8``
   * - F
     - ``fresnelSchlick``
     - ``F0 + (1 − F0)(1 − cosθ)⁵`` at ``dot(H, V)``

``F0 = mix(0.04, albedo, metallic)``. Specular is ``D·G·F`` over
``4·(N·V)(N·L)``, and the diffuse lobe is Lambertian scaled by
``(1 − F)(1 − metallic)``. Emission is added at the end, unlit.

Light types
^^^^^^^^^^^

**Directional** lights contribute ``intensity`` with no distance term.

**Point** lights attenuate as ``intensity / (1 + falloff · d²)``. Note the
consequence: ``falloff: 0`` removes attenuation entirely, giving a light of
constant intensity at any distance. The DSL default is ``1``.

**Spot** lights take the point attenuation and multiply by
``smoothstep(cos(outer), cos(inner), cosAngle)``, where ``inner`` is ``angle``
and ``outer`` is ``angle · (1 + penumbra)``. ``penumbra`` is therefore a
*fractional widening* of the cone, not an absolute blend width.

Ambient
^^^^^^^

``ambient`` is not itself a shader term. It is the scalar that fills ``sky`` and
``ground`` when those are unset; the shader only ever sees those two colours.

With no environment, ambient is a hemisphere lookup:
``mix(ground, sky, normal.y * 0.5 + 0.5)``.

With an ``environment()``, the environment's diffuse lookup **replaces** the
hemisphere entirely and ``sky`` and ``ground`` are ignored.

Ambient occlusion
-----------------

A 12-sample hemisphere kernel, defined once as a JavaScript array and
stringified into both shader languages so occlusion matches across backends. The
kernel is rotated per pixel by interleaved gradient noise and oriented to the
surface normal.

This is a world-space technique rather than a depth-buffer one: each sample is
placed at ``P + TBN · kernel[i] · ssaoRadius``, reprojected through the
view-projection matrix, and compared against the G-buffer position at that
pixel. Samples that land behind the camera, outside the frame, or on background
are skipped.

``ssao`` both gates the pass and acts as a **mix factor**, not a multiplier:
``ao = mix(1, sampledAO, ssao)``. The result attenuates **only the ambient
terms** — direct lighting and emission are untouched. The planar and probe
lighting passes disable it.

Neither ``ssao`` nor ``ssaoRadius`` is range-validated, so values above ``1``
extrapolate past full occlusion.

Reflections
-----------

One pass with two mutually exclusive branches, both additive on top of the lit
colour.

**Planar.** Taken when the fragment lies on the reflector plane and its normal
agrees with the plane. The mirrored lit buffer is sampled through the reflection
view-projection with a small cross-shaped blur whose radius grows with
``roughness²``, then faded at the frame edge and scaled by Fresnel.

**Screen-space.** A ray march along the reflection vector, but only for
``roughness < 0.3`` — rougher surfaces skip it entirely. Up to 24 steps with the
step size growing by 1.35× each iteration, a sign-flip crossing test, then six
bisection refinement steps. A hit must additionally pass a depth-agreement test,
a distance-scaled world-space thickness test, and a backface rejection. Misses
leave the pixel unchanged. Hits fade out with roughness and toward the frame
edge.

``reflections`` gates the probe, the reflector search and this whole pass, and
scales both branches.

There is **no environment fallback inside this pass**. The handoff is
structural: reflections are added on top of a lit colour that already contains
environment and probe specular, so rough surfaces and SSR misses simply keep
what lighting gave them.

Planar reflections
------------------

``reflector()`` marks one plane as a mirror. The plane's point and normal are
extracted from the node's world matrix — the normal from the transformed basis
rows, so it survives non-uniform parent scale. If the camera is on the negative
side, the normal is flipped so it always faces the viewer.

The camera is then mirrored across the plane: position and target reflected as
points, up reflected as a direction, with field of view and clip distances
copied unchanged. The mirrored G-buffer pass excludes the reflector itself,
clips everything behind the plane, and disables face culling because mirroring
reverses winding.

Reflection probe
----------------

``reflectionProbe`` captures a cubemap from a fixed world position, giving
curved surfaces something to reflect that screen-space rays cannot reach.

Each face runs the full deferred path — mesh G-buffer, then lighting — at
``reflectionProbeSize`` resolution, into one face of an ``rgba16f`` cube. The
probe's own lighting pass binds a 1×1 fallback cube and disables probe sampling,
so there is no recursion.

Capture is **amortized**: all six faces render on the first activated frame, then
one face per frame round-robin thereafter. A full refresh therefore takes six
frames, and the probe keeps updating for the lifetime of the scene.

Sampling takes 24 golden-angle taps around the reflection vector, with the disc
radius growing as ``roughness²``. Background pixels are captured with zero alpha,
and that alpha blends the probe against its fallback — environment specular if
an ``environment()`` exists, otherwise ``background``.

The probe is direction-only: there is no parallax correction, so it is accurate
at its capture point and approximate elsewhere. It contributes through ambient
specular only and is never read by the reflection pass.

Environment
-----------

``environment(oN)`` binds a pipeline surface as an equirectangular environment
map, sampled by direction with ``atan2``/``acos``.

Two filtered lookups are built at runtime rather than prefiltered: diffuse takes
five weighted taps, specular takes 24 golden-angle disc taps with radius growing
as ``roughness²``. Both are crude by design — there is no mip chain and no
cosine-convolved irradiance map.

``intensity`` scales both the diffuse ambient, which replaces the hemisphere, and
the specular ambient.

The environment is **never drawn**. It only lights surfaces; pixels with no
geometry take the flat ``background`` colour, so an environment map is visible
in reflections and shading but not as a backdrop.

Tonemap
-------

The final pass multiplies by ``exposure``, applies simple Reinhard
``c / (c + 1)``, then a fixed ``1/2.2`` gamma. Alpha is forced to ``1``, so the
scene surface is always opaque.

``exposure`` is a pre-tonemap linear multiplier and is not range-validated.

Backend parity
--------------

Each shader is two independently hand-written sources selected by backend
identity, not one source cross-compiled. Only the SSAO kernel and the light
count are genuinely shared, templated into both. Everything else must be kept in
step by hand, which is what the bit-identical parity tests exist to enforce.

The WGSL side carries documented compensations for the API differences: clip
space is fixed up in the vertex stage because WebGPU's Y is down and Z spans
``[0, w]``; several UV reads are flipped for surface row order; sampling uses
explicit-level variants because implicit derivatives are invalid after
non-uniform control flow; uniform structs carry explicit padding; and binding
indices are unique across stages because WebGPU merges them into one layout.

Scene programs set ``perBindingUniforms``, which gives each uniform struct its
own buffer. The default shared-buffer path cannot express a struct that differs
between stages or one containing an array of structs — the lights array needs
it. WebGL2 ignores the flag.

Known divergences
^^^^^^^^^^^^^^^^^

Two gaps are worth knowing about:

- **Face culling differs on the G-buffer fill.** WebGL2 enables back-face
  culling for triangle passes unless told otherwise, while the WebGPU MRT
  pipeline sets no cull mode. The main G-buffer is therefore single-sided on
  WebGL2 and double-sided on WebGPU. Scenes built from closed primitives do not
  notice; open geometry can.
- **The G-buffer clear fallback may not be valid on WebGPU.** The passes used
  when a scene contains no renderable meshes declare four draw buffers but use a
  present program whose WGSL fragment stage returns a single location. This is
  benign on WebGL2, and no test covers it. Unverified.

Sources
-------

``shaders/src/rendering/scene-renderer.js`` — pass driver, targets, probe and
planar setup; ``shaders/src/rendering/gbuffer.js`` — mesh, lighting, SSAO and
SSR shader sources for both languages;
``shaders/src/rendering/mesh-renderer.js`` — draw submission;
``shaders/src/rendering/post-shaders.js`` — present and tonemap.
