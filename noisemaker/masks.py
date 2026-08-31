"""Value masks for Noisemaker. Used when generating value noise or glyph maps."""

from __future__ import annotations

import json
import os
import re
import string
from typing import Any, Callable, cast

import numpy as np

import noisemaker.rng as rng
from noisemaker.constants import ValueMask

# Load masks
_SHARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "share"))
_MASKS_FILE = os.path.join(_SHARE_DIR, "masks.json")

with open(_MASKS_FILE) as f:
    _MASKS_DATA = json.load(f)["Masks"]

#: Hard-coded masks
Masks = {}
for name, value in _MASKS_DATA.items():
    Masks[ValueMask[name]] = value

# Procedural masks, corresponding to keys in constants.ValueMask

# Procedural mask shapes

_mask_shapes: dict[ValueMask, Any] = {}


# Masks wanting to use this decorator should first be added to the ValueMask enum in constants.py
def mask(*args: Any) -> Callable:
    """
    Function decorator for procedural masks.

    Args:
        *args: Optional mask shape specification

    Returns:
        Decorator function for registering mask functions
    """

    def decorator_fn(mask_fn: Callable) -> Callable:
        mask = ValueMask[mask_fn.__name__]

        if args:
            _mask_shapes[mask] = args[0]

        Masks[mask] = mask_fn

        return mask_fn

    return decorator_fn


def mask_shape(mask: ValueMask) -> list[int]:
    """
    Return the shape for the received ValueMask.

    Args:
        mask: ValueMask to get shape for

    Returns:
        Shape as [height, width, channels]
    """

    if ValueMask.is_procedural(mask):
        shape = _mask_shapes[mask]

        if callable(shape):
            shape = shape()

        # Ensure shape is a list for type checking
        shape = list(shape) if not isinstance(shape, list) else shape

    else:
        mask_data: Any = Masks[mask]
        height = len(mask_data)
        width = len(mask_data[0])

        if isinstance(mask_data[0][0], list):
            channels = len(mask_data[0][0])
        else:
            channels = 1

        shape = [height, width, channels]

    return cast(list[int], shape)


def get_atlas(mask: ValueMask) -> Any:
    """
    Get the glyph atlas for a procedural mask.

    Args:
        mask: ValueMask to get atlas for

    Returns:
        Atlas array or None if not applicable
    """
    atlas = None

    if mask == ValueMask.truetype:
        from noisemaker.glyphs import load_glyphs

        atlas = load_glyphs([15, 15, 1])

    elif ValueMask.is_procedural(mask):
        base_name = re.sub(r"_[a-z]+$", "", mask.name)

        if mask.name.endswith("_binary"):
            atlas = [Masks[ValueMask[f"{base_name}_0"]], Masks[ValueMask[f"{base_name}_1"]]]

        elif mask.name.endswith("_numeric"):
            atlas = [Masks[ValueMask[f"{base_name}_{i}"]] for i in string.digits]

        elif mask.name.endswith("_hex"):
            atlas = [Masks[g] for g in Masks if re.match(f"^{base_name}_[0-9a-f]$", g.name)]

        else:
            atlas = [Masks[g] for g in Masks if g.name.startswith(f"{mask.name}_") and not callable(Masks[g])]

    return atlas


def mask_values(
    mask: ValueMask,
    glyph_shape: list[int] | None = None,
    uv_noise: np.ndarray | None = None,
    atlas: np.ndarray | None = None,
    inverse: bool = False,
    time: float = 0.0,
    speed: float = 1.0,
) -> tuple[list[list[Any]], float]:
    """
    Return pixel values for the received ValueMask.

    Args:
        mask: ValueMask to render
        glyph_shape: Shape of the mask being rendered [height, width, channels]
        uv_noise: Per-pixel noise values, shaped like glyph_shape
        atlas: Pre-rendered atlas of images (e.g., TrueType letters)
        inverse: Return the inverse of the mask
        time: Time parameter for animation
        speed: Animation speed multiplier

    Returns:
        Mask value array
    """

    shape = mask_shape(mask)

    if glyph_shape is None:
        glyph_shape = shape

    if len(shape) == 3:
        glyph_shape[2] = shape[2]

    mask_values = []

    uv_shape = [int(glyph_shape[0] / shape[0]) or 1, int(glyph_shape[1] / shape[1]) or 1]

    if uv_noise is None:
        from noisemaker.simplex import simplex

        uv_noise = simplex(uv_shape, time=time, seed=rng.random_int(1, 65536), speed=speed, as_np=True)

        # normalize() but it's numpy
        # floor = np.amin(uv_noise)
        # ceil = np.amax(uv_noise)
        # uv_noise = (uv_noise - floor) / (ceil - floor)

    total = 0

    for y in range(glyph_shape[0]):
        uv_y = int((y / glyph_shape[0]) * uv_shape[0])

        mask_row: list[Any] = []
        mask_values.append(mask_row)

        for x in range(glyph_shape[1]):
            uv_x = int((x / glyph_shape[1]) * uv_shape[1])

            mask_entry: Any = Masks[mask]
            if callable(mask_entry):
                pixel = mask_entry(
                    x=x, y=y, row=mask_row, shape=shape, uv_x=uv_x, uv_y=uv_y, uv_noise=uv_noise, uv_shape=uv_shape, atlas=atlas, glyph_shape=glyph_shape
                )

            else:
                pixel = mask_entry[y % shape[0]][x % shape[1]]

            if not isinstance(pixel, list):
                pixel = [pixel]

            pixel = [float(i) for i in pixel]

            if inverse:
                pixel = [1.0 - i for i in pixel]

            mask_row.append(pixel)

            total += sum(pixel)

    return mask_values, total


def uv_random(uv_noise: np.ndarray, uv_x: int, uv_y: int) -> float:
    value = np.asarray(uv_noise[uv_y][uv_x]).reshape(-1)[0]
    return float((value + rng.random()) % 1.0)


def square_masks() -> list[ValueMask]:
    """
    Return a list of square ValueMasks.

    Returns:
        List of ValueMasks with square dimensions
    """

    square = []

    for mask in ValueMask:
        if callable(_mask_shapes.get(mask)):  # No dynamic shapes
            continue

        shape = mask_shape(mask)

        if shape and shape[0] == shape[1]:
            square.append(mask)

    return square


def _glyph_from_atlas_range(x: int, y: int, shape: list[int], uv_x: int, uv_y: int, uv_noise: np.ndarray, atlas: np.ndarray, **kwargs: Any) -> Any:
    glyph_index = int(uv_noise[uv_y][uv_x] * (len(atlas)))

    glyph_index = min(max(glyph_index, 0), len(atlas) - 1)

    return atlas[glyph_index][y % shape[0]][x % shape[1]]


@mask([10, 10, 1])
def dropout(uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    return uv_random(uv_noise, uv_x, uv_y) < 0.25


@mask([10, 10, 1])
def sparse(uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    return uv_random(uv_noise, uv_x, uv_y) < 0.15


@mask([10, 10, 1])
def sparser(uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    return uv_random(uv_noise, uv_x, uv_y) < 0.05


@mask([10, 10, 1])
def sparsest(uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    return uv_random(uv_noise, uv_x, uv_y) < 0.0125


@mask(lambda: [rng.random_int(5, 7), rng.random_int(6, 12), 1])
def invaders(**kwargs: Any) -> Any:
    return _invaders(**kwargs)


@mask([18, 18, 1])
def invaders_large(**kwargs: Any) -> Any:
    return _invaders(**kwargs)


@mask([6, 6, 1])
def invaders_square(**kwargs: Any) -> Any:
    return _invaders(**kwargs)


@mask([4, 4, 1])
def white_bear(**kwargs: Any) -> Any:
    return _invaders(**kwargs)


def _invaders(x: int, y: int, row: list[Any], shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    # Inspired by http://www.complexification.net/gallery/machines/invaderfractal/
    height = shape[0]
    width = shape[1]

    if y % height == 0 or x % width == 0:
        return 0

    elif x % width > width / 2:
        return row[x - int(((x % width) - width / 2) * 2)]

    else:
        return uv_random(uv_noise, uv_x, uv_y) < 0.5


@mask([6, 4, 1])
def matrix(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    height = shape[0]
    width = shape[1]

    if y % height == 0 or x % width == 0:
        return 0

    return uv_random(uv_noise, uv_x, uv_y) < 0.5


@mask(lambda: [rng.random_int(3, 4) * 2 + 1, rng.random_int(3, 4) * 2 + 1, 1])
def letters(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    # Inspired by https://www.shadertoy.com/view/4lscz8
    height = shape[0]
    width = shape[1]

    if any(n == 0 for n in (x % width, y % height)):
        return 0

    if any(n == 1 for n in (width - (x % width), height - (y % height))):
        return 0

    if all(n % 2 == 0 for n in (x % width, y % height)):
        return 0

    if x % 2 == 0 or y % 2 == 0:
        return uv_random(uv_noise, uv_x, uv_y) > 0.25

    return uv_random(uv_noise, uv_x, uv_y) > 0.75


@mask([14, 8, 1])
def iching(x: int, y: int, row: list[Any], shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    height = shape[0]
    width = shape[1]

    if any(n == 0 for n in (x % width, y % height)):
        return 0

    if any(n == 1 for n in (width - (x % width), height - (y % height))):
        return 0

    if y % 2 == 0:
        return 0

    if x % 2 == 1 and x % width not in (3, 4):
        return 1

    if x % 2 == 0:
        return row[x - 1]

    return uv_random(uv_noise, uv_x, uv_y) < 0.5


@mask(lambda: [rng.random_int(4, 6) * 2] * 2 + [1])
def ideogram(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    height = shape[0]
    width = shape[1]

    if any(n == 0 for n in (x % width, y % height)):
        return 0

    if any(n == 1 for n in (width - (x % width), height - (y % height))):
        return 0

    if all(n % 2 == 1 for n in (x % width, y % height)):
        return 0

    return uv_random(uv_noise, uv_x, uv_y) > 0.5


@mask(lambda: [rng.random_int(7, 9), rng.random_int(12, 24), 1])
def script(x: int, y: int, row: list[Any], shape: list[int], uv_noise: np.ndarray, uv_y: int, uv_x: int, **kwargs: Any) -> Any:
    height = shape[0]
    width = shape[1]

    x_step = x % width
    y_step = y % height

    if x > 0 and (x + y) % 2 == 1:
        return row[x - 1]

    if y_step == 0:
        return 0

    if y_step in (1, 3, 6):
        return uv_random(uv_noise, uv_x, uv_y) > 0.25

    if y_step in (2, 4, 5):
        return uv_random(uv_noise, uv_x, uv_y) > 0.9

    if x_step == 0:
        return 0

    if any(n == 0 for n in (width - x_step, height - y_step)):
        return 0

    if all(n % 2 == 0 for n in (x_step, y_step)):
        return 0

    if y_step == height - 1:
        return 0

    return uv_random(uv_noise, uv_x, uv_y) > 0.5


@mask([4, 4, 1])
def tromino(
    x: int, y: int, row: int, shape: list[int], uv_x: int, uv_y: int, uv_noise: np.ndarray, uv_shape: list[int], atlas: np.ndarray, **kwargs: Any
) -> Any:
    tex_x = x % shape[1]
    tex_y = y % shape[0]

    uv_value = uv_noise[uv_y][uv_x] * (len(atlas) - 1)
    uv_floor = int(uv_value)
    uv_fract = uv_value - uv_floor

    float2 = uv_noise[(uv_y + int(shape[0] * 0.5)) % uv_shape[0]][uv_x]
    float3 = uv_noise[uv_y][(uv_x + int(shape[1] * 0.5)) % uv_shape[1]]

    if uv_fract < 0.5:
        _x = tex_x
        tex_x = tex_y
        tex_y = _x

    if float2 < 0.5:
        tex_x = shape[1] - tex_x - 1

    if float3 < 0.5:
        tex_y = shape[0] - tex_y - 1

    return atlas[uv_floor][tex_x][tex_y]


@mask([6, 6, 1])
def alphanum_binary(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([6, 6, 1])
def alphanum_numeric(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([6, 6, 1])
def alphanum_hex(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([15, 15, 1])
def truetype(x: int, y: int, row: int, shape: list[int], uv_x: int, uv_y: int, uv_noise: np.ndarray, atlas: np.ndarray, **kwargs: Any) -> Any:
    value = max(0, min(1, uv_noise[uv_y][uv_x]))

    glyph = atlas[int(value * (len(atlas) - 1))]

    return glyph[y % shape[0]][x % shape[1]]


@mask([4, 4, 1])
def halftone(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([8, 5, 1])
def lcd(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([8, 5, 1])
def lcd_binary(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([10, 10, 1])
def fat_lcd(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([10, 10, 1])
def fat_lcd_binary(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([10, 10, 1])
def fat_lcd_numeric(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([10, 10, 1])
def fat_lcd_hex(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([6, 3, 1])
def arecibo_num(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    tex_x = x % shape[1]
    tex_y = y % shape[0]

    if tex_y == 0 or tex_y == shape[0] - 1 or tex_x == 0:
        return 0

    if tex_y == shape[0] - 2:
        return 1 if tex_x == 1 else 0

    return uv_random(uv_noise, uv_x, uv_y) < 0.5


@mask([6, 5, 1])
def arecibo_bignum(*args: Any, **kwargs: Any) -> Any:
    return arecibo_num(*args, **kwargs)


@mask([6, 6, 1])
def arecibo_nucleotide(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    tex_x = x % shape[1]
    tex_y = y % shape[0]

    if tex_y == 0 or tex_y == shape[0] - 1 or tex_x == 0:
        return 0

    if tex_y == shape[0] - 2:
        return 1 if tex_x < shape[1] else 0

    if tex_y < shape[0] - 3 and tex_x > shape[1] - 2:
        return 0

    return uv_random(uv_noise, uv_x, uv_y) < 0.5


_ARECIBO_DNA_TEMPLATE = [
    [0, 1, 0, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0, 1, 0],
    [0, 0, 1, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 0, 0, -1, 0, 0, 0, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 0, 0, 0, -1, 0, 0, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 1, 0, 0],
    [0, 1, 0, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0, 1, 0],
]


@mask([11, 17, 1])
def arecibo_dna(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    tex_x = x % shape[1]
    tex_y = y % shape[0]

    value = _ARECIBO_DNA_TEMPLATE[tex_y][tex_x]

    return uv_random(uv_noise, uv_x, uv_y) < 0.5 if value == -1 else value


@mask(lambda: [64, 64, 1])
def arecibo(x: int, y: int, row: int, shape: list[int], uv_x: int, uv_y: int, uv_noise: np.ndarray, glyph_shape: list[int], **kwargs: Any) -> Any:
    third_height = glyph_shape[0] / 3
    half_width = glyph_shape[1] / 2
    dna_half_width = mask_shape(ValueMask.arecibo_dna)[1] * 0.5

    if x > half_width - dna_half_width and x < half_width + dna_half_width:
        dna_x = int(x - half_width - dna_half_width)

        return arecibo_dna(dna_x, y, row, mask_shape(ValueMask.arecibo_dna), uv_noise, uv_x, uv_y, **kwargs)

    if x > half_width - (dna_half_width + 2) and x < half_width + dna_half_width + 1:
        return 0

    if y < third_height:
        return arecibo_num(x, y, row, mask_shape(ValueMask.arecibo_num), uv_noise, uv_x, uv_y, **kwargs)

    if y < third_height * 2:
        return arecibo_nucleotide(x, y, row, mask_shape(ValueMask.arecibo_nucleotide), uv_noise, uv_x, uv_y, **kwargs)

    return arecibo_bignum(x, y, row, mask_shape(ValueMask.arecibo_bignum), uv_noise, uv_x, uv_y, **kwargs)


@mask([6, 6, 1])
def truchet_lines(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([6, 6, 1])
def truchet_curves(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([6, 6, 1])
def truchet_tile(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([8, 8, 1])
def mcpaint(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([13, 13, 1])
def emoji(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask([24, 1, 1])
def bar_code(x: int, y: int, row: int, shape: list[int], uv_x: int, uv_y: int, uv_noise: np.ndarray, **kwargs: Any) -> Any:
    return uv_noise[0][uv_x] < 0.5


@mask([10, 1, 1])
def bar_code_short(*args: Any, **kwargs: Any) -> Any:
    return bar_code(*args, **kwargs)


@mask([8, 7, 1])
def bank_ocr(**kwargs: Any) -> Any:
    return _glyph_from_atlas_range(**kwargs)


@mask(lambda: [rng.random_int(25, 50)] * 2 + [1])
def fake_qr(x: int, y: int, row: int, shape: list[int], uv_noise: np.ndarray, uv_x: int, uv_y: int, **kwargs: Any) -> Any:
    x = x % shape[1]
    y = y % shape[1]

    if (
        (x == 0 or y == 0 or x == shape[1] - 1 or y == shape[0] - 1)
        or (y in (8, shape[0] - 9) and x < 9)
        or (y == 8 and x > shape[1] - 10)
        or (x in (8, shape[1] - 9) and y < 9)
        or (x == 8 and y > shape[0] - 10)
        or (y in (2, 6) and (x in range(2, 7) or x in range(shape[1] - 7, shape[1] - 2)))
        or (y in (shape[1] - 3, shape[1] - 7) and x in range(2, 7))
        or (x in (2, 6) and (y in range(2, 7) or y in range(shape[0] - 7, shape[0] - 2)))
        or (x in (shape[0] - 3, shape[0] - 7) and y in range(2, 7))
        or (x in (shape[0] - 7, shape[0] - 9) and y in range(shape[0] - 9, shape[0] - 6))
        or (y in (shape[1] - 7, shape[1] - 9) and x in range(shape[1] - 9, shape[1] - 6))
    ):

        return 1

    elif (
        (x == shape[1] - 8 and y == shape[0] - 8)
        or (x in (shape[0] - 6, shape[0] - 10) and y in range(shape[0] - 10, shape[0] - 5))
        or (y in (shape[1] - 6, shape[1] - 10) and x in range(shape[1] - 10, shape[1] - 5))
    ):

        return 0

    elif (x > 8 and x < shape[1] - 8) or (y > 8 and y < shape[0] - 8) or (x >= shape[1] - 8 and y >= shape[0] - 8):

        return uv_random(uv_noise, uv_x, uv_y) < 0.5

    return 0
