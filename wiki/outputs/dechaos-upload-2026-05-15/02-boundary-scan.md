# Pass 2 — Boundary Scan: upload (CPU → GPU hand-off) phase

Goal: identify the natural seams where responsibilities should be separated.

## What's mixed today

The upload phase has the following physical layout:

```
pipeline/orchestrator.ts        (2027 LOC) — plan-driver + upload coordinator + cold/upload telemetry + lifecycle + debug aggregator
renderer/renderClient.ts        ( 303 LOC) — postMessage wrapper + onChunksEvicted/onWantedSetDelta callback fields
renderer/workerProtocol.ts      ( 429 LOC) — typed message envelopes (shared with worker)
slicePath.ts / volumePath.ts    ( 194 / 268 LOC) — call deliverToWorker; assemble layer params from roster + entityIndex
renderLoop.ts                   ( 504 LOC) — wires onChunksEvicted/onWantedSetDelta callbacks to orchestrator
renderLoopTypes.ts              (  63 LOC) — MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB lives here
```

`orchestrator.ts` is the dechaos hot zone — it bundles the entire upload coordination AND the per-tick planning driver into one 2027-LOC class. The upload portion alone is ~750 LOC. Same shape as pre-refactor `cpuCache.ts` was, before the fetch/decode split.

## Concerns currently fused inside `Orchestrator`

Numbered for reference in later passes.

1. **Plan-driving + epoch caching** — `planAndFetch` body, `lastEpochs`, `cachedResult`, cause attribution ("which epoch moved").
2. **Cold-state assembly + emit** — `sendColdState` (1840-1994), the discriminated-union narrowing per active-set entry, per-channel display-state baking.
3. **Well roster synthesis** — `synthesizeWellRosterEntry` (193-285, free function above the class), used by both roster build (for slicePath/volumePath) AND cold-state matrix sourcing.
4. **View-hot-state assembly + emit** — `sendViewHotState` (2004-2025).
5. **Per-dataset member roster build** — `planAndFetch:684-744` — produces `MemberRosterEntry[]` for slicePath/volumePath.
6. **Drain + lane/level filter** — `deliverToWorker` body (1359-1432).
7. **Chunk dispatch (slice/volume branch)** — `sendDeliveryToWorker` (1653-1730), with O(D × I) manifest scan.
8. **Proxy dispatch** — `sendProxyDeliveryToWorker` (1739-1757).
9. **Chunk resend pass** — `deliverToWorker:1437-1473`.
10. **Proxy resend pass** — `deliverToWorker:1482-1509`.
11. **Delivery state tracking** — five maps: `deliverySentToWorker`, `deliveryRejectedByWorker`, `widToEntityId`, `proxyDeliveredToWorker`, `workerWantedSet`.
12. **Worker-evicted feedback handling** — `handleChunksEvicted` (1538-1569).
13. **Wanted-set delta handling** — `handleWantedSetDelta` (1583-1604).
14. **Lifecycle teardown** — `clearMemberResources` (1612-1638), `getTrackedMemberIds` (1607-1609).
15. **Cold-state telemetry** — events ring buffer + cause attribution + p50/p95 + churn detector + `publishColdStateDebug` + `coldStateDebug` snapshot.
16. **Upload telemetry** — events ring buffer + tick aggregates + p50/p95 + 3 sustained-anomaly detectors + `publishUploadStats` + `debugStats.upload`.
17. **Debug-orchDebug aggregation** — `planAndFetch:834-947` — scrapes from many state sources into `debugStats.orch`.
18. **HITL test hook** — `requestTestProxy` (1800-1836).
19. **Composite key composition** — three `proxyKeyFromX` helpers (1766-1776).
20. **Config-store subscription lifecycle** — constructor + `dispose` (489-509).

The class also carries cross-cutting fields that don't belong to any single concern: `requestEpoch`, `_lastRequests`, `_lastVisibleRegion`, `_lastEntities`, `_lastCachedKeyCounts`, `_lastFilteredRequests`, `_lastPlanByDataset`, `_lastProxyRequests`, `cachedDebugMemberSnapshot`, `planningState`. Most of these power the upload-side resend pass, the cache-hit short-circuit replay, or the debug panel — all of which could relocate.

## Candidate seams

### Seam A — Plan-driving vs upload-driving (the headline split)

The class is two roles in one container. The plan-driving role (concerns 1, 5, 17, 20) consumes WASM state, runs the planner, and emits a `RequestPlan`. The upload-driving role (concerns 2, 3, 4, 6–14, 16, 19) consumes decoded deliveries and ships them to the GPU worker.

These two roles share state today, but mostly through implicit ordering:
- `sendColdState` is invoked inside `planAndFetch` (line 750), and `deliverySentToWorker.clear()` follows immediately (line 773). The implicit invariant is "every cold-state emit must be paired with a sent-tracking reset" — encoded in code order, not in any signature.
- `lastEpochs` is set at the end of `planAndFetch` (line 950) and read at the top of `deliverToWorker` (line 1369) as a fallback. If `deliverToWorker` ran before any plan, the epochs default to all zeros.
- `_lastFilteredRequests` is written by the planning loop and consumed by both the resend pass (in `deliverToWorker`) AND the `widToEntityId` build (in `planAndFetch`).

Candidate boundary: a `Planner` (planAndFetch + epoch cache + planning state per dataset) and an `Uploader` (cold/view emit + drain + resend + worker feedback + telemetry + tracking). The bridge between them: `Planner.runTick(...)` returns `{ requests, activeSet, proxyRequests, coldStateMsg, viewHotStateMsg | null, memberRoster, entityIndex, epochs }`; `Uploader.applyTick(...)` accepts that bundle, emits messages, and resets tracking on cold-state changes.

This is the largest single tangle in the file.

### Seam B — Cold-state assembly vs emit

`sendColdState` does two things: builds a `ColdStateMessage` (a deterministic pure mapping over `activeSet × entities × matricesByEntity × dsSettings × selection × visibleRegion`) and posts it to the worker.

The build is testable on its own with no mocks; the emit is one line. They're fused today because the build inlines `entityById`, `displayStateByChannel`, and the per-entry narrowing into a single function.

Candidate boundary: a free function `buildColdState(args): ColdStateMessage`, and `Uploader.sendColdState(...)` becomes `client.coldState(buildColdState(...)); deliverySentToWorker.clear();`.

The same pattern applies to `sendViewHotState`: the body is "iterate cold-msg members, replicate one ray hit per member, post." A `buildViewHotState(coldMsg, rayHit, epochs, datasetId): ViewHotStateMessage` plus a one-line emit.

### Seam C — Roster + matrix build (one pass over the same data)

`planAndFetch:684-744` walks the active set twice: once to build `rosterEntries` (consumed by slicePath/volumePath for layer params) and once to build `matricesByEntity` (consumed by `sendColdState` for descriptor matrices). Both passes:
- Special-case `well-as-proxy` via `synthesizeWellRosterEntry`.
- Look up `entityById` for field entries.
- Read `scene.member_model_matrix` / `inv_member_model_matrix` for non-synthesised entries.

The two passes are interleaved but logically one operation: "for each active-set entry, decide its render geometry (position, dataW/dataH, model + inverse matrix)."

Candidate boundary: a pure `buildRoster(activeSet, entities, scene, datasetId): { entries, matricesByEntityId }`. Lives in a sibling module; consumed by `planAndFetch` AND by `buildColdState`.

### Seam D — Drain-and-filter vs send

`deliverToWorker` weaves two concerns: a pure-ish "filter incoming deliveries" loop (lane / target-LOD / already-sent filters with skip-counter side effects) and the actual `client.X` emits.

A pure `filterDeliveries(deliveries, targetByImage, sentByMember, lastSlice): { toSend: ReadyDelivery[], skipsByCause: SkipCounters }` function would be unit-testable without any worker mock. The send loop becomes "for each toSend, call the right client method, increment counters."

Today the same body also contains the resend pass — that's a third concern (Seam E).

### Seam E — Drain pass vs resend pass

`deliverToWorker` runs three distinct loops in sequence:
1. **Drain pass** (1387-1432) — iterate `cpuCache.drain()` output, lane/LOD-filter, send.
2. **Chunk resend pass** (1437-1473) — iterate `_lastFilteredRequests`, lookup via `getCachedChunk`, send.
3. **Proxy resend pass** (1482-1509) — iterate `_lastProxyRequests`, lookup via `getCachedProxy`, send.

Each loop has its own counter set (`drainedChunks`, `uploadedChunks`, `skipped*` vs `resendChunksConsidered`, `resendChunksAlreadySent`, `resendChunksRejected`, `resendChunksNotCached`, `resendChunkUploads` — and equivalents for proxies).

Candidate boundary: `runDrainPass(deliveries, ...) -> Counters`, `runChunkResendPass(requests, ...) -> Counters`, `runProxyResendPass(requests, ...) -> Counters`. The outer loop wires them together with the byte-budget short-circuit.

### Seam F — Delivery tracking (multi-store with implicit lifetimes)

Five separate maps with overlapping but distinct semantics:

| Field | Key | Cleared when | Read by |
|---|---|---|---|
| `deliverySentToWorker` | `workerMemberId → Set<chunkKey>` | every cold-state rebuild (line 773) + per-member in `clearMemberResources` + on worker eviction (`handleChunksEvicted`) | resend pass + `sendDeliveryToWorker` (already-sent guard) |
| `deliveryRejectedByWorker` | `workerMemberId → Set<chunkKey>` | every cold-state rebuild (line 574) + per-member in `clearMemberResources` + on worker eviction (acceptance proves deliverable) | resend pass (skip rejected) |
| `widToEntityId` | `workerMemberId → entityId` | every cold-state rebuild (line 575) + per-member in `clearMemberResources` | `handleChunksEvicted` (one site) |
| `proxyDeliveredToWorker` | `${ds}|${e}|${k}|${t}|${c} → ()` | per-entry on `handleWantedSetDelta` proxy reports + best-effort prefix in `clearMemberResources` | proxy resend pass + `sendProxyDeliveryToWorker` |
| `workerWantedSet` | `entityId → Set<chunkKey>` | every `handleWantedSetDelta` call | **never read** (see Risk K from Pass 1) |

Five maps, four of which are actually read; each with its own clear cadence; key shapes are inconsistent (workerMemberId vs entityId vs composite-string). Candidate boundary: a `DeliveryTracker` module that owns these maps and exposes intent-named operations:

- `markChunkSent(workerMemberId, entityId, chunkKey)` — also writes `widToEntityId`.
- `wasChunkSent(workerMemberId, chunkKey): bool`.
- `wasChunkRejected(workerMemberId, chunkKey): bool`.
- `markChunkEvicted(workerMemberId, evicted, skipped, cpuCache)` — the body of `handleChunksEvicted`.
- `markProxyDelivered(...) / wasProxyDelivered(...) / clearProxyDelivered(missing)`.
- `onColdStateRebuild()` — clears the right things.
- `clearMember(id) / clearAll()`.
- `entityIdFor(workerMemberId): string | null`.

Inside the module, each map can be a typed sub-store or all five can be one `DeliveryState` record — the public API is what matters.

### Seam G — Worker feedback handler

`handleChunksEvicted` and `handleWantedSetDelta` are the orchestrator's "respond to the worker" surface. They're wired in `renderLoop.start` to `client.onChunksEvicted` / `client.onWantedSetDelta`. Today they're public methods on `Orchestrator` because that's where the relevant state lives.

Candidate boundary: a `WorkerFeedback` collaborator that owns the relevant state (the rejection map, the proxy-delivered set, the entity-id reverse lookup) and consumes the upload tracker. The orchestrator (or its replacement Uploader) just delegates.

This naturally pairs with Seam F: `WorkerFeedback` becomes the "writer" side of `DeliveryTracker`.

### Seam H — Cold-state vs upload telemetry (parallel rolling-window systems)

Two telemetry pipelines live side by side in `Orchestrator`:

**Cold-state telemetry** (~150 LOC, 1099+):
- `coldStateEvents[]` ring buffer (1s window).
- `recordColdStateHit / recordColdStateRebuild`.
- `pruneColdStateWindow`.
- `maybeLogColdStateChurn` — sustained-non-view-rebuild detector.
- `publishColdStateDebug`.

**Upload telemetry** (~250 LOC, 1100+):
- `uploadEvents[]` (event ring buffer) + `uploadTickWindow[]` (per-tick aggregate ring buffer).
- `uploadSizeSamples[]` for p50/p95.
- `recordUploadEvent`.
- `publishUploadStats`.
- `maybeLogUploadAnomalies` — three sustained-condition detectors.

These don't share structure — they share **shape**. Both have:
- A constants block at the top of the file (`COLD_STATE_*` and `UPLOAD_*`).
- A ring buffer pruned by `now - WINDOW_MS`.
- A bounded p50/p95 sample buffer.
- A sustained-condition log detector with `since` + `lastLogAt` rate-limiting.

Candidate boundary: pull each into its own module:
- `pipeline/upload/uploadTelemetry.ts` — `UploadTelemetry` class with `recordUpload(now, bytes, isResend)`, `recordTickAggregate(stats)`, `publish(now, debugStats)`.
- `pipeline/upload/coldStateTelemetry.ts` — `ColdStateTelemetry` class with `recordHit(now)`, `recordRebuild(now, causes, durationMs)`, `publish(debugStats)`.

Both internally use a small `SustainedConditionDetector` helper (Seam I).

### Seam I — Sustained-condition detector pattern

Four distinct detectors share the exact same pattern:

| Detector | File location | Threshold | Sustain | Rate limit |
|---|---|---|---|---|
| `cold_state.churn` | `maybeLogColdStateChurn` | non-view rebuilds > 30/sec | 2000ms | 2000ms |
| `upload.budget_exhausted_sustained` | `maybeLogUploadAnomalies` | N consecutive ticks (default 3) | n/a (counter-based) | 2000ms |
| `upload.resend_storm` | `maybeLogUploadAnomalies` | resendRatio > 0.5 | 2000ms | 2000ms |
| `upload.drain_waste` | `maybeLogUploadAnomalies` | filterRatio > 0.5 | 2000ms | 2000ms |

All four:
- Track an `aboveThresholdSince: number | null` (or a consecutive-counter for the budget detector).
- Track a `lastLogAt: number`.
- Reset `aboveThresholdSince` to null when the condition turns false.
- Fire a `debugLog(...)` once sustained-and-rate-limited.

Today the budget detector is the odd one out (counter-based instead of timestamp-based) but the *shape* is identical.

Candidate boundary: a `SustainedCondition({ name, predicate, sustainMs, rateLimitMs, log })` helper with a single `tick(now): void` method. Each call site shrinks from ~30 LOC of bookkeeping to a one-liner `detector.tick(now)` after computing whatever the predicate needs.

### Seam J — `debugStats.orch` aggregation

`planAndFetch:834-947` is 80+ lines of "scrape state from many places into one debug payload." It pulls from:
- `memberRoster` (just-built).
- `planningState` (per-dataset, looped).
- `_lastRequests` (most-recent per dataset, last-wins).
- `_lastVisibleRegion` (last-wins).
- `_lastEntities` (last-wins).
- `_lastCachedKeyCounts`.
- `coldStateDebug` (placeholder, replaced after `recordColdStateRebuild`).

This is debug-only; it's gated on `debugStats.enabled` and runs once per non-cache-hit tick. Candidate boundary: a `publishOrchDebug(state)` private method or a sibling `orchestratorDebug.ts` module.

The "last dataset wins for activeSet — fine for single-dataset debug" comment (line 836) signals an existing bug-acknowledgment that would be easier to address in a dedicated module.

### Seam K — Cold-state lifecycle invariant (encoded in code order)

`planAndFetch` line 750 calls `sendColdState`; line 773 calls `this.deliverySentToWorker.clear()`. Between them, line 757 builds the entity-index map, line 766 conditionally fires `sendViewHotState`. The invariant — "every cold-state emit must reset chunk delivery tracking, because the worker rebuilt its atlases" — is documented in a comment on line 770-772.

If Seam A goes through, this invariant moves into the Uploader: `Uploader.sendColdState(...)` does the clear internally. The implicit ordering becomes an explicit method contract.

Same shape applies to `sendViewHotState`'s requirement that it run *before* the next render message so chunk eviction has the latest ray-pick. Today that's a comment on line 759-763; it should be a contract on the Uploader.

### Seam L — Composite-key helpers

Three `proxyKeyFromX` helpers (1766-1776) each build the same string format from a different shape (`ReadyProxyDelivery`, `ProxyRequest`, `MissingProxyLite`). They're pure functions on the class; could just be free functions in a `proxyKeys.ts` module (or sit on the Seam F `DeliveryTracker`).

### Seam M — HITL test hook

`requestTestProxy` (1800-1836) synthesises a single-proxy plan and pushes it through `cpuCache.submit`. It exists to give the dev console a way to trigger a single proxy upload. It doesn't share state with anything else in the class.

Candidate: move to `pipeline/upload/devtools.ts` (or wherever debug surfaces aggregate). Doesn't need to live on the production class.

### Seam N — `MAIN_VIEW_UPLOAD_BUDGET_BYTES` location

Currently in `renderLoopTypes.ts:45` next to `RESIDENCY_RENDER_INTERVAL_MS`. It's an upload-phase constant; lives in a render-loop file because both `slicePath.ts` and `volumePath.ts` need it and so does `orchestrator.test.ts`.

Candidate: move to a `pipeline/upload/constants.ts` (or similar) once the upload module exists. Minor.

### Seam O — `RenderClient` knows too many message shapes

`RenderClient` is a thin postMessage wrapper but exposes ~15 typed methods, half of which are upload-phase (chunk/proxy/cold/view-hot/remove) and half of which are unrelated (resize, slice/volume/minimap render, cursor data, intensity, destroy).

The `onChunksEvicted` and `onWantedSetDelta` callbacks are *fields*, set externally by `RenderLoop.start`. That's a leaky pattern — any code with a `RenderClient` reference can overwrite them.

Candidate boundary: an `UploadClient` facet that exposes only the upload-phase methods and a typed event subscription (`onChunksEvicted(handler) → unsubscribe`). The render-side methods stay on `RenderClient`. Both wrap the same Worker.

This is real but lower-priority — `RenderClient` is small enough that the mixing isn't painful in practice.

## Visualization: target shape (sketch)

```
pipeline/upload/                     (proposed directory)
  index.ts                           barrel — public surface for renderLoop / paths / tests
  uploader.ts                        thin coordinator: applyTick, sendColdState, deliverToWorker, dispose
  planner.ts                         (or stays in pipeline/orchestrator.ts as a sibling)
                                     planAndFetch, epoch cache, planning state per dataset
  coldState/
    build.ts                         buildColdState (pure); buildViewHotState (pure)
    roster.ts                        buildRoster + synthesizeWellRosterEntry
  delivery/
    drain.ts                         runDrainPass (pure filter + side-effect emit)
    resend.ts                        runChunkResend, runProxyResend
    dispatch.ts                      sendChunkToWorker, sendProxyToWorker (slice/volume branch)
    tracker.ts                       DeliveryTracker (the 5 maps from Seam F, behind a tight API)
    feedback.ts                      handleChunksEvicted, handleWantedSetDelta
  telemetry/
    upload.ts                        UploadTelemetry (Seam H)
    coldState.ts                     ColdStateTelemetry (Seam H)
    sustained.ts                     SustainedConditionDetector (Seam I)
  proxyKeys.ts                       three helpers (Seam L)
  constants.ts                       MAIN_VIEW_UPLOAD_BUDGET_BYTES, UPLOAD_WINDOW_MS, etc. (Seam N)
  devtools.ts                        requestTestProxy (Seam M)
```

This isn't a blueprint — it's a list of candidate boundaries to **stress-test in later passes**, especially the responsibility scan (Pass 3) and the dependency scan (Pass 4). Some seams may collapse or recombine after that work.

## Severity ranking

| Seam | Severity | Why |
|---|---|---|
| A. Plan vs upload split | High | Headline tangle: 2027-LOC dual-personality file. Every other seam below is easier inside a dedicated upload module. |
| F. Delivery tracking (5 maps) | High | Implicit lifetimes; key-shape ambiguity (wid vs entityId vs dataset); one map (`workerWantedSet`) is dead. Bug-prone. |
| H. Telemetry split | Medium-high | Clean lift; mirrors the fetch-side `telemetry.ts` extraction. Two ~150 LOC pipelines. |
| I. Sustained-condition pattern | Medium-high | Four detectors with the same shape; a 30-LOC helper would cut ~80 LOC of bookkeeping and unify behaviour. |
| B. Cold-state assembly vs emit | Medium | Pure-builder extraction; testability win for sendColdState (no mocks needed). |
| D. Drain/filter vs send | Medium | Pure-filter extraction; testability win for `deliverToWorker`. |
| E. Drain vs resend (chunk vs proxy) | Medium | Three loops in one method; counter naming inconsistencies; falls out cleanly once D is done. |
| G. Worker feedback handler | Medium | Natural sibling of F; pulls 50 LOC of "respond to worker" into one module. |
| C. Roster + matrix build | Medium-low | One pass over the same data; small but neat extraction. |
| K. Cold-state lifecycle invariant | Low | Falls out of A. Today it's a comment + code order. |
| J. orchDebug aggregation | Low | Mechanical; debug-only; touch alongside H. |
| L. Composite key helpers | Low | Sweep with F. |
| M. HITL test hook | Low | Move with the rest of the upload module; not blocking anything. |
| N. Constants location | Low | Bikeshed; do during the umbrella move. |
| O. RenderClient facet split | Low | Real but `RenderClient` is small enough to live with. |

## Cross-references to Pass 1 risks

| Pass 1 risk | Addressed by |
|---|---|
| A (dual-personality file) | Seam A |
| B (`workerWantedSet` is dead) | Seam F (delete it during the tracker extraction; CHUNK_PIPELINE.md doc fix at the end) |
| C (O(D × I) manifest scan) | Seam D — pull a `manifestByImage` map out of the tick context once; revisit in Pass 5 (Contract) |
| D (5 parallel trackers) | Seam F |
| E (`clearMemberResources` ambiguity) | Seam F (typed key system removes the prefix-match heuristic) |
| F (`sendColdState` invoked from `planAndFetch`) | Seam A + K |
| G (`synthesizeWellRosterEntry` cross-cuts) | Seam C |
| H (3-site filter scattering + counters) | Seam D + E |
| I (`widToEntityId` lifetime by call ordering) | Seam F (encoded as a method invariant) |
| J (`requestTestProxy` doesn't belong here) | Seam M |
| K (CHUNK_PIPELINE.md drift) | n/a — wiki update pass at the end |
| L (no upload-phase tests for chunk/cold/view) | Seams B, D, E (all yield testable units) — revisit in Pass 7 |

## Next pass

Pass 3 (Responsibility Scan) zooms in on **per-unit cohesion**: are the candidate sub-modules above each really one thing, and within each large method (`planAndFetch`, `deliverToWorker`, `sendColdState`, `sendDeliveryToWorker`) is anything doing too much?
