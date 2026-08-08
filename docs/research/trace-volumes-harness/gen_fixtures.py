#!/usr/bin/env python3
"""Generate two REAL large OME-Zarr v0.5 (zarr v3) fixtures for trace-volume measurement.

  V  volume     : single image, 3D multichannel timeseries, multi-GB level 0.
  C  collection : an OME-Zarr plate-layout collection of hundreds of members.

Data is structured-plus-noise so zstd ratios stay realistic (~1.5-2x), not the
~100x a constant array would give.
"""
from __future__ import annotations
import json, sys, time
from pathlib import Path
import numpy as np
import zarr
from zarr.codecs import BytesCodec, ZstdCodec

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tv/fixtures")
WHICH = sys.argv[2] if len(sys.argv) > 2 else "all"

CKE = {"name": "default", "configuration": {"separator": "/"}}


def axes_block():
    return [
        {"name": "t", "type": "time", "unit": "second"},
        {"name": "c", "type": "channel"},
        {"name": "z", "type": "space", "unit": "micrometer"},
        {"name": "y", "type": "space", "unit": "micrometer"},
        {"name": "x", "type": "space", "unit": "micrometer"},
    ]


def multiscales(nlevels, factors):
    return {
        "version": "0.5",
        "multiscales": [{
            "version": "0.5",
            "name": "image",
            "axes": axes_block(),
            "datasets": [
                {"path": str(i),
                 "coordinateTransformations": [
                     {"type": "scale", "scale": [1.0, 1.0, 1.0, float(f), float(f)]}]}
                for i, f in enumerate(factors)
            ],
            "type": "2x2 box average",
        }],
    }


def make_block(z, y, x, seed):
    """Structured + noisy uint16 block; compresses like real acquisition data."""
    rng = np.random.default_rng(seed)
    yy = np.linspace(0, 3.1, y, dtype=np.float32)[:, None]
    xx = np.linspace(0, 3.1, x, dtype=np.float32)[None, :]
    base = (np.sin(yy * 4) * np.cos(xx * 5) + 1.2) * 9000.0
    out = np.empty((z, y, x), dtype=np.uint16)
    for k in range(z):
        n = rng.normal(0, 900, size=(y, x)).astype(np.float32)
        out[k] = np.clip(base * (0.6 + 0.4 * np.sin(k * 0.3)) + n, 0, 65535).astype(np.uint16)
    return out


def write_image(path: Path, T, C, Z, Y, X, chunk, levels, seed0):
    """levels: list of xy downsample factors, e.g. [1,2,4,8]."""
    g = zarr.create_group(store=str(path), zarr_format=3, overwrite=True)
    g.attrs.update(ome=multiscales(len(levels), levels))
    arrs = []
    for i, f in enumerate(levels):
        y, x = max(1, Y // f), max(1, X // f)
        cz, cy, cx = chunk
        a = zarr.create_array(
            store=str(path), name=str(i), shape=(T, C, Z, y, x),
            chunks=(1, 1, cz, min(cy, y), min(cx, x)), dtype="uint16",
            serializer=BytesCodec(endian="little"), compressors=ZstdCodec(level=1),
            chunk_key_encoding=CKE, dimension_names=["t", "c", "z", "y", "x"],
            zarr_format=3, overwrite=True,
        )
        arrs.append((a, f, y, x))
    for t in range(T):
        for c in range(C):
            blk = make_block(Z, Y, X, seed0 + t * 31 + c)
            for a, f, y, x in arrs:
                a[t, c] = blk if f == 1 else blk[:, : y * f, : x * f].reshape(Z, y, f, x, f).mean(axis=(2, 4)).astype(np.uint16)
    return path


def gen_volume(root: Path):
    t0 = time.time()
    p = root / "volume-timeseries.zarr"
    T, C, Z, Y, X = 8, 3, 48, 1536, 1536
    write_image(p, T, C, Z, Y, X, chunk=(16, 256, 256), levels=[1, 2, 4, 8], seed0=1)
    raw = T * C * Z * Y * X * 2
    print(json.dumps({"fixture": "volume", "path": str(p), "shape_tczyx": [T, C, Z, Y, X],
                      "chunk_zyx": [16, 256, 256], "levels": 4,
                      "level0_raw_bytes": raw, "secs": round(time.time() - t0, 1)}))


def gen_collection(root: Path, rows=24, cols=16):
    t0 = time.time()
    p = root / "wide-collection.zarr"
    T, C, Z, Y, X = 4, 2, 8, 512, 512
    row_names = [f"R{i:02d}" for i in range(rows)]
    col_names = [f"{j:02d}" for j in range(cols)]
    g = zarr.create_group(store=str(p), zarr_format=3, overwrite=True)
    wells = [{"path": f"{r}/{c}", "rowIndex": ri, "columnIndex": ci}
             for ri, r in enumerate(row_names) for ci, c in enumerate(col_names)]
    g.attrs.update(ome={"version": "0.5", "plate": {
        "version": "0.5", "name": "wide-collection",
        "rows": [{"name": r} for r in row_names],
        "columns": [{"name": c} for c in col_names],
        "wells": wells, "field_count": 1}})
    blk = make_block(Z, Y, X, 7)
    n = 0
    for ri, r in enumerate(row_names):
        rg = zarr.create_group(store=str(p), path=r, zarr_format=3, overwrite=True)
        rg.attrs.update({})
        for ci, c in enumerate(col_names):
            wg = zarr.create_group(store=str(p), path=f"{r}/{c}", zarr_format=3, overwrite=True)
            wg.attrs.update(ome={"version": "0.5", "well": {"images": [{"path": "0"}]}})
            mp = f"{r}/{c}/0"
            mg = zarr.create_group(store=str(p), path=mp, zarr_format=3, overwrite=True)
            mg.attrs.update(ome=multiscales(3, [1, 2, 4]))
            for i, f in enumerate([1, 2, 4]):
                y, x = Y // f, X // f
                a = zarr.create_array(store=str(p), name=f"{mp}/{i}", shape=(T, C, Z, y, x),
                                      chunks=(1, 1, 8, min(256, y), min(256, x)), dtype="uint16",
                                      serializer=BytesCodec(endian="little"),
                                      compressors=ZstdCodec(level=1), chunk_key_encoding=CKE,
                                      dimension_names=["t", "c", "z", "y", "x"], zarr_format=3,
                                      overwrite=True)
                sub = blk if f == 1 else blk[:, : y * f, : x * f].reshape(Z, y, f, x, f).mean(axis=(2, 4)).astype(np.uint16)
                shifted = np.clip(sub.astype(np.int32) + (n % 37) * 120, 0, 65535).astype(np.uint16)
                for t in range(T):
                    for cc in range(C):
                        a[t, cc] = shifted
            n += 1
        print(f"  row {r} done ({n} members)", file=sys.stderr, flush=True)
    print(json.dumps({"fixture": "collection", "path": str(p), "members": n,
                      "member_shape_tczyx": [T, C, Z, Y, X], "levels": 3,
                      "level0_raw_bytes_total": n * T * C * Z * Y * X * 2,
                      "secs": round(time.time() - t0, 1)}))


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    if WHICH in ("all", "volume"):
        gen_volume(ROOT)
    if WHICH in ("all", "collection"):
        gen_collection(ROOT)
