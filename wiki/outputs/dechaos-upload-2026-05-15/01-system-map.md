# Pass 1 — System Map: upload (CPU → GPU hand-off) phase

Goal: orient before judging. What lives in the upload side of the chunk pipeline, what flows through it, and where it sits in the wider app.

## Scope

The "upload phase" is the slice between **CpuCache produces decoded deliveries** and **the GPU worker has them in its atlas + descriptor buffer**. It is the `Orchestrator`'s "second hat" — the first being the per-tick planning driver. Concretely:

- `lucida-web/src/pipeline/orchestrator.ts` (2027 LOC) — the entire upload phase lives in this one class. ~750 of those LOC are upload-specific (the rest is plan-driving, epoch caching, debug aggregation).
- `lucida-web/src/renderer/renderClient.ts` (303 LOC) — main-thread → GPU-worker `postMessage` wrapper. Owns the chunk/proxy/cold-state/view-hot-state messages.
- `lucida-web/src/renderLoop.ts:92-110` — wires `client.onChunksEvicted` / `client.onWantedSetDelta` callbacks to `orchestrator.handleChunksEvicted` / `handleWantedSetDelta`.
- `lucida-web/src/slicePath.ts:53` and `lucida-web/src/volumePath.ts:105` — the only callers of `orchestrator.deliverToWorker(...)`.
- `lucida-web/src/renderLoopTypes.ts:42-45` — `MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB`, `RESIDENCY_RENDER_INTERVAL_MS = 33`.
- `lucida-web/src/renderer/workerProtocol.ts` (429 LOC) — typed message envelopes (read by both client and worker; the upload phase touches `coldState`, `viewHotState`, `sliceChunkData`, `volumeChunkData`, `proxyAssetData`, `chunksEvicted`, `wantedSetDelta`).
- `lucida-web/src/pipeline/fetch/types.ts:60-102` — `ReadyDelivery = ReadyChunkDelivery | ReadyProxyDelivery` (the shape that flows out of `cpuCache.drain()` into the upload phase).
- `lucida-web/src/pipeline/orchestrator.test.ts` (1024 LOC) — proxy-delivery tests live here; chunk-delivery, cold-state-delivery, view-hot-state-delivery have **no direct unit tests**.

Total in scope: ~1100 LOC of production code (upload-specific portions of the above). The post-fetch-decode picture has the orchestrator file as the single biggest ball of code.

## Entrypoints (where execution begins)

1. **Construction** — `renderLoop.ts:57` — `private orchestrator = new Orchestrator()`. One per RenderLoop. The constructor wires a `configStore` subscription to invalidate the planning cache on UI knob changes (not directly an upload concern, but it can force a full cold-state rebuild on the next tick).

2. **Steady-state planning + upload prep** — `slicePath.ts:172` / `volumePath.ts:223` — `orchestrator.planAndFetch(ctx, minimapPendingFetch)`. On non-cache-hit ticks this runs the cold-state assembly + dispatch (`sendColdState`), the view-hot-state dispatch (`sendViewHotState`), AND clears `deliverySentToWorker` so the worker's freshly-rebuilt atlases will be re-filled.

3. **Steady-state delivery** — `slicePath.ts:53` / `volumePath.ts:105` — `orchestrator.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, sliceZ?)`. Returns `boolean` (budget exhausted). Drains, lane-filters, sends to worker, runs the resend pass for chunks and proxies, publishes telemetry.

4. **Worker → main thread feedback (eviction)** — `renderLoop.ts:95` — `client.onChunksEvicted = (datasetId, evicted, skipped) => orchestrator.handleChunksEvicted(datasetId, evicted, skipped, this.session.cpuCache)`. Forwards `skipped` keys to `cpuCache.markRejected` (a feedback line that crosses the fetch-phase boundary).

5. **Worker → main thread feedback (wanted-set)** — `renderLoop.ts:104` — `client.onWantedSetDelta = (_epochs, missing) => orchestrator.handleWantedSetDelta(missing)`. Splits the discriminated union: chunks land in `workerWantedSet`, proxy entries clear `proxyDeliveredToWorker` slots (so the next resend pass picks them up).

6. **Lifecycle** — `renderLoop.ts:165-182` removeDataset — calls `orchestrator.clearMemberResources(...)` for the dataset and each member, plus `client.removeLayerResources(...)` to drop GPU resources on the worker side. `getTrackedMemberIds()` is the discovery mechanism.

7. **Multi-channel transitions** — `renderLoop.ts:207-220 handleMultiChannelTransition` — uses `getTrackedMemberIds()` to find member keys whose composite-vs-bare shape no longer matches the active mode, and clears them on both worker and orchestrator.

8. **HITL debug** — `orchestrator.ts:1800 requestTestProxy` — synthesises a single-proxy plan and pushes it through `cpuCache.submit`, relying on the normal subscribe → tick → `deliverToWorker` chain to land it on the worker. Exposed on `window.__lucidaOrch` via `RenderLoop.getOrchestrator`.

## Main workflows

### A. Cold-state assembly + emit (per non-cache-hit tick, per dataset)

`orchestrator.ts:750-768` (call site in `planAndFetch`) → `sendColdState` (lines 1840-1994):

1. Build `entityById` map and per-channel `displayStateByChannel` (contrast/gamma/opacity/colormap/channelMask) from `dsSettings`.
2. For each `ActiveSetEntry` in the plan's active set, narrow on `kind` (well-as-proxy / invisible / field) and emit a `ColdStateActiveEntry` with: levels (Z/Y/X swizzle from TCZYX), promotion mode + proxy availability, parent well id, **precomputed model + inv matrices** (from `matricesByEntity`, sourced either from `synthesizeWellRosterEntry`'s synthetic AABB or `scene.member_model_matrix`), and the shared `displayStateByChannel`.
3. `client.coldState(msg)` → single `postMessage`.
4. Returned to caller so it can derive the deterministic `entityIndex` map (`computeMemberIndexMap`).
5. **Side effect (caller side):** `this.deliverySentToWorker.clear()` immediately after — worker rebuilds atlases, all chunks must be re-uploaded.

`sendViewHotState` (`orchestrator.ts:2004-2025`) — only fires when `viewEpoch` moved since the last emit for this dataset. One ray-pick per dataset (`scene.ray_hit_local_image`), replicated per member id (composite keys included).

### B. `deliverToWorker` per tick (`orchestrator.ts:1359-1515`)

1. Reset `currentUploadStats`; record tickStart.
2. Build `targetLevelByImage` from `_lastFilteredRequests` (the last plan's emitted requests — the "wanted level" map).
3. `ctx.cpuCache.drain(budget)` → `ReadyDelivery[]`. Bin into chunks vs proxies for telemetry.
4. **Drain pass** — for each delivery:
   - **Proxy**: `sendProxyDeliveryToWorker` → `client.proxyAssetData(...)`. Always uploads (no LOD filter for proxies).
   - **Chunk**: filter out `lane === "prefetch"` (cache-only), `lane === "overview"` (minimap path), wrong-LOD (chunk's `level` ≠ `targetLevelByImage[delivery.imageId]`). Survivors → `sendDeliveryToWorker` → `client.sliceChunkData` or `volumeChunkData`.
   - Each successful upload bumps `bytesUploaded`, decrements `remaining`, records into the rolling event window. Break on `remaining <= 0` and set `budgetExhausted=true`.
5. **Chunk resend pass** — iterate `_lastFilteredRequests`, skip prefetch + already-sent + worker-rejected, look up via `cpuCache.getCachedChunk`, send. Stop on `budgetExhausted`.
6. **Proxy resend pass** — iterate `_lastProxyRequests`, skip already-delivered, look up via `cpuCache.getCachedProxy`, send. Stop on `budgetExhausted`.
7. `publishUploadStats(tickStart)` — fold this tick's counters into rolling 1s window, derive p50/p95/ratios, fire any sustained-anomaly logs (3 detectors), publish to `debugStats.upload`.

### C. Chunk dispatch (`orchestrator.ts:1653-1730 sendDeliveryToWorker`)

1. Compute `workerMemberId` (`imageId:chN` for multi-channel, bare `imageId` for single).
2. Walk `ctx.datasets` to find the manifest containing this `imageId` — **O(D × I)** scan per chunk. (`skippedNoMeta++` if not found.)
3. Lookup `imageSpec.multiscale.levels[delivery.level]` — `skippedNoMeta++` if missing.
4. Already-sent guard: `deliverySentToWorker.get(wid).has(chunkKey)` → `skippedAlreadySent++`.
5. Branch on `viewMode === "slice"` vs "volume" → `client.sliceChunkData(...)` or `client.volumeChunkData(...)` with shape/chunk-shape/level/depth args extracted from `levelMeta`.
6. `sentSet.add(chunkKey)`; return bytes.

### D. Proxy dispatch (`orchestrator.ts:1739-1757 sendProxyDeliveryToWorker`)

Forwards to `client.proxyAssetData(datasetId, entityId, imageId, kind, t, c, dims, data, epochs)`. Records `proxyKeyFromDelivery(d)` into `proxyDeliveredToWorker`.

### E. Worker-evicted handling (`orchestrator.ts:1538-1569 handleChunksEvicted`)

- `evicted[]` keys → remove from `deliverySentToWorker[wid]` so resend can re-upload; also remove from `deliveryRejectedByWorker[wid]` (acceptance + later eviction proves they were deliverable).
- `skipped[]` keys → remove from `deliverySentToWorker[wid]` (they were optimistically added by `sendDeliveryToWorker`), add to `deliveryRejectedByWorker[wid]`, AND forward to `cpuCache.markRejected(entityId, key)` to stop re-fetching (uses `widToEntityId` for the lookup).

### F. Worker wanted-set delta (`orchestrator.ts:1583-1604 handleWantedSetDelta`)

- Clears `workerWantedSet`, then re-fills from the missing array.
- Chunks: add to `workerWantedSet[entityId]` set.
- Proxies: clear matching key from `proxyDeliveredToWorker` so the resend pass re-uploads from `getCachedProxy`.

### G. Lifecycle teardown (`orchestrator.ts:1612-1638 clearMemberResources`)

Called from `RenderLoop.removeDataset` per-dataset and per-member. Drops:
- `deliverySentToWorker`, `deliveryRejectedByWorker`, `widToEntityId` entries for this id.
- Best-effort prefix-match drop of `proxyDeliveredToWorker` entries scoped to this dataset.
- `lastViewEpochByDataset` entry (no-op for image-shaped ids).
- `debugStats.planning.byDataset[id]` (no-op for image-shaped ids).
- `_lastPlanByDataset` entry (no-op for image-shaped ids).

### H. Telemetry (3 sustained-anomaly detectors)

`orchestrator.ts:1099-1347` — `recordUploadEvent`, `publishUploadStats`, `maybeLogUploadAnomalies`. Three `debugLog("orch", …)` events:
- `upload.budget_exhausted_sustained` — N consecutive ticks with `budgetExhausted=true` (default N=3).
- `upload.resend_storm` — `resendRatio > 0.5` sustained > 2s.
- `upload.drain_waste` — `filterRatio > 0.5` sustained > 2s. Filter ratio is the **upload-bound** version: `(skippedWrongLod + skippedAlreadySent + skippedNoMeta) / (drainedChunks − skippedPrefetch − skippedOverview)`.

## Modules and external dependencies

| Module | Imports from outside the upload phase |
|---|---|
| `orchestrator.ts` (upload portions) | `pipeline/planning/{index,configStore,snapshot,debug}`, `pipeline/fetch/index` (`CpuCache`, `ReadyChunkDelivery`, `ReadyProxyDelivery`), `pipeline/{epochs,viewport,assetCatalog}`, `renderer/workerProtocol`, `renderer/descriptorBuffer` (`computeMemberIndexMap`, `iterateColdMembers`), `tickCommon` (`getSceneSettings`, `compositeKey`), `manifestTypes`, `axes`, `debug/{debugStats,logging}` |
| `renderer/renderClient.ts` | `renderer/workerProtocol`, `pipeline/epochs` (`SceneEpochs`) |
| `slicePath.ts` / `volumePath.ts` | `pipeline/orchestrator` (`Orchestrator`, `MemberRosterEntry`, `MinimapChunkCoord`), `renderer/workerProtocol` (layer params), `renderLoopTypes` (budget constant), `tickCommon`, `axes`, `debug/debugStats`, `manifestTypes` |
| `renderLoop.ts` | `pipeline/orchestrator` (`Orchestrator`), `renderer/renderClient` (the wired callbacks) |

## Outside callers (everything that touches the upload phase)

| Caller | What it touches |
|---|---|
| `slicePath.uploadAndRenderSlice` | `orchestrator.deliverToWorker(ctx, budget, sliceZ)` |
| `volumePath.uploadAndRenderVolume` | `orchestrator.deliverToWorker(ctx, budget, null)` |
| `renderLoop.start` | `client.onChunksEvicted` → `orchestrator.handleChunksEvicted`; `client.onWantedSetDelta` → `orchestrator.handleWantedSetDelta` |
| `renderLoop.removeDataset` | `orchestrator.clearMemberResources(...)`, `client.removeLayerResources(...)`, `getTrackedMemberIds()` |
| `renderLoop.handleMultiChannelTransition` | `getTrackedMemberIds()`, `clearMemberResources(key)` (for the wrong-shape keys) |
| `renderLoop.collectMemberIds` | `getTrackedMemberIds()` (treats as "members keyed by dataset prefix") |
| `App.tsx` (HITL hook) | `getOrchestrator()` exposes the orchestrator on `window` so devtools can call `requestTestProxy` |
| `orchestrator.test.ts` | Direct `deliverToWorker` + `getProxyDeliveredKeys` exercises (proxy-only) |

External systems touched: the GPU render worker (only via `RenderClient.postMessage`); `performance.now()` for timing; `debugLog` (gated console output).

## Where each "concern" lives today (high-level)

| Concern | Location | Notes |
|---|---|---|
| **Cold state assembly** | `orchestrator.sendColdState` (1840-1994) | Discriminated-union narrowing per-entry; per-channel display-state baking; matrix sourcing |
| **View hot state assembly** | `orchestrator.sendViewHotState` (2004-2025) | One ray-pick per dataset, fanned out to every member id |
| **Well-roster synthesis** | `synthesizeWellRosterEntry` (193-285, free function) | 3D AABB (world-space) + 2D AABB (voxel-space) computed independently; used by both the `planAndFetch` roster build AND `sendColdState`'s matrix lookup |
| **Drain + lane filter** | `orchestrator.deliverToWorker` (1359-1432) | Inline lane/level filters; the helper does already-sent + no-meta |
| **Chunk resend** | `orchestrator.deliverToWorker` (1437-1473) | Iterates `_lastFilteredRequests`; checks `deliverySentToWorker` + `deliveryRejectedByWorker` + `cpuCache.getCachedChunk` |
| **Proxy resend** | `orchestrator.deliverToWorker` (1482-1509) | Iterates `_lastProxyRequests`; checks `proxyDeliveredToWorker` + `cpuCache.getCachedProxy` |
| **Chunk dispatch (slice vs volume branch)** | `sendDeliveryToWorker` (1653-1730) | Manifest scan O(D × I); split by `ctx.mode` |
| **Proxy dispatch** | `sendProxyDeliveryToWorker` (1739-1757) | Single `client.proxyAssetData` |
| **Composite key building** | Three helpers: `proxyKeyFromDelivery`, `proxyKeyFromRequest`, `proxyKeyFromMissing` (1766-1776) | Three shapes input the same string format |
| **Worker-evicted bookkeeping** | `handleChunksEvicted` (1538-1569) | Three sets to update + one cross-phase callback (`cpuCache.markRejected`) |
| **Wanted-set bookkeeping** | `handleWantedSetDelta` (1583-1604) | Splits chunk vs proxy; **`workerWantedSet` is populated but never read** (see Risks) |
| **Multi-channel id reshape** | RenderLoop side; orchestrator just stores whatever `widToEntityId` was last seen | Composite vs bare key distinction lives in the call sites |
| **Lifecycle teardown** | `clearMemberResources` (1612-1638) | Best-effort prefix matching for proxy keys; ambiguous "is this id a dataset or a member?" handling |
| **Telemetry: events + windows** | `recordUploadEvent` (1105-1113), `publishUploadStats` (1120-1235) | Two parallel rolling windows (events vs per-tick aggregates) |
| **Telemetry: anomaly logs** | `maybeLogUploadAnomalies` (1250-1347) | 3 sustained-condition detectors with shared structure but in-line code |
| **Per-tick stat field set** | `currentUploadStats: UploadTickStats` from `debug/debugStats` | 14+ counters; mutated from many call sites in `deliverToWorker` and helpers |
| **Wire transport (chunk)** | `RenderClient.sliceChunkData / volumeChunkData` | Both clone-then-transfer the ArrayBuffer (zero-copy after slice(0)) |
| **Wire transport (proxy)** | `RenderClient.proxyAssetData` | Same clone-then-transfer; hard-codes `dataType: "u16"` |
| **Wire transport (state msgs)** | `RenderClient.coldState / viewHotState` | Plain `postMessage`; no transferList |

## High-risk / confusing areas (to revisit)

A. **`orchestrator.ts` is a dual-personality file.** Plan-driving (epoch caching, snapshot building, plan() invocation, debug aggregation) and upload-driving (cold state, drain, resend, telemetry, worker-feedback handlers, lifecycle) live in one 2027-LOC class. The upload portion alone is ~750 LOC. Same shape as pre-refactor `cpuCache.ts` was, before the fetch/decode split.

B. **`workerWantedSet` is dead state.** Populated by `handleWantedSetDelta` (1586-1596), declared at line 380, **never read anywhere** (verified by grep across `lucida-web/src/`). Yet `CHUNK_PIPELINE.md:230-231` claims the upload pass "Filter[s] to those in `workerWantedSet` (don't waste bandwidth on chunks the worker no longer needs)". Either the doc is stale or the filter regressed silently.

C. **Manifest scan in `sendDeliveryToWorker` is O(D × I) per chunk.** Lines 1664-1670 walk every dataset and every image to find the one containing this `imageId`. With many small-field plates this can dominate; called once per chunk per tick. No memoisation.

D. **Three parallel "did we send this?" trackers** (`deliverySentToWorker`, `deliveryRejectedByWorker`, `proxyDeliveredToWorker`) plus `widToEntityId` for the reverse lookup. Each has its own clear/delete cadence and ambiguous lifetime semantics (which workerMemberId shape is the key — composite, bare, or dataset?).

E. **`clearMemberResources` does best-effort prefix matching** (lines 1622-1625) and explicitly tolerates no-op deletes (1626-1637). The same string id ("workerMemberId") is overloaded across "is this a dataset id, an image id, or an `imageId:chN` composite?". The function defends against the ambiguity rather than resolving it.

F. **`sendColdState` is in the upload class but is invoked from inside `planAndFetch`.** The line `this.deliverySentToWorker.clear()` immediately after (line 773) is the implicit invariant: cold state goes out → worker rebuilds atlases → upload tracking must be reset. The invariant is stated only in a comment.

G. **The helper `synthesizeWellRosterEntry` (193-285) is a free function above the class** but is consumed from inside `planAndFetch` AND influences `sendColdState`'s matrix sourcing. Coupling between roster build (used by render-layer construction) and cold-state build (used by upload + worker descriptor) is implicit, threaded through `matricesByEntity`.

H. **Lane filtering, target-LOD filtering, and "already sent" filtering are checked at three different sites** — drain pass, helper-internal already-sent, resend pass — with three different "skipped" telemetry counters. The drain-pass filters are inline; the helper-internal filter is buried; the resend-pass filters are inline again with their own counter names (`resendChunksAlreadySent`, `resendChunksRejected`, `resendChunksNotCached`).

I. **`handleChunksEvicted` is the only place where `widToEntityId` is consumed** (1563). It's populated in the planning loop (672-675) on every full plan. The lifetime is "between cold-state rebuilds" — not encoded in any type, just by call ordering.

J. **`requestTestProxy` (1800-1836) has nothing to do with the upload phase per se** but lives in the upload class because it submits through CpuCache and relies on the normal drain → upload chain. Its presence in `Orchestrator` is a HITL convenience, not a structural concern.

K. **The CHUNK_PIPELINE.md trace lists "filter to workerWantedSet" and "MAIN_VIEW_UPLOAD_BUDGET_BYTES = 16MB."** Code says **8MB** (`renderLoopTypes.ts:45`) and **no such filter exists**. Doc drift to fold into the wiki update pass at the end.

L. **No direct upload-phase tests for chunk delivery, cold state, or view hot state.** `orchestrator.test.ts` covers planAndFetch (epoch caching, multi-dataset planning, cold-state display state, viewHotState emission cadence) and proxy delivery tracking. Chunk drain → send to worker, the resend pass behaviour, the telemetry anomaly logs, and `handleChunksEvicted` semantics all rely on integration coverage / manual testing today.

## Next pass

Pass 2 (Boundary Scan) should look at A, F, G, H, J in particular — the boundaries between cold-state assembly / drain-and-send / worker-feedback handling / telemetry / lifecycle, and the way the upload phase shares an enclosing class with planning.
