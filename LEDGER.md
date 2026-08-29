# Out-of-Band Ledger

Some layers of the platform are allowed to lag behind feature work: the
primary development pass ships the feature, and a separate catch-up pass
tops these layers off later. This file is the checkpoint record for those
passes.

Each section records:

- **Checkpoint** — the commit (SHA, date) through which the category is
  known to be caught up. "Caught up through X" describes what was audited,
  not where the fix landed. Cross-repo categories list one checkpoint per
  repo.
- **Scope** — what the pass owns.
- **Gap detection** — how to compute outstanding work since the checkpoint.
- **Log** — one line per completed pass, newest first.

Running a catch-up pass: compute the gap over `<checkpoint>..HEAD`, do the
work, verify it, then update the checkpoint and append a log line.

## I18n strings

- **Checkpoint:** noisemaker `11b7dd4f` / noisedeck `0d89bef0` (2026-08-29)
- **Scope:** two translation surfaces:
  - Noisemaker effect catalogs
    `shaders/effects/strings.{de,es,fr,it,ja,pt}.json`. The English catalog
    `strings.en.json` is generated from effect definitions (`npm run strings`)
    and drift-tested by `npm run test:shaders:i18n`.
  - Noisedeck UI catalogs under
    `app/js/i18n/locales/{de,es,fr,it,ja,pt}/`. The matching `en/` slices are
    the hand-authored source of truth.
  Missing locale keys fall back to English at runtime, so gaps on both
  surfaces are invisible without the checks below.
- **Gap detection:**
  1. Noisemaker — every key present in `strings.en.json` and absent from a
     locale file needs a translation. From `shaders/effects/`:

     ```
     node -e 'const fs=require("fs");const en=Object.keys(JSON.parse(fs.readFileSync("strings.en.json","utf8")));for(const l of["de","es","fr","it","ja","pt"]){const t=new Set(Object.keys(JSON.parse(fs.readFileSync("strings."+l+".json","utf8"))));const m=en.filter(k=>!t.has(k));if(m.length)console.log(l+":",m.join(", "))}'
     ```

     Keys stay in the same (sorted) order as the English catalog. Match each
     locale's existing conventions — parameter labels lowercase, effect names
     capitalized, description tone per locale — and reuse the file's existing
     translation for a term before inventing a new one. Run
     `npm run test:shaders:i18n` to enforce exact key order and non-empty values
     across all six translated catalogs, in addition to generated-English drift
     and runtime fallback behavior.
  2. Noisedeck — from its repository root, run the catalog-parity test. Its
     diff names every missing or extra leaf key by locale:

     ```
     node --test --test-timeout=60000 tests/i18n.node-test.js
     ```

     Add keys to the matching area slice in English order. The test enforces
     non-empty string values plus every placeholder, plural leaf, and markup tag
     from the English catalog.
- **Log:**
  - 2026-08-29 — caught up through noisemaker `11b7dd4f` / noisedeck
    `0d89bef0`: Noisemaker's generated English catalog and all six translated
    effect catalogs were already complete; added 306 Noisedeck translations
    (51 new UI leaves in each of six locales) for shader-pipeline export,
    collaboration, completion, and save-failure copy. Added durable Noisemaker
    key-order/non-empty-value checks and Noisedeck key-order, non-empty-value,
    placeholder, and markup integrity checks.
  - 2026-08-19 — caught up through `1ee891a2`: audited the i18n
    catch-up range; the English catalog was unchanged and all six locale
    catalogs remain complete, so no additional translations were needed in
    this pass.
  - 2026-08-14 — caught up through `712ac2cf`: audited the i18n
    catch-up range; the English catalog was unchanged and all six locale
    catalogs are now complete, so no additional translations were needed in
    this pass.
  - 2026-08-14 — catch-up, 1,566 strings: 261 missing keys across all six
    locales, covering the new and expanded `filter/chrome` through
    `filter/wind` effect blocks.
  - 2026-07-10 — initial top-off, 37 strings: `filter/parallax` block
    (5 keys, de/fr/it/ja/pt), `filter/dither.type.errorDiffusion` and
    `filter/lighting.heightMap` (all six locales).

## Large-format tiling

- **Checkpoint:** noisemaker `45a34489` / noisedeck `75262325` (preview
  branch), 2026-07-10
- **Scope:** every effect must be classified for Noisedeck's large-format
  (tiled print) export. Tile-aware effects consume the global `tileOffset`
  and `fullResolution` uniforms in both GLSL and WGSL (packed WGSL layouts
  may need explicit `uniformLayout` slots). Effects that cannot render
  tiled belong in one of noisedeck's deny-lists:
  `app/js/utils/hasStatefulEffects.js` (state textures cannot re-render at
  print resolution) or `app/js/utils/hasUpscaleOnlyEffects.js` (would seam
  at the 1024 px tile overlap). An effect in none of the three states
  silently produces seamed prints.
- **Gap detection:** list effects added since the checkpoint
  (`git log --diff-filter=A --name-only <checkpoint>..HEAD -- 'shaders/effects/*/*/definition.js'`)
  and classify each: make it tile-aware, or route it into the appropriate
  deny-list. Verify tile-aware claims with noisedeck's seam harness
  (`tests/large-format-seams/`).
- **Log:**
  - 2026-07-10 — post-ship catch-up: parallax tile-clamped + synth WGSL
    ports (noisemaker `45a34489`); effects added since ship routed into
    deny-lists, seam-harness hardening (noisedeck `a12ee01e`..`75262325`).
  - 2026-05-16 — feature shipped (noisemaker `f1b0a919`, noisedeck
    `913b722b`).

## Documentation

- **Checkpoint:** noisemaker `1ee891a2` (2026-08-18)
- **Scope:** the Sphinx docs under `docs/` (published to docs.noisemaker.app
  by `.github/workflows/docs-site.yml`) and the per-effect
  `shaders/effects/*/*/help.md` files rendered by the live Effect Reference.
  `help.md` is normally written in-band with the effect; this pass catches
  stragglers and decides which shipped features merit a narrative guide.
- **Gap detection:**
  1. Effects missing `help.md`: compare `shaders/effects/*/*/definition.js`
     against the corresponding `help.md` paths.
  2. Features shipped since the checkpoint that merit a guide under
     `docs/shaders/features.rst` (pattern: `docs/shaders/cubemaps.rst`).
  3. Narrative statements invalidated by recent commits (grep the affected
     terms in `docs/`).
- **Log:**
  - 2026-08-19 — caught up through `1ee891a2`: verified `help.md`
    coverage for all 210 effects and audited the shader-parity attestation
    infrastructure, PixelSort parity repair, JS/Python parity corrections,
    fixture tooling, and dependency updates in the range; updated the release
    workflow narrative for the new CPU parity-attestation gate, while no new
    effect or user-facing feature required an additional feature guide.
  - 2026-08-14 — caught up through `24c7053c`: verified `help.md`
    coverage for all 210 effects and audited the renderer-output guide and
    navigation links, i18n catalogs, AI contract, CI, and vendored tooling in
    the range; the existing guide covers the only Sphinx-relevant feature, so
    no additional narrative changes were needed in this pass.
  - 2026-08-14 — caught up through `0d34e10d`: verified `help.md`
    coverage for all 210 effects, added the renderer-output guide for sinks
    and bounded asynchronous frame export, and audited the in-band export-kit,
    static-site, effect-authoring, and repository-link changes; no other
    Sphinx narrative was invalidated.
  - 2026-08-11 — caught up through `f33b5bfb`: verified `help.md`
    coverage for all 210 effects and audited the AI development contract
    refresh plus the prior documentation catch-up; neither shipped a shader
    feature nor invalidated Sphinx narrative, so no guide or narrative edits
    were needed.
  - 2026-08-11 — caught up through `7cc4894b`: verified `help.md`
    coverage for all 210 effects, corrected the remaining stale pre-move
    repository URL in the CLI help snapshot, and audited the Playwright and
    Ruff dependency bumps; no additional shader feature guides needed.
  - 2026-08-10 — caught up through `7cdf2b6d`: verified `help.md`
    coverage for all 210 effects (including 25 effects added since the
    checkpoint), corrected four stale pre-move noisemaker repository links,
    and audited the in-band coding-agents guide plus runtime fixes; no
    additional shader feature guides needed.
  - 2026-07-10 — initial catch-up: added `help.md` for
    `mixer/channelCombine` and `filter/temporalAberration`; added feature
    guides for parallax, the 3D pipeline, and mashup.

## AI development contract (llms-full.txt)

- **Checkpoint:** noisemaker `c767e481` / shade-mcp `ac4c6ba1`, 2026-08-29
- **Scope:** the hand-authored agent contract `llms-full.txt` — the
  executable-source companion served at the site root that describes
  *current* runtime behavior across nine surfaces (DSL, effect definition,
  parameters/globals, passes/graph, textures, compatibility/mutation,
  rendered output, cross-backend parity, Shade MCP tool contracts), a fully
  worked validated effect, the surface × capability traceability matrix, and
  the 29-entry gap register (GAP-001..024 and GAP-026..030). The file pins its
  own audited SHAs in the "Source snapshots used for this contract" block at
  its head; that block and this checkpoint are the same two SHAs and must be
  advanced together. There is no generator — every update is a hand edit
  verified against live source.
  The short public index `llms.txt` carries no pinned snapshot and is kept
  current in-band with its links, so it is not part of this pass.
- **Gap detection:**
  1. Noisemaker drift — commits since the noisemaker checkpoint touching the
     primary source roots the contract reads:

     ```
     git log --oneline c767e481..HEAD -- shaders/src/lang/ shaders/src/runtime/ shaders/src/renderer/canvas.js shaders/tests/test-harness.js
     ```

     Each can invalidate a behavior statement, typed grammar, or validator
     message, or change a gap's status. Re-audit the affected surface
     section(s) and re-check every gap whose "Source evidence" file changed.
  2. Shade MCP drift (GAP-013) — `.mcp.json` runs
     `npx -y github:noisedeck/shade-mcp` unpinned. Re-resolve it to its current
     commit; if it moved off the pinned shade-mcp SHA, re-capture `tools/list`
     (tool count and signatures) and the `shade-mcp` server/protocol version
     triple, then re-audit the "Shade MCP tool contracts" section and the
     MCP-side gaps.
- **Log:**
  - 2026-08-29 — caught up through noisemaker `c767e481` / shade-mcp
    `ac4c6ba1`: re-audited the two watched device-limit commits and documented
    the expanded capability object, numeric volume-atlas clamping across graph,
    host, and UI paths, WebGL MRT budget probing/error cleanup, and ordered
    full-to-half-float MRT adaptation across WebGL2/WebGPU. Rechecked the
    changed-source evidence for GAP-001/004/005/006/007/016/026; none closed.
    Opened GAP-030 because MRT adaptation mutates graph formats without
    invalidating same-size reused backend textures. Reproduced the worked source
    graph and device-limit regression gates. Shade MCP did not move in this
    Tearoff range, so its handshake, 18 tool schemas, historical browser
    transcript, and MCP-side gaps remain pinned unchanged.
  - 2026-08-14 — caught up through noisemaker `f6b22ab3` / shade-mcp
    `ac4c6ba1`: verified that no Noisemaker watched source root changed,
    re-resolved the unpinned MCP package, and recaptured the
    `shade-mcp`/`0.2.1`/`2025-06-18` handshake, all 18 tool schemas, the exact
    two-pass source graph, and the eight-call worked transcript. Re-audited
    the affected MCP contract sources and every MCP-side gap; documented the
    configurable browser/AI timeouts, headless/session lifecycle, restricted
    loopback/opaque-origin CORS, opt-in description image, refreshable effect
    index, and manifest invalidation, narrowed GAP-020 now that pixel parity
    also uses the shared `isError` wrapper, and opened GAP-029 for invalidation
    racing an already in-flight index rebuild.
  - 2026-08-11 — caught up through noisemaker `e1feefa0` / shade-mcp
    `346ee022`: documented the renderer sink and bounded asynchronous frame
    export contracts across WebGL2/WebGPU, rechecked every changed-source gap,
    and opened GAP-028 for pending accepted frames canceled without a terminal
    queue result. Re-resolved the unpinned MCP package; recaptured the
    `shade-mcp`/`0.1.4`/`2025-06-18` handshake, all 18 tool schemas, and the
    eight-call worked transcript after the Node 22/SDK/Zod upgrades.
  - 2026-08-10 — caught up through noisemaker `7cc4894b` / shade-mcp
    `3e531fc6`: re-audited Noisemaker runtime drift; re-resolved the unpinned
    MCP package; recaptured the `shade-mcp`/`0.1.4`/`2025-06-18` handshake,
    all 18 tool signatures, and the worked transcript; narrowed GAP-020 for
    the new whole-call `isError` marker; closed GAP-025.
  - 2026-07-14 — contract instrumented (`dc67827b`) at snapshot noisemaker
    `75507112` / shade-mcp `7fd0d975`: nine surface sections, worked validated
    effect, 9×4 traceability matrix, 26-gap register. Audited clean through
    `478989b6`; checkpoint established at the contract's own snapshot.
