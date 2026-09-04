.. _shader-smrticles:

SMRTicles
=========

Smart Particles
~~~~~~~~~~~~~~~

*Stateful Massively-parallel Runtime for particles*

**or:**

*Simulations with Multiple Render Targets*

**or:**

*Whatever you'd like*

Noisemaker's shader pipeline includes common architecture for GPU-accelerated agent-based particle simulations. It provides a unified framework for initializing, simulating, and rendering perhaps millions of particles with shared state management and composable behaviors.

.. raw:: html

   <div class="shader-viewer-container" data-namespaces="points" data-default-effect="points/flock">
     <div class="shader-viewer-example">
       <div class="shader-viewer-canvas-wrapper">
         <canvas class="shader-viewer-canvas" width="384" height="384"></canvas>
         <pre class="shader-viewer-dsl-overlay"></pre>
         <button class="shader-viewer-random">Random</button>
         <div class="shader-viewer-loading">Loading...</div>
       </div>
       <div class="shader-viewer-controls">
         <div class="shader-viewer-select-wrapper">
           <label for="shader-effect-select-smrticles">Behavior</label>
           <select class="shader-viewer-select" id="shader-effect-select-smrticles">
             <option>Loading effects...</option>
           </select>
         </div>
         <div class="shader-viewer-params-label">Parameters</div>
         <div class="shader-viewer-params">
           <!-- Dynamic controls will be inserted here -->
         </div>
       </div>
     </div>
   </div>
   <style>
   .shader-viewer-canvas-wrapper {
     position: relative;
   }
   .shader-viewer-dsl-overlay {
     position: absolute;
     top: 8px;
     left: 8px;
     right: 8px;
     margin: 0;
     padding: 0;
     background: transparent;
     font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
     font-size: 11px;
     line-height: 1.4;
     pointer-events: none;
     z-index: 10;
     overflow: visible;
     white-space: pre-wrap;
     word-wrap: break-word;
   }
   .shader-viewer-dsl-overlay span {
     background: rgba(0, 0, 0, 0.7);
     color: #fff;
     padding: 2px 4px;
     display: inline;
     box-decoration-break: clone;
     -webkit-box-decoration-break: clone;
   }
   .shader-viewer-section {
     margin-bottom: 1.5em;
   }
   .shader-viewer-section h4 {
     margin: 0 0 0.5em 0;
     font-size: 0.9em;
     font-weight: 600;
     color: #555;
     text-transform: uppercase;
     letter-spacing: 0.05em;
   }
   </style>
   <script src="/_static/noisemaker-shaders-core.min.js"></script>
   <script src="/_static/shader-viewer.js"></script>

----

Philosophy
----------

Traditional particle systems duplicate substantial boilerplate code across effects:

- Agent initialization and respawn logic
- Color sampling from input textures
- Trail accumulation and decay
- Point-sprite rendering and blending

SMRTicles factors this common infrastructure into two **wrapper effects** (``pointsEmit`` and ``pointsRender``) that sandwich effect-specific **behavior middleware**. This architecture achieves:

1. **Code Reduction**: ~40% less shader code per effect
2. **Consistency**: All effects share the same deposit/blend approach
3. **Composability**: Mix and match behaviors in a single pipeline
4. **Maintainability**: Bug fixes propagate to all particle effects

----

Architecture Overview
---------------------

Pipeline Structure
^^^^^^^^^^^^^^^^^^

Every SMRTicles composition follows this three-stage pipeline:

.. code-block:: none

                             (input texture)
                                    │
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                         pointsEmit (render)                       │
   │  • Initialize agents with positions, velocities, colors, count    │
   │  • Handle respawn when agents die or attrition triggers           │
   │  • Sample colors from input texture                               │
   │  • Output: global_xyz, global_vel, global_rgba                    │
   └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                     Behavior Middleware (points)                  │
   │  • Read xyz/vel/rgba state from pipeline                          │
   │  • Apply effect-specific movement/physics/sensing                 │
   │  • Write updated state back (ping-ponged by runtime)              │
   │  • Examples: attractor, flock, flow, physarum, life, physical     │
   └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                       pointsRender (render)                       │
   │  • Diffuse: decay existing trail by intensity factor              │
   │  • Deposit: scatter agent colors via point-sprite rendering       │
   │  • Blend: composite trail with input by inputIntensity factor     │
   │  • Output: final image to outputTex                               │
   └─────────────────────────────────────────────────────────────────────┘

DSL Usage
^^^^^^^^^

SMRTicles compositions use method chaining in the Polymorphic DSL:

.. code-block:: javascript

   // Basic particle system with physics
   noise().pointsEmit().physical().pointsRender().write(o0)

   // Slime mold simulation
   noise().pointsEmit(stateSize: 512).physarum().pointsRender().write(o0)

   // Strange attractor with 3D viewport
   noise().pointsEmit().attractor().pointsRender(viewMode: ortho).write(o0)

   // Flow field tracing over an input image
   noise().pointsEmit().flow().pointsRender().write(o0)

----

State Textures
--------------

SMRTicles uses three shared global textures for agent state, created by ``pointsEmit`` and consumed by all downstream effects:

.. list-table::
   :header-rows: 1
   :widths: 15 20 65

   * - Texture
     - Format
     - Contents
   * - ``global_xyz``
     - rgba32f (may fall back to rgba16f)
     - [x, y, z, alive_flag] — Position in normalized [0,1] space, w=1 alive
   * - ``global_vel``
     - rgba32f (or rgba16f on constrained devices)
     - [vx, vy, vz, seed] — Velocity vector and per-agent random seed
   * - ``global_rgba``
     - rgba8
     - [r, g, b, a] — Agent color (sampled from input or mono white)

State Texture Sizing
^^^^^^^^^^^^^^^^^^^^

Agent count is controlled by the ``stateSize`` parameter, which sets the dimensions of the state textures. Total agents = stateSize × stateSize.

.. list-table::
   :header-rows: 1
   :widths: 20 30 50

   * - stateSize
     - Agent Count
     - Use Case
   * - 64
     - 4,096
     - Debugging, low-end devices
   * - 128
     - 16,384
     - Light simulations
   * - 256
     - 65,536
     - Default, good balance
   * - 512
     - 262,144
     - High density effects
   * - 1024
     - 1,048,576
     - Physarum, massive swarms
   * - 2048
     - 4,194,304
     - Maximum (GPU memory dependent)

Alive Flag Protocol
^^^^^^^^^^^^^^^^^^^

The ``xyz.w`` component encodes agent lifecycle state:

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Value
     - Meaning
   * - ``1.0``
     - Alive and active
   * - ``0.0``
     - Dead — respawn at random position next frame
   * - ``-1.0``
     - Dead — respawn at current xy (in-place respawn)

Effects signal agent death by writing ``xyz.w = 0.0`` (or ``-1.0`` for in-place). The ``pointsEmit`` wrapper detects this on the next frame and handles respawn.

----

Wrapper Effects
---------------

pointsEmit
^^^^^^^^^^

**Namespace:** ``render``

**Purpose:** Initialize and maintain agent state. Runs every frame to handle respawns.

**Key Parameters:**

.. list-table::
   :header-rows: 1
   :widths: 20 15 15 50

   * - Parameter
     - Type
     - Default
     - Description
   * - ``stateSize``
     - int
     - 256
     - State texture dimensions (64–2048)
   * - ``layout``
     - enum
     - random
     - Initial distribution: random, grid, center, ring, clusters, spiral
   * - ``seed``
     - float
     - 0.0
     - Random seed for reproducibility
   * - ``attrition``
     - float
     - 0.0
     - Per-frame respawn chance (0–10%)
   * - ``resetState``
     - button
     - —
     - Force all agents to respawn

**Spawn Patterns:**

- **random**: Uniform random distribution across canvas
- **grid**: Regular grid layout
- **center**: Concentrated in center region
- **ring**: Circular ring distribution
- **clusters**: N random cluster centers with Gaussian spread
- **spiral**: Archimedean spiral from center

pointsRender
^^^^^^^^^^^^

**Namespace:** ``render``

**Purpose:** Accumulate agent trails and composite with input.

**Key Parameters:**

.. list-table::
   :header-rows: 1
   :widths: 20 15 15 50

   * - Parameter
     - Type
     - Default
     - Description
   * - ``density``
     - float
     - 50.0
     - Percentage of agents to render (0–100)
   * - ``intensity``
     - float
     - 75.0
     - Trail persistence (0=instant fade, 100=no decay)
   * - ``inputIntensity``
     - float
     - 10.15
     - Input blend factor (0=trail only, 100=input visible)
   * - ``viewMode``
     - enum
     - flat
     - Viewport mode: flat (2D) or ortho (3D)
   * - ``rotateX/Y/Z``
     - float
     - varies
     - 3D rotation in radians (when viewMode=ortho)
   * - ``viewScale``
     - float
     - 0.8
     - Zoom factor for 3D view
   * - ``posX/Y``
     - float
     - 0.0
     - Position offset for 3D view

**Internal Passes:**

1. **Diffuse**: Decay existing trail by intensity factor
2. **Copy**: Prepare write buffer for hardware blending
3. **Deposit**: Point-sprite rendering of agents to trail (additive blend)
4. **Blend**: Composite trail over input texture

.. note::
   Additional sprite rendering modes (textured sprites, billboards, custom shapes) are planned for future releases.

----

Behavior Middleware
-------------------

All behavior effects live in the ``points`` namespace and follow a consistent pattern:

1. Read ``global_xyz``, ``global_vel``, ``global_rgba`` from pipeline
2. Apply effect-specific logic
3. Write updated state back (MRT output to same textures)
4. Passthrough ``inputTex`` to ``outputTex`` for 2D chain continuity

Available Behaviors
^^^^^^^^^^^^^^^^^^^

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Effect
     - Description
   * - ``physical``
     - Physics simulation with gravity, wind, drag, and wander forces
   * - ``flow``
     - Luminance-based flow field tracing with configurable behaviors
   * - ``hydraulic``
     - Gradient descent flow (hydraulic erosion pattern)
   * - ``flock``
     - Boids flocking: separation, alignment, cohesion
   * - ``physarum``
     - Slime mold chemotaxis with sensor-based steering
   * - ``dla``
     - Diffusion-limited aggregation (crystal growth)
   * - ``life``
     - Particle life: type-based attraction/repulsion matrix
   * - ``lenia``
     - Particle Lenia: continuous cellular automata with kernel-based attraction
   * - ``attractor``
     - Strange attractors: Lorenz, Rössler, Aizawa, Thomas, etc.

----

Implementation Notes
--------------------

MRT (Multiple Render Targets)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Behavior effects use MRT to update all three state textures in a single pass:

.. code-block:: glsl

   // GLSL fragment shader
   layout(location = 0) out vec4 outXYZ;
   layout(location = 1) out vec4 outVel;
   layout(location = 2) out vec4 outRGBA;

   void main() {
       // Read previous state
       vec4 xyz = texelFetch(xyzTex, ivec2(gl_FragCoord.xy), 0);
       vec4 vel = texelFetch(velTex, ivec2(gl_FragCoord.xy), 0);
       vec4 rgba = texelFetch(rgbaTex, ivec2(gl_FragCoord.xy), 0);

       // Apply behavior logic...

       // Write updated state
       outXYZ = xyz;
       outVel = vel;
       outRGBA = rgba;
   }

At pipeline creation, the runtime compares the combined attachment formats
with the backend's per-sample color budget. If an MRT group is too wide, it
demotes trailing ``rgba32f`` attachments to ``rgba16f`` while further
reductions are available. On a 32-byte device, ``pointsEmit`` keeps position
data in ``global_xyz`` at full precision and uses half precision for
``global_vel``. A smaller reported budget can also demote ``global_xyz`` and
may still be insufficient for the irreducible three-attachment pass.

Point-Sprite Deposit
^^^^^^^^^^^^^^^^^^^^

The deposit pass uses ``drawMode: "points"`` to scatter agents:

.. code-block:: glsl

   // Vertex shader
   void main() {
       // Map gl_VertexID to state texture coordinate
       int texSize = int(sqrt(float(vertexCount)));
       ivec2 coord = ivec2(gl_VertexID % texSize, gl_VertexID / texSize);

       // Read agent position from state texture
       vec4 xyz = texelFetch(xyzTex, coord, 0);

       // Cull dead agents
       if (xyz.w < 0.5) {
           gl_Position = vec4(-10.0);  // Off-screen
           return;
       }

       // Transform to clip space
       gl_Position = vec4(xyz.xy * 2.0 - 1.0, 0.0, 1.0);
       gl_PointSize = 1.0;
   }

Ping-Pong State
^^^^^^^^^^^^^^^

The runtime automatically ping-pongs state textures between frames. Effects read from the previous frame's state and write to the current frame's buffer. The ``updateFrameSurfaceBindings()`` method ensures within-frame visibility when multiple effects share textures.

----

Creating Custom Behaviors
-------------------------

To create a new SMRTicles behavior:

1. **Create effect directory**: ``shaders/effects/points/myeffect/``

2. **Define the effect** (``definition.js``):

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js'

   export default new Effect({
     name: "MyEffect",
     namespace: "points",
     func: "myEffect",
     tags: ["sim", "agents"],

     description: "Custom particle behavior",

     textures: {},  // Use shared global textures

     outputXyz: "global_xyz",
     outputVel: "global_vel",
     outputRgba: "global_rgba",

     globals: {
       myParam: {
         type: "float",
         default: 1.0,
         uniform: "myParam",
         ui: { label: "my param", control: "slider" }
       }
     },

     passes: [
       {
         name: "agent",
         program: "agent",
         drawBuffers: 3,
         inputs: {
           xyzTex: "global_xyz",
           velTex: "global_vel",
           rgbaTex: "global_rgba"
         },
         uniforms: { myParam: "myParam" },
         outputs: {
           outXYZ: "global_xyz",
           outVel: "global_vel",
           outRGBA: "global_rgba"
         }
       },
       {
         name: "passthrough",
         program: "passthrough",
         inputs: { inputTex: "inputTex" },
         outputs: { fragColor: "outputTex" }
       }
     ]
   })

3. **Implement shaders**: Create ``glsl/agent.glsl`` and ``wgsl/agent.wgsl`` with your behavior logic.

4. **Test**: Use the MCP tools to verify compilation and rendering:

.. code-block:: bash

   # Verify shader compiles
   mcp compileEffect --effect_id points/myeffect --backend webgl2

   # Check for non-monochrome output
   mcp renderEffectFrame --effect_id points/myeffect --backend webgl2

----

Performance Considerations
--------------------------

- **State size scaling**: Memory and bandwidth scale quadratically with ``stateSize``. Use the smallest size that achieves your visual goal.

- **Density culling**: The ``density`` parameter in ``pointsRender`` culls agents before vertex processing, saving GPU work.

- **Trail vs. chemistry**: Effects like ``physarum`` maintain separate pheromone textures for simulation accuracy, independent of visual trail intensity.

- **3D projection**: The ortho view mode in ``pointsRender`` adds rotation matrix computation per vertex. Use flat mode for 2D-only effects.

- **Neighbor queries**: Effects like ``flock`` and ``life`` have O(n²) neighbor lookups. Use spatial hashing (built into the shaders) or limit ``stateSize`` for real-time performance.
