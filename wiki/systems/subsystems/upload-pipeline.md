---
type: Subsystem
title: "Upload Pipeline"
description: "lucida-web/src/pipeline/upload/ — the CPU → GPU hand-off half of the Flow: Chunk Lifecycle."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/upload-pipeline.md
created: 2026-05-16
modified: 2026-06-25
---

# Upload Pipeline

`lucida-web/src/pipeline/upload/` — the CPU → GPU hand-off half of the [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md). A directory of focused modules with `uploader.ts` as a thin coordinator that fans out to collaborators (two parallel telemetry systems, a worker-feedback parser, pure cold-state builders, dispatch helpers, and worker-resource lifecycle tracking). See [`orchestrator.ts` split into `pipeline/upload/` modules](../../decisions/0034-orchestrator-split-into-pipeline-upload.md) for the directory-layout philosophy and the per-module rationale.

The Uploader is the symmetric downstream counterpart to [CPU Cache](cpu-cache.md): the cache owns bytes coming in from the network, the Uploader owns bytes going out to the GPU worker. Both halves of the chunk pipeline share a shape (thin coordinator + sibling files + sub-folders for tight clusters), so the pipeline reads as one consistent system rather than two unrelated styles.

## Why split it out

The upload role used to live in the former `orchestrator.ts` — a dual-personality god-object where planning and upload coexisted in one ~2000-line class because both touched [CPU Cache](cpu-cache.md) and worker IPC. The two roles share almost no state, yet every change required reasoning across both phases. The split (see ADR [`orchestrator.ts` split into `pipeline/upload/` modules](../../decisions/0034-orchestrator-split-into-pipeline-upload.md)) mirrors the fetch/decode refactor: one overgrown file becomes a coordinator plus small modules, behaviour-preserving except for named bug fixes. (The current `tickCoordinator.ts` is ~711 lines and owns the planner seam.)

## Module layout

Durable collaborators:

- `uploader.ts` — coordinator. The planner-facing surface is `sendColdState`, `sendViewHotStateIfAdvanced`, `deliverToWorker`; worker-feedback and resource-lifecycle methods are wire-boundary delegations.
- `uploadClient.ts` — `UploadClient`, the narrow facet of `RenderClient` (cold/hot state, tier-labeled chunk dispatch, layer-resource removal, and feedback callbacks).
- `coldState/` — pure builders, one concern per file: `buildColdState` (`build.ts`), `buildViewHotState` (`hotState.ts`), `buildDisplayStateByChannel` (`displayState.ts`), `buildRoster` + `synthesizeWellRosterEntry` (`roster.ts`), `identityMatrix` (`identity.ts`).
- `delivery/` — wire-boundary helpers: chunk dispatch/member-id routing, manifest indexing, feedback delegation, and member-resource cleanup tracking.
- `telemetry/` — `UploadTelemetry`, `ColdStateTelemetry`, and the shared `SustainedCondition`/`ConsecutiveTickDetector`.

Plus upload-budget constants, scissor calculation, and the barrel export.

## The Uploader's role per tick

The TickCoordinator drives one Uploader per render loop and feeds it through three dedicated planner-seam methods:

1. **`sendColdState(...)`** — per dataset on the rebuild path. Builds the cold-state message via the pure builders, posts it to the worker, and snapshots `epochs` for the subsequent `deliverToWorker` call.
2. **`sendViewHotStateIfAdvanced(...)`** — per dataset, conditional on `viewEpoch` advancing. Collects the per-dataset ray hit from the WASM scene and emits a view-only hot-state message; short-circuits if the camera hasn't moved.
3. **`deliverToWorker(ctx, budget, sliceZ)`** — reads constant-time detail/coarse demand, then incrementally pulls from `cpuCache.getDeliverable()` until the frame budget is consumed. It never materializes the full ready set. Each dispatched chunk is marked sent only after dispatch succeeds.

## Collaborators

**`UploadTelemetry`** and **`ColdStateTelemetry`** are two parallel rolling-window systems. The first owns the per-tick events ring, the p50/p95 size sketch, and three sustained-anomaly detectors (`upload.budget_exhausted_sustained`, `upload.resend_storm`, `upload.drain_waste`). The second owns cold-state cache-hit vs rebuild attribution, per-epoch cause counters, and the sustained-non-view-churn detector. Both share the `SustainedCondition` + `ConsecutiveTickDetector` helpers so the two arms detect anomalies the same way.

**`WorkerFeedback`** delegates residency feedback to [CPU Cache](cpu-cache.md). Evicted keys clear optimistic sent state and become re-eligible; true atlas-policy rejections enter `RejectionTracker`; wanted-set deltas call `markChunkMissing`.

**Pure cold-state builders** (`buildColdState`, `buildViewHotState`, `buildRoster`, `buildDisplayStateByChannel`, `synthesizeWellRosterEntry`, `identityMatrix`) are side-effect-free functions that take a planner snapshot and return a wire message. Extracting them gave the cold-state assembly its own test surface and unblocked the `sendColdState` wrapper shrinking to a few lines.

**Dispatch** is a single priority loop. `CpuCache.getDeliverable()` owns the filters (`cached`, wanted this rebuild, not sent, not rejected) and ordering. `Uploader.deliverToWorker` owns manifest lookup, tier-aware wire-message construction, telemetry, and the one-item soft budget cap.

## Interactions

- **Upstream**: [Planning Domain](planning-domain.md) produces the `RequestPlan`; `TickCoordinator` submits it directly to [CPU Cache](cpu-cache.md). The Uploader no longer stores planner snapshots.
- **Sideways**: [CPU Cache](cpu-cache.md)'s `getDeliverable()` output is the input to `deliverToWorker`.
- **Downstream**: [Worker Protocol](worker-protocol.md) is the wire shape. The Uploader consumes only the cold/hot-state, tiered-chunk, resource-removal, and feedback facet of `RenderClient`; draw methods remain outside `UploadClient`.
- **Worker → main feedback** loops back through `WorkerFeedback` into [CPU Cache](cpu-cache.md). The TickCoordinator owns no upload state.

## Invariants

- **`cpuCache.publishPlanningCycle()` runs exactly once per cold-state rebuild tick.** The atlas state is global per worker, so delivery/rejection reset and wanted-set replacement happen once for the staged workspace batch rather than once per dataset.
- **Planner-facing Uploader surface is three methods.** `recordPlanForDataset` and `onPlanRebuildStart` are gone; request snapshots and sent/rejected state live in [CPU Cache](cpu-cache.md).
- **`MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB` is a soft cap.** `deliverToWorker` may overshoot by up to one chunk's size before setting `budgetExhausted`, since the byte accounting happens after dispatch. The minimap path uses a separate 2 MB budget (still in `renderLoopTypes.ts`).
- **The slice-vs-volume branch lives only in `dispatchChunk`.** The Uploader reads `viewMode` from `TickContext.mode` and threads it into the dispatch call. If you find a second site branching on view mode, it's a leak.
- **Chunk sent state clears on cold-state rebuild.** Detail/coarse chunks belong to the current atlas plan, so a rebuild makes old optimistic sends re-eligible.

## Gotchas

- **The Uploader is constructed before the TickCoordinator and passed into it.** Tests must plan before delivery; production render-loop ordering guarantees a plan before any tick.
- **No `workerWantedSet` filter exists.** `deliverToWorker` does NOT filter against any worker-wanted-set; deliverability is owned by `CpuCache.getDeliverable()`. If you see references to a `workerWantedSet` filter in old code, old docs, or your muscle memory, fix them.
- **Worker resource tracking is not delivery tracking.** `delivery/resources.ts` exists for layer cleanup; do not use it to decide whether a chunk should be sent.
- **`sendColdState` happens on the rebuild path; `deliverToWorker` happens every tick.** On cache-hit ticks the Uploader does not need planner snapshots — it asks `CpuCache` for deliverables directly.
- **`multiChannel` is explicit in cold state.** Do not infer member-id shape from `visibleChannels.length`; multi-channel mode with one visible channel still uses `imageId:chN` residency keys. Tier routing is a second dimension on top of that member key.

## Design rationale

See [`orchestrator.ts` split into `pipeline/upload/` modules](../../decisions/0034-orchestrator-split-into-pipeline-upload.md) for why the upload role was hoisted out of `tickCoordinator.ts` into its own coordinator, and why the directory layout mirrors the [CPU Cache](cpu-cache.md) shape.
