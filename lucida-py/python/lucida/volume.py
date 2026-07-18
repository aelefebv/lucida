"""Bounded assembly helpers for chunks returned by the canonical Rust store.

This module deliberately does not decode Zarr metadata, paths, or codecs. Those
formats are owned by ``lucida-store``; keeping a second partial decoder in
Python caused the two clients to disagree on valid datasets.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


DEFAULT_MAX_ASSEMBLY_BYTES = 256 * 1024 * 1024


@dataclass
class ViewportData:
    """Chunk data assembled from an explicitly bounded viewport."""

    data: np.ndarray
    origin: tuple[int, int, int]
    level: int
    level_shape: tuple[int, int, int]
    chunk_shape: tuple[int, int, int]
    t: int
    c: int
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)


def assemble_chunks(
    chunks: dict[str, np.ndarray],
    needed: list[dict[str, Any]],
    chunk_shape_zyx: tuple[int, int, int],
    level_shape_zyx: tuple[int, int, int],
    dtype: np.dtype | str,
    *,
    crop_zyx: tuple[tuple[int, int], tuple[int, int], tuple[int, int]] | None = None,
    max_bytes: int = DEFAULT_MAX_ASSEMBLY_BYTES,
) -> tuple[np.ndarray, tuple[int, int, int]]:
    """Assemble sparse chunks into a byte-budgeted Z/Y/X crop.

    ``crop_zyx`` uses half-open level-voxel bounds. Without it, the result is
    the intersection of the requested chunks' bounding box and the level. A
    sparse request whose bounding box exceeds ``max_bytes`` is rejected before
    allocation; callers should provide a crop or stream smaller batches.
    """

    dtype = np.dtype(dtype)
    chunk_shape = _positive_shape("chunk_shape_zyx", chunk_shape_zyx)
    level_shape = _nonnegative_shape("level_shape_zyx", level_shape_zyx)
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if not needed:
        return np.zeros((0, 0, 0), dtype=dtype), (0, 0, 0)

    coordinates: list[tuple[int, int, int, str]] = []
    for index, chunk in enumerate(needed):
        try:
            coordinate = (int(chunk["z"]), int(chunk["y"]), int(chunk["x"]))
            key = str(chunk["key"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"needed[{index}] is not a valid chunk reference") from error
        if any(value < 0 for value in coordinate):
            raise ValueError(f"needed[{index}] has a negative chunk coordinate")
        coordinates.append((*coordinate, key))

    starts = tuple(
        min(coordinate[axis] for coordinate in coordinates) * chunk_shape[axis]
        for axis in range(3)
    )
    ends = tuple(
        min(
            (max(coordinate[axis] for coordinate in coordinates) + 1)
            * chunk_shape[axis],
            level_shape[axis],
        )
        for axis in range(3)
    )
    if crop_zyx is not None:
        crop = _validate_crop(crop_zyx, level_shape)
        starts = tuple(max(starts[axis], crop[axis][0]) for axis in range(3))
        ends = tuple(min(ends[axis], crop[axis][1]) for axis in range(3))

    output_shape = tuple(max(0, ends[axis] - starts[axis]) for axis in range(3))
    element_count = output_shape[0] * output_shape[1] * output_shape[2]
    required_bytes = element_count * dtype.itemsize
    if required_bytes > max_bytes:
        raise MemoryError(
            f"chunk assembly requires {required_bytes} bytes; limit is {max_bytes}; "
            "provide crop_zyx or stream smaller batches"
        )
    output = np.zeros(output_shape, dtype=dtype)

    for chunk_z, chunk_y, chunk_x, key in coordinates:
        array = chunks.get(key)
        if array is None:
            continue
        if array.ndim != 3:
            raise ValueError(f"chunk {key!r} must be a 3D Z/Y/X array")
        chunk_start = (
            chunk_z * chunk_shape[0],
            chunk_y * chunk_shape[1],
            chunk_x * chunk_shape[2],
        )
        chunk_end = tuple(
            min(chunk_start[axis] + array.shape[axis], level_shape[axis])
            for axis in range(3)
        )
        copy_start = tuple(max(starts[axis], chunk_start[axis]) for axis in range(3))
        copy_end = tuple(min(ends[axis], chunk_end[axis]) for axis in range(3))
        if any(copy_end[axis] <= copy_start[axis] for axis in range(3)):
            continue
        destination = tuple(
            slice(copy_start[axis] - starts[axis], copy_end[axis] - starts[axis])
            for axis in range(3)
        )
        source = tuple(
            slice(
                copy_start[axis] - chunk_start[axis],
                copy_end[axis] - chunk_start[axis],
            )
            for axis in range(3)
        )
        output[destination] = array[source].astype(dtype, copy=False)

    return output, starts


def _positive_shape(name: str, shape: tuple[int, int, int]) -> tuple[int, int, int]:
    values = _shape(name, shape)
    if any(value <= 0 for value in values):
        raise ValueError(f"{name} values must be positive")
    return values


def _nonnegative_shape(
    name: str, shape: tuple[int, int, int]
) -> tuple[int, int, int]:
    values = _shape(name, shape)
    if any(value < 0 for value in values):
        raise ValueError(f"{name} values must be non-negative")
    return values


def _shape(name: str, shape: tuple[int, int, int]) -> tuple[int, int, int]:
    if len(shape) != 3:
        raise ValueError(f"{name} must contain exactly three values")
    try:
        return tuple(int(value) for value in shape)  # type: ignore[return-value]
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} values must be integers") from error


def _validate_crop(
    crop: tuple[tuple[int, int], tuple[int, int], tuple[int, int]],
    level_shape: tuple[int, int, int],
) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    if len(crop) != 3:
        raise ValueError("crop_zyx must contain three (start, end) pairs")
    normalized = []
    for axis, bounds in enumerate(crop):
        if len(bounds) != 2:
            raise ValueError("each crop_zyx axis must contain (start, end)")
        start, end = int(bounds[0]), int(bounds[1])
        if start < 0 or end < start or end > level_shape[axis]:
            raise ValueError(
                f"crop_zyx axis {axis} must satisfy 0 <= start <= end <= "
                f"{level_shape[axis]}"
            )
        normalized.append((start, end))
    return tuple(normalized)  # type: ignore[return-value]
