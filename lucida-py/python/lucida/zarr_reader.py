"""Read Zarr v3 chunks from disk and assemble into numpy arrays."""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import lz4.block
import numpy as np


@dataclass
class ViewportData:
    """Chunk data assembled from the current viewport."""

    data: np.ndarray  # shape (Z, Y, X)
    origin: tuple[int, int, int]  # (z, y, x) voxel offset at this level
    level: int
    level_shape: tuple[int, int, int]  # full (Z, Y, X) at this level
    chunk_shape: tuple[int, int, int]  # (Z, Y, X) chunk size
    t: int
    c: int
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)  # (Z, Y, X) physical spacing


@dataclass
class LevelMeta:
    """Parsed metadata for a single resolution level."""

    chunk_shape: tuple[int, int, int]  # (Z, Y, X)
    shape: tuple[int, int, int]  # (Z, Y, X)
    dtype: np.dtype
    codecs: list[dict]


def read_level_meta(store_path: str | Path, level: int) -> LevelMeta:
    """Parse ``{store_path}/{level}/zarr.json`` for chunk shape, dtype, codecs."""
    zarr_json = Path(store_path) / str(level) / "zarr.json"
    with open(zarr_json) as f:
        meta = json.load(f)

    # shape and chunk_shape are [T, C, Z, Y, X]
    full_shape = meta["shape"]
    chunk_shape_full = meta["chunk_grid"]["configuration"]["chunk_shape"]

    shape_zyx = (full_shape[2], full_shape[3], full_shape[4])
    chunk_zyx = (chunk_shape_full[2], chunk_shape_full[3], chunk_shape_full[4])

    dtype = np.dtype(meta["data_type"])
    codecs = meta.get("codecs", [])

    return LevelMeta(
        chunk_shape=chunk_zyx,
        shape=shape_zyx,
        dtype=dtype,
        codecs=codecs,
    )


def _has_lz4(codecs: list[dict]) -> bool:
    return any(c.get("name") == "numcodecs/lz4" for c in codecs)


def decompress_chunk(raw_bytes: bytes, codecs: list[dict]) -> bytes:
    """Decompress chunk data. LZ4 format: 4-byte LE original size + lz4 block."""
    if _has_lz4(codecs):
        orig_size = struct.unpack("<I", raw_bytes[:4])[0]
        return lz4.block.decompress(raw_bytes[4:], uncompressed_size=orig_size)
    return raw_bytes


def read_chunk_from_file(
    store_path: str | Path,
    level: int,
    t: int,
    c: int,
    z: int,
    y: int,
    x: int,
    meta: LevelMeta,
) -> np.ndarray:
    """Read a single chunk file and return as numpy array shaped (cz, cy, cx)."""
    path = Path(store_path) / str(level) / "c" / str(t) / str(c) / str(z) / str(y) / str(x)
    raw = path.read_bytes()
    decompressed = decompress_chunk(raw, meta.codecs)
    arr = np.frombuffer(decompressed, dtype=meta.dtype)
    cz, cy, cx = meta.chunk_shape
    return arr.reshape((cz, cy, cx))


def assemble_chunks(
    chunks_dict: dict[str, np.ndarray],
    needed: list[dict],
    chunk_shape_zyx: tuple[int, int, int],
    level_shape_zyx: tuple[int, int, int],
    dtype: np.dtype,
) -> tuple[np.ndarray, tuple[int, int, int]]:
    """Assemble chunk arrays into a contiguous volume covering the bounding box.

    Returns ``(data, origin)`` where origin is ``(z, y, x)`` in voxels at this level.
    """
    cz, cy, cx = chunk_shape_zyx
    depth_full, height_full, width_full = level_shape_zyx

    # Compute bounding box of chunk grid coords
    xs = [ch["x"] for ch in needed]
    ys = [ch["y"] for ch in needed]
    zs = [ch["z"] for ch in needed]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)

    # Origin in voxel coords at this level
    origin_x = min_x * cx
    origin_y = min_y * cy
    origin_z = min_z * cz

    # Output size, clamped to level shape at edges
    out_x = min((max_x - min_x + 1) * cx, width_full - origin_x)
    out_y = min((max_y - min_y + 1) * cy, height_full - origin_y)
    out_z = min((max_z - min_z + 1) * cz, depth_full - origin_z)

    output = np.zeros((out_z, out_y, out_x), dtype=dtype)

    for ch in needed:
        key = ch["key"]
        if key not in chunks_dict:
            continue
        chunk_arr = chunks_dict[key]

        x_off = (ch["x"] - min_x) * cx
        y_off = (ch["y"] - min_y) * cy
        z_off = (ch["z"] - min_z) * cz

        # Valid region to copy (may be smaller at edges)
        cw = min(cx, out_x - x_off)
        ch_h = min(cy, out_y - y_off)
        cd = min(cz, out_z - z_off)

        # Zarr v3 chunks are stored at full chunk shape (zero-padded),
        # so source uses full chunk dimensions; only copy valid portion
        output[z_off:z_off + cd, y_off:y_off + ch_h, x_off:x_off + cw] = \
            chunk_arr[:cd, :ch_h, :cw]

    return output, (origin_z, origin_y, origin_x)
