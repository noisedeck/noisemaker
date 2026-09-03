# navierStokes

Stable-fluids Navier-Stokes solver

## Description

2D incompressible fluid simulation using Stam's stable-fluids method. On reset (or first frame),
the velocity field is seeded with several coherent vortex blobs and matching dye spots; the rest
of the solver evolves them. Each subsequent frame: semi-Lagrangian advect velocity and dye,
compute divergence, solve a pressure Poisson equation with Jacobi iterations, and subtract the
pressure gradient so the velocity is divergence-free. Renders the dye channel in monochrome
(apply a palette downstream for color). Press the stir button to re-seed.

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| tex | surface | none | - | Optional input surface |
| zoom | int | x4 | x1/x2/x4/x8/x16/x32 | Sim resolution divider |
| iterations | int | 20 | 4-40 | Jacobi pressure iterations |
| smoothing | int | linear | constant/linear/hermite/catmullRom3x3/catmullRom4x4/bSpline3x3/bSpline4x4 | Display interpolation |
| speed | float | 60 | 5-145 | Timestep multiplier |
| dyeDecay | float | 99 | 80-100 | Dye persistence per frame (×0.01) |
| velocityDecay | float | 99 | 80-100 | Velocity drag per frame (×0.01) |
| inputForce | float | 0 | 0-100 | Mix input luminance gradient into velocity |
| inputDye | float | 0 | 0-100 | Mix input brightness into dye |
| seed | int | 1 | 1-100 | Random seed |
| inputIntensity | float | 0 | 0-100 | Output blend with input texture |
| resetState | boolean | false | - | Re-stir the fluid |
