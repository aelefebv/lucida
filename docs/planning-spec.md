# Planning Specification

How visible entities and camera state become prioritized chunk requests. The Planning domain is a pure function — `PlanningSnapshot → RequestPlan` — that decides what to load, at what priority, for which entities. It does not fetch data, manage GPU state, or read from other domains directly.

See also: [DOMAINS.md](../DOMAINS.md) section 6.1, [Orchestrator Integration Spec](orchestrator-integration-spec.md), [GLOSSARY.md](../GLOSSARY.md).

---

## Design Principles

1. **Planning is a pure function.** It receives a complete `PlanningSnapshot` and returns a `RequestPlan`. No I/O, no GPU calls, no network fetches, no direct reads from other domains.
2. **Testable in isolation.** Synthetic snapshots are sufficient — no WASM, no worker, no browser required. The test suite has 50+ tests using only in-memory data.
3. **Planning decides _what_ to load.** It does not decide _how_ to fetch or _where_ to store. Those are CPU Cache and GPU Residency concerns.
4. **Rust handles geometry, TypeScript handles policy.** WASM produces compact geometric recommendations (`ViewQueryResult`, `VisibleRegion`). TypeScript applies promotion thresholds, scheduling priorities, cache filtering, and temporal prefetch on top.
5. **Epoch-based invalidation.** Planning is only re-invoked when relevant epochs change. Identical epochs produce identical plans — the Orchestrator can cache the result.

---

## Implementation Split

Planning spans two languages:

```
Rust (lucida-core)                          TypeScript (lucida-web)
─────────────────                           ───────────────────────
Geometric query engine                      Policy + scheduling
  Scene::view_query()                         plan()
    → ViewQueryResult                           → RequestPlan
  Camera::visible_region()
    → VisibleRegion                           Subdomains:
  chunk::select_level()                         promote()
  chunk::visible_chunks()                       iterateChunks()
  chunk::visible_and_prefetch_chunks()          sortCenterOut()
  chunk::chunk_outside_frustum()                computePriority()
```

The Rust side answers: "given this camera and these entities, what is geometrically important?" The TypeScript side answers: "given what is important, what has been cached, and what the user is doing, what chunks should we request and in what order?"

### Why this split?

LOD is not one decision — it is four, split across layers:

| LOD decision | Language | Depends on |
|---|---|---|
| **Ideal target LOD** | Rust | Camera, voxel scale, entity bounds — pure geometry |
| **Representation selection** (overview / detail) | TypeScript | Projected size, hysteresis, asset availability |
| **Detail-owned LOD range** (target + seed levels) | TypeScript | Promotion policy, number of levels |
| **Realized requests** (which exact chunks to fetch) | TypeScript | Cache state, visible channels, temporal runway |

---

## Data Model

### Input: PlanningSnapshot

The full input to `plan()`. Assembled by the Orchestrator from upstream domains.

```typescript
interface PlanningSnapshot {
  epochs: PlanningEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  cacheState: CacheStateSnapshot;
  workerWantedSet: WorkerWantedSetSnapshot;
  previousActiveSet: ActiveSetEntry[];
  assetCatalog: AssetCatalogSnapshot | null;
}
```

Each field and its upstream source:

```
PlanningSnapshot
├── epochs ──────────────── scene.epochs()  [WASM]
│     content, layout, view, selection (from SceneEpochs)
│     + asset (0 until Asset Catalog)
│     + request (bumped per plan cycle)
├── entities ────────────── scene.view_query(dsId)  [WASM]
│     Per-entity: visibility, projectedDiagonalPx, idealTargetLod,
│     importance, centroidWorld, levels (from ContentGraph)
├── visibleRegion ───────── scene.visible_region(dsId)  [WASM]
│     xyBounds, zRange, effectiveZoom, sortCenter, frustumPlanes
├── selection
│   ├── t, c, z ─────────── scene.t(), scene.c(), scene.z()
│   ├── visibleChannels ─── getActiveChannels(dsSettings)
│   ├── renderMode ──────── camera mode (slice / volume)
│   └── interactionState ── "idle" (stub, future: from input handler)
├── cacheState
│   └── cached ──────────── Map<entityId, Set<chunkKey>> from CPU cache
├── workerWantedSet
│   └── resident ────────── Map<entityId, Set<chunkKey>> (stub until M3)
├── previousActiveSet ───── orchestrator.previousActiveSet (own state)
└── assetCatalog ────────── null (stub until Asset Catalog)
```

### Output: RequestPlan

```typescript
interface RequestPlan {
  requests: ChunkRequest[];    // Priority-ordered across all lanes
  activeSet: ActiveSetEntry[]; // LOD state for next frame's hysteresis
  epochs: PlanningEpochs;      // Propagated with bumped requestEpoch
}
```

### Key Types

**EntitySnapshot** — one entry per image-bearing entity, assembled from `ViewQueryResult` + content graph:

```typescript
interface EntitySnapshot {
  entityId: string;
  imageId: string;
  kind: "Image" | "Well" | "Field";
  visible: boolean;
  projectedDiagonalPx: number;   // Screen-space bounding diagonal
  projectedAreaPx2: number;
  centroidWorld: [number, number, number];
  idealTargetLod: number;        // From Rust: geometric recommendation
  importance: number;            // projectedAreaPx2 / distance
  numLevels: number;
  levels: LevelGeometry[];       // Per-level shape/chunk_shape/grid_shape
  position: [number, number];    // Layout placement (composed)
}
```

**ChunkRequest** — a single prioritized fetch entry:

```typescript
interface ChunkRequest {
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  lane: "overview" | "detail" | "runway";
  priority: number;              // Lower = more urgent
  chunkKey: string;              // Canonical: "level/t/c/z/y/x"
}
```

**ActiveSetEntry** — per-entity planning result, carried forward for hysteresis:

```typescript
interface ActiveSetEntry {
  entityId: string;
  imageId: string;
  representation: "overview" | "proxy" | "detail";
  targetLod: number;             // Finest level to request
  seedDetailLod: number;         // Coarsest detail-owned level
  detailOwnedLodRange: [number, number];  // [finest, coarsest] inclusive
}
```

**VisibleRegion** — compact geometric output from WASM:

```typescript
interface VisibleRegion {
  xyBounds: [number, number, number, number];  // [minX, minY, maxX, maxY] voxels
  zRange: [number, number];                     // [start, end) voxels
  effectiveZoom: number;                        // Screen pixels per voxel
  sortCenter: [number, number, number] | null;  // Center-out loading origin
  frustumPlanes: [number, number, number, number][] | null;  // 6 planes (3D)
}
```

---

## Core Algorithm

`plan()` executes eight steps:

```
plan(snapshot)
  │
  ├─ Step 1: promote(entities, previousActiveSet)
  │    → activeSet: ActiveSetEntry[]
  │    Decides representation (overview/detail) per entity with hysteresis.
  │
  ├─ Step 2: Build entityById lookup
  │    O(1) access for later steps.
  │
  ├─ Step 3: Detail lane
  │    For each detail entry: iterateChunks() at current T,
  │    assign detail priority (lane offset 0).
  │
  ├─ Step 4: Runway lane
  │    For each detail entry: iterateChunks() at T+1..T+RUNWAY_DEPTH,
  │    assign runway priority (lane offset 1000+).
  │
  ├─ Step 5: Overview lane
  │    For all entities: iterateChunks() at coarsest LOD only,
  │    assign overview priority (lane offset 2000).
  │
  ├─ Step 6: Merge and sort by priority (ascending)
  │    Produces a single priority-ordered request list across all lanes.
  │
  ├─ Step 7: Epoch propagation
  │    Bumps requestEpoch.
  │
  └─ Step 8: Return RequestPlan { requests, activeSet, epochs }
```

---

## Subdomains

### 1. Promotion

Decides each entity's display tier: **overview** (coarsest LOD fallback) or **detail** (native chunks at target LOD). Uses hysteresis to prevent flicker at zoom boundaries.

**Constants:**

| Constant | Value | Meaning |
|---|---|---|
| `PROMOTE_THRESHOLD_PX` | 80 | Promote to detail above this projected diagonal |
| `DEMOTE_THRESHOLD_PX` | 40 | Demote to overview below this |

**Decision table:**

| Projected Diagonal | From Overview | From Detail | Result |
|---|---|---|---|
| >= 80 px | Promote | Stay | **Detail** |
| [40, 80) px | Stay | Stay | **Keep previous** (default: overview) |
| < 40 px | Stay | Demote | **Overview** |
| Invisible | N/A | Force | **Overview** |

The 40px hysteresis band prevents rapid toggling when an entity oscillates near the threshold during panning or zooming. An entity that enters the band keeps its current representation — it won't promote until it reaches 80px, and won't demote until it drops below 40px.

**Implementation** (`promote()` in `pipeline/planning.ts`):

```
For each entity:
  1. If not visible → overview
  2. If projectedDiagonalPx >= PROMOTE_THRESHOLD → detail
  3. If projectedDiagonalPx < DEMOTE_THRESHOLD → overview
  4. Otherwise (hysteresis band): look up previous representation
     - Was detail? Stay detail
     - Was overview or unknown? Stay overview
```

The `proxy` representation is a forward-compatible placeholder for the Asset Catalog. V1 promotion is two-tier only (overview / detail).

### 2. LOD Range Assignment

Each promoted entity gets a range of levels it "owns" for detail rendering:

**Detail entries:**
```
targetLod = idealTargetLod        (from Rust view_query — geometric ideal)
seedDetailLod = min(targetLod + 2, numLevels - 1)
detailOwnedLodRange = [targetLod, seedDetailLod]   // [finest, coarsest]
```

The seed LOD (coarsest in the detail range) loads first for fast initial display. The target LOD (finest) provides full-resolution rendering. The range supports progressive refinement: the shader falls back through coarser detail levels while finer ones stream in.

**Overview entries:**
```
coarsest = numLevels - 1
targetLod = coarsest
seedDetailLod = coarsest
detailOwnedLodRange = [coarsest, coarsest]   // single level
```

Overview entities request only the coarsest level — a single-LOD fallback for global navigation.

### 3. Chunk Iteration

`iterateChunks()` enumerates the grid cells an entity needs, applying spatial culling and cache filtering. It is a TypeScript port of Rust `visible_chunks()` in `lucida-core/src/chunk.rs`, extended with multi-LOD iteration and cache-awareness.

**Algorithm:**

```
iterateChunks(entity, entry, visibleRegion, selection, cacheState)

  For each level in [coarsest..finest] from detailOwnedLodRange:
    For each channel in selection.visibleChannels:
      iterateGridCells(entity, region, selection, levelGeo, level0, level, c, cached, out)

  sortCenterOut(out, region, entity)
  return out
```

Iterating coarsest-first means seed LOD chunks appear earliest in the output — they are the first to be fetched and displayed.

**Grid cell iteration** (`iterateGridCells()`):

```
1. Compute per-axis scale: full_res_voxels / level_voxels
2. Compute chunk world size: chunk_shape × scale
3. Offset visible region by entity position → local coordinates
4. Early-out if no overlap (AABB test)
5. Compute grid cell ranges:
     col: [floor(localMinX / chunkWorldX), ceil(localMaxX / chunkWorldX))
     row: [floor(localMinY / chunkWorldY), ceil(localMaxY / chunkWorldY))
     z:   [floor(zRange[0] / chunkWorldZ), ceil(zRange[1] / chunkWorldZ))
6. For each (z, row, col) in ranges:
     a. If frustum planes present: test chunk AABB → skip if outside
     b. Compute canonical key: "level/t/c/z/y/x"
     c. If key is in cached set → skip
     d. Emit ChunkRequest
```

**Frustum culling** (3D only): Uses the p-vertex method. For each of the 6 frustum planes, the chunk AABB corner most aligned with the plane normal is tested. If that corner is on the negative side of any plane, the entire chunk is outside the frustum and is skipped. Chunk coordinates are offset by entity position before testing since frustum planes are in global voxel space.

**Entity position offsets**: For multi-member datasets (plates), each entity sits at a composed position from layout placement + transform edges. The visible region is offset to local coordinates for grid cell computation, but chunk AABBs are tested in global space against frustum planes.

### 4. Center-Out Sorting

Chunks are sorted by distance from the sort center so that the most visually important chunks (center of screen) load first.

```
sortCenterOut(requests, region, entity)

  1. Determine sort center in local coords:
     - If region.sortCenter exists: offset by entity.position
     - Otherwise: midpoint of visible region, offset by entity.position

  2. Pre-compute chunk world sizes per level (handles anisotropic levels):
     chunkWorld[level] = [chunkX × scaleX, chunkY × scaleY, chunkZ × scaleZ]

  3. Sort by squared distance:
     dist(req) = ((x+0.5) × cwX - centerX)² + ((y+0.5) × cwY - centerY)² + ...
```

Pre-computing chunk world sizes per level ensures correct sorting across LODs — different levels have different chunk dimensions, so a grid index at level 2 maps to a different world extent than the same index at level 0.

### 5. Three-Lane Scheduling

Requests are organized into three priority lanes, separated by large numeric offsets to guarantee inter-lane ordering:

| Lane | Offset | Purpose | Entities | Timepoints |
|---|---|---|---|---|
| **Detail** | 0 | Current frame at target LOD | Detail-promoted only | Current T |
| **Runway** | 1000 | Temporal prefetch | Detail-promoted only | T+1 .. T+`RUNWAY_DEPTH` |
| **Overview** | 2000 | Background seeding | All entities | Current T |

**Intra-lane priority** (`computePriority()`):

```
priority = laneOffset + (1 - importance) × 500 + distanceFromCenter × 10
```

- **Lower = more urgent.** Detail lane requests always precede runway, which precedes overview.
- **Importance** (from `view_query`): `projectedAreaPx2 / distance`. Larger on-screen entities closer to the camera are prioritized.
- **Distance**: Chunks closer to the sort center are prioritized within a lane.
- **Runway depth**: Each future timepoint adds 100 to the lane offset (T+1 → 1100, T+2 → 1200), so nearer future frames load first.

**Temporal runway**: For detail-promoted entities, Planning generates requests for the next `RUNWAY_DEPTH` (2) timepoints. These pre-warm the cache so scrubbing through T is smooth — the next timepoints' chunks arrive before the user scrubs to them.

### 6. Cache Filtering

Chunks already present in the CPU cache are skipped during iteration. The Orchestrator assembles `CacheStateSnapshot` from the chunk store before calling `plan()`:

```typescript
interface CacheStateSnapshot {
  cached: Map<string, Set<string>>;  // entityId → Set<chunkKey>
}
```

Each `iterateGridCells()` call checks `cached.get(entityId)` and skips any chunk whose canonical key is already in the set. This prevents redundant fetch requests and ensures the request plan only contains genuinely missing chunks.

Cache state changes (new chunks arriving) do **not** trigger replanning — they trigger re-upload via the existing `dataDirty` flag. Planning only re-runs when scene epochs change (camera moved, selection changed, content added).

### 7. Epoch Propagation

Planning consumes and propagates epochs for invalidation:

```typescript
interface PlanningEpochs {
  content: number;    // Dataset added/removed
  layout: number;     // Layout changed
  view: number;       // Camera moved
  selection: number;  // T/C/Z or channel visibility changed
  asset: number;      // Placeholder (0 until Asset Catalog)
  request: number;    // Bumped each time plan() runs
}
```

The first four epochs come from `SceneEpochs` in Rust. Planning extends them with:
- `asset`: Forward-compatible placeholder for when the Asset Catalog provides proxy availability.
- `request`: Bumped by 1 each time `plan()` produces a new plan. Used by downstream consumers (Worker Protocol) to detect stale deliveries.

The Orchestrator compares current epochs against the last planning cycle. If no relevant epochs changed, `plan()` is not called and the cached `RequestPlan` is returned directly.

---

## Rust-Side Geometric Engine

The Rust side provides three geometric queries consumed by Planning. These are pure functions of camera state + entity metadata — they have no knowledge of cache, scheduling, or representation.

### Scene::view_query()

Returns per-entity geometric recommendations from the current camera viewpoint.

**Implementation** (`lucida-core/src/scene/mod.rs`):

```
For each MemberState in derived state:
  1. Compute screen-space bounding box:
     - 2D: project entity corners (pos to pos + fov_size)
     - 3D: project rendering_transform corners (includes Y-flip, global correction)
  2. Check overlap with viewport → visible
  3. Compute projected_diagonal_px and projected_area_px2
  4. Compute ideal_target_lod:
     ppv = projected_diagonal_px / voxel_diagonal
     raw = floor(-log2(ppv))
     ideal_target_lod = clamp(raw, 0, numLevels - 1)
  5. Compute importance = projected_area_px2 / distance_to_eye
  6. Sort results by importance descending
```

Output: `ViewQueryResult { epochs: SceneEpochs, visible_entities: EntityQueryResult[] }`

### Camera::visible_region()

Returns the camera's viewport bounds in voxel coordinates.

**Fields:**

| Field | Source | Purpose |
|---|---|---|
| `xy_bounds` | Camera projection | Viewport AABB in voxel coords |
| `z_range` | View state `z_range` | Active Z slab |
| `effective_zoom` | Camera zoom × DPR | Screen pixels per voxel, for LOD selection |
| `sort_center` | Camera center (3D) or `None` (2D) | Center-out loading origin |
| `frustum_planes` | Arcball/Fly camera | 6 half-planes for per-chunk culling (3D only, `None` in 2D) |

Both 2D and 3D use the same code path. The `VisibleRegion` encodes the camera mode in its data — frustum planes present for 3D, absent for 2D.

### chunk::select_level()

Picks the best multiscale level for a given zoom:

```rust
fn select_level(zoom: f64, num_levels: u32) -> u32 {
    let level = (-zoom.log2()).floor().max(0.0) as u32;
    level.min(num_levels - 1)
}
```

At `zoom = 1.0` (1:1 pixel mapping), level 0 (full res). At `zoom = 0.25`, level 2. Never exceeds the coarsest level.

This is used by `Scene::chunk_plan_for()` (the legacy WASM chunk planner) but the new TypeScript planning uses `idealTargetLod` from `view_query()` instead — same underlying math, but computed per-entity with proper screen-space projection rather than a single global zoom value.

---

## Multi-Member Support

For plate datasets, each image-bearing entity (field) is positioned at a composed offset: layout placement + transform edge. Planning handles multi-member datasets throughout:

1. **AABB culling**: In `view_query()`, entities fully outside the viewport are marked `visible: false`. In `iterateGridCells()`, the visible region is tested against entity bounds and short-circuits if no overlap.

2. **Local coordinate transform**: The visible region is offset by `entity.position` to get local coordinates for grid cell computation: `localMinX = region.xyBounds[0] - entity.position[0]`.

3. **Global frustum testing**: When frustum planes are present (3D), chunk AABBs are offset back to global coordinates for plane testing: `cmin[0] = col × chunkWorldX + entity.position[0]`.

4. **Per-entity cache state**: `CacheStateSnapshot.cached` is keyed by entity ID, so cache filtering is correct even when multiple entities have overlapping chunk grids.

5. **Independent promotion**: Each entity is independently promoted/demoted based on its own projected size. In a plate view, zoomed-in wells get detail while distant wells stay at overview.

---

## Debug Panel

The Planning tab in the debug panel (`lucida-web/src/debug/DebugPanel.tsx`) provides live visualization of planning state. It polls at 200ms intervals and assembles a `PlanningSnapshot` from live WASM queries, calls `plan()`, and displays the result:

- **Active Set**: Each entry with representation (D/O), targetLod, seedDetailLod, detailOwnedLodRange
- **Requests by Lane**: Counts for detail, runway, overview
- **Visible Region**: xy_bounds, z_range, effective_zoom, sort_center, frustum_planes
- **Entity Positions**: Layout placements from `member_positions()`

The debug panel constructs its own `PlanningSnapshot` with empty cache state and worker wanted set — it shows what Planning _would_ request if nothing were cached, which is useful for verifying the algorithm independent of cache behavior.

---

## Rust-Side Legacy Chunk Planner

`Scene::chunk_plan_for()` in `lucida-core/src/scene/mod.rs` is the older WASM-side chunk planner. It performs single-LOD planning per dataset:

```
For each MemberState:
  1. Compute visible_region using member's volume transform
  2. AABB cull: skip members fully outside viewport
  3. Offset region to local coords
  4. select_level(effectiveZoom, numLevels) → single level
  5. Call visible_chunks() (3D) or visible_and_prefetch_chunks() (2D)
  6. Return MemberChunkPlan { image_id, position, needed, prefetch }
```

This is consumed by the legacy `tickCommon.planAndFetchForDatasets()` path via `zarr/chunkPlan.ts`. It does not support multi-LOD iteration, promotion/demotion hysteresis, three-lane scheduling, temporal runway, or cache-aware filtering.

The TypeScript `plan()` function replaces this with the full algorithm described in this spec. The Rust `chunk_plan_for()` function remains available for CLI and Python use cases where the full scheduling pipeline is not needed.

---

## Constants

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `PROMOTE_THRESHOLD_PX` | 80 | `planning.ts` | Projected diagonal to promote to detail |
| `DEMOTE_THRESHOLD_PX` | 40 | `planning.ts` | Projected diagonal to demote to overview |
| `DETAIL_LANE_OFFSET` | 0 | `planning.ts` | Priority base for detail-lane requests |
| `RUNWAY_LANE_OFFSET` | 1000 | `planning.ts` | Priority base for runway-lane requests |
| `OVERVIEW_LANE_OFFSET` | 2000 | `planning.ts` | Priority base for overview-lane requests |
| `RUNWAY_DEPTH` | 2 | `planning.ts` | Number of future timepoints to prefetch |

---

## File Map

| File | Role |
|---|---|
| `lucida-web/src/pipeline/planning.ts` | Planning domain: types, `plan()`, `promote()`, `iterateChunks()`, `sortCenterOut()`, `chunkOutsideFrustum()`, `chunkKey()`, test helpers |
| `lucida-web/src/pipeline/planning.test.ts` | 50+ tests: promotion, LOD ranges, hysteresis, frustum culling, cache filtering, multi-channel, center-out sort, entity position offsets, multi-LOD iteration, scheduling, temporal runway, importance weighting, epoch propagation |
| `lucida-core/src/chunk.rs` | Rust chunk primitives: `ChunkCoord`, `select_level()`, `visible_chunks()`, `visible_and_prefetch_chunks()`, `chunk_outside_frustum()` |
| `lucida-core/src/query.rs` | `ViewQueryResult`, `EntityQueryResult` types |
| `lucida-core/src/camera.rs` | `VisibleRegion` type, `Camera::visible_region()` |
| `lucida-core/src/scene/mod.rs` | `Scene::view_query()`, `Scene::chunk_plan_for()` (legacy), `MemberState`, `DatasetDerivedState` |
| `lucida-core/src/epoch.rs` | `SceneEpochs` type |
| `lucida-web/src/zarr/chunkPlan.ts` | Legacy WASM integration: `evaluateChunkPlanFor()` (to be deleted at M0) |
| `lucida-web/src/tickCommon.ts` | Legacy plan+fetch pipeline: `planAndFetchForDatasets()` (to be replaced by Orchestrator) |
| `lucida-web/src/debug/DebugPanel.tsx` | Planning tab: live snapshot assembly, `plan()` invocation, result display |
| `lucida-web/src/debug/debugStats.ts` | Debug stats sink: plan cache hits/misses, member stats |

---

## What This Does NOT Cover

This spec covers the Planning domain — from "Orchestrator provides a snapshot" to "Planning returns a request plan." It does not cover:

- **Orchestrator integration** — how the snapshot is assembled and how the request plan is applied. See [Orchestrator Integration Spec](orchestrator-integration-spec.md).
- **CPU Cache** — how requests are fetched, decoded, and stored. That is domain 6.2.
- **Worker Protocol** — how chunk data reaches the GPU worker. That is domain 6.3.
- **GPU Residency** — atlas management, page tables, wanted-set reporting. That is domain 6.4.
- **Rendering** — the semantic fallback chain (target LOD → coarser detail → overview → nothing). That is domain 6.5.
- **Asset Catalog** — proxy product availability that will feed into `PlanningSnapshot.assetCatalog` and enable the `proxy` representation tier.
- **Minimap planning** — the minimap has its own coarse chunk needs and bypasses Planning entirely.

---

## Design Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Planning is TypeScript, not Rust | Planning depends on cache state, worker state, visible channels, interaction mode, and temporal runway policy — all browser-specific live state. Moving it to Rust would require passing all of this across the WASM boundary for every planning cycle. |
| D2 | Pure function, not a stateful object | Makes testing trivial (synthetic snapshots), prevents hidden coupling, and makes caching straightforward (same input → same output). The only "state" is `previousActiveSet`, which is an explicit input. |
| D3 | Hysteresis band of 40px (80 - 40) | Chosen to prevent visible flicker during smooth zoom. Too narrow and entities toggle rapidly; too wide and detail promotion feels sluggish. The 2:1 ratio (80/40) provides stable behavior across typical zoom speeds. |
| D4 | Three lanes with numeric offsets rather than separate queues | A single sorted list is simpler to consume downstream. Lane offsets (0, 1000, 2000) are large enough that intra-lane priority never crosses lane boundaries — importance and distance contributions are bounded well below 1000. |
| D5 | Runway depth of 2 timepoints | Covers the most common scrubbing speed. Deeper runway wastes bandwidth on timepoints the user may never reach; shallower runway causes visible stalls during scrub. |
| D6 | Iterate coarsest-to-finest within detail range | Seed LOD chunks appear first in the output and are fetched first. This gives immediate coarse display while fine detail streams in — progressive refinement without explicit prioritization logic. |
| D7 | Cache filtering during iteration, not post-hoc | Skipping cached chunks during grid iteration avoids generating thousands of requests only to filter them later. For large datasets with warm caches, this reduces plan() time significantly. |
| D8 | Overview lane requests all entities, not just overview-promoted ones | Overview is a global fallback — every entity needs a coarsest-LOD representation for navigation and for the detail→overview fallback chain in rendering. Detail-promoted entities get both detail and overview requests. |
| D9 | Center-out sort per entity, not globally | Each entity has its own position offset and potentially different chunk world sizes at each LOD. Sorting per-entity before merging into the global list produces correct spatial ordering. |
| D10 | `chunkDistanceFromCenter()` uses grid indices as a rough proxy | The exact world-space distance isn't needed for intra-lane ordering — just a roughly center-out pattern. Grid indices are cheap to compute and sufficient for prioritization. |

---

## Rules

1. **Planning is a pure function.** `PlanningSnapshot → RequestPlan`. No I/O, no side effects, no direct reads from other domains.
2. **All inputs arrive in the snapshot.** Planning never calls WASM, reads cache state, or queries the DOM. The Orchestrator assembles the snapshot; Planning consumes it.
3. **Epoch propagation is mandatory.** Every `RequestPlan` carries epoch tags so downstream consumers can detect staleness.
4. **Per-level chunk geometry.** Planning must handle per-level chunk shapes. There is no global "chunk size" — `LevelGeometry` varies by level.
5. **Cache filtering is by canonical key.** `"level/t/c/z/y/x"` — the same format used everywhere in the system.
6. **Promotion hysteresis must be preserved.** `previousActiveSet` flows as an input, not hidden internal state. Dropping it resets hysteresis and causes flicker.
7. **Overview is a fallback, not a substitute.** Overview-lane requests exist for every entity. They are not a replacement for detail LODs within the detail-owned range.
8. **Planning operates on content identity.** Entity IDs, image IDs, level indices, grid coordinates — never atlas slots, pool indices, or GPU handles.

---

## Related

- Domain model: [DOMAINS.md](../DOMAINS.md) section 6.1
- Orchestrator integration: [docs/orchestrator-integration-spec.md](orchestrator-integration-spec.md)
- Content graph: [docs/canonical-content-graph.md](canonical-content-graph.md)
- Import pipeline: [docs/import-pipeline-spec.md](import-pipeline-spec.md)
- Per-crate architecture: `lucida-core/ARCHITECTURE.md`
- Glossary: [GLOSSARY.md](../GLOSSARY.md)
