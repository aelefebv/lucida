#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class BigFixtureConfig:
    t: int
    c: int
    z: int
    y: int
    x: int
    chunk_z: int
    chunk_y: int
    chunk_x: int
    scale_z: float
    scale_y: float
    scale_x: float


@dataclass(frozen=True)
class ChunkTask:
    t_idx: int
    c_idx: int
    z_chunk: int
    y_chunk: int
    x_chunk: int
    z_start: int
    y_start: int
    x_start: int
    z_extent: int
    y_extent: int
    x_extent: int


def div_ceil(numer: int, denom: int) -> int:
    return (numer + denom - 1) // denom


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a large deterministic OME-Zarr v0.5 fixture with many chunk files. "
            "Current Lucida storage path expects t/c chunks of 1 and supports chunked z/y/x assembly."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/tmp/lucida_ome_zarr_v05_big_tc_3d"),
        help="Output fixture directory",
    )
    parser.add_argument("--t", type=int, default=4, help="t axis size")
    parser.add_argument("--c", type=int, default=4, help="c axis size")
    parser.add_argument("--z", type=int, default=320, help="z axis size")
    parser.add_argument("--y", type=int, default=128, help="y axis size")
    parser.add_argument("--x", type=int, default=128, help="x axis size")
    parser.add_argument("--chunk-z", type=int, default=50, help="z chunk size")
    parser.add_argument("--chunk-y", type=int, default=50, help="y chunk size")
    parser.add_argument("--chunk-x", type=int, default=50, help="x chunk size")
    parser.add_argument("--scale-z", type=float, default=2.4, help="z physical scale")
    parser.add_argument("--scale-y", type=float, default=1.0, help="y physical scale")
    parser.add_argument("--scale-x", type=float, default=1.0, help="x physical scale")
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, (os_cpu_count() or 1) - 1),
        help="Chunk writer worker threads (default: cpu_count-1)",
    )
    parser.add_argument(
        "--queue-factor",
        type=int,
        default=4,
        help="In-flight task multiplier for worker queue (default: 4)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite output directory if it already exists",
    )
    return parser.parse_args()


def os_cpu_count() -> int:
    try:
        import os

        return os.cpu_count() or 1
    except Exception:
        return 1


def validate_config(cfg: BigFixtureConfig, workers: int, queue_factor: int) -> None:
    for name, value in [
        ("t", cfg.t),
        ("c", cfg.c),
        ("z", cfg.z),
        ("y", cfg.y),
        ("x", cfg.x),
        ("chunk_z", cfg.chunk_z),
        ("chunk_y", cfg.chunk_y),
        ("chunk_x", cfg.chunk_x),
        ("workers", workers),
        ("queue_factor", queue_factor),
    ]:
        if value <= 0:
            raise SystemExit(f"{name} must be > 0")
    for name, value in [
        ("scale_z", cfg.scale_z),
        ("scale_y", cfg.scale_y),
        ("scale_x", cfg.scale_x),
    ]:
        if not math.isfinite(value) or value <= 0:
            raise SystemExit(f"{name} must be finite and > 0")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def ensure_output_dir(output: Path, force: bool) -> None:
    if output.exists():
        if not force:
            raise SystemExit(
                f"output already exists: {output} (use --force to overwrite)"
            )
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)


def print_plan(output: Path, cfg: BigFixtureConfig, workers: int) -> None:
    z_chunks = div_ceil(cfg.z, cfg.chunk_z)
    y_chunks = div_ceil(cfg.y, cfg.chunk_y)
    x_chunks = div_ceil(cfg.x, cfg.chunk_x)
    chunks = cfg.t * cfg.c * z_chunks * y_chunks * x_chunks
    bytes_total = cfg.t * cfg.c * cfg.z * cfg.y * cfg.x * 2
    gib = bytes_total / (1024**3)

    print(f"output: {output}")
    print(f"shape: [t={cfg.t}, c={cfg.c}, z={cfg.z}, y={cfg.y}, x={cfg.x}]")
    print(
        f"chunks: [1,1,{cfg.chunk_z},{cfg.chunk_y},{cfg.chunk_x}] "
        f"=> [t={cfg.t}, c={cfg.c}, z={z_chunks}, y={y_chunks}, x={x_chunks}] => {chunks} chunk files"
    )
    print(f"approx raw data size: {gib:.2f} GiB")
    print(f"workers: {workers}")


def write_metadata(output: Path, cfg: BigFixtureConfig) -> None:
    write_json(
        output / ".zattrs",
        {
            "multiscales": [
                {
                    "version": "0.5",
                    "name": "big-tc-3d",
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
                                    "scale": [1.0, 1.0, cfg.scale_z, cfg.scale_y, cfg.scale_x],
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )

    write_json(
        output / "0" / ".zarray",
        {
            "zarr_format": 2,
            "shape": [cfg.t, cfg.c, cfg.z, cfg.y, cfg.x],
            "chunks": [1, 1, cfg.chunk_z, cfg.chunk_y, cfg.chunk_x],
            "dtype": "<u2",
            "compressor": None,
            "fill_value": 0,
            "order": "C",
            "filters": None,
            "dimension_separator": "/",
        },
    )

    write_json(
        output / "0" / ".zattrs",
        {"_ARRAY_DIMENSIONS": ["t", "c", "z", "y", "x"]},
    )


def _tc_shape_params(cfg: BigFixtureConfig, t_idx: int, c_idx: int) -> dict[str, float]:
    cx1 = cfg.x * (0.28 + 0.12 * math.sin(0.7 * t_idx + 0.4 * c_idx))
    cy1 = cfg.y * (0.34 + 0.10 * math.cos(0.4 * t_idx + 0.8 * c_idx))
    cz1 = cfg.z * (0.42 + 0.18 * math.sin(0.2 * t_idx + 0.35 * c_idx))
    r1 = min(cfg.x, cfg.y, cfg.z) * (0.16 + 0.02 * ((t_idx + c_idx) % 3))

    cx2 = cfg.x * (0.66 + 0.09 * math.cos(0.5 * t_idx + 0.9 * c_idx))
    cy2 = cfg.y * (0.60 + 0.08 * math.sin(0.6 * t_idx + 0.3 * c_idx))
    cz2 = cfg.z * (0.58 + 0.16 * math.cos(0.17 * t_idx + 0.29 * c_idx))
    r2 = min(cfg.x, cfg.y, cfg.z) * (0.13 + 0.015 * ((2 * t_idx + c_idx) % 4))

    ax = cfg.x * (0.10 + 0.03 * t_idx)
    ay = cfg.y * (0.82 - 0.05 * c_idx)
    az = cfg.z * (0.12 + 0.02 * c_idx)
    bx = cfg.x * (0.88 - 0.02 * c_idx)
    by = cfg.y * (0.18 + 0.04 * t_idx)
    bz = cfg.z * (0.84 - 0.03 * t_idx)
    abx = bx - ax
    aby = by - ay
    abz = bz - az
    ab2 = abx * abx + aby * aby + abz * abz
    tube_r = min(cfg.x, cfg.y, cfg.z) * 0.08

    return {
        "cx1": cx1,
        "cy1": cy1,
        "cz1": cz1,
        "r1": r1,
        "cx2": cx2,
        "cy2": cy2,
        "cz2": cz2,
        "r2": r2,
        "ax": ax,
        "ay": ay,
        "az": az,
        "abx": abx,
        "aby": aby,
        "abz": abz,
        "ab2": ab2,
        "tube_r": tube_r,
    }


def make_chunk_blob_numpy(
    cfg: BigFixtureConfig,
    t_idx: int,
    c_idx: int,
    z_start: int,
    z_extent: int,
    y_start: int,
    y_extent: int,
    x_start: int,
    x_extent: int,
) -> bytes:
    p = _tc_shape_params(cfg, t_idx, c_idx)

    z = (z_start + np.arange(z_extent, dtype=np.float64))[:, None, None]
    y = (y_start + np.arange(y_extent, dtype=np.float64))[None, :, None]
    x = (x_start + np.arange(x_extent, dtype=np.float64))[None, None, :]

    zf = z / max(cfg.z - 1, 1)
    value = 250.0 + 700.0 * zf + float(t_idx) * 450.0 + float(c_idx) * 260.0

    dx1 = x - p["cx1"]
    dy1 = y - p["cy1"]
    dz1 = z - p["cz1"]
    d1 = dx1 * dx1 + dy1 * dy1 + dz1 * dz1
    r1_sq = p["r1"] * p["r1"]
    falloff1 = np.clip(1.0 - d1 / r1_sq, 0.0, 1.0)
    sphere1 = 48000.0 * falloff1 * falloff1
    value = np.maximum(value, sphere1)

    dx2 = x - p["cx2"]
    dy2 = y - p["cy2"]
    dz2 = z - p["cz2"]
    d2 = dx2 * dx2 + dy2 * dy2 + dz2 * dz2
    r2_sq = p["r2"] * p["r2"]
    falloff2 = np.clip(1.0 - d2 / r2_sq, 0.0, 1.0)
    sphere2 = 39000.0 * falloff2 * falloff2
    value = np.maximum(value, sphere2)

    if p["ab2"] > 1e-8:
        apx = x - p["ax"]
        apy = y - p["ay"]
        apz = z - p["az"]
        t_proj = np.clip(
            (apx * p["abx"] + apy * p["aby"] + apz * p["abz"]) / p["ab2"],
            0.0,
            1.0,
        )
        qx = p["ax"] + p["abx"] * t_proj
        qy = p["ay"] + p["aby"] * t_proj
        qz = p["az"] + p["abz"] * t_proj
        tx = x - qx
        ty = y - qy
        tz = z - qz
        td2 = tx * tx + ty * ty + tz * tz
        tube_r2 = p["tube_r"] * p["tube_r"]
        falloff_t = np.clip(1.0 - td2 / tube_r2, 0.0, 1.0)
        tube = 34000.0 * falloff_t * falloff_t
        value = np.maximum(value, tube)

    ripple = (
        np.sin((x + z + 7.0 * float(t_idx)) * 0.09)
        + np.cos((y - z + 11.0 * float(c_idx)) * 0.08)
    ) * 420.0
    value = value + ripple + 1100.0

    clipped = np.clip(value, 0.0, 65535.0).astype(np.dtype("<u2"), copy=False)
    return clipped.tobytes(order="C")


def iter_chunk_tasks(cfg: BigFixtureConfig) -> tuple[list[ChunkTask], int, int, int]:
    z_chunk_count = div_ceil(cfg.z, cfg.chunk_z)
    y_chunk_count = div_ceil(cfg.y, cfg.chunk_y)
    x_chunk_count = div_ceil(cfg.x, cfg.chunk_x)
    tasks: list[ChunkTask] = []
    for t_idx in range(cfg.t):
        for c_idx in range(cfg.c):
            for z_chunk in range(z_chunk_count):
                z_start = z_chunk * cfg.chunk_z
                z_extent = min(cfg.chunk_z, cfg.z - z_start)
                for y_chunk in range(y_chunk_count):
                    y_start = y_chunk * cfg.chunk_y
                    y_extent = min(cfg.chunk_y, cfg.y - y_start)
                    for x_chunk in range(x_chunk_count):
                        x_start = x_chunk * cfg.chunk_x
                        x_extent = min(cfg.chunk_x, cfg.x - x_start)
                        tasks.append(
                            ChunkTask(
                                t_idx=t_idx,
                                c_idx=c_idx,
                                z_chunk=z_chunk,
                                y_chunk=y_chunk,
                                x_chunk=x_chunk,
                                z_start=z_start,
                                y_start=y_start,
                                x_start=x_start,
                                z_extent=z_extent,
                                y_extent=y_extent,
                                x_extent=x_extent,
                            )
                        )
    return tasks, z_chunk_count, y_chunk_count, x_chunk_count


def ensure_chunk_dirs(output: Path, cfg: BigFixtureConfig, z_chunk_count: int, y_chunk_count: int) -> None:
    root = output / "0"
    for t_idx in range(cfg.t):
        for c_idx in range(cfg.c):
            for z_chunk in range(z_chunk_count):
                for y_chunk in range(y_chunk_count):
                    (root / str(t_idx) / str(c_idx) / str(z_chunk) / str(y_chunk)).mkdir(
                        parents=True,
                        exist_ok=True,
                    )


def write_one_chunk(output: Path, cfg: BigFixtureConfig, task: ChunkTask) -> None:
    chunk_path = (
        output
        / "0"
        / str(task.t_idx)
        / str(task.c_idx)
        / str(task.z_chunk)
        / str(task.y_chunk)
        / str(task.x_chunk)
    )
    chunk_path.write_bytes(
        make_chunk_blob_numpy(
            cfg,
            task.t_idx,
            task.c_idx,
            task.z_start,
            task.z_extent,
            task.y_start,
            task.y_extent,
            task.x_start,
            task.x_extent,
        )
    )


def maybe_print_progress(done: int, total: int, started: float) -> None:
    if done == 1 or done % 128 == 0 or done == total:
        elapsed = max(time.time() - started, 1e-6)
        rate = done / elapsed
        remaining = (total - done) / max(rate, 1e-9)
        print(
            f"chunks {done}/{total} ({done/total*100:.1f}%) "
            f"rate={rate:.1f}/s eta={remaining:.1f}s",
            flush=True,
        )


def write_chunks(output: Path, cfg: BigFixtureConfig, workers: int, queue_factor: int) -> None:
    tasks, z_chunk_count, y_chunk_count, _ = iter_chunk_tasks(cfg)
    total = len(tasks)
    ensure_chunk_dirs(output, cfg, z_chunk_count, y_chunk_count)
    started = time.time()

    if workers <= 1:
        for idx, task in enumerate(tasks, start=1):
            write_one_chunk(output, cfg, task)
            maybe_print_progress(idx, total, started)
        return

    in_flight_cap = max(workers * queue_factor, workers)
    pending: set[Future[None]] = set()
    done_count = 0
    next_idx = 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        while done_count < total:
            while len(pending) < in_flight_cap and next_idx < total:
                fut = executor.submit(write_one_chunk, output, cfg, tasks[next_idx])
                pending.add(fut)
                next_idx += 1

            completed, pending = wait(pending, return_when=FIRST_COMPLETED)
            for fut in completed:
                fut.result()
                done_count += 1
                maybe_print_progress(done_count, total, started)


def main() -> None:
    args = parse_args()
    cfg = BigFixtureConfig(
        t=args.t,
        c=args.c,
        z=args.z,
        y=args.y,
        x=args.x,
        chunk_z=args.chunk_z,
        chunk_y=args.chunk_y,
        chunk_x=args.chunk_x,
        scale_z=args.scale_z,
        scale_y=args.scale_y,
        scale_x=args.scale_x,
    )
    validate_config(cfg, workers=args.workers, queue_factor=args.queue_factor)

    print_plan(args.output, cfg, workers=args.workers)
    ensure_output_dir(args.output, args.force)
    write_metadata(args.output, cfg)
    write_chunks(args.output, cfg, workers=args.workers, queue_factor=args.queue_factor)
    print("done")


if __name__ == "__main__":
    sys.exit(main())
