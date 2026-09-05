#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10", "pytest>=8"]
# ///
"""Tests for the parts of the level chain check that need no server.

Run with ``uv run extras/test_verify_level_chain.py``. The level-rule tests
read the committed ``level-index.ome.zarr`` fixture; the frame and run
tests build their inputs in a temporary directory. Nothing here launches
a browser or opens a socket.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_level_chain as check  # noqa: E402

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "ome-zarr"
LEVEL_INDEX = FIXTURES_DIR / "level-index.ome.zarr"

# The check's own fixture: four levels halving every axis.
HALVING = [(64, 512, 512), (32, 256, 256), (16, 128, 128), (8, 64, 64)]


def test_level_shapes_come_from_the_multiscale_metadata() -> None:
    shapes = check.level_shapes(LEVEL_INDEX)
    assert shapes == [(32, 64, 64), (16, 32, 32), (8, 16, 16), (4, 8, 8)]


def test_level_ratios_read_the_real_shapes_along_the_resolved_axes() -> None:
    assert check.level_ratios(HALVING, check.IN_PLANE_AXES) == [1.0, 2.0, 4.0, 8.0]
    assert check.level_ratios(HALVING, check.VOLUME_AXES) == [1.0, 2.0, 4.0, 8.0]
    # A level that only thins the third axis is no coarser in a slice view.
    anisotropic = [(64, 512, 512), (32, 512, 512), (16, 256, 256)]
    assert check.level_ratios(anisotropic, check.IN_PLANE_AXES) == [1.0, float("inf"), 2.0]
    assert check.level_ratios(anisotropic, check.VOLUME_AXES) == [1.0, 2.0, 4.0]


def test_the_rule_picks_the_coarsest_level_that_still_fills_every_pixel() -> None:
    """The spec's rule: the largest L with zoom × ratio at most 1, else 0."""
    ratios = [1.0, 2.0, 4.0, 8.0]
    assert check.expected_target(2.0, ratios) == 0
    assert check.expected_target(0.51, ratios) == 0
    assert check.expected_target(0.5, ratios) == 1
    assert check.expected_target(0.177, ratios) == 2
    assert check.expected_target(0.125, ratios) == 3
    assert check.expected_target(0.08, ratios) == 3
    assert check.expected_target(0.001, ratios) == 3
    assert check.expected_target(0.1, [1.0, float("inf"), 2.0]) == 2


def test_the_zoom_for_a_level_sits_in_the_middle_of_the_band_that_level_owns() -> None:
    ratios = [1.0, 2.0, 4.0, 8.0]
    for level in range(4):
        zoom = check.zoom_for_level(level, ratios)
        assert check.expected_target(zoom, ratios) == level
        # A quarter octave either way is the hysteresis band; the chosen
        # zoom must not sit inside it, or the target would depend on where
        # the camera came from.
        band = 2 ** 0.25
        assert check.expected_target(zoom * band, ratios) == level
        assert check.expected_target(zoom / band, ratios) == level

    # A level that resolves no finer than the one before it is not a target.
    with pytest.raises(ValueError):
        check.zoom_for_level(1, [1.0, float("inf"), 2.0])
    with pytest.raises(ValueError):
        check.zoom_for_level(9, ratios)
    # A level whose only coarser neighbour is skippable still gets its band.
    assert check.expected_target(check.zoom_for_level(0, [1.0, float("inf"), 2.0]), [1.0, float("inf"), 2.0]) == 0


def test_a_neutral_gray_names_its_level_and_anything_else_names_none() -> None:
    """The contrast window of −1 to levels−1 draws level L at (L + 1) / levels of white."""
    levels = 4
    assert check.level_from_color((64, 64, 64), levels) == 0
    assert check.level_from_color((128, 128, 128), levels) == 1
    assert check.level_from_color((191, 191, 191), levels) == 2
    assert check.level_from_color((255, 255, 255), levels) == 3
    # A little off in any channel is still the level.
    assert check.level_from_color((130, 126, 128), levels) == 1
    # No level is black, so an entity drawing nothing is not mistaken for one.
    assert check.level_from_color((0, 0, 0), levels) is None
    # The compositor's background is not neutral, and reads as no level.
    assert check.level_from_color((13, 13, 20), levels) is None
    # A gray between two levels is not a level either.
    assert check.level_from_color((96, 96, 96), levels) is None


def test_the_frame_is_read_at_its_center(tmp_path: Path) -> None:
    frame = np.zeros((40, 60, 3), dtype=np.uint8)
    frame[:, :] = (13, 13, 20)
    frame[18:23, 28:33] = (191, 191, 191)
    # One stray pixel at the center must not sway the reading.
    frame[20, 30] = (255, 0, 0)
    path = tmp_path / "frame.png"
    Image.fromarray(frame).save(path)

    assert check.frame_size(path) == (60, 40)
    assert check.center_color(path, size=5) == (191, 191, 191)


def test_the_bound_counts_the_chunks_the_view_can_cover_plus_a_border() -> None:
    # Zoomed in on the 512-sample plane: 1024 device pixels of image inside a
    # 2880 × 1800 viewport, in 64-pixel level-0 chunks.
    assert check.wanted_set_bound(
        viewport=(2880, 1800), image_samples=(512, 512), zoom=2.0, ratio=1.0, chunk=32, depth_chunks=1
    ) == 17 * 17
    # Zoomed out to level 2: a 90-pixel image in 22.6-pixel chunks.
    assert check.wanted_set_bound(
        viewport=(2880, 1800), image_samples=(512, 512), zoom=0.177, ratio=4.0, chunk=32, depth_chunks=1
    ) == 5 * 5
    # An image larger than the viewport is bounded by the viewport.
    assert check.wanted_set_bound(
        viewport=(640, 640), image_samples=(4096, 4096), zoom=1.0, ratio=1.0, chunk=64, depth_chunks=1
    ) == 11 * 11
    # A volume is weaker by the depth of the cut in chunks.
    assert check.wanted_set_bound(
        viewport=(2880, 1800), image_samples=(512, 512), zoom=2.0, ratio=1.0, chunk=32, depth_chunks=2
    ) == 2 * 17 * 17


def tick(at_us: int, target: int, planned: dict[int, int], displayed: int | None) -> dict:
    return {
        "atUs": at_us,
        "datasetId": "wds-1",
        "targetLevel": {"min": target, "max": target},
        "levelPinned": False,
        "displayedLevel": None if displayed is None else {"min": displayed, "max": displayed},
        "levels": [{"level": level, "planned": count, "cached": 0, "inFlight": 0} for level, count in planned.items()],
    }


def test_the_trace_reading_takes_the_final_target_and_the_largest_plan_at_it() -> None:
    run = {
        "header": {"runId": "run-1", "endReason": "quiescent", "durationUs": 900_000},
        "ticks": [
            # The page's default camera plans level 0 before the composed one applies.
            tick(10_000, 0, {0: 256, 3: 4}, None),
            tick(40_000, 2, {2: 16, 3: 4}, None),
            tick(200_000, 2, {2: 3}, 2),
            tick(500_000, 2, {}, 2),
        ],
        "events": [
            {"kind": "level-change", "levelChange": {"datasetId": "wds-1", "from": {"min": 0, "max": 0}, "to": {"min": 2, "max": 2}}}
        ],
    }
    reading = check.read_levels(run)
    assert reading.target == (2, 2)
    assert reading.displayed == (2, 2)
    assert reading.wanted_at_target == 16
    assert reading.level_changes == [((0, 0), (2, 2))]
    assert reading.settle_seconds == pytest.approx(0.9)


def test_a_run_with_no_tick_reads_as_no_target() -> None:
    reading = check.read_levels({"header": {"runId": "run-2", "durationUs": 0}, "ticks": [], "events": []})
    assert reading.target is None
    assert reading.displayed is None
    assert reading.wanted_at_target == 0


def test_the_run_the_driver_waited_for_is_the_one_read(tmp_path: Path) -> None:
    run_file = tmp_path / "run.json"
    run_file.write_text(
        json.dumps(
            {
                "header": {"runId": "run-b"},
                "trace": {"runs": [{"header": {"runId": "run-a"}}, {"header": {"runId": "run-b"}}, {"header": {"runId": "run-c"}}]},
            }
        )
    )
    assert check.run_in_document(run_file)["header"]["runId"] == "run-b"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", *sys.argv[1:]]))
