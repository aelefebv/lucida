---
created: 2026-04-18
modified: 2026-04-23
---

# lucida-store

Storage abstraction and import pipeline. Wraps `object_store` to give the server a uniform handle on local filesystems, GCS, S3, and HTTP static stores; reads OME-Zarr metadata and produces the three-part [[decisions/three-output-import-model|ImportResult]] (`DatasetManifest`, `FetchSource`, `ServerBindingSeed`).

The crate also includes ingest tooling under `ingest/` for converting plate readers and TIFF stacks into OME-Zarr — used by `lucida-cli` and `extras/`.

## Why split into three outputs

Importing a dataset produces information for three different audiences:

- **`DatasetManifest`** — what the renderer needs to plan and place entities (entities, transforms, images, layouts). Broadcast to every client; durable in document state.
- **`FetchSource`** — how the client should fetch chunk bytes. Currently always `Proxied` (server-mediated WebSocket binary frames). Future variants will support direct fetches.
- **`ServerBindingSeed`** — what the server needs to resolve chunk keys to object-store paths and decode storage compression. Server-private; never sent to clients.

The split exists because mixing them led to either over-broadcasting (server-only details leaked to clients) or under-broadcasting (clients had to round-trip to the server for things they could compute themselves). See [[decisions/three-output-import-model]].

## Module map

- `lib.rs` — `chunk_key_to_store_path` (the canonical 5D-key → on-disk path mapper, axes-aware) and the `ALL_DIMS` constant `["t", "c", "z", "y", "x"]`
- `backend.rs` — `open(url)` → `Arc<dyn ObjectStore>`. URL scheme routing: `/path` (local), `gs://`, `s3://`, `http(s)://`
- `cache.rs` — `CachedStore`: byte-level LRU wrapping any `ObjectStore`
- `import.rs` — `import_dataset`: detects plate vs single-image from OME metadata, builds `ImportResult`
- `import_types.rs` — `ImportResult`, `ServerBindingSeed`, `ImageBindingSeed`, `StorageCodecInfo`
- `parse.rs` — Zarr v3 metadata parsing helpers
- `ingest/` — plate scanner, plate reader, TIFF reader, OME-Zarr writer, pyramid generation. Used by ingest tooling.

## Interactions

- **Consumers**: [[lucida-server]] calls `backend::open` per dataset URL, `import::import_dataset` once on open, and `cache::CachedStore` for every chunk read. [[lucida-py]] also exposes both via `PyStore`.
- **Wire-side outputs flow into [[lucida-protocol]]** as `DatasetOpened { manifest, fetch, catalog }` and onto every connected client.
- **No direct dependency on [[lucida-core]]**. The crate produces structured data that lucida-core understands; it doesn't know about `Scene`.

## Invariants

- **Logical chunk keys are always 5D `level/t/c/z/y/x`**, even when the dataset has fewer or more axes. `chunk_key_to_store_path` walks the dataset's *raw* axes list to construct the on-disk path: it strips canonical-subset axes (e.g. for a `[c,y,x]` dataset, t/z drop out) and injects `"0"` for canonical-superset axes (e.g. for a CZI `[t,c,z,m,y,x]` mosaic, the m position gets `"0"` — the axis is pinned to index 0 by `lucida-content::normalize::classify_axes`). Clients and planners don't have to special-case axis variants.
- **Plate fields are entities; well placement is a layout.** The import builds field entities (`{id}:field:{path}`) parented to well entities (`{id}:well:{path}`) and emits a source layout that places the wells, not the fields. Field-to-well transforms encode each FOV's intra-well position.
- **Stage-positioned plates have translations in physical units (microns)** in OME-Zarr, but lucida composes transforms in voxel units. The import converts using the level-0 X/Y scale before forming the `field → well` transform. See [[gotchas/stage-translations-are-microns]].
- **Storage codecs are detected from level 0** and recorded as a per-image `storage_codecs` list. Currently consulted only for compression detection; preserved per-level so future code can support per-LOD codec differences.

## Gotchas

- **`ImportResult` is JSON-serializable as a whole** for debugging and pretty-printing — but only `DatasetManifest` and `FetchSource` are sent on the wire. `ServerBindingSeed` is server-private. Don't accidentally broadcast it.
- **The default plate layout uses an 8% inter-FOV gap** for grid plates (`build_grid_field_transforms`). This is an aesthetic constant; see `lucida-content/src/plate.rs` if you need to change it. Stage-positioned plates use the actual translations and ignore the gap.
- **`PrefixStore` wraps GCS/S3 stores when the URL has a path**, so paths returned by the resolver are relative to the prefix. Local filesystem URLs use `LocalFileSystem::new_with_prefix(url)` instead, which is conceptually similar but a different code path.
- **`CachedStore` byte budget is 512 MB by default** (set in `handler::handle_open_remote_dataset`). This is per-dataset, not global. Many large datasets in one session can blow up server memory.
