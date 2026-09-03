"""Stroboscopic detection, WCAG 2.3.1 general flash threshold."""

import numpy as np
import pytest

from noisemaker.strobe import GRID, is_strobing, luminance_grid, max_flashes_per_second


def _grids(values):
    return [np.full((GRID, GRID), v, dtype=np.float64) for v in values]


def _square_wave(seconds, hz, fps=30, low=0.0, high=1.0):
    n = int(seconds * fps)
    half = fps / hz / 2
    return np.array([high if (i // half) % 2 else low for i in range(n)])


# --- luminance ------------------------------------------------------------

def test_luminance_grid_uses_wcag_coefficients():
    green = luminance_grid(np.tile([0.0, 1.0, 0.0], (16, 16, 1)))
    blue = luminance_grid(np.tile([0.0, 0.0, 1.0], (16, 16, 1)))

    assert green.mean() == pytest.approx(0.7152, abs=1e-3)
    assert blue.mean() == pytest.approx(0.0722, abs=1e-3)


def test_luminance_grid_linearizes_srgb():
    """Mid grey is ~0.214 linear, not 0.5 — the gamma curve must be undone."""
    assert luminance_grid(np.full((16, 16, 3), 0.5)).mean() == pytest.approx(0.214, abs=1e-3)


def test_luminance_grid_downsamples_to_the_block_grid():
    assert luminance_grid(np.zeros((512, 512, 3))).shape == (GRID, GRID)


def test_luminance_grid_ignores_an_alpha_channel():
    assert luminance_grid(np.full((16, 16, 4), 0.5)) == pytest.approx(
        luminance_grid(np.full((16, 16, 3), 0.5))
    )


# --- flash rate is the flash frequency, not the transition count ----------

@pytest.mark.parametrize("hz", [1, 2, 3, 4, 6, 15])
def test_reported_rate_equals_the_flash_frequency(hz):
    """A flash is a PAIR of opposing changes, so an N Hz wave is N flashes/sec.

    Counting each transition instead would report 2N and effectively halve the
    threshold.
    """
    assert max_flashes_per_second(_square_wave(3, hz), fps=30) == pytest.approx(float(hz))


def test_three_per_second_passes_and_four_fails():
    """WCAG fails content at MORE than three flashes per second."""
    assert not is_strobing(_grids(_square_wave(3, hz=3)), fps=30)
    assert is_strobing(_grids(_square_wave(3, hz=4)), fps=30)


def test_monotonic_ramp_is_not_flashing():
    """One long change in a single direction is never a flash."""
    assert max_flashes_per_second(np.linspace(0.0, 1.0, 90), fps=30) == 0.0


def test_small_jitter_is_not_flashing():
    """'Slight flickering is okay': swings well under the 0.10 delta."""
    series = np.array([0.40 + (0.02 if i % 2 else 0.0) for i in range(90)])

    assert max_flashes_per_second(series, fps=30) == 0.0


def test_flash_needs_the_darker_state_below_the_dark_threshold():
    """Two bright states 0.14 apart are not a flash — both exceed 0.80."""
    series = np.array([0.85 if i % 2 else 0.99 for i in range(90)])

    assert max_flashes_per_second(series, fps=30) == 0.0


# --- whole-frame verdict --------------------------------------------------

def test_full_frame_strobe_is_caught():
    assert is_strobing(_grids(_square_wave(3, hz=15)), fps=30)


def test_steady_animation_is_not_caught():
    assert not is_strobing(_grids(np.linspace(0.2, 0.6, 90)), fps=30)


def test_localized_strobe_over_the_area_threshold_is_caught():
    """Half the field strobing while the frame mean barely moves.

    This is the case a whole-frame average misses. It is not a refinement:
    the reference clip that prompted this feature is caught only here.
    """
    frames = []
    for v in _square_wave(3, hz=15):
        f = np.full((GRID, GRID), 0.30)
        f[:4, :] = v
        frames.append(f)

    assert is_strobing(frames, fps=30)


def test_localized_strobe_under_the_area_threshold_is_not_caught():
    frames = []
    for v in _square_wave(3, hz=15):
        f = np.full((GRID, GRID), 0.30)
        f[0, :2] = v          # ~3% of blocks
        frames.append(f)

    assert not is_strobing(frames, fps=30)


def test_area_rule_sits_at_the_quarter_field_boundary():
    """16 of 64 blocks is exactly 25% and must count as strobing."""
    frames = []
    for v in _square_wave(3, hz=15):
        f = np.full((GRID, GRID), 0.30)
        f[:2, :] = v          # 16/64 blocks
        frames.append(f)

    assert is_strobing(frames, fps=30)


def test_too_few_frames_is_not_strobing():
    assert not is_strobing(_grids([0.0, 1.0]), fps=30)


def test_no_frames_is_not_strobing():
    assert not is_strobing([], fps=30)


# --- the wire format the bot reads ---------------------------------------

def test_verdict_line_wire_format():
    from noisemaker.strobe import verdict_line

    assert verdict_line(_grids(_square_wave(3, hz=15)), 90) == "strobe-warning: yes"
    assert verdict_line(_grids(np.linspace(0.2, 0.6, 90)), 90) == "strobe-warning: no"


def test_verdict_line_uses_target_duration_as_the_real_playback_rate():
    """Stretched output plays slower, so the same frames flash less often.

    150 frames of every-other-frame alternation is 15 flashes/sec at 30fps, but
    only 2.5 when spread over 30 seconds — below the threshold.
    """
    from noisemaker.strobe import verdict_line

    grids = _grids(_square_wave(5, hz=15))

    assert verdict_line(grids, 150) == "strobe-warning: yes"
    assert verdict_line(grids, 150, target_duration=30) == "strobe-warning: no"
