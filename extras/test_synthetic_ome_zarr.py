# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pytest>=8"]
# ///
"""Tests for the synthetic OME-Zarr fixture generator.

Run with ``uv run extras/test_synthetic_ome_zarr.py``, which installs the
dependencies from the inline metadata, or with plain ``pytest`` in an
environment that has zarr-python 3, numpy, and pytest installed. The
committed-fixture test also needs ``uv`` on PATH, because ``regenerate.sh``
runs the generator through it.

Every test reads the written store back with zarr-python or by parsing the
shard index bytes directly. Nothing here asserts on the generator's internals.
"""

from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import zarr

sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic_ome_zarr as gen  # noqa: E402

ABSENT = (2**64 - 1, 2**64 - 1)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def multiscale(image_dir: Path) -> dict:
    return read_json(image_dir / "zarr.json")["attributes"]["ome"]["multiscales"][0]


def read_shard_index(shard_path: Path, inner_chunks: int) -> list[tuple[int, int]]:
    """Return the (offset, nbytes) entries of a shard whose index is at the end.

    The index is ``inner_chunks`` little-endian ``(u64, u64)`` pairs in C order
    over the inner chunk grid, followed by a 4-byte crc32c checksum.
    """
    data = shard_path.read_bytes()
    index_bytes = inner_chunks * 16
    tail = data[-(index_bytes + 4) : -4]
    raw = struct.unpack("<" + "QQ" * inner_chunks, tail)
    return [(raw[2 * i], raw[2 * i + 1]) for i in range(inner_chunks)]


def level_array(image_dir: Path, level: int) -> np.ndarray:
    return np.asarray(zarr.open_array(str(image_dir / str(level)), mode="r")[:])


def generate(tmp_path: Path, name: str, *args: str) -> Path:
    out = tmp_path / name
    assert gen.main([str(out), *args]) == 0
    return out


def test_irregular_and_per_axis_factors_produce_declared_shapes(tmp_path: Path) -> None:
    out = generate(
        tmp_path,
        "shapes.ome.zarr",
        "--size", "9,40,50",
        "--channels", "2",
        "--levels", "4",
        "--factor", "1,2,2",
        "--factor", "3",
        "--factor", "2,1,5",
        "--chunk", "4",
    )
    expected_shapes = [
        [2, 9, 40, 50],
        [2, 9, 20, 25],
        [2, 3, 7, 9],
        [2, 2, 7, 2],
    ]
    expected_scales = [
        [1.0, 1.0, 1.0, 1.0],
        [1.0, 1.0, 2.0, 2.0],
        [1.0, 3.0, 6.0, 6.0],
        [1.0, 6.0, 6.0, 30.0],
    ]
    ms = multiscale(out)
    assert [a["name"] for a in ms["axes"]] == ["c", "z", "y", "x"]
    assert [d["path"] for d in ms["datasets"]] == ["0", "1", "2", "3"]
    for level, dataset in enumerate(ms["datasets"]):
        transforms = dataset["coordinateTransformations"]
        assert transforms == [{"type": "scale", "scale": expected_scales[level]}]
        meta = read_json(out / str(level) / "zarr.json")
        assert meta["zarr_format"] == 3
        assert meta["node_type"] == "array"
        assert meta["shape"] == expected_shapes[level]
        assert meta["data_type"] == "uint16"
        assert meta["chunk_grid"]["configuration"]["chunk_shape"] == [1, 4, 4, 4]
        assert meta["chunk_key_encoding"] == {
            "name": "default",
            "configuration": {"separator": "/"},
        }
        assert level_array(out, level).shape == tuple(expected_shapes[level])


def test_last_factor_repeats_for_remaining_levels(tmp_path: Path) -> None:
    out = generate(tmp_path, "repeat.ome.zarr", "--size", "64,64", "--levels", "4", "--factor", "2", "--chunk", "8")
    shapes = [read_json(out / str(level) / "zarr.json")["shape"] for level in range(4)]
    assert shapes == [[64, 64], [32, 32], [16, 16], [8, 8]]
    ms = multiscale(out)
    assert [a["name"] for a in ms["axes"]] == ["y", "x"]
    assert ms["datasets"][3]["coordinateTransformations"][0]["scale"] == [8.0, 8.0]


def test_time_and_channel_axes_appear_when_larger_than_one(tmp_path: Path) -> None:
    out = generate(
        tmp_path, "tc.ome.zarr", "--size", "4,16,16", "--channels", "3", "--timepoints", "2", "--levels", "2", "--chunk", "8"
    )
    ms = multiscale(out)
    assert [a["name"] for a in ms["axes"]] == ["t", "c", "z", "y", "x"]
    assert [a["type"] for a in ms["axes"]] == ["time", "channel", "space", "space", "space"]
    meta = read_json(out / "0" / "zarr.json")
    assert meta["shape"] == [2, 3, 4, 16, 16]
    assert meta["chunk_grid"]["configuration"]["chunk_shape"] == [1, 1, 8, 8, 8]
    assert ms["datasets"][1]["coordinateTransformations"][0]["scale"] == [1.0, 1.0, 2.0, 2.0, 2.0]


def test_unsharded_codec_chain_is_bytes_then_zstd(tmp_path: Path) -> None:
    out = generate(tmp_path, "flat.ome.zarr", "--size", "16,16", "--levels", "1", "--chunk", "8")
    codecs = read_json(out / "0" / "zarr.json")["codecs"]
    assert codecs[0] == {"name": "bytes", "configuration": {"endian": "little"}}
    assert codecs[1]["name"] == "zstd"
    assert len(codecs) == 2


def test_sharded_codec_chain_wraps_the_same_inner_chain(tmp_path: Path) -> None:
    out = generate(tmp_path, "sharded.ome.zarr", "--size", "32,32", "--levels", "1", "--chunk", "8", "--shard", "16")
    meta = read_json(out / "0" / "zarr.json")
    assert meta["chunk_grid"]["configuration"]["chunk_shape"] == [16, 16]
    assert len(meta["codecs"]) == 1
    outer = meta["codecs"][0]
    assert outer["name"] == "sharding_indexed"
    cfg = outer["configuration"]
    assert cfg["chunk_shape"] == [8, 8]
    assert cfg["index_location"] == "end"
    assert cfg["codecs"][0] == {"name": "bytes", "configuration": {"endian": "little"}}
    assert cfg["codecs"][1]["name"] == "zstd"
    assert [c["name"] for c in cfg["index_codecs"]] == ["bytes", "crc32c"]


def test_sharded_and_unsharded_twins_hold_identical_samples(tmp_path: Path) -> None:
    common = ["--size", "48,48", "--channels", "2", "--levels", "3", "--chunk", "8", "--seed", "11"]
    flat = generate(tmp_path, "twin-unsharded.ome.zarr", *common)
    sharded = generate(tmp_path, "twin-sharded.ome.zarr", *common, "--shard", "16")
    for level in range(3):
        a = level_array(flat, level)
        b = level_array(sharded, level)
        assert a.dtype == np.uint16
        np.testing.assert_array_equal(a, b)
        assert a.std() > 0, f"level {level} is constant, so a wrong read could pass"
    level0 = level_array(flat, 0)
    assert not np.array_equal(level0[0], level0[1])
    assert len(list((flat / "0" / "c").rglob("*"))) > len(list((sharded / "0" / "c").rglob("*")))
    assert multiscale(flat)["axes"] == multiscale(sharded)["axes"]
    assert multiscale(flat)["datasets"] == multiscale(sharded)["datasets"]


def test_same_seed_reproduces_and_different_seed_differs(tmp_path: Path) -> None:
    common = ["--size", "16,16", "--levels", "1", "--chunk", "8"]
    first = generate(tmp_path, "a.ome.zarr", *common, "--seed", "3")
    again = generate(tmp_path, "b.ome.zarr", *common, "--seed", "3")
    other = generate(tmp_path, "c.ome.zarr", *common, "--seed", "4")
    np.testing.assert_array_equal(level_array(first, 0), level_array(again, 0))
    assert not np.array_equal(level_array(first, 0), level_array(other, 0))


def test_coarser_levels_resample_the_same_picture(tmp_path: Path) -> None:
    """A coarse level is a resampling of the fine one, not an unrelated picture."""
    out = generate(tmp_path, "pyramid.ome.zarr", "--size", "64,64", "--levels", "2", "--chunk", "8")
    fine = level_array(out, 0).astype(np.float64)
    coarse = level_array(out, 1).astype(np.float64)
    block_mean = fine.reshape(32, 2, 32, 2).mean(axis=(1, 3))
    # Coarse levels are point-sampled, not averaged; the picture is smooth
    # enough that the gap to the block mean stays under 2% of the range.
    assert np.abs(coarse - block_mean).max() < 0.02 * np.iinfo(np.uint16).max


@pytest.mark.parametrize("shard_args", [[], ["--shard", "16"]], ids=["unsharded", "sharded"])
def test_level_index_makes_every_sample_read_back_as_its_level(tmp_path: Path, shard_args: list[str]) -> None:
    out = generate(tmp_path, "li.ome.zarr", "--size", "32,32", "--levels", "3", "--chunk", "8", "--level-index", *shard_args)
    for level in range(3):
        values = level_array(out, level)
        assert values.shape == (32 >> level, 32 >> level)
        assert np.all(values == level), f"level {level} holds values other than {level}"


def test_level_index_writes_the_all_zero_level_zero(tmp_path: Path) -> None:
    """Level 0 is all zeros, equal to the fill value, and must still be written.

    A reader that treats a missing chunk as fill would make the level look
    right while nothing is there, so this checks the objects themselves.
    """
    flat = generate(tmp_path, "li-flat.ome.zarr", "--size", "32,32", "--levels", "1", "--chunk", "8", "--level-index")
    for y in range(4):
        for x in range(4):
            assert (flat / "0" / "c" / str(y) / str(x)).is_file()
    sharded = generate(
        tmp_path, "li-sharded.ome.zarr", "--size", "32,32", "--levels", "1", "--chunk", "8", "--shard", "16", "--level-index"
    )
    for sy in range(2):
        for sx in range(2):
            index = read_shard_index(sharded / "0" / "c" / str(sy) / str(sx), inner_chunks=4)
            assert ABSENT not in index


def test_level_index_in_three_dimensions_with_z_left_alone(tmp_path: Path) -> None:
    out = generate(
        tmp_path, "li3d.ome.zarr", "--size", "8,32,32", "--levels", "3", "--factor", "1,2,2", "--chunk", "4,8,8", "--level-index"
    )
    for level in range(3):
        values = level_array(out, level)
        assert values.shape == (8, 32 >> level, 32 >> level)
        assert np.all(values == level)


def test_sparse_unsharded_leaves_a_checkerboard_of_chunks_unwritten(tmp_path: Path) -> None:
    common = ["--size", "32,32", "--levels", "3", "--chunk", "8", "--seed", "5"]
    dense = generate(tmp_path, "dense.ome.zarr", *common)
    sparse = generate(tmp_path, "sparse.ome.zarr", *common, "--sparse", "--unwritten-level", "2")

    dense0 = level_array(dense, 0)
    sparse0 = level_array(sparse, 0)
    for y in range(4):
        for x in range(4):
            region = (slice(8 * y, 8 * y + 8), slice(8 * x, 8 * x + 8))
            written = (y + x) % 2 == 0
            assert (sparse / "0" / "c" / str(y) / str(x)).is_file() == written
            if written:
                np.testing.assert_array_equal(sparse0[region], dense0[region])
            else:
                assert np.all(sparse0[region] == 0)
    # Parity keeps the origin chunk written at every level, which the
    # unwritten-level probe relies on.
    assert (sparse / "0" / "c" / "0" / "0").is_file()
    assert (sparse / "1" / "c" / "0" / "0").is_file()

    assert [d["path"] for d in multiscale(sparse)["datasets"]] == ["0", "1", "2"]
    assert (sparse / "2" / "zarr.json").is_file()
    assert not (sparse / "2" / "c").exists()
    assert np.all(level_array(sparse, 2) == 0)


def test_sparse_sharded_marks_inner_chunks_absent_in_the_shard_index(tmp_path: Path) -> None:
    common = ["--size", "32,32", "--levels", "3", "--chunk", "8", "--shard", "16", "--seed", "5"]
    dense = generate(tmp_path, "dense.ome.zarr", *common)
    sparse = generate(tmp_path, "sparse.ome.zarr", *common, "--sparse", "--unwritten-level", "2")

    dense0 = level_array(dense, 0)
    sparse0 = level_array(sparse, 0)
    for sy in range(2):
        for sx in range(2):
            shard = sparse / "0" / "c" / str(sy) / str(sx)
            assert shard.is_file(), "every shard keeps at least one written inner chunk"
            index = read_shard_index(shard, inner_chunks=4)
            for iy in range(2):
                for ix in range(2):
                    y, x = 2 * sy + iy, 2 * sx + ix
                    written = (y + x) % 2 == 0
                    entry = index[iy * 2 + ix]
                    assert (entry != ABSENT) == written, f"inner chunk ({y}, {x})"
                    region = (slice(8 * y, 8 * y + 8), slice(8 * x, 8 * x + 8))
                    if written:
                        np.testing.assert_array_equal(sparse0[region], dense0[region])
                    else:
                        assert np.all(sparse0[region] == 0)
    assert (sparse / "2" / "zarr.json").is_file()
    assert not (sparse / "2" / "c").exists()


def test_sparse_parity_counts_every_axis(tmp_path: Path) -> None:
    out = generate(
        tmp_path, "sparse-tc.ome.zarr", "--size", "8,8", "--channels", "2", "--timepoints", "2", "--levels", "1", "--chunk", "4", "--sparse"
    )
    for t in range(2):
        for c in range(2):
            for y in range(2):
                for x in range(2):
                    written = (t + c + y + x) % 2 == 0
                    assert (out / "0" / "c" / str(t) / str(c) / str(y) / str(x)).is_file() == written


def test_collection_lays_tiles_out_as_a_grid_of_groups(tmp_path: Path) -> None:
    out = generate(tmp_path, "collection.ome.zarr", "--tiles", "5", "--size", "16,16", "--levels", "2", "--chunk", "8")
    root = read_json(out / "zarr.json")
    assert root["node_type"] == "group"
    ome = root["attributes"]["ome"]
    assert ome["version"] == "0.5"
    collection = ome["plate"]
    assert [r["name"] for r in collection["rows"]] == ["A", "B"]
    assert [c["name"] for c in collection["columns"]] == ["1", "2", "3"]
    assert collection["wells"] == [
        {"path": "A/1", "rowIndex": 0, "columnIndex": 0},
        {"path": "A/2", "rowIndex": 0, "columnIndex": 1},
        {"path": "A/3", "rowIndex": 0, "columnIndex": 2},
        {"path": "B/1", "rowIndex": 1, "columnIndex": 0},
        {"path": "B/2", "rowIndex": 1, "columnIndex": 1},
    ]
    assert collection["field_count"] == 1
    assert read_json(out / "A" / "zarr.json")["node_type"] == "group"
    assert not (out / "B" / "3").exists()
    for entry in collection["wells"]:
        group = read_json(out / entry["path"] / "zarr.json")
        assert group["attributes"]["ome"]["well"] == {"images": [{"path": "0"}]}
        image = out / entry["path"] / "0"
        assert [d["path"] for d in multiscale(image)["datasets"]] == ["0", "1"]
        assert level_array(image, 0).shape == (16, 16)
        assert level_array(image, 1).shape == (8, 8)
    assert not np.array_equal(level_array(out / "A/1/0", 0), level_array(out / "A/2/0", 0))


def test_collection_tiles_are_identical_across_layouts(tmp_path: Path) -> None:
    common = ["--tiles", "2", "--size", "16,16", "--levels", "1", "--chunk", "8", "--seed", "9"]
    flat = generate(tmp_path, "flat.ome.zarr", *common)
    sharded = generate(tmp_path, "sharded.ome.zarr", *common, "--shard", "16")
    for tile in ["A/1/0", "A/2/0"]:
        np.testing.assert_array_equal(level_array(flat / tile, 0), level_array(sharded / tile, 0))


def test_parse_args_reads_every_option() -> None:
    opts = gen.parse_args(
        [
            "out.zarr",
            "--tiles", "3",
            "--size", "9,40,50",
            "--channels", "2",
            "--timepoints", "4",
            "--levels", "4",
            "--factor", "1,2,2",
            "--factor", "3",
            "--chunk", "4",
            "--shard", "8,8,8",
            "--sparse",
            "--unwritten-level", "3",
            "--unwritten-level", "1",
            "--level-index",
            "--seed", "7",
            "--overwrite",
        ]
    )
    assert opts.out == Path("out.zarr")
    assert opts.tiles == 3
    assert opts.size == (9, 40, 50)
    assert opts.channels == 2
    assert opts.timepoints == 4
    assert opts.levels == 4
    assert opts.factors == ((1, 2, 2), (3, 3, 3))
    assert opts.chunk == (4, 4, 4)
    assert opts.shard == (8, 8, 8)
    assert opts.sparse is True
    assert opts.unwritten_levels == (1, 3)
    assert opts.level_index is True
    assert opts.seed == 7
    assert opts.overwrite is True


def test_parse_args_defaults_describe_a_single_unsharded_image() -> None:
    opts = gen.parse_args(["out.zarr"])
    assert opts.tiles is None
    assert opts.size == (256, 256)
    assert opts.channels == 1
    assert opts.timepoints == 1
    assert opts.levels == 3
    assert opts.factors == ((2, 2),)
    assert opts.chunk == (64, 64)
    assert opts.shard is None
    assert opts.sparse is False
    assert opts.unwritten_levels == ()
    assert opts.level_index is False


@pytest.mark.parametrize(
    "argv",
    [
        ["out.zarr", "--size", "16"],
        ["out.zarr", "--size", "2,3,4,5"],
        ["out.zarr", "--factor", "2,2,2"],
        ["out.zarr", "--chunk", "8", "--shard", "12"],
        ["out.zarr", "--chunk", "8,8", "--shard", "16,16,16"],
        ["out.zarr", "--levels", "2", "--unwritten-level", "2"],
        ["out.zarr", "--unwritten-level", "0"],
        ["out.zarr", "--levels", "0"],
        ["out.zarr", "--tiles", "0"],
        ["out.zarr", "--factor", "0"],
    ],
    ids=[
        "size-arity",
        "size-too-many",
        "factor-arity",
        "shard-not-multiple",
        "shard-arity",
        "unwritten-out-of-range",
        "unwritten-level-zero",
        "no-levels",
        "no-tiles",
        "zero-factor",
    ],
)
def test_parse_args_rejects_inconsistent_options(argv: list[str]) -> None:
    with pytest.raises(SystemExit):
        gen.parse_args(argv)


def test_main_refuses_to_overwrite_unless_asked(tmp_path: Path) -> None:
    out = tmp_path / "once.ome.zarr"
    args = [str(out), "--size", "16,16", "--levels", "1", "--chunk", "8"]
    assert gen.main(args) == 0
    with pytest.raises(SystemExit):
        gen.main(args)
    assert gen.main([*args, "--overwrite"]) == 0
    assert (out / "0" / "zarr.json").is_file()


def test_chunk_grid_covers_partial_edges(tmp_path: Path) -> None:
    """A size that is not a multiple of the chunk or shard still writes every sample."""
    out = generate(tmp_path, "edges.ome.zarr", "--size", "20,20", "--levels", "1", "--chunk", "8", "--shard", "16", "--seed", "2")
    flat = generate(tmp_path, "edges-flat.ome.zarr", "--size", "20,20", "--levels", "1", "--chunk", "8", "--seed", "2")
    a = level_array(out, 0)
    assert a.shape == (20, 20)
    np.testing.assert_array_equal(a, level_array(flat, 0))
    assert a[19, 19] != 0 or a[0, 0] != 0
    assert math.ceil(20 / 16) ** 2 == len(list((out / "0" / "c").rglob("*/*")))


FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "ome-zarr"
COMMITTED = [
    "twin-unsharded.ome.zarr",
    "twin-sharded.ome.zarr",
    "sparse-sharded.ome.zarr",
    "level-index.ome.zarr",
    "collection-unsharded.ome.zarr",
]


def test_committed_fixtures_match_regenerate_script(tmp_path: Path) -> None:
    """The committed fixtures are what regenerate.sh writes today.

    Compares every metadata document and every array's samples rather than
    bytes, because the zstd frames can differ between library versions while
    the data does not. Needs uv on PATH, since regenerate.sh runs the
    generator through it.
    """
    subprocess.run(["bash", str(FIXTURES_DIR / "regenerate.sh"), str(tmp_path)], check=True, capture_output=True)
    for name in COMMITTED:
        committed, fresh = FIXTURES_DIR / name, tmp_path / name
        for meta_path in sorted(committed.rglob("zarr.json")):
            rel = meta_path.relative_to(committed)
            meta = read_json(meta_path)
            assert meta == read_json(fresh / rel), f"{name}/{rel}"
            if meta["node_type"] == "array":
                a = np.asarray(zarr.open_array(str(meta_path.parent), mode="r")[:])
                b = np.asarray(zarr.open_array(str(fresh / rel.parent), mode="r")[:])
                np.testing.assert_array_equal(a, b, err_msg=f"{name}/{rel.parent}")
        committed_objects = sorted(p.relative_to(committed) for p in committed.rglob("*") if p.is_file())
        fresh_objects = sorted(p.relative_to(fresh) for p in fresh.rglob("*") if p.is_file())
        assert committed_objects == fresh_objects, name
        payload = sum(p.stat().st_size for p in committed.rglob("*") if p.is_file())
        assert payload < 20_000, f"{name} is {payload} bytes; the committed fixtures stay small"


def test_committed_twins_hold_identical_samples() -> None:
    flat, sharded = FIXTURES_DIR / "twin-unsharded.ome.zarr", FIXTURES_DIR / "twin-sharded.ome.zarr"
    for level in range(3):
        np.testing.assert_array_equal(level_array(flat, level), level_array(sharded, level))


def test_committed_sparse_pyramid_has_absent_inner_chunks_and_an_unwritten_level() -> None:
    sparse = FIXTURES_DIR / "sparse-sharded.ome.zarr"
    absent = sum(entry == ABSENT for sy in range(2) for sx in range(2) for entry in read_shard_index(sparse / "0" / "c" / str(sy) / str(sx), 4))
    assert absent == 8, "half of the 16 inner chunks at level 0 are absent"
    assert not (sparse / "2" / "c").exists()


def test_committed_level_index_pyramid_reads_back_its_level() -> None:
    pyramid = FIXTURES_DIR / "level-index.ome.zarr"
    for level in range(4):
        assert np.all(level_array(pyramid, level) == level)


if __name__ == "__main__":
    # zarr is already imported, so pytest warns it cannot rewrite zarr's
    # asserts; none are exercised here.
    raise SystemExit(pytest.main([__file__, "-q", "-W", "ignore::pytest.PytestAssertRewriteWarning", *sys.argv[1:]]))
