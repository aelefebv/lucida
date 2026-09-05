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
level, the chunk shape per level, the shard shape, a sparse pyramid,
unwritten levels, and the level-index picture. A factor or a chunk shape is
one value, per-axis values such as `1,2,2`, or a different one for each
level. `uv run extras/synthetic_ome_zarr.py --help` and the docstring at the
top of the script describe each flag.

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
  the run's device pixel ratio. `--pin-contrast` keeps the dataset's
  contrast window at its default instead of fitting it to the data as it
  arrives; without it, two runs of one dataset can draw the same data a
  level apart, because the fit samples whatever is resident when it runs.
  A level-index pyramid opened the same way tells a screenshot check which
  level the viewer chose, because the sample values are the level number.

## The level chain check

`extras/verify_level_chain.py` proves the target level end to end. It
writes a level-index pyramid with the generator and opens it four times
through the trace driver at device pixel ratio 2: zoomed in and zoomed out,
in slice mode and in volume mode. Each run names the level it must reach,
and the check places the camera in the middle of the band of zooms that
level owns, measured in device pixels per level-0 sample. Four independent
answers must then name the same level: the rule of ADR 0061 applied to the
level shapes on disk, the target level `lucida-core` records for the
composed camera, the target level on the trace's last planning pass, and
the gray the frame shows, because every sample at level L holds the value
L. Each run must also reach quiescence, and the detail chunks it requested
per planning pass must fit the wanted-set bound the ADR states. The
zoomed-in slice run places the image past the viewport's edges, so its set
is cut by the screen rather than by the level.

The runs pin a gray colormap and a contrast window of −1 to the coarsest
level, so level L draws as `(L + 1) / levels` of white and the frame is
never black or the background color. The volume runs use the
maximum-intensity render mode and stay off level 0, because the ray march
skips a zero sample as empty space and every sample at level 0 is 0.

It needs the same server, CLI, and Chrome as the sharded twin check:

```sh
(cd lucida-web && pnpm run build)
cargo run -p lucida-server &
uv run extras/verify_level_chain.py
```

`--slice-levels` and `--volume-levels` choose the levels the runs reach,
`--size`, `--levels`, and `--chunk` shape the pyramid, and `--dataset`
reuses a level-index pyramid already on disk. The check's own tests run
with `uv run extras/test_verify_level_chain.py` and need neither a server
nor a browser. The measurement that fills the ADR's numbers, a wide
collection zoomed out with and without the level rule, is
`docs/research/level-chain-harness/`.

## The sharded twin check

`extras/verify_sharded_twins.py` proves reading a sharded dataset end to
end. It writes two twin pairs with the generator and opens each dataset
through the trace driver, in its own workspace, at device pixel ratio 2.
Then it checks what came back. Every run reached quiescence. Each pair's
two frames are the size the viewport makes at that ratio, not blank, and
identical pixel for pixel. Every backend read in a sharded run waited on
the chunk read cap and moved exactly the inner chunks it carried, one shard
index, or both. A read may carry one inner chunk or a byte-contiguous
stretch of one shard's inner chunks merged into one read. Every read in an
unsharded run moved one whole chunk object.

The expected sizes come from the shard indexes on disk, so the read
comparison is exact. The check also asserts that the view wanted no shard
whole. That is the one case where a shard downloaded whole has the same
length as a legitimate merged read. Every run passes `--pin-contrast`,
because the default contrast fit samples whatever is resident when it runs,
and two runs of one dataset then draw the same data a level apart (issue
#1037).

The second pair has a single source level too large to serve as the coarse
tier, so the server generates a coarse level over the sharded source. The
check asserts that both runs requested that level and still match. The pair
is one image whose source grid stays under the 32 chunks the server
generates on its own after an open, and the check waits for that fill
before it opens the view, because a static view never asks for the rest
(issue #1034). The fill reads the whole source, so the server answers the
pair's own requests from its cache and the read audit is the first pair's
job. Point `--generated-cache-dir` at the server's generated coarse cache
and the check compares the two generated tiers byte for byte as well.

It needs a running server that serves a built web bundle, the `lucida` CLI,
and Chrome. From the repository root:

```sh
(cd lucida-web && pnpm run build)
LUCIDA_GENERATED_COARSE_CACHE_DIR=/tmp/lucida-coarse cargo run -p lucida-server &
uv run extras/verify_sharded_twins.py --generated-cache-dir /tmp/lucida-coarse
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
