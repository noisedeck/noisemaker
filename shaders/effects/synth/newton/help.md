# newton

Newton fractal explorer with deep zoom, variable polynomial degree, relaxation control, and curated points of interest

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| poi | int | hexWeb6 | manual/hexWeb6/octoFlower8/pentaSpiral5/spiralJunction3/starCenter5/triplePoint3 | Preset location |
| outputMode | int | blended | blended/iteration/rootIndex | Output algorithm |
| iterations | int | 100 | 10–500 | Max iterations |
| degree | int | 3 | 3–8 | Polynomial degree (manual mode) |
| relaxation | float | 1 | 0.5–2 | Newton relaxation factor |
| tolerance | float | 0.001 | 0.0001–0.01 | Convergence tolerance |
| centerX | float | 0 | -3–3 | Center x (manual mode) |
| centerY | float | 0 | -3–3 | Center y (manual mode) |
| rotation | float | 0 | -180-180 | Rotation (degrees) |
| zoomSpeed | float | 0 | 0–5 | Auto-zoom speed |
| zoomDepth | float | 0 | 0–14 | Zoom depth (powers of 10) |
| degreeSpeed | float | 0 | 0–1 | Degree animation speed (manual mode) |
| degreeRange | float | 0 | 0–3 | Degree animation range (manual mode) |
| relaxSpeed | float | 0 | 0–1 | Relaxation animation speed |
| relaxRange | float | 0 | 0–0.5 | Relaxation animation range |
| invert | boolean | false | - | Invert output |
