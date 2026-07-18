---
type: Flow
title: "Flow: Chunk Lifecycle"
description: "From \"the planner decides this chunk is wanted\" to \"this chunk's voxels become pixels.\" This is the canonical hot path; every render frame walks pieces of it."
tags: [lucida, flow]
source_path: wiki/flows/chunk-lifecycle.md
created: 2026-04-18
modified: 2026-07-16
---

# Flow: Chunk Lifecycle

From "the planner decides this chunk is wanted" to "this chunk's voxels become pixels." This is the canonical hot path; every render frame walks pieces of it.

## Phases

### 1. Planning decides "wanted"

[Planning Domain](../systems/subsystems/planning-domain.md) resolves each visible tile/image to an explicit `detail` level and optional source/generated-ready `coarse` level. For each visible entity in the active set, it iterates grid cells inside `xyBounds ∩ zRange ∩ frustumPlanes`. Each candidate becomes a tier-labeled `ChunkRequest` in one of four lanes: `detail`, `coarse`, `prefetch`, or `minimap`. Detail, coarse, and prefetch priorities are `laneOffset + (1-importance)*importanceWeight + distance*distanceWeight` (`computePriority` in `emit.ts`), so the lane offset separates kinds of work and importance/distance order within a lane. The minimap lane has a bounded fast-seed mode with no entity importance/distance terms and a bulk mode that is placed behind all view-serving requests when whole-dataset demand is large.

### 2. CPU cache submits + schedules

[CPU Cache](../systems/subsystems/cpu-cache.md) demotes stale detail entities, dedups by chunk key, interleaves detail/coarse requests when both lanes have work, and pushes survivors to the scheduler. Concurrent fetches are bounded by `decode-pool-size × FETCH_CONCURRENCY_MULTIPLIER` (multiplier = 3, hardware-dependent) and by 32 MB in-flight.

### 3. Network fetch

`contentSource.ts::fetch(req)` asks `bridge.ts` to send a `chunk_request` JSON over the workspace WebSocket. `FetchSource::Proxied` names this ordinary server relay: source chunks route through `serve_chunk_from_store` and its bounded `CachedStore` object-store reader, while generated coarse chunks route through `serve_generated_chunk_request` and the derived-chunk cache.

Ready source and generated chunks use the same checked frame owned by `lucida-protocol`: `[client_id u32 LE][key_len u16 LE][UTF-8 key bytes][payload bytes]`. The key is `{datasetId}/{imageId}/{chunkKey}`. `bridge.ts::handleBinary` uses the canonical web decoder and forwards the validated `(key, payload)` pair; `contentSource.handleBinary` resolves the exact composite key in the pending-fetch table. If a generated chunk is not ready, the server sends `GeneratedChunkStatus`; `pending` clears in-flight state without entering failure tracking. Client-originated binary frames and retired asset/proxy frame shapes fail closed.

### 4. Decode

`decodePool.ts` hands the encoded buffer to a worker in a dynamically-sized pool (`decode.worker.ts`; size `Math.max(2, floor(cores/2) - 1)`) which selects codec (Raw/Lz4/Zstd) from the `WireFormat` for that image and produces a typed array.

### 5. Cache insertion

Decoded chunk inserted into the appropriate [CPU Cache](../systems/subsystems/cpu-cache.md) bucket (`detail` or `coarse/minimap`), stamped with priority, residency tier, and wanted generation.

### 6. Deliverability

`CpuCache.getDeliverable()` yields cached, currently-wanted, not-rejected, not-sent chunks in priority order. The [Uploader](../systems/subsystems/upload-pipeline.md) consumes that iterable within the upload budget (8 MB main view, 2 MB minimap). Detail and coarse bytes use the same delivery contract and remain distinct through their tier label.

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
5. **Fallback chain**: selected detail tier → configured coarse tier → empty.
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
