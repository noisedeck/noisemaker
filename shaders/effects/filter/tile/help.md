# tile

Symmetry-based kaleidoscope tiler. Applies wallpaper-group symmetry operations to produce seamlessly tileable patterns from any input.

## Description

Selects a region of the input and folds it using mirror or rotational symmetry. The output tiles seamlessly when repeated. Inspired by Terrazzo-style pattern generation.

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| symmetry | int | mirrorXY | mirrorXY/rotate2/rotate4/rotate6 | Symmetry group |
| scale | float | 1.0 | 0.1-4.0 | Scale of source sampling region |
| offsetX | float | 0 | -1 to 1 | Pan source region horizontally |
| offsetY | float | 0 | -1 to 1 | Pan source region vertically |
| angle | float | 0 | 0-360 | Rotate the entire tiled output |
| repeat | float | 2 | 1-10 | Number of tile repetitions to display |
| aspectLens | boolean | true | on/off | Correct tiles to square aspect ratio |

## Notes

- mirrorXY reflects both axes for a four-quadrant pattern
- rotate2 applies 180° rotational symmetry
- rotate4 produces square kaleidoscope patterns
- rotate6 produces hexagonal kaleidoscope patterns
- Adjust offset and scale to explore different regions of the input
- Angle rotates the entire output grid, preserving seamlessness
- Set repeat to 1 to output just the tile unit
- When 1:1 aspect is enabled, tiles are square on non-square canvases (more tiles along the longer axis). Disable if you need the output image itself to tile seamlessly at the canvas aspect ratio.
