# Pass 1 — System Map: fetch/decode subsystem

Goal: orient before judging. What lives in the fetch/decode side of the chunk pipeline, what flows through it, and where it sits in the wider app.

## Scope

The "fetch/decode" subsystem is the slice between **planning emits requests** and **the orchestrator drains decoded buffers** to the GPU worker. Concretely:

- `lucida-web/src/pipeline/cpuCache.ts` (1627 LOC) — submit / drain / snapshot / telemetry; in-flight scheduler; tiered LRU eviction
- `lucida-web/src/pipeline/contentSource.ts` (319 LOC) — `ContentSource` interface + `ProxiedContentSource` impl over the WS bridge; chunk + proxy fetch; proxy header parsing
- `lucida-web/src/pipeline/decodePool.ts` (114 LOC) — pool of N web workers; round-robin / least-busy dispatch
- `lucida-web/src/pipeline/decode.worker.ts` (140 LOC) — LZ4 (inline) / Zstd (lazy `fzstd`) decompression + uint8/bool/uint16 normalization
- `lucida-web/src/bridge.ts` (350 LOC) — WS framing; `handleBinary` parses the chunk envelope and routes by key prefix
- `lucida-web/src/pipeline/cpuCache.test.ts` (1427 LOC) — characterization tests (already substantial)

Total in scope: ~2550 LOC of production code + ~1430 LOC of tests.

## Entrypoints (where execution begins)

1. **Construction + wiring** — `hooks/useBridge.ts:98-102`:
   ```
   decodePool   = new DecodePool();
   contentSource = new ProxiedContentSource(sendMessage);
   cpuCache     = new CpuCache(contentSource, decodePool);
   ```
   These three are then handed into a `Session` (`session.ts`) and live for the lifetime of the WebSocket connection. Surviving 2D↔3D toggle is intentional (RenderLoop is recreated on toggle; Session is not).

2. **Per-dataset image registration** — `useBridge.ts:476` — `setupFetchPipeline()` calls `contentSource.registerImage(image_id, wire_format)` for each image in the manifest. The wire format **must** be registered before the first `cpuCache.submit()` for that image, or the fetch promise rejects with `"No wire format registered…"`.

3. **Steady-state submit** — `orchestrator.ts:792` — every tick, `ctx.cpuCache.submit(plan)` is called with a `RequestPlan` produced by the planning domain.

4. **Steady-state drain** — `orchestrator.ts:1387` — `ctx.cpuCache.drain(budget)` returns `ReadyDelivery[]` (chunks + proxies, discriminated union); orchestrator then forwards each to the GPU worker via `client.sliceChunkData / volumeChunkData / proxyAssetData`.

5. **Re-send path** — `orchestrator.ts:1467,1501` — when the worker reports an eviction, orchestrator calls `cpuCache.getCachedChunk` / `getCachedProxy` and re-uploads.

6. **Worker-rejection signal** — `orchestrator.ts:1575` — when the worker reports `chunksSkipped` (atlas full, incoming farther than farthest existing slot), orchestrator forwards each to `cpuCache.markRejected(entityId, key)`.

7. **Lifecycle** — `RenderLoop.removeDataset` → `cpuCache.cancelDataset(datasetId, entityIds)`; on disconnect, `bridge` triggers `contentSource.rejectAll()` indirectly via close handler.

8. **Binary frame routing** — `bridge.ts:213-231` — `handleBinary` parses the envelope (`client_id` 4B, `keyLen` 2B LE, key bytes, payload), decides chunk vs proxy by `key.startsWith("proxy/")`, and calls either `onChunkData` → `contentSource.handleChunkData` or `onProxyData` → `contentSource.handleProxyData`. These resolve pending promise entries.

## Main workflows

### A. Steady-state chunk arrival
1. `cpuCache.submit(plan)` — dedup against in-flight + cached + failed + rejected; refresh `priority`/`lastSeenTick` on cached entries; push survivors to `pendingRequests`; demote entities that left `activeSet`.
2. `startChunkFetches()` — drain `pendingRequests` until `inFlight.size >= maxConcurrentFetches` or `inFlightBytes >= maxBytesInFlight`. Each `startSingleFetch(req)` creates an `AbortController`, books an estimated byte cost, and kicks off `fetchAndDecode(req, …)`.
3. `fetchAndDecode`:
   - `source.fetch(req, signal)` → `FetchResult` (raw bytes + wireFormat + dataType). Errors classified `permanent` (404 / "malformed") vs `transient` (everything else); transient gets one retry after 500ms; permanent or exhausted retries become `failures.set(key, …)` until next content-epoch bump.
   - `decode.decode(bytes, wireFormat, dataType)` → decompressed + normalized `ArrayBuffer`. Times tracked into a 100-entry rolling window for p50/p95.
   - Insert into `mainCache` (lane = detail/prefetch/proxy/...) or `overviewCache` (lane = overview/minimap), evict if needed, push onto `ready[]`, notify listeners.
4. `notifyListeners` → wakes `renderLoop` (which is subscribed via `cpuCache.subscribe`) → `residencyDirty = true`.
5. Orchestrator's next tick calls `drain(MAIN_VIEW_UPLOAD_BUDGET_BYTES = 16MB)` → posts to GPU worker.

### B. Proxy arrival (S5 path)
Mirrors A but routes through `pendingProxyRequests` / `inFlightProxy` / `proxyCache` / `fetchProxy`. Proxies have a separate timeout (60s vs 10s), a separate evict-needed pass (`evictProxyIfNeeded` — pure LRU), and a separate ready-delivery shape (`ReadyProxyDelivery` with header + raw u16 bytes).

### C. Eviction
- `evictIfNeeded(cache, budget, incomingBytes, "main"|"overview")` decides between `evictLRU` (overview: pure insertion-order LRU) and `evictTiered` (main: tier order varies by detected interaction mode `panning`/`scrubbing`/`idle`; within `active-detail` tier, sort by `lastSeenTick → priority desc → insertedAt`).
- `evictProxyIfNeeded(incomingBytes)` is a flat-then-sort LRU across all dataset proxy maps.

### D. Cancellation
- `cancelDataset(datasetId, entityIds)` aborts in-flight chunk fetches whose entityId is in the set, in-flight proxy fetches under the dataset, drops queued entries, drops cached entries, drops ready deliveries, drops failure-map entries (using `entityId + "/"` prefix match because plate IDs contain slashes), and `activeEntityIds` entries.
- `markRejected` aborts a single in-flight chunk and prevents future re-enqueue until `clearRejected` runs.

### E. Telemetry
- `telemetry()` produces `CacheTelemetry` with ~30 fields covering bytes/budgets, in-flight counts, eviction rates by tier, decode percentiles, hit rate, interaction mode, last error. Window-scoped counters reset on each call.
- `getCacheDump`, `getProxyCacheDump`, `getPendingDump` produce per-entry rows for debug-panel "Dump …" buttons.
- `snapshot()` (`{cached, inFlight}` keyed by entityId → Set<chunkKey>) is consumed by orchestrator + DebugOverlays.

## Modules and external dependencies

| Module | Imports from outside the subsystem |
|---|---|
| `cpuCache.ts` | `planning/index.ts` (types: `RequestPlan, ChunkRequest, ProxyRequest, CacheStateSnapshot`), `epochs.ts` (`SceneEpochs`), `debug/logging.ts` (`debugLog`) |
| `contentSource.ts` | `manifestTypes.ts` (`WireFormat`), `assetCatalog.ts` (`ProxyKind`) |
| `decodePool.ts` | `manifestTypes.ts` (`WireFormat`) |
| `decode.worker.ts` | `manifestTypes.ts` (`WireFormat`), lazy `fzstd` |
| `bridge.ts` | `debug/logging.ts` |

## Outside callers

| Caller | What it touches |
|---|---|
| `session.ts` | constructs and holds the trio |
| `hooks/useBridge.ts` | constructs the trio + `setupFetchPipeline` (`registerImage` per image) + `bridge.onChunkData` / `onProxyData` handlers wired to `contentSource.handleChunkData` / `handleProxyData` |
| `pipeline/orchestrator.ts` | `submit / drain / snapshot / markRejected / clearRejected / getCachedChunk / getCachedProxy / cancelDataset` (the heavy consumer) |
| `renderLoop.ts` | `subscribe` (residencyDirty) + lifecycle hooks |
| `renderLoopTypes.ts` | type-only |
| `debug/DebugOverlays.tsx` | `getCachedChunkTier / getPendingSnapshot / getPendingProxySnapshot / isProxyInFlight / snapshot` |
| `debug/DebugPanel.tsx` | `telemetry / updateConfig / getCacheDump / getProxyCacheDump / getPendingDump` |
| `cpuCache.test.ts` | the entire surface, with mocked `ContentSource` + `DecodePool` |

External systems: WebSocket (only network path); web workers (decode pool); browser timers (`setTimeout` for retry + timeout); `performance.now()` for timing.

## Where each "concern" lives today (high-level)

| Concern | File | Notes |
|---|---|---|
| **Wire transport (chunk)** | `bridge.ts:handleBinary` + `contentSource.ProxiedContentSource.fetch` | Bridge parses envelope; ContentSource owns the JSON request + pending-promise table |
| **Wire transport (proxy)** | `bridge.ts:handleBinary` (`proxy/` prefix branch) + `contentSource.ProxiedContentSource.fetchProxy` | Header parsing in `parseProxyHeader` (free function in same file) |
| **Wire-format registry** | `contentSource.imageWireFormats` map | Populated at `registerImage`; consulted on every `fetch` |
| **Codec dispatch** | `decodePool.decode` (chooses worker) → `decode.worker.ts:decompress` (chooses LZ4 / Zstd / Raw) | LZ4 is inline; Zstd lazy-imports `fzstd` |
| **Pixel normalization** | `decode.worker.ts:normalize` | uint8 passthrough, bool→u16 expansion, uint16 passthrough |
| **Fetch scheduling (chunk)** | `cpuCache.startChunkFetches` + `startSingleFetch` + `fetchAndDecode` | Concurrency cap + bytes-in-flight cap; running average for byte estimation |
| **Fetch scheduling (proxy)** | `cpuCache.startProxyFetches` + `startSingleProxyFetch` + `fetchProxy` | **Shares** chunk concurrency caps |
| **Dedup (already cached / in-flight / failed / rejected)** | `cpuCache.submit` body | A 4-condition early-continue ladder per request |
| **Active set tracking + demotion** | `cpuCache.submit` + `demoteEntity` | Diffs `activeEntityIds` vs `plan.activeSet` |
| **Cache insertion + sizing** | `cpuCache.fetchAndDecode` (chunk) + `cpuCache.fetchProxy` (proxy) + `insertEntry` | Sizing inline in the `cacheEntry` literal |
| **Eviction (overview)** | `evictLRU` | Pure LRU |
| **Eviction (detail)** | `evictTiered` + `getTierOrder` + `detectInteractionMode` | Tier order driven by interaction mode (panning/scrubbing/idle) inferred from epoch history |
| **Eviction (proxy)** | `evictProxyIfNeeded` | Flat LRU across all datasets |
| **Failure classification + retry + burst log** | `fetchAndDecode` (catch block) + `recordFailureForBurstDetection` + `failures` map | Permanent vs transient by string match on error message |
| **Backpressure logging** | `startChunkFetches` (post-loop) | 1/sec rate limit |
| **Telemetry collection** | `telemetry` + per-call counters scattered across `submit / fetchAndDecode / removeEntry / evictProxyIfNeeded` | Window-scoped reset on each call |
| **Debug dumps** | `getCacheDump / getProxyCacheDump / getPendingDump` | Pure read |
| **Lifecycle (cancel)** | `cancelDataset / reset` | 7+8 numbered steps respectively |
| **Worker-rejection bookkeeping** | `markRejected / clearRejected` + `rejectedKeys` map | Coupled to orchestrator's cold-state-rebuild cadence |
| **Cached-key snapshot** | `snapshot` | Used by orchestrator for re-send check; planning no longer consumes |
| **Listener fan-out** | `subscribe / notifyListeners` | One subscriber today (RenderLoop) |

## High-risk / confusing areas (to revisit)

A. **`cpuCache.ts` is 1627 LOC and fuses ~12 concerns.** The list in the previous table reads like the case for splitting. By comparison, the post-refactor `planning/` directory has 11 files of 100–500 LOC each. The same shape almost certainly applies here.

B. **Chunk and proxy paths are duplicated.** `pendingRequests`/`pendingProxyRequests`, `inFlight`/`inFlightProxy`, `inFlightBytes`/`inFlightProxyBytes`, `startChunkFetches`/`startProxyFetches`, `startSingleFetch`/`startSingleProxyFetch`, `fetchAndDecode`/`fetchProxy`. They share concurrency caps but are otherwise parallel structures with subtle differences (proxy has no retry, no failure tracking, different timeout, different ready-shape).

C. **Telemetry counters are scattered.** `evictionsSinceSnapshot`, `evictionsByTierSinceSnapshot`, `decodesSinceSnapshot`, `decodeTimes`, `transientFailures`, `permanentFailures`, `lastError`, `cacheLogState`, `pendingEnqueuedAt`, `totalHits`, `totalRequests`, `epochHistory`, `avgDecodedBytes`, `completedFetches`, `lruCounter`, `submitTick` — 16 separate fields, mutated from many call sites.

D. **Failure classification by string-matching error messages** (`message.includes("404") || message.includes("malformed")`). Brittle. Plus: the proxy path silently never marks failures, which is a real divergence in semantics, not just code.

E. **`bridge.handleBinary` is the chunk/proxy router.** Fine today, but the `key.startsWith("proxy/")` branching means adding a third asset kind requires bridge edits — a leaky boundary.

F. **`extractDataType` lives in `decodePool.ts` but is consumed by `contentSource.ts`.** Type-of-data information is wire-format metadata, not a decode-pool concern. Cross-cutting helper in the wrong home.

G. **Worker-rejection state (`rejectedKeys`)** is essentially a feedback channel from GPU worker through orchestrator into the cache. Today the cache has to know what "cold-state-rebuild" means (via `clearRejected` cadence) — that's a coupling worth questioning.

H. **No interface for non-WS transport.** `ContentSource` is an interface and `ProxiedContentSource` is the only impl. `cpuCache.test.ts` mocks via the interface; great. But there's no `LocalContentSource` or `DirectContentSource` despite `FetchSource` having `Proxied | Direct | Local` variants on the wire. Today everything goes through the proxy regardless of `FetchSource`. (Verified by code reading; double-check in Pass 4.)

I. **`extractDataType` + `wireFormat` get propagated into the cache entry purely for the orchestrator's `dataType` field on `ReadyChunkDelivery`** — meanwhile the decode worker itself already consumed `dataType` to do normalization. The information loops back through CPU cache for a downstream consumer (uint8→uint16 conversion at GPU upload).

J. **`reset()` and `cancelDataset()` overlap heavily.** Both abort + clear; reset is the "everything" version. Test surface for both is large.

## Next pass

Pass 2 (Boundary Scan) should look at A, B, F, G, H, I in particular — the boundaries between transport / decode / cache / scheduler / telemetry / lifecycle.
