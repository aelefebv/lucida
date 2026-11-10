#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2"]
# ///
"""Write synthetic OME-Zarr datasets for tests and measurements.

The output is an OME-Zarr 0.5 dataset on Zarr v3, or an OME-NGFF 0.4 one on
Zarr v2, that lucida opens like any other: a single multiscale image, or a
collection of tiles laid out as a grid of groups. Every option below is a
command-line flag.

Run it with uv, which installs the dependencies declared at the top of this
file into a throwaway environment:

    uv run extras/synthetic_ome_zarr.py OUT.ome.zarr [options]

Options:

    --tiles N            Write a collection of N tiles instead of one image.
                         Tiles fill a near-square grid of groups, one image per
                         group. Omit for a single image.
    --size Y,X | Z,Y,X   Spatial size of level 0. Two values make a 2D dataset,
                         three make a 3D one. Default 256,256. In a collection,
                         repeat the flag to give tiles their own sizes: tile i
                         takes the i-th size, and the last one repeats.
    --channels C         Channel count. Default 1. A channel axis is written
                         only when C is larger than 1.
    --channel-colors RRGGBB,...
                         The color each image declares for each of its
                         channels, one per channel, written to an `omero`
                         block. Written verbatim, so a malformed value tests
                         what a reader does with one. Omit for no `omero`
                         block.
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
    --clip-chunks        Clip each level's chunk shape to that level's shape,
                         as writers do that never declare a chunk larger than
                         its array. With tiles of different sizes, a coarse
                         level's chunk shape then differs from tile to tile.
                         Not combinable with --shard.
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
    --labels             Also write a label image, `balls`, beside each image:
                         uint32 ids of a grid of balls, one ball per 32 level 0
                         samples along each spatial axis, on the image's levels,
                         chunks and shards. A label has no channel axis.
    --scale S | Y,X | Z,Y,X
                         The extent of one level 0 sample, in the same axis
                         order as --size, in --unit when one is given. One value
                         applies to every spatial axis. Default 1. Each coarser
                         level's scale is this times the running product of the
                         factors.
    --translation T | Y,X | Z,Y,X
                         Where level 0's first sample sits, in the same axis
                         order and units as --scale. Default 0. Each coarser
                         level is shifted by half its extra sample size, so
                         sample centers keep their place.
    --unit U             Length unit written on every spatial axis, such as
                         micrometer or nanometer. Omit to write none.
    --level-index        Give every sample at level L the value L, so a
                         screenshot names the level that rendered. Without it,
                         every level samples one smooth picture at its own
                         sample spacing.
    --dtype T            Sample data type: uint16 (default), uint8, uint32,
                         uint64, int8, int16, int32, int64, float16, float32,
                         or float64.
    --range=LO,HI        The values the picture spans, darkest to brightest.
                         Default 0,60000. Integer types round to the nearest
                         whole value; a range reaching below zero needs a
                         signed or float type. Write it with `=`, since a
                         negative LO would otherwise read as a flag.
    --zarr-version V     3 (default) writes OME-Zarr 0.5 on Zarr v3. 2 writes
                         OME-NGFF 0.4 on Zarr v2: `.zgroup`, `.zattrs`, and
                         `.zarray`, with the OME blocks at the top of `.zattrs`.
                         Not combinable with --shard.
    --compressor C       The codec that compresses each chunk: zstd (default),
                         gzip, blosc-lz4 (Blosc with lz4 and byte shuffle, as
                         numcodecs writes by default), or none.
    --order O            C (default) or F. F stores each chunk in Fortran
                         order: Zarr v2's `order` field, or on Zarr v3 a
                         transpose codec that reverses the axes.
    --endian E           little (default) or big: the byte order each sample
                         is stored in.
    --checksum           End each chunk in a crc32c checksum. Zarr v3 only.
    --dimension-separator S
                         The separator between chunk coordinates in a Zarr v2
                         chunk key: / (default) or a dot.
    --level-prefix P     Name level L's array P followed by L, as the multiscale
                         metadata gives it. Default empty, so the arrays are
                         0, 1, 2, and so on.
    --consolidated       Consolidate every metadata document into the root:
                         `.zmetadata` on Zarr v2, `consolidated_metadata` in
                         the root `zarr.json` on Zarr v3.
    --seed N             Seed for the picture. The same seed gives the same
                         samples whatever the layout. Default 0.
    --overwrite          Replace OUT if it exists.

Level L has shape ceil(shape of level L-1 / factor) on every spatial axis,
and its scale transform is the running product of the factors.

Examples:

    Two datasets with identical samples, one sharded and one not:
        uv run extras/synthetic_ome_zarr.py twin-unsharded.ome.zarr --size 48,48 --chunk 8
        uv run extras/synthetic_ome_zarr.py twin-sharded.ome.zarr --size 48,48 --chunk 8 --shard 16

    A 3D level-index pyramid that leaves z alone:
        uv run extras/synthetic_ome_zarr.py levels.ome.zarr --size 32,512,512 --levels 4 --factor 1,2,2 --level-index

    A float volume whose values reach below zero:
        uv run extras/synthetic_ome_zarr.py float.ome.zarr --size 64,256,256 --dtype float32 --range=-200,1000

    Two images of one region at different sample sizes, the second moved:
        uv run extras/synthetic_ome_zarr.py coarse.ome.zarr --size 64,64 --scale 2 --unit micrometer
        uv run extras/synthetic_ome_zarr.py fine.ome.zarr --size 256,256 --scale 500 --unit nanometer --translation 0,32000

    A large collection for measurements:
        uv run extras/synthetic_ome_zarr.py big.ome.zarr --tiles 216 --size 2048,2048 --channels 3 --chunk 64 --shard 512

    The same samples on Zarr v2, compressed as numcodecs does by default:
        uv run extras/synthetic_ome_zarr.py v2.ome.zarr --size 48,48 --chunk 8 --zarr-version 2 --compressor blosc-lz4
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

import numcodecs
import numpy as np
import zarr
from zarr.codecs import BloscCodec, BytesCodec, Crc32cCodec, GzipCodec, TransposeCodec, ZstdCodec

DTYPES = ("uint8", "uint16", "uint32", "uint64", "int8", "int16", "int32", "int64", "float16", "float32", "float64")
DEFAULT_DTYPE = "uint16"

# Below uint16's maximum so an auto-contrast window has headroom above the data.
DEFAULT_RANGE = (0.0, 60000.0)

DEFAULT_SIZE = (256, 256)
DEFAULT_CHUNK = 64
DEFAULT_FACTOR = 2
DEFAULT_LEVELS = 3

COMPRESSORS = ("zstd", "gzip", "blosc-lz4", "none")

AXIS_TYPES = {"t": "time", "c": "channel", "z": "space", "y": "space", "x": "space"}

LABEL_NAME = "balls"
LABEL_DTYPE = "uint32"
# Level 0 samples per ball of the label, along each spatial axis.
LABEL_CUBE = 32


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
    sizes: tuple[tuple[int, ...], ...] = (DEFAULT_SIZE,)
    channels: int = 1
    channel_colors: tuple[str, ...] = ()
    timepoints: int = 1
    levels: int = DEFAULT_LEVELS
    factors: tuple[tuple[int, ...], ...] = ((DEFAULT_FACTOR, DEFAULT_FACTOR),)
    chunks: tuple[tuple[int, ...], ...] = ((DEFAULT_CHUNK, DEFAULT_CHUNK),)
    clip_chunks: bool = False
    shard: tuple[int, ...] | None = None
    sparse: bool = False
    unwritten_levels: tuple[int, ...] = ()
    scale: tuple[float, ...] | None = None
    translation: tuple[float, ...] | None = None
    unit: str | None = None
    labels: bool = False
    level_index: bool = False
    dtype: str = DEFAULT_DTYPE
    value_range: tuple[float, float] = DEFAULT_RANGE
    zarr_version: int = 3
    compressor: str = "zstd"
    order: str = "C"
    endian: str = "little"
    checksum: bool = False
    dimension_separator: str = "/"
    level_prefix: str = ""
    consolidated: bool = False
    seed: int = 0
    overwrite: bool = False

    @property
    def size(self) -> tuple[int, ...]:
        """Level 0's size for a single image, or for a collection's first tile."""
        return self.sizes[0]

    @property
    def ndim(self) -> int:
        return len(self.size)

    def size_of(self, tile: int) -> tuple[int, ...]:
        """Level 0's size for ``tile``: its own entry, or the last one given."""
        return self.sizes[min(tile, len(self.sizes) - 1)]

    def chunk_at(self, level: int) -> tuple[int, ...]:
        """The chunk shape of ``level``: its own entry, or the last one given."""
        return self.chunks[min(level, len(self.chunks) - 1)]

    def chunk_for(self, level: Level) -> tuple[int, ...]:
        """The chunk shape written for ``level``, clipped to it under --clip-chunks."""
        chunk = self.chunk_at(level.index)
        if self.clip_chunks:
            return tuple(min(c, s) for c, s in zip(chunk, level.shape))
        return chunk

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
    def label_leading_axes(self) -> tuple[tuple[str, int], ...]:
        """The image's non-spatial axes a label keeps: all but the channel axis."""
        return tuple(axis for axis in self.leading_axes if axis[0] != "c")

    @property
    def spatial_names(self) -> list[str]:
        return ["z", "y", "x"] if self.ndim == 3 else ["y", "x"]

    @property
    def axis_names(self) -> list[str]:
        return [name for name, _ in self.leading_axes] + self.spatial_names

    @property
    def label_axis_names(self) -> list[str]:
        return [name for name, _ in self.label_leading_axes] + self.spatial_names


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


def _finite_floats(text: str) -> tuple[float, ...]:
    values = tuple(float(part) for part in text.split(","))
    if not all(math.isfinite(v) for v in values):
        raise ValueError("every value must be finite")
    return values


def _value_range(text: str) -> tuple[float, float]:
    parts = tuple(float(part) for part in text.split(","))
    if len(parts) != 2 or not all(math.isfinite(v) for v in parts) or parts[0] >= parts[1]:
        raise ValueError("takes two finite values, LO,HI, with LO below HI")
    return parts[0], parts[1]


def _per_axis(values: tuple, ndim: int, flag: str, parser: argparse.ArgumentParser) -> tuple:
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
    parser.add_argument("--size", type=_positive_ints, action="append", metavar="Y,X|Z,Y,X", help="spatial size of level 0 (default 256,256); repeat for per-tile sizes in a collection")
    parser.add_argument("--channels", type=int, default=1, metavar="C", help="channel count (default 1)")
    parser.add_argument("--channel-colors", type=lambda text: tuple(text.split(",")), default=(), metavar="RRGGBB,...", help="the color each channel declares, in an omero block (default none)")
    parser.add_argument("--timepoints", type=int, default=1, metavar="T", help="timepoint count (default 1)")
    parser.add_argument("--levels", type=int, default=DEFAULT_LEVELS, metavar="N", help="pyramid levels (default 3)")
    parser.add_argument("--factor", type=_positive_ints, action="append", metavar="F|F,F[,F]", help="scale factor to the next level, one value or per axis; repeat for per-level factors (default 2)")
    parser.add_argument("--chunk", type=_positive_ints, action="append", metavar="S|S,S[,S]", help="chunk shape in samples, one value or per axis; repeat for per-level chunk shapes (default 64)")
    parser.add_argument("--clip-chunks", action="store_true", help="clip each level's chunk shape to the level's shape")
    parser.add_argument("--shard", type=_positive_ints, metavar="S|S,S[,S]", help="shard shape in samples, a multiple of --chunk; presence means sharded")
    parser.add_argument("--sparse", action="store_true", help="leave a checkerboard of chunks unwritten")
    parser.add_argument("--unwritten-level", type=int, action="append", default=[], metavar="L", help="declare level L but write no chunk for it; repeatable")
    parser.add_argument("--scale", type=_finite_floats, metavar="S|S,S[,S]", help="extent of one level 0 sample, one value or per axis (default 1)")
    parser.add_argument("--translation", type=_finite_floats, metavar="T|T,T[,T]", help="where level 0's first sample sits, one value or per axis (default 0)")
    parser.add_argument("--unit", metavar="U", help="length unit written on every spatial axis (default none)")
    parser.add_argument("--labels", action="store_true", help="also write a label image of uint32 balls beside each image")
    parser.add_argument("--level-index", action="store_true", help="give every sample at level L the value L")
    parser.add_argument("--dtype", choices=DTYPES, default=DEFAULT_DTYPE, help="sample data type (default uint16)")
    parser.add_argument("--range", type=_value_range, default=DEFAULT_RANGE, metavar="LO,HI", dest="value_range", help="values the picture spans (default 0,60000)")
    parser.add_argument("--zarr-version", type=int, choices=(2, 3), default=3, help="Zarr format version (default 3)")
    parser.add_argument("--compressor", choices=COMPRESSORS, default="zstd", help="chunk compressor (default zstd)")
    parser.add_argument("--order", choices=("C", "F"), default="C", help="memory order of each chunk (default C)")
    parser.add_argument("--endian", choices=("little", "big"), default="little", help="byte order of each sample (default little)")
    parser.add_argument("--checksum", action="store_true", help="end each chunk in a crc32c checksum (Zarr v3 only)")
    parser.add_argument("--dimension-separator", choices=("/", "."), default="/", help="Zarr v2 chunk key separator (default /)")
    parser.add_argument("--level-prefix", default="", metavar="P", help="name level L's array P followed by L (default empty)")
    parser.add_argument("--consolidated", action="store_true", help="consolidate every metadata document into the root")
    parser.add_argument("--seed", type=int, default=0, metavar="N", help="seed for the picture (default 0)")
    parser.add_argument("--overwrite", action="store_true", help="replace OUT if it exists")
    args = parser.parse_args(argv)

    sizes = tuple(args.size or [DEFAULT_SIZE])
    if len(sizes[0]) not in (2, 3):
        parser.error(f"--size takes 2 (Y,X) or 3 (Z,Y,X) values, got {len(sizes[0])}")
    ndim = len(sizes[0])
    if any(len(size) != ndim for size in sizes):
        parser.error("every --size takes the same number of values")
    if len(sizes) > 1 and args.tiles is None:
        parser.error("a repeated --size gives tiles their own sizes, so it needs --tiles")
    for flag, value in (("--channels", args.channels), ("--timepoints", args.timepoints), ("--levels", args.levels)):
        if value < 1:
            parser.error(f"{flag} must be at least 1")
    if args.tiles is not None and args.tiles < 1:
        parser.error("--tiles must be at least 1")
    if args.channel_colors and len(args.channel_colors) != args.channels:
        parser.error(f"--channel-colors takes one color per channel, {args.channels}, got {len(args.channel_colors)}")

    factors = tuple(_per_axis(f, ndim, "--factor", parser) for f in (args.factor or [(DEFAULT_FACTOR,)]))
    chunks = tuple(_per_axis(c, ndim, "--chunk", parser) for c in (args.chunk or [(DEFAULT_CHUNK,)]))
    shard = None
    if args.shard is not None and args.clip_chunks:
        parser.error("--clip-chunks cannot be combined with --shard, which must be a multiple of every chunk")
    if args.shard is not None:
        shard = _per_axis(args.shard, ndim, "--shard", parser)
        for chunk in chunks:
            for axis, (s, c) in enumerate(zip(shard, chunk)):
                if s % c != 0:
                    parser.error(f"--shard must be a multiple of every --chunk on every axis; axis {axis} has {s} % {c} != 0")
    scale = None if args.scale is None else _per_axis(args.scale, ndim, "--scale", parser)
    if scale is not None and any(v <= 0 for v in scale):
        parser.error("--scale takes positive values")
    translation = None if args.translation is None else _per_axis(args.translation, ndim, "--translation", parser)
    unwritten = tuple(sorted(set(args.unwritten_level)))
    for level in unwritten:
        if level < 1 or level >= args.levels:
            parser.error(f"--unwritten-level {level} is outside 1..{args.levels - 1}; level 0 is always written")
    if args.zarr_version == 2 and args.shard is not None:
        parser.error("--shard needs --zarr-version 3; Zarr v2 has no sharding")
    if args.zarr_version == 2 and args.checksum:
        parser.error("--checksum needs --zarr-version 3")
    if np.issubdtype(np.dtype(args.dtype), np.integer):
        info = np.iinfo(args.dtype)
        lo, hi = args.value_range
        if lo < info.min or hi > info.max:
            parser.error(f"--range {lo:g},{hi:g} is outside what {args.dtype} holds, {info.min}..{info.max}")

    return Options(
        out=args.out,
        tiles=args.tiles,
        sizes=sizes,
        channels=args.channels,
        channel_colors=args.channel_colors,
        timepoints=args.timepoints,
        levels=args.levels,
        factors=factors,
        chunks=chunks,
        clip_chunks=args.clip_chunks,
        shard=shard,
        sparse=args.sparse,
        unwritten_levels=unwritten,
        scale=scale,
        translation=translation,
        unit=args.unit,
        labels=args.labels,
        level_index=args.level_index,
        dtype=args.dtype,
        value_range=args.value_range,
        zarr_version=args.zarr_version,
        compressor=args.compressor,
        order=args.order,
        endian=args.endian,
        checksum=args.checksum,
        dimension_separator=args.dimension_separator,
        level_prefix=args.level_prefix,
        consolidated=args.consolidated,
        seed=args.seed,
        overwrite=args.overwrite,
    )


def plan_levels(opts: Options, size: tuple[int, ...]) -> list[Level]:
    """Derive every level's shape and scale from a level 0 size and the factors."""
    shape = size
    scale = (1.0,) * opts.ndim
    levels = [Level(0, shape, scale)]
    for index in range(1, opts.levels):
        factor = opts.factors[min(index - 1, len(opts.factors) - 1)]
        shape = tuple(max(1, math.ceil(s / f)) for s, f in zip(shape, factor))
        scale = tuple(sc * f for sc, f in zip(scale, factor))
        levels.append(Level(index, shape, scale))
    return levels


def ome_attributes(opts: Options, blocks: dict) -> dict:
    """OME blocks placed as the version puts them: under `ome` in 0.5, at the top in 0.4."""
    if opts.zarr_version == 2:
        return {key: {"version": "0.4", **value} for key, value in blocks.items()}
    return {"ome": {"version": "0.5", **blocks}}


def multiscale_block(opts: Options, levels: list[Level], name: str, axis_names: list[str]) -> dict:
    """One multiscale over arrays with these axes, the leading ones unscaled."""
    axes = [{"name": axis, "type": AXIS_TYPES[axis]} for axis in axis_names]
    if opts.unit is not None:
        for axis in axes:
            if axis["type"] == "space":
                axis["unit"] = opts.unit
    leading = [0.0] * (len(axis_names) - opts.ndim)
    sample = opts.scale or (1.0,) * opts.ndim
    origin = opts.translation or (0.0,) * opts.ndim
    datasets = []
    for level in levels:
        scale = [factor * s for factor, s in zip(level.scale, sample)]
        transforms = [{"type": "scale", "scale": [1.0] * len(leading) + scale}]
        if opts.translation is not None:
            # A coarser sample spans several finer ones; its center moves by
            # half the difference, so every level's centers sit where level 0's do.
            shift = [o + (s - s0) / 2 for o, s, s0 in zip(origin, scale, sample)]
            transforms.append({"type": "translation", "translation": leading + shift})
        datasets.append({"path": f"{opts.level_prefix}{level.index}", "coordinateTransformations": transforms})
    return {"name": name, "axes": axes, "datasets": datasets}


def multiscales_attributes(opts: Options, levels: list[Level], name: str) -> dict:
    multiscale = multiscale_block(opts, levels, name, opts.axis_names)
    blocks = {}
    if opts.channel_colors:
        blocks["omero"] = {"channels": [{"color": color} for color in opts.channel_colors]}
    if opts.zarr_version == 2:
        return {"multiscales": [{"version": "0.4", **multiscale}], **blocks}
    return {"ome": {"version": "0.5", "multiscales": [multiscale], **blocks}}


def labels_index_attributes(opts: Options) -> dict:
    """The `labels` group's list of the label images under it."""
    if opts.zarr_version == 2:
        return {"labels": [LABEL_NAME]}
    return {"ome": {"version": "0.5", "labels": [LABEL_NAME]}}


def label_attributes(opts: Options, levels: list[Level]) -> dict:
    """A label image's multiscale, and its image-label block naming the image it labels."""
    multiscale = multiscale_block(opts, levels, LABEL_NAME, opts.label_axis_names)
    image_label = {"source": {"image": "../../"}}
    if opts.zarr_version == 2:
        return {"multiscales": [{"version": "0.4", **multiscale}], "image-label": {"version": "0.4", **image_label}}
    return {"ome": {"version": "0.5", "multiscales": [multiscale], "image-label": image_label}}


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


def collection_attributes(opts: Options, tiles: int, name: str) -> dict:
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
    return ome_attributes(opts, {"plate": collection})


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
        coordinates.append((indices + 0.5) * level.scale[axis] / opts.size_of(tile)[axis])
    grids = np.meshgrid(*coordinates, indexing="ij")

    value = np.full(tuple(extent), 0.45)
    for axis, grid in enumerate(grids):
        value += 0.15 * np.sin(2.0 * np.pi * frequencies[axis] * grid + phases[axis])
    distance_squared = sum((grid - spot_center[axis]) ** 2 for axis, grid in enumerate(grids))
    value += 0.4 * np.exp(-distance_squared / (2.0 * spot_width**2))
    lo, hi = opts.value_range
    scaled = lo + np.clip(value, 0.0, 1.0) * (hi - lo)
    if np.issubdtype(np.dtype(opts.dtype), np.integer):
        scaled = np.rint(scaled)
    return scaled.astype(opts.dtype)


def label_region(level: Level, origin: Sequence[int], extent: Sequence[int], size: Sequence[int]) -> np.ndarray:
    """The label ids on one spatial region of one level, for an image of level 0 ``size``.

    Level 0's space is cut into cubes of LABEL_CUBE samples, each holding one
    ball whose id is one more than the cube's index, with 0 between the balls.
    Like the picture, it is a function of position in level 0's space, so every
    level labels the same balls.
    """
    cubes = [math.ceil(s / LABEL_CUBE) for s in size]
    coordinates = [
        (np.arange(origin[axis], origin[axis] + extent[axis], dtype=np.float64) + 0.5) * level.scale[axis] / LABEL_CUBE
        for axis in range(len(size))
    ]
    grids = np.meshgrid(*coordinates, indexing="ij")
    ids = np.ones(tuple(extent), dtype=np.int64)
    distance_squared = np.zeros(tuple(extent))
    stride = 1
    for axis in reversed(range(len(size))):
        cube = np.minimum(np.floor(grids[axis]).astype(np.int64), cubes[axis] - 1)
        ids += cube * stride
        stride *= cubes[axis]
        distance_squared += (grids[axis] - cube - 0.5) ** 2
    return np.where(distance_squared <= 0.4**2, ids, 0).astype(LABEL_DTYPE)


def write_image(store: zarr.storage.LocalStore, prefix: str, opts: Options, levels: list[Level], tile: int, name: str) -> None:
    """Write one multiscale image group and its level arrays under ``prefix``."""
    zarr.create_group(store=store, path=prefix, attributes=multiscales_attributes(opts, levels, name), zarr_format=opts.zarr_version)
    for level in levels:
        write_level(store, prefix, opts, level, tile)
    if opts.labels:
        write_labels(store, prefix, opts, levels, tile)


def write_labels(store: zarr.storage.LocalStore, prefix: str, opts: Options, levels: list[Level], tile: int) -> None:
    """Write the label image of the image under ``prefix``, as `labels/` and `labels/<name>/` beside its levels."""
    labels_path = f"{prefix}/labels" if prefix else "labels"
    zarr.create_group(store=store, path=labels_path, attributes=labels_index_attributes(opts), zarr_format=opts.zarr_version)
    group_path = f"{labels_path}/{LABEL_NAME}"
    zarr.create_group(store=store, path=group_path, attributes=label_attributes(opts, levels), zarr_format=opts.zarr_version)
    leading_shape = tuple(size for _, size in opts.label_leading_axes)
    leading_ones = (1,) * len(leading_shape)
    for level in levels:
        chunk = opts.chunk_for(level)
        array = zarr.create_array(
            store=store,
            name=f"{group_path}/{opts.level_prefix}{level.index}",
            shape=leading_shape + level.shape,
            chunks=leading_ones + chunk,
            shards=(leading_ones + opts.shard) if opts.shard else None,
            fill_value=0,
            zarr_format=opts.zarr_version,
            **storage_arguments(opts, LABEL_DTYPE, opts.label_axis_names),
        )
        unit = opts.shard or chunk
        for grid_index in itertools.product(*[range(math.ceil(s / u)) for s, u in zip(level.shape, unit)]):
            origin = [g * u for g, u in zip(grid_index, unit)]
            extent = [min(u, s - o) for u, s, o in zip(unit, level.shape, origin)]
            values = label_region(level, origin, extent, opts.size_of(tile))
            region = (slice(None),) * len(leading_shape) + tuple(slice(o, o + e) for o, e in zip(origin, extent))
            # Every timepoint holds the same balls.
            array[region] = np.broadcast_to(values, leading_shape + values.shape)


def storage_arguments(opts: Options, dtype: str, axis_names: list[str]) -> dict:
    """How each chunk of an array of ``dtype`` with these axes is encoded, as `zarr.create_array` takes it for the version."""
    ndim = len(axis_names)
    if opts.zarr_version == 2:
        compressor = {
            "zstd": numcodecs.Zstd(),
            "gzip": numcodecs.GZip(),
            "blosc-lz4": numcodecs.Blosc(cname="lz4", clevel=5, shuffle=numcodecs.Blosc.SHUFFLE),
            "none": None,
        }[opts.compressor]
        byte_order = "<" if opts.endian == "little" else ">"
        return {
            "dtype": np.dtype(dtype).newbyteorder(byte_order),
            "compressors": compressor,
            "order": opts.order,
            "chunk_key_encoding": {"name": "v2", "separator": opts.dimension_separator},
        }
    compressors = {
        "zstd": [ZstdCodec()],
        "gzip": [GzipCodec()],
        "blosc-lz4": [BloscCodec(cname="lz4", clevel=5, shuffle="shuffle")],
        "none": [],
    }[opts.compressor]
    if opts.checksum:
        compressors.append(Crc32cCodec())
    filters = [TransposeCodec(order=tuple(reversed(range(ndim))))] if opts.order == "F" else []
    return {
        "dtype": dtype,
        "dimension_names": axis_names,
        "filters": filters,
        "serializer": BytesCodec(endian=opts.endian),
        "compressors": compressors,
    }


def write_level(store: zarr.storage.LocalStore, prefix: str, opts: Options, level: Level, tile: int) -> None:
    leading_shape = tuple(size for _, size in opts.leading_axes)
    leading_ones = (1,) * len(leading_shape)
    chunk = opts.chunk_for(level)
    level_path = f"{opts.level_prefix}{level.index}"
    array = zarr.create_array(
        store=store,
        name=f"{prefix}/{level_path}" if prefix else level_path,
        shape=leading_shape + level.shape,
        chunks=leading_ones + chunk,
        shards=(leading_ones + opts.shard) if opts.shard else None,
        fill_value=0,
        # Level 0 of a level-index pyramid is all zeros, equal to the fill
        # value; the default would elide its chunks and make a written level
        # look unwritten.
        config={"write_empty_chunks": True},
        zarr_format=opts.zarr_version,
        **storage_arguments(opts, opts.dtype, opts.axis_names),
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
                    values = np.full(extent, level.index, dtype=opts.dtype)
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
    levels = plan_levels(opts, opts.size)
    name = opts.out.name.split(".")[0] or "synthetic"
    store = zarr.storage.LocalStore(str(opts.out))

    if opts.tiles is None:
        write_image(store, "", opts, levels, tile=0, name=name)
        consolidate(store, opts)
        return levels

    zarr.create_group(store=store, attributes=collection_attributes(opts, opts.tiles, name), zarr_format=opts.zarr_version)
    rows, columns = tile_grid(opts.tiles)
    for row in range(rows):
        zarr.create_group(store=store, path=row_name(row), zarr_format=opts.zarr_version)
    for tile in range(opts.tiles):
        group_path = tile_group_path(tile, columns)
        group_attributes = ome_attributes(opts, {"well": {"images": [{"path": "0"}]}})
        zarr.create_group(store=store, path=group_path, attributes=group_attributes, zarr_format=opts.zarr_version)
        tile_levels = plan_levels(opts, opts.size_of(tile))
        write_image(store, f"{group_path}/0", opts, tile_levels, tile=tile, name=f"{name} {group_path}")
    consolidate(store, opts)
    return levels


def consolidate(store: zarr.storage.LocalStore, opts: Options) -> None:
    if opts.consolidated:
        zarr.consolidate_metadata(store, zarr_format=opts.zarr_version)


def main(argv: Sequence[str] | None = None) -> int:
    opts = parse_args(argv)
    levels = generate(opts)
    layout = f"sharded {opts.shard}" if opts.shard else "unsharded"
    what = f"collection of {opts.tiles} tiles" if opts.tiles else "image"
    if opts.labels:
        what += f" with the label {LABEL_NAME}"
    shapes = ", ".join("x".join(str(s) for s in level.shape) for level in levels)
    chunks = ", ".join("x".join(str(s) for s in opts.chunk_for(level)) for level in levels)
    print(f"wrote {opts.out}: {what}, {layout}, chunks [{chunks}], levels [{shapes}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
