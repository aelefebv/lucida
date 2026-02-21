#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_plane(path: Path, width: int, height: int, fn) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = bytearray(width * height * 2)
    offset = 0
    for y in range(height):
        for x in range(width):
            value = max(0, min(65535, int(round(fn(x, y)))))
            blob[offset] = value & 0xFF
            blob[offset + 1] = (value >> 8) & 0xFF
            offset += 2
    path.write_bytes(blob)


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def generate_axis_remap_fixture() -> None:
    root = ROOT / "ome_zarr_v05_axis_remap"
    reset_dir(root)

    write_json(
        root / ".zattrs",
        {
            "multiscales": [
                {
                    "version": "0.5",
                    "name": "axis-remap",
                    "axes": [
                        {"name": "z", "type": "space", "unit": "micrometer"},
                        {"name": "y", "type": "space", "unit": "micrometer"},
                        {"name": "x", "type": "space", "unit": "micrometer"},
                        {"name": "channel", "type": "channel"},
                    ],
                    "datasets": [
                        {
                            "path": "0",
                            "coordinateTransformations": [
                                {"type": "scale", "scale": [1.8, 0.5, 0.5, 1.0]}
                            ],
                        }
                    ],
                }
            ]
        },
    )

    write_json(
        root / "0" / ".zarray",
        {
            "zarr_format": 2,
            "shape": [4, 8, 8, 2],
            "chunks": [1, 8, 8, 1],
            "dtype": "<u2",
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": "/",
        },
    )
    write_json(root / "0" / ".zattrs", {"_ARRAY_DIMENSIONS": ["z", "y", "x", "channel"]})

    for z in range(4):
        for c in range(2):
            write_plane(
                root / "0" / str(z) / "0" / "0" / str(c),
                width=8,
                height=8,
                fn=lambda x, y, z=z, c=c: 500 + z * 1000 + c * 7000 + y * 16 + x,
            )


def structured_value(x: int, y: int, z: int, size: int) -> int:
    cx = size * 0.35
    cy = size * 0.4
    cz = size * 0.45
    r = size * 0.22

    dx = x - cx
    dy = y - cy
    dz = z - cz
    dist2 = dx * dx + dy * dy + dz * dz
    value = 400.0 + z * 20.0

    if dist2 < r * r:
        falloff = 1.0 - dist2 / (r * r)
        value = max(value, 46000.0 * falloff * falloff)

    # tube
    ax, ay, az = size * 0.1, size * 0.8, size * 0.15
    bx, by, bz = size * 0.85, size * 0.2, size * 0.8
    abx, aby, abz = bx - ax, by - ay, bz - az
    apx, apy, apz = x - ax, y - ay, z - az
    ab2 = abx * abx + aby * aby + abz * abz
    t = 0.0 if ab2 < 1e-8 else max(0.0, min(1.0, (apx * abx + apy * aby + apz * abz) / ab2))
    qx, qy, qz = ax + abx * t, ay + aby * t, az + abz * t
    tx, ty, tz = x - qx, y - qy, z - qz
    tube_dist2 = tx * tx + ty * ty + tz * tz
    tube_r = size * 0.09
    if tube_dist2 < tube_r * tube_r:
        falloff = 1.0 - tube_dist2 / (tube_r * tube_r)
        value = max(value, 36000.0 * falloff * falloff)

    ripple = (
        math.sin((x + z) * 0.27) * math.cos((y - z) * 0.21)
        + math.sin((x + y) * 0.11)
    ) * 600.0
    value += ripple + 1200.0
    return int(max(0, min(65535, round(value))))


def generate_small_3d_fixture(name: str, scale_zyx: tuple[float, float, float]) -> None:
    size = 32
    root = ROOT / name
    reset_dir(root)

    write_json(
        root / ".zattrs",
        {
            "multiscales": [
                {
                    "version": "0.5",
                    "name": name,
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
                                {
                                    "type": "scale",
                                    "scale": [1.0, 1.0, scale_zyx[0], scale_zyx[1], scale_zyx[2]],
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )

    write_json(
        root / "0" / ".zarray",
        {
            "zarr_format": 2,
            "shape": [1, 1, size, size, size],
            "chunks": [1, 1, 1, size, size],
            "dtype": "<u2",
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": "/",
        },
    )
    write_json(root / "0" / ".zattrs", {"_ARRAY_DIMENSIONS": ["t", "c", "z", "y", "x"]})

    for z in range(size):
        write_plane(
            root / "0" / "0" / "0" / str(z) / "0" / "0",
            width=size,
            height=size,
            fn=lambda x, y, z=z: structured_value(x, y, z, size),
        )


def generate_v04_smoke_fixture() -> None:
    root = ROOT / "ome_zarr_v04_smoke"
    reset_dir(root)

    write_json(
        root / ".zattrs",
        {
            "multiscales": [
                {
                    "version": "0.4",
                    "name": "v04-smoke",
                    "axes": ["z", "y", "x"],
                    "datasets": [{"path": "0"}],
                }
            ]
        },
    )

    write_json(
        root / "0" / ".zarray",
        {
            "zarr_format": 2,
            "shape": [6, 16, 16],
            "chunks": [1, 16, 16],
            "dtype": "<u2",
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": "/",
        },
    )

    for z in range(6):
        write_plane(
            root / "0" / str(z) / "0" / "0",
            width=16,
            height=16,
            fn=lambda x, y, z=z: z * 1500 + y * 32 + x,
        )


def tc_structured_value(x: int, y: int, z: int, size: int, t: int, c: int) -> int:
    # Deterministic per-(t,c) scene shifts so axis scrubbing is obvious in 3D.
    sx = (x + t * 3 + c * 2) % size
    sy = (y + c * 4 + t) % size
    sz = (z + t * 2 - c) % size
    value = structured_value(sx, sy, sz, size)
    value += t * 1400 + c * 900
    return int(max(0, min(65535, value)))


def generate_tc_3d_fixture() -> None:
    size = 24
    t_size = 3
    c_size = 3
    root = ROOT / "ome_zarr_v05_tc_3d"
    reset_dir(root)

    write_json(
        root / ".zattrs",
        {
            "multiscales": [
                {
                    "version": "0.5",
                    "name": "tc-3d",
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
                                {"type": "scale", "scale": [1.0, 1.0, 1.6, 1.0, 1.0]}
                            ],
                        }
                    ],
                }
            ]
        },
    )

    write_json(
        root / "0" / ".zarray",
        {
            "zarr_format": 2,
            "shape": [t_size, c_size, size, size, size],
            "chunks": [1, 1, 1, size, size],
            "dtype": "<u2",
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": "/",
        },
    )
    write_json(
        root / "0" / ".zattrs",
        {"_ARRAY_DIMENSIONS": ["t", "c", "z", "y", "x"]},
    )

    for t in range(t_size):
        for c in range(c_size):
            for z in range(size):
                write_plane(
                    root / "0" / str(t) / str(c) / str(z) / "0" / "0",
                    width=size,
                    height=size,
                    fn=lambda x, y, z=z, t=t, c=c: tc_structured_value(x, y, z, size, t, c),
                )


def main() -> None:
    generate_axis_remap_fixture()
    generate_small_3d_fixture("ome_zarr_v05_anisotropic_3d", scale_zyx=(3.0, 1.0, 0.6))
    generate_small_3d_fixture("ome_zarr_v05_isotropic_3d", scale_zyx=(1.0, 1.0, 1.0))
    generate_v04_smoke_fixture()
    generate_tc_3d_fixture()


if __name__ == "__main__":
    main()
