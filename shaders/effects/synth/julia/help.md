# julia

Julia set explorer with deep zoom, distance estimation, and curated c-value gallery

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| poi | int | doubleSpiral | manual/basilica/dendrite/douadyRabbit/doubleSpiral/dragonCurve/galaxy/lightning/sanMarco/siegel/starfish | Preset c-value |
| cReal | float | -0.123 | -2–2 | c real (manual mode) |
| cImag | float | 0.745 | -2–2 | c imaginary (manual mode) |
| cPath | int | none | none/bulb/cardioid/circle | Animated c-path |
| cSpeed | float | 0.3 | 0–2 | c animation speed |
| cRadius | float | 0.7885 | 0.01–1.5 | Circle path radius |
| centerX | float | 0 | -3–3 | Center x |
| centerY | float | 0 | -3–3 | Center y |
| rotation | float | 0 | -180–180 | Rotation (degrees) |
| outputMode | int | orbitTrap | distance/normalMap/orbitTrap/smoothIteration/stripeAverage | Output algorithm |
| iterations | int | 300 | 50–1000 | Max iterations |
| stripeFreq | float | 5 | 0.5–20 | Stripe frequency |
| trapShape | int | point | circle/cross/point | Orbit trap shape |
| lightAngle | float | 45 | 0–360 | Normal map light angle |
| invert | boolean | false | - | Invert output |
| zoomSpeed | float | 0 | 0–5 | Auto-zoom speed |
| zoomDepth | float | 0 | 0–14 | Zoom depth (powers of 10) |
