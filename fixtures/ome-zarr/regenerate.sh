#!/usr/bin/env bash
# Rewrite every committed fixture from the generator.
#
# Usage: regenerate.sh [DEST]
#
# DEST defaults to this directory. The generator's tests pass a temporary
# directory and compare the result against the committed fixtures.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
gen="$repo/extras/synthetic_ome_zarr.py"
dest="${1:-$here}"
mkdir -p "$dest"

# 40 is a multiple of the 8-sample chunk but not of the 16-sample shard, and
# the coarser levels (20 and 10) are multiples of neither, so the twins hold
# both partial shards and partial chunks.
twin=(--size 40,40 --channels 2 --levels 3 --chunk 8 --seed 1 --overwrite)
uv run "$gen" "$dest/twin-unsharded.ome.zarr" "${twin[@]}"
uv run "$gen" "$dest/twin-sharded.ome.zarr" "${twin[@]}" --shard 16

uv run "$gen" "$dest/sparse-sharded.ome.zarr" \
  --size 32,32 --levels 3 --chunk 8 --shard 16 --sparse --unwritten-level 2 --seed 1 --overwrite

uv run "$gen" "$dest/level-index.ome.zarr" \
  --size 32,64,64 --levels 4 --chunk 16 --level-index --overwrite

# Three tiles fill a 2x2 grid, so one slot is empty.
uv run "$gen" "$dest/collection-unsharded.ome.zarr" \
  --tiles 3 --size 24,24 --levels 2 --factor 3,2 --chunk 8 --seed 1 --overwrite

# The first tile is smaller than the second and larger than the third, and level
# 1's chunk is clipped to each tile's level, so the tiles disagree on its shape.
uv run "$gen" "$dest/collection-mixed.ome.zarr" \
  --tiles 3 --size 14,12 --size 16,16 --size 12,10 --channels 2 --levels 2 \
  --chunk 8 --chunk 16 --clip-chunks --seed 1 --overwrite

# Twins of the two above in other formats and codec chains: the same options and
# seed, so the same samples.
uv run "$gen" "$dest/v2-twin.ome.zarr" "${twin[@]}" --zarr-version 2 --compressor blosc-lz4
uv run "$gen" "$dest/v3-codec-chain.ome.zarr" "${twin[@]}" \
  --order F --endian big --compressor gzip --checksum
uv run "$gen" "$dest/v2-collection.ome.zarr" \
  --tiles 3 --size 24,24 --levels 2 --factor 3,2 --chunk 8 --seed 1 --overwrite \
  --zarr-version 2 --order F --endian big --dimension-separator .

# Level arrays named s0, s1, ... rather than by their index.
uv run "$gen" "$dest/v3-level-paths.ome.zarr" "${twin[@]}" --shard 16 --level-prefix s
uv run "$gen" "$dest/v2-consolidated.ome.zarr" \
  --tiles 3 --size 24,24 --levels 2 --factor 3,2 --chunk 8 --seed 1 --overwrite \
  --zarr-version 2 --level-prefix s --consolidated
uv run "$gen" "$dest/v3-consolidated.ome.zarr" \
  --tiles 3 --size 24,24 --levels 2 --factor 3,2 --chunk 8 --seed 1 --overwrite \
  --level-prefix s --consolidated

# Data types past 32 bits and below float32, with values only their own type holds.
dtype=(--size 16,16 --levels 2 --chunk 8 --seed 1 --overwrite)
uv run "$gen" "$dest/dtype-int64.ome.zarr" "${dtype[@]}" --dtype int64 --range=-6000000000,6000000000
uv run "$gen" "$dest/dtype-uint64.ome.zarr" "${dtype[@]}" --dtype uint64 --range=0,18000000000000000000
uv run "$gen" "$dest/dtype-float16.ome.zarr" "${dtype[@]}" --dtype float16 --range=-1000,1000
