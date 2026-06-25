---
created: 2026-05-16
modified: 2026-06-25
---

# Upload Pipeline

`lucida-web/src/pipeline/upload/` — the CPU → GPU hand-off half of the [[chunk-lifecycle]]. A directory of focused modules with `uploader.ts` as a thin coordinator that fans out to collaborators (two parallel telemetry systems, a worker-feedback parser, pure cold-state builders, dispatch helpers, and worker-resource lifecycle tracking). See [[decisions/0034-orchestrator-split-into-pipeline-upload]] for the directory-layout philosophy and the per-module rationale.

The Uploader is the symmetric downstream counterpart to [[cpu-cache]]: the cache owns bytes coming in from the network, the Uploader owns bytes going out to the GPU worker. Both halves of the chunk pipeline share a shape (thin coordinator + sibling files + sub-folders for tight clusters), so the pipeline reads as one consistent system rather than two unrelated styles.

## Why split it out

The upload role used to live in the former `orchestrator.ts` — a dual-personality god-object where planning and upload coexisted in one ~2000-line class because both touched [[cpu-cache]] and worker IPC. The two roles share almost no state, yet every change required reasoning across both phases. The split (see ADR [[decisions/0034-orchestrator-split-into-pipeline-upload]]) mirrors the fetch/decode refactor: one overgrown file becomes a coordinator plus small modules, behaviour-preserving except for named bug fixes. (The current `tickCoordinator.ts` is ~711 lines and owns the planner seam.)

## Module layout

Durable collaborators:

- `uploader.ts` — coordinator. The planner-facing surface is `sendColdState`, `sendViewHotStateIfAdvanced`, `deliverToWorker`; worker-feedback and resource-lifecycle methods are wire-boundary delegations.
- `uploadClient.ts` — `UploadClient`, the narrow facet of `RenderClient` (cold/hot state, tier-labeled chunk dispatch, proxy-fallback dispatch, layer-resource removal, the two feedback callbacks). Render-side methods stay on the full `RenderClient`.
- `coldState/` — pure builders, one concern per file: `buildColdState` (`build.ts`), `buildViewHotState` (`hotState.ts`), `buildDisplayStateByChannel` (`displayState.ts`), `buildRoster` + `synthesizeWellRosterEntry` (`roster.ts`), `identityMatrix` (`identity.ts`).
- `delivery/` — wire-boundary helpers: `dispatch.ts` (the delivery entry point `dispatchChunkDelivery` that `uploader.ts` calls, plus the lower-level `dispatchChunk`/`dispatchProxy` and member-id helpers), `manifestIndex.ts`, `feedback.ts` (delegates to [[cpu-cache]]), `resources.ts` (member-id cleanup tracking).
- `telemetry/` — `UploadTelemetry`, `ColdStateTelemetry`, and the shared `SustainedCondition`/`ConsecutiveTickDetector`.

Plus `constants.ts` (`MAIN_VIEW_UPLOAD_BUDGET_BYTES` = 8 MB; the budget splits in half per tier when both detail and coarse have demand), `proxyKeys.ts`, `scissor.ts` (`computeScissorRect`), `index.ts` (barrel).

## The Uploader's role per tick

The TickCoordinator drives one Uploader per render loop and feeds it through three dedicated planner-seam methods:

1. **`sendColdState(...)`** — per dataset on the rebuild path. Builds the cold-state message via the pure builders, posts it to the worker, and snapshots `epochs` for the subsequent `deliverToWorker` call.
2. **`sendViewHotStateIfAdvanced(...)`** — per dataset, conditional on `viewEpoch` advancing. Collects the per-dataset ray hit from the WASM scene and emits a view-only hot-state message; short-circuits if the camera hasn't moved.
3. **`deliverToWorker(ctx, budget, sliceZ)`** — called by `slicePath.ts` / `volumePath.ts`. Walks `cpuCache.getDeliverable()` in strict priority order, dispatches each chunk with its `detail` or `coarse` residency tier, then calls `cpuCache.markSent(delivery)` only after the dispatch succeeds. Legacy proxy deliveries follow the same loop only when enabled.

## Collaborators

**`UploadTelemetry`** and **`ColdStateTelemetry`** are two parallel rolling-window systems. The first owns the per-tick events ring, the p50/p95 size sketch, and three sustained-anomaly detectors (`upload.budget_exhausted_sustained`, `upload.resend_storm`, `upload.drain_waste`). The second owns cold-state cache-hit vs rebuild attribution, per-epoch cause counters, and the sustained-non-view-churn detector. Both share the `SustainedCondition` + `ConsecutiveTickDetector` helpers so the two arms detect anomalies the same way.

**`WorkerFeedback`** parses worker residency feedback, then delegates state mutation to [[cpu-cache]]. `chunksEvicted.keys` means "clear optimistic chunk sent state; this chunk is re-eligible" (eviction, stale delivery, wrong slice, or metadata/pool miss). `chunksEvicted.skipped` is reserved for true atlas-policy rejection (atlas full + incoming chunk farther than the farthest resident slot) and flows into `RejectionTracker`. `wantedSetDelta` is authoritative for both chunks and proxies: missing chunks call `cpuCache.markChunkMissing(...)`, while missing proxies call `cpuCache.markProxyMissing(...)`.

**Pure cold-state builders** (`buildColdState`, `buildViewHotState`, `buildRoster`, `buildDisplayStateByChannel`, `synthesizeWellRosterEntry`, `identityMatrix`) are side-effect-free functions that take a planner snapshot and return a wire message. Extracting them gave the cold-state assembly its own test surface and unblocked the `sendColdState` wrapper shrinking to a few lines.

**Dispatch** is a single priority loop. `CpuCache.getDeliverable()` owns the filters (`cached`, wanted this rebuild, not sent, not rejected) and ordering. `Uploader.deliverToWorker` owns manifest lookup, tier-aware wire-message construction, telemetry, and the one-item soft budget cap.

## Interactions

- **Upstream**: [[planning-domain]] produces the `RequestPlan`; `TickCoordinator` submits it directly to [[cpu-cache]]. The Uploader no longer stores planner snapshots.
- **Sideways**: [[cpu-cache]]'s `getDeliverable()` output is the input to `deliverToWorker`.
- **Downstream**: [[worker-protocol]] is the wire shape. The Uploader consumes the narrow `UploadClient` facet of `RenderClient` (cold/hot state, tier-labeled chunk dispatch, legacy proxy dispatch, layer-resource removal, the two feedback callback fields). The render-side methods on `RenderClient` (`volumeRenderMultiPass`, `sliceRenderMultiPass`, `minimap*`, `updateCursorData`, `destroy`) are not part of `UploadClient`. The worker side that consumes those messages is [[gpu-residency]].
- **Worker → main feedback** loops back through `WorkerFeedback` into [[cpu-cache]]. The TickCoordinator owns no upload state.

## Invariants

- **`cpuCache.onPlanRebuildStart()` runs exactly once per cold-state rebuild tick.** The atlas state is global per worker, so the per-dataset loop's `sendColdState` calls must see one shared reset rather than per-dataset multi-clears.
- **Planner-facing Uploader surface is three methods.** `recordPlanForDataset` and `onPlanRebuildStart` are gone; request snapshots and sent/rejected state live in [[cpu-cache]].
- **`MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB` is a soft cap.** `deliverToWorker` may overshoot by up to one chunk's size before setting `budgetExhausted`, since the byte accounting happens after dispatch. The minimap path uses a separate 2 MB budget (still in `renderLoopTypes.ts`).
- **The slice-vs-volume branch lives only in `dispatchChunk`.** The Uploader reads `viewMode` from `TickContext.mode` and threads it into the dispatch call. If you find a second site branching on view mode, it's a leak.
- **Chunk sent state clears on cold-state rebuild.** Detail/coarse chunks are part of the current cold-state atlas plan, so a rebuild makes old optimistic sends re-eligible. Legacy proxy sent state survives cold state because proxy pools persist across atlas rebuilds.

## Gotchas

- **The Uploader is constructed before the TickCoordinator and passed into it.** If anything reaches `Uploader` before the first plan completes, `lastEpochs` falls back to the zero-default `{ content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 }`. Tests must call `planAndFetch` first; production code never hits this branch because the render loop ordering guarantees a plan before any tick.
- **No `workerWantedSet` filter exists.** `deliverToWorker` does NOT filter against any worker-wanted-set; deliverability is owned by `CpuCache.getDeliverable()`. If you see references to a `workerWantedSet` filter in old code, old docs, or your muscle memory, fix them.
- **Worker resource tracking is not delivery tracking.** `delivery/resources.ts` exists only so dataset removal and multi-channel transitions can call `removeLayerResources` for stale member IDs. Do not use it to decide whether a chunk or proxy should be sent.
- **`sendColdState` happens on the rebuild path; `deliverToWorker` happens every tick.** On cache-hit ticks the Uploader does not need planner snapshots — it asks `CpuCache` for deliverables directly.
- **`multiChannel` is explicit in cold state.** Do not infer member-id shape from `visibleChannels.length`; multi-channel mode with one visible channel still uses `imageId:chN` residency keys. Tier routing is a second dimension on top of that member key.

## Design rationale

See [[decisions/0034-orchestrator-split-into-pipeline-upload]] for why the upload role was hoisted out of `tickCoordinator.ts` into its own coordinator, and why the directory layout mirrors the [[cpu-cache]] shape.
