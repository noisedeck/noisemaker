# renderLit3d

Universal 3D volume raymarcher with advanced lighting controls

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| volumeSize | int | v64 | v16/v32/v64/v128 | Volume resolution (inherited from upstream) |
| shape | int | cube | cube/sphere | Bounding shape for the volume |
| threshold | float | 0.5 | 0-1 | Surface threshold |
| invert | boolean | false | - | Invert threshold |
| orbitSpeed | int | 1 | -5 to 5 | Volume rotation speed |
| cameraPosition | vec3 | 0,0.1425,1.0 | -1 to 1 | Camera position (scaled 5x, 0,0,0 = center) |
| bgColor | color | 0,0,0 | - | Background color |
| bgAlpha | float | 1 | 0-1 | Background alpha |

### Lighting Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| lightDirection | vec3 | 0.5,0.5,1.0 | - | Direction of the light source |
| diffuseColor | color | 1.0,1.0,1.0 | - | Color of diffuse lighting |
| diffuseIntensity | float | 0.7 | 0-2 | Intensity of diffuse lighting |
| specularColor | color | 1.0,1.0,1.0 | - | Color of specular highlights |
| specularIntensity | float | 0.3 | 0-2 | Intensity of specular highlights |
| shininess | float | 32 | 1-256 | Specular shininess (higher = tighter highlights) |
| ambientColor | color | 0.1,0.1,0.1 | - | Ambient light color |
| rimIntensity | float | 0.15 | 0-1 | Intensity of rim/fresnel lighting |
| rimPower | float | 3.0 | 0.5-8 | Rim lighting falloff power |

## Notes

This effect extends `render3d` with full lighting controls, allowing you to fine-tune:

- **Diffuse lighting**: Lambertian shading based on surface normal and light direction
- **Specular lighting**: Blinn-Phong highlights for shiny surfaces
- **Ambient lighting**: Base illumination for shadowed areas
- **Rim lighting**: Fresnel-based edge glow effect

### Bounding Shapes

- **cube**: Classic box-bounded volume (default)
- **sphere**: Spherical boundary for organic shapes
- **plane**: Horizontal slab for terrain/landscape effects
- **none**: Unbounded - marches until max distance (use with care)

### Usage Examples

```
// Basic lit 3D noise
noise3d().renderLit3d().write(o0)

// Spherical bounding for organic look
cell3d().renderLit3d(shape: sphere, shininess: 128).write(o0)

// Terrain-style plane rendering
fractal3d().renderLit3d(shape: plane, threshold: 0.3).write(o0)

// Dramatic rim lighting
fractal3d().renderLit3d(rimIntensity: 0.5, rimPower: 2.0, ambientColor: [0.05, 0.05, 0.1]).write(o0)

// Colored lighting
shape3d().renderLit3d(diffuseColor: [1.0, 0.8, 0.6], specularColor: [1.0, 0.9, 0.8]).write(o0)
```

The volumeSize parameter is automatically inherited from the upstream 3D effect.
