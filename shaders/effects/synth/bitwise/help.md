# bitwise

Bitwise operation patterns (XOR squares, AND, OR, etc.)

## Description

Generates patterns by applying bitwise and arithmetic operations to pixel coordinates. The classic "XOR squares" pattern emerges from `x XOR y & 0xFF` — other operations produce dramatically different results with the same inputs.

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| operation | int | xor | xor/and/or/nand/xnor/mul/add/sub | Bitwise operation |
| scale | float | 50 | 1-100 | Cell size (higher = bigger cells) |
| rotation | float | 0 | -180-180 | Rotation (degrees) |
| offsetX | int | 0 | -256-256 | Horizontal coordinate offset |
| offsetY | int | 0 | -256-256 | Vertical coordinate offset |
| mask | int | bit8 | bit8/bit7/bit6/bit5/bit4/bit3/bit2/bit1 | Bit depth mask |
| seed | int | 0 | 0-255 | XORs into coordinates for pattern variation |
| colorMode | int | mono | mono/rgb/hsv | Color mode |
| colorOffset | int | 7 | 0-64 | Color offset |
| speed | int | 0 | -5-5 | Animation speed (panning) |

## Operations

- **XOR (0)**: Classic recursive Sierpinski-like squares
- **AND (1)**: Chaotic diagonal emphasis
- **OR (2)**: Dense coverage with triangular gaps
- **NAND (3)**: Inverted AND
- **XNOR (4)**: Inverted XOR
- **MUL (5)**: Multiplication table (hyperbolic curves)
- **ADD (6)**: Diagonal stripes
- **SUB (7)**: Directional stripes

## Bit Depth

Lower bit depth (smaller mask) quantizes the output into fewer steps, producing chunkier, more graphic results. 1-bit mask gives pure black/white patterns.
