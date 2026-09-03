# pointsBillboardRender

Render agent particles as billboard sprites with built-in shapes or texture sampling

## Description

Each particle is rendered as a quad with a procedural SDF shape or external texture. Shapes include circle, ring, square, diamond, triangle, star, and a soft gaussian glow. Particles can be sized, rotated, and varied per-particle using deterministic noise.

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| shapeMode | int | circle | texture/circle/ring/square/diamond/triangle/star/soft | Particle shape |
| tex | surface | none | - | Sprite texture (only used when shape is "texture") |
| blendMode | int | additive | additive/alpha | Blend mode |
| depositOpacity | float | 20 | 1-100 | Deposit opacity — scales particle contribution to reduce additive blowout |
| pointSize | float | 8 | 1-64 | Point size |
| sizeVariation | float | 0 | 0-100 | Size variation |
| rotationVar | float | 0 | 0-100 | Rotation variation |
| seed | int | 42 | 0-1000 | Seed |
| density | float | 50 | 0-100 | Density |
| intensity | float | 75 | 0-100 | Trail intensity |
| inputIntensity | float | 10.15 | 0-100 | Input mix |
| viewMode | int | flat | flat/ortho | View |
| rotateX | float | 0.3 | 0-6.283185 | Rotate X |
| rotateY | float | 0 | 0-6.283185 | Rotate Y |
| rotateZ | float | 0 | 0-6.283185 | Rotate Z |
| viewScale | float | 0.8 | 0.1-10 | Zoom |
| posX | float | 0 | -50-50 | Pos X |
| posY | float | 0 | -50-50 | Pos Y |
