from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence


@dataclass(frozen=True, slots=True)
class FixtureSpec:
    level0_shape: tuple[int, int, int, int, int] = (1, 3, 1, 768, 768)
    level1_shape: tuple[int, int, int, int, int] = (1, 3, 1, 384, 384)
    level0_chunk: tuple[int, int, int, int, int] = (1, 1, 1, 192, 192)
    level1_chunk: tuple[int, int, int, int, int] = (1, 1, 1, 192, 192)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _ceil_div(value: int, divisor: int) -> int:
    return (value + divisor - 1) // divisor


def _strides(shape: Sequence[int]) -> list[int]:
    if not shape:
        return []
    strides = [1] * len(shape)
    for axis in range(len(shape) - 2, -1, -1):
        strides[axis] = strides[axis + 1] * shape[axis + 1]
    return strides


def _for_each_index(shape: Sequence[int]) -> Iterator[list[int]]:
    if not shape or any(axis == 0 for axis in shape):
        return
    index = [0] * len(shape)
    while True:
        yield index.copy()
        axis = len(shape) - 1
        while axis >= 0:
            index[axis] += 1
            if index[axis] < shape[axis]:
                break
            index[axis] = 0
            axis -= 1
        if axis < 0:
            return


def _linear_index(index: Sequence[int], strides: Sequence[int]) -> int:
    return sum(item * stride for item, stride in zip(index, strides))


def _level0_value(channel: int, y: int, x: int, x_size: int) -> int:
    return (channel * 12000) + ((y * x_size + x) % 10000)


def _write_array_metadata(
    level_path: Path,
    shape: Sequence[int],
    chunk_shape: Sequence[int],
) -> None:
    payload = {
        "zarr_format": 3,
        "node_type": "array",
        "shape": list(shape),
        "data_type": "uint16",
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": list(chunk_shape)},
        },
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": 0,
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "attributes": {},
        "storage_transformers": [],
    }
    level_path.mkdir(parents=True, exist_ok=True)
    (level_path / "zarr.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_root_metadata(root_path: Path) -> None:
    payload = {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "multiscales": [
                {
                    "name": "primary",
                    "axes": [
                        {"name": "t", "type": "t"},
                        {"name": "c", "type": "c"},
                        {"name": "z", "type": "z"},
                        {"name": "y", "type": "y"},
                        {"name": "x", "type": "x"},
                    ],
                    "datasets": [
                        {
                            "path": "0",
                            "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 1, 1, 1]}],
                        },
                        {
                            "path": "1",
                            "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 1, 2, 2]}],
                        },
                    ],
                }
            ],
            "omero": {
                "channels": [
                    {"index": 0, "label": "c0", "color": "ffffff", "window": {"start": 0, "end": 10000}},
                    {"index": 1, "label": "c1", "color": "ff0000", "window": {"start": 0, "end": 22000}},
                    {"index": 2, "label": "c2", "color": "00ff00", "window": {"start": 0, "end": 34000}},
                ]
            },
        },
    }
    root_path.mkdir(parents=True, exist_ok=True)
    (root_path / "zarr.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_chunk_files(
    level_path: Path,
    shape: Sequence[int],
    chunk_shape: Sequence[int],
    source_level0_width: int,
    is_level1: bool,
) -> None:
    chunk_counts = [_ceil_div(axis_size, chunk_axis) for axis_size, chunk_axis in zip(shape, chunk_shape)]
    chunk_strides = _strides(chunk_shape)
    chunk_value_count = (
        chunk_shape[0] * chunk_shape[1] * chunk_shape[2] * chunk_shape[3] * chunk_shape[4]
    )
    for chunk_index in _for_each_index(chunk_counts):
        local_values = [0] * int(chunk_value_count)

        actual_shape = []
        chunk_start = []
        for axis, chunk_axis in enumerate(chunk_shape):
            axis_start = chunk_index[axis] * chunk_axis
            chunk_start.append(axis_start)
            actual_shape.append(min(chunk_axis, shape[axis] - axis_start))

        for local_index in _for_each_index(actual_shape):
            global_index = [chunk_start[axis] + local_index[axis] for axis in range(len(shape))]
            channel = global_index[1]
            y = global_index[3]
            x = global_index[4]
            if is_level1:
                value = _level0_value(channel, y * 2, x * 2, source_level0_width)
            else:
                value = _level0_value(channel, y, x, source_level0_width)
            local_linear = _linear_index(local_index, chunk_strides)
            local_values[local_linear] = value

        encoded = bytearray(len(local_values) * 2)
        for index, value in enumerate(local_values):
            encoded[index * 2 : index * 2 + 2] = int(value).to_bytes(2, byteorder="little", signed=False)

        chunk_path = level_path / "c"
        for index in chunk_index:
            chunk_path = chunk_path / str(index)
        chunk_path.parent.mkdir(parents=True, exist_ok=True)
        chunk_path.write_bytes(bytes(encoded))


def create_render_perf_fixture(
    output_path: Path,
    *,
    spec: FixtureSpec = FixtureSpec(),
    overwrite: bool = False,
) -> Path:
    if output_path.exists() and overwrite:
        for child in sorted(output_path.rglob("*"), reverse=True):
            if child.is_file() or child.is_symlink():
                child.unlink()
            elif child.is_dir():
                child.rmdir()
        output_path.rmdir()

    if output_path.exists() and not overwrite:
        raise FileExistsError(f"fixture path already exists: {output_path}")

    _write_root_metadata(output_path)
    level0_path = output_path / "0"
    level1_path = output_path / "1"
    _write_array_metadata(level0_path, spec.level0_shape, spec.level0_chunk)
    _write_array_metadata(level1_path, spec.level1_shape, spec.level1_chunk)
    _write_chunk_files(level0_path, spec.level0_shape, spec.level0_chunk, spec.level0_shape[4], False)
    _write_chunk_files(level1_path, spec.level1_shape, spec.level1_chunk, spec.level0_shape[4], True)
    return output_path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate deterministic OME-Zarr render benchmark fixture.")
    parser.add_argument(
        "--output",
        type=Path,
        default=_repo_root() / "output" / "perf" / "fixtures" / "render-bench.zarr",
        help="Fixture output path.",
    )
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output path.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    output = args.output.expanduser().resolve()
    create_render_perf_fixture(output, overwrite=args.overwrite)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
