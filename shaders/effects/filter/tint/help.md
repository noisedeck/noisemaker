# tint

Colorize input texture with a color overlay

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| color | color | 1,1,1 | - | Tint color |
| alpha | float | 0.5 | 0-1 | Tint amount |
| mode | int | overlay | overlay/multiply/recolor | Blend mode |

## Notes

- **overlay** mode lerps between the input and the tint color
- **multiply** mode multiplies input RGB by the tint color
- **recolor** mode replaces the input hue with the tint color's hue in HSV space, preserving brightness
