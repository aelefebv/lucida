---
type: Crate
title: "lucida-content"
description: "Pure data model for dataset content: the DatasetManifest and the entities, transforms, images, layouts, and identifiers that compose it."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-content.md
created: 2026-04-18
modified: 2026-06-25
---

# lucida-content

Pure data model for dataset content: the `DatasetManifest` and the entities, transforms, images, layouts, and identifiers that compose it. No I/O. No async. Lives below [lucida-core](lucida-core.md) in the dependency graph and is re-exported transparently from `lucida_core::*`.

## Why a separate crate

The crate exists so that [lucida-store](lucida-store.md) can produce the manifest without pulling in [lucida-core](lucida-core.md) (which has wasm-bindgen dependencies and the full Scene model). Splitting the data model from the Scene also clarifies a contract: `DatasetManifest` is what the server publishes; everything richer (`Scene`, `DerivedState`, view query) lives in `lucida-core`.

## Module map

- `id.rs` — newtype IDs: `DatasetId`, `EntityId`, `ImageId`, `LayoutId`. All wrap `String` to prevent accidental cross-domain mixing.
- `entity.rs` — `Entity { id, kind, parent, labels }`, `EntityKind { Image, Well, Field }`, `EntityLabels` (display name, well row/column, field index, etc.)
- `image.rs` — `ImageSpec`, `MultiscaleInfo`, `LevelGeometry { level_index, shape, chunk_shape, grid_shape, scale }`, `Axis`, `AxisKind`, `DataType`, `PinnedAxis`
- `transform.rs` — `TransformEdge { from, to, transform }`, `VoxelTransform` (4×4 matrix in voxel units) and `AffineTransform` (the inner matrix type `VoxelTransform` is transparent over)
- `layout.rs` — `LayoutSpec { id, name, placements }`, `EntityPlacement { entity_id, position }`
- `kind.rs` — `DatasetKind::Single` vs `DatasetKind::Plate { rows, columns, positioning_mode, has_explicit_positions }`, `PositioningMode`
- `graph.rs` — `DatasetManifest` itself: holds entities, transforms, images, source layouts, default layout id
- `plate.rs` — `build_grid_field_transforms`, `build_plate_layout`, `PlateLayoutError`
- `normalize.rs` — `normalize_to_5d` for axis padding when datasets have fewer than 5 axes; `classify_axes` for splitting a raw OME-Zarr axes list into canonical `{t,c,z,y,x}` and pinned non-canonical members
- `url.rs` — cross-platform dataset URL helpers per [Canonical dataset URL form](../../decisions/0042-canonical-dataset-url-form.md): three canonicalizing ops — `normalize_dataset_url` (idempotent string-level canonicalization), `is_local_dataset_url` (classifier over the canonical form), and `dataset_id_for_url` (BLAKE3 ID derivation). `dataset_url_hash16` shares the BLAKE3 digest with the ID (via a shared `blake3_url` helper) so they can't drift. [lucida-core](lucida-core.md)'s `saved_view` re-exposes the three public helpers as `#[wasm_bindgen]` shims so the SPA imports the same single source of truth.

## Interactions

- **Producers**: [lucida-store](lucida-store.md) `import_dataset` builds a manifest from OME-Zarr metadata. Test fixtures and ingest tooling build them too.
- **Consumers**: [lucida-core](lucida-core.md)'s `Scene` ingests them on `DocumentCommand::DatasetOpened` and produces `DerivedState` (positions, projected geometry) for the [Planning Domain](../subsystems/planning-domain.md). The web client mirrors the type shapes in `lucida-web/src/manifestTypes.ts`.

## Invariants

- **Every entity is one of `Image`, `Well`, or `Field`.** Singles produce one `Image` entity; plates produce `Well` parents with `Field` children. Bare `Image` entities have no parent.
- **`shape` and `chunk_shape` are always 5D** (`[T, C, Z, Y, X]`), normalized via `normalize_to_5d` even when the source dataset has fewer or more axes. Missing canonical dimensions are filled with size 1.
- **`MultiscaleInfo.axes` is strictly canonical** — anything outside `{t,c,z,y,x}` is filtered out by `classify_axes` and surfaced separately in `MultiscaleInfo.pinned_axes` (each entry carries name, raw size, and the index it was pinned to — always `0` today). For a CZI mosaic with axes `[t,c,z,m,y,x]`, `axes.len()` is `5` and `pinned_axes` has one entry for `m`. The raw axes list is preserved on `ImageBindingSeed.axes_names` so [lucida-store](lucida-store.md)'s `chunk_key_to_store_path` can inject `0` at non-canonical positions when constructing on-disk paths.
- **`grid_shape[d] == shape[d].div_ceil(chunk_shape[d])`** for every dimension. Asserted in import tests; downstream planning relies on this without re-checking.
- **Field-to-well transforms exist for every field in a plate.** Either grid-derived (computed by `build_grid_field_transforms`) or stage-derived (taken from OME translation, converted to voxel units in [lucida-store](lucida-store.md)).
- **`source_layouts` is never empty.** Singles get one layout with a single placement at `[0, 0]` for the image entity. Plates get one layout with one placement per well. In both cases `default_layout_id` points into the list. (Field-within-well positions are *not* in the layout — see [Layout System](../subsystems/layout-system.md).)

## Gotchas

- **`DatasetManifest` was renamed from `ContentGraph`** in commit `c1d982d`. Some older code or comments may still reference the old name; treat them as the same thing.
- **Field IDs encode the FOV path**: `{dataset}:field:{store_prefix}` (e.g. `plate-id:field:A/1/0`). Store prefix uniqueness within the manifest depends on the source layout being well-disjoint, which OME-Zarr enforces but the import doesn't re-check.
- **`VoxelTransform::matrix()` returns column-major 4×4** (16 floats) — column-major because that's what GPUs and `glam` expect. Don't reshape it row-major when reading translations; X is index 12, Y is index 13.
