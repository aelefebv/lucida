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

**DatasetDerivedState** -- Per-dataset precomputed cache built on RegisterDataset. Contains volume transforms, active layout, and member states. Rebuilt on content changes, not serialized.

**MemberState** -- Precomputed per image-bearing entity: position (composed from layout + transforms), volume transform, level geometries. Used by chunk planning to avoid scanning ContentGraph every frame.

## Geometry

**5D normalization** -- All internal geometry uses `[T, C, Z, Y, X]`. Missing axes = 1. Normalization happens once at import.

**grid_shape** -- Precomputed `ceil(shape / chunk_shape)`. Avoids per-frame division in chunk iteration and LOD selection.

**chunk_key** -- Canonical 5D key: `"level/t/c/z/y/x"`. Zeros for missing axes.

## Per-Crate Glossaries

- [lucida-content/GLOSSARY.md](lucida-content/GLOSSARY.md)
- [lucida-protocol/GLOSSARY.md](lucida-protocol/GLOSSARY.md)
- [lucida-store/GLOSSARY.md](lucida-store/GLOSSARY.md)
- [lucida-server/GLOSSARY.md](lucida-server/GLOSSARY.md)
