# Synthetic OME-Zarr fixtures

Small OME-Zarr 0.5 datasets for offline tests, written by
`extras/synthetic_ome_zarr.py`. None is larger than 20 KB. Generate anything
larger on demand with the same script rather than committing it.

## The generator

The script declares its dependencies inline, so uv runs it with no setup:

```sh
uv run extras/synthetic_ome_zarr.py OUT.ome.zarr [options]
```

Options choose a single image or a collection of N tiles, a 2D or 3D size,
channel and timepoint counts, the number of levels, the scale factor per
level, the chunk shape, the shard shape, a sparse pyramid, unwritten levels,
and the level-index picture. A factor is one value, per-axis values such as
`1,2,2`, or a different factor for each level. `uv run
extras/synthetic_ome_zarr.py --help` and the docstring at the top of the
script describe each flag.

Two properties the tests rely on:

- **Layout never changes the samples.** The picture is a function of the
  seed and of position in level 0's coordinate space, so a sharded dataset
  and an unsharded one written with the same options hold identical values,
  and each level samples the same picture at its own sample spacing.
- **All-zero chunks are written.** Level 0 of a level-index pyramid holds
  only zeros, which equals the fill value. The generator writes those chunks
  anyway, so a reader can tell a written level from an unwritten one.

The generator's own tests run with `uv run extras/test_synthetic_ome_zarr.py`.

## Committed fixtures

`regenerate.sh` holds the exact command for each one. Run it to rewrite them
all, and commit the result.

| Fixture | Contents | What it exercises |
| --- | --- | --- |
| `twin-unsharded.ome.zarr` | 2D, 40×40, two channels, three levels, 8×8 chunks, one object per chunk | The layout lucida's import reads today. The reference half of the twin pair. |
| `twin-sharded.ome.zarr` | The same options and seed, with 16×16 shards of four inner chunks each | Identical samples behind the sharding codec, including partial shards and partial chunks at the edges. |
| `sparse-sharded.ome.zarr` | 2D, 32×32, three levels, 8×8 chunks, 16×16 shards; a checkerboard of inner chunks is absent from every shard index at levels 0 and 1; level 2 is declared but has no chunk | A missing inner chunk reading as fill, and an unwritten sharded level. |
| `level-index.ome.zarr` | 3D, 32×64×64, four levels halving every axis, 16×16×16 chunks, one object per chunk; every sample at level L is L | Which level rendered, read straight off a screenshot or a decoded chunk. |
| `collection-unsharded.ome.zarr` | Three 24×24 tiles on a 2×2 grid with one slot empty, two levels, the second shrinking y by 3 and x by 2 | The collection layout and an irregular per-axis factor through lucida's import. |

Sample values are `uint16` in every fixture, and the codec chain is `bytes`
(little-endian) followed by `zstd`. A sharded fixture wraps that same chain in
`sharding_indexed` with the index at the end of each shard.

## How the tests use them

- **Store.** `lucida-store/src/import.rs` imports both twins,
  `level-index.ome.zarr`, and `collection-unsharded.ome.zarr` and asserts the
  level shapes, chunk shapes, scales, tiles, and codec the metadata declares.
  The sharded twin reports its inner chunk shape, so the two twins import to
  the same geometry. `lucida-store/src/shard.rs` reads every inner chunk of
  the sharded twin through the shard index, and reads the missing inner
  chunks and the unwritten level of `sparse-sharded.ome.zarr` the same way.
  The import of `sparse-sharded.ome.zarr` names its unwritten level and
  leaves the two sparse levels alone. The checkerboard always writes the
  origin inner chunk, so an origin shard whose index leaves it out is a
  hand-built sharded store in the same test module.
- **Server.** `lucida-server/tests/synthetic_fixtures_e2e.rs` resolves chunk
  keys against the same fixtures and decodes the objects they name, checking
  that every sample of level L reads back as L and that the twin's channels
  carry distinct pictures. `lucida-server/tests/sharded_fixtures_e2e.rs`
  serves both twins through the chunk-read pipeline, through generated
  coarse, and over a socket, and asserts identical bytes for every chunk
  key. `lucida-server/src/dataset_open.rs` opens `sparse-sharded.ome.zarr`
  and asserts that dataset health degrades and names the unwritten level.
- **End to end.** Generate a large dataset on demand and open it with the
  trace driver, which drives the page at device pixel ratio 2 by default:

  ```sh
  uv run extras/synthetic_ome_zarr.py /tmp/big.ome.zarr --tiles 216 --size 2048,2048 --channels 3 --chunk 64 --shard 512
  lucida trace /tmp/big.ome.zarr --screenshot /tmp/big.png
  ```

  `--screenshot` writes the frame the page shows once it has settled, at
  the run's device pixel ratio. A level-index pyramid opened the same way
  tells a screenshot check which level the viewer chose, because the sample
  values are the level number.

## The sharded twin check

`extras/verify_sharded_twins.py` proves the sharded store end to end. It
writes two twin pairs with the generator, opens each dataset through the
trace driver in its own workspace at device pixel ratio 2, and asserts that
every run settled, that each pair's two frames are not blank and match to
within one level of an 8-bit channel, that every backend read in a sharded
run moved exactly one inner chunk, one shard index, or the two together, and
that every read in an unsharded run moved one whole chunk object. The
expected sizes come from the shard indexes on disk, so the read comparison
is exact. The frame tolerance is what two page loads of one dataset differ
by; a wrong inner chunk moves pixels by far more. The second pair has a
single source level too large to serve as the coarse tier, so the server
generates a coarse level over the sharded source, and the check asserts
that both runs requested that level and still match. That pair is one image
whose source grid stays under the 32 chunks the server generates on its own
after an open, and the check waits for that fill before it opens the view,
because a static view never asks for the rest (issue #1034).

It needs a running server that serves a built web bundle, the `lucida` CLI,
and Chrome. From the repository root:

```sh
(cd lucida-web && pnpm run build)
cargo run -p lucida-server &
uv run extras/verify_sharded_twins.py
```

Pass `--server` for a server elsewhere, `--lucida` to name the CLI, and
`--keep` to keep the datasets, frames, and run files. On failure they are
always kept, and the report says where. `uv run
extras/verify_sharded_twins.py --help` lists the generator options the two
pairs use.

The byte count each backend read moved travels in the server's timing rows
as `backend_bytes`, which is how a trace can show that a shard was read by
the inner chunk and never downloaded whole. The check's own tests run with
`uv run extras/test_verify_sharded_twins.py` and need neither a server nor a
browser.

The Rust tests locate the fixtures relative to `CARGO_MANIFEST_DIR`, so they
run from any working directory.
