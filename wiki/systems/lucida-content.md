---
created: 2026-04-18
modified: 2026-04-18
---

# lucida-content

Pure data model for dataset content: the `DatasetManifest` and the entities, transforms, images, layouts, and identifiers that compose it. No I/O. No async. Lives below [[lucida-core]] in the dependency graph and is re-exported transparently from `lucida_core::*`.

## Why a separate crate

The crate exists so that [[lucida-store]] can produce the manifest without pulling in [[lucida-core]] (which has wasm-bindgen dependencies and the full Scene model). Splitting the data model from the Scene also clarifies a contract: `DatasetManifest` is what the server publishes; everything richer (`Scene`, `DerivedState`, view query) lives in `lucida-core`.

## Module map

- `id.rs` — newtype IDs: `DatasetId`, `EntityId`, `ImageId`, `LayoutId`. All wrap `String` to prevent accidental cross-domain mixing.
- `entity.rs` — `Entity { id, kind, parent, labels }`, `EntityKind { Image, Field, Well }`, `EntityLabels` (display name, well row/column, field index, etc.)
- `image.rs` — `ImageSpec`, `MultiscaleInfo`, `LevelGeometry { level_index, shape, chunk_shape, grid_shape, scale }`, `Axis`, `AxisKind`, `DataType`
- `transform.rs` — `TransformEdge { from, to, transform }`, `VoxelTransform` (4×4 matrix in voxel units)
- `layout.rs` — `LayoutSpec { id, name, placements }`, `EntityPlacement { entity_id, position }`
- `kind.rs` — `DatasetKind::Single` vs `DatasetKind::Plate { rows, columns, positioning_mode, has_stage_positions }`, `PositioningMode`
- `graph.rs` — `DatasetManifest` itself: holds entities, transforms, images, source layouts, default layout id
- `plate.rs` — `build_grid_field_transforms`, `build_plate_layout`, `PlateLayoutError`
- `normalize.rs` — `normalize_to_5d` for axis padding when datasets have fewer than 5 axes

## Interactions

- **Producers**: [[lucida-store]] `import_dataset` builds a manifest from OME-Zarr metadata. Test fixtures and ingest tooling build them too.
- **Consumers**: [[lucida-core]]'s `Scene` ingests them on `DocumentCommand::DatasetOpened` and produces `DerivedState` (positions, projected geometry) for the [[planning-domain]]. The web client mirrors the type shapes in `lucida-web/src/manifestTypes.ts`.

## Invariants

- **Every entity is one of `Image`, `Field`, or `Well`.** Singles produce one `Image` entity; plates produce `Well` parents with `Field` children. Bare `Image` entities have no parent.
- **`shape` and `chunk_shape` are always 5D** (`[T, C, Z, Y, X]`), normalized via `normalize_to_5d` even when the source dataset has fewer axes. Missing dimensions are filled with size 1.
- **`grid_shape[d] == shape[d].div_ceil(chunk_shape[d])`** for every dimension. Asserted in import tests; downstream planning relies on this without re-checking.
- **Field-to-well transforms exist for every field in a plate.** Either grid-derived (computed by `build_grid_field_transforms`) or stage-derived (taken from OME translation, converted to voxel units in [[lucida-store]]).
- **`source_layouts` always contains at least the default layout** for plates. Empty for singles. `default_layout_id` points into the list when present.

## Gotchas

- **`DatasetManifest` was renamed from `ContentGraph`** in commit `c1d982d`. Some older code or comments may still reference the old name; treat them as the same thing.
- **Field IDs encode the FOV path**: `{dataset}:field:{store_prefix}` (e.g. `plate-id:field:A/1/0`). Store prefix uniqueness within the manifest depends on the source layout being well-disjoint, which OME-Zarr enforces but the import doesn't re-check.
- **`VoxelTransform::matrix()` returns column-major 4×4** (16 floats) — column-major because that's what GPUs and `glam` expect. Don't reshape it row-major when reading translations; X is index 12, Y is index 13.
