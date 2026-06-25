---
type: Gotcha
title: "Wire chunk keys: t/c are voxel coords, z/y/x are chunk-grid coords"
description: "The wire chunk key is level/t/c/z/y/x."
tags: [lucida, gotcha]
source_path: wiki/gotchas/wire-chunk-key-conventions.md
created: 2026-04-23
modified: 2026-06-25
---

# Wire chunk keys: t/c are voxel coords, z/y/x are chunk-grid coords

The wire chunk key is `level/t/c/z/y/x`. The five spatial values look symmetric, but they aren't: **`t` and `c` are voxel coordinates** (one per timepoint, one per channel) while **`z`, `y`, `x` are chunk-grid coordinates** (one per chunk along that axis). The asymmetry is invisible for the typical OME-Zarr where `chunk_shape[t] == chunk_shape[c] == 1` (one timepoint per chunk, one channel per chunk), but it becomes load-bearing for any export that bundles multiple timepoints or channels into a single on-disk chunk.

## Why the asymmetry exists

The web client's chunk planner ([lucida-web](../systems/crates/lucida-web.md) `pipeline/planning/`) iterates two axes differently:

- For **`z`, `y`, `x`** it walks chunk-grid cells (`for iz in zStart..zEnd`, etc.) — `iz` is already a chunk index by construction. Wire-coord = disk-grid-coord directly.
- For **`t`, `c`** it picks a single voxel value: `selection.t` (the current timepoint) and each `c` in `selection.visibleChannels`. Wire-coord = voxel index — which equals disk-grid-coord *only when* `chunk_shape[axis] == 1`.

For `~99%` of OME-Zarrs the two interpretations coincide. The wire format codifies the convention rather than fixing the asymmetry — changing it would require restructuring the GPU atlas to store multiple channels/timepoints per slot.

## Where the divide and slice happen

Both happen on the server side, in the same `lucida-store` / `lucida-server` plumbing:

- **Disk path resolution** — `lucida-store::chunk_key_to_store_path(key, axes, chunk_shape)` divides wire `t` and `c` by `chunk_shape[axis]` to produce disk-grid coords. Wire `c=3` with `chunk_shape[c]=5` becomes disk c-coord `3 / 5 = 0`.
- **Byte slicing** — `serve_chunk_from_store` (and `proxy::server_source::fetch_dense_volume`) call `level_info.chunk_byte_layout.slice_range(wire_t, wire_c)`. The method reduces to intra-chunk indices (`wire_value % chunk_size`) and returns the byte range to extract from the decompressed on-disk bytes. See [Non-canonical axes are pinned to index 0](non-canonical-axes.md#post-decode-byte-slicing).

The per-level `chunk_shape` and the precomputed strides live on the server-private binding seed (`LevelBindingInfo.chunk_shape`, `ChunkByteLayout.byte_stride_t/c`, `ChunkByteLayout.chunk_size_t/c`). See [lucida-store](../systems/crates/lucida-store.md#binding-seed-shape).

## Worked example: lif_test.ome.zarr

Axes `[t, c, z, y, x]`, shape `[1, 5, 1, 1024, 1024]`, chunk_shape `[1, 5, 1, 1024, 1024]`, dtype uint16. All 5 channels live in a single on-disk chunk file at `0/c/0/0/0/0/0`.

Web client wants channel 3:
1. Sends wire chunk key `0/0/3/0/0/0` (t=0, c=3, z=0, y=0, x=0).
2. Server's resolver: `c-axis disk-coord = 3 / 5 = 0` → resolves to disk path `0/c/0/0/0/0/0`.
3. Server fetches and decodes — gets 10 MB (5 channels × 2 MB).
4. Server's slice step: `slice_range(wire_t=0, wire_c=3)` → `(intra_t × byte_stride_t + intra_c × byte_stride_c, canonical_byte_size)` = `(0 + 3 × 2 MB, 2 MB)` = `(6 MB, 2 MB)`.
5. Server ships `bytes[6 MB .. 8 MB]` to the client as channel 3's chunk. Client uploads to GPU as channel 3's atlas slot.

Wire requests for `c=0,1,2,3,4` all resolve to the same disk file but extract different byte ranges (`(0,2MB)`, `(2MB,2MB)`, `(4MB,2MB)`, `(6MB,2MB)`, `(8MB,2MB)`).

## Why the client doesn't change

In principle the client could send a chunk-grid coord on `c` (always `0` for `lif_test`) and a separate "intra-chunk channel offset" — but then the GPU atlas would need to store multi-channel slots and the multichannel renderer would need to slice within an atlas slot. Both are larger blast-radius changes than the server-side divide-and-slice.

A side effect: the client's CPU cache holds N copies of the same disk chunk's data (one per visible channel slot), and the server re-decodes the same disk chunk N times when N channels are requested simultaneously. Both are inefficient but correct. The encoded-byte cache (`CachedStore`) hides the storage cost; decode dedup can come later if perf measurements show it matters.

## Related

- [Non-canonical axes are pinned to index 0](non-canonical-axes.md) — the eligibility rule that governs whether the slice is contiguous (extends to canonical-indexed `t`, `c` after PRD #451).
- [Blosc support is a deliberately narrow subset](blosc-support.md) — codec validation that runs in the same import phase as the chunk-shape eligibility check.
- [lucida-store](../systems/crates/lucida-store.md) — module map and binding-seed shape.
