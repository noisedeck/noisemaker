# Mesh Render

**Note:** Mesh rendering is a proof of concept. The mesh loader currently only supports OBJ format.

Renders triangle meshes from mesh surface textures using the triangles draw mode.

## Usage

```
meshLoader().meshRender(scale: 1.5, offsetY: -0.5).write(o0)
```

## Parameters

### Mesh Transform
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| scale | float | 1.0 | Mesh scale factor |
| offsetX | float | 0.0 | Mesh X translation |
| offsetY | float | 0.0 | Mesh Y translation |
| offsetZ | float | 0.0 | Mesh Z translation |

### View
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| rotateX | float | 0.0 | Rotation around X axis (radians) |
| rotateY | float | 0.0 | Rotation around Y axis (radians) |
| rotateZ | float | 0.0 | Rotation around Z axis (radians) |
| viewScale | float | 1.0 | Zoom/scale factor |
| posX | float | 0.0 | Camera X position |
| posY | float | 0.0 | Camera Y position |

### Lighting
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| lightDirection | vec3 | 0.5,0.7,0.5 | Light direction |
| diffuseColor | color | [1.0, 1.0, 1.0] | Diffuse color |
| diffuseIntensity | float | 0.7 | Diffuse intensity (0.0-2.0) |
| specularColor | color | [1.0, 1.0, 1.0] | Specular color |
| specularIntensity | float | 0.3 | Specular intensity (0.0-2.0) |
| shininess | float | 32.0 | Specular exponent (1.0-256.0) |
| ambientColor | color | [0.1, 0.1, 0.1] | Ambient color |
| rimIntensity | float | 0.15 | Rim light intensity (0.0-1.0) |
| rimPower | float | 3.0 | Rim light falloff exponent (0.5-8.0) |

### Appearance
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| meshColor | color | [0.8, 0.8, 0.8] | Mesh surface color |
| bgColor | color | [0.1, 0.1, 0.15] | Background color |
| bgAlpha | float | 1.0 | Background opacity (0.0-1.0) |
| wireframe | int | solid | Render mode: solid or wireframe |

## Draw Mode

Uses `drawMode: "triangles"` - vertices are read from mesh textures via `texelFetch` 
in the vertex shader, similar to how `drawMode: "points"` works for particle systems.

## Pipeline Integration

Typically used after `meshLoader()`:

```
// Load and render with transform
meshLoader().meshRender(scale: 0.5, rotateY: time * 0.5).write(o0)
```

Can also be chained with filters:

```
meshLoader().meshRender().bloom(radius: 0.02).write(o0)
```
