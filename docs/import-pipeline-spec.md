# Import Pipeline Specification

How a filepath or GCS path becomes a registered dataset. This is the first phase of the atlas refactor: replacing the monolithic `AddDataset` command with a structured import pipeline that cleanly separates canonical content, client-visible fetch metadata, and server-private storage binding.

---

## Design Principles

1. **Import produces three distinct outputs**, not a monolithic command blob.
2. **Canonical content describes what the dataset is.** It does not describe how to fetch it, where it's stored, or how to display it.
3. **Fetch metadata describes how a client turns logical addresses into bytes.** It varies by client mode (proxied, direct, local) and does not contain storage internals.
4. **Server binding is operational and private.** It owns live resources (object store handles, caches, compiled resolvers) and never crosses the wire.
5. **Storage codec is not wire codec.** The server may read codec X from storage and send codec Y to clients.
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

### Current flow (being replaced)

```
User provides URL
  → Client sends OpenRemoteDataset { url } via WebSocket
  → Server: lucida_store::backend::open(url)
  → Server: lucida_store::metadata::read_dataset_info()
      → Returns DatasetMetadata { dataset: Dataset, level_paths, axes_names }
      → Dataset contains client_metadata JSON blob with axes, codecs, level paths
  → Server: builds DocumentCommand::AddDataset (flat bag of canonical + fetch + hints)
  → Server: wraps store in CachedStore, registers ServerStore { store, axes }
  → Server: broadcasts AddDataset to all clients
  → Client: applies AddDataset, parses client_metadata JSON, sets up fetchers
```

Problems:
- `Dataset` mixes canonical identity with fetch hints and layout-baked positions
- `client_metadata` is an untyped JSON blob that duplicates and diverges from typed fields
- `DatasetMember` bakes layout position into entity identity
- `ServerStore` carries raw `axes_names` instead of a compiled resolver
- Storage codec info is passed to clients even though the server proxies chunks
- Every client parses the same untyped blob differently

### New flow

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
  → Client: registers ContentGraph into scene state
  → Client: uses ClientFetchDescriptor to set up its fetch pipeline
           (web: proxied fetchers, py: headless fetch, cli: ignores — inspection only)
```

---

## Crate Responsibilities and Dependencies

### Dependency graph

```
                lucida-content
                  ↑       ↑
           ┌──────┘       └──────┐
      lucida-protocol            │
        ↑       ↑                │
   ┌────┘       └────┐           │
lucida-core      lucida-store ───┘
   ↑                ↑
   └──┐         ┌───┘
    lucida-server
```

`lucida-core` and `lucida-store` are sibling dependents of `lucida-protocol` — neither depends on the other. This is what makes `ImportResult` (in lucida-store) able to contain `ClientFetchDescriptor` (from lucida-protocol) without introducing a lucida-store → lucida-core dependency. `lucida-server` is the first place the two siblings come back together operationally: it consumes `ImportResult` from lucida-store and applies `RegisterDataset` through lucida-core's scene state.

### What changes in each crate

#### lucida-content

Owns the canonical data model.

**Types defined here:**
- ID types: `DatasetId`, `EntityId`, `ImageId`, `LayoutId`
- Entity model: `Entity`, `EntityKind`, `EntityLabels`
- Transforms: `TransformEdge`, `AffineTransform`
- Image geometry: `ImageSpec`, `MultiscaleInfo`, `Axis`, `AxisKind`, `LevelGeometry`, `DataType`
- Layouts: `LayoutSpec`, `EntityPlacement`, `PositioningMode`
- Dataset kind: `DatasetKind`
- Top-level graph: `ContentGraph`
- Plate layout construction: `build_plate_layout()`, `plate_extent()`

**Rules:**
- No dependencies on other lucida crates
- No protocol messages, no fetch descriptors
- Only dependency: `serde`
- Everything is `Serialize + Deserialize`

**Module structure:**
```
lucida-content/src/
├── lib.rs          // crate docs, re-exports
├── id.rs           // DatasetId, EntityId, ImageId, LayoutId
├── entity.rs       // Entity, EntityKind, EntityLabels
├── transform.rs    // TransformEdge, AffineTransform
├── image.rs        // ImageSpec, MultiscaleInfo, Axis, AxisKind, LevelGeometry, DataType
├── layout.rs       // LayoutSpec, EntityPlacement, PositioningMode
├── kind.rs         // DatasetKind
├── graph.rs        // ContentGraph
└── plate.rs        // build_plate_layout(), plate_extent()
```

**Full type definitions** are in the [lucida-content type reference](#lucida-content-type-reference) section below.

---

#### lucida-protocol

Shared fetch and registration types. Depends on `lucida-content` (for ID types, `DataType`, `ContentGraph`). Does not depend on `lucida-core` or `lucida-store`. Both `lucida-core` and `lucida-store` depend on this crate, which is what allows `ImportResult` to contain `ClientFetchDescriptor` without `lucida-store` depending on `lucida-core`.

**Types defined here:**

```rust
// --- Fetch descriptor ---

/// How a client turns logical chunk addresses into bytes for a dataset.
/// Enum by mode because the modes need different fields.
///
/// Proxied mode exposes only what the client needs (wire format per image).
/// Direct and Local modes additionally expose storage-facing addressing
/// (level paths, store prefixes) because the client resolves paths itself.
pub enum ClientFetchDescriptor {
    Proxied(ProxiedFetchDescriptor),
    Direct(DirectFetchDescriptor),
    Local(LocalFetchDescriptor),
}

/// Server-proxied fetch. Client sends logical chunk keys (image_id + canonical
/// chunk key), server resolves storage paths and returns bytes.
/// No storage-facing addressing is exposed — the server owns path resolution.
pub struct ProxiedFetchDescriptor {
    /// Per-image wire format. The client needs to know what byte encoding
    /// to expect per image (e.g., raw uint16 vs LZ4-compressed float32).
    /// Today all images in a plate share the same wire format, but the
    /// model does not assume this.
    pub images: Vec<ProxiedImageSpec>,
}

/// What the client needs to know about a proxied image's responses.
pub struct ProxiedImageSpec {
    pub image_id: ImageId,
    pub wire_format: WireFormat,
}

/// Client fetches directly from storage (future).
/// Needs storage-facing addressing because the client resolves paths itself.
pub struct DirectFetchDescriptor {
    pub images: Vec<DirectImageSpec>,
}

/// Local filesystem access (Python headless).
/// Same addressing needs as Direct — client resolves paths locally.
pub struct LocalFetchDescriptor {
    pub images: Vec<DirectImageSpec>,
}

/// Per-image fetch metadata for modes where the client resolves storage paths.
///
/// NOTE: This type is incomplete for phase 1. Level paths and store_prefix
/// alone are not sufficient for client-side path resolution — the client
/// would also need the original axis order (or a compiled chunk-path schema)
/// to map canonical 5D chunk keys to on-disk paths. In proxied mode this is
/// not a problem because the server's ChunkResolver owns that mapping.
/// Direct and Local modes will need additional fields (e.g., a chunk key
/// schema or axes_names) before they can be implemented. This is acceptable
/// because only Proxied mode is implemented in phase 1.
pub struct DirectImageSpec {
    pub image_id: ImageId,
    pub wire_format: WireFormat,
    /// Per-level addressing (level index → on-disk path).
    pub levels: Vec<LevelAddress>,
    /// Store prefix for routing chunk requests (e.g., "A/1/0" for plate FOVs).
    pub store_prefix: Option<String>,
}

/// How to address a specific level within an image's multiscale pyramid.
pub struct LevelAddress {
    pub level_index: u32,
    pub path: String,  // "0", "1", "2" — the on-disk level path
}

/// What byte format the client should expect from chunk responses.
pub enum WireFormat {
    /// Raw decompressed bytes (server decompresses before sending).
    Raw { data_type: DataType },
    /// LZ4-compressed bytes (client decompresses).
    Lz4 { data_type: DataType },
    /// Zstd-compressed bytes (client decompresses).
    Zstd { data_type: DataType },
}

// --- Registration command ---

/// Application-level message: a dataset has been imported and should be registered.
/// Carries canonical content and client-visible fetch metadata.
/// Does NOT carry server-private binding state.
///
/// The dataset ID is content.dataset_id — no redundant outer ID.
pub struct RegisterDataset {
    pub content: ContentGraph,
    pub fetch: ClientFetchDescriptor,
}
```

**Module structure:**
```
lucida-protocol/src/
├── lib.rs          // re-exports
├── fetch.rs        // ClientFetchDescriptor, ProxiedFetchDescriptor, DirectFetchDescriptor,
│                   // LocalFetchDescriptor, ProxiedImageSpec, DirectImageSpec,
│                   // LevelAddress, WireFormat
└── register.rs     // RegisterDataset
```

**Rules:**
- Depends only on `lucida-content` and `serde`
- No scene state, no storage, no runtime resources
- Everything is `Serialize + Deserialize`

---

#### lucida-core

Depends on `lucida-content` and `lucida-protocol`. Re-exports `lucida-protocol` types for ergonomic access. Loses ownership of `Dataset`, `Layer`, `LevelInfo`, `DatasetMember`, `PlateWell`, `PlateFov`, `PositioningMode`, `DatasetKind` (moved to lucida-content or removed) and `ClientFetchDescriptor`, `RegisterDataset` (moved to lucida-protocol).

The `DocumentCommand` enum becomes:

```rust
// In lucida-core::command (re-exports RegisterDataset from lucida-protocol)

pub enum DocumentCommand {
    RegisterDataset(RegisterDataset),
    RemoveDataset { id: DatasetId },
}
```

`SetVolumeScale` is removed. Scale is canonical content derived from `LevelGeometry` at import time. It is not a mutable property that should be patched after the fact.

**Scene state changes:**

`DocumentState`:

```rust
pub struct DocumentState {
    /// Keyed by DatasetId for O(1) lookup. Insertion order preserved for UI ordering.
    pub content_graphs: IndexMap<DatasetId, ContentGraph>,
}
```

`Scene::apply()` handles `RegisterDataset` by:
1. Storing the `ContentGraph` keyed by `dataset_id`
2. Computing `VolumeTransform` per `ImageSpec` from its `LevelGeometry` level 0 shape + scale (using existing `compute_volume_transform`). A dataset with multiple image-bearing entities gets a transform per image.
3. **Activating the default layout:** If `content.default_layout_id` is `Some(id)`, set that layout as active for this dataset. If `None`, activate the first source layout. This is not implicit — it is an explicit step in registration that scene state performs, so no downstream consumer needs to guess.

**Remains in lucida-core:**
- `VolumeTransform` and `compute_volume_transform()` — scene-state concern, computed from content at registration
- `compute_member_transform()` — computes per-entity model matrices from content + active layout
- `Camera`, `VisibleRegion`, `ChunkCoord` — geometric query types
- `visible_chunks()`, `select_level()` — geometric query functions, consuming `LevelGeometry` from content
- `DocumentCommand` — the full application command enum, including `RegisterDataset` (re-exported from lucida-protocol) and `RemoveDataset`
- `ClientMessage`, `ServerMessage`, `PresenceState` — session-level message types. These are not import/fetch types and remain in lucida-core. The name `lucida-protocol` refers specifically to the import/fetch registration layer, not to session messaging.

**File-level changes:**
- `chunk.rs`: `visible_chunks()` takes `LevelGeometry` instead of separate shape/chunk arrays. Uses precomputed `grid_shape`.
- `command.rs`: `DocumentCommand::RegisterDataset(RegisterDataset)` (re-exported from lucida-protocol). `SetVolumeScale` removed.
- `scene/types.rs`: `DocumentState.content_graphs: IndexMap<DatasetId, ContentGraph>`
- `protocol.rs`: `ServerMessage::CommandBroadcast` carries `RegisterDataset`
- `transform.rs`: unchanged (computes `VolumeTransform` from shape + scale, called per `ImageSpec`)

---

#### lucida-store

Depends on `lucida-content` and `lucida-protocol`. Does not depend on `lucida-core`.

Types previously imported from lucida-core (`Dataset`, `Layer`, `LevelInfo`, `DatasetMember`, etc.) now come from lucida-content. `plate::compute_fov_positions` is now `lucida_content::plate::build_plate_layout`. `compute_volume_transform` is no longer called during import (scene-state concern). `ClientFetchDescriptor` and related fetch types come from lucida-protocol.

**Return type:**

```rust
/// The structured result of importing a dataset from storage.
pub struct ImportResult {
    /// Canonical content model.
    pub content: ContentGraph,
    /// Client-visible fetch metadata (Proxied for server-mediated access).
    pub fetch: ClientFetchDescriptor,
    /// Serializable seed for building the server's operational binding.
    pub binding_seed: ServerBindingSeed,
}

/// Everything the server needs to build its operational binding.
/// Serializable, no live resources. Per-image to allow heterogeneous
/// images within a dataset (different axes, different codecs).
///
/// Does not include source_url — the server already has that from the
/// open() call and attaches it when building ServerBinding.
pub struct ServerBindingSeed {
    /// Per-image storage metadata. Today all plate images share the same
    /// axes and codecs, but the model does not assume this.
    pub images: Vec<ImageBindingSeed>,
}

/// Per-image server-side storage metadata.
pub struct ImageBindingSeed {
    pub image_id: ImageId,
    /// Original axis names from OME metadata, used to compile ChunkResolver.
    pub axes_names: Vec<String>,
    /// Store prefix for this image (e.g., "A/1/0" for plate FOVs).
    pub store_prefix: Option<String>,
    /// Storage codec information per level (as stored on disk, not wire format).
    pub storage_codecs: Vec<StorageCodecInfo>,
}

pub struct StorageCodecInfo {
    pub level_index: u32,
    /// Codec chain as stored in OME-Zarr metadata.
    pub codecs: Vec<serde_json::Value>,
}
```

**`import_dataset` replaces `read_dataset_info`:**

Returns `ImportResult { content, fetch, binding_seed }` instead of `DatasetMetadata { dataset, level_paths, axes_names }`.

For a single image dataset, the construction looks like:

```rust
pub async fn import_dataset(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
) -> Result<ImportResult, StoreError> {
    // Parse OME-Zarr metadata (same parsing logic as today)
    // ...

    // Build content graph
    let entity_id = EntityId(id.to_string());
    let image_id = ImageId(id.to_string());

    let entity = Entity {
        id: entity_id.clone(),
        kind: EntityKind::Image,
        parent: None,
        labels: EntityLabels { name: Some(name.to_string()), ..Default::default() },
    };

    let multiscale = MultiscaleInfo {
        axes: parsed_axes,           // Vec<Axis> from OME metadata
        levels: level_geometries,    // Vec<LevelGeometry>, normalized to 5D
        data_type: parsed_data_type, // DataType from zarr.json data_type field
    };

    let image = ImageSpec {
        image_id: image_id.clone(),
        owner: entity_id.clone(),
        multiscale,
    };

    let default_layout_id = LayoutId("source".to_string());
    let source_layout = LayoutSpec {
        id: default_layout_id.clone(),
        name: "Source".to_string(),
        placements: vec![EntityPlacement {
            entity_id: entity_id.clone(),
            position: [0.0, 0.0],
        }],
    };

    let content = ContentGraph {
        dataset_id: DatasetId(id.to_string()),
        name: name.to_string(),
        kind: DatasetKind::Single,
        entities: vec![entity],
        transforms: vec![],
        images: vec![image],
        source_layouts: vec![source_layout],
        default_layout_id: Some(default_layout_id),
    };

    // Build fetch descriptor (per-image, proxied mode — no storage addressing needed)
    let fetch = ClientFetchDescriptor::Proxied(ProxiedFetchDescriptor {
        images: vec![ProxiedImageSpec {
            image_id: image_id.clone(),
            wire_format: WireFormat::Raw { data_type: parsed_data_type },
        }],
    });

    // Build binding seed (per-image)
    let binding_seed = ServerBindingSeed {
        images: vec![ImageBindingSeed {
            image_id: image_id.clone(),
            axes_names,
            store_prefix: None,
            storage_codecs: level_entries.iter().enumerate().zip(level_metas.iter()).map(
                |((i, _), meta)| StorageCodecInfo {
                    level_index: i as u32,
                    codecs: meta.codecs.clone(),
                }
            ).collect(),
        }],
    };

    Ok(ImportResult { content, fetch, binding_seed })
}
```

For plates, the same function:
1. Parses plate root metadata (rows, columns, wells, FOVs) — same as today
2. Reads representative FOV multiscales — same as today
3. Builds `Entity` nodes for each well (`EntityKind::Well`) and field (`EntityKind::Field`) with parent links
4. Builds `TransformEdge` for field→well relationships:
   - **Stage positioning:** from OME metadata `coordinateTransformations[type=translation]`
   - **Grid positioning:** from `lucida_content::plate::build_grid_field_transforms()` which arranges fields within wells
5. Calls `lucida_content::plate::build_plate_layout()` to produce the source `LayoutSpec` — this places **wells** in a grid, not fields
6. Builds per-image `ImageBindingSeed` with `store_prefix` for server binding (store_prefix is server-private in proxied mode)
7. Returns `ImportResult`

**What `PlateInfo` becomes:**

`PlateInfo` remains an intermediate parsing type. It accumulates parsed plate metadata and has an `into_import_result()` method (or the construction is inlined). It produces `ContentGraph` entities + transforms + layout, not a `Dataset` with baked positions and a `client_metadata` JSON blob.

**Removed:**
- `client_metadata` JSON construction — replaced by typed structures
- `DatasetMetadata` type — replaced by `ImportResult`
- Dependency on lucida-core

**Unchanged:**
- `backend.rs`: scheme routing, `open()`
- `cache.rs`: `CachedStore` (consumed by server binding)
- `ingest.rs`
- Normalization helpers (`normalize_to_5d`, `normalize_f64_to_5d`, `axis_index`) — used during parsing
- `chunk_key_to_store_path` — consumed by `ChunkResolver` construction in lucida-server

---

#### lucida-server

Depends on `lucida-core`, `lucida-store`, `lucida-protocol`, `lucida-content`.

**Types defined here:**

```rust
/// Operational storage binding. Owns live resources.
/// Built from ServerBindingSeed + the original source URL + Arc<dyn ObjectStore> + cache config.
pub struct ServerBinding {
    pub source_url: String,     // from the open() call, not from the seed
    pub store: Arc<dyn ObjectStore>,
    pub resolver: ChunkResolver,
    pub cache: Arc<CachedStore>,
}

/// Compiled key→path mapper. Built once at import from per-image binding seeds.
/// Used per chunk request to resolve logical keys to object store paths.
pub struct ChunkResolver {
    /// Per-image resolvers, keyed by ImageId.
    images: HashMap<ImageId, ImageResolver>,
}

struct ImageResolver {
    axes_names: Vec<String>,
    store_prefix: Option<String>,
    // Potentially more fields for shard lookup, batched responses, etc.
}

impl ChunkResolver {
    /// Build from a ServerBindingSeed.
    pub fn new(seed: &ServerBindingSeed) -> Self {
        let images = seed.images.iter().map(|img| {
            let resolver = ImageResolver {
                axes_names: img.axes_names.clone(),
                store_prefix: img.store_prefix.clone(),
            };
            (img.image_id.clone(), resolver)
        }).collect();
        ChunkResolver { images }
    }

    /// Resolve a canonical chunk key to an object store path for a given image.
    pub fn resolve(&self, image_id: &ImageId, key: &str) -> Option<String> {
        let img = self.images.get(image_id)?;
        let store_path = lucida_store::chunk_key_to_store_path(key, &img.axes_names);
        Some(match &img.store_prefix {
            Some(prefix) => format!("{prefix}/{store_path}"),
            None => store_path,
        })
    }
}
```

**Handler before and after:**

Before (`handle_open_remote_dataset`):
```rust
// 1. Open store
let store = lucida_store::backend::open(&url)?;
// 2. Parse metadata → DatasetMetadata { dataset, level_paths, axes_names }
let meta = lucida_store::metadata::read_dataset_info(&store, &dataset_id, &name).await?;
// 3. Build AddDataset command from Dataset
let cmd = DocumentCommand::AddDataset { /* fields from meta.dataset */ };
// 4. Wrap store, register ServerStore { store, axes }
let cached = Arc::new(CachedStore::new(store.clone(), 512 * 1024 * 1024));
session.server_stores.insert(dataset_id, ServerStore { store: cached, axes: meta.axes_names });
// 5. Broadcast AddDataset
broadcast(ServerMessage::CommandBroadcast { seq, command: cmd });
```

After:
```rust
// 1. Open store (unchanged)
let store = lucida_store::backend::open(&url)?;
// 2. Import → ImportResult { content, fetch, binding_seed }
let result = lucida_store::import::import_dataset(&store, &dataset_id, &name).await?;
// 3. Build ServerBinding from seed + live resources
let cached = Arc::new(CachedStore::new(store.clone(), 512 * 1024 * 1024));
let resolver = ChunkResolver::new(&result.binding_seed);
let binding = ServerBinding {
    source_url: url.clone(),
    store: store.clone(),
    resolver,
    cache: cached,
};
// 4. Register binding (replaces server_stores)
session.server_bindings.insert(result.content.dataset_id.clone(), binding);
// 5. Build and broadcast RegisterDataset (content + fetch, no binding)
let cmd = DocumentCommand::RegisterDataset(RegisterDataset {
    content: result.content,
    fetch: result.fetch,
});
broadcast(ServerMessage::CommandBroadcast { seq, command: cmd });
```

**Chunk serving before and after:**

Before (`serve_chunk_from_store`):
```rust
let server_store = session.server_stores.get(&dataset_id)?;
let store_path = lucida_store::chunk_key_to_store_path(&key, &server_store.axes);
let full_path = match store_prefix {
    Some(prefix) => format!("{prefix}/{store_path}"),
    None => store_path,
};
let bytes = server_store.store.get_bytes(&Path::from(full_path)).await?;
```

After:
```rust
let binding = session.server_bindings.get(&dataset_id)?;
let object_path = binding.resolver.resolve(&image_id, &key)
    .ok_or_else(|| /* unknown image */)?;
let bytes = binding.cache.get_bytes(&Path::from(object_path)).await?;
```

The resolver encapsulates per-image axis→path mapping and store_prefix routing. Adding shard support, batched responses, or alternative storage layouts later only changes the resolver internals. Different images within a dataset can have different axes or prefixes without changing the serving interface.

**Session state:**

```rust
pub struct Session {
    pub document_state: DocumentState,
    pub server_bindings: HashMap<DatasetId, ServerBinding>,
    // ...
}
```

Replaces `server_stores: HashMap<String, ServerStore>`.

---

#### lucida-web

**Bridge/hooks layer:**

Reception of `RegisterDataset`:
```typescript
if (cmd.type === "register_dataset") {
    const { content, fetch } = cmd;
    // 1. Register content graph into WASM scene state
    wasmScene.register_content(content);
    // 2. Set up fetch pipeline from typed descriptor
    setupFetchPipeline(content, fetch);
}
```

`setupFetchPipeline` consumes the typed `ClientFetchDescriptor`:

```typescript
function setupFetchPipeline(content: ContentGraph, fetch: ClientFetchDescriptor) {
    if (fetch.type === "proxied") {
        // Proxied: each image has wire_format only — server resolves all addressing
        for (const spec of fetch.images) {
            registerProxiedFetcher(spec.image_id, content.dataset_id, spec.wire_format);
        }
    }
    // Direct and Local modes would additionally consume level paths and store prefixes
}
```

**What the web client reads from `ContentGraph`:**
- `content.images[].multiscale.axes` → which dimension sliders to show (T, C, Z)
- `content.images[].multiscale.levels` → level count, shape for LOD selection
- `content.images[].multiscale.data_type` → contrast range defaults
- `content.kind` → whether to show plate UI
- `content.source_layouts` → initial layout
- `content.entities` → entity labels for UI (well names, field indices)

---

#### lucida-py

- Receives `RegisterDataset` with typed content + fetch descriptor
- Registers `ContentGraph` via PyO3 into the Rust scene state
- Uses `ClientFetchDescriptor` to set up headless fetch pipeline
- For local access, the descriptor is `Local` instead of `Proxied`

---

#### lucida-cli

- Receives `RegisterDataset` via WebSocket broadcast
- Registers content graph into native Rust scene state (direct, no FFI)
- Ignores `ClientFetchDescriptor` — CLI is inspection/control only, no chunk fetching

---

## Normalization Conventions

### Axis order

All internal geometry uses fixed 5D `[T, C, Z, Y, X]` (indices 0–4). Missing axes have size 1 in shape/chunk_shape/grid_shape and scale 1.0. Original axis metadata is preserved in `MultiscaleInfo.axes` for UI purposes (e.g., hiding the T slider for a 3D dataset).

This is the same convention the existing codebase uses via `normalize_to_5d`. The normalization happens once at import time in lucida-store.

### Coordinate conventions

- Entity placements: `[X, Y]` in layout pixel space
- Shapes: `[T, C, Z, Y, X]` in normalized axis order
- Scales: `[T, C, Z, Y, X]` physical units per voxel
- Transform matrices: column-major 4x4 `[f64; 16]`
- Chunk keys: `"level/t/c/z/y/x"` (canonical 5D, with 0 for missing axes) — unchanged from current

---

## Type Migration Table

### Migration from old types

| Old type | New type / location | Notes |
|---|---|---|
| `Dataset` | `ContentGraph` (lucida-content) | Decomposed into entities + images + layouts |
| `DatasetKind` | `DatasetKind` (lucida-content) | Plate variant drops `wells` field |
| `PlateWell` | `Entity` kind: Well (lucida-content) | Position removed, labels carry row/col |
| `PlateFov` | `Entity` kind: Field (lucida-content) | Position → transforms, store_prefix → fetch |
| `PositioningMode` | `PositioningMode` (lucida-content) | Unchanged |
| `Layer` | `ImageSpec` + `MultiscaleInfo` (lucida-content) | Decomposed |
| `LevelInfo` | `LevelGeometry` (lucida-content) | Gains grid_shape, scale, full 5D |
| `compute_fov_positions()` | `build_plate_layout()` (lucida-content) | Returns LayoutSpec, no mutation |
| `plate_extent()` | `plate_extent()` (lucida-content) | Takes LayoutSpec instead of wells |
| `DatasetMember` | Removed | Split: identity → Entity, position → LayoutSpec, store_prefix → ImageBindingSeed / DirectImageSpec |
| `DatasetMetadata` | `ImportResult` (lucida-store) | Structured three-part output |
| `client_metadata` JSON | Removed | Replaced by typed ContentGraph + ClientFetchDescriptor |
| `ServerStore` | `ServerBinding` (lucida-server) | Operational, with compiled ChunkResolver |

### Types by crate

| Crate | New types |
|---|---|
| **lucida-content** | `DatasetId`, `EntityId`, `ImageId`, `LayoutId`, `ContentGraph`, `Entity`, `EntityKind`, `EntityLabels`, `TransformEdge`, `AffineTransform`, `ImageSpec`, `MultiscaleInfo`, `Axis`, `AxisKind`, `LevelGeometry`, `DataType`, `LayoutSpec`, `EntityPlacement` |
| **lucida-protocol** | `ClientFetchDescriptor` (enum), `ProxiedFetchDescriptor`, `ProxiedImageSpec`, `DirectFetchDescriptor`, `LocalFetchDescriptor`, `DirectImageSpec`, `LevelAddress`, `WireFormat`, `RegisterDataset` |
| **lucida-store** | `ImportResult`, `ServerBindingSeed`, `ImageBindingSeed`, `StorageCodecInfo` |
| **lucida-server** | `ServerBinding`, `ChunkResolver` |

---

## Implementation Order

### Step 1: Create lucida-content crate

Define all canonical types. No other crate changes yet — this is additive.

- Create `lucida-content/` with `Cargo.toml` (edition 2024, serde dependency only)
- Define all types listed in the module structure above
- Move `compute_fov_positions` and `plate_extent` from `lucida-core/plate.rs`, refactored to produce `LayoutSpec` instead of mutating entities
- Move normalization helpers (`normalize_to_5d`, `normalize_f64_to_5d`, `axis_index`) from lucida-store — these are used by both lucida-store (during parsing) and lucida-content (during layout construction)
- Add to workspace `Cargo.toml`
- Write tests for plate layout construction and normalization

### Step 2: Create lucida-protocol crate

Define fetch and registration types. Depends only on lucida-content.

- Create `lucida-protocol/` with `Cargo.toml` (edition 2024, depends on lucida-content + serde)
- Define `ClientFetchDescriptor`, `ProxiedFetchDescriptor`, `ProxiedImageSpec`, `DirectFetchDescriptor`, `LocalFetchDescriptor`, `DirectImageSpec`, `LevelAddress`, `WireFormat`
- Define `RegisterDataset`
- Add to workspace `Cargo.toml`

### Step 3: Refactor lucida-store to return ImportResult

- Add `lucida-content` and `lucida-protocol` to lucida-store's dependencies
- Create `lucida_store::import` module (or refactor `metadata.rs`)
- Refactor `read_dataset_info` → `import_dataset` returning `ImportResult`
- Define `ServerBindingSeed`, `ImageBindingSeed`, and `StorageCodecInfo` in lucida-store
- Keep the old `read_dataset_info` temporarily as a compatibility shim if needed
- Remove `client_metadata` JSON construction
- Remove lucida-core dependency from lucida-store
- Update existing tests to use new return type

### Step 4: Update lucida-core

- Add `lucida-content` and `lucida-protocol` to lucida-core's dependencies
- Re-export `RegisterDataset` from lucida-protocol in `command.rs`
- Update `DocumentCommand` enum: `AddDataset` → `RegisterDataset`
- Update `DocumentState`: `datasets: Vec<Dataset>` → `content_graphs: IndexMap<DatasetId, ContentGraph>`
- Update `Scene::apply()` to handle `RegisterDataset` (compute VolumeTransform per ImageSpec, activate default layout)
- Update `visible_chunks` to consume `LevelGeometry`
- Remove old types (`Dataset`, `Layer`, `LevelInfo`, `DatasetMember`, `PlateWell`, `PlateFov`)
- Remove `plate.rs` from lucida-core (moved to lucida-content)

### Step 5: Update lucida-server

- Define `ServerBinding`, `ChunkResolver` in lucida-server
- Update handler to call `import_dataset`, build `ServerBinding`, broadcast `RegisterDataset`
- Update chunk serving to use `ChunkResolver`
- Replace `ServerStore` with `ServerBinding` in session state
- Update protocol serialization

### Step 6: Update clients

- **lucida-web**: Update bridge to receive `RegisterDataset`, replace `setupRemoteDataset` with typed `setupFetchPipeline`, remove `client_metadata` parsing
- **lucida-py**: Update WebSocket handler to receive `RegisterDataset`, register content via PyO3
- **lucida-cli**: Update command reception (registers content graph, ignores fetch descriptor)

### Step 7: Clean up

- Remove any compatibility shims from step 3
- Remove old `DatasetMetadata` type
- Remove `client_metadata` field from any remaining types
- Verify all tests pass
- Verify web, CLI, and Python clients work end-to-end

---

## lucida-content Type Reference

Detailed type definitions for the canonical content model. Everything here lives in the `lucida-content` crate with no dependencies on other lucida crates. Only dependency: `serde`.

### ID Types

```rust
/// Stable dataset identity. Assigned by the server on import.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DatasetId(pub String);

/// Stable entity identity within a dataset.
/// For plates: well path ("A/1") or field path ("A/1/0").
/// For single images: same as dataset_id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntityId(pub String);

/// Identifies an image-bearing entity's multiscale image data.
/// Distinct from EntityId because not all entities bear images (wells don't).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ImageId(pub String);

/// A unique identifier for a registered layout.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LayoutId(pub String);
```

**ID assignment conventions:**
- `DatasetId`: server-assigned, typically `"srv-{hash}"` from the source URL.
- `EntityId`: derived from dataset structure. For a single image dataset, same as dataset_id. For plates, the well path (`"A/1"`) or field store prefix (`"A/1/0"`).
- `ImageId`: same as the `EntityId` of the image-bearing entity. Every `ImageSpec` has a unique `ImageId`, and every `ImageId` maps 1:1 to an `EntityId` with `EntityKind::Image` or `EntityKind::Field`.

### Entity Model

An entity is a node in the content graph's hierarchy. It carries identity and labels, not position.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub id: EntityId,
    pub kind: EntityKind,
    pub parent: Option<EntityId>,
    pub labels: EntityLabels,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityKind {
    /// A standalone image. Used for non-plate datasets. Image-bearing.
    Image,
    /// A well in a plate. Not image-bearing — contains fields.
    Well,
    /// A field (FOV) within a well. Image-bearing.
    Field,
}

/// Structured metadata for display and lookup.
/// Not all fields apply to all entity kinds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntityLabels {
    /// Human-readable name (e.g., "A/1", "Field 0").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Well row label (e.g., "A"). Only for wells and their children.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub well_row: Option<String>,
    /// Well column label (e.g., "1"). Only for wells and their children.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub well_column: Option<String>,
    /// Row index within the plate grid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_index: Option<u32>,
    /// Column index within the plate grid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_index: Option<u32>,
    /// Field/FOV index within a well (0-based).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_index: Option<u32>,
}
```

**Entity hierarchy for a single image dataset:**
```
Image (EntityKind::Image, parent: None)
```

**Entity hierarchy for a plate dataset:**
```
Well A/1 (EntityKind::Well, parent: None)
  ├─ Field A/1/0 (EntityKind::Field, parent: Some("A/1"))
  └─ Field A/1/1 (EntityKind::Field, parent: Some("A/1"))
Well B/2 (EntityKind::Well, parent: None)
  └─ Field B/2/0 (EntityKind::Field, parent: Some("B/2"))
```

Wells are top-level entities (no dataset-level entity needed — the dataset is the `ContentGraph` itself). Fields are children of wells.

### Transforms

Spatial relationships between entities from source metadata. Not layout-dependent — these are intrinsic to the dataset.

```rust
/// A directed spatial transform between two entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformEdge {
    pub from: EntityId,
    pub to: EntityId,
    pub transform: AffineTransform,
}

/// A 2D or 3D affine transform.
/// For field→well transforms from stage positions, this is typically
/// a pure translation. The full affine is available for future use.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffineTransform {
    /// Column-major 4x4 matrix. Identity = no transform.
    pub matrix: [f64; 16],
}
```

**When transforms exist:**
- **Plate with stage positions:** Each field has a `TransformEdge` from field to its parent well, encoding the stage translation from OME metadata `coordinateTransformations[type=translation]`.
- **Plate with grid positioning:** Each field has a `TransformEdge` from field to its parent well, computed by `build_grid_field_transforms()`. This arranges fields in a grid within each well using gap fractions.
- **Single image:** No transforms. One entity, no parent.

In both plate modes, every field has a field→well transform. The difference is only where the transform comes from (metadata vs computed grid). This is what allows layouts to place wells without knowing about fields — the field→well transform is always available to compose with the well's layout position.

**What transforms do NOT include:**
- Layout-derived positions (well placement in view space). Those come from `LayoutSpec`.
- `VolumeTransform` (voxel space → normalized world space). That's computed by `lucida-core` scene state from `LevelGeometry` shape + scale.

### Image and Multiscale Geometry

```rust
/// An image-bearing entity's multiscale specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSpec {
    pub image_id: ImageId,
    /// The entity that owns this image. Must have EntityKind::Image (standalone)
    /// or EntityKind::Field (FOV within a well).
    pub owner: EntityId,
    pub multiscale: MultiscaleInfo,
}

/// Everything needed for geometric reasoning about a multiscale image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiscaleInfo {
    /// Canonical axis definitions, preserving original metadata.
    pub axes: Vec<Axis>,
    /// Per-level geometry, ordered from finest (level 0) to coarsest.
    pub levels: Vec<LevelGeometry>,
    /// Semantic data type of the image values.
    pub data_type: DataType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Axis {
    /// Original axis name from OME metadata (e.g., "t", "c", "z", "y", "x").
    pub name: String,
    /// Semantic kind.
    pub kind: AxisKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AxisKind {
    Time,
    Channel,
    Space,
}

/// Per-level shape, chunk grid, and scale in the multiscale pyramid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelGeometry {
    /// Level index (0 = finest/full resolution).
    pub level_index: u32,
    /// Voxel shape, normalized to [T, C, Z, Y, X]. Missing axes are 1.
    pub shape: [u64; 5],
    /// Chunk shape, normalized to [T, C, Z, Y, X]. Missing axes are 1.
    pub chunk_shape: [u64; 5],
    /// Grid shape: ceil(shape[i] / chunk_shape[i]) per axis.
    /// Precomputed to avoid redundant division in hot paths
    /// (chunk iteration, frustum culling, LOD selection).
    pub grid_shape: [u64; 5],
    /// Physical scale per axis, normalized to [T, C, Z, Y, X]. Missing axes are 1.0.
    pub scale: [f64; 5],
}

/// Semantic data type of image values. Not wire encoding or storage codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataType {
    Uint8,
    Uint16,
    Uint32,
    Float32,
    Float64,
}
```

For plates, many fields may share identical `MultiscaleInfo` (same axes, same level geometry, same data type). The model allows divergence — each field gets its own `ImageSpec` even if the geometry is the same.

**Why `[u64; 5]` and not `Vec<u64>`:** The renderer, planner, and geometric query engine all think in T,C,Z,Y,X. Fixed arrays avoid per-access branching on axis count and make hot paths simpler. Normalization happens once at import time.

**Why `grid_shape` is precomputed:** `ceil(shape / chunk_shape)` is used in chunk iteration, frustum culling, and LOD computation. Computing it once at import avoids redundant work in every planning cycle.

### Dataset Kind

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub enum DatasetKind {
    #[default]
    Single,
    Plate {
        /// Row labels (e.g., ["A", "B", "C"]).
        rows: Vec<String>,
        /// Column labels (e.g., ["1", "2", "3"]).
        columns: Vec<String>,
        /// How FOVs are positioned within wells.
        positioning_mode: PositioningMode,
        /// Whether any FOV has stage position metadata.
        has_stage_positions: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PositioningMode {
    /// FOVs positioned by stage coordinates from metadata.
    Stage,
    /// FOVs arranged in a regular grid pattern.
    #[default]
    Grid,
}
```

`DatasetKind::Plate` carries plate-level metadata (dimensions, positioning mode) but does NOT carry a list of wells or FOVs. Well and field membership is expressed through the entity tree.

### Source Layouts

```rust
/// A spatial arrangement of entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutSpec {
    pub id: LayoutId,
    /// Human-readable name (e.g., "Plate Grid", "Stage Positions").
    pub name: String,
    /// Per-entity placement in this layout.
    pub placements: Vec<EntityPlacement>,
}

/// Where an entity goes in a particular layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityPlacement {
    pub entity_id: EntityId,
    /// Position in layout space [X, Y].
    pub position: [f64; 2],
}
```

**Source layouts produced at import:**
- **Single image:** One layout placing the sole entity at the origin.
- **Plate:** One layout placing **wells** in a grid based on row/column indices. Field positions within wells come from `TransformEdge` (field→well), not from the layout. This separation is what makes custom well layouts (condition grids, filtered views) possible later without recomputing field coordinates — swapping the layout re-places wells, and field-to-well transforms stay fixed.

**Default layout:** `ContentGraph.default_layout_id: Option<LayoutId>` tells scene state which layout to activate on registration. If `None`, the first source layout is used.

### ContentGraph (top-level type)

```rust
/// The canonical content model for a dataset.
///
/// Describes what the dataset is as a scientific object: its entities,
/// their spatial relationships, image geometry, and source layouts.
/// Deterministic and immutable for a given dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentGraph {
    pub dataset_id: DatasetId,
    pub name: String,
    pub kind: DatasetKind,
    pub entities: Vec<Entity>,
    pub transforms: Vec<TransformEdge>,
    pub images: Vec<ImageSpec>,
    pub source_layouts: Vec<LayoutSpec>,
    pub default_layout_id: Option<LayoutId>,
}
```

**Traversal patterns** (linear scans are fine for our entity counts — hundreds to low thousands):

```rust
// What fields does well A/1 have?
entities.iter().filter(|e| e.parent.as_ref() == Some(&well_id))

// What image geometry does field A/1/0 have?
images.iter().find(|img| img.owner == field_entity_id)

// What is the stage translation for field A/1/0 relative to well A/1?
transforms.iter().find(|t| t.from == field_id && t.to == well_id)

// Where does well A/1 go in the default layout?
let layout = source_layouts.iter().find(|l| Some(&l.id) == default_layout_id.as_ref());
layout.placements.iter().find(|p| p.entity_id == well_id)
```

### Plate Layout Construction (moved from lucida-core)

`compute_fov_positions` and `plate_extent` move to `lucida-content::plate` because they are pure functions from metadata to layout.

**Key design rule:** `build_plate_layout` places **wells**, not fields. Field positions within wells are expressed as `TransformEdge` (field→well) from source metadata. This separation means:
- Swapping to a custom well layout (condition grid, filtered view) re-places wells without recomputing field coordinates.
- Stage translations remain intrinsic field→well transforms, not layout placements.
- `plate_extent` computes the bounding box from well placements plus the local extent of fields within each well (from transforms + FOV shape).

**Phase 1 invariant: uniform field geometry.** The plate layout helpers take a single `fov_shape` parameter, which assumes all fields in a plate share the same voxel shape, chunk grid, and scale. This is a stated invariant for phase 1 — it matches all datasets we currently handle. The `ContentGraph` and `ImageSpec` model already allows per-image divergence, so when heterogeneous plates arrive, the layout helpers will need to accept per-field geometry (e.g., via a map from `ImageId` to `LevelGeometry`). The canonical types do not need to change; only these helper signatures do.

```rust
// lucida-content/src/plate.rs

/// Build a source layout that places wells in a grid.
/// Field positions within wells come from TransformEdges, not from this layout.
///
/// Only EntityKind::Well entities receive placements. Field entities are
/// used solely to derive per-well field counts for spacing calculations
/// and must not be treated as placement targets.
pub fn build_plate_layout(
    entities: &[Entity],            // full entity list — wells and fields
    plate_rows: &[String],
    plate_columns: &[String],
    fov_shape: [u64; 5],            // for computing well spacing with gap fractions
) -> LayoutSpec

/// Build field→well TransformEdges for grid-positioned plates
/// (where metadata has no stage translations).
///
/// Precondition: every field entity must have a `field_index` in its
/// `EntityLabels`, and field indices must be unique within each well.
///
/// Fields within each well are ordered by `field_index` and arranged
/// in a row-major grid. This ordering is deterministic: two
/// implementations given the same entity set must produce identical
/// transforms.
pub fn build_grid_field_transforms(
    well_entities: &[Entity],
    field_entities: &[Entity],      // only EntityKind::Field
    fov_shape: [u64; 5],
) -> Vec<TransformEdge>

/// Compute the bounding box of a plate from well placements and
/// field extents within each well.
pub fn plate_extent(
    layout: &LayoutSpec,
    field_transforms: &[TransformEdge],
    fov_shape: [u64; 5],
) -> [f64; 2]
```

Returns a `LayoutSpec` with well placements and `TransformEdge` values for field→well relationships. No mutation, no side effects.

---

## What This Does NOT Cover

This spec covers the import pipeline — from "user provides a path" to "dataset is registered and fetchable." It does not cover:

- **Pipeline orchestration** (planning, CPU cache, worker protocol, GPU residency, rendering) — those are downstream consumers of the content graph and are addressed separately in DOMAINS.md §6.
- **Collaboration** — command sync and presence continue to work the same way, just carrying `RegisterDataset` instead of `AddDataset`.
- **Derived layouts** — condition grids, comparison views, and other client-authored layouts. These are expressed as `LayoutSpec` values and registered with scene state, but the authoring logic is a separate concern.
- **Asset catalog** — overview/proxy product availability. This is a web-only overlay, separate from the canonical content graph.
- **Direct or local fetch modes** — the initial implementation uses `Proxied` mode exclusively. `Direct` and `Local` variants are defined in the type system but are intentionally incomplete (see `DirectImageSpec` note) and should not be wired into runtime code paths until their addressing requirements are fully specified.
