# Canonical Content Graph

The shared data model for what datasets contain and how their spatial components relate. Implemented in the `lucida-content` crate.

See also: [DOMAINS.md](../DOMAINS.md) section 1, [Import Pipeline Spec](import-pipeline-spec.md), [lucida-content GLOSSARY](../lucida-content/GLOSSARY.md).

---

## Purpose

The content graph answers one question: **what is this dataset?**

It does not say what to load, how to present it, what derived products exist, or what the camera is looking at. Those are the concerns of Scene State, the Asset Catalog, and the Pipeline. The content graph is the canonical, immutable description of a dataset's structure — its entities, their spatial relationships, their multiscale image data, and their source layout.

Every client (web, CLI, Python) consumes the same content graph types from the same Rust implementation. This is the foundation that the rest of the system builds on.

---

## Crate: `lucida-content`

Standalone Rust crate. Depends only on `serde`. No lucida crate dependencies.

### Dependency position

```
lucida-store ──produces──► lucida-content ◄──consumes── lucida-core
                                 ▲                          ▲
                                 │                          │
                           lucida-protocol            lucida-server
                           (depends on content)       (via core)
```

Neither `lucida-store` nor `lucida-core` depends on the other. Both depend on `lucida-content`. The protocol crate (`lucida-protocol`) also depends on `lucida-content` for shared types like `DataType` and `ImageId`.

---

## The ContentGraph type

`ContentGraph` is the root type. One is produced per dataset at import time.

```rust
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

| Field | Purpose |
|-------|---------|
| `dataset_id` | Stable identifier for this dataset |
| `name` | Human-readable name (from metadata or user) |
| `kind` | `Single` or `Plate { rows, columns, positioning_mode, has_stage_positions }` |
| `entities` | All nodes in the content hierarchy (images, wells, fields) |
| `transforms` | Directed spatial relationships between entities |
| `images` | Multiscale image metadata, linking entities to their pyramid data |
| `source_layouts` | Well/image placements derived deterministically from metadata |
| `default_layout_id` | Which source layout to activate on open |

---

## Subdomains

### 1. Entities

An entity is a node in the content hierarchy. Three kinds:

| Kind | Meaning | Parent |
|------|---------|--------|
| `Image` | A standalone multiscale image (single-image datasets) | None |
| `Well` | A container in a plate (e.g., well A1) | None |
| `Field` | A field of view within a well | Well entity |

```rust
pub struct Entity {
    pub id: EntityId,
    pub kind: EntityKind,
    pub parent: Option<EntityId>,
    pub labels: EntityLabels,
}
```

`EntityLabels` carries optional structured metadata: `name`, `well_row`, `well_column`, `row_index`, `column_index`, `field_index`. These come from OME-Zarr metadata and are used by layout construction and UI display.

**Entity identity is stable.** An entity's ID does not change based on which layout is active, whether a proxy has been generated for it, or which client is viewing it.

### 2. Transforms

A `TransformEdge` encodes a directed spatial relationship between two entities — typically a field-to-well translation.

```rust
pub struct TransformEdge {
    pub from: EntityId,    // child (field)
    pub to: EntityId,      // parent (well)
    pub transform: AffineTransform,
}

pub struct AffineTransform {
    pub matrix: [f64; 16],  // column-major 4x4
}
```

In practice, transforms are 2D translations positioning fields within their parent well. The 4x4 matrix encodes the translation in `matrix[12]` (tx) and `matrix[13]` (ty).

Two sources:
- **Stage positions:** From OME-Zarr `coordinateTransformations` with `type: "translation"`. Normalized so the minimum within each well is `[0, 0]`.
- **Grid positions:** Computed when stage positions are absent. Fields arranged in a sqrt-based grid with 8% FOV-width gaps.

Single-image datasets have no transforms (the image is the root entity).

### 3. Multiscale metadata

An `ImageSpec` links an image-bearing entity to its multiscale pyramid data.

```rust
pub struct ImageSpec {
    pub image_id: ImageId,
    pub owner: EntityId,
    pub multiscale: MultiscaleInfo,
}

pub struct MultiscaleInfo {
    pub axes: Vec<Axis>,
    pub levels: Vec<LevelGeometry>,
    pub data_type: DataType,
}
```

`owner` points to the entity this image belongs to — an `Image` entity for single-image datasets, a `Field` entity for plates.

**Per-level geometry:**

```rust
pub struct LevelGeometry {
    pub level_index: u32,
    pub shape: [u64; 5],        // [T, C, Z, Y, X]
    pub chunk_shape: [u64; 5],  // [T, C, Z, Y, X]
    pub grid_shape: [u64; 5],   // ceil(shape / chunk_shape)
    pub scale: [f64; 5],        // physical units per voxel
}
```

Key invariants:

- **Chunk shape is per-level.** Different resolution levels of the same image may have different chunk dimensions. There is no global "chunk size" for an image. All consumers must handle this.
- **`grid_shape` is precomputed.** `ceil(shape / chunk_shape)` per axis. Avoids redundant division in chunk iteration and LOD selection.
- **All arrays are 5D `[T, C, Z, Y, X]`.** Missing axes have size 1 in shape/chunk_shape/grid_shape and scale 1.0. Normalization happens once at import time — consumers never deal with variable axis orders.

Original axis metadata is preserved in `MultiscaleInfo.axes` for UI display (axis names and kinds).

**Data types:** `Uint8`, `Uint16`, `Uint32`, `Float32`, `Float64`.

### 4. Source layouts

A `LayoutSpec` describes a spatial arrangement of entities (specifically wells or standalone images).

```rust
pub struct LayoutSpec {
    pub id: LayoutId,
    pub name: String,
    pub placements: Vec<EntityPlacement>,
}

pub struct EntityPlacement {
    pub entity_id: EntityId,
    pub position: [f64; 2],  // [X, Y] in layout pixel space
}
```

**Source layouts place wells, not fields.** Field positions within wells come from `TransformEdge`. This keeps the layout clean — a well has one placement, and its internal field arrangement is a separate concern.

For plates, the source layout is a grid computed by `build_plate_layout()`:
- Well gap: 20% of FOV width
- Field gap within wells: 8% of FOV width
- Wells arranged in row-major plate grid order

For single-image datasets, the source layout has one placement at `[0, 0]`.

`LayoutSpec` is a portable value type — not browser-specific. Any client can create derived layouts and register them with Scene State. The browser authors condition grids and comparison views as `LayoutSpec` values, not as JS-only objects.

### 5. Dataset kind

```rust
pub enum DatasetKind {
    Single,
    Plate {
        rows: Vec<String>,
        columns: Vec<String>,
        positioning_mode: PositioningMode,
        has_stage_positions: bool,
    },
}
```

`PositioningMode` is `Stage` (from metadata coordinates) or `Grid` (computed).

---

## 5D normalization

All internal geometry uses fixed 5D arrays indexed as `[T, C, Z, Y, X]` (indices 0-4). This normalization is applied once at import time by `normalize_to_5d()` / `normalize_f64_to_5d()`.

Rules:
- Missing axes get size 1 in shape/chunk_shape/grid_shape
- Missing axes get scale 1.0
- Chunk keys are canonical 5D: `"level/t/c/z/y/x"` with zeros for missing axes
- Original axis names preserved in `MultiscaleInfo.axes` for display

This eliminates axis-order branching from all downstream code. Every consumer — Scene State, Planning, CPU Cache, GPU Residency — can assume 5D indexing.

---

## How the content graph is produced

The import pipeline in `lucida-store` parses OME-Zarr metadata and produces three outputs:

```rust
pub struct ImportResult {
    pub content: ContentGraph,
    pub fetch: ClientFetchDescriptor,
    pub binding_seed: ServerBindingSeed,
}
```

Only `ContentGraph` belongs to `lucida-content`. The other two belong to `lucida-protocol` and `lucida-store` respectively. See [Import Pipeline Spec](import-pipeline-spec.md) for the full import design.

The import flow:

1. `import_dataset(store, id, name)` reads root `zarr.json`
2. Detects plate vs. single image from `/attributes/ome/plate`
3. Parses multiscale metadata: axes, per-level shapes, chunk shapes, scales, data types
4. Normalizes all geometry to 5D
5. Constructs entities, transforms, image specs, and source layout
6. Returns `ImportResult` with the three outputs separated

The content graph is deterministic — the same OME-Zarr input always produces the same content graph.

---

## How consumers use the content graph

### Scene State (`lucida-core`)

On `RegisterDataset`, Scene State calls `build_derived_state(content)` to produce `DatasetDerivedState`:

- Selects the active layout (default or first)
- For each image-bearing entity, computes:
  - 2D position (from layout placement + field transform composition)
  - Volume transform (4x4 model matrix from level-0 geometry)
  - Level geometries for LOD selection
- Caches these as `MemberState` entries for hot-path geometric queries

The content graph itself is stored immutably in `DocumentState.content_graphs`. The derived state is a precomputed cache that is rebuilt when content changes — it is not serialized or shared.

### Server (`lucida-server`)

The server imports the content graph, builds an operational `ServerBinding` (ObjectStore handle, ChunkResolver, CachedStore) from the `ServerBindingSeed`, and broadcasts `RegisterDataset { content, fetch }` to all connected clients.

The server does not interpret the content graph beyond storing it and forwarding it. Chunk resolution uses the `ServerBindingSeed` / `ChunkResolver`, not the content graph directly.

### Web client (`lucida-web`)

Receives the content graph via `RegisterDataset` over WebSocket. Applies it as a document command, which triggers `build_derived_state()` in WASM. The web client reads entities, layouts, and channel metadata from the content graph for UI display (layer panel, navigation, settings).

### Python client (`lucida-py`)

Receives the same content graph via PyO3 bindings. Uses it for headless data access — entity enumeration, viewport queries, chunk coordinate computation.

### CLI (`lucida-cli`)

Consumes the content graph natively via direct Rust calls. Used for dataset inspection and viewport control.

---

## Design decisions

### Why a separate crate?

The content graph is consumed by every other crate: `lucida-core`, `lucida-store`, `lucida-protocol`, `lucida-server`, `lucida-cli`, `lucida-py`, and `lucida-web` (via WASM). If these types lived in `lucida-core`, then `lucida-store` would need to depend on `lucida-core` — creating a dependency between the import pipeline and the scene engine. The standalone `lucida-content` crate keeps the dependency graph clean and each crate focused.

### Why immutable?

The content graph describes what the dataset *is*, not what the client is doing with it. A well doesn't stop existing because the camera moved. A field's chunk shape doesn't change because the user switched layouts. Immutability means:

- Safe to share across threads without synchronization
- Safe to replicate to multiple clients without conflict resolution
- Deterministic — same input always produces the same graph
- No cache invalidation concerns for content-graph-derived computations

### Why source layouts live here

Source layouts are deterministic derivations from metadata — plate grid positions, stage positions. They are not client-authored arrangements. Placing them in the content graph means every client gets a usable default layout without needing browser-specific code.

Derived layouts (condition grids, comparison views) are authored by clients but expressed as `LayoutSpec` values — the same portable type. This keeps layout representation unified across the system.

### Why entities are independent of products

A well exists whether or not an overview proxy has been generated for it. If entity existence were tied to product availability, the content graph would change as the server generates overviews — breaking its immutability invariant and creating race conditions between import and product generation.

Product availability is tracked by the Asset Catalog (web only). The content graph says "well A1 exists here with these fields." The asset catalog says "a 3D proxy for well A1 is available at this resolution."

### Why per-level chunk geometry

OME-Zarr allows different chunk dimensions at different resolution levels. Treating chunk size as an image-level constant would silently produce wrong chunk coordinates for levels that deviate. The per-level design:

- Correctly handles real-world OME-Zarr data
- Makes the per-level nature explicit in the type system (`Vec<LevelGeometry>`)
- Pushes level-aware chunk iteration to consumers, where it belongs
- Avoids a "default chunk size" footgun

---

## Rules

These are the invariants that code touching the content graph must preserve:

1. **Deterministic and immutable.** The content graph for a given dataset does not change because of view state, layout selection, or client type.
2. **No runtime/fetch concerns.** Proxy availability, cache state, GPU residency, and wire format are not part of the content graph.
3. **Entities have stable identity.** Entity IDs do not change based on layout, presentation, or client.
4. **Per-level chunk geometry.** All consumers must handle per-level chunk shapes. There is no global "chunk size."
5. **5D normalization.** All shape/chunk/grid/scale arrays are `[T, C, Z, Y, X]`. No variable axis orders downstream of import.
6. **Source layouts place wells, not fields.** Field positioning within wells uses `TransformEdge`.
7. **Layouts are portable values.** `LayoutSpec` is shared, not browser-specific. Derived layouts are expressed as `LayoutSpec`, not as client-only objects.
8. **No lucida dependencies.** `lucida-content` depends only on `serde`. Adding a dependency on another lucida crate is a design error.
