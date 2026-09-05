Parallax
========

Parallax produces a pseudo-3D perspective shift from a height map through
ray-marched parallax occlusion mapping.

``filter/parallax`` re-projects its input as if the height map extruded it
into relief viewed from an angle:

1. The height map's luminosity gives each pixel a height from 0 to 1.
2. For every output pixel, the effect marches a view ray through the height field until it hits the surface.
   The ``direction`` parameter sets the ray angle.
3. The effect samples the input where the ray hits the surface.
   Tall features lean away from the viewer and cover objects behind them.

.. code-block:: dsl

    search filter, synth

    noise(ridges: true)
      .parallax()
      .write(o0)

With the default ``heightMap`` the input acts as its own height map
(bright = tall). Wire a different surface to displace one image by another's
relief.

Parameters
----------

.. list-table::
   :header-rows: 1
   :widths: 22 18 18 42

   * - Parameter
     - Type
     - Default
     - Description
   * - ``heightMap``
     - surface
     - ``inputTex``
     - Height source. Its luminosity defines the height field.
   * - ``direction``
     - vec3
     - ``[0.5, 0.5, 1]``
     - Viewer angle. Straight down ``(0,0,1)`` means no shift. Glancing
       angles maximize the shift.
   * - ``pivot``
     - number (0–1)
     - 0
     - The anchored height plane. A value of 0 locks the ground, and
       features rise from it. A value of 1 locks the peaks, and valleys
       sink inward.

Related
-------

- ``filter/lighting`` accepts the same kind of height map through its
  ``heightMap`` input, for lit shading of a relief.
- During large-format tiled rendering, the effect clamps the parallax shift.
  Displaced samples stay within the tile overlap, preventing seams in very
  large prints.
