# Pass 2 — Boundary Scan: fetch/decode subsystem

Goal: identify the natural seams where responsibilities should be separated.

## What's mixed today

Today the fetch/decode subsystem has the following physical layout:

```
cpuCache.ts         (1627 LOC) — submit/scheduler/eviction/telemetry/lifecycle/dumps/proxy-mirror
contentSource.ts    ( 319 LOC) — wire transport (chunk + proxy) + header parsing
decodePool.ts       ( 114 LOC) — worker pool + extractDataType helper
decode.worker.ts    ( 140 LOC) — codec dispatch + normalization (in-worker)
bridge.ts           ( 350 LOC) — WS framing + binary envelope + chunk/proxy router
```

`cpuCache.ts` is the dechaos hot zone — it bundles ~12 distinct concerns into one class. By contrast, the post-refactor planning module split 11 concerns across 100–500 LOC files. The same shape applies here.

## Concerns currently fused inside `CpuCache`

Numbered for reference in later passes.

1. **Public submit/drain/snapshot/telemetry API** — the orchestrator's view of the cache.
2. **Cache storage** — three Maps (`mainCache`, `overviewCache`, `proxyCache`) + their byte counters.
3. **Active-set diffing + tier promotion/demotion** — `submit()` body + `demoteEntity`.
4. **Dedup ladder** — "skip if rejected | cached (refresh) | in-flight | failed" — currently inline in `submit()`.
5. **Fetch scheduling for chunks** — concurrency cap, byte-cap, in-flight bookkeeping, byte estimate refinement.
6. **Fetch scheduling for proxies** — parallel structure to (5), shares caps but is otherwise duplicated.
7. **Failure classification, retry, failure map, burst-log** — `fetchAndDecode` catch + `recordFailureForBurstDetection` + `failures`.
8. **Eviction policy** — three policies (overview LRU / detail tiered / proxy LRU) + interaction-mode detection.
9. **Telemetry production** — counters scattered across many call sites; aggregation in `telemetry()`.
10. **Debug dumps** — `getCacheDump`, `getProxyCacheDump`, `getPendingDump` (read-only views).
11. **Lifecycle** — `cancelDataset`, `reset`, `clearRejected`.
12. **Worker-rejection feedback channel** — `markRejected`, `clearRejected`, `rejectedKeys` map.

The cache also carries cross-cutting state: `submitTick`, `lruCounter`, `epochHistory`, `currentEpochs`, `cacheLogState`, `lastError`, `decodeTimes`, `pendingEnqueuedAt`, `avgDecodedBytes`, `completedFetches`. All of it lives on the `CpuCache` class but most of it has nothing to do with caching.

## Candidate seams

### Seam A — Transport (chunk vs proxy as a single concept)

The proxy path is structurally a fetch of a different asset kind, with different header/payload layout, different timeout, different lack-of-retry semantics. Today this is expressed as **parallel duplicated code** inside `cpuCache.ts` (concerns 5 + 6) and inside `contentSource.ts` (`fetch` + `fetchProxy` are siblings, not specializations).

Candidate boundary: a single `Asset` concept with `kind: "chunk" | "proxy"`. One scheduler, one pending queue, one in-flight map. Per-kind hooks for: timeout, response parsing (header + payload split for proxy), retry policy.

This is the largest single source of duplication in the subsystem.

### Seam B — Wire transport vs cache

`ProxiedContentSource` is good — it already encapsulates "send JSON, await binary by key, parse." The `ContentSource` interface gives `cpuCache.ts` testable injection. **This boundary is healthy as-is.** The seam to consider here is internal to `contentSource.ts`:

- The `parseProxyHeader` free function should arguably live alongside the wire format types or in a `proxyHeader.ts`. It's not transport, it's parsing, and it's referenced from one place inside `ProxiedContentSource`.
- `proxyResponseKey` and the implicit `compositeKey = "${datasetId}/${imageId}/${chunkKey}"` for chunks are both **wire-key composition rules** — they should sit together with parseProxyHeader as part of a wire-protocol module that also gets used by the bridge router (see Seam C).

### Seam C — Bridge envelope vs key-prefix routing

`bridge.handleBinary` (`bridge.ts:213-231`) parses the `(client_id, keyLen, keyBytes, payload)` envelope and then makes a routing decision:

```
if (key.startsWith("proxy/")) onProxyData(key, payload)
else onChunkData(key, payload)
```

The bridge is responsible for the WS-level envelope. It should not know about the application-level "chunk vs proxy" taxonomy. Today the contentSource has two handlers (`handleChunkData`, `handleProxyData`) and the bridge knows which to call.

Candidate boundary: `Bridge.onBinary(key, payload)` — a single handler — and `ContentSource` (or a dedicated `BinaryRouter`) does the prefix dispatch. Removes a coupling and makes adding asset kinds a one-place change.

### Seam D — Decode pipeline

`decode.worker.ts` already has a good internal seam: `decompress` (Raw / LZ4 / Zstd) → `normalize` (uint8 / bool / uint16). These are pure functions and even re-exported for tests. **Internally healthy.**

The fragile boundary is across the worker postMessage edge: the request shape is `{id, bytes, wireFormat, dataType}`, with `dataType` redundant — it's already extractable from `wireFormat` via `extractDataType`. The pool computes `extractDataType(wireFormat)` on the main thread and ships both. Candidate cleanup: ship only `wireFormat` and let the worker do the extraction.

`extractDataType` itself lives in `decodePool.ts` but is logically wire-format introspection. It's used by `contentSource.ts` (for the `FetchResult.dataType` field on every chunk fetch). Candidate boundary: move it to `manifestTypes.ts` (where `WireFormat` already lives) or to a sibling `wireFormat.ts`.

### Seam E — Fetch scheduling vs cache storage

Inside `CpuCache`, the **fetch scheduler** (concerns 4, 5, 6, 7) and the **cache storage + eviction** (concerns 2, 3, 8) are tangled. They share fields (`pendingRequests`, `inFlight`, `mainCache`) but address different questions:

- Scheduler: *what should we fetch next, and how many at once?*
- Cache: *what's resident, how much memory does it use, and what gets evicted?*

A clean split: `FetchScheduler` (`pending + inFlight + concurrency caps + retry + dedup against in-flight/failed`) and `ChunkStore` (`cache maps + byte budgets + tiered eviction + active/demoted/prefetch tier model`). `CpuCache` becomes the thin coordinator: takes a `RequestPlan`, runs dedup against `ChunkStore`, hands survivors to `FetchScheduler`, receives decoded buffers, inserts to `ChunkStore`, queues to `ready[]`.

This mirrors the planning split (`modes.ts` separated from `chunks.ts` separated from `emit.ts` separated from `plan.ts`).

### Seam F — Eviction policy as plug-in

Three eviction policies live as `if`-branches in `evictIfNeeded`:
- Overview LRU
- Detail tiered (with interaction-mode-driven tier order)
- Proxy LRU (separate function `evictProxyIfNeeded`)

Plus the active-detail tie-breaker (`lastSeenTick → priority desc → insertedAt`) is a fourth, distinct strategy.

Candidate boundary: each cache layer (overview / detail / proxy) holds its own policy as a strategy object or static module. The store doesn't know about interaction mode; it asks its policy.

### Seam G — Interaction-mode detection vs eviction

`detectInteractionMode` reads `epochHistory` (last 10 epoch snapshots) and returns `panning | scrubbing | idle`. This is consumed by:
- `evictTiered` — to pick tier order
- `telemetry()` — to surface in the telemetry payload

It has nothing to do with caching. Candidate boundary: pull `epochHistory` + `detectInteractionMode` out as a sibling `interactionMode.ts` (a tiny self-contained module, < 50 LOC). Both eviction and telemetry depend on it explicitly.

### Seam H — Telemetry collection

`telemetry()` aggregates from 16 separately-mutated fields. Concrete pain points:
- Window-scoped counters (`evictionsSinceSnapshot`, `decodesSinceSnapshot`) reset inside `telemetry()` itself, conflating "produce telemetry" with "advance the window."
- Counters are mutated from many call sites (`submit`, `fetchAndDecode`, `removeEntry`, `evictProxyIfNeeded`, `recordFailureForBurstDetection`).
- The `cacheLogState` (rate-limited debug log state) is mixed in with telemetry counters.

Candidate boundary: a `CacheTelemetry` object (or two: `Counters` for monotonic + `Window` for reset-on-read). Public methods like `recordEviction(tier)`, `recordDecode(ms)`, `recordHit()`, `recordRequest()`. Hides the field set behind a tight interface.

### Seam I — Lifecycle vs steady-state

`cancelDataset` and `reset` are 80+ LOC of "find every Map and remove" logic. They share the form *but not the implementation*. Each new piece of state added to `CpuCache` requires updating both. The current count is 7 numbered steps in `cancelDataset` and 8 fields zeroed in `reset`.

Candidate boundary: each sub-store (FetchScheduler / ChunkStore / ProxyStore / FailureMap / RejectionSet / Telemetry) exposes its own `cancelDataset(datasetId, entityIds)` and `reset()`. `CpuCache` orchestrates by fanning out. New state added to a sub-store automatically gets its lifecycle handled.

### Seam J — Worker-rejection feedback

`markRejected` / `clearRejected` / `rejectedKeys` are a state channel from the GPU worker (via orchestrator) into the cache. The cache uses them in `submit`'s dedup ladder. The lifecycle ("clear on cold-state-rebuild") is owned by the orchestrator.

This is small, but the coupling is implicit: the cache trusts the orchestrator's clear cadence. Candidate boundary: keep the `rejectedKeys` field but make the lifecycle contract explicit in the comment block (already partly there) and unit-test it independently. Or push it out to a `RejectionTracker` module that the orchestrator owns and the cache reads from. (Probably not worth a full extraction yet — score it 6/10 for value.)

### Seam K — Debug dumps as read-only views

`getCacheDump` / `getProxyCacheDump` / `getPendingDump` are pure reads but tightly coupled to internal `Map<string, Map<string, CacheEntry>>` shapes. They're the only public API consumed by `DebugPanel`.

Candidate boundary: an explicit `inspect()` API on each sub-store, or keep them on `CpuCache` as a `DebugInspector` collaborator with no other responsibility. Low priority but mechanically easy.

## Visualization: target shape (sketch)

```
pipeline/fetch/                    (proposed directory)
  index.ts                         barrel — public surface for orchestrator/session
  scheduler.ts                     pending queue + inFlight + concurrency caps + dedup
  retry.ts                         failure classification + retry + failures map + burst log
  store.ts                         main + overview cache maps + budgets + insert/remove
  eviction.ts                      tiered + LRU policies; takes interaction mode as input
  proxyStore.ts                    proxy cache + LRU eviction (or fold into store via Asset abstraction)
  interactionMode.ts               epochHistory + panning/scrubbing/idle detection
  telemetry.ts                     counters + window + telemetry()/dumps
  rejection.ts                     rejectedKeys feedback channel (or live on store)
  cpuCache.ts                      thin coordinator wiring the above
  contentSource.ts                 unchanged interface; impl loses parseProxyHeader to wireProtocol.ts
  wireProtocol.ts                  parseProxyHeader + composite-key composers + key-prefix router
  decodePool.ts                    unchanged; loses extractDataType to manifestTypes.ts
  decode.worker.ts                 unchanged
```

This isn't a blueprint — it's a list of candidate boundaries to **stress-test in later passes**, especially the responsibility scan (Pass 3) and the dependency scan (Pass 4). Some seams may collapse or recombine after that work.

## Severity ranking

| Seam | Severity | Why |
|---|---|---|
| A. Chunk/proxy duplication | High | Highest LOC payoff; most footgun-prone (silent semantic divergence on retry/failure) |
| E. Scheduler vs store | High | The biggest single tangle inside `CpuCache`; clearest mirror to the planning refactor |
| H. Telemetry collection | Medium-high | 16 fields scattered; eats reading time; not bug-prone but blocks structural change |
| I. Lifecycle fan-out | Medium | Symptom of E; resolves naturally once sub-stores own their lifecycle |
| F. Eviction-policy plug-in | Medium | Cleaner once stores are split; weak standalone |
| G. Interaction-mode extraction | Medium-low | Tiny, easy, useful as a warm-up |
| C. Bridge envelope vs key router | Medium-low | Real coupling but small; do it when adding the next asset kind |
| D. Decode-pipeline cleanup | Low | Internally healthy; minor cleanups (extractDataType placement, redundant dataType arg) |
| B. Wire-key composers / parseProxyHeader | Low | Small files of helper code; sweep with C |
| K. Debug dumps as views | Low | Mechanical; do alongside H |
| J. Worker-rejection extraction | Low | Implicit coupling, but very small surface |

## Next pass

Pass 3 (Responsibility Scan) zooms in on **per-unit cohesion**: are the candidate sub-modules above each really one thing, and is anything inside `decode.worker.ts` / `contentSource.ts` / `decodePool.ts` doing too much?
