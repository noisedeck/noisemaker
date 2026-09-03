# flythrough3d

3D fractal flythrough volume generator with camera-relative sampling.

## Description

Generates a moving volume-of-interest (VOI) that samples fractal space around a spline-based camera path. Designed for deep interior flythroughs of Mandelbulb and Mandelbox fractals with smooth navigation and collision avoidance.

## Key Features

- **Camera-relative VOI**: The voxel grid moves with the camera, sampling fractal space around the current position
- **Distance estimation**: Uses DE for stable shell rendering, normals, and collision avoidance
- **Spline pathing**: Smooth Catmull-Rom spline trajectory through fractal space
- **Collision avoidance**: Automatic push-away from surfaces using DE gradient
- **Hybrid density**: Thin surface shell + soft interior haze for depth
- **Orbit trap coloring**: Rich color variation based on fractal dynamics

## Parameters

### Fractal

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `type` | int | mandelbulb | mandelbulb/mandelbox | Fractal type |
| `power` | float | 8.0 | -3-16 | Mandelbulb power exponent |
| `iterations` | int | 12 | 4-24 | Fractal iteration depth |
| `bailout` | float | 4.0 | 1-16 | Escape radius |

### Camera

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `speed` | float | 0.2 | 0-1 | Flight speed along path |
| `voiSize` | float | 0.5 | 0.1-2 | Half-extent of view volume |

### Volume

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `volumeSize` | int | x64 | x16/x32/x64/x128 | Voxel grid resolution |
| `seed` | int | 0 | 0-100 | Flight path seed (no UI control) |

## Examples

Basic flythrough:
```
flythrough3d().render3d().write(o0)
```

Fast Mandelbulb flight:
```
flythrough3d(type: mandelbulb, speed: 0.5, power: 8).render3d().write(o0)
```

Deep Mandelbox interior:
```
flythrough3d(type: mandelbox, voiSize: 0.3).render3d().write(o0)
```

Voxel-style rendering:
```
flythrough3d().render3d(filtering: voxel, threshold: 0.4).write(o0)
```

## Architecture

1. **Flight Path**: Procedural spline through fractal space, seeded by `seed`
2. **VOI Transform**: Camera-relative bounding box mapped to voxel grid
3. **Fractal Sampling**: DE-based density with hybrid shell/interior
4. **Collision Response**: Gradient-based push when camera approaches surface
5. **Volume Output**: Compatible with render3d pipeline

## Tips

- **Mandelbox** with negative scale creates navigable cavern-like interiors
- **Lower voiSize** = more detail but smaller view distance
- Change **seed** for different flight paths through the same fractal
