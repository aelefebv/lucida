# Chunk Pipeline: End-to-End Trace

How a dataset gets from "user opens URL" to "pixels on screen" in lucida-web. Covers single Zarr and plate datasets, the CPU and GPU caches, prioritization, eviction, and the shader fallback chain.

> Where a `file:line` is cited, treat it as the entry point — the surrounding function is what matters.

---

## 1. Opening a dataset (single vs. plate)

### 1a. UI → server request

Both single Zarr and plate enter the same way:

1. User types/pastes a URL into the open-dataset input → `lucida-web/src/App.tsx:497-510`.
2. `useDatasets.handleUrlSubmit` calls `Bridge.sendOpenRemoteDataset(url)` → `lucida-web/src/bridge.ts:208-211` sends `{type:"open_remote_dataset", url}` over the WebSocket.
3. The **server** is what determines whether this resolves to a `Single` or `Plate`. It probes the store (Zarr root vs HCS plate metadata), builds a `DatasetManifest`, picks a `FetchSource`, and broadcasts a `dataset_opened` event back to all clients.

Wire shape of the broadcast (matches Rust `DocumentCommand::DatasetOpened(DatasetOpened)`, snake-cased by serde):

```json
{ "type": "dataset_opened",
  "manifest": <DatasetManifest>,   // structural blueprint: entities, transforms, images, layouts
  "fetch":    <FetchSource>,        // how to get bytes: { Proxied | Direct | Local }
  "catalog":  <AssetCatalog> }      // proxy-availability seed (empty in S3, populated S5+)
```

The web client doesn't know in advance — it learns by inspecting `manifest.kind` on the returned event (`lucida-web/src/manifestTypes.ts`).

### 1b. Receiving `dataset_opened`

`lucida-web/src/hooks/useBridge.ts:142-186` (command handler) and `useBridge.ts:355-409` (`setupFetchPipeline`) do the dual hand-off:

- **WASM side**: `scene.apply_command(commandJson)` — the Rust `Scene` (in `lucida-core`) ingests the entities/transforms/images/layouts. From here, all spatial/visibility logic is WASM-driven.
- **JS side**, in order:
  1. `contentSource.registerImage(image_id, wire_format)` per image — sets up the binary fetch promise table keyed by `level/t/c/z/y/x`.
  2. `datasetsRef.set(datasetId, {manifest, fetch})` — the JS dataset registry.
  3. `initLayerMaps(datasetId)` — per-channel display state (contrast/gamma/colormap).
  4. Apply `set_channel_visible` per channel so WASM knows the channel count (extracted from image `shape[1]` since axes are TCZYX).
  5. `loopRef.current.addDataset(datasetId, manifest)` — `RenderLoop` learns about the new dataset and flips `interactiveDirty=true`.
  6. Pre-allocate a `Uint16Array` for the coarsest level (used by the volume/intensity sampler).

### 1c. The single vs. plate divergence is in **manifest shape**, not flow

Same code path, different `DatasetManifest`:

|                       | Single                                                                | Plate                                                                       |
| --------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `manifest.kind`       | `"Single"`                                                            | `{Plate: {rows, columns, positioning_mode, has_stage_positions}}`           |
| Entities              | one `Image`                                                           | many `Well` (parents) + `Field` (children); images attach to fields         |
| Layouts               | one placement at `[0, 0]` for the image entity                        | `source_layouts[].placements` position **wells** in plate-space; field-within-well offsets come from `TransformEdge`s (`build_grid_field_transforms` for grid plates; OME translation for stage-positioned) |
| Planning treats it as | a singleton "well group" with one field (`planning.ts:472-481`)       | grouped by `parentId` (`planning.ts:411-483`)                               |

So **plate complexity lives entirely in planning** (where it groups, promotes, and synthesizes well proxies). The fetch/cache/render layers below see the same chunk requests either way, just more of them and with extra `WellProxy3D`/`FieldProxy3D` request kinds.

---

## 2. The render loop: what triggers a frame

`lucida-web/src/renderLoop.ts:17-325` is a **pull-based RAF loop with typed dirty flags**:

- `interactiveDirty` — camera move, layout change, dataset add/remove, multichannel toggle, click in canvas.
- `residencyDirty` — new chunk decoded (CPU cache subscribe), worker reports eviction, worker reports wanted-set delta.

Throttling (`renderLoop.ts:289-296`):

- `interactiveDirty` → render **immediately** (camera move can't wait).
- `residencyDirty` → wait until `now - lastResidencyRenderTime >= 33ms` (≈30 fps cap on chunk-arrival redraws). The **tick still runs** in the gap to keep uploading; only the *render* is throttled.

Every tick runs four phases in order: **plan → upload → render (maybe) → minimap**. Reschedule via RAF if work remains.

---

## 3. Planning: deciding what chunks are wanted

This lives in `lucida-web/src/pipeline/planning.ts` and runs every tick from the orchestrator.

### 3a. Inputs (queried from WASM)

`lucida-web/src/pipeline/orchestrator.ts:306-312`:

- `scene.view_query(dsId)` → `visible_entities[]` with `projected_diagonal_px`, `projected_area_px2`, `centroid_world`, `ideal_target_lod`, `importance` (per entity, per frame).
- `scene.member_positions(dsId)` → `{entityId: [voxelX, voxelY]}` (for slice placement).
- `scene.visible_region(dsId)` → `xyBounds`, `zRange`, `effectiveZoom`, `frustumPlanes` (for chunk culling).

The view query is **the** source of truth for "what's visible and at what apparent size."

### 3b. Promotion: per-well LOD/proxy decision (`planning.ts:498-635`)

For each well group, choose one of three modes based on the well's projected diagonal (in screen pixels):

| Mode                            | Threshold | What gets fetched                                                  |
| ------------------------------- | --------- | ------------------------------------------------------------------ |
| **well-as-proxy**               | `< 80px`  | One `WellProxy3D` per visible channel. **No detail chunks.**       |
| **fields-with-proxy-fallback**  | `80–150px`| Detail chunks + `FieldProxy3D` per field + `WellProxy3D` per well  |
| **fields-with-detail**          | `> 150px` | Detail chunks; field proxy only if catalog advertises it           |

Constants in `planning.ts:23-36`. **Hysteresis bands** of ±5px around each threshold prevent flapping when the user dwells near a boundary — once you're in a mode, you stay until you cross the far edge.

**Catalog-aware degradation** (`planning.ts:537-558`): if the chosen mode wants a proxy that the server's asset catalog doesn't advertise, degrade one tier finer (e.g., wanted well-as-proxy but no `WellProxy3D` exists → drop to fields-with-proxy-fallback). Each degrade increments `PlanStats.catalogDegradations`.

**LOD range** (`planning.ts:611-632`, `makeFieldEntry`):

```
targetLod        = entity.idealTargetLod    (from WASM, log2 of pixels-per-chunk)
coarsestDetailLod    = min(targetLod + 2, maxLevel)
detailOwnedRange = [targetLod, coarsestDetailLod]
```

Two-LOD buffer absorbs zoom transitions smoothly.

### 3c. Chunk enumeration & priority (`planning.ts:772-957`)

For each entity in the active set, iterate grid cells inside `xyBounds` ∩ `zRange` ∩ frustum planes. Each candidate becomes a `ChunkRequest` with a priority:

```
priority = laneOffset + (1 - importance) * 500 + distance * 10
```

**Lower number = higher priority.** Lane offsets (`planning.ts:46-56`):

| Lane     | Offset | What                          |
| -------- | ------ | ----------------------------- |
| DETAIL   | 0      | Visible chunks                |
| PROXY    | 500    | Well/field proxy fallbacks    |
| PREFETCH | 1000   | Next-timepoint prefetch       |
| OVERVIEW | 2000   | Minimap                       |

So a centered, important detail chunk wins (~0); a faraway prefetch chunk loses (~1500+).

### 3d. Inspecting what planning did

`plan()` returns `RequestPlan.stats: PlanStats` alongside the requests — `catalogDegradations` and culling counters (`considered → afterXyBounds → afterZRange → afterFrustum`) accumulated across all `iterateChunks` calls in the run. The orchestrator combines this with the plan itself + a `cpuCache.snapshot()` cross-reference to publish per-dataset planning telemetry to `debugStats.planning.byDataset[dsId]`:

- chunk lanes, total chunks, proxy count
- per-LOD breakdown (planned / cached / in-flight)
- wells-by-mode (deduped by parent well)
- catalog degradations
- focal entity (visible entity nearest viewport center) with its mode + reason ("123px ∈ [85, 145] → clearly fallback")

The DebugPanel **Planning** tab renders this per dataset; two console-dump buttons there print the raw plan and active set categorized by lane. Two **overlays** (gated in the Logging tab) draw on top of the canvas: per-well promotion-mode badges and a chunk-grid visualization (status: cached / in-flight / planned). Both work in slice and volume modes via `WasmScene.project_to_screen`. See `lucida-web/src/debug/DebugOverlays.tsx`.

---

## 4. CPU cache: fetch scheduling & decoding

`lucida-web/src/pipeline/cpuCache.ts:203-934` is the **sole** chunk-fetch path (the old `SharedChunkQueue` was deleted in S5).

### 4a. Submit flow (`cpuCache.ts:306-369`)

Each tick, orchestrator calls `cpuCache.submit(plan)`. Cache:

1. **Demotes entities** that left the active set: their cached chunks move from `active-detail` → `demoted-detail` tier (still in cache, but first to evict).
2. **Dedups** each request: skip if cached, in-flight, or recently-failed.
3. Pushes survivors onto `pendingQueue`.
4. Calls `startFetches()`.

### 4b. Fetch scheduler (`cpuCache.ts:617-750`)

```
maxConcurrentFetches = decodePoolSize × 3   (≈9 in-flight)
maxBytesInFlight     = 32 MB
```

Sort `pendingQueue` ascending by priority, then launch fetches until either limit is hit. Each fetch:

1. `contentSource.fetch(req)` → binary frame from the WS proxy (matched by `level/t/c/z/y/x` key in `bridge.ts:140-158`).
2. Hand the encoded buffer to `decodePool.decode(...)` — 3 web workers running `decode.worker.ts`, picking codec by wire format (Raw/Lz4/Zstd).
3. On resolve: insert into the cache and append to a `ready[]` queue (the orchestrator drains this each tick).

### 4c. Eviction tiers (`cpuCache.ts:759-850`)

Evict from highest-numbered tier first:

1. `prefetch` — cheapest to lose
2. `demoted-detail` — entities the user navigated away from
3. `active-detail` — currently visible
4. `proxy` — fallback resource
5. `overview` (minimap) — most expensive to lose; whole-dataset coverage

LRU within each tier (by `insertedAt`). Budgets: detail 512 MB, overview 64 MB, proxy 256 MB.

### 4d. Drain to GPU (`cpuCache.ts:466-484`)

Orchestrator calls `drain(uploadBudgetBytes)` each tick — pulls deliveries off `ready[]` until the byte budget is exhausted.

---

## 5. CPU → GPU hand-off: the orchestrator's role

`lucida-web/src/pipeline/orchestrator.ts:257-689` is the conductor between planning, CPU cache, and GPU worker.

### 5a. Each tick (`planAndFetch`)

1. **Epoch fast-path** (`:262-290`): query WASM epochs (content/layout/view/selection/asset/request). If nothing changed, return cached result. Hits ~5% of frames.
2. **For each visible dataset**: run `plan(snapshot)` → `RequestPlan`, then `cpuCache.submit(plan)`.
3. **Build cold state** (`:1041-1148`) — see below.
4. **Build view hot state** (`:1158-1179`) — only when view epoch bumps; carries ray-pick coords used for GPU eviction distance.
5. **Build entity index map** (`:523`): an explicit ordered list of `(memberId → index)` shared by CPU and GPU. Both sides iterate the same active set in the same order, so indices match by construction. Shaders use this index to look up the EntityDescriptor.

### 5b. Cold state (the worker's worldview)

`ColdStateMessage` is **everything the GPU worker needs to plan its own work**:

```ts
{ epochs, datasetId, currentT, currentZ, visibleChannels, visibleRegion,
  activeSet: [{ entityId, imageId, targetLod, detailOwnedLodRange,
                levels: [{level, chunkShape, gridShape, levelDims}],
                mode, proxyKind, proxyAvailable, wellProxyAvailable,
                parentWellId, modelMatrix, invModelMatrix,
                displayStateByChannel }],
  viewMode }
```

On receipt, the worker:

1. Updates `memberToDataset`.
2. Allocates / remaps **atlas pools** (volume = shared per dataset; slice = single-entity).
3. Rebuilds the **descriptor buffer** (`renderer/descriptorBuffer.ts`) — a GPU storage buffer of `EntityDescriptor[]` entries (modelMatrix, invModelMatrix, contrast/gamma/opacity, colormap LUT index, per-LOD info, proxy slot handles).
4. Computes the **wanted-set** (`renderer/wantedSet.ts`): walking the active set + LOD range against current GPU residency, produces `MissingChunk[]` and `MissingProxy[]`.
5. Posts a `wantedSetDelta` back to main thread.

On the main thread, `orchestrator.handleWantedSetDelta` clears `proxyDeliveredToWorker` for the missing keys (so the next drain re-sends them) and bumps `residencyDirty`.

### 5c. Upload to GPU (`orchestrator.ts:869-934`)

Each tick:

1. `cpuCache.drain(MAIN_VIEW_UPLOAD_BUDGET_BYTES = 16MB)` returns ready chunks.
2. Filter to those in `workerWantedSet` (don't waste bandwidth on chunks the worker no longer needs).
3. `client.sliceChunkData(...)` or `client.volumeChunkData(...)` — posts the typed array + metadata to the worker.
4. Worker writes to atlas slot, updates indirection buffer entry.
5. `sentSet.add(chunkKey)` to avoid re-uploading until next eviction.

---

## 6. GPU residency: atlas + indirection

`lucida-web/src/renderer/gpu.worker.ts` is the OffscreenCanvas-owning worker. All WebGPU lives here.

### 6a. Atlases

- **Slice atlas**: one per dataset, ~64 MB, X-Y grid layout.
- **Volume atlas**: shared per dataset, ~512 MB, partitioned into per-entity-LOD sections (Shared Pools v1 = SP-1).
- **Proxy atlases** (`renderer/proxyAtlas.ts`): one pool per `(datasetId, kind, slotDims, channel)`. 64 slots/pool, 1-D layout along X. Pure LRU eviction — important for plates because well/field proxies otherwise blow out atlas capacity.

### 6b. Indirection buffer

Storage buffer (`array<u32>`) that maps logical `(entity, lod, z, y, x)` → atlas slot coordinates. Shader reads it before sampling the atlas texture. Only flushed when chunk residency actually changes (atlas write/evict), not every frame.

### 6c. Eviction & re-fetch

When the GPU worker evicts a slot to make room, it:

1. Posts a `chunksEvicted` message (evicted + skipped keys).
2. Includes the now-missing chunks in the next `wantedSetDelta`.
3. Main thread clears its delivery tracking → next drain re-uploads if still in CPU cache, or re-requests if already gone.

This is why **plate FPS is sensitive to pool capacity and CPU-cache size** — eviction churn cascades.

---

## 7. The shaders: where chunks become pixels

Three WGSL shaders in `lucida-web/src/renderer/`:

### 7a. `slice.wgsl` (2D)

Per-fragment:

1. Look up `descriptors[entityIndex]` — get model matrix, contrast/gamma, LUT index, per-LOD info, proxy handles.
2. Project fragment world position into entity-local voxel coords.
3. Compute `(z, y, x)` cell within the chosen LOD's grid.
4. Read `indirection[lod.indirectionOffset + cellIndex]` → atlas slot coord.
5. **Semantic fallback chain** (DOMAINS step 9, just merged in `4aec276`):
   - Try detail at target LOD (slot encoded as "used" → sample).
   - Fallback: coarser detail LODs in range.
   - Fallback: field proxy texture (using `fieldProxyPoolIndex`/`fieldProxySlotIndex`).
   - Fallback: well proxy texture.
   - Last resort: blank.
6. Apply contrast → gamma → LUT (`textureSample(lutTex, samplerLinear, vec2(val, 0.5))`) → opacity.

### 7b. `volume.wgsl` (3D ray-march)

Same descriptor read, same fallback chain, but inside the ray-march loop. The recent perf commit (`b0a5985`) hoists the `EntityDescriptor` read out of the inner loop — significant on volume because it was being re-read per ray step.

For **well-as-proxy** entries in volume mode, `volumePath.ts:15-65` computes a per-entity scissor rect by projecting the well AABB to screen space — skips fragments outside the well's screen footprint entirely.

### 7c. `compositor.wgsl`

Composites multi-layer outputs (per-channel composites for multichannel mode, per-dataset for layered datasets). Composite key naming: `imageId:chN` for multichannel, bare `imageId` for single-channel.

---

## 8. Prioritization, summarized

| Question                                       | Answer                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **What gets fetched first?**                   | Lowest priority number wins. Detail-lane chunks at high importance and near viewport center fetch first (≈0). Runway/overview lanes wait. |
| **What gets uploaded to GPU first?**           | Whatever drained from `cpuCache.ready[]` this tick that's also in `workerWantedSet`. Drain order matches the order chunks finished decoding (FIFO within priority). |
| **What gets evicted from CPU cache first?**    | Tier order: prefetch → demoted-detail → active-detail → proxy → overview. LRU within tier.                                              |
| **What gets evicted from GPU atlas first?**    | Pure LRU on slot `touchOrder` (per pool). The orchestrator drives "what should be there"; the worker just reports what it lost.       |
| **What LOD is chosen?**                        | `idealTargetLod` from WASM view query (computed from projected diagonal vs. ideal pixels-per-chunk), with a +2 LOD buffer (`detailOwnedLodRange`). |
| **Plate-specific: when do well proxies show up?** | When the well's projected diagonal is below 80px (well-as-proxy mode) or in the 80–150px band (proxy-fallback). One pool per `(dataset, kind, slotDims, channel)` to keep pools cohesive. |

---

## 9. End-to-end summary in one paragraph

User opens a URL → web sends `open_remote_dataset` → server probes the store, builds `DatasetManifest` + `FetchSource`, broadcasts `dataset_opened` event → WASM ingests entities/layouts and JS sets up the fetch pipeline + render loop → on every RAF tick, orchestrator queries WASM (`view_query` + `member_positions` + `visible_region`), runs `planning.plan()` to choose per-well mode (well-as-proxy / proxy-fallback / detail) with hysteresis, enumerates wanted chunks with priorities, submits to `CpuCache` → CPU cache fetches up to ~9 in parallel via `ContentSource` (WebSocket binary frames), decodes in 3 worker pool, parks in tiered LRU → orchestrator builds `ColdState` for the GPU worker, drains decoded chunks within a 16 MB/frame budget, posts to worker → worker writes atlas slot, updates indirection buffer, recomputes wanted-set, reports deltas → render phase invokes slice or volume shader, which uses `entityIndex` to read its descriptor, indirection-looks-up its atlas slot, walks the semantic fallback chain (detail → coarser → field proxy → well proxy → blank), applies contrast/gamma/LUT/opacity, composits → pixels. Single vs. plate differ only in `DatasetManifest` shape (one image vs. wells-of-fields with synthesized well-proxy AABBs); every layer below planning processes the resulting requests identically.

---

## Key constants & budgets reference

```
# Planning thresholds (pixels of projected diagonal)
FAR_THRESHOLD_PX             = 80
DETAIL_THRESHOLD_PX          = 150
HYSTERESIS_PX                = 5

# Buffers
PREFETCH_DEPTH               = 2          # prefetch 2 future timepoints

# CPU Cache budgets
DEFAULT_DETAIL_BUDGET        = 512 MB
DEFAULT_OVERVIEW_BUDGET      = 64 MB
DEFAULT_PROXY_BUDGET         = 256 MB
DEFAULT_MAX_BYTES_IN_FLIGHT  = 32 MB

# Fetch concurrency
FETCH_CONCURRENCY_MULTIPLIER = 3          # × decode pool size (default 3) ≈ 9 in-flight

# Timeouts
DEFAULT_TIMEOUT_MS           = 10_000     # chunks
DEFAULT_PROXY_TIMEOUT_MS     = 60_000     # proxies

# GPU Atlas budgets
SLICE_ATLAS_BUDGET           = 64 MB
VOLUME_ATLAS_BUDGET          = 512 MB
PROXY_POOL_CAPACITY          = 64         # slots per pool

# Render throttling
RESIDENCY_RENDER_INTERVAL_MS      = 33 ms      # batch chunk arrivals, ≈30 fps cap
MAIN_VIEW_UPLOAD_BUDGET      = 16 MB / frame
```

## Key file map

| Concern                  | File                                       | Notable functions / lines                                |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| Dataset opening (UI)     | `lucida-web/src/App.tsx`                   | `:497-510`                                               |
| Bridge / WebSocket       | `lucida-web/src/bridge.ts`                 | `:208-211` open, `:140-158` binary routing               |
| Pipeline setup           | `lucida-web/src/hooks/useBridge.ts`        | `:142-186` cmd handler, `:355-409` setupFetchPipeline    |
| Manifest types           | `lucida-web/src/manifestTypes.ts`          | TS mirrors of `DatasetManifest` / `FetchSource`          |
| Content source (JS class)| `lucida-web/src/pipeline/contentSource.ts` | `ContentSource` class — per-image fetch promise tables; consumes a `FetchSource` |
| Planning                 | `lucida-web/src/pipeline/planning.ts`      | `:498-635` promote, `:772-957` chunk enum + culling counters, `:969+` plan, `:218` PlanStats |
| Orchestrator             | `lucida-web/src/pipeline/orchestrator.ts`  | `:257-689` planAndFetch, `:869-934` upload, `:1041-1148` cold state |
| CPU cache                | `lucida-web/src/pipeline/cpuCache.ts`      | `:306-369` submit, `:617-750` scheduler, `:759-850` eviction |
| Decode pool              | `lucida-web/src/pipeline/decodePool.ts`    | 3 workers; codec selection                               |
| Render loop              | `lucida-web/src/renderLoop.ts`             | `:17-325` tick, `:289-296` throttle                      |
| Slice path               | `lucida-web/src/slicePath.ts`              | `:143-200`                                               |
| Volume path              | `lucida-web/src/volumePath.ts`             | `:94-200`, `:15-65` scissor                              |
| GPU worker               | `lucida-web/src/renderer/gpu.worker.ts`    | cold state, atlases, wanted-set                          |
| Descriptor buffer        | `lucida-web/src/renderer/descriptorBuffer.ts` | EntityDescriptor[] storage buffer                      |
| Proxy atlas              | `lucida-web/src/renderer/proxyAtlas.ts`    | per-(dataset,kind,dims,channel) pools                    |
| Wanted-set computation   | `lucida-web/src/renderer/wantedSet.ts`     | missing chunks/proxies                                   |
| Shaders                  | `lucida-web/src/renderer/{slice,volume,compositor}.wgsl` | indirection, fallback chain, LUT                |
| Debug telemetry          | `lucida-web/src/debug/debugStats.ts`       | `planning.byDataset` shape — populated by orchestrator   |
| Debug panel              | `lucida-web/src/debug/DebugPanel.tsx`      | Planning tab + dump buttons                              |
| Debug overlays           | `lucida-web/src/debug/DebugOverlays.tsx`   | well-mode badges + chunk-grid; uses `WasmScene.project_to_screen` |
