---
type: Decision
title: "`orchestrator.ts` split into `pipeline/upload/` modules"
description: "lucida-web/src/pipeline/orchestrator.ts (2027 lines, 36 fields, twenty responsibilities split across a planner role and an upload role) is split into a planner-only role (the file that became tickCoordinator.ts, ~711…"
tags: [lucida, decision]
source_path: wiki/decisions/0034-orchestrator-split-into-pipeline-upload.md
created: 2026-05-16
modified: 2026-06-25
---

# `orchestrator.ts` split into `pipeline/upload/` modules

> Note (since): the planner-only `orchestrator.ts` that remains after this split has since been renamed to `pipeline/tickCoordinator.ts`; references to `orchestrator.ts` below describe the file at decision time.

## Decision

`lucida-web/src/pipeline/orchestrator.ts` (2027 lines, 36 fields, twenty responsibilities split across a planner role and an upload role) is split into a planner-only role (the file that became `tickCoordinator.ts`, ~711 LOC as landed) plus a new `Uploader` coordinator (`uploader.ts`, ~311 LOC) backed by a `lucida-web/src/pipeline/upload/` directory of focused modules. The upload responsibilities — ~750 LOC today, fused into the same class as planning — migrate out of `orchestrator.ts` and into the new directory; `Orchestrator` retains the planning role (`planAndFetch` body, `planningState`, `cachedResult`, `lastEpochs`, the configStore subscription, debug snapshots).

The `pipeline/upload/` directory mirrors the shape of `pipeline/fetch/` after [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md): a thin coordinator (`uploader.ts`) plus sibling files for each concern, with sub-folders where related modules cluster tightly (`coldState/`, `delivery/`, `telemetry/`). As landed, the layout is: `index.ts` (barrel), `uploader.ts` (coordinator), `constants.ts`, `proxyKeys.ts`, `uploadClient.ts`; `coldState/` (`build.ts`, `hotState.ts`, `roster.ts`, `displayState.ts`, `identity.ts`); `delivery/` (`dispatch.ts`, `feedback.ts`, `manifestIndex.ts`, `resources.ts`); `telemetry/` (`upload.ts`, `coldState.ts`, `sustained.ts`). The originally-planned `tracker.ts` landed as `resources.ts` (`WorkerResourceTracker`); the drain/resend passes were folded inline into `uploader.ts` rather than becoming `drain.ts`/`resend.ts` modules; the planned top-level `devtools.ts` was not created. Per-module test files land alongside.

## Why this shape

`orchestrator.ts` is a dual-personality god-object: planning (driven by view state, produces request plans) and upload (driven by tick budget, dispatches bytes to the worker) coexist in one class because both touched `cpuCache` and worker IPC during early development. The two roles share almost no state in practice — `lastEpochs`, `requestEpoch`, and `lastViewEpochByDataset` are the only fields read by both. The fused class makes every modification require reasoning across both phases.

The split mirrors [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md) in shape: a single overgrown file becomes a coordinator plus a directory of 50–250 LOC modules, behaviour-preserving except for explicit named bug fixes. The two refactors complete the chunk pipeline's structural cleanup — fetch/decode upstream (CPU bytes in), upload downstream (GPU bytes out) — and adopting the same shape on both halves means the pipeline reads as one consistent system rather than two unrelated styles.

`pipeline/upload/` mirrors `pipeline/fetch/` for the same composability reasons spelled out in 0032: the eight-pass dechaos analysis identified the same kinds of extractable units (a state tracker, pure builders, telemetry counters, a feedback handler) and recommended the same kind of directory-of-small-files destination. The eleven modules below are not an arbitrary count — they correspond one-to-one with the extractable seams Pass 2 ranked and Pass 6 confirmed.

## Why the integration test suite stays monolithic through Slice 9

`orchestrator.test.ts` (1024 LOC, 20 `it()` blocks) is the existing safety net. It covers planning + cold-state + viewHotState + proxy delivery end-to-end. Chunk delivery has zero direct tests today, which is why Slice 1 adds ~525 LOC of characterization tests *to the existing file* before any structural change starts — those tests need to be there at Slice 2 and Slice 5 and Slice 7 alike, and giving them a stable home means not splitting the file in parallel.

Through Slices 2–9 the integration tests stay put while per-module tests get added alongside each extracted module (`tracker.test.ts`, `drain.test.ts`, `displayState.test.ts`, etc.). Splitting `orchestrator.test.ts` into per-module test files mid-refactor would mean deciding which test belongs with which module while the modules are themselves moving — the same cognitive-load argument [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md) used for the cpu-cache split.

The migration happens in Slice 10, after `Uploader` exists: upload-related test blocks (proxy delivery tracking, cold-state display state, viewHotState emission) move from `orchestrator.test.ts` to the appropriate per-module test files (`tracker.test.ts`, `coldState/displayState.test.ts`, `coldState/hotState.test.ts`). Planning-only tests stay on `orchestrator.test.ts`. The end state matches the destination diagram in the sequencing plan.

## Why bug fixes ride along inside slices

Two real bugs were surfaced by the eight-pass dechaos analysis:

1. `_lastFilteredRequests` / `_lastProxyRequests` are flat fields written per-dataset in the planning loop — only the last dataset's requests survive. The resend pass therefore only resends for the last dataset processed in the rebuild (multi-dataset under-resends).
2. `workerWantedSet` is populated from `wantedSetDelta` but never read 

Each fix is a few-line diff once the surrounding structure exists. Pulling them into separate PRs would either land them speculatively (before the structure that makes them obvious) or duplicate the structural work in the bug-fix PR. They land inside the slices that surface them: dead-state removal + doc fix in Slice 3, multi-dataset map conversion in Slice 4 (which also adds the `planningState.delete(id)` lifecycle fix). Same pattern as the two latent bugs ride-alongs in [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md) (`imageWireFormats` leak in Slice 4; transient/permanent misclassification in Slice 8).

## Why `Uploader` is a coordinator, not a class hierarchy

`Uploader` consumes `WorkerResourceTracker` (the landed name for the planned `DeliveryTracker`), `UploadTelemetry`, `ColdStateTelemetry`, the `WorkerFeedback` handler, the upload client, and a `CpuCache` reference. Its body is composition: `sendColdState` is a thin wrapper around `buildColdState` + the client send + tracker bookkeeping; `deliverToWorker` runs the drain + chunk/proxy-resend passes inline (folded into the method via `tryDispatchDelivery`, rather than as separate `runDrainPass`/`runResendPass` helpers). No inheritance, no template methods — just wiring. The previous slices (5–9) extract the collaborators; Slice 10 wires them together. By the time Slice 10 lands, the Uploader is mostly a constructor + a handful of thin delegating methods.

This matches the fetch refactor's Slice 10 (cpuCache as coordinator) in intent: the planner-only file (now `tickCoordinator.ts`) shrinks from 2027 LOC to ~711 LOC; `Uploader` is the new ~311 LOC coordinator. (The original "~400 / ~250" projections undershot the landed sizes — see the LOC note in [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md), where the coordinator likewise did not shrink as far as planned.) Reasoning load drops sharply — each file has one responsibility you can hold in your head.

## Why chunk/proxy unification is NOT pursued here

Pass 6 of the dechaos analysis explicitly recommended **against** an asset-abstraction-over-chunk-and-proxy in the upload phase: the helper bodies (`dispatchChunk`, `dispatchProxy`; the chunk vs proxy classification paths) are ~30 LOC each, and unifying them behind a shared `Asset` interface would add abstraction overhead without reducing duplication. This contrasts with the fetch refactor, where Pass 6 identified chunk/proxy unification as a medium-payoff deferred opportunity (cf. [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md)'s deferred Slice 12). The asymmetry is intentional and matches the spirit of [ContentSource (JS) vs FetchSource (wire)](0006-content-source-vs-fetch-source.md) — two near-identical names for related-but-distinct concerns, where the cost of conflation exceeds the cost of duplication.

## How this decision shows up in code

- `lucida-web/src/pipeline/upload/` — the new directory.
- `lucida-web/src/pipeline/upload/uploader.ts` — the coordinator (~311 LOC as landed).
- `lucida-web/src/pipeline/upload/index.ts` — barrel re-export of the public surface.
- The sub-folders and modules listed under "Why this shape" above (`coldState/`, `delivery/` = dispatch/feedback/manifestIndex/resources, `telemetry/`).
- `lucida-web/src/pipeline/tickCoordinator.ts` (formerly `orchestrator.ts`) — planner-only (~711 LOC, down from 2027).
- `lucida-web/src/pipeline/tickCoordinator.test.ts` (formerly `orchestrator.test.ts`) — planner-only tests; upload-related blocks migrated to per-module test files.
- New per-module test files under `pipeline/upload/` (`coldState/build.test.ts`, `delivery/dispatch.test.ts`, `delivery/manifestIndex.test.ts`, `telemetry/upload.test.ts`, etc.).
- `renderLoop.ts` rewires `client.onChunksEvicted` to `uploader.handleChunksEvicted` directly (was `orchestrator.handleChunksEvicted`).
- `slicePath.ts` / `volumePath.ts` call `uploader.deliverToWorker` (was `orchestrator.deliverToWorker`).

## Related

- [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md) — sister-refactor on the upstream half of the chunk pipeline; shape and cadence mirrored here
- [`planning/index.ts` Split into Per-Concern Files](0029-planning-index-split-into-per-concern-files.md) — earlier directory-of-small-files refactor; original template both this ADR and 0032 mirror
- [ContentSource (JS) vs FetchSource (wire)](0006-content-source-vs-fetch-source.md) — context for the chunk/proxy duplication-vs-unification trade-off (the spirit this refactor honours by NOT unifying)
- [CpuCache as Sole Fetch Path](0008-cpu-cache-as-sole-fetch-path.md) — establishes the fetch-side phase boundaries; upload-side is the symmetric downstream half
- Flow: Chunk Lifecycle — overarching pipeline architecture; will be refreshed in Slice 13 after the refactor stabilizes
- PRD #607 — the work item this ADR was created during
