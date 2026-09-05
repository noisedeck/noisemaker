import { Effect } from '../../../src/runtime/effect.js'

/**
 * synth/remap — Polygon-zone router.
 *
 * Renders up to eight polygonal zones, each routed to one engine surface
 * (any of o0..o7, written by an upstream effect). Noisedeck's canvas editor
 * and portable Remap map imports fill the per-zone vertex uniforms here.
 * Each zone declares its source via a `zoneN_tex` surface input,
 * wired in DSL: `remap(zone0_tex: read(o0), zone1_tex: read(o3))`.
 *
 * Zone vertices are packed two per vec4 (xy = vert n, zw = vert n+1) for
 * eight zones × 32 vertex pairs. Zones with vertexCount < 3 or with
 * zoneN_tex unwired (default "none") are skipped, and pixels falling
 * outside every active zone show the background color.
 *
 * Geometry correction (warping the rectangular projector output onto a
 * non-rectangular physical surface — e.g. a curved wall or a tilted
 * screen) is intentionally NOT in this effect. Use the projector's
 * keystone or 4-corner correction instead. A future revision may bring
 * back an 8-handle Coons-patch warp for the cases hardware can't handle
 * (curved surfaces, multi-target, multi-projector edge blends).
 */

const MAX_ZONES = 8
const MAX_VERTS_PER_ZONE = 64

// Build the uniformLayout programmatically so the per-zone slots stay in sync.
// Layout (267 vec4 slots total):
//   slot 0:      bgR, bgG, bgB, bgAlpha
//   slot 1:      zoneCount, smoothEdge, _, time
//   slot 2..9:   zone meta (xyzw = vertexCount, active, _, alpha) for zones 0..7
//                `active` is set by the runtime via colorModeUniform: 1 when
//                the zoneN_tex surface input is wired, 0 when it's "none".
//   slot 10..265: zone polygons
//                Each zone gets MAX_VERTS_PER_ZONE/2 = 32 vec4s
//                packed vec4 = (vert n.x, vert n.y, vert n+1.x, vert n+1.y)
//   slot 266.xy: resolution (auto-filled by the runtime; needed because
//                this is a starter effect with no inputTex binding)
const uniformLayout = (() => {
    const layout = {
        bgColor:     { slot: 0, components: 'xyz' },
        bgAlpha:     { slot: 0, components: 'w' },
        zoneCount:   { slot: 1, components: 'x' },
        smoothEdge:  { slot: 1, components: 'y' },
        time:        { slot: 1, components: 'w' },
        resolution:  { slot: 10 + MAX_ZONES * (MAX_VERTS_PER_ZONE / 2), components: 'xy' }
    }
    for (let z = 0; z < MAX_ZONES; z++) {
        const metaSlot = 2 + z
        layout[`zone${z}_count`]  = { slot: metaSlot, components: 'x' }
        layout[`zone${z}_active`] = { slot: metaSlot, components: 'y' }
        layout[`zone${z}_alpha`]  = { slot: metaSlot, components: 'w' }
        for (let pair = 0; pair < MAX_VERTS_PER_ZONE / 2; pair++) {
            const slot = 10 + z * (MAX_VERTS_PER_ZONE / 2) + pair
            layout[`zone${z}_v${pair}`] = { slot, components: 'xyzw' }
        }
    }
    return layout
})()

const passInputs = (() => {
    const inputs = {}
    for (let z = 0; z < MAX_ZONES; z++) inputs[`zone${z}_tex`] = `zone${z}_tex`
    return inputs
})()

export default new Effect({
  name: "Remap",
  namespace: "synth",
  func: "remap",
  tags: ["geometric", "blend"],

  description: "Polygon zones routed to engine surfaces (companion to the Remap zone-editor app)",
  openCategories: ["general"],

  uniformLayout,

  globals: {
    zoneCount: {
      type: "int",
      default: 0,
      uniform: "zoneCount",
      min: 0,
      max: MAX_ZONES,
      step: 1,
      ui: { label: "zone count", control: "slider" }
    },

    bgColor: {
      type: "color",
      default: [0, 0, 0],
      uniform: "bgColor",
      ui: { label: "background", control: "color" }
    },

    bgAlpha: {
      type: "float",
      default: 1.0,
      uniform: "bgAlpha",
      min: 0,
      max: 1,
      ui: { label: "background alpha", control: "slider" }
    },

    smoothEdge: {
      type: "float",
      default: 0.04,
      uniform: "smoothEdge",
      min: 0,
      max: 1,
      step: 0.01,
      ui: { label: "edge smoothing", control: "slider" }
    },

    ...makeZoneGlobals()
  },

  // Demo program — proves the effect compiles. Users populate real
  // zones via canvas editing or portable map import in Noisedeck.
  defaultProgram: "search synth\n\nremap(bgColor: #336699, bgAlpha: 1)\n  .write(o0)",

  passes: [
    {
      name: "render",
      program: "remap",
      inputs: passInputs,
      outputs: { fragColor: "outputTex" }
    }
  ]
})

// Helper for the per-zone globals. Defined here (after the Effect
// export) on purpose — function declarations hoist to the top of the
// module, so the spread `...makeZoneGlobals()` above still works at
// load time, while the source-text scanner that reads this file looking
// for top-level `hidden: true` (the manifest-generator's autodetect for
// "this whole effect is hidden") only sees text up to the `globals: {`
// substring. Keeping this body AFTER that substring lets us use
// `hidden: true` on per-param `ui:` blocks without false-positiving the
// effect itself out of the dropdown. `ui.hidden` (vs. `ui.control:
// false`) is also what programState's `_buildParameterOverrides` looks
// for when deciding which params to round-trip through DSL on
// serialization — required for the loader UI to survive a recompile.
function makeZoneGlobals() {
    const out = {}
    for (let z = 0; z < MAX_ZONES; z++) {
        // Zone N's UI controls light up only when zoneCount > N — so with
        // zoneCount = 0 nothing under "zone 1" is interactable, with
        // zoneCount = 2 zones 1 and 2 are interactable, etc.
        const enabled = { enabledBy: { param: 'zoneCount', gt: z } }
        const cat = `zone ${z + 1}`
        out[`zone${z}_tex`] = {
            type: 'surface',
            default: 'none',
            colorModeUniform: `zone${z}_active`,
            ui: { label: `zone ${z + 1} source`, category: cat, ...enabled }
        }
        out[`zone${z}_count`] = {
            type: 'int',
            default: 0,
            uniform: `zone${z}_count`,
            min: 0,
            max: MAX_VERTS_PER_ZONE,
            ui: { label: 'vertices', control: 'slider', hidden: true, category: cat, ...enabled }
        }
        out[`zone${z}_alpha`] = {
            type: 'float',
            default: 1.0,
            uniform: `zone${z}_alpha`,
            min: 0,
            max: 1,
            ui: { label: 'alpha', control: 'slider', category: cat, ...enabled }
        }
        for (let pair = 0; pair < MAX_VERTS_PER_ZONE / 2; pair++) {
            out[`zone${z}_v${pair}`] = {
                type: 'vec4',
                default: [0, 0, 0, 0],
                uniform: `zone${z}_v${pair}`,
                ui: {
                    label: `verts ${pair * 2}–${pair * 2 + 1}`,
                    control: 'slider',
                    hidden: true,
                    format: 'vector',
                    category: cat
                }
            }
        }
    }
    return out
}
