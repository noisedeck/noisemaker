# {{NM_PROGRAM_NAME}}

A WebGL2 page exported from Noisedeck. It plays your program with the same Noisemaker engine the app
uses. It fetches nothing at runtime.

## Run it

Browsers refuse ES modules over `file://`. Serve this folder with the following command, run from this directory:

```
python3 -m http.server 8000
```

Open <http://localhost:8000/>. No backend, build step, or npm is required.

## What's inside

| Path | What it is |
| --- | --- |
| `index.html` | The page. Its `<script type="module">` block contains your program inline. |
| `program.dsl` | Your program's source, exactly as it was in Noisedeck. |
| `noisedeck-export.json` | The exported content, export time, and engine build. |
| `shaders/` | The GLSL behind each effect you used. Present if you kept **include shader code** checked. |
| `vendor/noisemaker/` | The Noisemaker engine `{{NM_ENGINE_VERSION}}`. Present if you kept **include engine code** checked. |
| `LICENSES/` | Licenses for everything shipped here. |

## The engine

If you kept **include engine code** checked, the export includes everything. Open the page to run it offline.

If you cleared **include engine code**, copy your engine to `vendor/noisemaker/` or change the imports to reference your copy. The page reads two paths near the top of the `<script type="module">` block:

```js
const ENGINE_URL  = './vendor/noisemaker/noisemaker-shaders-core.esm.min.js';
const BUNDLE_PATH = './effects';   // resolved against the engine module, not the page
```

`BUNDLE_PATH` is relative to the engine, not to `index.html`. The engine uses this path to load effect bundles. Keep it unchanged unless your effects are in a different location from the engine.

This export is pinned to Noisemaker `{{NM_ENGINE_VERSION}}`. The page therefore keeps rendering the same way after the engine changes.

## Editing it

`index.html` holds your program as a string:

```js
const DSL = "...";
```

Replace the string with any valid Noisemaker program. Reload the page. Effects outside `vendor/noisemaker/effects/` will fail to load. Use the effects listed below or add the required bundles.

Playback loops every 15 seconds (`LOOP_SECONDS`). The canvas follows the window, capped at 2x device
pixel ratio. If the program fails to start, the page displays a message. It also writes the full error to the console.

## Effects used by this program

{{NM_EFFECT_LIST}}

## Browser support

WebGL2 runs in every current desktop and mobile browser. Heavy programs, and anything using 3D or
particles, want a discrete GPU for a smooth frame rate.

## License

The Noisemaker engine is MIT licensed. See `LICENSES/`. Your program and the imagery it renders are
yours.
