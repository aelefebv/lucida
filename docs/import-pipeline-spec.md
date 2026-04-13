# Import Pipeline Specification

> **Status:** Implemented (803a3a5). `lucida-content` and `lucida-protocol` crates live. Three-output import model operational.

How a filepath or GCS path becomes a registered dataset. The import pipeline cleanly separates canonical content, client-visible fetch metadata, and server-private storage binding.

---

## Design Principles

1. **Import produces three distinct outputs**, not a monolithic command blob.
2. **Canonical content describes what the dataset is.** It does not describe how to fetch it, where it's stored, or how to display it.
3. **Fetch metadata describes how a client turns logical addresses into bytes.** It varies by client mode (proxied, direct, local) and does not contain storage internals.
4. **Server binding is operational and private.** It owns live resources (object store handles, caches, compiled resolvers) and never crosses the wire.
5. **Storage codec is not wire codec.** The server decodes storage compression and chooses what wire format to send. Each `WireFormat` variant (`Raw`, `Lz4`, `Zstd`) carries a `data_type: DataType` field so the client knows the pixel format of the response. Phase 1: server decodes LZ4 from storage, sends `WireFormat::Raw { data_type }` to clients.
6. **Registration is an application-level event**, not the data model. It carries the import products but is not itself canonical content.

---

## The Three Import Products

```
Import
  ├── ContentGraph          (canonical, shared, deterministic)
  │   Entities, transforms, image specs, source layouts.
  │   Describes the dataset as a scientific object.
  │   Lives in: lucida-content
  │
  ├── ClientFetchDescriptor (client-visible, mode-shaped)
  │   How to turn logical chunk keys into bytes.
  │   Enum: Proxied | Direct | Local.
  │   Lives in: lucida-protocol
  │
  └── ServerBindingSeed     (serializable, no live resources)
      What the server needs to build its operational binding.
      Per-image axes and storage codecs.
      Lives in: lucida-store
          │
          ▼ (server combines with live resources)
      ServerBinding          (operational, server-private)
      Object store handle, compiled ChunkResolver, LRU cache.
      Lives in: lucida-server
```

---

## End-to-End Flow

```
User provides URL
  → Client sends OpenRemoteDataset { url } via WebSocket
  → Server: lucida_store::backend::open(url)
  → Server: lucida_store::import::import_dataset(store, id, name)
      → Parses OME-Zarr metadata (root zarr.json, level zarr.jsons, well metadata)
      → Builds entities, transforms, image specs from parsed metadata
      → Builds source layout(s) from plate structure or single-image identity
      → Builds ClientFetchDescriptor (Proxied for WebSocket clients)
      → Builds ServerBindingSeed (per-image axes, storage codecs)
      → Returns ImportResult { content, fetch, binding_seed }
  → Server: builds ServerBinding from binding_seed + store + cache config
  → Server: registers ServerBinding in session
  → Server: broadcasts RegisterDataset { content, fetch } to all clients
  → Client: registers ContentGraph into scene state (builds DatasetDerivedState)
  → Client: uses ClientFetchDescriptor to set up its fetch pipeline
           (web: proxied fetchers, py: headless fetch, cli: ignores — inspection only)

Chunk request:
  → Client sends { dataset_id, image_id, key }
  → Server: ChunkResolver.resolve(image_id, key) → object store path
  → Server: read bytes, decompress storage codec (LZ4 → raw)
  → Server: send raw bytes to client (WireFormat::Raw)
```

---

## Normalization Conventions

### Axis order

All internal geometry uses fixed 5D `[T, C, Z, Y, X]` (indices 0-4). Missing axes have size 1 in shape/chunk_shape/grid_shape and scale 1.0. Original axis metadata is preserved in `MultiscaleInfo.axes` for UI purposes (e.g., hiding the T slider for a 3D dataset).

Normalization happens once at import time in lucida-store via `lucida_content::normalize`.

### Coordinate conventions

- Entity placements: `[X, Y]` in layout pixel space
- Shapes: `[T, C, Z, Y, X]` in normalized axis order
- Scales: `[T, C, Z, Y, X]` physical units per voxel
- Transform matrices: column-major 4x4 `[f64; 16]`
- Chunk keys: `"level/t/c/z/y/x"` (canonical 5D, with 0 for missing axes)
- Chunk requests: `{ dataset_id, image_id, key }` — store_prefix is server-private

### Plate conventions

- Source layouts place **wells**, not fields. Field positions within wells come from `TransformEdge` (field→well).
- `LevelGeometry.grid_shape` is precomputed (`ceil(shape / chunk_shape)`) to avoid redundant division in chunk iteration and LOD selection.
- Phase 1 invariant: uniform field geometry. All fields in a plate share the same voxel shape, chunk grid, and scale. The `ContentGraph` and `ImageSpec` model already allows per-image divergence.

---

## What This Does NOT Cover

This spec covers the import pipeline — from "user provides a path" to "dataset is registered and fetchable." It does not cover:

- **Pipeline orchestration** (planning, CPU cache, worker protocol, GPU residency, rendering) — those are downstream consumers of the content graph and are addressed separately in DOMAINS.md §6.
- **Collaboration** — command sync and presence continue to work the same way, carrying `RegisterDataset`.
- **Derived layouts** — condition grids, comparison views, and other client-authored layouts. These are expressed as `LayoutSpec` values and registered with scene state, but the authoring logic is a separate concern.
- **Asset catalog** — overview/proxy product availability. This is a web-only overlay, separate from the canonical content graph.
- **Direct or local fetch modes** — the initial implementation uses `Proxied` mode exclusively. `Direct` and `Local` variants are structurally defined in the type system (with full serde round-trip coverage) but are not wired into any runtime code path. They should not be activated until their addressing and authentication requirements are fully specified.

---

## Related

- Per-crate architecture docs: `lucida-content/ARCHITECTURE.md`, `lucida-protocol/ARCHITECTURE.md`, `lucida-store/ARCHITECTURE.md`, `lucida-server/ARCHITECTURE.md`
- Domain model: `DOMAINS.md`
- Type definitions: see source code in each crate
