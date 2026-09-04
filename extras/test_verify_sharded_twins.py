# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10", "pytest>=8"]
# ///
"""Tests for the parts of the sharded twin check that need no server.

Run with ``uv run extras/test_verify_sharded_twins.py``. The read-shape
tests read the committed fixtures under ``fixtures/ome-zarr``; the audit and
frame tests build their inputs in a temporary directory. Nothing here
launches a browser or opens a socket.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_sharded_twins as check  # noqa: E402

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "ome-zarr"
SHARDED = FIXTURES_DIR / "twin-sharded.ome.zarr"
UNSHARDED = FIXTURES_DIR / "twin-unsharded.ome.zarr"
SPARSE = FIXTURES_DIR / "sparse-sharded.ome.zarr"

# The committed sharded twin: 8x8 inner chunks, 16x16 shards, four entries
# and a checksum per index.
TWIN_INDEX_BYTES = 4 * 16 + 4


def test_image_prefix_strips_the_dataset_and_marker_from_a_tile_id() -> None:
    assert check.image_prefix("ds-7:image:A/1/0") == "A/1/0"
    assert check.image_prefix("ds-7") == ""


def test_array_layout_reads_the_sharded_and_the_unsharded_metadata() -> None:
    sharded = check.ArrayLayout.read(SHARDED / "0")
    assert sharded.sharded
    assert sharded.axes == ("c", "y", "x")
    assert sharded.inner_chunk_shape == (1, 8, 8)
    assert sharded.shard_shape == (1, 16, 16)
    assert sharded.chunks_per_shard == (1, 2, 2)
    assert sharded.index_location == "end"
    assert sharded.index_checksum
    assert sharded.index_bytes == TWIN_INDEX_BYTES

    unsharded = check.ArrayLayout.read(UNSHARDED / "0")
    assert not unsharded.sharded
    assert unsharded.inner_chunk_shape == (1, 8, 8)


def test_grid_coords_keep_only_the_axes_the_array_declares() -> None:
    layout = check.ArrayLayout.read(SHARDED / "0")
    assert check.grid_coords("0/0/1/0/3/4", layout) == ("0", (1, 3, 4))
    two_d = check.ArrayLayout(("y", "x"), (8, 8), None, "end", False)
    assert check.grid_coords("2/0/0/0/3/4", two_d) == ("2", (3, 4))
    with pytest.raises(ValueError):
        check.grid_coords("0/0/0", layout)


def test_an_unsharded_key_costs_its_whole_object() -> None:
    shape = check.read_shape(UNSHARDED, "twin", "0/0/0/0/0/0")
    assert shape is not None
    assert not shape.sharded
    assert shape.object_bytes == (UNSHARDED / "0" / "c" / "0" / "0" / "0").stat().st_size
    assert shape.allowed == {shape.object_bytes: "object"}


def test_a_sharded_key_costs_its_index_entry_and_the_index() -> None:
    """The inner chunk's range is the unsharded twin's object, byte for byte.

    Key c=1, y=2, x=3 in 8-sample inner chunks lies in shard (1, 1, 1) at
    position 1 of its 2x2 inner grid.
    """
    shape = check.read_shape(SHARDED, "twin", "0/0/1/0/2/3")
    assert shape is not None
    assert shape.sharded and shape.written
    assert shape.path == SHARDED / "0" / "c" / "1" / "1" / "1"
    assert shape.index_bytes == TWIN_INDEX_BYTES
    twin_object = (UNSHARDED / "0" / "c" / "1" / "2" / "3").stat().st_size
    assert shape.inner_bytes == twin_object
    assert shape.allowed == {
        TWIN_INDEX_BYTES: "index",
        twin_object: "inner-chunk",
        twin_object + TWIN_INDEX_BYTES: "index+inner-chunk",
    }
    # A shard read whole is never an allowed size.
    assert shape.path.stat().st_size not in shape.allowed


def test_an_absent_inner_chunk_and_a_missing_shard_cost_an_index_read_at_most() -> None:
    absent = check.read_shape(SPARSE, "sparse", "0/0/0/0/0/1")
    assert absent is not None and not absent.written
    assert absent.allowed == {TWIN_INDEX_BYTES: "index"}

    unwritten_level = check.read_shape(SPARSE, "sparse", "2/0/0/0/0/0")
    assert unwritten_level is not None and not unwritten_level.written
    assert not unwritten_level.path.is_file()


def test_a_level_the_store_does_not_hold_is_a_generated_level() -> None:
    assert check.read_shape(SHARDED, "twin", "7/0/0/0/0/0") is None


def browser_row(rid: int, chunk_key: str, image_id: str = "twin", generation: int = 1) -> dict:
    return {
        "rid": rid,
        "connectionGeneration": generation,
        "imageId": image_id,
        "chunkKey": chunk_key,
        "level": int(chunk_key.split("/")[0]),
    }


def server_row(rid: int, backend_bytes: int | None, generation: int = 1, family: str = "chunk") -> dict:
    return {
        "rid": rid,
        "connectionGeneration": generation,
        "family": family,
        "backendBytes": backend_bytes,
    }


def test_audit_accepts_the_sizes_a_shard_read_can_produce_and_flags_the_rest() -> None:
    inner = check.read_shape(SHARDED, "twin", "0/0/1/0/2/3")
    assert inner is not None and inner.inner_bytes is not None
    shard_bytes = inner.path.stat().st_size
    run = {
        "rows": [
            browser_row(1, "0/0/1/0/2/3"),
            browser_row(2, "0/0/1/0/2/3"),
            browser_row(3, "0/0/1/0/2/3"),
            browser_row(4, "0/0/1/0/2/3"),
            browser_row(5, "0/0/1/0/2/3"),
            browser_row(6, "7/0/0/0/0/0"),
            browser_row(7, "7/0/0/0/0/0"),
            # Two coalesced browser rows under one label share the key.
            browser_row(8, "0/0/1/0/2/3"),
            browser_row(8, "0/0/1/0/2/3"),
        ],
        "serverRows": [
            server_row(1, inner.inner_bytes),
            server_row(2, inner.inner_bytes + TWIN_INDEX_BYTES),
            server_row(3, TWIN_INDEX_BYTES),
            server_row(4, None),
            server_row(5, shard_bytes),
            server_row(6, None),
            server_row(7, 64),
            server_row(8, inner.inner_bytes),
            server_row(99, 10),
            server_row(1, 5, family="asset"),
        ],
    }
    audit = check.audit_reads(SHARDED, run)
    assert audit.by_kind == {"inner-chunk": 2, "index+inner-chunk": 1, "index": 1}
    assert audit.range_reads == 3
    assert audit.no_read == 1
    assert audit.generated == 2
    assert audit.unlabelled == 1
    assert audit.largest_read == shard_bytes
    assert audit.smallest_shard == shard_bytes
    assert not audit.ok
    assert len(audit.violations) == 2
    assert f"read {shard_bytes} bytes" in audit.violations[0]
    assert "generated level" in audit.violations[1]


def test_audit_of_an_unsharded_run_accepts_only_the_whole_object() -> None:
    size = (UNSHARDED / "0" / "c" / "0" / "0" / "0").stat().st_size
    run = {
        "rows": [browser_row(1, "0/0/0/0/0/0"), browser_row(2, "0/0/0/0/0/0")],
        "serverRows": [server_row(1, size), server_row(2, size - 1)],
    }
    audit = check.audit_reads(UNSHARDED, run)
    assert audit.by_kind == {"object": 1}
    assert audit.range_reads == 0
    assert len(audit.violations) == 1


def write_frame(path: Path, pixels: np.ndarray) -> Path:
    Image.fromarray(pixels.astype(np.uint8), "RGBA").save(path)
    return path


def test_frames_match_within_one_level_and_a_single_color_is_blank(tmp_path: Path) -> None:
    height, width = 10, 10
    gradient = np.zeros((height, width, 4), dtype=np.uint8)
    gradient[..., 0] = np.arange(width, dtype=np.uint8) * 20
    gradient[..., 3] = 255
    first = write_frame(tmp_path / "a.png", gradient)
    same = write_frame(tmp_path / "b.png", gradient)
    identical = check.compare_frames(first, same, tmp_path / "diff.png")
    assert identical.matches and not identical.blank
    assert identical.max_delta == 0 and identical.differing_fraction == 0.0
    assert (identical.width, identical.height) == (width, height)
    assert identical.colors == (10, 10)
    assert not (tmp_path / "diff.png").exists()

    # One level in one channel is what two page loads of one dataset differ
    # by: reported, drawn nowhere, and a match.
    nudged = gradient.copy()
    nudged[2, 2, 1] += 1
    within = check.compare_frames(first, write_frame(tmp_path / "n.png", nudged), tmp_path / "diff.png")
    assert within.matches and within.max_delta == 1
    assert within.differing_fraction == pytest.approx(0.01)
    assert not (tmp_path / "diff.png").exists()

    changed = nudged.copy()
    changed[3, 4] = (255, 255, 255, 255)
    other = write_frame(tmp_path / "c.png", changed)
    differing = check.compare_frames(first, other, tmp_path / "diff.png")
    assert differing.differing_fraction == pytest.approx(0.02)
    assert differing.max_delta == 255
    assert not differing.matches
    # The picture of the difference shows only what lies beyond the tolerance.
    diff = np.asarray(Image.open(tmp_path / "diff.png").convert("RGBA"))
    assert tuple(diff[3, 4]) == (255, 0, 255, 255)
    assert tuple(diff[2, 2]) == (0, 0, 0, 255)
    assert tuple(diff[0, 0]) == (0, 0, 0, 255)

    blank = write_frame(tmp_path / "blank.png", np.full((height, width, 4), (9, 9, 9, 255), dtype=np.uint8))
    assert check.compare_frames(blank, blank).blank

    smaller = write_frame(tmp_path / "small.png", gradient[:5, :5])
    mismatched = check.compare_frames(first, smaller)
    assert mismatched.differing_fraction == 1.0 and not mismatched.matches


def test_the_run_file_yields_the_run_the_driver_waited_for(tmp_path: Path) -> None:
    waited = {"header": {"runId": "run-1-2"}, "rows": [{"level": 3}], "serverRows": []}
    later = {"header": {"runId": "run-1-3"}, "rows": [], "serverRows": []}
    run_file = tmp_path / "run.json"
    run_file.write_text(json.dumps({"header": {"runId": "run-1-2"}, "trace": {"runs": [waited, later]}}))
    assert check.run_in_document(run_file) == waited
    assert check.levels_requested(waited) == {3}

    run_file.write_text(json.dumps({"header": {"runId": None}, "trace": {"runs": []}}))
    with pytest.raises(ValueError):
        check.run_in_document(run_file)


def test_twin_pairs_write_the_same_recipe_twice_and_refuse_a_coarse_pair_the_server_would_not_fill(
    tmp_path: Path,
) -> None:
    pairs = check.twin_pairs(check.parse_args([]))
    assert [pair.name for pair in pairs] == ["pyramid", "coarse"]
    pyramid, coarse = pairs
    assert pyramid.source_levels == 4 and not pyramid.generated_coarse
    unsharded = pyramid.unsharded_args(tmp_path)
    sharded = pyramid.sharded_args(tmp_path)
    assert unsharded[0].endswith("pyramid-unsharded.ome.zarr")
    assert sharded[0].endswith("pyramid-sharded.ome.zarr")
    assert sharded[1:] == [*unsharded[1:-1], "--shard", "512", "--overwrite"]

    # One image, one level, and a source grid the server's own fill covers:
    # 768x2304 in 256-sample chunks is 3x9 = 27 chunks, under the limit of 32.
    assert coarse.source_levels == 1 and coarse.generated_coarse
    assert "--tiles" not in coarse.generator_args
    args = coarse.generator_args
    assert args[args.index("--levels") + 1] == "1"
    assert args[args.index("--chunk") + 1] == "256"
    assert args[args.index("--size") + 1] == "768,2304"

    # A long axis the source would serve as the coarse tier generates nothing.
    with pytest.raises(SystemExit):
        check.twin_pairs(check.parse_args(["--coarse-size", "2048,2048"]))
    # A grid the server's own fill cannot finish would stall on a static view.
    with pytest.raises(SystemExit):
        check.twin_pairs(check.parse_args(["--coarse-chunk", "64"]))
    check.twin_pairs(check.parse_args(["--coarse-size", "2304,2304", "--coarse-chunk", "512"]))


def test_ready_generated_chunks_sums_the_health_report_over_datasets() -> None:
    health = {
        "datasets": [
            {"name": "a", "generated_coarse": {"status": "healthy", "ready_chunks": 27, "pending_chunks": 0}},
            {"name": "b", "generated_coarse": {"status": "healthy", "ready_chunks": 5, "pending_chunks": 3}},
        ]
    }
    assert check.ready_generated_chunks(health) == 32
    assert check.ready_generated_chunks({"datasets": []}) == 0


if __name__ == "__main__":
    # zarr is already imported through the check, so pytest warns it cannot
    # rewrite zarr's asserts; none are exercised here.
    raise SystemExit(pytest.main([__file__, "-q", "-W", "ignore::pytest.PytestAssertRewriteWarning", *sys.argv[1:]]))
