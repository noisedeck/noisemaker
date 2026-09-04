.. _shader-effects:

Effect Definition Spec
======================

An "Effect" is a self-contained unit that transforms inputs to outputs using one or more rendering or compute passes.

1. Schema
---------

Effect definitions are created using the ``Effect`` constructor with a configuration object. This is the primary and recommended approach.

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js';

   export default new Effect({
     name: "SimpleBloom",
     namespace: "examples",
     func: "bloom",

     globals: {
       intensity: {
         type: "float",
         default: 0.5,
         min: 0,
         max: 1,
         ui: { label: "Intensity", control: "slider" }
       },
       threshold: {
         type: "float",
         default: 0.5,
         min: 0,
         max: 1,
         ui: { label: "Threshold", control: "slider" }
       }
     },

     textures: {
       downsampled: { width: "25%", height: "25%", format: "rgba16f" }
     },

     passes: [
       {
         name: "downsample",
         program: "downsample",
         inputs: {
           scene: "inputTex"
         },
         outputs: {
           color: "downsampled"
         }
       },
       {
         name: "composite",
         program: "composite",
         inputs: {
           scene: "inputTex",
           bloom: "downsampled"
         },
         outputs: {
           color: "outputTex"
         }
       }
     ]
   });

2. Key Concepts
---------------


* ``namespace``: Logical grouping for the effect (e.g., ``"synth"``, ``"filter"``). Combined with ``name``, it forms the unique identity.
* ``textures``: Defines the internal render targets. Dimensions can be absolute, relative to screen (``"screen"``, ``"50%"``), or fixed.
* ``passes``:

  * ``program``: Key to look up the shader code (GLSL/WGSL).
  * ``inputs``: Maps shader uniform samplers to texture names.
  * ``outputs``: Maps shader output locations (or write buffers) to texture names.
  * ``uniforms``: Maps shader uniform names to effect-global parameter names.
  * ``repeat``: A fixed repeat count or the name of a uniform that supplies it.
  * Backend fields include ``entryPoint``, ``drawMode``, ``drawBuffers``,
    ``count``, ``countUniform``, ``blend``, ``workgroups``, ``storageBuffers``,
    and ``storageTextures``.

2b. Tags and Namespaces
-----------------------

Effects can be categorized using **tags** and **namespaces** to help users discover and reason about available effects.

**Namespaces**

Namespace is the primary categorization and acts as an implicit tag. Each effect belongs to exactly one namespace.

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Namespace
     - Description
   * - ``io``
     - Pipeline I/O operations (built-in; no ``io`` entry in the required search directive)
   * - ``classicNoisedeck``
     - Complex shaders ported from the original noisedeck.app pipeline
   * - ``synth``
     - 2D generator modules
   * - ``mixer``
     - Blend two sources from A to B
   * - ``filter``
     - Apply special effects to 2D input
   * - ``points``
     - Agent and particle simulations (e.g. physarum, flock, dla, lenia, life)
   * - ``render``
     - Rendering utilities (render3d, cubemaps, mesh and points rendering, render loops)
   * - ``synth3d``
     - 3D volumetric generators (e.g. noise3d, cellularAutomata3d, reactionDiffusion3d, fractal3d, shape3d)
   * - ``filter3d``
     - 3D volumetric processors (flow3d, palette3d)
   * - ``user``
     - User-defined effects

**Tags**

Tags are curated labels for additional categorization. An effect may have multiple tags. Tags are optional and defined globally in ``shaders/src/runtime/tags.js``.

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Tag
     - Description
   * - ``3d``
     - 3D volumetric effects
   * - ``agents``
     - Particle and agent-based systems
   * - ``antialiasing``
     - Edge smoothing and antialiasing
   * - ``audio``
     - Audio-reactive effects
   * - ``blend``
     - Compositing and blend modes
   * - ``blur``
     - Blur and softening
   * - ``color``
     - Color manipulation
   * - ``distort``
     - Input distortion
   * - ``edges``
     - Accentuate or isolate texture edges
   * - ``fractal``
     - Fractal patterns
   * - ``geometric``
     - Shapes
   * - ``geometry``
     - 3D mesh geometry
   * - ``glitch``
     - Glitch and corruption effects
   * - ``image``
     - Image-input effects
   * - ``lens``
     - Emulated camera lens effects
   * - ``mesh``
     - 3D mesh rendering
   * - ``midi``
     - MIDI-reactive effects
   * - ``noise``
     - Very noisy
   * - ``palette``
     - Color palette mapping
   * - ``pattern``
     - Repeating or structured patterns
   * - ``pixel``
     - Pixelation and pixel-level effects
   * - ``sim``
     - Simulations with temporal state
   * - ``text``
     - Text rendering
   * - ``tiling``
     - Seamless tiling
   * - ``transform``
     - Moves stuff around
   * - ``util``
     - Utility function
   * - ``video``
     - Video-input effects

**Usage in Effect Definitions:**

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js';

   export default new Effect({
     name: "Warp",
     namespace: "filter",
     func: "warp",
     tags: ["distort", "noise"],  // Multiple tags allowed

     globals: { /* ... */ },
     passes: [ /* ... */ ]
   });

**Tag Validation:**

Tags are validated against the curated list in ``shaders/src/runtime/tags.js``. Invalid tags will be flagged during development. The ``validateTags()`` function can be used for programmatic validation:

.. code-block:: javascript

   import { validateTags, isValidTag } from '../../../src/runtime/tags.js';

   // Check a single tag
   isValidTag('color');  // true
   isValidTag('foobar'); // false

   // Validate an array of tags
   validateTags(['color', 'distort']);  // { valid: true, invalidTags: [] }
   validateTags(['color', 'invalid']);  // { valid: false, invalidTags: ['invalid'] }

**UI Rendering:**

In the demo UI, tags are rendered to the right of the namespace badge. Namespace appears prominently (as the "important tag"), with additional tags displayed in a lighter style.

3. On-Disk Layout
-----------------

Effects are typically authored as a directory containing a definition file, shader sources, and documentation.

.. code-block:: text

   my-effect/
   ├── definition.js       # Exports new Effect({...}) or Effect subclass
   ├── glsl/
   │   └── my-shader.glsl  # WebGL implementation
   ├── wgsl/
   │   └── my-shader.wgsl  # WebGPU implementation
   └── help.md             # User documentation (markdown)

**Shader References:**
The ``program`` field in a pass can specify a relative path (e.g., ``"./my-shader"``). The runtime resolves this path relative to the definition file, injecting the backend-specific directory (``glsl/`` or ``wgsl/``) and appending the appropriate extension (``.glsl`` or ``.wgsl``).

**Documentation:**
The ``help.md`` file is optional but recommended for library effects. It provides context for the editor UI.

**Example DSL:**
Example DSL snippets are auto-generated by the demo UI based on the effect type (starter, filter, or mixer). There is no need to maintain ``example.dsl`` files manually.

4. Global Enums
---------------

To promote consistency and reduce duplication, common enumerations are defined in a global registry. Effects reference these enums by name instead of redefining the choices.

**Global Registry Example:**

.. code-block:: javascript

   const globalEnums = {
     "interpolation": {
       "nearest": 0,
       "linear": 1,
       "hermite": 2,
       "cubic": 3
     },
     "wrapMode": {
       "clamp": 0,
       "repeat": 1,
       "mirror": 2
     }
   };

**Effect Usage:**

.. code-block:: javascript

   globals: {
     interp: {
       type: "int",
       enum: "interpolation", // References global key
       default: "linear"      // Uses string key
     }
   }

The runtime resolves the string value (e.g., ``"linear"``) to its integer counterpart (``1``) before binding to the shader.

4b. UI Categories
-----------------

Uniform controls can be visually grouped in the demo UI using the ``ui.category`` property. Categories allow complex effects with many parameters to organize their controls into logical sections.

**Category Requirements:**

- Category names **MUST** be camelCase (start with lowercase letter, no spaces/underscores/hyphens)
- Categories appear in order of first occurrence in the globals object
- Controls without a category default to ``"general"`` (displayed last)
- The UI shows category labels on hover and renders separators between groups

**Example:**

.. code-block:: javascript

   globals: {
     temperature: {
       type: "float",
       default: 0,
       uniform: "gradeTemperature",
       ui: {
         label: "Temperature",
         control: "slider",
         category: "primary"      // camelCase required
       }
     },
     hslHueCenter: {
       type: "float",
       default: 0,
       uniform: "gradeHslHueCenter",
       ui: {
         label: "Hue Center",
         control: "slider",
         category: "hslSecondary", // camelCase, no spaces
         enabledBy: "hslEnable"    // Only enabled when hslEnable is truthy
       }
     }
   }

4c. Conditional Control Visibility (enabledBy)
-----------------------------------------------

The ``enabledBy`` property controls when a parameter's UI control is enabled or disabled based on the value of other parameters. This supports both simple truthy checks and complex conditional expressions.

**Simple String Format (Legacy):**

The simplest form takes a parameter name as a string. The control is enabled when the referenced parameter is "truthy" (non-zero for numbers, true for booleans, non-empty for strings).

.. code-block:: javascript

   enabledBy: "hslEnable"    // enabled when hslEnable is truthy

**Comparison Operators:**

For more precise control, use an object with ``param`` and one or more comparison operators:

.. code-block:: javascript

   enabledBy: { param: "intensity", gt: 0.5 }     // enabled when intensity > 0.5
   enabledBy: { param: "intensity", gte: 0.5 }    // enabled when intensity >= 0.5
   enabledBy: { param: "intensity", lt: 0.5 }     // enabled when intensity < 0.5
   enabledBy: { param: "intensity", lte: 0.5 }    // enabled when intensity <= 0.5
   enabledBy: { param: "mode", eq: 1 }            // enabled when mode === 1
   enabledBy: { param: "mode", neq: 0 }           // enabled when mode !== 0

**Set Membership:**

Check if a value is a member of (or excluded from) a set of values:

.. code-block:: javascript

   enabledBy: { param: "mode", in: [1, 2, 3] }       // enabled when mode is 1, 2, or 3
   enabledBy: { param: "mode", notIn: [0, 4] }       // enabled when mode is NOT 0 or 4
   enabledBy: { param: "preset", in: ["a", "b"] }    // works with strings too

**Multiple Conditions (AND):**

Multiple operators in a single object are AND'd together:

.. code-block:: javascript

   enabledBy: { param: "intensity", gt: 0, lt: 1 }   // enabled when 0 < intensity < 1

**Logical Operators:**

For complex conditions, use ``or``, ``and``, and ``not``:

.. code-block:: javascript

   // OR: enabled when EITHER condition is true
   enabledBy: {
     or: [
       { param: "mode", eq: 1 },
       { param: "enabled", eq: true }
     ]
   }

   // AND (explicit): enabled when ALL conditions are true
   enabledBy: {
     and: [
       { param: "mode", gt: 0 },
       { param: "intensity", gte: 0.5 }
     ]
   }

   // NOT: invert a condition
   enabledBy: { not: { param: "disabled", eq: true } }

   // Complex nested conditions
   enabledBy: {
     or: [
       { param: "mode", eq: 2 },
       { and: [
         { param: "mode", eq: 1 },
         { param: "advanced", eq: true }
       ]}
     ]
   }

**Operator Reference:**

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Operator
     - Description
   * - ``eq``
     - Equal to value
   * - ``neq``
     - Not equal to value
   * - ``gt``
     - Greater than value (numbers only)
   * - ``gte``
     - Greater than or equal to value (numbers only)
   * - ``lt``
     - Less than value (numbers only)
   * - ``lte``
     - Less than or equal to value (numbers only)
   * - ``in``
     - Value is member of array
   * - ``notIn``
     - Value is not member of array
   * - ``or``
     - Array of conditions, any must be true
   * - ``and``
     - Array of conditions, all must be true
   * - ``not``
     - Invert the nested condition

**BANNED:**

- ``category: "Primary"`` — PascalCase forbidden
- ``category: "HSL Secondary"`` — spaces forbidden
- ``category: "hsl_secondary"`` — underscores forbidden

5. Lifecycle Methods (Class-Based Effects)
-------------------------------------------

Most effects are purely declarative and use the ``new Effect({...})`` pattern shown above. However, for effects requiring CPU-side state management (e.g., simulation steps, complex time-keeping, or audio analysis), you can either:

1. **Pass lifecycle functions in the config** (simpler):

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js';

   export default new Effect({
     name: "PulseEffect",
     namespace: "examples",
     func: "pulse",

     globals: {
       speed: { type: "float", default: 1.0 },
       intensity: { type: "float", default: 0.5 }
     },

     passes: [
       { name: "main", program: "pulse", outputs: { color: "outputTex" } }
     ],

     // Lifecycle hooks as config properties
     onInit() {
       this.state.phase = 0;
     },

     onUpdate({ time, delta, uniforms }) {
       this.state.phase += delta * uniforms.speed;
       return {
         u_pulse: Math.sin(this.state.phase) * uniforms.intensity
       };
     }
   });

2. **Subclass Effect** (for complex cases with additional methods):

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js';

   export default class MediaEffect extends Effect {
     name = "Media";
     namespace = "synth";
     func = "media";

     globals = { /* ... */ };
     passes = [ /* ... */ ];

     onInit() {
       this.state.imageWidth = 1;
       this.state.imageHeight = 1;
     }

     onUpdate(_context) {
       return {
         imageSize: [this.state.imageWidth || 1, this.state.imageHeight || 1]
       };
     }

     // Additional custom methods
     setMediaDimensions(width, height) {
       this.state.imageWidth = width;
       this.state.imageHeight = height;
     }
   }

**When to use class-based effects:**

- You need custom methods beyond lifecycle hooks
- You have complex module-level setup (e.g., building enum choices from imports)
- The effect requires external resource management

**Lifecycle Method Contract:**

The runtime invokes these methods at specific stages:

- ``onInit()``: Called once when the effect is loaded. Initialize state here.
- ``onUpdate({ time, delta, uniforms })``: Called every frame before rendering. Return an object of computed uniforms.
- ``onDestroy()``: Called when the effect is removed. Clean up resources here.

.. code-block:: javascript

   // Lifecycle methods can be defined in config or as class methods

   onInit() {
     this.state.generation = 0;
     this.state.lastUpdate = 0;
   }

   onUpdate({ time, delta, uniforms }) {
     // Update state periodically
     if (time - this.state.lastUpdate > 0.1) {
       this.state.generation++;
       this.state.lastUpdate = time;
     }

     // Return computed uniforms for this frame
     return {
       u_generation: this.state.generation,
       u_computed_value: Math.sin(time) * uniforms.intensity
     };
   }

   onDestroy() {
     // Cleanup resources (e.g., event listeners, audio contexts)
   }

6. Effect Constructor Reference
-------------------------------

The ``Effect`` constructor accepts a configuration object. Common properties
are listed below; Section 7 summarizes the remaining fields copied by the
current constructor.

**Required:**

- ``name`` (string): Display name for the effect
- ``passes`` (array): One or more render/compute passes

**Optional:**

- ``namespace`` (string): Logical grouping (e.g., ``"filter"``, ``"synth"``, ``"mixer"``)
- ``func`` (string): DSL function name used by runtime registration
- ``tags`` (array): Curated tags for categorization (see section 2b)
- ``globals`` (object): Uniform parameters exposed to shaders and UI
- ``textures`` (object): Internal render targets
- ``onInit`` (function): Lifecycle hook called once on load
- ``onUpdate`` (function): Lifecycle hook called every frame
- ``onDestroy`` (function): Lifecycle hook called on cleanup

**Example - Minimal Effect:**

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js';

   export default new Effect({
     name: "Invert",
     namespace: "filter",
     func: "inv",
     passes: [
       {
         name: "main",
         program: "invert",
         inputs: { inputTex: "inputTex" },
         outputs: { fragColor: "outputTex" }
       }
     ]
   });

**Example - Effect with Globals and Textures:**

.. code-block:: javascript

   import { Effect } from '../../../src/runtime/effect.js';

   export default new Effect({
     name: "Blur",
     namespace: "filter",
     func: "blur",

     globals: {
       radiusX: { type: "float", default: 5.0, min: 0, max: 50, uniform: "radiusX" },
       radiusY: { type: "float", default: 5.0, min: 0, max: 50, uniform: "radiusY" }
     },

     textures: {
       _blurTemp: { width: "screen", height: "screen", format: "rgba8unorm" }
     },

     passes: [
       {
         name: "blurH",
         program: "blurH",
         inputs: { inputTex: "inputTex" },
         outputs: { fragColor: "_blurTemp" }
       },
       {
         name: "blurV",
         program: "blurV",
         inputs: { inputTex: "_blurTemp" },
         outputs: { fragColor: "outputTex" }
       }
     ]
   });

7. Configuration Shape (Informative)
-------------------------------------

The following pseudocode summarizes the authoring shape consumed by the current
runtime. It is not an enforced JSON Schema: the structure harness's
``validateEffectDefinition()`` performs only the limited checks described in
the pipeline guide. Regular expressions are shown in ``/.../`` form.

.. code-block:: javascript

   // Deliberately abridged shape; validation is described above.
   {
     "type": "object",
     "required": ["name", "passes"],
     "properties": {
       "name": { "type": "string", "description": "Non-empty display name; spaces are allowed" },
       "namespace": { "type": "string", "description": "Logical namespace" },
       "func": { "type": "string", "description": "DSL function name for this effect" },
       "description": { "type": "string" },
       "tags": { "type": "array", "items": { "type": "string" } },
       "globals": { "type": "object", "additionalProperties": { "$ref": "#/definitions/uniformSpec" } },
       "textures": { "type": "object", "additionalProperties": { "$ref": "#/definitions/textureSpec" } },
       "passes": { "type": "array", "minItems": 1, "items": { "$ref": "#/definitions/passSpec" } },
       "outputTex3d": { "type": "string", "description": "Internal texture name to expose as 3D volume output" },
       "outputGeo": { "type": "string", "description": "Internal texture name to expose as geometry buffer output" },
       "uniformLayout": { "type": "object" },
       "uniformLayouts": { "type": "object" },
       "paramAliases": { "type": "object" },
       "openCategories": { "type": "array", "items": { "type": "string" } },
       "defaultProgram": { "type": "string" },
       "hidden": { "type": "boolean" },
       "deprecatedBy": { "type": "string" },
       "onInit": { "type": "function" },
       "onUpdate": { "type": "function" },
       "onDestroy": { "type": "function" },
       "asyncInit": { "type": "function" }
     },
     "definitions": {
       "uniformSpec": {
         "type": "object",
         "required": ["type"],
         "properties": {
           "type": { "type": "string", "enum": ["boolean","color","float","geometry","int","mat3","member","palette","string","surface","vec2","vec3","vec4","volume"] },
           "default": { "description": "Optional effect-defined default." },
           "min": { "type": "number" },
           "max": { "type": "number" },
           "step": { "type": "number" },
           "choices": {
             "type": "object",
             "additionalProperties": { "type": "integer" },
             "description": "Map of label strings to integer values for dropdowns"
           },
           "enum": { "type": "string", "description": "Reference to a global enum key" },
           "ui": {
             "type": "object",
             "properties": {
               "label": { "type": "string" },
               "control": { "type": ["string", "boolean"] },
               "category": { "type": "string", "pattern": "^[a-z][a-zA-Z0-9]*$", "description": "UI grouping category (MUST be camelCase)" },
               "hint": { "type": "string", "description": "Tooltip text for the control" },
               "enabledBy": { 
                 "oneOf": [
                   { "type": "string", "description": "Parameter name for truthy check" },
                   { "$ref": "#/definitions/enableCondition" }
                 ],
                 "description": "Condition that must be satisfied for this control to be enabled"
               }
             }
           },
           "requires": {
             "type": "object",
             "description": "Conditional visibility logic (e.g. show this uniform only if another uniform has a specific value)"
           }
         }
       },
       "dimensionSpec": {
         "oneOf": [
           {"type": "number"},
           {"type": "string", "description": "screen, auto, or a percentage parsed with parseFloat"},
           {"type": "object", "required": ["scale"], "properties": {"scale": {"type":"number"}, "clamp": {"type":"object", "properties": {"min": {"type":"number"}, "max": {"type":"number"}}}}},
           {"type": "object", "required": ["param"], "properties": {"param": {"type":"string"}, "paramDefault": {"type":"number"}, "default": {"type":"number"}, "multiply": {"type":"number"}, "power": {"type":"number"}}},
           {"type": "object", "required": ["screenDivide"], "properties": {"screenDivide": {"type":"string"}, "default": {"type":"number"}}}
         ]
       },
       "textureSpec": {
         "type": "object",
         "properties": {
           "width": { "$ref": "#/definitions/dimensionSpec" },
           "height": { "$ref": "#/definitions/dimensionSpec" },
           "depth": { "$ref": "#/definitions/dimensionSpec" },
           "format": { "type": "string" }
         },
         "description": "User-defined textures. Width and height default to screen; format defaults to rgba16f."
       },
       "enableCondition": {
         "type": "object",
         "description": "Conditional expression for enabledBy",
         "properties": {
           "param": { "type": "string", "description": "Parameter name to check" },
           "eq": { "description": "Equal to value" },
           "neq": { "description": "Not equal to value" },
           "gt": { "type": "number", "description": "Greater than" },
           "gte": { "type": "number", "description": "Greater than or equal" },
           "lt": { "type": "number", "description": "Less than" },
           "lte": { "type": "number", "description": "Less than or equal" },
           "in": { "type": "array", "description": "Value is member of array" },
           "notIn": { "type": "array", "description": "Value is not member of array" },
           "or": { "type": "array", "items": { "$ref": "#/definitions/enableCondition" }, "description": "Any condition must be true" },
           "and": { "type": "array", "items": { "$ref": "#/definitions/enableCondition" }, "description": "All conditions must be true" },
           "not": { "$ref": "#/definitions/enableCondition", "description": "Invert condition" }
         }
       },
       "passSpec": {
         "type": "object",
         "required": ["program"],
         "properties": {
           "name": { "type": "string" },
           "program": { "type": "string" },
           "inputs": { "type": "object", "additionalProperties": {"type":"string"} },
           "outputs": { "type": "object", "additionalProperties": {"type":"string"} },
           "entryPoint": { "type": "string" },
           "drawMode": { "type": "string" },
           "drawBuffers": { "type": "integer", "minimum": 1 },
           "count": { "type": ["integer", "string"] },
           "countUniform": { "type": "string" },
           "repeat": { "type": ["integer", "string"] },
           "blend": {},
           "uniforms": { 
             "type": "object", 
             "additionalProperties": { "type": "string" },
             "description": "Shader uniform name to effect-global parameter name."
           },
           "workgroups": { "type": "array", "items": {"type":"integer","minimum":1}, "minItems":1, "maxItems":3 },
           "storageBuffers": { "type": "object" },
           "storageTextures": { "type": "object" }
         }
       }
     }
   }

Backend format-name handling is described in Section 7.3.

7.1 Reserved Texture Names
^^^^^^^^^^^^^^^^^^^^^^^^^^

The runtime synthesizes these textures automatically. Do not define them in ``textures``.

**2D Pipeline (standard):**

* ``inputTex`` — 2D input from the previous effect in the chain
* ``outputTex`` — 2D output to the next effect in the chain

**3D Pipeline (volumetric):**

* ``inputTex3d`` — 3D volume input from the previous effect
* ``outputTex3d`` — Effect-level property pointing to an internal texture to expose as 3D output

**Geometry Pipeline:**

* ``inputGeo`` — Geometry buffer (normals + depth) from upstream raymarched effect
* ``outputGeo`` — Effect-level property pointing to an internal texture to expose as geometry output

Effects that produce 3D volumes or geometry buffers declare the output at effect level:

.. code-block:: javascript

   export default new Effect({
     name: "VolumeGenerator",
     namespace: "synth3d",
     textures: {
       volumeCache: { width: 64, height: 4096, format: "rgba16float" },
       geoBuffer: { width: "screen", height: "screen", format: "rgba16float" }
     },
     passes: [ /* ... */ ],
     outputTex3d: "volumeCache",  // Expose volumeCache as 3D output
     outputGeo: "geoBuffer"       // Expose geoBuffer as geometry output
   });

7.2 Dimension Resolution Algorithm
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

For each texture dimension (``width`` or ``height``), resolve to integer pixels:

.. code-block:: js

   function resolveDimension(spec, screenSize, uniforms = {}) {
     if (typeof spec === 'number') return Math.max(1, Math.floor(spec))
     if (spec === 'screen' || spec === 'auto') return screenSize

     if (typeof spec === 'string' && spec.endsWith('%')) {
       const percent = parseFloat(spec)
       return Math.max(1, Math.floor(screenSize * percent / 100))
     }

     if (typeof spec === 'object') {
       // Param-based; `default` is the final fallback after transforms.
       if (spec.param !== undefined) {
         const hasTransform = spec.power !== undefined || spec.multiply !== undefined
         const paramDefault = spec.paramDefault ?? 64
         let value = uniforms[spec.param] ?? paramDefault
         if (spec.multiply !== undefined) value *= spec.multiply
         if (spec.power !== undefined) value = Math.pow(value, spec.power)
         if (hasTransform && uniforms[spec.param] === undefined && spec.default !== undefined) {
           value = spec.default
         }
         return Math.max(1, Math.floor(value))
       }

       // Screen-divide: { screenDivide: 'zoom', default: 1 }
       if (spec.screenDivide !== undefined) {
         const divisor = uniforms[spec.screenDivide] ?? spec.default ?? 1
         return Math.max(1, Math.round(screenSize / divisor))
       }

       // Scale-based: { scale: 0.5, clamp: { min: 64, max: 512 } }
       if (spec.scale !== undefined) {
         let computed = Math.floor(screenSize * spec.scale)
         if (spec.clamp) {
           if (spec.clamp.min !== undefined) computed = Math.max(spec.clamp.min, computed)
           if (spec.clamp.max !== undefined) computed = Math.min(spec.clamp.max, computed)
         }
         return Math.max(1, computed)
       }
     }

     return screenSize  // Fallback
   }

All dimensions MUST be positive integers. Numeric, percentage, parameter, and
scale results round down; ``screenDivide`` rounds to the nearest integer. A
minimum of 1px is enforced.

7.3 Backend Format Resolution
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Format names are resolved independently by each backend; there is no
capability negotiation or precision-downgrade policy.

* WebGL recognizes ``rgba8``, ``rgba16f``, ``rgba32f``, ``r8``, ``r16f``,
  and ``r32f``. Any other name falls back to the ``rgba8`` descriptor.
* WebGPU maps those compact names to their WebGPU equivalents, also recognizes
  the corresponding WebGPU-format spellings plus ``bgra8unorm``, and passes
  any other non-empty format string through unchanged. An omitted format
  resolves to ``rgba8unorm``.

Unsupported resolved formats or usages fail when the backend creates or uses
the texture; the resolver does not preflight device capabilities.
