---
type: Gotcha
title: "Non-canonical axes are pinned to index 0"
description: "OME-Zarr datasets exported from CZI (and some other Bioformats sources) may include axes outside the canonical Lucida set {t, c, z, y, x} — most commonly m (mosaic/scene enumeration), s, h, or r."
tags: [lucida, gotcha]
source_path: wiki/gotchas/non-canonical-axes.md
created: 2026-04-23
modified: 2026-07-06
---

# Non-canonical axes are pinned to index 0

OME-Zarr datasets exported from CZI (and some other Bioformats sources) may include axes outside the canonical Lucida set `{t, c, z, y, x}` — most commonly `m` (mosaic/scene enumeration), `s`, `h`, or `r`. When Lucida opens such a dataset it **silently pins each non-canonical axis to index `0`** and otherwise ignores it.

Concretely: a CZI mosaic with axes `[t, c, z, m, y, x]` and shape `[1, 4, 1, 6, 2048, 1504]` opens as a 5D image showing only `m=0`. The other five mosaic scenes are present on disk but are not exposed by the manifest.

When the on-disk chunk file *also bundles multiple pinned slices together* (e.g. `chunk_shape` is 2 along `m`), the path injection alone is not enough — the decoded buffer arrives 2× the canonical size. See "Prefix-slice handling" below.

## How to spot it

- The server log emits `[lucida-store] dataset {id}: axis 'm' (size 6) is non-canonical and was pinned to index 0` once per pinned axis at dataset-open time.
- `MultiscaleInfo.pinned_axes` on the wire carries the structured metadata: `{ name, size, pinned_index }` per dropped axis.
- `MultiscaleInfo.axes.length` will be `≤ 5`; the raw axes list lives only on the server-private `ImageBindingSeed.axes_names`.

## Why it works at all

The pin is plumbed through two seams:

1. `lucida-content::normalize::classify_axes` splits the raw OME axes list into canonical (`{t,c,z,y,x}`) and pinned (`PinnedAxis` per non-canonical name) — invoked at import time.
2. `lucida-store::chunk_key_to_store_path` walks the *raw* axes list (preserved on `ImageBindingSeed.axes_names`) and injects `"0"` at each non-canonical position when constructing on-disk Zarr v3 chunk paths. So the canonical 5D logical chunk key still resolves to the right byte range on disk.

Without (2), every chunk fetch would 404 because the path would be missing the `m` coordinate component.

## Post-decode byte slicing

The path-injection trick covers the case where each canonical chunk lives in its own on-disk file. Two situations bundle multiple canonical-chunks worth of data into one on-disk file:

1. **Pinned axes with `chunk_size > 1`** (CZI mosaics, PRD #447). `chunk_shape` along `m` is often `2`, so a single on-disk chunk contains both `m=0` and `m=1`. The server reads the right file but the buffer is `2×` the canonical size.
2. **Canonical-indexed axes (`t`, `c`) with `chunk_size > 1`** (LIF/Bioformats multichannel exports, PRD #451). `chunk_shape[c] = 5` packs all 5 channels into a single on-disk chunk; wire requests for ch0–ch4 all need the same disk file but different byte ranges within it.

Both cases share one mechanism: byte-level slicing at the decode step, computed once at import.

- `lucida-store::layout::compute_chunk_byte_layout` runs at import per level and returns `ChunkByteLayout { canonical_byte_size, on_disk_byte_size, byte_stride_t, byte_stride_c, chunk_size_t, chunk_size_c }`.
- `ChunkByteLayout::slice_range(wire_t, wire_c) -> (offset, size)` is the single seam used by `serve_chunk_from_store` and `build_server_proxy_source`. It reduces wire `t/c` voxel coords to intra-chunk indices (`wire_value % chunk_size`) and returns the byte range to extract from the decompressed bytes. For canonical 5D and pinned-only datasets, the result is `(0, canonical_byte_size)` — equivalent to the pre-PRD-#451 `bytes.truncate(canonical_byte_size)` path.
- The per-level layout is carried on the server-private binding seed (see [lucida-store](../systems/crates/lucida-store.md#binding-seed-shape)).

### Eligibility rule (unified outer/inner)

Slicing is only correct when the requested wire-chunk slice falls in a *contiguous range* of the on-disk byte buffer. In C-order byte layout that holds iff, after eliminating axes whose `chunk_size == 1`, every "outer" axis precedes every "inner" axis in the raw axes list:

- **Outer set** = pinned axes ∪ canonical-indexed axes (`t`, `c`)
- **Inner set** = canonical-kept axes (`z`, `y`, `x`)

When the rule holds, the wire-chunk slice for `(intra_t, intra_c)` (with all pinned coords = 0) is contiguous starting at `intra_t × byte_stride_t + intra_c × byte_stride_c` with length `canonical_byte_size`.

Examples that satisfy the rule:

- `[t, c, z, m, y, x]` with `chunk_shape = [1, 1, 1, 2, 2048, 1504]` — outer `m` (chunk>1) precedes inner `y, x` (chunk>1). Pinned `m=0` slice is the first `2048 × 1504 × 2` bytes of a `2 × 2048 × 1504 × 2` on-disk chunk.
- `[t, c, z, y, x]` with `chunk_shape = [1, 5, 1, 1024, 1024]` (the lif_test case) — outer `c` (chunk=5) precedes inner `y, x` (chunk>1). Wire `c=3` slice is bytes `[6 MB .. 8 MB]` of a 10 MB on-disk chunk.
- `[t, c, z, m, y, x]` with `chunk_shape = [1, 5, 1, 2, 1024, 1024]` — both `c` (canonical-indexed) and `m` (pinned) are outer; both precede `y, x`. Eligible.

Examples rejected at import:

- `[t, c, z, y, m, x]` with `y_chunk > 1` and `m_chunk > 1` — `m` (outer, pinned) follows `y` (inner, kept canonical). Error: `axis 'm' ... non-canonical (pinned) ... non-prefix position`.
- `[t, z, c, y, x]` with `z_chunk > 1` and `c_chunk > 1` — `c` (outer, canonical-indexed) follows `z` (inner, kept canonical). Error: `axis 'c' ... canonical-indexed (t/c) ... non-prefix position`.

The "drop axes with `chunk_size == 1`" relaxation matters: many real exports have intermediate axes with chunk_size 1 (e.g. `z`, `t`) that don't iterate within a chunk, so their position relative to "outer" axes doesn't constrain anything.

## What this is not

- **Not a scene picker.** There is no UI today to choose which `m` index to view. The pinned index is hard-coded to `0`.
- **Not a fan-out.** Each `m` index is *not* surfaced as a sibling image (the way collection tiles are). For CZI mosaics where each `m` is an independent physical scene, this means you only see the first scene; the other scenes are invisible.
- **Not a Lucida storage choice.** Lucida's own ingest writer (`lucida-store::ingest::ome_metadata`) always emits canonical 5D zarrs. The pin only matters when *reading* third-party non-canonical zarrs.

## Related

- [Blosc support is a deliberately narrow subset](blosc-support.md) — the storage codec used by every CZI export in the wild; codec validation now happens at import alongside the prefix-eligibility check.
- [lucida-store](../systems/crates/lucida-store.md) — where `compute_chunk_byte_layout` and the codec validator live.
