---
created: 2026-04-23
modified: 2026-04-23
---

# Non-canonical axes are pinned to index 0

OME-Zarr datasets exported from CZI (and some other Bioformats sources) may include axes outside the canonical Lucida set `{t, c, z, y, x}` — most commonly `m` (mosaic/scene enumeration), `s`, `h`, or `r`. When Lucida opens such a dataset it **silently pins each non-canonical axis to index `0`** and otherwise ignores it.

Concretely: a CZI mosaic with axes `[t, c, z, m, y, x]` and shape `[1, 4, 1, 6, 2048, 1504]` opens as a 5D image showing only `m=0`. The other five mosaic scenes are present on disk but are not exposed by the manifest.

## How to spot it

- The server log emits `[lucida-store] dataset {id}: axis 'm' (size 6) is non-canonical and was pinned to index 0` once per pinned axis at dataset-open time.
- `MultiscaleInfo.pinned_axes` on the wire carries the structured metadata: `{ name, size, pinned_index }` per dropped axis.
- `MultiscaleInfo.axes.length` will be `≤ 5`; the raw axes list lives only on the server-private `ImageBindingSeed.axes_names`.

## Why it works at all

The pin is plumbed through two seams:

1. `lucida-content::normalize::classify_axes` splits the raw OME axes list into canonical (`{t,c,z,y,x}`) and pinned (`PinnedAxis` per non-canonical name) — invoked at import time.
2. `lucida-store::chunk_key_to_store_path` walks the *raw* axes list (preserved on `ImageBindingSeed.axes_names`) and injects `"0"` at each non-canonical position when constructing on-disk Zarr v3 chunk paths. So the canonical 5D logical chunk key still resolves to the right byte range on disk.

Without (2), every chunk fetch would 404 because the path would be missing the `m` coordinate component.

## What this is not

- **Not a scene picker.** There is no UI today to choose which `m` index to view. The pinned index is hard-coded to `0`.
- **Not a fan-out.** Each `m` index is *not* surfaced as a sibling image (the way plate FOVs are). For CZI mosaics where each `m` is an independent physical scene, this means you only see the first scene; the other scenes are invisible.
- **Not a Lucida storage choice.** Lucida's own ingest writer (`lucida-store::ingest::ome_metadata`) always emits canonical 5D zarrs. The pin only matters when *reading* third-party non-canonical zarrs.
