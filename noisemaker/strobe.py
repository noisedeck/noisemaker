"""Stroboscopic detection against the WCAG 2.3.1 general flash threshold.

Photosensitive seizure risk is a published standard, not a matter of taste, so
this module implements the bar rather than a tuned sensitivity:

  * A *flash* is a **pair** of opposing changes in relative luminance of at
    least ``FLASH_DELTA``, where the darker of the two states sits below
    ``DARK_THRESHOLD``. A 3 Hz square wave is three flashes per second and six
    transitions per second; counting transitions doubles the rate and is the
    easy mistake here.
  * Content fails at **more than** ``MAX_FLASHES_PER_SECOND`` flashes in any
    one-second window.
  * The flashing region must cover a meaningful part of the field of view.
    WCAG expresses this as 25% of a 10-degree field; a full-frame generative
    animation approximates that with ``MIN_FLASHING_AREA`` of an evenly tiled
    grid.

The area rule does the real work. Averaging luminance over the whole frame
understates a strobe badly: a reference clip that flashes every block at 8 Hz
measured only 3.0 flashes per second as a whole-frame mean, which does not
clear the threshold on its own.
"""

import numpy as np

GRID = 8
FLASH_DELTA = 0.10
DARK_THRESHOLD = 0.80
MAX_FLASHES_PER_SECOND = 3
MIN_FLASHING_AREA = 0.25


def luminance_grid(image):
    """Mean WCAG relative luminance over a ``GRID`` x ``GRID`` tiling of a frame.

    ``image`` is height x width x channels with values in 0..1. Only the first
    three channels are read, so an RGBA frame works unchanged.
    """

    a = np.asarray(image, dtype=np.float64)[..., :3]

    # sRGB -> linear, then the WCAG luminance coefficients.
    linear = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    luminance = (
        linear[..., 0] * 0.2126 + linear[..., 1] * 0.7152 + linear[..., 2] * 0.0722
    )

    rows = np.array_split(luminance, GRID, axis=0)
    return np.array(
        [[block.mean() for block in np.array_split(row, GRID, axis=1)] for row in rows]
    )


def _opposing_change_indices(series):
    """Frames where a qualifying change *reverses* the previous one.

    Walks the series against a moving anchor rather than looking for local
    extrema. Extrema detection fails on exactly the signal that matters here:
    a square wave holds a plateau, so successive differences are zero and no
    turning point is ever found. It also misreads a slow monotonic ramp as a
    flash, because the first and last samples look like a huge excursion.

    Anchoring fixes both. A change only registers once the signal has moved
    ``FLASH_DELTA`` from the anchor, and only counts when it reverses the
    previous direction — a ramp is all one direction and yields nothing.
    """

    values = np.asarray(series, dtype=np.float64)

    if values.size < 3:
        return []

    indices = []
    anchor = values[0]
    direction = 0

    for i in range(1, len(values)):
        delta = values[i] - anchor

        if abs(delta) < FLASH_DELTA:
            continue

        if min(values[i], anchor) >= DARK_THRESHOLD:
            # Both states sit above the dark threshold; not a qualifying flash.
            anchor = values[i]
            continue

        heading = 1 if delta > 0 else -1

        if direction != 0 and heading != direction:
            indices.append(i)

        direction = heading
        anchor = values[i]

    return indices


def max_flashes_per_second(series, fps):
    """Peak flash rate over any one-second window of a luminance series."""

    reversals = np.array(_opposing_change_indices(series))

    if reversals.size == 0:
        return 0.0

    window = int(round(fps))
    peak = max(
        int(((reversals >= start) & (reversals < start + window)).sum())
        for start in range(len(series))
    )

    # A flash is a pair of opposing changes, so two reversals make one flash.
    # Counting reversals directly would double every rate and, in effect,
    # halve the threshold.
    return peak / 2.0


def is_strobing(grids, fps=30):
    """True when a sequence of luminance grids fails the flash threshold.

    ``grids`` is one ``GRID`` x ``GRID`` array per frame, in order.
    """

    if len(grids) < 3:
        return False

    stack = np.asarray(grids, dtype=np.float64)

    if max_flashes_per_second(stack.mean(axis=(1, 2)), fps) > MAX_FLASHES_PER_SECOND:
        return True

    flashing = [
        max_flashes_per_second(stack[:, row, col], fps) > MAX_FLASHES_PER_SECOND
        for row in range(stack.shape[1])
        for col in range(stack.shape[2])
    ]

    return float(np.mean(flashing)) >= MIN_FLASHING_AREA


def verdict_line(grids, frame_count, target_duration=None, default_fps=30):
    """The renderer's machine-readable strobe verdict.

    ``target_duration`` stretches the frames across that many seconds, so it,
    not the encoder's nominal frame rate, is what a viewer's eye sees. Without
    it the frames play at ``default_fps``.
    """

    fps = frame_count / target_duration if target_duration else default_fps

    return f"strobe-warning: {'yes' if is_strobing(grids, fps=fps) else 'no'}"
