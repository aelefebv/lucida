---
created: 2026-04-18
modified: 2026-05-19
---

# Flow: Chunk Lifecycle

From "the planner decides this chunk is wanted" to "this chunk's voxels become pixels." This is the canonical hot path; every render frame walks pieces of it.

## Phases

### 1. Planning decides "wanted"

[[planning-domain]] resolves each visible field/image to an explicit `detail` level and optional `coarse` level. For each visible entity in the active set, it iterates grid cells inside `xyBounds ∩ zRange ∩ frustumPlanes`. Each candidate becomes a tier-labeled `ChunkRequest` with priority `laneOffset + (1-importance)*500 + distance*10`.

### 2. CPU cache submits + schedules

[[cpu-cache]] demotes stale detail entities, dedups by chunk key, interleaves detail/coarse requests when both lanes have work, and pushes survivors to the scheduler. Fetches launch up to about 9 concurrent requests bounded by 32 MB in-flight.

### 3. Network fetch

`contentSource.ts::fetch(req)` → `bridge.ts` sends a `chunk_request` JSON over WebSocket. Source chunks route to `serve_chunk_from_store`; generated coarse chunks route to `serve_generated_chunk_request`.

Ready source and generated chunks both use the normal chunk frame layout: `[client_id u32 LE][key_len u16 LE][key bytes][payload bytes]`. `bridge.ts::handleBinary` parses and routes by composite key (`{datasetId}/{imageId}/{chunkKey}`). If a generated chunk is not ready, the server sends `GeneratedChunkStatus`; `pending` clears in-flight state without entering failure tracking.

### 4. Decode

`decodePool.ts` hands the encoded buffer to one of 3 web workers (`decode.worker.ts`) which selects codec (Raw/Lz4/Zstd) from the `WireFormat` for that image and produces a typed array.

### 5. Cache insertion

Decoded chunk inserted into the appropriate [[cpu-cache]] bucket (`detail` or `coarse/minimap`), stamped with priority, residency tier, and wanted generation.

### 6. Deliverability

`CpuCache.getDeliverable()` yields cached, currently-wanted, not-rejected, not-sent chunks in priority order. The [[upload-pipeline|Uploader]] consumes that iterable within the upload budget (8 MB main view, 2 MB minimap). Legacy proxy deliveries participate only when the proxy bridge is enabled.

### 7. Post to worker

`client.sliceChunkData(...)` or `client.volumeChunkData(...)` — typed array transfer (zero-copy) over [[worker-protocol]], carrying `tier: "detail" | "coarse"`.

### 8. Worker writes atlas + updates indirection

[[gpu-residency]] picks a slot in the appropriate atlas pool keyed by dataset, channel, chunk dimensions, and tier. Writes the texture. Updates the indirection buffer entry mapping `(entity, lod, z, y, x) → slot coords`. Indirection writes are batched and flushed only on residency change.

### 9. Render

Slice or volume shader runs:
1. Read `descriptors[entityIndex]`.
2. Project fragment to entity-local voxel coords.
3. Compute cell within the chosen LOD.
4. `indirection[lod.indirectionOffset + cellIndex]` → atlas slot.
5. **Fallback chain**: explicit detail tier → explicit coarse tier → legacy field/well proxy if bridge-enabled and resident → blank.
6. Apply contrast → gamma → LUT sample → opacity.

### 10. Composite

`compositor.wgsl` blends per-channel composites for multichannel mode; per-dataset for layered datasets. Composite key naming: `imageId:chN` for multichannel, bare `imageId` for single.

### 11. Eviction (closing the loop)

When the worker evicts a slot under memory pressure, it posts `chunksEvicted` (evicted + skipped keys) and the evicted chunks reappear in the next `wantedSetDelta`. Main thread clears `DeliveryState` via `cpuCache.markChunkEvicted(...)` → next `getDeliverable()` re-uploads from CPU cache, or the planner re-requests if the cache also evicted.

## Where things can fail

- **Network** — fetch failures land in the cache's recently-failed window and are retried later.
- **Decode** — codec mismatch or corrupt bytes: error logged, no slot allocated; the planner re-enumerates next tick.
- **Atlas full** — worker evicts LRU; the tick coordinator may upload, get evicted, and re-upload in the same tick under pressure (visible as "thrash" in debug stats).
- **Stale upload** — worker's epoch check drops chunks whose planning epoch is older than the worker's current understanding. Debug panel shows these as "skipped."

## Related

- [[chunk-pipeline]] — system overview
- [[planning-domain]]
- [[cpu-cache]]
- [[gpu-residency]]
- [[worker-protocol]]
