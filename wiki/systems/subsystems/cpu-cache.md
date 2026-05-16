---
created: 2026-04-18
modified: 2026-05-15
---

# CPU Cache

`lucida-web/src/pipeline/cpuCache.ts` — host-side cache between the network and the GPU. Owns fetch scheduling, decode pool dispatch, tiered LRU eviction, and the drain queue that feeds [[gpu-residency|the GPU worker]].

After S5, this is the **sole** chunk fetch path. The old `SharedChunkQueue` was deleted; if you see a reference to it anywhere, that's stale.

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
