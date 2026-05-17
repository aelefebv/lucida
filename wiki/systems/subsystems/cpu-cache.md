---
created: 2026-04-18
modified: 2026-05-17
---

# CPU Cache

`lucida-web/src/pipeline/fetch/` — host-side cache between the network and the GPU. A directory of focused modules with `cpuCache.ts` as a thin coordinator that fans out to collaborators (interaction-mode detector, telemetry counters, eviction policies, three stores, two schedulers, retry policy + typed errors, rejection tracker, delivery-state tracker, wire-protocol helpers). See [[decisions/0032-cpucache-split-into-pipeline-fetch]] for the directory-layout philosophy and the per-module rationale.

This is the **sole** chunk fetch path. If you see a reference to a `SharedChunkQueue` anywhere, that's stale.

## Module layout

The directory's collaborators (each one a focused, separately-testable unit):

- `cpuCache.ts` — coordinator. Wires the collaborators in its constructor; each public method (`submit`, `getDeliverable`, `markSent`, `markChunkEvicted`, `markProxyMissing`, `onPlanRebuildStart`, `snapshot`, `telemetry`, `cancelDataset`, `reset`, `markRejected`, `getCachedChunk`, `getCachedProxy`, `getCacheDump`, `getProxyCacheDump`, `subscribe`) is a few-line fan-out. Still hosts `fetchAndDecode` and `fetchProxy` — they're the startFn callbacks the schedulers invoke and the seam where source + decode + store coordinate.
- `types.ts` — internal + public type defs (`CacheEntry`, `ReadyDelivery` union, `CacheTelemetry`, `CpuCacheConfig`, `EvictionTier`, `Lane`, `TierCounters`, `TierResidencyEntry`).
- `interactionMode.ts` — `InteractionModeDetector` (panning / scrubbing / idle) drives the tier-order rotation in `TieredPolicy`.
- `eviction.ts` — `EvictionPolicy` interface with `LRUPolicy` (overview + proxy caches) and `TieredPolicy` (main cache; preserves the active-detail tiebreaker exactly).
- `chunkStore.ts` — `ChunkStore`. Wraps a `Map<entityId, Map<chunkKey, CacheEntry>>` + bytes counter + budget + eviction policy. Parameterized: the main cache and overview cache are both `ChunkStore` instances differing only in policy + tier label.
- `proxyStore.ts` — `ProxyStore`. Wraps the two-level `Map<datasetId, Map<innerKey, ProxyCacheEntry>>` + LRU-across-datasets policy. Separate class because the two-level shape differs from chunk stores.
- `scheduler.ts` — `Scheduler<Req>` generic. Owns pending queue + in-flight Map + concurrency/bytes caps + backpressure logging via injected `BurstLogger`. Instantiated twice (chunk + proxy); explicitly NOT unified — see [[decisions/0032-cpucache-split-into-pipeline-fetch]].
- `retry.ts` — typed `FetchError(kind: "permanent" | "transient" | "abort")` + `classifyFetchError` + `RetryPolicy` interface with `OnceTransientRetry` (current chunk behaviour) and `NeverRetry` (current proxy behaviour). See [[decisions/0033-typed-fetch-error]].
- `telemetry.ts` — `TelemetryCounters` (verb API: `recordRequest` / `recordHit` / `recordEviction` / `recordDecode` / `recordFetchFailure` / `recordCompletedFetch` / `snapshot` / `reset`) + `BurstLogger` (rate-limited debug log channel for `cache.backpressure` and `cache.failure_burst`).
- `rejection.ts` — `RejectionTracker` wraps the per-entity `Set<chunkKey>` rejected map. `mark` returns whether the key was newly added so the caller can abort an in-flight fetch.
- `deliveryState.ts` — `DeliveryState` wraps optimistic chunk/proxy sent state. Chunk sent facts clear on cold-state rebuild; proxy sent facts survive until worker feedback says the proxy is missing or the dataset is removed.
- `contentSource.ts` — `ContentSource` interface + `ProxiedContentSource` impl over the WebSocket bridge. Owns `handleBinary(key, payload)` and routes itself by `proxy/` prefix (the bridge does not sniff for binary routing).
- `decodePool.ts` — codec-agnostic decode worker pool. Unchanged shape.
- `decode.worker.ts` — Raw / LZ4 / Zstd decompression + uint8 / bool / uint16 normalization. The Zstd path slices the typed-array view to avoid a 12-byte garbage prefix in some payloads.
- `wireProtocol.ts` — `parseProxyHeader` (64-byte LE) + `proxyResponseKey` (cross-language contract with the Rust server's `proxy_response_key`).
- `index.ts` — barrel re-export. External callers import from `pipeline/fetch/` only.

## Why a CPU cache between network and GPU

Three problems all want to be solved in one place:

1. **Decoding is parallel** but bounded by the decode worker pool size (3). If the network out-paces decode, requests pile up; if decode out-paces upload, decoded bytes sit waiting. A central cache lets fetch and decode and upload each go at their own rate without coupling.
2. **Re-fetch on GPU eviction is wasteful** if the bytes are still in CPU memory. The worker can evict an atlas slot under memory pressure; the CPU cache holds the decoded bytes long enough to re-upload without going back to the network.
3. **Tier-aware eviction lets the cheap stuff (prefetch, demoted) go first.** Without tiers, LRU evicts whatever's oldest, which often happens to be the most expensive thing to re-fetch (overview/minimap data covers the whole dataset).

## Submit → schedule → decode → deliver

Each tick:

1. **Rebuild start** — on a cold-state rebuild, tick coordinator calls `cpuCache.onPlanRebuildStart()` once before the per-dataset loop. This advances the wanted generation, clears rejection state, and clears chunk sent state.
2. **Submit** — tick coordinator calls `cpuCache.submit(plan)` per dataset. The cache demotes entities that left the active set (their chunks move to the `demoted-detail` tier), dedups requests, refreshes wanted-generation/priority on cached entries, and pushes survivors onto scheduler pending queues.
3. **Schedule** — schedulers launch up to `maxConcurrentFetches` (≈9), bounded by `maxBytesInFlight` (32 MB). Chunk and proxy schedulers share both caps; proxy fallback drains first so a saturated detail queue cannot strand fallback assets until the next camera move.
4. **Fetch** — `contentSource.fetch(req)` or `fetchProxy(req)` returns bytes via the WebSocket bridge.
5. **Decode / insert** — decoded chunks and proxies land in their cache stores with priority and wanted generation stamped from the latest submit that still wanted the in-flight request.
6. **Deliver** — the uploader walks `cpuCache.getDeliverable()`, which yields cached, currently-wanted, not-rejected, not-sent chunks/proxies in priority order. After dispatch, it calls `cpuCache.markSent(delivery)`.

## Eviction tiers

Highest-numbered tier evicts first. LRU within each tier (by `insertedAt`), except for **active-detail** — see below.

1. **prefetch** — cheapest to lose
2. **demoted-detail** — entity navigated away from
3. **active-detail** — currently visible
4. **proxy** — fallback resource (well/field proxy)
5. **overview** — per-entity coarsest pass + minimap; most expensive; covers whole dataset

`lane: "minimap"` chunks land in the overview cache — the most-protected tier — so the minimap survives memory pressure that would clear other tiers. Combined with the planner emitting minimap at priority 0, the effect is "fetched first, evicted last." See [[decisions/0023-minimap-lane-with-highest-priority]].

Budgets: main 512 MB, overview 64 MB, proxy 256 MB.

### Active-detail uses least-recently-wanted, lowest-importance first

Pure insertion-order LRU is exactly wrong here: focal-point chunks fetch first (smallest priority number), so they're the *oldest* in cache, so they'd evict first under pressure — producing a center-outward eviction wave (visible in the chunkGrid debug overlay as green→red ripples).

Instead, active-detail evicts in this order (each key is a tiebreaker for the prior):

1. **`lastSeenTick` ascending** — chunks not present in the most recent plan go first. Handles frustum-culled, out-of-LOD-range, and off-screen chunks for still-active entities.
2. **`priority` descending** — among entries seen this tick, the highest priority *number* (= farthest from focal, lowest importance) goes first.
3. **`insertedAt` ascending** — deterministic tiebreaker.

Both `lastSeenTick` and `priority` are refreshed on every `submit()` for any cached chunk that appears in the plan. This requires Planning to emit cached chunks (it doesn't filter by cache state — `submit()` is the sole dedup point).

## Interactions

- **Upstream**: [[planning-domain]] produces the `RequestPlan` consumed by `submit`. The tick coordinator owns the call site (`pipeline/tickCoordinator.ts`).
- **Sideways**: `contentSource.ts` (binary fetch via [[lucida-web|bridge.ts]]) and `decodePool.ts` (3 web workers running `decode.worker.ts`).
- **Downstream**: the [[upload-pipeline|Uploader]] walks `getDeliverable()` and posts to the GPU worker via [[worker-protocol]] messages. Worker feedback returns through `markChunkEvicted` and `markProxyMissing`.

## Invariants

- **Demotion preserves bytes.** When an entity leaves the active set, its chunks don't drop — they move tier. They evict only under memory pressure, after the cheaper tiers are exhausted.
- **In-flight dedup is by chunk key.** The same `(level, t, c, z, y, x)` is fetched at most once concurrently regardless of how many requesters want it.
- **Recently-failed requests are skipped on next submit.** A failed fetch doesn't immediately retry. The wanted set carries the request forward; eventually the failure window expires.
- **Delivery is byte-bounded, not count-bounded.** Bigger chunks consume budget faster. The uploader receives `MAIN_VIEW_UPLOAD_BUDGET_BYTES` (8 MB on main view, 2 MB on minimap) per tick and uses a one-item soft cap.

## Gotchas

- **Failure tracking is a window, not a permanent fail-list.** If a request fails repeatedly because the server can't serve it (e.g. a missing chunk), the cache will keep retrying with a backoff. There's no per-request retry budget.
- **Cache budgets are per-tier, not global.** A dataset with a huge proxy footprint can fill the proxy tier while the detail tier is half-empty; the cache won't redistribute. Tune budgets or the planner if this bites.
- **Delivery order is strict priority across chunks and proxies.** `ready[]` no longer imposes decode-completion order; `getDeliverable()` merges currently-wanted cached entries by planner priority.
- **In-flight fetches are not automatically current.** A chunk requested by an older camera/LOD plan may finish after a rebuild; it stays cached but is deliverable only if a newer submit refreshed that in-flight key. This prevents stale low-LOD arrivals from uploading into a zoomed-in cold state.
- **Worker skipped feedback is image-keyed, rejection is entity-keyed.** `markChunkEvicted` resolves `(imageId, c, chunkKey)` back through the cache entry before marking rejections, so plate fields whose `entityId` differs from `imageId` do not repeatedly resend rejected chunks.
- **`submit` is called before upload in the same tick** — the planner refreshes wanted-generation on cached entries before `deliverToWorker` asks for deliverables. If you reorder these in `tickCoordinator.ts`, expect a one-frame upload latency or stale deliverability.
