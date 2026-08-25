# Noisemaker Rendering Pipeline

> **This is a short summary.** The full Shaders documentation lives at
> **<https://docs.noisemaker.app/shaders/>**. Each section
> heading below links to the corresponding page or section in the full docs.

The Noisemaker Rendering Pipeline is a high-performance, backend-agnostic system designed to execute complex, multi-pass visual effects on the GPU. It supports both WebGL 2 and WebGPU, allowing for declarative effect definitions and a powerful live-coding experience via the Polymorphic DSL that powers the Noisemaker Shader Effects Collection.

## [Core Philosophy](https://docs.noisemaker.app/shaders/)

- **Declarative Effects**: Effects are defined as data (JSON graphs), enabling easy composition and modification.
- **Graph-Based Execution**: The pipeline treats the entire frame as a Directed Acyclic Graph (DAG) of passes, optimizing execution order and resource usage.
- **Backend Agnostic**: The runtime abstracts away the differences between WebGL 2 and WebGPU.
- **Zero CPU Readback**: All data flow happens on the GPU to maximize performance.
- **Compute First**: First-class support for compute shaders.

## [Compute Passes and GPGPU Fallback](https://docs.noisemaker.app/shaders/pipeline/)

Effects that perform state updates, simulations, or multi-output operations use `type: "compute"` in their pass definitions for **semantic correctness**. This clearly communicates the intent of the pass.

### Backend Handling

- **WebGPU (WGSL)**: Native compute shaders with `@compute` entry points
- **WebGL2 (GLSL)**: Graceful fallback to GPGPU render passes

The WebGL2 backend automatically converts compute passes to render passes using a GPGPU pattern:
- Fragment shaders perform the "compute" work
- Multiple Render Targets (MRT) handle multi-output passes via `gl.drawBuffers()`
- Points draw mode enables scatter operations for agent-based effects

### Example

```javascript
// Effect definition uses semantic type: "compute"
{
  id: "agent-update",
  type: "compute",  // Semantically correct - this updates state
  outputs: ["state1", "state2"],  // Multi-output
  shader: { glsl: agentShaderGLSL, wgsl: agentShaderWGSL }
}
```

On WebGPU, this dispatches a compute shader. On WebGL2, the runtime converts it to a render pass with MRT, achieving the same result with maximum compatibility.

### [Agent-Based Effects](https://docs.noisemaker.app/shaders/#agent-based-effects)

Effects like `erosion_worms` and `physarum` use agents that:
1. Read state from textures
2. Update positions/velocities via compute/GPGPU passes
3. Deposit trails using points draw mode (scatter)
4. Diffuse/blur accumulated trails

This pattern requires MRT for multi-output state updates and careful texture management.

## Live Demo

Explore the pipeline's effects with the interactive demo:

- **[index.html](index.html)**: Live demo showcasing all effects with a two-column interface featuring real-time parameter controls and GLSL/WGSL backend selection.

## Documentation

Full specifications live on Read the Docs:

- **[Effects Specification](https://docs.noisemaker.app/shaders/effects/)** — schema and format for defining effects as JSON graphs.
- **[Language Specification](https://docs.noisemaker.app/shaders/language/)** — Polymorphic DSL used to chain effects.
- **[Pipeline Specification](https://docs.noisemaker.app/shaders/pipeline/)** — pipeline architecture, graph compilation, resource allocation, and execution phases.
- **[Compiler Specification](https://docs.noisemaker.app/shaders/compiler/)** — how the DSL is compiled into an executable GPU Render Graph.
- **[Integration Guide](https://docs.noisemaker.app/shaders/integration/)** — embedding shader bundles into downstream apps.
- **[Features Overview](https://docs.noisemaker.app/shaders/features/)** — capabilities catalog.

## [Effect Directory Structure](https://docs.noisemaker.app/shaders/#project-structure)

Effects are organized by namespace under `effects/`:

```
effects/
├── synth/          # Source generators (noise, patterns, fractals, cellular automata)
├── filter/         # Single-input transforms (distortion, color, blur, overlays)
├── mixer/          # Two-input compositing (blend modes, masks, splits)
├── points/         # Agent/particle simulations (physarum, flocking, DLA)
├── render/         # Rendering utilities (mesh, points, 3D, loops)
├── filter3d/       # 3D filter effects
├── synth3d/        # 3D source generators (raymarching, voxels)
└── classicNoisedeck/  # Legacy Noisedeck effects
```

Each effect lives in its own directory:

```
effects/{namespace}/{effectName}/
├── definition.js          # Effect metadata, parameters, and pass graph
├── help.md                # Parameter documentation
├── glsl/{program}.glsl    # WebGL2 fragment shaders
└── wgsl/{program}.wgsl    # WebGPU shaders
```

## Mesh Assets

Procedural OBJ meshes for 3D rendering effects are in `share/meshes/`:

| File | Shape |
|------|-------|
| `sphere.obj` | UV sphere |
| `cube.obj` | Unit cube |
| `torus.obj` | Torus (ring in XZ, tube axis Y) |
| `icosphere.obj` | Icosphere |
| `cylinder.obj` | Cylinder |
| `cone.obj` | Cone |
| `capsule.obj` | Capsule |

These are serialized by `share/meshes/generate.cjs` from the scene graph's own generators in
`shaders/src/geometry/primitives.js`, and bundled into `dist/shaders/share/meshes/` for deployment.
Re-run `node share/meshes/generate.cjs` after changing a primitive.

Three differences from the pre-`primitives.js` assets are deliberate:

- **`cube.obj` and `icosphere.obj` used to render inside-out.** `runtime/obj-parser.js` reverses
  face order on read (OBJ CW to GL CCW), and the old generator wrote those two shapes already
  counter-clockwise — 100% of their triangles (12/12 and 320/320) reached the GPU wound against
  their normals, so back-face culling showed the far interior. Regeneration fixed both; all seven
  assets now parse with zero inverted triangles.
- **`sphere.obj` and `capsule.obj` are mirrored in x.** `primitives.js` negates the x term of the
  normal formula (`-sin(phi) * cos(theta)` where the old generator used `+`). The silhouette is
  unchanged — these shapes are symmetric about the axis — but the `u = 0` seam sits on the
  opposite side, so uv columns land mirrored. The old assets carried no `vt` lines at all.
- **`torus.obj` is no longer rotated 90°** — the ring lies in XZ with the tube axis on Y, matching
  `createTorus`.

## [Architecture](https://docs.noisemaker.app/shaders/pipeline/)

The pipeline operates in three main phases:

1.  **Graph Compilation**: Parses the DSL, expands effects into constituent passes, and performs topological sorting.
2.  **Resource Allocation**: Manages a shared pool of textures and allocates them to graph nodes efficiently.
3.  **Execution**: Dispatches the render passes to the GPU driver.

## UI → Shader Data Flow

The demo UI follows a strict event-driven architecture to ensure maximum performance.

### Control Flow

```
User interacts with control (slider, checkbox, select)
    ↓
Event listener fires (change/input)
    ↓
Handler writes to state object (pass.uniforms, globalUniforms)
    ↓
Next render() frame picks up updated values
```

### Design Principles

| Principle | Implementation |
|-----------|----------------|
| Event-driven updates | Controls use `addEventListener('change')`, never polled |
| No DOM in render path | `render()` reads only from state objects |
| State as source of truth | `pass.uniforms` and `globalUniforms` hold current values |
| Immediate feedback | Sliders use `input` event for live preview |

### Performance Requirements

The render loop must be allocation-free and DOM-free:

- **No `new Map()`** — use `.clear()` and reuse
- **No object spreads** — mutate in place
- **No DOM reads** — all values come from state objects
- **No `console.log()`** — remove debug logging from hot paths

These constraints ensure stable 60 FPS rendering regardless of effect complexity.

## [Bundling](https://docs.noisemaker.app/shaders/integration/)

Shader effects can be bundled into standalone JavaScript modules for distribution. This eliminates the need for runtime lazy-loading of individual shader files.

### Building Bundles

```bash
npm run bundle:shaders
```

This produces:

| Path | Description |
|------|-------------|
| `dist/shaders/noisemaker-shaders-core.esm.js` | Core runtime (CanvasRenderer, ProgramState, etc.) — no effects inlined |
| `dist/shaders/noisemaker-shaders-core.esm.min.js` | Minified ESM variant |
| `dist/shaders/noisemaker-shaders-core.min.js` | Minified IIFE variant (exposes `window.NoisemakerShadersCore`) |
| `dist/effects/<namespace>/<effect>.js` | Per-effect bundle with shaders inlined |
| `dist/shaders/effects/manifest.json` | Effect registry consumed by `renderer.loadManifest()` |

### Using Bundles

The core bundle is loaded once. Each effect you use is fetched on demand from `dist/effects/` via `renderer.loadEffect()` (or `loadEffects([...])` for several at once) before `renderer.compile()`:

```javascript
import { CanvasRenderer } from './dist/shaders/noisemaker-shaders-core.esm.min.js';

const renderer = new CanvasRenderer({
    canvas,
    width: 512, height: 512,
    basePath: './dist/shaders',   // core bundle + effects/manifest.json
    useBundles: true,
    bundlePath: './dist/effects'  // per-effect bundles
});

await renderer.loadManifest();
await renderer.loadEffect('synth/noise');
await renderer.compile('search synth\nnoise().write(o0)\nrender(o0)');

renderer.start();
```

---

For double buffering, multi-pass internals, feedback effects, iteration, test
commands, and downstream integration, see the
[full Shaders docs on Read the Docs](https://docs.noisemaker.app/shaders/).
