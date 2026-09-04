# Data layout guide

lucida reads OME-Zarr 0.5 stores one chunk at a time, and it reads only the
chunks the screen needs. The layout a writer chooses decides how many reads a
view costs and how many bytes each read moves. This guide recommends one
layout and says, for each choice, which viewer behavior it serves.

The numbers here are starting points for measurement, not requirements. A
store that uses different numbers still opens. Measure with your own data over
your own link, then adjust. The last section says how.

One part of this guide describes behavior that is still being built. Everything
it says about the target level is what
[issue #989](https://github.com/aelefebv/lucida/issues/989) adds. The choice of
level has landed already, so the target follows the screen unless a level pin
holds it at one level. The rest applies today. Import accepts the sharding
codec and the viewer reads inner chunks out of shards, and what remains of
[issue #990](https://github.com/aelefebv/lucida/issues/990) changes nothing
about the layout to write.

## How the viewer reads a store

The viewer plans a wanted set: the chunks the current view calls for, at one
pyramid level, for the timepoints and channels on screen. The server reads each
one from the object store, decodes it, and sends it as one wire chunk: one
timepoint, one channel, and the full spatial extent of one chunk. Nothing reads
a whole array.

Two residency tiers hold what arrives. The detail tier holds the level under
inspection. The coarse tier holds one level per image that is small enough to
stand for the whole image at one timepoint and channel. It is the floor under
the detail tier, and the minimap draws from it.

Over a remote object store, a view is bounded by how many reads per second the
link completes. One measured link climbed to about 57 reads per second at a
concurrency of 16 and went no higher at any concurrency above it, with bytes
per second flattening at the same point. The measurement is in
[Source-read concurrency](research/source-read-concurrency.md). So a layout
should need few reads per view, and no read should carry bytes the screen
never shows.

## The recommended layout

| Choice | Starting point |
| --- | --- |
| Inner chunk, time and channel axes | 1 timepoint, 1 channel |
| Inner chunk, spatial axes | 256 × 256 samples in 2D, 64 × 64 × 64 in 3D |
| Shard | 8 × 8 inner chunks in 2D, 4 × 4 × 4 in 3D |
| Shard index | At the end of the shard |
| Pyramid step | Halve each in-plane axis per level |
| Downsampling | Mean or area, recorded in the multiscale metadata |
| Coarsest level | Fits in one shard |
| Codec chain | `bytes` little endian, then `zstd`, `lz4`, `blosc`, or nothing |

The following sections take each row in turn.

### One timepoint and one channel per inner chunk

A wire chunk carries one timepoint and one channel. When an inner chunk bundles
several, the server decodes the whole bundle and slices out the one the request
names, so each step of a scrub through time, and each change of channel,
decodes every bundled member to show one. A bundled store still opens, and
bundling composes with sharding, but it multiplies the decode work behind every
scrub.

### The spatial shape of an inner chunk

The inner chunk is the unit the viewer fetches, decodes, uploads, and evicts,
so its shape sets the size of every unit downstream. A smaller chunk wastes
fewer bytes at the edge of the view and lets the upload budget of 8 MiB per
frame carry more of the view in each frame. A larger chunk costs fewer reads.
256 × 256 samples in 2D and 64 × 64 × 64 in 3D sit between the two, at 128 KiB
and 512 KiB per chunk for 16-bit samples.

Two limits bound the choice. The renderer keeps one GPU pool per distinct chunk
shape in a dataset, so use the same inner chunk shape at every level of an
image. A 3D chunk must also fit in a 3D texture, and WebGPU guarantees only
2048 samples per axis.

The inner chunk shape is also where this layout meets the screen-chosen target
level. See
[Where the inner chunk shape meets the target level](#where-the-inner-chunk-shape-meets-the-target-level).

### A shard of 64 inner chunks

Without shards, each chunk is one object, and a large image at 256 × 256
becomes hundreds of thousands of objects that are slow to write, list, and
read. A shard packs a fixed grid of inner chunks into one object with an index
that says where each one lies. The object count falls by the shard's size while
the read unit stays the inner chunk. The viewer reads the index once per shard,
caches it for as long as the dataset is open, and then reads each inner chunk
it needs as one range read from the same object. Range reads that wait for a
source-read permit together and whose bytes lie next to each other in the
shard go out as one request, so a run of neighbouring inner chunks costs one
round trip when the link is busy. zarr-python writes a shard's inner chunks in
position order, which puts a run along the last axis end to end; a writer that
orders them another way keeps a working store and loses the merge.

A shard of 64 inner chunks is about one screen. With the shapes in this guide, a
2D shard covers 2048 × 2048 samples, close to one high-density display at the
target level, so one view touches a few shards and a pan reuses the indexes it
already holds. The index of a 64-chunk shard is 1,028 bytes, one small read.

Do not nest shards. The viewer reads one level of sharding, with the codec
chain inside it.

### The index at the end of the shard

The viewer reads the index with one range read wherever it lies and never asks
for the object's size first, so the location changes nothing about what the
viewer does. It changes how the shard is written. The end is the default that
writing tools produce, and it lets a writer stream inner chunks into a shard
and close it with the index, so a shard is written once. Match the default
unless you have a reason not to.

### Halve each in-plane axis per level

The shaders show one level at a time and never blend between levels, so the
level on screen is at most one pyramid step away from the sampling the screen
calls for. A factor of two makes that step one octave. Whichever level is
nearest the screen, picked by hand today or by the screen under issue #989, is
then never more than twice as fine as the screen needs. The same factor makes
the coarser levels cheap to keep resident while a finer one arrives, which is
what #989 does. Each coarser level is a quarter of the previous one in 2D and
an eighth in 3D, so a whole chain of them adds about a third of the target
level's bytes.

Halve the in-plane axes at every level. Halve the depth axis too while its
spacing is no coarser than the in-plane spacing, and leave it alone once it is
coarser. The slice view chooses its level by the in-plane axes, so a level that
only halves depth gives it nothing new to show. The converter in
`extras/collection_to_ome_zarr.py` follows the same rule, halving whichever
axes are not already the coarsest.

Write every level you declare. On open, the viewer probes the origin chunk of
each level, and an unwritten level, one a store declares but never wrote chunks
for, renders as zeros and degrades the dataset's health. An export that stops
early does not fail to open. It shows a black picture with a warning beside it.

### Mean or area downsampling, recorded in the metadata

The shaders draw one stored sample per screen pixel without filtering, so a
coarser level is exactly what the screen shows at that zoom. A level
made by dropping samples shows a decimated, aliased picture, and the viewer has
nothing to correct it with. Average the samples that each coarser sample
replaces.

Record the method in the `type` field of the multiscales metadata, with any
parameters in its `metadata` object. lucida does not read that field yet, and a
viewer has no other way to learn how a level was made. Issue #989 plans to show
the method beside the level on screen, and a level written without it can only
ever be shown as a number. The in-repo converter writes `2x2 box average`.

### A coarsest level that fits in one shard

The coarse tier takes the coarsest level within its bounds: a long axis of at
most 2048 samples, at most 64 MiB decoded per timepoint and channel, at most
16 MiB per chunk, and at most 4,096 chunks. It fetches that level around every
visible image, per timepoint and channel, and a collection of hundreds of
members fetches hundreds of them on open. So the last level of the pyramid is
the floor whenever it fits, and its size sets the cost of opening.

Stop the pyramid no earlier than the level that fits in one shard. Each
member's floor is then one object, one index read and a burst of range reads,
so opening a collection costs one object per member for the floor. For a
collection, keep halving well past that point, down to
a few hundred samples on a side, because that floor is paid once per member.
The in-repo converter stops at 256. A pyramid with no level inside the bounds
makes the server generate one from the source data on first open.

### The codec chain

Import accepts `bytes` in little-endian order, alone or followed by one of
`zstd`, `lz4`, or `blosc` with `zstd` inside. Under sharding, that is the
chain inside the sharding codec, and the index uses `bytes` and `crc32c`.
Sample types are `uint8`, `uint16`, `uint32`, `float32`, and `float64`.

## Where the inner chunk shape meets the target level

The target level and sharding both depend on the inner chunk shape, for
opposite reasons.

Issue #989 makes the target level follow the screen. Once it does, the screen
bounds the wanted set. The viewer wants at most the viewport's area
divided by one chunk's footprint at the target level, however large the image
or the collection. The inner chunk shape sets that footprint. A 3200 × 2000
device-pixel viewport over 256 × 256 chunks wants about 100 chunks. Over
1024 × 1024 chunks it wants about 10, each carrying 16 times the bytes, with
most of every edge chunk off screen. Over 64 × 64 chunks it wants about 1,600
reads.

Sharding is what makes the small end of that range affordable. Without it,
256 × 256 chunks turn a 100,000 × 100,000 image into about 150,000 objects at
level 0 alone. With 8 × 8 shards, that is about 2,400. The level rule wants
inner chunks small enough that a view costs bytes in proportion to the screen,
and sharding keeps that from costing objects in proportion to the image. The
inner chunk shape is the one number both read, and 256 × 256 is where this
guide starts.

## Write it with zarr-python

zarr-python 3 writes this layout directly. The `chunks` argument is the inner
chunk shape and `shards` is the shard shape. The following example creates
level 0 of a 2D dataset with three channels, on axes `t, c, z, y, x` with a
depth of one:

```python
import zarr
from zarr.codecs import ZstdCodec

root = zarr.create_group("dataset.zarr")
level_0 = root.create_array(
    "0",
    shape=(1, 3, 1, 40_000, 60_000),
    chunks=(1, 1, 1, 256, 256),
    shards=(1, 1, 1, 2048, 2048),
    dtype="uint16",
    compressors=ZstdCodec(level=3),
)
```

For 3D data, use `chunks=(1, 1, 64, 64, 64)` and
`shards=(1, 1, 256, 256, 256)`. Until sharded reading lands, leave `shards`
out and keep `chunks` as it is.

In the resulting `zarr.json`, the `chunk_grid` holds the shard shape and the
`sharding_indexed` codec's own `chunk_shape` holds the inner chunk shape.
lucida's chunk keys address the inner chunk. Write the multiscales metadata for
each level with its `scale` transform and the `type` field described earlier.

## Measure before you settle on a layout

The trace driver opens a dataset in a headless browser, waits for the run to
become quiescent, and writes a trace whose diagnostic names the phase that
dominated. Run it against a candidate layout and against a second one, then
compare:

```bash
lucida trace gs://bucket/dataset.zarr
```

If the diagnostic attributes the run to network first byte or to queue wait,
the layout asks for too many reads. If it attributes the run to upload, the
chunks are too large for the per-frame budget. Change one row of the table at
a time.
