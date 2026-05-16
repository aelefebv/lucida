---
created: 2026-05-16
modified: 2026-05-16
---

# Upload Pipeline

`lucida-web/src/pipeline/upload/` — the CPU → GPU hand-off half of the [[chunk-pipeline]]. A directory of focused modules with `uploader.ts` as a thin coordinator that fans out to collaborators (a delivery tracker, two parallel telemetry systems, a worker-feedback handler, pure cold-state builders, and a three-pass drain/resend/dispatch pipeline). See [[decisions/0034-orchestrator-split-into-pipeline-upload]] for the directory-layout philosophy and the per-module rationale.

The Uploader is the symmetric downstream counterpart to [[cpu-cache]]: the cache owns bytes coming in from the network, the Uploader owns bytes going out to the GPU worker. Both halves of the chunk pipeline share a shape (thin coordinator + sibling files + sub-folders for tight clusters), so the pipeline reads as one consistent system rather than two unrelated styles.

## Why split it out

`orchestrator.ts` was a dual-personality god-object: planning (driven by view state, produces request plans) and upload (driven by tick budget, dispatches bytes to the worker) coexisted in one 2027-line class because both touched [[cpu-cache]] and worker IPC during early development. The two roles share almost no state in practice — `lastEpochs`, `requestEpoch`, and `lastViewEpochByDataset` were the only fields read by both — yet every modification required reasoning across both phases.

The split mirrors the fetch/decode refactor (see [[decisions/0032-cpucache-split-into-pipeline-fetch]]) in shape and cadence: a single overgrown file becomes a coordinator plus a directory of small modules, behaviour-preserving except for explicit named bug fixes. The eleven modules correspond one-to-one with the extractable units the fetch side surfaced — a state tracker, pure builders, telemetry counters, a feedback handler.

## Module layout

The directory's collaborators (each one a focused, separately-testable unit):

- `uploader.ts` — coordinator (~492 LOC). Wires the collaborators in its constructor; each public method (`onPlanRebuildStart`, `sendColdState`, `sendViewHotStateIfAdvanced`, `recordPlanForDataset`, `deliverToWorker`, `handleChunksEvicted`, `handleWantedSetDelta`, `clearMember`, `clearDataset`) is a thin fan-out.
- `index.ts` — barrel re-export. External callers import from `pipeline/upload/` only.
- `constants.ts` — `MAIN_VIEW_UPLOAD_BUDGET_BYTES` (8 MB) plus the two telemetry-tuning families (`COLD_STATE_*` and `UPLOAD_*`).
- `proxyKeys.ts` — three free-function composers (`proxyKeyFromDelivery`, `proxyKeyFromMissing`, `proxyKeyFromRequest`) that build the `${datasetId}|${entityId}|${kind}|${t}|${c}` composite key used to dedupe proxy uploads.
- `uploadClient.ts` — `UploadClient` interface (narrow facet of `RenderClient`: cold/hot state, chunk and proxy dispatch, layer-resource removal, the two worker → main feedback callback fields). Render-side methods stay on the full `RenderClient`.
- `scissor.ts` — pure `computeScissorRect` helper, extracted to land in unit-test territory.
- `coldState/` — pure builders. `build.ts` is the top-level `buildColdState` + `buildColdActiveEntry`; `hotState.ts` is `buildViewHotState`; `roster.ts` is `buildRoster` + `synthesizeWellRosterEntry`; `displayState.ts` is `buildDisplayStateByChannel`; `identity.ts` is the `identityMatrix` factory.
- `delivery/` — the per-tick send pipeline. `tracker.ts` is `DeliveryTracker`; `drain.ts` is `classifyDelivery` + `runDrainPass`; `resend.ts` is `classifyChunkResend` + `classifyProxyResend` + `runChunkResendPass` + `runProxyResendPass`; `dispatch.ts` is `dispatchChunk` + `dispatchProxy`; `manifestIndex.ts` is the per-tick `buildManifestByImage` memo; `feedback.ts` is `WorkerFeedback`.
- `telemetry/` — `upload.ts` is `UploadTelemetry`; `coldState.ts` is `ColdStateTelemetry`; `sustained.ts` is the shared `SustainedCondition` + `ConsecutiveTickDetector` detectors.

## The Uploader's role per tick

The Orchestrator drives one Uploader per render loop and feeds it through five dedicated planner-seam methods:

1. **`onPlanRebuildStart()`** — called once per cold-state rebuild tick. Resets chunk-side delivery tracking; hoisted to once-per-tick so multi-dataset rebuilds don't multi-clear an atlas state that is global per worker.
2. **`sendColdState(...)`** — per dataset on the rebuild path. Builds the cold-state message via the pure builders, posts it to the worker, and snapshots `epochs` for the subsequent `deliverToWorker` call.
3. **`sendViewHotStateIfAdvanced(...)`** — per dataset, conditional on `viewEpoch` advancing. Collects the per-dataset ray hit from the WASM scene and emits a view-only hot-state message; short-circuits if the camera hasn't moved.
4. **`recordPlanForDataset(...)`** — per dataset. Stashes the per-dataset `lastFilteredRequests` / `lastProxyRequests` snapshots that subsequent resend passes consume, and pre-populates the tracker's `wid → entityId` reverse lookup so an eviction report that arrives before any chunk has shipped can still resolve `cpuCache.markRejected`.
5. **`deliverToWorker(ctx, budget, sliceZ)`** — called by `slicePath.ts` / `volumePath.ts`. Drains [[cpu-cache]]'s `ready[]` queue and dispatches to the worker within the byte budget.

## Collaborators

**`DeliveryTracker`** owns the four delivery-lifecycle maps (`deliverySentToWorker`, `deliveryRejectedByWorker`, `widToEntityId`, `proxyDeliveredToWorker`) as one object with explicit method contracts. The lifetime invariants ("clear sent on every cold-state rebuild", "drop rejected on worker eviction") live on the tracker, not on whichever caller happens to remember them.

**`UploadTelemetry`** and **`ColdStateTelemetry`** are two parallel rolling-window systems. The first owns the per-tick events ring, the p50/p95 size sketch, and three sustained-anomaly detectors (`upload.budget_exhausted_sustained`, `upload.resend_storm`, `upload.drain_waste`). The second owns cold-state cache-hit vs rebuild attribution, per-epoch cause counters, and the sustained-non-view-churn detector. Both share the `SustainedCondition` + `ConsecutiveTickDetector` helpers so the two arms detect anomalies the same way.

**`WorkerFeedback`** owns `handleChunksEvicted` (evicted chunks are re-eligible for upload; skipped chunks land on the tracker's rejected set and forward to `cpuCache.markRejected`) and `handleWantedSetDelta` (only the proxy branch is meaningful — chunk entries are intentionally ignored).

**Pure cold-state builders** (`buildColdState`, `buildViewHotState`, `buildRoster`, `buildDisplayStateByChannel`, `synthesizeWellRosterEntry`, `identityMatrix`) are side-effect-free functions that take a planner snapshot and return a wire message. Extracting them gave the cold-state assembly its own test surface and unblocked the `sendColdState` wrapper shrinking to a few lines.

**Drain / resend / dispatch** is a three-pass pipeline. The drain pass iterates `cpuCache.drain(budget)` output and runs `classifyDelivery` (rejects unknown widths, wrong-LOD chunks, etc.). The chunk and proxy resend passes walk `lastFilteredRequests` and `lastProxyRequests` and run their respective classifiers. All three passes share the same `manifestByImage` memo built once per tick by `buildManifestByImage` — the lookup is O(1) per chunk instead of an O(D × I) per-chunk dataset scan. Each pass owns its own counter writes onto the shared `currentUploadStats` and stops dispatching when the byte budget is exhausted.

## Interactions

- **Upstream**: [[planning-domain]] produces the `RequestPlan` and per-dataset request snapshots the Uploader stashes via `recordPlanForDataset`. The Orchestrator (now planner-only) is the call site that feeds them in.
- **Sideways**: [[cpu-cache]]'s drain output is the input to the drain pass; the cache and the Uploader meet in `deliverToWorker`.
- **Downstream**: [[worker-protocol]] is the wire shape. The Uploader consumes the narrow `UploadClient` facet of `RenderClient` (cold/hot state, chunk and proxy dispatch, layer-resource removal, the two feedback callback fields). The render-side methods on `RenderClient` (`volumeRenderMultiPass`, `sliceRenderMultiPass`, `minimap*`, `updateCursorData`, `destroy`) are not part of `UploadClient`. The worker side that consumes those messages is [[gpu-residency]].
- **Worker → main feedback** loops back through `WorkerFeedback` into the `DeliveryTracker`. The Orchestrator owns no upload state — every read or write of `chunkSent` / `chunkRejected` / `proxyDelivered` / `widToEntityId` goes through the tracker.

## Invariants

- **`onPlanRebuildStart()` runs exactly once per cold-state rebuild tick.** The atlas state is global per worker, so the per-dataset loop's `sendColdState` calls must see a single shared reset rather than per-dataset multi-clears. Pairing cold-state emission with tracker reset is an explicit invariant of the Uploader.
- **`lastFilteredRequests` and `lastProxyRequests` are per-dataset Maps.** Both are keyed `Map<datasetId, …>` so the resend pass iterates every dataset's snapshot rather than collapsing to whichever dataset was processed last in the planning loop.
- **`MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB` is a soft cap.** `deliverToWorker` may overshoot by up to one chunk's size before setting `budgetExhausted`, since the byte accounting happens after dispatch. The minimap path uses a separate 2 MB budget (still in `renderLoopTypes.ts`).
- **The slice-vs-volume branch lives only in `dispatchChunk`.** The Uploader reads `viewMode` from `TickContext.mode` and threads it into the dispatch call; the drain and resend passes are mode-agnostic. If you find a second site branching on view mode, it's a leak.
- **Proxy delivery survives cold state, chunk delivery does not.** Worker proxy pools persist across atlas rebuilds (created lazily, destroyed only on dataset removal), so `proxyDelivered` is cleared per-entry by `clearProxyDelivered` on `wantedSetDelta` — never wholesale at rebuild.

## Gotchas

- **The Uploader is constructed before the Orchestrator and passed into it.** If anything reaches `Uploader` before the first plan completes, `lastEpochs` falls back to the zero-default `{ content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 }`. Tests must call `planAndFetch` first; production code never hits this branch because the render loop ordering guarantees a plan before any tick.
- **No `workerWantedSet` filter exists.** `deliverToWorker` does NOT filter against any worker-wanted-set — it filters via `classifyDelivery` on per-tick `targetLevelByImage`. If you see references to a `workerWantedSet` filter in old code, old docs, or your muscle memory, fix them.
- **`getProxyDeliveredKeys()` returns the live `Set` on `DeliveryTracker`.** Used by `uploader.test.ts` for inspection — do not call from production code, and do not mutate the returned set.
- **`recordPlanForDataset` and `sendColdState` happen on the rebuild path; `deliverToWorker` happens every tick.** On cache-hit ticks the per-dataset snapshots are reused and the resend passes do all the work; the drain pass still runs but the deliveries queue is usually empty. If you change the rebuild gating in `Orchestrator.planAndFetch`, expect resend latency.

## Design rationale

See [[decisions/0034-orchestrator-split-into-pipeline-upload]] for why the upload role was hoisted out of `orchestrator.ts` into its own coordinator, and why the directory layout mirrors the [[cpu-cache]] shape.
