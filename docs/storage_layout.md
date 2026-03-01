# Lucida S1 Storage Layout

This document describes the S1 cache layout validated by `storage_layout_validate`.

## Generation Root

For each source and generation, artifacts are stored at:

`<cache_root>/<source_id>/gen_<generation_seq>`

Example:

`/tmp/lucida-cache/src_00000001/gen_00000003`

## Required Paths

- `canonical.ome.zarr/.zattrs`
- `canonical.ome.zarr/0/.zarray`
- `tile2d/manifest.json`
- at least one `tile2d/**.tileblk`
- at least one `preview2d/lod_*.pgm`

## Optional Paths

- `brick3d/manifest.json`
- `brick3d/lod*/brick_*.blkpkg`

`brick3d` can be absent before first 3D demand because brick build is lazy.

## Validation Tool

Run:

```bash
cd engine
cargo run --bin storage_layout_validate -- <cache_root> <source_id> <generation_seq>
```

Output is JSON. Exit code is `0` when the layout is valid and `1` otherwise.
