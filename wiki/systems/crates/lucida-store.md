---
created: 2026-04-18
modified: 2026-05-26
---


# lucida-store

Storage abstraction and import pipeline. Wraps `object_store` to give the server a uniform handle on local filesystems, GCS, S3, and HTTP static stores; reads OME-Zarr metadata and produces the three-part [[decisions/0005-three-output-import-model|ImportResult]] (`DatasetManifest`, `FetchSource`, `ServerBindingSeed`).

The crate also includes ingest tooling under `ingest/` for converting plate readers and TIFF stacks into OME-Zarr — used by `lucida-cli` and `extras/`.

## Why split into three outputs

Importing a dataset produces information for three different audiences:

- **`DatasetManifest`** — what the renderer needs to plan and place entities (entities, transforms, images, layouts). Broadcast to every client; durable in document state.
- **`FetchSource`** — how the client should fetch chunk bytes. Currently always `Proxied` (server-mediated WebSocket binary frames). Future variants will support direct fetches.
- **`ServerBindingSeed`** — what the server needs to resolve chunk keys to object-store paths and decode storage compression. Server-private; never sent to clients.

The split exists because mixing them led to either over-broadcasting (server-only details leaked to clients) or under-broadcasting (clients had to round-trip to the server for things they could compute themselves). See [[decisions/0005-three-output-import-model]].

## Module map

- `lib.rs` — `chunk_key_to_store_path(key, axes, chunk_shape)` (the canonical 5D-key → on-disk path mapper, axes-aware and chunk-shape-aware) and the `ALL_DIMS` constant `["t", "c", "z", "y", "x"]`. Wire `t/c` are voxel coords (one per timepoint/channel) and `z/y/x` are chunk-grid coords; for `t/c` the function divides by `chunk_shape[axis]` to yield disk-grid coords. See [[gotchas/wire-chunk-key-conventions]].
- `backend.rs` — `open(url)` → `Arc<dyn ObjectStore>`. Calls `lucida_content::url::normalize_dataset_url` at entry, then routes the canonical form by scheme: Unix `/path`, drive-letter `c:/path`, UNC `//server/share/path` (all local via `LocalFileSystem`), `gs://`, `s3://`, `http(s)://`. Per [[decisions/0042-canonical-dataset-url-form]] the normalization is idempotent and the canonical form is what every downstream consumer sees. Both cloud arms call `from_env()` to inherit each vendor's native env vars (`AWS_*` for S3; `GOOGLE_*` for GCS, including `GOOGLE_SERVICE_ACCOUNT*` and Google's standard `GOOGLE_APPLICATION_CREDENTIALS`). Picking `from_env()` over `new()` is the load-bearing choice — `new()` skips env discovery entirely. See [[gcs-credentials]].
- `cache.rs` — `CachedStore`: byte-level LRU wrapping any `ObjectStore`
- `import.rs` — `import_dataset`: detects plate vs single-image from OME metadata, builds `ImportResult`
- `import_types.rs` — `ImportResult`, `ServerBindingSeed`, `ImageBindingSeed`, `LevelBindingInfo`
- `codec.rs` — `StorageCompression`, `BloscConfig`, `BloscCompressor`, `BloscShuffle`. Parses + validates a Zarr v3 codec chain into Lucida's structured codec types. Validation runs at import per level and produces per-level errors (e.g. `level 2: blosc cname 'lz4' is not supported`). See [[gotchas/blosc-support]] for the supported subset.
- `layout.rs` — `ChunkByteLayout { canonical_byte_size, on_disk_byte_size, byte_stride_t, byte_stride_c, chunk_size_t, chunk_size_c }` plus `slice_range(wire_t, wire_c) -> (offset, size)` and `compute_chunk_byte_layout`. The single seam for "given a decoded on-disk chunk, what byte range is the wire chunk?" — handles both pinned-axis bundling (PRD #447) and canonical-indexed bundling (PRD #451) uniformly. For canonical 5D datasets `slice_range` returns `(0, canonical_byte_size)`, equivalent to the old "no slicing needed" path. See [[gotchas/non-canonical-axes#post-decode-byte-slicing]].
- `parse.rs` — Zarr v3 metadata parsing helpers
- `ingest/` — plate scanner, plate reader, TIFF reader, OME-Zarr writer, pyramid generation. Used by ingest tooling.

## Interactions

- **Consumers**: [[lucida-server]] calls `backend::open` per dataset URL, `import::import_dataset` once on open, and `cache::CachedStore` for every chunk read. [[lucida-py]] also exposes both via `PyStore`.
- **Wire-side outputs flow into [[lucida-protocol]]** as `DatasetOpened { manifest, fetch, catalog }` and onto every connected client.
- **No direct dependency on [[lucida-core]]**. The crate produces structured data that lucida-core understands; it doesn't know about `Scene`.

## Invariants

- **Logical chunk keys are always 5D `level/t/c/z/y/x`**, even when the dataset has fewer or more axes. `chunk_key_to_store_path` walks the dataset's *raw* axes list to construct the on-disk path: it strips canonical-subset axes (e.g. for a `[c,y,x]` dataset, t/z drop out) and injects `"0"` for canonical-superset axes (e.g. for a CZI `[t,c,z,m,y,x]` mosaic, the m position gets `"0"` — the axis is pinned to index 0 by `lucida-content::normalize::classify_axes`). Clients and planners don't have to special-case axis variants.
- **Wire `t` and `c` are voxel coordinates; `z`, `y`, `x` are chunk-grid coordinates.** This asymmetry is invisible for typical OME-Zarrs (`chunk_shape[t] == chunk_shape[c] == 1`) but matters when channels or timepoints are bundled into a single on-disk chunk. The server divides wire `t/c` by `chunk_shape[axis]` to find the disk file and uses `ChunkByteLayout::slice_range` to extract the requested timepoint/channel's bytes. See [[gotchas/wire-chunk-key-conventions]].
- **Plate fields are entities; well placement is a layout.** The import builds field entities (`{id}:field:{path}`) parented to well entities (`{id}:well:{path}`) and emits a source layout that places the wells, not the fields. Field-to-well transforms encode each FOV's intra-well position.
- **Stage-positioned plates have translations in physical units (microns)** in OME-Zarr, but lucida composes transforms in voxel units. The import converts using the level-0 X/Y scale before forming the `field → well` transform. See [[gotchas/stage-translations-are-microns]].
- **Storage codecs are validated at import time, per level.** Each level's codec chain is parsed into `StorageCompression` (in `codec.rs`); unsupported codecs surface as a structured error naming the level and offending property rather than silently passing compressed bytes through to the client. See [[gotchas/blosc-support]].

## Binding-seed shape

`ImageBindingSeed` carries per-level decoder + chunk-layout information as a single structured field:

- `levels: Vec<LevelBindingInfo>` where `LevelBindingInfo { level_index, compression, chunk_shape, chunk_byte_layout }`.

`chunk_shape` parallels `ImageBindingSeed.axes_names` (one entry per on-disk axis) and is consumed by the resolver to translate wire `t/c` voxel coords into disk-grid coords. `chunk_byte_layout` carries the precomputed strides + chunk sizes used by the slice step. Consumers (`ChunkResolver::level_info(image_id, level)`, `serve_chunk_from_store`, `build_server_proxy_source`) take the level index and read all fields off one record.

The seed remains server-private — never broadcast. See [[decisions/0005-three-output-import-model]] for why.

`LevelBindingInfo` is `Clone` (not `Copy`) since the introduction of `chunk_shape: Vec<u64>`.

## Gotchas

- **`ImportResult` is JSON-serializable as a whole** for debugging and pretty-printing — but only `DatasetManifest` and `FetchSource` are sent on the wire. `ServerBindingSeed` is server-private. Don't accidentally broadcast it.
- **The default plate layout uses an 8% inter-FOV gap** for grid plates (`build_grid_field_transforms`). This is an aesthetic constant; see `lucida-content/src/plate.rs` if you need to change it. Stage-positioned plates use the actual translations and ignore the gap.
- **`PrefixStore` wraps GCS/S3 stores when the URL has a path**, so paths returned by the resolver are relative to the prefix. Local filesystem URLs use `LocalFileSystem::new_with_prefix(url)` instead, which is conceptually similar but a different code path.
- **`CachedStore` byte budget is 512 MB by default** (set in `handler::handle_open_remote_dataset`). This is per-dataset, not global. Many large datasets in one session can blow up server memory.
