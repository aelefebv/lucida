---
created: 2026-04-18
modified: 2026-05-16
---

# CPU Cache

`lucida-web/src/pipeline/fetch/` — host-side cache between the network and the GPU. A directory of focused modules with `cpuCache.ts` as a thin coordinator that fans out to collaborators (interaction-mode detector, telemetry counters, eviction policies, three stores, two schedulers, retry policy + typed errors, rejection tracker, wire-protocol helpers). See [[decisions/0032-cpucache-split-into-pipeline-fetch]] for the directory-layout philosophy and the per-module rationale.

After S5, this is the **sole** chunk fetch path. The old `SharedChunkQueue` was deleted; if you see a reference to it anywhere, that's stale.

## Module layout

The directory's collaborators (each one a focused, separately-testable unit):

- `cpuCache.ts` — coordinator. Wires the collaborators in its constructor; each public method (`submit`, `drain`, `snapshot`, `telemetry`, `cancelDataset`, `reset`, `markRejected`, `clearRejected`, `getCachedChunk`, `getCachedProxy`, `getCacheDump`, `getProxyCacheDump`, `subscribe`) is a few-line fan-out. Still hosts `fetchAndDecode` and `fetchProxy` — they're the startFn callbacks the schedulers invoke and the seam where source + decode + store + ready-listener coordinate.
- `types.ts` — internal + public type defs (`CacheEntry`, `ReadyDelivery` union, `CacheTelemetry`, `CpuCacheConfig`, `EvictionTier`, `Lane`, `TierCounters`, `TierResidencyEntry`).
- `interactionMode.ts` — `InteractionModeDetector` (panning / scrubbing / idle) drives the tier-order rotation in `TieredPolicy`.
- `eviction.ts` — `EvictionPolicy` interface with `LRUPolicy` (overview + proxy caches) and `TieredPolicy` (main cache; preserves the active-detail tiebreaker exactly).
- `chunkStore.ts` — `ChunkStore`. Wraps a `Map<entityId, Map<chunkKey, CacheEntry>>` + bytes counter + budget + eviction policy. Parameterized: the main cache and overview cache are both `ChunkStore` instances differing only in policy + tier label.
- `proxyStore.ts` — `ProxyStore`. Wraps the two-level `Map<datasetId, Map<innerKey, ProxyCacheEntry>>` + LRU-across-datasets policy. Separate class because the two-level shape differs from chunk stores.
- `scheduler.ts` — `Scheduler<Req>` generic. Owns pending queue + in-flight Map + concurrency/bytes caps + backpressure logging via injected `BurstLogger`. Instantiated twice (chunk + proxy); explicitly NOT unified — see [[decisions/0032-cpucache-split-into-pipeline-fetch]].
- `retry.ts` — typed `FetchError(kind: "permanent" | "transient" | "abort")` + `classifyFetchError` + `RetryPolicy` interface with `OnceTransientRetry` (current chunk behaviour) and `NeverRetry` (current proxy behaviour). See [[decisions/0033-typed-fetch-error]].
- `telemetry.ts` — `TelemetryCounters` (verb API: `recordRequest` / `recordHit` / `recordEviction` / `recordDecode` / `recordFetchFailure` / `recordCompletedFetch` / `snapshot` / `reset`) + `BurstLogger` (rate-limited debug log channel for `cache.backpressure` and `cache.failure_burst`).
- `rejection.ts` — `RejectionTracker` wraps the per-entity `Set<chunkKey>` rejected map. `mark` returns whether the key was newly added so the caller can abort an in-flight fetch.
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

## Submit → schedule → decode → drain

Each tick:

1. **Submit** — orchestrator calls `cpuCache.submit(plan)`. The cache demotes entities that left the active set (their chunks move to the `demoted-detail` tier), dedups requests, pushes survivors onto `pendingRequests`.
2. **Schedule** — `startChunkFetches` sorts pending by priority and launches up to `maxConcurrentFetches` (≈9) bounded by `maxBytesInFlight` (32 MB).
3. **Fetch** — `contentSource.fetch(req)` returns binary bytes via the WebSocket bridge; routed by `(level, t, c, z, y, x)` key.
4. **Decode** — `decodePool.decode(...)` picks a worker from a 3-worker pool, selects codec by wire format (Raw/Lz4/Zstd), returns a typed array.
5. **Insert + signal** — decoded chunk lands in the cache and on the `ready[]` queue. The orchestrator drains this each tick within the upload budget.

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

- **Upstream**: [[planning-domain]] produces the `RequestPlan` consumed by `submit`. The orchestrator owns the call site (`pipeline/orchestrator.ts`).
- **Sideways**: `contentSource.ts` (binary fetch via [[lucida-web|bridge.ts]]) and `decodePool.ts` (3 web workers running `decode.worker.ts`).
- **Downstream**: the orchestrator's drain loop pulls from `ready[]`, filters against `workerWantedSet`, and posts to the GPU worker via [[worker-protocol]] messages.

## Invariants

- **Demotion preserves bytes.** When an entity leaves the active set, its chunks don't drop — they move tier. They evict only under memory pressure, after the cheaper tiers are exhausted.
- **In-flight dedup is by chunk key.** The same `(level, t, c, z, y, x)` is fetched at most once concurrently regardless of how many requesters want it.
- **Recently-failed requests are skipped on next submit.** A failed fetch doesn't immediately retry. The orchestrator sees no entry in `ready[]` and the wanted-set carries the request forward; eventually the failure window expires.
- **Drain is byte-bounded, not count-bounded.** Bigger chunks consume budget faster. The orchestrator passes `MAIN_VIEW_UPLOAD_BUDGET_BYTES` (16 MB on main view, 2 MB on minimap) per tick.

## Gotchas

- **Failure tracking is a window, not a permanent fail-list.** If a request fails repeatedly because the server can't serve it (e.g. a missing chunk), the cache will keep retrying with a backoff. There's no per-request retry budget.
- **Cache budgets are per-tier, not global.** A dataset with a huge proxy footprint can fill the proxy tier while the detail tier is half-empty; the cache won't redistribute. Tune budgets or the planner if this bites.
- **Drain order matches decode-completion order within a priority band.** If a high-priority chunk decodes after a lower-priority one in the same band, the lower-priority one drains first. The orchestrator's wanted-set filter still ensures only useful chunks make it across.
- **`submit` is called before `drain` in the same tick** — the planner can immediately move a freshly-decoded chunk from `ready[]` into the upload path within one frame. If you reorder these in `orchestrator.ts`, expect a one-frame upload latency.
