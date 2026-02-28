# Lucida Storage Layout

Version: 0.1 draft  
Date: 2026-02-28  
Status: First-pass storage and on-disk layout specification aligned to `spec.md`, `protocol_and_schemas.md`, and `sequences.md`

## 1. Purpose

This document defines the persistent storage contract for Lucida.

It answers four questions:

1. How does Lucida lay out datasets, generations, layers, and sidecars on disk?
2. How are the canonical OME-Zarr cache and Lucida-specific streaming assets organized?
3. How do mutable concepts such as `@working`, label metadata hot-reload, and derived layer publish fit into an otherwise immutable, cache-friendly object model?
4. How does the on-disk layout map to the HTTP data plane and future static object serving?

This document is normative for the logical storage model, directory/group naming, mutability rules, and generation lifecycle. It is not normative for a single filesystem driver, chunk sharding implementation, or object store backend.

---

## 2. Design principles

1. **Canonical first, streaming optimized second.** The persistent source-derived cache is OME-Zarr compatible. Lucida-specific streaming assets extend that cache under explicit namespaces instead of replacing it.
2. **Generation-local immutability.** Once a payload is advertised at a concrete URL, it must not change in place. Mutable workflows are represented by new generations, new revisions, or append-only namespaces.
3. **Dual representation is explicit.** 2D tiles and 3D bricks are separate representations with separate storage contracts.
4. **Chunk identity is logical; URLs are concrete.** The logical `ChunkKey` remains stable across serving modes. Concrete object paths may add version segments such as `write_rev` to preserve cacheability.
5. **Sparse derived data is first-class.** Missing chunks are meaningful and must not be silently treated as zeros.
6. **Scene artifacts are distinct from cache artifacts.** Scene files and Context Packages are portable artifacts; the Lucida cache is an engine-managed data store.
7. **Engine local first, cloud compatible later.** The same layout must support a single-machine central cache and future static/object-backed deployments.

---

## 3. Scope and boundaries

This document covers:
- source records and dataset records
- working and pinned generation stores
- OME-Zarr-compatible canonical cache layout
- Lucida-specific groups under `/lucida/`
- sidecars for labels, points, and small metadata indexes
- optional object projection for static/HTTP serving
- pinning and garbage collection rules

This document does **not** define:
- control-plane JSON message schemas (see protocol document)
- Scene file payload schema
- Context Package payload schema
- plugin packaging or sandboxing
- exact transport choice (WebSocket vs WebTransport)

---

## 4. Storage scopes and top-level layout

Lucida uses a central cache root by default, with optional per-project overrides.

Recommended top-level layout:

```text
lucida_cache/
  store.json
  sources/
    src_<id>/
      source.json
      watch.json
  datasets/
    ds_<id>/
      dataset.json
      aliases/
        working.json
      pins/
        pin_<id>.json
      generations/
        gen_<id>/
          generation.json
          store.zarr/
          sidecars/
          objects/
  artifacts/
    scenes/
    context_packages/
```

### 4.1 Top-level entries

- `store.json`: engine-wide metadata for the cache root.
- `sources/`: source registry records describing external inputs and watch policy.
- `datasets/`: logical dataset stores used by the data plane and layer bindings.
- `artifacts/`: optional engine-managed local storage for saved Scene files and Context Packages. Exported artifacts may also live outside the cache root.

### 4.2 `store.json`

`store.json` SHOULD include:

```json
{
  "lucida_storage_layout_version": "0.1",
  "created_at": "2026-02-28T00:00:00Z",
  "engine_version": "lucida-engine/0.1",
  "default_cache_policy": {
    "keep_previous_working_ttl_seconds": 600,
    "pin_gc_protected": true
  }
}
```

It MAY also include node-local settings such as default shard profile, object projection mode, or cache root UUID.

---

## 5. Source registry

A **source** is an external input location: TIFF/BigTIFF, OME-Zarr, Zarr, N5, or another loader-backed URI.

Sources are tracked separately from datasets because a single external path/watch target may have engine-local storage policies, watch settings, and aliases independent of scene usage.

### 5.1 Source directory

Recommended layout:

```text
sources/
  src_<id>/
    source.json
    watch.json
```

### 5.2 `source.json`

`source.json` SHOULD include:

```json
{
  "source_id": "src_...",
  "uri": "file:///data/sample.ome.tif",
  "loader_kind": "tiff | ome_zarr | zarr | n5 | plugin",
  "dataset_id": "ds_...",
  "created_at": "2026-02-28T00:00:00Z",
  "source_identity": {
    "path": "/data/sample.ome.tif",
    "scheme": "file"
  },
  "watch_mode": "watcher_only",
  "stability_policy": {
    "debounce_seconds": 2,
    "single_file_stat_verify_ms": 200
  }
}
```

### 5.3 `watch.json`

`watch.json` is mutable runtime state and MAY include:

```json
{
  "source_id": "src_...",
  "last_event_at": "2026-02-28T00:01:12Z",
  "last_stable_at": "2026-02-28T00:01:14Z",
  "watch_status": "idle | changed | stabilizing | build_requested",
  "last_error": null
}
```

This file is operational, not portable.

---

## 6. Dataset store

A **dataset** is the logical storage root addressed by chunk keys and used by scenes/layers. A dataset usually corresponds to one watched source, but the separation is deliberate because dataset IDs are the stable serving identity.

### 6.1 Dataset directory

Recommended layout:

```text
datasets/
  ds_<id>/
    dataset.json
    aliases/
      working.json
    pins/
      pin_<id>.json
    generations/
      gen_<id>/
        ...
```

### 6.2 `dataset.json`

`dataset.json` SHOULD include:

```json
{
  "dataset_id": "ds_...",
  "source_id": "src_...",
  "created_at": "2026-02-28T00:00:00Z",
  "canonical_axes_suffix": "tczyx",
  "extra_axes": ["position", "round"],
  "default_scene_mode": "live_working",
  "storage_profiles": {
    "canonical_store": "ome_zarr_compatible",
    "object_projection": "engine_served | materialized | sharded"
  }
}
```

### 6.3 Aliases and pins

`aliases/working.json` points to the currently active working generation:

```json
{
  "alias": "working",
  "dataset_id": "ds_...",
  "generation_id": "gen_...",
  "generation_seq": 42,
  "updated_at": "2026-02-28T00:12:00Z"
}
```

Pins are durable references to generations:

```json
{
  "pin_id": "pin_...",
  "dataset_id": "ds_...",
  "generation_id": "gen_...",
  "label": "paper-figure-3",
  "created_at": "2026-02-28T00:15:00Z"
}
```

Pins MUST protect the referenced generation from garbage collection.

---

## 7. Generation store

A **generation** is the unit of source-derived cache immutability. A generation represents a stable source state after Lucida's stability window and serves as the parent for all base payloads for that source state.

### 7.1 Generation directory

```text
generations/
  gen_<id>/
    generation.json
    store.zarr/
    sidecars/
    objects/
```

### 7.2 Mutability model

Generation directories follow these rules:

- `generation.json` is mutable while building and becomes append-only once the generation is `ready` or `failed`.
- `store.zarr/` is append-only at the chunk/object level once a given chunk is published as ready. A chunk object must not be rewritten in place.
- `sidecars/` may receive new revisions (for example, metadata hot-reload) using revisioned filenames or subdirectories.
- `objects/` is append-only. Concrete object URLs MUST be immutable.

### 7.3 `generation.json`

`generation.json` SHOULD include:

```json
{
  "generation_id": "gen_...",
  "dataset_id": "ds_...",
  "source_id": "src_...",
  "generation_seq": 42,
  "created_at": "2026-02-28T00:12:00Z",
  "completed_at": null,
  "state": "stabilizing | building | partial_ready | ready | failed | abandoned | gc_pending",
  "source_snapshot": {
    "uri": "file:///data/sample.ome.tif",
    "detected_change_at": "2026-02-28T00:11:55Z",
    "stable_at": "2026-02-28T00:11:57Z"
  },
  "build_status": {
    "preview_ready": true,
    "canonical_2d_ready": false,
    "brick3d_ready": false
  },
  "layer_status": {},
  "warnings": []
}
```

### 7.4 Build order and readiness

Lucida SHOULD build in this order:

1. generation metadata and root groups
2. coarse preview and minimap artifacts
3. coarse canonical 2D LODs
4. finer canonical 2D LODs and LOD0
5. optional histograms/summary stats
6. lazy 3D bricks on demand, coarse first
7. optional occupancy masks and secondary summaries

Readiness MUST be recorded in `generation.json` and MAY be mirrored inside `store.zarr/lucida/build/`.

---

## 8. `store.zarr/` logical layout

`store.zarr/` is the logical dataset store for a generation. It MUST be OME-Zarr compatible at the canonical layer groups and MAY contain Lucida-specific groups under `/lucida/`.

Recommended logical layout:

```text
store.zarr/
  zarr.json
  layers/
    lay_<id>/
      zarr.json
      0/
      1/
      2/
      ...
  lucida/
    brick3d/
      lay_<id>/
        zarr.json
        0/
        1/
        ...
    previews/
      lay_<id>/
        manifest.json
    histograms/
      lay_<id>/
        histogram.json
    occupancy/
      lay_<id>/
        zarr.json
        0/
        1/
        ...
    coverage/
      lay_<id>/
        tile2d/
          zarr.json
          0/
          1/
          ...
        brick3d/
          zarr.json
          0/
          1/
          ...
    build/
      manifest.json
```

### 8.1 Root metadata

The `store.zarr/` root SHOULD carry Lucida metadata in root attributes or a root manifest. At minimum:

```json
{
  "lucida": {
    "storage_layout_version": "0.1",
    "dataset_id": "ds_...",
    "generation_id": "gen_...",
    "source_id": "src_...",
    "canonical_axes_suffix": "tczyx",
    "extra_axes": ["position", "round"]
  }
}
```

### 8.2 Canonical layer groups: `/layers/<layer_id>/`

Each `layers/<layer_id>/` group MUST be an OME-Zarr-compatible image or labels node.

It SHOULD contain:
- Zarr group metadata
- OME-Zarr `multiscales` metadata
- layer identity and Lucida metadata in attrs
- numeric multiscale arrays `0/`, `1/`, `2/`, ...

#### 8.2.1 Layer attrs

Each layer group SHOULD include attrs similar to:

```json
{
  "lucida": {
    "layer_id": "lay_...",
    "kind": "image | labels | points_proxy",
    "role": "base | derived",
    "dataset_id": "ds_...",
    "generation_id": "gen_...",
    "channel_block_size": 4,
    "missing_chunk_semantics": "transparent | fill_value",
    "dependency": {
      "base_layer_id": null,
      "base_generation_id": null,
      "policy": null
    }
  }
}
```

#### 8.2.2 Canonical 2D tile chunking defaults

For canonical 2D-oriented arrays:
- XY chunks default to `512 x 512`
- image channel chunk defaults to `4`
- labels use `C = 1`
- T chunk defaults to `1`
- Z chunk defaults to `1` for tile-oriented browsing, unless a loader-specific optimization dictates otherwise

Chunk shapes MUST preserve tile semantics across LODs even if full array shapes shrink.

#### 8.2.3 Derived layer canonical arrays

Derived layers MAY also use `/layers/<layer_id>/` for their tile-oriented representation.

Rules for derived canonical arrays:
- same spatial grid and world transform as base layer
- dtype and channel count MAY differ from base
- missing chunk objects represent uncovered regions, not valid zeros
- `missing_chunk_semantics` MUST be set to `transparent`

Because generic Zarr readers may interpret missing chunks via `fill_value`, Lucida clients MUST honor Lucida sparse semantics rather than assuming missing equals zero.

### 8.3 3D bricks: `/lucida/brick3d/<layer_id>/`

The `brick3d` namespace stores the 3D-optimized representation.

Rules:
- one group per layer
- multiscale arrays `0/`, `1/`, `2/`, ...
- chunk shapes selected to be approximately cubic in world space
- channel blocking defaults to `4` for images, `1` for labels
- chunk shape MAY vary by LOD

Attrs SHOULD include:

```json
{
  "lucida": {
    "representation": "brick3d",
    "target_uncompressed_bytes_per_block": 1048576,
    "world_space_shaping": true
  }
}
```

### 8.4 Previews: `/lucida/previews/<layer_id>/`

Previews are for first paint and minimap. They are intentionally browser-friendly, potentially lossy artifacts.

Required contract:
- each layer with previews SHOULD have a `manifest.json`
- actual preview binaries MAY live in the `objects/` projection rather than inside Zarr arrays

`manifest.json` SHOULD describe:

```json
{
  "layer_id": "lay_...",
  "default_format": "webp",
  "fallback_format": "png",
  "modes": ["overview_composite", "plane_preview"],
  "available_lods": [3, 4, 5],
  "z_policy": "per_plane | projected"
}
```

An implementation MAY additionally store preview RGB arrays under Zarr groups, but the object projection remains the serving contract.

### 8.5 Histograms: `/lucida/histograms/<layer_id>/`

Histograms are small summaries, not primary image payloads.

Recommended form:

```text
lucida/histograms/
  lay_<id>/
    histogram.json
```

`histogram.json` SHOULD contain per-channel, per-LOD summaries such as:
- min/max
- mean/std (optional)
- percentiles (for quick auto-contrast)
- histogram bins/counts
- saturation counts (optional)

### 8.6 Occupancy masks: `/lucida/occupancy/<layer_id>/`

Occupancy masks are optional but recommended for volume rendering and empty-space skipping.

They SHOULD be stored as coarse 3D arrays, one or more LODs, with boolean or uint8 values indicating whether a corresponding brick region contains non-empty signal.

These masks MAY be generated lazily.

### 8.7 Coverage indexes: `/lucida/coverage/<layer_id>/`

Coverage indexes make sparse derived data explicit.

Recommended layout:

```text
lucida/coverage/
  lay_<id>/
    tile2d/
      zarr.json
      0/
      1/
      ...
    brick3d/
      zarr.json
      0/
      1/
      ...
```

Coverage arrays SHOULD be boolean arrays over the **chunk grid**, not the pixel grid.

For `tile2d`, dimensions conceptually correspond to:
- extra axes
- `t`
- `z`
- `ty`
- `tx`

For `brick3d`, dimensions conceptually correspond to:
- extra axes
- `t`
- `bz`
- `by`
- `bx`

Coverage arrays allow:
- fast sparse overlay indication
- exact determination of which chunk keys are present
- coverage overlay rendering at low zoom
- easier garbage collection and manifest generation

### 8.8 Build manifests: `/lucida/build/`

Build status MAY be mirrored inside the generation store for convenience:

```text
lucida/build/
  manifest.json
```

`manifest.json` SHOULD include per-layer, per-representation readiness and may duplicate a subset of `generation.json`.

---

## 9. Sidecars

Sidecars store mutable, query-oriented, or non-array artifacts that do not fit cleanly into Zarr groups.

Recommended layout:

```text
sidecars/
  labels/
    lay_<id>/
      current.json
      mapping_epochs/
        epoch_000003/
          metadata_rev_000012.sqlite
          manifest.json
          exports/
            metadata_rev_000012.parquet
  points/
    lay_<id>/
      current.json
      revisions/
        rev_000004.sqlite
```

### 9.1 Labels sidecars

Labels sidecars are the source of truth for:
- `original_id -> dense_id` mapping
- metadata rows per label object
- mapping epoch and metadata revision tracking

#### 9.1.1 `current.json`

```json
{
  "layer_id": "lay_...",
  "mapping_epoch": 3,
  "metadata_rev": 12,
  "storage_kind": "sqlite",
  "current_path": "mapping_epochs/epoch_000003/metadata_rev_000012.sqlite"
}
```

#### 9.1.2 SQLite contract

The SQLite file SHOULD contain at least:
- `label_map(original_id PRIMARY KEY, dense_id UNIQUE NOT NULL, active INTEGER, first_seen_generation_id TEXT, last_seen_generation_id TEXT NULL)`
- `objects(original_id PRIMARY KEY, ... arbitrary metadata columns ...)`
- `schema_meta(key PRIMARY KEY, value TEXT)`
- `revision_meta(metadata_rev PRIMARY KEY, created_at TEXT, note TEXT NULL)`

Lucida MUST treat `label_map` as authoritative for the universe of indexed objects. If raster IDs exist outside the map, Lucida may still render them but MUST surface an `incomplete_label_index` warning and cannot guarantee full filter correctness.

#### 9.1.3 Dense ID stability

Dense IDs are stable where possible by anchoring on `original_id`.
- new IDs append
- missing IDs leave holes
- IDs are not recycled by default
- explicit compaction creates a new mapping epoch

### 9.2 Points sidecars

Points layers MAY use SQLite or Parquet. Default for interactive query/update is SQLite.

A points SQLite SHOULD include:
- `points(point_id PRIMARY KEY, x REAL, y REAL, z REAL NULL, t INTEGER NULL, ... metadata columns ...)`
- optional spatial indexes where supported
- revision metadata

### 9.3 Small JSON manifests

Small control manifests such as `current.json`, `manifest.json`, or `exports/index.json` MUST be UTF-8 JSON and SHOULD be versioned by revision when they describe mutable data.

---

## 10. Derived layer storage

Derived layers are scene-level concepts but dataset-generation-local storage artifacts.

By default, a derived layer is pinned to a base layer and a base generation. Its payloads therefore live with that base generation's store.

### 10.1 Placement

Derived layers SHOULD be stored in the same generation store as their base generation:
- tile-oriented representation under `/store.zarr/layers/<derived_layer_id>/`
- brick representation under `/store.zarr/lucida/brick3d/<derived_layer_id>/`
- coverage under `/store.zarr/lucida/coverage/<derived_layer_id>/`
- any label/points sidecars under `sidecars/`

This keeps chunk addressing aligned with the existing `dataset_id + generation_id + layer_id` contract.

### 10.2 Write revisions and immutable URLs

Derived layers are mutable within a generation because publish operations may overwrite prior chunk content.

To preserve immutable data-plane URLs, Lucida MUST separate:
- the **logical chunk key**: `(dataset_id, generation_id, layer_id, representation, lod, index_key, c0, coords)`
- the **concrete object epoch**: typically the layer's `write_rev`

Implications:
- the canonical chunk key does **not** change when a derived layer is overwritten
- the concrete object path used for serving MUST include a version segment such as `epoch/<write_rev>`
- control-plane payload descriptors are authoritative for the URL clients should fetch
- clients SHOULD treat data URLs as opaque and not reconstruct them from the logical chunk key alone

### 10.3 Sparse semantics

Derived layers are sparse by default.

Rules:
- missing chunk object = no contribution / transparent
- coverage arrays are authoritative for presence tests
- downsampled coarse LODs are built only from existing chunks
- no finer-than-computed LODs are invented automatically

### 10.4 Overwrite vs new layer

When publishing results back:
- `overwrite` updates the same layer and increments `write_rev`
- `new` creates a new derived layer ID rooted on the same base generation

Old `write_rev` payload epochs MAY be garbage-collected after a safety TTL if they are no longer referenced by any connected client or pinned artifact.

---

## 11. Object projection for the data plane

`store.zarr/` is the logical store. `objects/` is the optional concrete object projection used for static or cache-friendly serving.

### 11.1 Why object projection exists

The browser-facing data plane wants:
- immutable URLs
- compact payloads optimized for browser decode
- preview images in browser-native formats
- compatibility with engine-served and static-object serving

Those needs do not always map 1:1 onto raw Zarr chunk files. Therefore Lucida defines an **object projection** that can be:
- materialized on disk
- generated lazily and cached on disk
- resolved on demand by the engine from the logical store

### 11.2 Recommended object projection layout

```text
objects/
  v1/
    data/
      ds_<id>/
        gen_<id>/
          lay_<id>/
            tile2d/
              epoch/
                0/
                  lod/
                    0/
                      idx/
                        t=0;z=120/
                          c0/0/
                            chunk/y=17;x=42.bin
            brick3d/
              epoch/
                0/
                  lod/
                    2/
                      idx/
                        t=0/
                          c0/4/
                            chunk/z=4;y=9;x=11.bin
            preview2d/
              epoch/
                0/
                  lod/
                    4/
                      idx/
                        t=0;z=120/
                          chunk/y=1;x=2.webp
```

For derived layers, `epoch/<write_rev>/` is required. For immutable base layers, `epoch/0/` MAY be omitted internally but SHOULD be preserved in the materialized object layout for uniformity.

### 11.3 Concrete URL rule

The data-plane URL returned to clients MUST map to the concrete object path, not just the logical chunk key.

For base immutable data, the protocol's recommended canonical path is sufficient.
For mutable derived payloads, the concrete URL MUST add the epoch/version segment.

### 11.4 Payload file formats

Recommended file extensions:
- quantitative tile/brick payloads: `.bin`
- preview payloads: `.webp` or `.png`
- optional side manifests: `.json`

Quantitative `.bin` files SHOULD contain the Lucida payload header plus compressed bytes as defined by the protocol document.

### 11.5 Exploded vs sharded realization

The object projection may be realized in two profiles.

#### Exploded profile
- one file per served payload
- simplest for local/LAN deployments
- easiest to debug
- may create many small files

#### Sharded profile
- many logical payloads packed into larger shard objects
- an index manifest maps logical object paths to `(object_url, byte_range)`
- better for object stores/CDNs and very large chunk counts

If sharded, the control-plane payload descriptor MUST include the concrete URL and byte-range metadata. The logical object path remains stable even if the physical shard file changes.

---

## 12. Mapping from logical chunk keys to storage

### 12.1 Logical key

The canonical `ChunkKey` is defined in the protocol document and includes:
- `dataset_id`
- `generation_id`
- `layer_id`
- `representation`
- `lod`
- `index_key`
- `c0` (when applicable)
- chunk coordinates

### 12.2 Mapping to `store.zarr/`

Logical mapping rules:
- `representation = tile2d` maps to `/store.zarr/layers/<layer_id>/<lod>/`
- `representation = brick3d` maps to `/store.zarr/lucida/brick3d/<layer_id>/<lod>/`
- `representation = preview2d` maps to preview manifests and concrete preview objects

The exact Zarr chunk object path is implementation-defined by the Zarr codec/layout, but the logical array group path is fixed.

### 12.3 Mapping to object projection

Logical mapping rules:
- `dataset_id` -> `datasets/<dataset_id>/`
- `generation_id` -> `generations/<generation_id>/`
- `layer_id` -> layer namespace
- `representation`, `lod`, `index_key`, `c0`, `coords` -> concrete object path
- `epoch` -> `0` for immutable data, `write_rev` for mutable derived layer payloads

---

## 13. Garbage collection and retention

### 13.1 Working generations

Default retention policy:
- keep latest working generation
- keep one previous working generation for a short TTL (for example, 10 minutes)
- garbage-collect older unpinned working generations

A generation marked by a pin or referenced by a durable Scene file or Context Package MUST NOT be GC'd until the reference is removed.

### 13.2 Partial or abandoned builds

Generations in `failed` or `abandoned` state MAY be GC'd aggressively, but Lucida SHOULD retain enough logs/manifests for diagnosis for a short TTL.

### 13.3 Derived layer write epochs

Old `write_rev` epochs for derived layers MAY be deleted once:
- no active clients reference them
- no Context Package or pinned scene references them
- a configurable safety TTL has elapsed

### 13.4 Sidecar revisions

Labels metadata revisions and points revisions MAY be pruned independently of generation GC, but the currently referenced revision for any live or pinned layer MUST be retained.

### 13.5 Coverage and occupancy artifacts

Coverage arrays, occupancy masks, and histograms are derivable artifacts. They MAY be regenerated and MAY be GC'd with their owning generation or layer revision.

---

## 14. Consistency and atomicity rules

### 14.1 Atomic chunk publication

A chunk MUST be written atomically from the point of view of readers.
Recommended approach:
- write to temp path
- fsync if appropriate
- rename/move into final location
- update readiness/coverage manifests last

### 14.2 Manifest update ordering

For any new payload:
1. write payload
2. write or update checksum/coverage metadata
3. update `generation.json`, layer status, or `current.json` pointers
4. only then emit control-plane readiness events

### 14.3 No mixed-generation frames

Storage alone cannot enforce this, but the layout MUST make it easy: generation-scoped stores and generation-scoped paths mean clients can keep generation boundaries clean.

### 14.4 Mutable sidecars

Mutable sidecars such as label metadata MUST use revisioned files or epoch directories. In-place replacement of the file currently being read by clients SHOULD be avoided. `current.json` or equivalent pointer files SHOULD advance to the new revision atomically.

---

## 15. Recommended metadata fields by artifact

This section is a practical checklist.

### 15.1 `dataset.json`

Recommended fields:
- `dataset_id`
- `source_id`
- `created_at`
- `canonical_axes_suffix`
- `extra_axes`
- `default_channel_block_size`
- `default_tile_shape`
- `default_brick_target_bytes`
- `storage_profiles`

### 15.2 `generation.json`

Recommended fields:
- `generation_id`
- `generation_seq`
- `dataset_id`
- `source_id`
- `state`
- `created_at`
- `completed_at`
- `source_snapshot`
- `build_status`
- `warnings`
- `pin_refcount`
- `gc_eligible_after`

### 15.3 Layer attrs under `store.zarr`

Recommended fields:
- `layer_id`
- `kind`
- `role`
- `dataset_id`
- `generation_id`
- `channel_block_size`
- `missing_chunk_semantics`
- `dependency` (for derived layers)
- `affine_world_from_index`
- `calibration_status`

### 15.4 Sidecar `current.json`

Recommended fields:
- `layer_id`
- `mapping_epoch` or `rev`
- `metadata_rev`
- `storage_kind`
- `current_path`
- `updated_at`

---

## 16. Example: minimal generation tree

Example for one image layer, one labels layer, and one sparse derived image layer:

```text
lucida_cache/
  datasets/
    ds_abcd/
      dataset.json
      aliases/
        working.json
      generations/
        gen_0042/
          generation.json
          store.zarr/
            zarr.json
            layers/
              lay_img/
                zarr.json
                0/
                1/
                2/
              lay_lbl/
                zarr.json
                0/
                1/
                2/
              lay_deriv/
                zarr.json
                0/
                1/
            lucida/
              brick3d/
                lay_img/
                  zarr.json
                  0/
                  1/
                lay_lbl/
                  zarr.json
                  0/
                lay_deriv/
                  zarr.json
                  1/
              previews/
                lay_img/
                  manifest.json
              histograms/
                lay_img/
                  histogram.json
              coverage/
                lay_deriv/
                  tile2d/
                    zarr.json
                    0/
                    1/
                  brick3d/
                    zarr.json
                    1/
          sidecars/
            labels/
              lay_lbl/
                current.json
                mapping_epochs/
                  epoch_000003/
                    metadata_rev_000012.sqlite
            points/
          objects/
            v1/
              data/
                ds_abcd/
                  gen_0042/
                    lay_img/
                      tile2d/
                        epoch/
                          0/
                            lod/
                              0/
                                idx/
                                  t=0;z=120/
                                    c0/0/
                                      chunk/y=17;x=42.bin
                    lay_deriv/
                      tile2d/
                        epoch/
                          7/
                            lod/
                              1/
                                idx/
                                  t=0;z=120/
                                    c0/0/
                                      chunk/y=17;x=42.bin
```

---

## 17. Interoperability notes

1. Base image and labels layers should remain readable as ordinary OME-Zarr image/labels nodes by non-Lucida tools whenever possible.
2. Lucida-specific semantics such as sparse derived transparency, coverage arrays, write revisions, and preview object projection are Lucida extensions and may not be understood by generic tools.
3. If a deployment must maximize interoperability, the recommended compromise is:
   - keep canonical base layers strictly OME-Zarr compatible
   - treat `/lucida/` and `sidecars/` as Lucida-only extensions
   - export derived results to standalone canonical datasets when needed for external tools

---

## 18. Open implementation choices (non-blocking)

The following choices are intentionally left open, provided the logical layout and invariants remain intact:

- exact Zarr version and codec stack used for `store.zarr/`
- whether previews are additionally stored as RGB arrays inside Zarr
- whether object projection is eager, lazy, or purely engine-translated
- exact shard index format for sharded object projection
- whether `artifacts/` is engine-managed by default or only created on demand
