# Data layout guide

lucida reads OME-Zarr 0.5 stores one chunk at a time, and only the chunks the
screen needs, so the layout decides how many reads a view costs and how many
bytes each read moves. This guide recommends one layout and says which viewer
behavior each choice serves. A store with other numbers still opens. Measure
before you settle, as the last section describes.

## How the viewer reads a store

The viewer plans a wanted set: the chunks the view calls for, at each image's
target level, for the timepoints and channels on screen. The target level is
the coarsest level that still puts a sample under every device pixel, unless a
level pin holds it. The server reads and decodes each chunk and sends it as one
wire chunk: one timepoint, one channel, and the full spatial extent of one
chunk. Nothing reads a whole array.

Over a remote object store, a view is bounded by how many reads per second the
link completes. One measured link plateaued at a concurrency of 16, near 57
reads per second, with bytes per second flattening at the same point
([ADR 0053](adr/0053-fair-share-source-read-admission.md)). So a layout should
need few reads per view, and no read should carry bytes the screen never shows.

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

### One timepoint and one channel per inner chunk

A wire chunk carries one timepoint and one channel. When an inner chunk bundles
several, the server decodes the whole bundle to slice out one, so every step of
a scrub through time or channels decodes every bundled member.

### The spatial shape of an inner chunk

The inner chunk is the unit the viewer fetches, decodes, uploads, and evicts. A
smaller chunk wastes fewer bytes at the edge of the view and lets the upload
budget of 8 MiB per frame carry more of the view each frame. A larger chunk
costs fewer reads. 256 × 256 in 2D and 64 × 64 × 64 in 3D sit between the two,
at 128 KiB and 512 KiB per chunk for 16-bit samples.

At the target level the screen bounds the wanted set: at most the viewport's
area divided by one chunk's footprint, however large the image or collection.
A 3200 × 2000 device-pixel viewport over 256 × 256 chunks wants about 100
chunks. Over 1024 × 1024 chunks it wants about 10, each carrying 16 times the
bytes, with most of every edge chunk off screen. Over 64 × 64 chunks it wants
about 1,600 reads.

Use the same inner chunk shape at every level of an image, because the renderer
keeps one GPU pool per distinct chunk shape. A 3D chunk must also fit in a 3D
texture, and WebGPU guarantees only 2048 samples per axis.

### A shard of 64 inner chunks

Without shards, each chunk is one object. At 256 × 256, a 100,000 × 100,000
image is about 150,000 objects at level 0 alone, slow to write, list, and read.
With 8 × 8 shards it is about 2,400, and the read unit stays the inner chunk.
Small inner chunks keep a view's bytes in proportion to the screen, and shards
keep them from costing objects in proportion to the image.

The viewer reads a shard's index once, caches it while the dataset is open, and
reads each inner chunk as one range read. Range reads that wait for a permit
together and lie end to end in the shard go out as one request
([ADR 0062](adr/0062-merged-range-reads-at-the-permit-queue.md)). zarr-python
writes inner chunks in position order, which puts a run along the last axis end
to end. A writer that orders them another way keeps a working store and loses
the merge.

A 2D shard of 8 × 8 covers 2048 × 2048 samples, about one high-density display
at the target level, so a view touches a few shards and a pan reuses the
indexes it holds. A 64-chunk index is 1,028 bytes, read in one range read
wherever it lies and without asking the object's size, so its location only
matters to the writer. The end is what writing tools default to, and it lets a writer
stream inner chunks and close the shard with the index. Do not nest shards:
import rejects a sharding codec inside another.

### Halve each in-plane axis per level

The shaders show one level at a time and never blend between levels. With a
factor of two, the target level is never more than twice as fine as the screen
needs. Coarser levels already resident stay on screen while the target
arrives, and they are cheap: the whole chain adds about a third of the target
level's bytes in 2D and a seventh in 3D.

Halve the depth axis too while its spacing is no coarser than the in-plane
spacing, then leave it alone. The slice view picks its level by the in-plane
axes, so a level that only halves depth gives it nothing new to show.
`extras/collection_to_ome_zarr.py` follows the same rule.

Write every level you declare. On open, the viewer probes the origin chunk of
each level. A level that is declared but has no chunks renders as zeros and
degrades the dataset's health, so an export that stops early opens as a black
picture with a warning beside it.

### Mean or area downsampling, recorded in the metadata

The shaders draw one stored sample per screen pixel without filtering, so a
coarser level is exactly what the screen shows at that zoom. A level made by
dropping samples shows an aliased picture the viewer cannot correct. Average
the samples each coarser sample replaces.

Record the method in the `type` field of the multiscales metadata, with any
parameters in its `metadata` object. Import reads `type`, and the layer panel
shows it beside the level. The in-repo converter writes `2x2 box average`.

### A coarsest level that fits in one shard

The coarse tier holds one level per image as the floor under the target
level, and the minimap draws from it. It takes the coarsest level within its
bounds: a long in-plane axis of at most 2048 samples, at most 64 MiB decoded per
timepoint and channel, at most 16 MiB per chunk, and at most 4,096 chunks. It
fetches that level for every visible image, so a collection of hundreds of
members fetches hundreds on open, and the size of the last level sets the cost
of opening.

Stop the pyramid no earlier than the level that fits in one shard, so each
image's floor is one object. For a collection, keep halving down to a few
hundred samples on a side, because the floor is paid once per member. The
in-repo converter stops at 256. A pyramid with no level inside the bounds makes
the server generate one from the source data on first open.

### The codec chain

Import accepts `bytes` in little-endian order, alone or followed by one of
`zstd`, `lz4`, or `blosc` with `zstd` inside. Under sharding, the sharding codec
is the only outer codec, this chain goes inside it, and the index uses `bytes`
optionally followed by `crc32c`. Sample types are `uint8`, `uint16`, `uint32`,
`float32`, and `float64`.

## Write it with zarr-python

zarr-python 3 writes this layout directly. `chunks` is the inner chunk shape
and `shards` is the shard shape. This creates level 0 of a 2D dataset with
three channels, on axes `t, c, z, y, x` with a depth of one:

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
`shards=(1, 1, 256, 256, 256)`. In the resulting `zarr.json`, the `chunk_grid`
holds the shard shape and the `sharding_indexed` codec's `chunk_shape` holds the
inner chunk shape, which is what lucida's chunk keys address. Write the
multiscales metadata for each level with its `scale` transform and the `type`
field.

## Measure before you settle on a layout

The trace driver opens a dataset in a headless browser, waits for the run to
become quiescent, and writes a trace whose diagnostic names the phase that
dominated. Run it against two candidate layouts and compare:

```bash
lucida trace gs://bucket/dataset.zarr
```

If the diagnostic leads with queue wait or with reads from the store, the
layout asks for too many reads. If it leads with upload, the chunks are too
large for the per-frame budget. Change one row of the table at a time.
