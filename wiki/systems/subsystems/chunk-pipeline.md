---
created: 2026-04-18
modified: 2026-05-07
---

# Chunk Pipeline

The end-to-end path from "user opens a dataset URL" to "pixels on screen" in [[lucida-web]]. Owns the trickiest interactions in the codebase: planning thresholds, prioritized fetching, decode parallelism, GPU residency, and the semantic fallback chain.

## Where the deep dive lives

The repo's top-level **`CHUNK_PIPELINE.md`** is the canonical end-to-end trace. It walks every step with concrete file:line references, the exact priority formula, the eviction tier order, the upload budget per frame, and a one-paragraph summary. Read it when you need the trace.

This article captures the *shape*, *invariants*, and *gotchas* — the things that won't be obvious from a single read of the trace.

## Phases of one frame

Every RAF tick runs four phases in this order, then reschedules if work remains:

1. **Plan** — query WASM (`view_query`, `member_positions`, `visible_region`); decide which entities are active and at what LOD; enumerate wanted chunks with priorities. Owned by [[planning-domain]].
2. **Upload** — drain decoded chunks from the [[cpu-cache]] to the GPU worker, filtered by what the worker still wants and bounded by the per-frame byte budget.
3. **Render** — slice or volume path; throttled if only `residencyDirty` changed (≈30 fps cap on chunk-arrival redraws), immediate if `interactiveDirty`. Owned by [[gpu-residency]] downstream of `renderLoop.ts`.
4. **Minimap** — same indirection lookups, smaller atlas, render-key skips when stationary.

## Sub-systems and where to read more

- [[planning-domain]] — what to fetch and at what priority
- [[cpu-cache]] — fetch scheduling, decode pool, eviction tiers, drain
- [[gpu-residency]] — atlases, indirection, descriptor buffer, fallback chain
- [[worker-protocol]] — message contract between main thread and GPU worker
- [[multichannel-and-colormaps]] — composite key naming, per-channel settings, LUT sampling

## Invariants

- **The view query is the single source of truth for "what's visible and at what apparent size."** Planning, the CPU cache, the GPU worker, and the shaders never re-derive these — they consume them. The view query lives in WASM (`scene.view_query(dsId)`) so the answer is the same as the server's and the CLI's.
- **Single vs plate complexity lives entirely in planning.** Below planning, both produce the same shape of `ChunkRequest` — plates just have more of them and add `WellProxy3D` / `FieldProxy3D` request kinds.
- **Priority is a single scalar, lower wins.** The formula is `laneOffset + (1 - importance) * 500 + distance * 10`. Lanes are `DETAIL=0`, `PROXY=500`, `PREFETCH=1000`, `OVERVIEW=2000`. Centered, important detail wins (~0); far prefetch loses (~1500+).
- **`CpuCache` is the sole fetch path.** The old `SharedChunkQueue` was deleted in S5; nothing else fetches.
- **Atlas eviction is pure LRU per pool.** The orchestrator drives "what should be there"; the GPU worker just reports what it lost via `chunksEvicted` and the next `wantedSetDelta`.
- **Plate proxy pools are keyed by `(datasetId, kind, slotDims, channel)`.** The `channel` axis matters because each channel composites independently and pool capacity is per-pool — see [[decisions/0004-multi-pool-atlases]].

## Gotchas

- **Exceeding the 16 MB/frame upload budget starves other work.** The budget is reserved across slice + volume; over-budget chunks defer to the next frame. There's a separate 2 MB minimap budget.
- **Worker eviction reporting is async** — the worker posts `chunksEvicted` (evicted + skipped); the main thread reconciles against `proxyDeliveredToWorker` and `sentSet` on receipt. Forgetting this drift causes "I sent it, why didn't it draw?" symptoms.
- **Hysteresis bands of ±5px around each promotion threshold** prevent flapping when the user dwells near a boundary. If you tune thresholds in `planning.ts`, keep the band; without it, plates oscillate between modes during normal scroll.
- **Catalog-aware degradation** — if planning wants a proxy that the server's `AssetCatalog` doesn't advertise, it degrades one tier finer (e.g., wanted well-as-proxy but no `WellProxy3D` available → drop to fields-with-proxy-fallback). This is silent; observable only via the debug panel.
- **`residencyDirty` is throttled (~33ms) but the tick still runs in the gap to keep uploading.** Only the *render* is throttled. If you change this, expect either visible jitter (no throttle) or upload starvation (throttling the whole tick).
