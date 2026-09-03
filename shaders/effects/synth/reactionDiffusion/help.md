# reactionDiffusion

Gray-Scott reaction-diffusion

## Description

Implements the Gray-Scott model of reaction-diffusion, producing organic, self-organizing patterns. The simulation models two virtual chemicals that diffuse and react, creating spots, stripes, and complex patterns depending on the feed and kill rates.

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| tex | surface | none | - | Texture |
| zoom | int | x8 | x1/x2/x4/x8/x16/x32/x64 | Zoom |
| smoothing | int | linear | constant/linear/hermite/catmullRom3x3/catmullRom4x4/bSpline3x3/bSpline4x4 | Smoothing |
| speed | float | 100 | 10-145 | Speed |
| resetState | boolean | false | - | State |
| seed | int | 1 | 1-100 | Random seed |
| sourceF | int | slider | slider/sliderInput/brightness/darkness/red/green/blue | Feed source |
| feed | float | 70 | 10-110 | Feed value |
| sourceK | int | slider | slider/sliderInput/brightness/darkness/red/green/blue | Kill source |
| kill | float | 67 | 45-70 | Kill value |
| sourceR1 | int | slider | slider/sliderInput/brightness/darkness/red/green/blue | Rate 1 source |
| rate1 | float | 92 | 50-120 | Rate 1 value |
| sourceR2 | int | slider | slider/sliderInput/brightness/darkness/red/green/blue | Rate 2 source |
| rate2 | float | 22 | 20-50 | Rate 2 value |
| iterations | int | 8 | 1-32 | Iterations |
| weight | float | 0 | 0-100 | Input weight |
| inputIntensity | float | 0 | 0-100 | Input mix |
