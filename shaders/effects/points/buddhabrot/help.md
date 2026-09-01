# buddhabrot

Buddhabrot fractal via progressive orbit accumulation — agents test random c values and deposit escaped orbit traces

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| stateSize | int | 512 | - | Particle state texture size (no UI control) |
| mode | int | standard | anti/standard | Standard or anti-buddhabrot |
| maxIter | int | 200 | 20–2000 | Max orbit iterations |
| minIter | int | 1 | 1–1000 | Min orbit iterations |
| centerX | float | -0.5 | -3–3 | Center x |
| centerY | float | 0 | -3–3 | Center y |
| zoom | float | 1 | 0.1–5 | Zoom level |
