# synth/remap

Polygon-zone router with live canvas editing in Noisedeck.

## Overview

Each pixel is tested against up to eight polygon zones. The first zone that contains the pixel decides which engine surface is sampled. Pixels outside every active zone — and pixels in zones whose source isn't wired — show the background color. Each zone has its own alpha and an edge smoothing factor blends adjacent zones smoothly.

In Noisedeck, edit zones directly over the live canvas from the Remap effect. Existing `.remap.json` maps can be imported, and the effect exports the same portable version 1 format.

## Workflow

1. Add Remap to your Noisedeck composition and choose **edit zones**.
2. Choose **add zone**, then click points on the live canvas. Click the first point or press Enter to finish; Escape cancels an unfinished shape.
3. Assign each zone a source using its source control. The mapped image updates as you drag vertices. Click an edge midpoint to insert a vertex; right-click a vertex to remove it.
4. Set zone names, outline colors, and opacity in the effect controls.
5. Choose **export remap config** to save the portable map, or **import remap config** to load an existing map.

The canvas editor manages the hidden shape parameters (`zoneN_count`, `zoneN_vP`). Runtime integrations can still apply these parameters through `applyStepParameterValues({ step_N: params })` and wire source surfaces in DSL with `zoneN_tex: read(oN)`. Existing maps and hexadecimal vertex literals remain valid.

## Parameters

### General
- **Zone count**: how many of the eight slots are active (0–8). Slots with `vertices < 3` or with `zoneN_tex` unwired are skipped automatically.
- **Background**: color for pixels outside every active zone.
- **Background alpha**: alpha channel for the background.
- **Edge smoothing**: soft falloff at polygon boundaries to hide aliased seams between adjacent zones.

### Zones (1–8)
For each zone:
- **Zone N source** (`zoneN_tex`): the engine surface to sample. Wire in DSL with `zoneN_tex: read(oN)`. When unwired (default `"none"`), the zone is skipped.
- **Alpha**: per-zone opacity.
- **Vertices** (hidden): vertex count, managed by canvas editing or map import.
- **verts P–P+1** (hidden): packed `vec4` holding two vertices, managed by canvas editing or map import.

## Coordinate space

Vertices are normalized: `(0, 0)` is top-left and `(1, 1)` is bottom-right. The GLSL backend flips the y axis internally so polygons match the canvas editor's orientation on either backend.

## Limits

- 8 zones (matches the eight engine user surfaces `o0`…`o7`)
- 64 vertices per zone

If you need more than 64 vertices per zone, decompose the polygon into multiple zones and wire them all to the same source surface.

## Geometry correction (deferred)

This effect intentionally does not include software geometry correction (warping the rectangular projector output onto a non-rectangular physical surface). For now, use your projector's keystone or 4-corner correction.

A future revision may bring back an 8-handle Coons-patch warp, suitable for the cases hardware can't handle:

- curved surfaces (cylinders, columns, fabric drops)
- non-contiguous targets (one projector hitting multiple separate surfaces)
- multi-projector setups with edge feathering

When that happens, the warp will be additive: the existing zone-routing semantics will not change, and the new uniforms will be opt-in.
