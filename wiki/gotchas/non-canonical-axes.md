---
created: 2026-04-23
modified: 2026-04-23
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

## Prefix-slice handling (post-Slice 1)

The path-injection trick covers the case where each canonical chunk lives in its own on-disk file. CZI mosaics commonly violate that assumption: `chunk_shape` along `m` is often `2`, so a single on-disk chunk byte stream contains both `m=0` and `m=1`. After path injection the server reads the right file, but the buffer is twice as large as the canonical pipeline expects, and the client's `new Uint16Array(buf)` either explodes or paints garbage.

The fix is byte-level prefix slicing at the decode step, computed once at import.

- `lucida-store::layout::compute_chunk_byte_layout` runs at import per level and returns `ChunkByteLayout { canonical_byte_size, on_disk_byte_size, needs_slicing }`.
- When `needs_slicing == true`, `serve_chunk_from_store` (and `build_server_proxy_source`) decode the storage-compressed chunk and then truncate the resulting buffer to `canonical_byte_size` before shipping it to the client. This drops the trailing `m=1`/`m=2`/etc. slices that share the on-disk chunk file with `m=0`.
- The per-level layout is carried on the server-private binding seed (see [[lucida-store#interactions]]).

### Eligibility rule

Prefix slicing is only correct when the canonical-axes slice falls in a *contiguous prefix* of the on-disk byte buffer. In C-order byte layout that holds iff, after eliminating axes whose `chunk_size == 1` (those contribute a single index either way), every pinned axis comes before every canonical axis in the raw axes list. With all pinned coords = 0, the canonical sub-block then coincides with the first `canonical_byte_size` bytes.

Examples that satisfy the rule:

- `[t, c, z, m, y, x]` with `chunk_shape = [1, 1, 1, 2, 2048, 1504]` — all canonical axes (`t,c,z,y,x`) preceded by `m`. Canonical sub-block is the first `2048 × 1504 × 2 bytes` of an `2 × 2048 × 1504 × 2 bytes` on-disk chunk.
- `[m, t, c, z, y, x]` — same idea, pinned axis trivially first.

Examples rejected at import:

- `[t, c, z, y, m, x]` with `y_chunk > 1` — `y` (canonical) precedes `m` (pinned). With all pinned coords = 0 the canonical slice is interleaved every two `x`-rows, not a contiguous prefix. The error is roughly `axis 'm' (chunk_size 2) is non-canonical and falls in a non-prefix position`.

The "drop axes with `chunk_size == 1`" relaxation matters: many CZI exports have e.g. `t` or `z` as a non-canonical axis with chunk_size 1, where ordering doesn't matter because there is exactly one slice along that axis.

## What this is not

- **Not a scene picker.** There is no UI today to choose which `m` index to view. The pinned index is hard-coded to `0`.
- **Not a fan-out.** Each `m` index is *not* surfaced as a sibling image (the way plate FOVs are). For CZI mosaics where each `m` is an independent physical scene, this means you only see the first scene; the other scenes are invisible.
- **Not a Lucida storage choice.** Lucida's own ingest writer (`lucida-store::ingest::ome_metadata`) always emits canonical 5D zarrs. The pin only matters when *reading* third-party non-canonical zarrs.

## Related

- [[blosc-support]] — the storage codec used by every CZI export in the wild; codec validation now happens at import alongside the prefix-eligibility check.
- [[lucida-store]] — where `compute_chunk_byte_layout` and the codec validator live.
