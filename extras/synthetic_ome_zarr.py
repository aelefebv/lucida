#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2"]
# ///
"""Write synthetic OME-Zarr 0.5 datasets for tests and measurements.

The output is a Zarr v3 dataset that lucida opens like any other: a single
multiscale image, or a collection of tiles laid out as a grid of groups.
Every option below is a command-line flag.

Run it with uv, which installs the dependencies declared at the top of this
file into a throwaway environment:

    uv run extras/synthetic_ome_zarr.py OUT.ome.zarr [options]

Options:

    --tiles N            Write a collection of N tiles instead of one image.
                         Tiles fill a near-square grid of groups, one image per
                         group. Omit for a single image.
    --size Y,X | Z,Y,X   Spatial size of level 0. Two values make a 2D dataset,
                         three make a 3D one. Default 256,256.
    --channels C         Channel count. Default 1. A channel axis is written
                         only when C is larger than 1.
    --timepoints T       Timepoint count. Default 1. A time axis is written
                         only when T is larger than 1.
    --levels N           Number of pyramid levels, level 0 being finest.
                         Default 3.
    --factor F           Scale factor between one level and the next, in the
                         same axis order as --size. One value applies to every
                         spatial axis; per-axis values such as 1,2,2 leave an
                         axis alone. Repeat the flag to give each level its own
                         factor; the last one repeats for the remaining levels.
                         Default 2.
    --chunk S | Y,X | Z,Y,X
                         Chunk shape in samples. The time and channel axes are
                         always chunked at 1. Repeat the flag to give each
                         level its own chunk shape; the last one repeats for
                         the remaining levels. Default 64.
    --shard S | Y,X | Z,Y,X
                         Shard shape in samples, a multiple of the chunk shape
                         on every axis. Its presence makes the dataset sharded:
                         each shard is one object holding many inner chunks and
                         an index. Omit for one object per chunk.
    --sparse             Leave a checkerboard of chunks unwritten: a chunk is
                         written only when the sum of its grid indices over
                         every axis is even. In a sharded dataset the unwritten
                         inner chunks are absent from their shard's index.
    --unwritten-level L  Declare level L in the multiscale metadata and write
                         its array metadata, but no chunk. Repeatable. Level 0
                         is always written.
    --level-index        Give every sample at level L the value L, so a
                         screenshot names the level that rendered. Without it,
                         every level samples one smooth picture at its own
                         sample spacing.
    --seed N             Seed for the picture. The same seed gives the same
                         samples whatever the layout. Default 0.
    --overwrite          Replace OUT if it exists.

Level L has shape ceil(shape of level L-1 / factor) on every spatial axis,
and its scale transform is the running product of the factors. Sample values
are uint16.

Examples:

    Two datasets with identical samples, one sharded and one not:
        uv run extras/synthetic_ome_zarr.py twin-unsharded.ome.zarr --size 48,48 --chunk 8
        uv run extras/synthetic_ome_zarr.py twin-sharded.ome.zarr --size 48,48 --chunk 8 --shard 16

    A 3D level-index pyramid that leaves z alone:
        uv run extras/synthetic_ome_zarr.py levels.ome.zarr --size 32,512,512 --levels 4 --factor 1,2,2 --level-index

    A large collection for measurements:
        uv run extras/synthetic_ome_zarr.py big.ome.zarr --tiles 216 --size 2048,2048 --channels 3 --chunk 64 --shard 512
"""

from __future__ import annotations

import argparse
import itertools
import math
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import zarr
from zarr.codecs import BytesCodec, ZstdCodec

# Never a one-byte type. zarr-python omits the `bytes` codec's `endian` for
# those, and lucida's import rejects a `bytes` codec without it.
DTYPE = np.uint16

# Below the type's maximum so an auto-contrast window has headroom above the data.
SAMPLE_MAX = 60000

DEFAULT_SIZE = (256, 256)
DEFAULT_CHUNK = 64
DEFAULT_FACTOR = 2
DEFAULT_LEVELS = 3

AXIS_TYPES = {"t": "time", "c": "channel", "z": "space", "y": "space", "x": "space"}


@dataclass(frozen=True)
class Options:
    """Everything the generator needs, as parsed from the command line.

    Spatial tuples (``size``, ``factors``, ``chunks``, ``shard``) all share one
    axis order: ``(y, x)`` for 2D and ``(z, y, x)`` for 3D. ``factors`` and
    ``chunks`` are per level, and the last entry repeats for the levels past
    it.
    """

    out: Path
    tiles: int | None = None
    size: tuple[int, ...] = DEFAULT_SIZE
    channels: int = 1
    timepoints: int = 1
    levels: int = DEFAULT_LEVELS
    factors: tuple[tuple[int, ...], ...] = ((DEFAULT_FACTOR, DEFAULT_FACTOR),)
    chunks: tuple[tuple[int, ...], ...] = ((DEFAULT_CHUNK, DEFAULT_CHUNK),)
    shard: tuple[int, ...] | None = None
    sparse: bool = False
    unwritten_levels: tuple[int, ...] = ()
    level_index: bool = False
    seed: int = 0
    overwrite: bool = False

    @property
    def ndim(self) -> int:
        return len(self.size)

    def chunk_at(self, level: int) -> tuple[int, ...]:
        """The chunk shape of ``level``: its own entry, or the last one given."""
        return self.chunks[min(level, len(self.chunks) - 1)]

    @property
    def leading_axes(self) -> tuple[tuple[str, int], ...]:
        """The non-spatial axes that are written, as (name, size), in axis order.

        An axis of size 1 is left out of the array, so a single-channel
        dataset has no channel axis.
        """
        axes = []
        if self.timepoints > 1:
            axes.append(("t", self.timepoints))
        if self.channels > 1:
            axes.append(("c", self.channels))
        return tuple(axes)

    @property
    def axis_names(self) -> list[str]:
        spatial = ["z", "y", "x"] if self.ndim == 3 else ["y", "x"]
        return [name for name, _ in self.leading_axes] + spatial


@dataclass(frozen=True)
class Level:
    """One pyramid level: its spatial shape and its scale relative to level 0."""

    index: int
    shape: tuple[int, ...]
    scale: tuple[float, ...]


def _positive_ints(text: str) -> tuple[int, ...]:
    values = tuple(int(part) for part in text.split(","))
    if any(v <= 0 for v in values):
        raise ValueError("every value must be a positive integer")
    return values


def _per_axis(values: tuple[int, ...], ndim: int, flag: str, parser: argparse.ArgumentParser) -> tuple[int, ...]:
    """Expand a one-value form to every spatial axis and check the arity."""
    if len(values) == 1:
        return values * ndim
    if len(values) != ndim:
        parser.error(f"{flag} takes 1 or {ndim} values for a {ndim}D dataset, got {len(values)}")
    return values


def parse_args(argv: Sequence[str] | None = None) -> Options:
    parser = argparse.ArgumentParser(
        prog="synthetic_ome_zarr.py",
        description="Write a synthetic OME-Zarr 0.5 dataset. See the module docstring for the options.",
    )
    parser.add_argument("out", type=Path, help="output path")
    parser.add_argument("--tiles", type=int, metavar="N", help="write a collection of N tiles instead of one image")
    parser.add_argument("--size", type=_positive_ints, default=DEFAULT_SIZE, metavar="Y,X|Z,Y,X", help="spatial size of level 0 (default 256,256)")
    parser.add_argument("--channels", type=int, default=1, metavar="C", help="channel count (default 1)")
    parser.add_argument("--timepoints", type=int, default=1, metavar="T", help="timepoint count (default 1)")
    parser.add_argument("--levels", type=int, default=DEFAULT_LEVELS, metavar="N", help="pyramid levels (default 3)")
    parser.add_argument("--factor", type=_positive_ints, action="append", metavar="F|F,F[,F]", help="scale factor to the next level, one value or per axis; repeat for per-level factors (default 2)")
    parser.add_argument("--chunk", type=_positive_ints, action="append", metavar="S|S,S[,S]", help="chunk shape in samples, one value or per axis; repeat for per-level chunk shapes (default 64)")
    parser.add_argument("--shard", type=_positive_ints, metavar="S|S,S[,S]", help="shard shape in samples, a multiple of --chunk; presence means sharded")
    parser.add_argument("--sparse", action="store_true", help="leave a checkerboard of chunks unwritten")
    parser.add_argument("--unwritten-level", type=int, action="append", default=[], metavar="L", help="declare level L but write no chunk for it; repeatable")
    parser.add_argument("--level-index", action="store_true", help="give every sample at level L the value L")
    parser.add_argument("--seed", type=int, default=0, metavar="N", help="seed for the picture (default 0)")
    parser.add_argument("--overwrite", action="store_true", help="replace OUT if it exists")
    args = parser.parse_args(argv)

    if len(args.size) not in (2, 3):
        parser.error(f"--size takes 2 (Y,X) or 3 (Z,Y,X) values, got {len(args.size)}")
    ndim = len(args.size)
    for flag, value in (("--channels", args.channels), ("--timepoints", args.timepoints), ("--levels", args.levels)):
        if value < 1:
            parser.error(f"{flag} must be at least 1")
    if args.tiles is not None and args.tiles < 1:
        parser.error("--tiles must be at least 1")

    factors = tuple(_per_axis(f, ndim, "--factor", parser) for f in (args.factor or [(DEFAULT_FACTOR,)]))
    chunks = tuple(_per_axis(c, ndim, "--chunk", parser) for c in (args.chunk or [(DEFAULT_CHUNK,)]))
    shard = None
    if args.shard is not None:
        shard = _per_axis(args.shard, ndim, "--shard", parser)
        for chunk in chunks:
            for axis, (s, c) in enumerate(zip(shard, chunk)):
                if s % c != 0:
                    parser.error(f"--shard must be a multiple of every --chunk on every axis; axis {axis} has {s} % {c} != 0")
    unwritten = tuple(sorted(set(args.unwritten_level)))
    for level in unwritten:
        if level < 1 or level >= args.levels:
            parser.error(f"--unwritten-level {level} is outside 1..{args.levels - 1}; level 0 is always written")

    return Options(
        out=args.out,
        tiles=args.tiles,
        size=args.size,
        channels=args.channels,
        timepoints=args.timepoints,
        levels=args.levels,
        factors=factors,
        chunks=chunks,
        shard=shard,
        sparse=args.sparse,
        unwritten_levels=unwritten,
        level_index=args.level_index,
        seed=args.seed,
        overwrite=args.overwrite,
    )


def plan_levels(opts: Options) -> list[Level]:
    """Derive every level's shape and scale from the size and the factors."""
    shape = opts.size
    scale = (1.0,) * opts.ndim
    levels = [Level(0, shape, scale)]
    for index in range(1, opts.levels):
        factor = opts.factors[min(index - 1, len(opts.factors) - 1)]
        shape = tuple(max(1, math.ceil(s / f)) for s, f in zip(shape, factor))
        scale = tuple(sc * f for sc, f in zip(scale, factor))
        levels.append(Level(index, shape, scale))
    return levels


def multiscales_attributes(opts: Options, levels: list[Level], name: str) -> dict:
    axes = [{"name": name, "type": AXIS_TYPES[name]} for name in opts.axis_names]
    leading_scale = [1.0] * len(opts.leading_axes)
    datasets = [
        {
            "path": str(level.index),
            "coordinateTransformations": [{"type": "scale", "scale": leading_scale + [float(s) for s in level.scale]}],
        }
        for level in levels
    ]
    return {"ome": {"version": "0.5", "multiscales": [{"name": name, "axes": axes, "datasets": datasets}]}}


def tile_grid(tiles: int) -> tuple[int, int]:
    """Rows and columns of the near-square grid that holds this many tiles."""
    columns = math.ceil(math.sqrt(tiles))
    rows = math.ceil(tiles / columns)
    return rows, columns


def row_name(index: int) -> str:
    """Spreadsheet-style row names: A..Z, then AA, AB, and so on."""
    name = ""
    index += 1
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        name = chr(ord("A") + remainder) + name
    return name


def tile_group_path(tile: int, columns: int) -> str:
    """The group that holds one tile, as ``row/column`` in the collection."""
    return f"{row_name(tile // columns)}/{tile % columns + 1}"


def collection_attributes(tiles: int, name: str) -> dict:
    """Root attributes of a collection, in the OME-Zarr 0.5 layout the format calls a plate."""
    rows, columns = tile_grid(tiles)
    entries = [
        {"path": tile_group_path(i, columns), "rowIndex": i // columns, "columnIndex": i % columns} for i in range(tiles)
    ]
    collection = {
        "name": name,
        "rows": [{"name": row_name(r)} for r in range(rows)],
        "columns": [{"name": str(c + 1)} for c in range(columns)],
        "wells": entries,
        "field_count": 1,
    }
    return {"ome": {"version": "0.5", "plate": collection}}


def picture_region(opts: Options, tile: int, t: int, c: int, level: Level, origin: Sequence[int], extent: Sequence[int]) -> np.ndarray:
    """Evaluate the smooth picture on one spatial region of one level.

    The picture is a function of position in level 0's coordinate space, so
    every level samples the same picture at its own sample spacing and a
    sharded dataset holds the same values as an unsharded one. Each
    (tile, t, c) draws its own frequencies, phases, and one bright spot from
    the seed.
    """
    rng = np.random.default_rng([opts.seed, tile, t, c])
    frequencies = rng.uniform(1.0, 3.0, opts.ndim)
    phases = rng.uniform(0.0, 2.0 * np.pi, opts.ndim)
    spot_center = rng.uniform(0.25, 0.75, opts.ndim)
    spot_width = rng.uniform(0.08, 0.2)

    # Sample centers in level-0 space, normalized so frequencies are cycles
    # across the dataset.
    coordinates = []
    for axis in range(opts.ndim):
        indices = np.arange(origin[axis], origin[axis] + extent[axis], dtype=np.float64)
        coordinates.append((indices + 0.5) * level.scale[axis] / opts.size[axis])
    grids = np.meshgrid(*coordinates, indexing="ij")

    value = np.full(tuple(extent), 0.45)
    for axis, grid in enumerate(grids):
        value += 0.15 * np.sin(2.0 * np.pi * frequencies[axis] * grid + phases[axis])
    distance_squared = sum((grid - spot_center[axis]) ** 2 for axis, grid in enumerate(grids))
    value += 0.4 * np.exp(-distance_squared / (2.0 * spot_width**2))
    return np.rint(np.clip(value, 0.0, 1.0) * SAMPLE_MAX).astype(DTYPE)


def write_image(store: zarr.storage.LocalStore, prefix: str, opts: Options, levels: list[Level], tile: int, name: str) -> None:
    """Write one multiscale image group and its level arrays under ``prefix``."""
    zarr.create_group(store=store, path=prefix, attributes=multiscales_attributes(opts, levels, name), zarr_format=3)
    for level in levels:
        write_level(store, prefix, opts, level, tile)


def write_level(store: zarr.storage.LocalStore, prefix: str, opts: Options, level: Level, tile: int) -> None:
    leading_shape = tuple(size for _, size in opts.leading_axes)
    leading_ones = (1,) * len(leading_shape)
    chunk = opts.chunk_at(level.index)
    array = zarr.create_array(
        store=store,
        name=f"{prefix}/{level.index}" if prefix else str(level.index),
        shape=leading_shape + level.shape,
        chunks=leading_ones + chunk,
        shards=(leading_ones + opts.shard) if opts.shard else None,
        dtype=DTYPE,
        fill_value=0,
        dimension_names=opts.axis_names,
        serializer=BytesCodec(endian="little"),
        compressors=[ZstdCodec()],
        # Level 0 of a level-index pyramid is all zeros, equal to the fill
        # value; the default would elide its chunks and make a written level
        # look unwritten.
        config={"write_empty_chunks": True},
        zarr_format=3,
    )
    if level.index in opts.unwritten_levels:
        return

    # A sparse level is written one inner chunk at a time so the skipped
    # chunks never reach the shard and stay absent from its index.
    unit = opts.shard if (opts.shard and not opts.sparse) else chunk
    grid = [range(math.ceil(s / u)) for s, u in zip(level.shape, unit)]
    for t in range(opts.timepoints):
        for c in range(opts.channels):
            for grid_index in itertools.product(*grid):
                if opts.sparse and (t + c + sum(grid_index)) % 2 == 1:
                    continue
                origin = [g * u for g, u in zip(grid_index, unit)]
                extent = [min(u, s - o) for u, s, o in zip(unit, level.shape, origin)]
                if opts.level_index:
                    values = np.full(extent, level.index, dtype=DTYPE)
                else:
                    values = picture_region(opts, tile, t, c, level, origin, extent)
                leading_index = {"t": t, "c": c}
                region: list[int | slice] = [leading_index[name] for name, _ in opts.leading_axes]
                region.extend(slice(o, o + e) for o, e in zip(origin, extent))
                array[tuple(region)] = values


def generate(opts: Options) -> list[Level]:
    """Write the dataset described by ``opts`` and return its level plan."""
    if opts.out.exists():
        if not opts.overwrite:
            raise SystemExit(f"{opts.out} exists; pass --overwrite to replace it")
        shutil.rmtree(opts.out)
    levels = plan_levels(opts)
    name = opts.out.name.split(".")[0] or "synthetic"
    store = zarr.storage.LocalStore(str(opts.out))

    if opts.tiles is None:
        write_image(store, "", opts, levels, tile=0, name=name)
        return levels

    zarr.create_group(store=store, attributes=collection_attributes(opts.tiles, name), zarr_format=3)
    rows, columns = tile_grid(opts.tiles)
    for row in range(rows):
        zarr.create_group(store=store, path=row_name(row), zarr_format=3)
    for tile in range(opts.tiles):
        group_path = tile_group_path(tile, columns)
        group_attributes = {"ome": {"version": "0.5", "well": {"images": [{"path": "0"}]}}}
        zarr.create_group(store=store, path=group_path, attributes=group_attributes, zarr_format=3)
        write_image(store, f"{group_path}/0", opts, levels, tile=tile, name=f"{name} {group_path}")
    return levels


def main(argv: Sequence[str] | None = None) -> int:
    opts = parse_args(argv)
    levels = generate(opts)
    layout = f"sharded {opts.shard}" if opts.shard else "unsharded"
    what = f"collection of {opts.tiles} tiles" if opts.tiles else "image"
    shapes = ", ".join("x".join(str(s) for s in level.shape) for level in levels)
    chunks = ", ".join("x".join(str(s) for s in opts.chunk_at(level.index)) for level in levels)
    print(f"wrote {opts.out}: {what}, {layout}, chunks [{chunks}], levels [{shapes}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
