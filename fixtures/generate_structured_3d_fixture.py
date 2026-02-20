#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path


SIZE = 128


def write_root_zattrs(root: Path) -> None:
    root_attrs = {
        "multiscales": [
            {
                "version": "0.5",
                "name": "structured-3d",
                "axes": [
                    {"name": "t", "type": "time", "unit": "second"},
                    {"name": "c", "type": "channel"},
                    {"name": "z", "type": "space", "unit": "micrometer"},
                    {"name": "y", "type": "space", "unit": "micrometer"},
                    {"name": "x", "type": "space", "unit": "micrometer"},
                ],
                "datasets": [
                    {
                        "path": "0",
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1.0, 1.0, 1.0, 1.0, 1.0]}
                        ],
                    }
                ],
            }
        ]
    }
    (root / ".zattrs").write_text(json.dumps(root_attrs, indent=2) + "\n", encoding="utf-8")


def write_array_metadata(root: Path) -> None:
    array_path = root / "0"
    array_path.mkdir(parents=True, exist_ok=True)
    zarray = {
        "zarr_format": 2,
        "shape": [1, 1, SIZE, SIZE, SIZE],
        "chunks": [1, 1, 1, SIZE, SIZE],
        "dtype": "<u2",
        "compressor": None,
        "fill_value": 0,
        "order": "C",
        "filters": None,
        "dimension_separator": "/",
    }
    (array_path / ".zarray").write_text(json.dumps(zarray, indent=2) + "\n", encoding="utf-8")
    (array_path / ".zattrs").write_text(
        json.dumps({"_ARRAY_DIMENSIONS": ["t", "c", "z", "y", "x"]}, indent=2) + "\n",
        encoding="utf-8",
    )


def clamp_u16(value: float) -> int:
    if value <= 0:
        return 0
    if value >= 65535:
        return 65535
    return int(round(value))


def sphere_intensity(x: int, y: int, z: int, cx: float, cy: float, cz: float, radius: float, amp: float) -> float:
    dx = x - cx
    dy = y - cy
    dz = z - cz
    dist2 = dx * dx + dy * dy + dz * dz
    radius2 = radius * radius
    if dist2 >= radius2:
        return 0.0
    falloff = 1.0 - dist2 / radius2
    return amp * falloff * falloff


def tube_intensity(
    x: int,
    y: int,
    z: int,
    ax: float,
    ay: float,
    az: float,
    bx: float,
    by: float,
    bz: float,
    radius: float,
    amp: float,
) -> float:
    abx = bx - ax
    aby = by - ay
    abz = bz - az
    apx = x - ax
    apy = y - ay
    apz = z - az
    ab2 = abx * abx + aby * aby + abz * abz
    if ab2 <= 1e-8:
        return 0.0
    t = (apx * abx + apy * aby + apz * abz) / ab2
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    qx = ax + abx * t
    qy = ay + aby * t
    qz = az + abz * t
    dx = x - qx
    dy = y - qy
    dz = z - qz
    dist2 = dx * dx + dy * dy + dz * dz
    radius2 = radius * radius
    if dist2 >= radius2:
        return 0.0
    falloff = 1.0 - dist2 / radius2
    return amp * falloff * falloff


def structured_voxel(x: int, y: int, z: int) -> int:
    base = 1200.0 + (z / (SIZE - 1)) * 900.0

    cells = [
        (36.0, 36.0, 34.0, 16.0, 46000.0),
        (83.0, 45.0, 58.0, 19.0, 52000.0),
        (57.0, 86.0, 82.0, 22.0, 50000.0),
        (94.0, 94.0, 36.0, 14.0, 43000.0),
        (27.0, 92.0, 96.0, 13.0, 41000.0),
    ]
    tubes = [
        (18.0, 20.0, 18.0, 110.0, 108.0, 110.0, 6.5, 36000.0),
        (15.0, 110.0, 70.0, 114.0, 20.0, 56.0, 4.5, 30000.0),
        (66.0, 16.0, 12.0, 61.0, 112.0, 118.0, 5.0, 34000.0),
    ]

    value = base
    for cx, cy, cz, radius, amp in cells:
        value = max(value, sphere_intensity(x, y, z, cx, cy, cz, radius, amp))
    for ax, ay, az, bx, by, bz, radius, amp in tubes:
        value = max(value, tube_intensity(x, y, z, ax, ay, az, bx, by, bz, radius, amp))

    ripple = (
        math.sin((x + z) * 0.11) * math.cos((y - z) * 0.09) + math.sin((x + y) * 0.05)
    ) * 420.0
    value += ripple + 1800.0

    return clamp_u16(value)


def write_chunks(root: Path) -> None:
    for z in range(SIZE):
        chunk_dir = root / "0" / "0" / "0" / str(z) / "0"
        chunk_dir.mkdir(parents=True, exist_ok=True)
        chunk_path = chunk_dir / "0"

        plane = bytearray(SIZE * SIZE * 2)
        offset = 0
        for y in range(SIZE):
            for x in range(SIZE):
                value = structured_voxel(x, y, z)
                plane[offset] = value & 0xFF
                plane[offset + 1] = (value >> 8) & 0xFF
                offset += 2

        chunk_path.write_bytes(plane)


def generate(output_dir: Path) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    write_root_zattrs(output_dir)
    write_array_metadata(output_dir)
    write_chunks(output_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate deterministic structured OME-Zarr 0.5 fixture")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "ome_zarr_v05_structured_3d",
        help="Output fixture directory",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    generate(args.output)


if __name__ == "__main__":
    main()
