# Lucida Glossary

Top-level terms. Per-crate glossaries have more detail.

## Content Model

**ContentGraph** -- Canonical description of a dataset: entities, transforms, images, layouts. Deterministic and immutable for a given dataset.

**Entity** -- A node in the content hierarchy. Kinds: Image (standalone), Well (plate container), Field (FOV within a well).

**ImageSpec** -- Links an entity to its multiscale image data (axes, levels, data type).

**LevelGeometry** -- Shape, chunk shape, grid shape, and scale for one pyramid level. Fixed 5D: `[T, C, Z, Y, X]`.

**TransformEdge** -- Directed spatial relationship between entities (e.g., field-to-well translation).

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

**SceneEpochs** -- Typed epoch counters (`content`, `layout`, `view`, `selection`) on Scene. Bumped by commands. Primary invalidation mechanism for the pipeline — replaces ad-hoc generation counters as consumers are rewritten.

**ViewQueryResult** -- Compact per-entity geometric recommendations from Scene State. Contains visibility, projected screen size, centroid, ideal target LOD, and importance ranking. Produced by `Scene::view_query()`.

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

## Per-Crate Glossaries

- [lucida-content/GLOSSARY.md](lucida-content/GLOSSARY.md)
- [lucida-protocol/GLOSSARY.md](lucida-protocol/GLOSSARY.md)
- [lucida-store/GLOSSARY.md](lucida-store/GLOSSARY.md)
- [lucida-server/GLOSSARY.md](lucida-server/GLOSSARY.md)
