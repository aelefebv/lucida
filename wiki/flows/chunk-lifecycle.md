---
created: 2026-04-18
modified: 2026-04-18
---

# Flow: Chunk Lifecycle

From "the planner decides this chunk is wanted" to "this chunk's voxels become pixels." This is the canonical hot path; every render frame walks pieces of it.

The repo's top-level **`CHUNK_PIPELINE.md`** is the long-form trace, complete with file:line references for every transition. This flow article gives the high-level shape and points at where each phase is owned.

## Phases

### 1. Planning decides "wanted"

[[planning-domain]] — `planning.ts:732-900`. For each visible entity in the active set, iterate grid cells inside `xyBounds ∩ zRange ∩ frustumPlanes`. Each candidate becomes a `ChunkRequest` with priority `laneOffset + (1-importance)*500 + distance*10`.

### 2. CPU cache submits + schedules

[[cpu-cache]] — `cpuCache.ts:306-369` (submit), `:617-750` (scheduler). Demote stale entities, dedup, push to `pendingQueue`. Sort by priority, launch up to ≈9 concurrent fetches bounded by 32 MB in-flight.

### 3. Network fetch

`contentSource.ts::fetch(req)` → `bridge.ts` sends a `chunk_request` JSON over WebSocket → server's `serve_chunk_from_store` → binary frame back over the unicast channel.

Frame layout: `[client_id u32 LE][key_len u16 LE][key bytes][payload bytes]`. `bridge.ts::handleBinary` parses, routes by composite key (`{datasetId}/{imageId}/{chunkKey}` for chunks, `proxy/...` prefix for proxies).

### 4. Decode

`decodePool.ts` hands the encoded buffer to one of 3 web workers (`decode.worker.ts`) which selects codec (Raw/Lz4/Zstd) from the `WireFormat` for that image and produces a typed array.

### 5. Cache insertion

Decoded chunk inserted into the appropriate tier of [[cpu-cache]] (active-detail / demoted-detail / prefetch / proxy / overview); appended to `ready[]`.

### 6. Orchestrator drain

`orchestrator.ts:869-934` — pulls from `ready[]` until upload budget exhausted (16 MB main view, 2 MB minimap). Filters to chunks still in `workerWantedSet` (don't waste bandwidth on chunks the worker no longer wants).

### 7. Post to worker

`client.sliceChunkData(...)` or `client.volumeChunkData(...)` — typed array transfer (zero-copy) over [[worker-protocol]].

### 8. Worker writes atlas + updates indirection

[[gpu-residency]] — `gpu.worker.ts`. Picks a slot in the appropriate atlas pool (per `(dataset, channel, chunk dims)` for proxies; per-entity-LOD section for volume; X-Y grid for slice). Writes the texture. Updates the indirection buffer entry mapping `(entity, lod, z, y, x) → slot coords`. Indirection writes are batched and flushed only on residency change.

### 9. Render

Slice or volume shader runs:
1. Read `descriptors[entityIndex]`.
2. Project fragment to entity-local voxel coords.
3. Compute cell within the chosen LOD.
4. `indirection[lod.indirectionOffset + cellIndex]` → atlas slot.
5. **Fallback chain**: detail target LOD → coarser detail LODs → field proxy → well proxy → blank.
6. Apply contrast → gamma → LUT sample → opacity.

### 10. Composite

`compositor.wgsl` blends per-channel composites for multichannel mode; per-dataset for layered datasets. Composite key naming: `imageId:chN` for multichannel, bare `imageId` for single.

### 11. Eviction (closing the loop)

When the worker evicts a slot under memory pressure, it posts `chunksEvicted` (evicted + skipped keys) and the evicted chunks reappear in the next `wantedSetDelta`. Main thread clears its delivery tracking → next drain re-uploads from CPU cache, or re-requests if the cache also evicted.

## Where things can fail

- **Network** — fetch failures land in the cache's recently-failed window and are retried later.
- **Decode** — codec mismatch or corrupt bytes: error logged, no slot allocated; the planner re-enumerates next tick.
- **Atlas full** — worker evicts LRU; the orchestrator may upload, get evicted, and re-upload in the same tick under pressure (visible as "thrash" in debug stats).
- **Stale upload** — worker's epoch check drops chunks whose planning epoch is older than the worker's current understanding. Debug panel shows these as "skipped."

## Related

- [[chunk-pipeline]] — system overview
- [[planning-domain]]
- [[cpu-cache]]
- [[gpu-residency]]
- [[worker-protocol]]
