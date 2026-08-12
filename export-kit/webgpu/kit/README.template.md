# {{NM_PROGRAM_NAME}}

A WebGPU page exported from Noisedeck. It plays your program with the same Noisemaker engine the app
uses, asking for WebGPU first and falling back to WebGL2 where the browser has none. It fetches
nothing at runtime.

## Run it

Browsers refuse ES modules over `file://`, so serve the folder. From this directory:

```
python3 -m http.server 8000
```

Open <http://localhost:8000/>. No backend, no build step, no npm.

## What's inside

| Path | What it is |
| --- | --- |
| `index.html` | The page. Your program is inlined in its `<script type="module">` block. |
| `program.dsl` | Your program's source, exactly as Noisedeck had it. |
| `noisedeck-export.json` | What was exported, when, against which engine build. |
| `shaders/` | The WGSL behind each effect you used. Present if you kept **include shader code** checked. |
| `vendor/noisemaker/` | The Noisemaker engine `{{NM_ENGINE_VERSION}}`. Present if you kept **include engine code** checked. |
| `LICENSES/` | Licenses for everything shipped here. |

## The engine

Left **include engine code** checked? Everything's here. Open the page and it runs offline.

Unchecked? Copy your engine to `vendor/noisemaker/`, or point the imports at your copy. The page
reads two paths, both near the top of the `<script type="module">` block:

```js
const ENGINE_URL  = './vendor/noisemaker/noisemaker-shaders-core.esm.min.js';
const BUNDLE_PATH = './effects';   // resolved against the engine module, not the page
```

`BUNDLE_PATH` is relative to the engine, not to `index.html`. That is how the engine loads effect
bundles, so leave it alone unless your effects live somewhere other than beside the engine.

This export is pinned to Noisemaker `{{NM_ENGINE_VERSION}}`. Pinning is deliberate: the page keeps
rendering the same way after the engine moves on.

## Editing it

`index.html` holds your program as a string:

```js
const DSL = "...";
```

Replace it with anything the Noisemaker language accepts and reload. Effects not already under
`vendor/noisemaker/effects/` will fail to load, so stay within the set below or add the bundles you
need.

Playback loops every 15 seconds (`LOOP_SECONDS`). The canvas follows the window, capped at 2x device
pixel ratio. If the program fails to start the page says so on screen and puts the full error in the
console.

## Effects used by this program

{{NM_EFFECT_LIST}}

## Browser support

WebGPU needs a recent Chrome, Edge, Safari 18+, or Firefox with WebGPU enabled, served over
`http://localhost` or HTTPS. Without it the page renders through WebGL2 and the footer says so, so
the export never comes up blank.

Effects reach this page only if they carry a WGSL shader. That is the whole current effect set.

## License

The Noisemaker engine is MIT licensed; see `LICENSES/`. Your program and the imagery it renders are
yours.
