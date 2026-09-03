"""Frame-count gating for magic-mashup input directories.

magic_mashup indexes every input directory positionally (``files[i]`` for frame
``i``), so a directory holding fewer frames than the mashup renders silently
drops out partway through the loop instead of failing. These tests pin the
guard that keeps short directories out of the collage entirely.
"""

import os

import pytest

from noisemaker.scripts.noisemaker import _usable_mashup_dirs


def _make_frames(parent, name, count, suffix=".png"):
    path = os.path.join(parent, name)
    os.makedirs(path)
    for i in range(count):
        open(os.path.join(path, f"{i:04d}{suffix}"), "w").close()
    return path


def test_keeps_dirs_with_exactly_the_requested_count(tmp_path):
    root = str(tmp_path)
    _make_frames(root, "exact", 150)

    assert _usable_mashup_dirs(root, 150) == ["exact"]


def test_keeps_dirs_with_more_than_the_requested_count(tmp_path):
    root = str(tmp_path)
    _make_frames(root, "long", 200)

    assert _usable_mashup_dirs(root, 150) == ["long"]


def test_drops_dirs_with_fewer_frames(tmp_path):
    root = str(tmp_path)
    _make_frames(root, "short", 149)

    assert _usable_mashup_dirs(root, 150) == []


def test_mixed_lengths_keeps_only_the_long_ones(tmp_path):
    """The real cutover case: 50-frame history alongside fresh 150-frame runs."""
    root = str(tmp_path)
    _make_frames(root, "old-a", 50)
    _make_frames(root, "old-b", 50)
    _make_frames(root, "new-a", 150)
    _make_frames(root, "new-b", 150)

    assert _usable_mashup_dirs(root, 150) == ["new-a", "new-b"]


def test_ignores_loose_files(tmp_path):
    root = str(tmp_path)
    _make_frames(root, "frames", 150)
    open(os.path.join(root, "stray.png"), "w").close()

    assert _usable_mashup_dirs(root, 150) == ["frames"]


def test_non_png_files_do_not_count_toward_the_total(tmp_path):
    root = str(tmp_path)
    _make_frames(root, "decoys", 150, suffix=".txt")

    assert _usable_mashup_dirs(root, 150) == []


def test_empty_input_dir(tmp_path):
    assert _usable_mashup_dirs(str(tmp_path), 150) == []


def test_result_is_sorted_for_determinism(tmp_path):
    root = str(tmp_path)
    for name in ("c", "a", "b"):
        _make_frames(root, name, 150)

    assert _usable_mashup_dirs(root, 150) == ["a", "b", "c"]
