# Synthetic OME-Zarr fixtures

Small OME-Zarr datasets for offline tests, written by
`extras/synthetic_ome_zarr.py`. None is larger than 20 KB. Generate anything
larger on demand with the same script rather than committing it:

```sh
uv run extras/synthetic_ome_zarr.py OUT.ome.zarr [options]
```

`--help` and the docstring at the top of the script describe each option. The
generator's own tests run with `uv run extras/test_synthetic_ome_zarr.py`.

Two properties the tests rely on:

- Layout never changes the samples. The picture is a function of the seed and
  of position in level 0's coordinate space, so a sharded dataset and an
  unsharded one written with the same options hold identical values, and each
  level samples the same picture at its own sample spacing.
- All-zero chunks are written. Level 0 of a level-index pyramid holds only
  zeros, which equals the fill value. The generator writes those chunks anyway,
  so a reader can tell a written level from an unwritten one.

## Committed fixtures

`regenerate.sh` holds the exact command for each one. Run it to rewrite them
all, and commit the result. The generator's tests fail if the committed
fixtures differ from what it writes.

| Fixture | Contents | What it exercises |
| --- | --- | --- |
| `twin-unsharded.ome.zarr` | 2D, 40×40, two channels, three levels, 8×8 chunks, one object per chunk | The unsharded reference half of the twin pair. |
| `twin-sharded.ome.zarr` | The same options and seed, with 16×16 shards of four inner chunks each | Identical samples behind the sharding codec, including partial shards and partial chunks at the edges. |
| `sparse-sharded.ome.zarr` | 2D, 32×32, three levels, 8×8 chunks, 16×16 shards; a checkerboard of inner chunks is absent from every shard index at levels 0 and 1; level 2 is declared but has no chunk | A missing inner chunk reading as fill, and an unwritten sharded level. |
| `level-index.ome.zarr` | 3D, 32×64×64, four levels halving every axis, 16×16×16 chunks, one object per chunk; every sample at level L is L | Which level rendered, read straight off a screenshot or a decoded chunk. |
| `collection-unsharded.ome.zarr` | Three 24×24 tiles on a 2×2 grid with one slot empty, two levels, the second shrinking y by 3 and x by 2 | The collection layout and an irregular per-axis factor through lucida's import. |
| `collection-mixed.ome.zarr` | Three tiles on a 2×2 grid, two channels, two levels; the tiles are 14×12, 16×16, and 12×10; level 0 is chunked 8×8 and level 1 is one chunk the size of each tile's level (7×6, 8×8, or 6×5) | Tiles whose level shapes and chunk shapes differ, served at one declared geometry. |
| `v2-twin.ome.zarr` | `twin-unsharded` as OME-NGFF 0.4 on Zarr v2, compressed with Blosc (lz4, byte shuffle) | The Zarr v2 reader and numcodecs' default compressor. |
| `v3-codec-chain.ome.zarr` | `twin-unsharded` with the chain `transpose`, `bytes` (big-endian), `gzip`, `crc32c` | A Zarr v3 chain beyond `bytes` and one compressor. |
| `v2-collection.ome.zarr` | `collection-unsharded` as OME-NGFF 0.4 on Zarr v2, in Fortran order, big-endian, with `.` between chunk coordinates | A Zarr v2 collection, and the v2 options that change how a chunk is laid out. |
| `v3-level-paths.ome.zarr` | `twin-sharded` with its level arrays named `s0`, `s1`, `s2` | Levels found by their multiscale path, not their index, through shards. |
| `v2-consolidated.ome.zarr` | `collection-unsharded` as OME-NGFF 0.4 on Zarr v2, with levels named `s0` and `s1` and every metadata document consolidated into `.zmetadata` | Named levels in a collection, and an open that reads only the root's metadata. |

Sample values are `uint16` in every fixture. Unless the table says otherwise,
the dataset is OME-Zarr 0.5 on Zarr v3 and its codec chain is `bytes`
(little-endian) followed by `zstd`. A sharded fixture wraps that same chain in
`sharding_indexed` with the index at the end of each shard. Each fixture in the
last five rows holds the same samples as its twin.

## End-to-end checks

Three scripts in `extras/` generate their own datasets and open them through
the trace driver at device pixel ratio 2: `verify_level_chain.py` (the target
level), `verify_trace_script.py` (scripted steps), and
`verify_sharded_twins.py` (sharded and unsharded twins draw the same frames,
and sharded runs read by the inner chunk). Each script's docstring says what it
asserts and lists its options, and its `test_` sibling runs without a server.
They need a server serving a built web bundle, the `lucida` CLI, and Chrome:

```sh
(cd lucida-web && pnpm run build)
LUCIDA_GENERATED_COARSE_CACHE_DIR=/tmp/lucida-coarse cargo run -p lucida-server &
uv run extras/verify_level_chain.py
uv run extras/verify_trace_script.py
uv run extras/verify_sharded_twins.py --generated-cache-dir /tmp/lucida-coarse
```

`scripts/trace_gate.sh` runs `lucida trace --gate` over generated datasets at
device pixel ratio 1 and 2, against the same kind of server. The `Trace gate`
workflow runs it nightly in headless Chrome on SwiftShader.

`docs/research/level-chain-harness/` measures the target level against level 0
pinned.
