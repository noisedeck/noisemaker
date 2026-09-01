# RenderCubemap3D

Renders a 3D volume into seamless cubemap faces as a lit "blob in space" — a
multi-face clone of `render3d`. The camera sits at the volume center and looks
out through a 90-degree frustum per face (`cubeBasis`), so adjacent faces share
edge directions and tile without seams. Keeps render3d's lighting and gamma.

For the raw, true-color sample with no lighting or gamma, use `renderCubemapSurface`.

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| volumeSize | int | v64 | v16/v32/v64/v128 | Voxel grid resolution, inherited from the upstream volume effect (no UI control) |
| filtering | int | isosurface | isosurface/voxel | Render the volume as a smooth isosurface or blocky voxels |
| threshold | float | 0.5 | 0-1 | Surface threshold |
| invert | boolean | false | - | Invert the inside/outside test |
| cubeBasis | mat3 | identity | - | Cube face orientation basis (no UI control) |
| bgColor | color | 0.02,0.02,0.02 | - | Background color |
| bgAlpha | float | 1 | 0-1 | Background alpha |

## Notes

- **isosurface**: Smooth raymarching with trilinear interpolation and bisection refinement.
- **voxel**: DDA voxel traversal with flat face shading.

volumeSize is inherited from the upstream 3D effect.
