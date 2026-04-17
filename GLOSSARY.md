# Lucida Glossary

Top-level terms. Per-crate glossaries have more detail.

## Content Model

**ContentGraph** -- Canonical description of a dataset: entities, transforms, images, layouts. Deterministic and immutable for a given dataset.

**Entity** -- A node in the content hierarchy. Kinds: Image (standalone), Well (plate container), Field (FOV within a well).

**ImageSpec** -- Links an entity to its multiscale image data (axes, levels, data type).

**LevelGeometry** -- Shape, chunk shape, grid shape, and scale for one pyramid level. Fixed 5D: `[T, C, Z, Y, X]`.

**TransformEdge** -- Directed spatial relationship between entities (e.g., field-to-well translation). Carries a `VoxelTransform` — translations and scales are always in voxel units of the source entity's full-resolution image.

**LayoutSpec** -- A spatial arrangement of entities. Source layouts come from metadata; derived layouts are client-authored.

**DatasetKind** -- Single (one image) or Plate (rows, columns, wells, fields).

## Import Pipeline

**ImportResult** -- Three-part output of import: ContentGraph + ClientFetchDescriptor + ServerBindingSeed.

**ClientFetchDescriptor** -- How a client fetches chunk bytes. Proxied (server resolves paths), Direct (client resolves), or Local (filesystem).

**ServerBindingSeed** -- Serializable server-private metadata. Used to build the operational ServerBinding.

**ServerBinding** -- Live server-side resources: ObjectStore handle, ChunkResolver, CachedStore.

**ChunkResolver** -- Compiled lookup mapping (ImageId, chunk_key) to object store path.

**WireFormat** -- Byte encoding of chunk responses: Raw, Lz4, Zstd.

**RegisterDataset** -- Application-level message carrying ContentGraph + ClientFetchDescriptor. Broadcast by the server on dataset open.

## Scene State

**SceneEpochs** -- Typed epoch counters (`content`, `layout`, `view`, `selection`) on Scene. Bumped by commands. Primary invalidation mechanism for the pipeline — replaces ad-hoc generation counters as consumers are rewritten. Extended by PlanningEpochs with `asset` and `request` counters.

**ViewQueryResult** -- Compact per-entity geometric recommendations from Scene State. Contains visibility, projected screen size, centroid, ideal target LOD, and importance ranking. Produced by `Scene::view_query()`.

**VisibleRegion** -- Compact geometric output from WASM: viewport AABB in voxel space, Z range, effective zoom, optional sort center, optional frustum planes (3D only). Produced by `Camera::visible_region()`, exported via `WasmScene::visible_region()`. Used by Planning for spatial chunk culling — both 2D and 3D use the same code path.

**EntityQueryResult** -- One entry in a ViewQueryResult. Per-entity: visible, projected_diagonal_px, projected_area_px2, centroid_world, ideal_target_lod, importance.

**RayHit** -- Result of `Scene::ray_pick()`. Closest entity intersected by a screen-space ray, with world-space hit position and distance.

**DatasetDerivedState** -- Per-dataset precomputed cache built on RegisterDataset or SetActiveLayout. Contains volume transforms, active layout, and member states. Rebuilt on content or layout changes, not serialized.

**MemberState** -- Precomputed per image-bearing entity: position (composed from layout + transforms), volume transform, level geometries. Used by chunk planning and view queries to avoid scanning ContentGraph every frame.

## Layout System

**RegisterLayout** -- DocumentCommand that adds a client-authored LayoutSpec to the shared layout registry. Available to all clients in the session.

**SetActiveLayout** -- DocumentCommand that switches the active layout for a dataset. Rebuilds derived state (member positions). Shared — all clients see the same active layout.

## Geometry

**5D normalization** -- All internal geometry uses `[T, C, Z, Y, X]`. Missing axes = 1. Normalization happens once at import.

**grid_shape** -- Precomputed `ceil(shape / chunk_shape)`. Avoids per-frame division in chunk iteration and LOD selection.

**chunk_key** -- Canonical 5D key: `"level/t/c/z/y/x"`. Zeros for missing axes.

## Planning

**PlanningSnapshot** -- Full input to `plan()`. Assembled by the Orchestrator from Scene State (ViewQueryResult, VisibleRegion, epochs), content graph, asset catalog, selection state, CPU cache state, worker wanted-set, and previous active set.

**RequestPlan** -- Output of `plan()`: prioritized chunk request list, active set, and propagated epoch tags.

**plan()** -- Top-level pure function: `PlanningSnapshot → RequestPlan`. No I/O, no GPU, no network. Testable with synthetic snapshots.

**Promotion** -- Representation selection: decides each entity's display tier (overview, proxy, or detail) based on projected screen size, with hysteresis to prevent flicker.

**Representation** -- The display tier assigned to an entity: `"overview"` (coarsest LOD), `"proxy"` (placeholder until Asset Catalog), or `"detail"` (native chunks at target LOD).

**ActiveSetEntry** -- Per-entity planning result: representation, targetLod, seedDetailLod, detailOwnedLodRange.

**LOD range** -- Per promoted entity: `targetLod` (ideal finest level from WASM), `seedDetailLod` (coarsest detail-owned level, for progressive refinement), `detailOwnedLodRange` `[finest, coarsest]` inclusive.

**Request lanes** -- Three-lane priority scheme: detail (highest, current frame), runway (medium, adjacent timepoints), overview (lowest, background seeding).

**ChunkRequest** -- A single prioritized fetch entry: entity, level, T/C/Z/Y/X grid coords, lane, priority, chunkKey.

**PlanningEpochs** -- Extends SceneEpochs with `asset` (from Asset Catalog, placeholder) and `request` (bumped per plan cycle).

**requestEpoch** -- Monotonic counter bumped each time `plan()` produces a new `RequestPlan`. Carried on all main→worker messages so the worker can distinguish one plan generation from another.

**Cold state** -- Per-epoch-change message (`ColdStateMessage`) sent from the orchestrator to the GPU worker carrying the active set, visible region, current T, visible channels, and view mode. Enables the worker to compute its wanted-set.

**ColdStateMessage** -- Main→worker message carrying cold state. Sent on content/layout/selection epoch change, after `plan()` produces a new active set.

**Wanted-set** -- The set of chunks the GPU worker reports as missing — the diff between what it should have (derived from cold state + visible region) and what it actually has in its atlas. Computed by `computeWantedSet()`.

**WantedSetDeltaMessage** -- Worker→main message carrying the wanted-set: an array of `{ entityId, chunkKey }` entries for chunks the worker needs but doesn't have. Sent after cold state arrival and after eviction.

## Per-Crate Glossaries

- [lucida-content/GLOSSARY.md](lucida-content/GLOSSARY.md)
- [lucida-protocol/GLOSSARY.md](lucida-protocol/GLOSSARY.md)
- [lucida-store/GLOSSARY.md](lucida-store/GLOSSARY.md)
- [lucida-server/GLOSSARY.md](lucida-server/GLOSSARY.md)
