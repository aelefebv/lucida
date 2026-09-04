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
