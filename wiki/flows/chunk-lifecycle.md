---
type: Flow
title: "Flow: Chunk Lifecycle"
description: "From \"the planner decides this chunk is wanted\" to \"this chunk's voxels become pixels.\" This is the canonical hot path; every render frame walks pieces of it."
tags: [lucida, flow]
source_path: wiki/flows/chunk-lifecycle.md
created: 2026-04-18
modified: 2026-06-25
---

# Flow: Chunk Lifecycle

From "the planner decides this chunk is wanted" to "this chunk's voxels become pixels." This is the canonical hot path; every render frame walks pieces of it.

## Phases

### 1. Planning decides "wanted"

[Planning Domain](../systems/subsystems/planning-domain.md) resolves each visible field/image to an explicit `detail` level and optional `coarse` level. For each visible entity in the active set, it iterates grid cells inside `xyBounds ∩ zRange ∩ frustumPlanes`. Each candidate becomes a tier-labeled `ChunkRequest`. For the detail/proxy/prefetch/overview lanes the priority is `laneOffset + (1-importance)*500 + distance*10` (`computePriority` in `emit.ts`), so the lane offset separates lanes and importance/distance order within a lane. The minimap lane is the exception: it emits each request at bare `minimapLaneOffset` with no importance/distance terms, because minimap chunks are per-dataset rather than per-entity-importance.

### 2. CPU cache submits + schedules

[CPU Cache](../systems/subsystems/cpu-cache.md) demotes stale detail entities, dedups by chunk key, interleaves detail/coarse requests when both lanes have work, and pushes survivors to the scheduler. Concurrent fetches are bounded by `decode-pool-size × FETCH_CONCURRENCY_MULTIPLIER` (multiplier = 3, hardware-dependent) and by 32 MB in-flight.

### 3. Network fetch

`contentSource.ts::fetch(req)` → `bridge.ts` sends a `chunk_request` JSON over WebSocket. Source chunks route to `serve_chunk_from_store`; generated coarse chunks route to `serve_generated_chunk_request`.

Ready source and generated chunks both use the normal chunk frame layout: `[client_id u32 LE][key_len u16 LE][key bytes][payload bytes]`. `bridge.ts::handleBinary` only splits the frame and forwards the `(key, payload)` pair (it doesn't know the chunk-vs-proxy taxonomy); the composite-key dispatch lives in `contentSource.handleBinary`, which sniffs the `proxy/` prefix and otherwise resolves the pending fetch by composite key (`{datasetId}/{imageId}/{chunkKey}`). If a generated chunk is not ready, the server sends `GeneratedChunkStatus`; `pending` clears in-flight state without entering failure tracking.

### 4. Decode

`decodePool.ts` hands the encoded buffer to a worker in a dynamically-sized pool (`decode.worker.ts`; size `Math.max(2, floor(cores/2) - 1)`) which selects codec (Raw/Lz4/Zstd) from the `WireFormat` for that image and produces a typed array.

### 5. Cache insertion

Decoded chunk inserted into the appropriate [CPU Cache](../systems/subsystems/cpu-cache.md) bucket (`detail` or `coarse/minimap`), stamped with priority, residency tier, and wanted generation.

### 6. Deliverability

`CpuCache.getDeliverable()` yields cached, currently-wanted, not-rejected, not-sent chunks in priority order. The [Uploader](../systems/subsystems/upload-pipeline.md) consumes that iterable within the upload budget (8 MB main view, 2 MB minimap). Legacy proxy deliveries participate only when the proxy bridge is enabled.

### 7. Post to worker

`client.sliceChunkData(...)` or `client.volumeChunkData(...)` — typed array transfer (zero-copy) over [Worker Protocol](../systems/subsystems/worker-protocol.md), carrying `tier: "detail" | "coarse"`.

### 8. Worker writes atlas + updates indirection

[GPU Residency](../systems/subsystems/gpu-residency.md) picks a slot in the appropriate atlas pool keyed by dataset, channel, chunk dimensions, and tier. Writes the texture. Updates the indirection buffer entry mapping `(entity, lod, z, y, x) → slot coords`. Indirection writes are batched and flushed only on residency change.

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

- [Flow: Chunk Lifecycle](chunk-lifecycle.md) — system overview
- [Planning Domain](../systems/subsystems/planning-domain.md)
- [CPU Cache](../systems/subsystems/cpu-cache.md)
- [GPU Residency](../systems/subsystems/gpu-residency.md)
- [Worker Protocol](../systems/subsystems/worker-protocol.md)
