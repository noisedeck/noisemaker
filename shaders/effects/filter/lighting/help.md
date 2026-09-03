# lighting

Applies 3D lighting effects

## Description

Uses a three-step process:
1. **Normal Calculation**: Uses Sobel convolution on the input texture's luminosity to extract gradients, which are converted into 3D surface normals
2. **Lighting Model**: Applies Blinn-Phong lighting with diffuse, specular, and ambient components
3. **Output**: The lit result is combined with the original texture colors

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| normalStrength | float | 1.5 | 0-5 | Depth |
| smoothing | float | 1 | 1-10 | Smoothing |
| diffuseColor | color | 1,1,1 | - | Color |
| specularColor | color | 1,1,1 | - | Color |
| specularIntensity | float | 0.5 | 0-2 | Intensity |
| shininess | float | 64 | 8-256 | Shininess |
| ambientColor | color | 0.2,0.2,0.2 | - | Ambient |
| lightDirection | vec3 | 0.5,0.5,1 | - | Direction |
| reflection | float | 0 | 0-100 | Reflection |
| refraction | float | 0 | 0-100 | Refraction |
| aberration | float | 0 | 0-100 | Aberration |
| heightMap | surface | inputTex | - | Surface sampled for height, defaulting to the input |

## Notes

- Increase **normalStrength** to make surface features more pronounced
- Adjust **lightDirection** to change where highlights appear
- Higher **shininess** creates tighter, shinier specular highlights
- Use **reflection** and **refraction** for glass/water-like effects
- **aberration** adds RGB channel splitting for dispersion effects
