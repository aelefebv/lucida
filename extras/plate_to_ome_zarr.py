#!/usr/bin/env python3
"""
Standalone HCS plate-to-OME-Zarr v0.5 converter.

Scans a directory of HCS TIFF files matching the pattern:
    r{row}c{col}f{field}p{plane}-ch{channel}t{timepoint}.tiff

and writes a Zarr v3 / OME-Zarr v0.5 plate hierarchy with multiscale pyramids.

Dependencies (pip install):
    tifffile numpy lz4

Usage:
    python plate_to_ome_zarr.py <input_dir> <output.zarr> [options]

    Options:
        --chunk-xy N      XY chunk size (default: 256)
        --chunk-z N       Z chunk size (default: 64)
        --voxel-x X       Override voxel size X (µm)
        --voxel-y Y       Override voxel size Y (µm)
        --voxel-z Z       Override voxel size Z (µm)
        --min-size N      Minimum pyramid dimension (default: 256)
"""

import argparse
import json
import os
import re
import struct
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import lz4.block
import numpy as np
import tifffile


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class VoxelSize:
    x: float = 1.0
    y: float = 1.0
    z: float = 1.0


@dataclass
class FovLayout:
    index: int
    files: dict  # (t, c, z) -> Path


@dataclass
class WellLayout:
    row_name: str
    col_name: str
    row_index: int
    col_index: int
    fovs: list  # list[FovLayout]


@dataclass
class PlateLayout:
    name: str
    rows: list          # sorted row names e.g. ["A", "B"]
    columns: list       # sorted col names e.g. ["1", "2"]
    wells: list         # list[WellLayout]
    channels: int = 1
    timepoints: int = 1
    z_planes: int = 1
    image_width: int = 0
    image_height: int = 0
    voxel_size: VoxelSize = field(default_factory=VoxelSize)


@dataclass
class LevelSpec:
    width: int
    height: int
    depth: int
    scale: list         # [x, y, z] cumulative scale factors
    downsample_xy: bool
    downsample_z: bool


# ---------------------------------------------------------------------------
# Plate scanning
# ---------------------------------------------------------------------------

HCS_PATTERN = re.compile(
    r"(?i)r(\d+)c(\d+)f(\d+)p(\d+)-ch(\d+)t(\d+)\.tiff?$"
)


def row_number_to_letter(n: int) -> str:
    """Convert 1-indexed row number to letter (1->A, 26->Z, 27->R27)."""
    if 1 <= n <= 26:
        return chr(ord("A") + n - 1)
    return f"R{n}"


def read_tiff_info(path: Path) -> tuple[int, int, VoxelSize]:
    """Read dimensions and voxel size from first TIFF."""
    with tifffile.TiffFile(str(path)) as tif:
        page = tif.pages[0]
        w, h = page.imagewidth, page.imagelength

        voxel = VoxelSize()
        # Try to get resolution from TIFF tags
        res_unit = page.tags.get("ResolutionUnit")
        x_res = page.tags.get("XResolution")
        y_res = page.tags.get("YResolution")

        if x_res is not None and y_res is not None:
            # Resolution values are (numerator, denominator) tuples
            xr = x_res.value
            yr = y_res.value
            if isinstance(xr, tuple):
                xr = xr[0] / xr[1] if xr[1] != 0 else xr[0]
            if isinstance(yr, tuple):
                yr = yr[0] / yr[1] if yr[1] != 0 else yr[0]

            unit = res_unit.value if res_unit is not None else 1
            if unit == 2 and xr > 0 and yr > 0:  # inch
                voxel.x = 25400.0 / xr
                voxel.y = 25400.0 / yr
            elif unit == 3 and xr > 0 and yr > 0:  # cm
                voxel.x = 10000.0 / xr
                voxel.y = 10000.0 / yr

        return w, h, voxel


def scan_plate_directory(input_dir: Path) -> PlateLayout:
    """Scan directory for HCS TIFFs and build plate layout."""
    # Collect all matching files
    entries = []
    for root, _dirs, files in os.walk(input_dir):
        for fname in files:
            m = HCS_PATTERN.search(fname)
            if m:
                row, col, fov, plane, ch, tp = (int(x) for x in m.groups())
                entries.append((
                    row, col, fov - 1,  # FOV 0-indexed
                    plane, ch, tp,
                    Path(root) / fname,
                ))

    if not entries:
        raise ValueError(f"No HCS TIFF files found in {input_dir}")

    print(f"Found {len(entries)} HCS TIFF files")

    # Discover plate dimensions
    all_rows = sorted(set(e[0] for e in entries))
    all_cols = sorted(set(e[1] for e in entries))
    max_channels = max(e[4] for e in entries)
    max_timepoints = max(e[5] for e in entries)
    max_z = max(e[3] for e in entries)

    row_names = [row_number_to_letter(r) for r in all_rows]
    col_names = [str(c) for c in all_cols]

    row_index_map = {r: i for i, r in enumerate(all_rows)}
    col_index_map = {c: i for i, c in enumerate(all_cols)}

    # Group by (row, col, fov)
    grouped: dict[tuple[int, int, int], dict[tuple[int, int, int], Path]] = defaultdict(dict)
    for row, col, fov, plane, ch, tp, path in entries:
        grouped[(row, col, fov)][(tp, ch, plane)] = path

    # Build well layouts
    wells_by_rc: dict[tuple[int, int], list[FovLayout]] = defaultdict(list)
    for (row, col, fov_idx), file_map in grouped.items():
        wells_by_rc[(row, col)].append(FovLayout(index=fov_idx, files=file_map))

    wells = []
    for (row, col), fovs in sorted(wells_by_rc.items()):
        fovs.sort(key=lambda f: f.index)
        wells.append(WellLayout(
            row_name=row_number_to_letter(row),
            col_name=str(col),
            row_index=row_index_map[row],
            col_index=col_index_map[col],
            fovs=fovs,
        ))

    # Read image dimensions from first file
    first_path = entries[0][6]
    img_w, img_h, voxel = read_tiff_info(first_path)

    layout = PlateLayout(
        name=input_dir.name,
        rows=row_names,
        columns=col_names,
        wells=wells,
        channels=max_channels,
        timepoints=max_timepoints,
        z_planes=max_z,
        image_width=img_w,
        image_height=img_h,
        voxel_size=voxel,
    )

    print(f"Plate: {layout.name}")
    print(f"  Rows: {layout.rows}, Columns: {layout.columns}")
    print(f"  Wells: {len(layout.wells)}")
    print(f"  Channels: {layout.channels}, Timepoints: {layout.timepoints}, Z: {layout.z_planes}")
    print(f"  Image: {layout.image_width}x{layout.image_height}")
    print(f"  Voxel: {layout.voxel_size.x:.4f} x {layout.voxel_size.y:.4f} x {layout.voxel_size.z:.4f} µm")

    return layout


# ---------------------------------------------------------------------------
# FOV TIFF reading
# ---------------------------------------------------------------------------

def read_fov_tiffs(
    fov: FovLayout,
    channels: int,
    timepoints: int,
    z_planes: int,
    width: int,
    height: int,
) -> np.ndarray:
    """Read all TIFFs for a single FOV into a 5D TCZYX uint16 array."""
    volume = np.zeros((timepoints, channels, z_planes, height, width), dtype=np.uint16)

    for (t, c, z), path in fov.files.items():
        # Convert from 1-indexed to 0-indexed
        ti, ci, zi = t - 1, c - 1, z - 1
        if ti >= timepoints or ci >= channels or zi >= z_planes:
            continue

        img = tifffile.imread(str(path))
        if img.dtype == np.uint8:
            img = (img.astype(np.uint16) * 257)  # 0..255 -> 0..65535
        elif img.dtype != np.uint16:
            raise ValueError(f"Unsupported dtype {img.dtype} in {path}")

        if img.shape != (height, width):
            raise ValueError(
                f"Dimension mismatch in {path}: expected {height}x{width}, "
                f"got {img.shape[0]}x{img.shape[1]}"
            )

        volume[ti, ci, zi] = img

    return volume


# ---------------------------------------------------------------------------
# Pyramid downsampling
# ---------------------------------------------------------------------------

def downsample_xy(data: np.ndarray) -> np.ndarray:
    """2x box-average downsample in XY only. Input shape: (T, C, Z, Y, X)."""
    t, c, z, h, w = data.shape
    nh, nw = (h + 1) // 2, (w + 1) // 2
    out = np.zeros((t, c, z, nh, nw), dtype=np.uint16)

    # Crop to even dimensions for bulk averaging
    eh, ew = h & ~1, w & ~1
    if eh > 0 and ew > 0:
        block = data[:, :, :, :eh, :ew].reshape(t, c, z, eh // 2, 2, ew // 2, 2)
        out[:, :, :, :eh // 2, :ew // 2] = block.mean(axis=(4, 6)).astype(np.uint16)

    # Right edge (odd width)
    if w & 1:
        out[:, :, :, :eh // 2, -1] = data[:, :, :, :eh:2, -1:].mean(axis=-1).reshape(
            t, c, z, max(eh // 2, 1)
        )[:, :, :, :eh // 2].astype(np.uint16) if eh > 0 else 0

    # Bottom edge (odd height)
    if h & 1:
        out[:, :, :, -1, :ew // 2] = data[:, :, :, -1:, :ew:2].mean(axis=-2).reshape(
            t, c, z, max(ew // 2, 1)
        )[:, :, :, :ew // 2].astype(np.uint16) if ew > 0 else 0

    # Corner (odd width and height)
    if (w & 1) and (h & 1):
        out[:, :, :, -1, -1] = data[:, :, :, -1, -1]

    return out


def downsample_z_only(data: np.ndarray) -> np.ndarray:
    """2x box-average downsample in Z only. Input shape: (T, C, Z, Y, X)."""
    t, c, z, h, w = data.shape
    nz = (z + 1) // 2
    out = np.zeros((t, c, nz, h, w), dtype=np.uint16)

    ez = z & ~1
    if ez > 0:
        block = data[:, :, :ez].reshape(t, c, ez // 2, 2, h, w)
        out[:, :, :ez // 2] = block.mean(axis=3).astype(np.uint16)

    if z & 1:
        out[:, :, -1] = data[:, :, -1]

    return out


def downsample_xyz(data: np.ndarray) -> np.ndarray:
    """2x box-average downsample in XYZ. Input shape: (T, C, Z, Y, X)."""
    # Downsample XY first, then Z
    xy = downsample_xy(data)
    return downsample_z_only(xy)


def compute_downsample_schedule(
    w: int, h: int, d: int, voxel: VoxelSize, min_size: int
) -> list[LevelSpec]:
    """Compute anisotropy-aware downsample schedule."""
    levels = [LevelSpec(
        width=w, height=h, depth=d,
        scale=[voxel.x, voxel.y, voxel.z],
        downsample_xy=False, downsample_z=False,
    )]

    cum_sx, cum_sy, cum_sz = 1.0, 1.0, 1.0
    cw, ch, cd = w, h, d

    while True:
        eff_x = voxel.x * cum_sx
        eff_y = voxel.y * cum_sy
        eff_z = voxel.z * cum_sz
        max_eff = max(eff_x, eff_y, eff_z)

        # Determine which axes are uniquely coarsest
        z_uniquely_coarsest = (eff_z == max_eff and eff_x < max_eff and eff_y < max_eff)
        x_uniquely_coarsest = (eff_x == max_eff and eff_y < max_eff and eff_z < max_eff)
        y_uniquely_coarsest = (eff_y == max_eff and eff_x < max_eff and eff_z < max_eff)

        can_xy = cw > min_size or ch > min_size
        can_z = cd > min_size

        # Skip rules
        do_xy = can_xy
        do_z = can_z

        if z_uniquely_coarsest and can_xy:
            do_z = False
        if (x_uniquely_coarsest or y_uniquely_coarsest) and can_z:
            do_xy = False

        if not do_xy and not do_z:
            break

        nw = (cw + 1) // 2 if do_xy else cw
        nh = (ch + 1) // 2 if do_xy else ch
        nd = (cd + 1) // 2 if do_z else cd

        if do_xy:
            cum_sx *= 2.0
            cum_sy *= 2.0
        if do_z:
            cum_sz *= 2.0

        levels.append(LevelSpec(
            width=nw, height=nh, depth=nd,
            scale=[voxel.x * cum_sx, voxel.y * cum_sy, voxel.z * cum_sz],
            downsample_xy=do_xy, downsample_z=do_z,
        ))

        cw, ch, cd = nw, nh, nd

    return levels


def apply_downsample(data: np.ndarray, spec: LevelSpec) -> np.ndarray:
    """Apply downsampling according to a LevelSpec."""
    if spec.downsample_xy and spec.downsample_z:
        return downsample_xyz(data)
    elif spec.downsample_xy:
        return downsample_xy(data)
    elif spec.downsample_z:
        return downsample_z_only(data)
    else:
        raise ValueError("LevelSpec has no downsampling flags set")


# ---------------------------------------------------------------------------
# OME-Zarr metadata builders
# ---------------------------------------------------------------------------

def build_plate_metadata(layout: PlateLayout) -> dict:
    """Build root plate zarr.json."""
    field_count = max(len(w.fovs) for w in layout.wells) if layout.wells else 0

    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "plate": {
                    "version": "0.5",
                    "name": layout.name,
                    "rows": [{"name": r} for r in layout.rows],
                    "columns": [{"name": c} for c in layout.columns],
                    "wells": [
                        {
                            "path": f"{w.row_name}/{w.col_name}",
                            "rowIndex": w.row_index,
                            "columnIndex": w.col_index,
                        }
                        for w in layout.wells
                    ],
                    "field_count": field_count,
                },
            }
        },
    }


def build_well_metadata(well: WellLayout) -> dict:
    """Build well-level zarr.json."""
    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "well": {
                    "images": [{"path": str(fov.index)} for fov in well.fovs],
                },
            }
        },
    }


def build_group_metadata() -> dict:
    """Build a plain Zarr v3 group (for row directories)."""
    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {},
    }


def build_multiscales_metadata(
    levels: list[LevelSpec], voxel: VoxelSize
) -> dict:
    """Build FOV-level zarr.json with OME multiscales."""
    datasets = []
    for i, lvl in enumerate(levels):
        datasets.append({
            "path": str(i),
            "coordinateTransformations": [
                {
                    "type": "scale",
                    "scale": [1.0, 1.0, lvl.scale[2], lvl.scale[1], lvl.scale[0]],
                }
            ],
        })

    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "multiscales": [
                    {
                        "version": "0.5",
                        "name": "image",
                        "axes": [
                            {"name": "t", "type": "time", "unit": "second"},
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space", "unit": "micrometer"},
                            {"name": "y", "type": "space", "unit": "micrometer"},
                            {"name": "x", "type": "space", "unit": "micrometer"},
                        ],
                        "datasets": datasets,
                        "type": "2x2 box average",
                    }
                ],
            }
        },
    }


def build_array_metadata(
    shape: tuple[int, ...],
    chunk_shape: tuple[int, ...],
) -> dict:
    """Build Zarr v3 array metadata for a single pyramid level."""
    return {
        "zarr_format": 3,
        "node_type": "array",
        "shape": list(shape),
        "data_type": "uint16",
        "chunk_grid": {
            "name": "regular",
            "configuration": {
                "chunk_shape": list(chunk_shape),
            },
        },
        "chunk_key_encoding": {
            "name": "default",
            "configuration": {"separator": "/"},
        },
        "fill_value": 0,
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "numcodecs/lz4", "configuration": {"acceleration": 1}},
        ],
        "dimension_names": ["t", "c", "z", "y", "x"],
        "attributes": {},
    }


# ---------------------------------------------------------------------------
# Zarr chunk writing
# ---------------------------------------------------------------------------

def write_json(path: Path, data: dict):
    """Write a JSON file, creating parent dirs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def extract_and_compress_chunk(
    volume: np.ndarray,
    t: int, c: int, z_start: int, y_start: int, x_start: int,
    cz: int, cy: int, cx: int,
) -> bytes:
    """Extract a chunk from the volume and LZ4-compress it."""
    _t, _c, depth, height, width = volume.shape

    # Slice with clamping
    z_end = min(z_start + cz, depth)
    y_end = min(y_start + cy, height)
    x_end = min(x_start + cx, width)

    chunk = volume[t, c, z_start:z_end, y_start:y_end, x_start:x_end]

    # Zero-pad if at edge
    if chunk.shape != (cz, cy, cx):
        padded = np.zeros((cz, cy, cx), dtype=np.uint16)
        padded[:chunk.shape[0], :chunk.shape[1], :chunk.shape[2]] = chunk
        chunk = padded

    # Ensure contiguous little-endian
    chunk = np.ascontiguousarray(chunk)
    raw = chunk.tobytes()

    # LZ4 compress with prepended uncompressed size (4-byte LE)
    compressed = lz4.block.compress(raw, store_size=False)
    return struct.pack("<I", len(raw)) + compressed


def write_chunks(
    volume: np.ndarray,
    level_dir: Path,
    chunk_xy: int,
    chunk_z: int,
):
    """Write all chunks for a pyramid level."""
    t_dim, c_dim, z_dim, h_dim, w_dim = volume.shape

    chunk_shape = (1, 1, min(chunk_z, z_dim), min(chunk_xy, h_dim), min(chunk_xy, w_dim))
    cz, cy, cx = chunk_shape[2], chunk_shape[3], chunk_shape[4]

    # Write array metadata
    write_json(
        level_dir / "zarr.json",
        build_array_metadata(volume.shape, chunk_shape),
    )

    # Pre-create chunk directories
    tasks = []
    for ti in range(t_dim):
        for ci in range(c_dim):
            for zi in range(0, z_dim, cz):
                for yi in range(0, h_dim, cy):
                    for xi in range(0, w_dim, cx):
                        chunk_path = level_dir / "c" / str(ti) / str(ci) / str(
                            zi // cz
                        ) / str(yi // cy) / str(xi // cx)
                        tasks.append((ti, ci, zi, yi, xi, chunk_path))

    total = len(tasks)
    written = 0

    def write_one(task):
        ti, ci, zi, yi, xi, chunk_path = task
        data = extract_and_compress_chunk(volume, ti, ci, zi, yi, xi, cz, cy, cx)
        chunk_path.parent.mkdir(parents=True, exist_ok=True)
        with open(chunk_path, "wb") as f:
            f.write(data)

    with ThreadPoolExecutor() as pool:
        futures = {pool.submit(write_one, task): task for task in tasks}
        for future in as_completed(futures):
            future.result()  # Raise if error
            written += 1
            if written % 100 == 0 or written == total:
                print(f"    Chunks: {written}/{total}")


# ---------------------------------------------------------------------------
# Main conversion pipeline
# ---------------------------------------------------------------------------

def convert_plate_to_zarr(
    input_dir: Path,
    output_dir: Path,
    chunk_xy: int = 256,
    chunk_z: int = 64,
    voxel_override: Optional[VoxelSize] = None,
    min_size: int = 256,
):
    """Convert an HCS plate directory to OME-Zarr v0.5."""
    # 1. Scan plate
    layout = scan_plate_directory(input_dir)

    # Apply voxel overrides
    if voxel_override:
        if voxel_override.x != 1.0:
            layout.voxel_size.x = voxel_override.x
        if voxel_override.y != 1.0:
            layout.voxel_size.y = voxel_override.y
        if voxel_override.z != 1.0:
            layout.voxel_size.z = voxel_override.z

    # 2. Write plate metadata
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "zarr.json", build_plate_metadata(layout))

    # 3. Write row group metadata
    for row_name in layout.rows:
        write_json(output_dir / row_name / "zarr.json", build_group_metadata())

    # 4. Process each well
    for well_idx, well in enumerate(layout.wells):
        well_dir = output_dir / well.row_name / well.col_name
        write_json(well_dir / "zarr.json", build_well_metadata(well))

        print(f"\nWell {well.row_name}/{well.col_name} ({well_idx + 1}/{len(layout.wells)})")

        # 5. Process each FOV in the well
        for fov in well.fovs:
            print(f"  FOV {fov.index} ({len(fov.files)} files)")

            # Read all TIFFs into 5D volume
            volume = read_fov_tiffs(
                fov,
                layout.channels,
                layout.timepoints,
                layout.z_planes,
                layout.image_width,
                layout.image_height,
            )

            # Compute downsample schedule
            levels = compute_downsample_schedule(
                layout.image_width,
                layout.image_height,
                layout.z_planes,
                layout.voxel_size,
                min_size,
            )

            print(f"    Pyramid: {len(levels)} levels")

            # Write FOV multiscales metadata
            fov_dir = well_dir / str(fov.index)
            write_json(fov_dir / "zarr.json", build_multiscales_metadata(levels, layout.voxel_size))

            # Write each pyramid level
            current = volume
            for level_idx, level in enumerate(levels):
                print(f"    Level {level_idx}: {level.width}x{level.height}x{level.depth}")

                level_dir = fov_dir / str(level_idx)
                write_chunks(current, level_dir, chunk_xy, chunk_z)

                # Downsample for next level (if not the last)
                if level_idx + 1 < len(levels):
                    next_level = levels[level_idx + 1]
                    current = apply_downsample(current, next_level)

            del volume, current  # Free memory

    print(f"\nDone. Output: {output_dir}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Convert HCS plate TIFFs to OME-Zarr v0.5",
    )
    parser.add_argument("input_dir", type=Path, help="Directory containing HCS TIFFs")
    parser.add_argument("output_zarr", type=Path, help="Output .zarr directory")
    parser.add_argument("--chunk-xy", type=int, default=256, help="XY chunk size (default: 256)")
    parser.add_argument("--chunk-z", type=int, default=64, help="Z chunk size (default: 64)")
    parser.add_argument("--voxel-x", type=float, default=None, help="Override voxel X (µm)")
    parser.add_argument("--voxel-y", type=float, default=None, help="Override voxel Y (µm)")
    parser.add_argument("--voxel-z", type=float, default=None, help="Override voxel Z (µm)")
    parser.add_argument("--min-size", type=int, default=256, help="Minimum pyramid dimension (default: 256)")

    args = parser.parse_args()

    if not args.input_dir.is_dir():
        print(f"Error: {args.input_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    voxel_override = None
    if any(v is not None for v in [args.voxel_x, args.voxel_y, args.voxel_z]):
        voxel_override = VoxelSize(
            x=args.voxel_x or 1.0,
            y=args.voxel_y or 1.0,
            z=args.voxel_z or 1.0,
        )

    convert_plate_to_zarr(
        input_dir=args.input_dir,
        output_dir=args.output_zarr,
        chunk_xy=args.chunk_xy,
        chunk_z=args.chunk_z,
        voxel_override=voxel_override,
        min_size=args.min_size,
    )


if __name__ == "__main__":
    main()
