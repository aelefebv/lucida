# Dechaos: upload (CPU → GPU hand-off) phase — summary

Date: 2026-05-15. Scope: the upload-phase portion of `lucida-web/src/pipeline/orchestrator.ts` (~750 of 2027 LOC) plus its main-thread collaborators (`renderer/renderClient.ts`, the upload-related bits of `renderLoop.ts`, the `deliverToWorker` call sites in `slicePath.ts` / `volumePath.ts`, and the typed envelopes in `renderer/workerProtocol.ts`). Mirrors the recently-completed dechaos pass on the fetch/decode subsystem.

## TL;DR

The upload phase is **functionally healthy at the worker boundary** (the worker side is well-tested via `descriptorBuffer.test.ts`, `wantedSet.test.ts`, `residency.test.ts`, etc.) but `orchestrator.ts` is the textbook dual-personality god-object: 2027 LOC, 36 fields, 20 distinct responsibilities split across a planner role and an upload role. The upload portion alone is ~750 LOC. Same shape as `cpuCache.ts` was before its refactor.

The proposed plan is **11 incremental slices** in dependency order, mirroring the fetch refactor's cadence. The orchestrator splits into a thin `Planner` (~400 LOC) and a new `Uploader` module (~250 LOC) backed by a `pipeline/upload/` directory of small focused files. Two real bugs surface naturally and get fixed mid-refactor: a multi-dataset resend bug, and dead-state vs documented-behavior drift around `workerWantedSet`.

## Per-pass outputs

1. [01-system-map.md](01-system-map.md) — what's in scope, who calls in/out, where each concern lives today. Surfaces the `workerWantedSet` dead-state issue and the CHUNK_PIPELINE.md drift (doc says 16 MB budget + worker-wanted filter; code says 8 MB + no filter).
2. [02-boundary-scan.md](02-boundary-scan.md) — 15 candidate seams, ranked by severity. Top three: plan-vs-upload split, delivery tracker (5 maps under one API), telemetry split.
3. [03-responsibility-scan.md](03-responsibility-scan.md) — `orchestrator.ts` owns 20 named responsibilities; `planAndFetch` (462 LOC) and `deliverToWorker` (157 LOC) are the longest methods. Cold-state assembly (155 LOC) and upload telemetry (250 LOC) are also dense. Other files (`workerProtocol.ts`, `slicePath.ts` / `volumePath.ts`) are healthy.
4. [04-dependency-scan.md](04-dependency-scan.md) — `debugStats` global mutated from 34 sites; implicit ordering (`lastEpochs` set→read across methods); 5 trackers with implicit lifetimes; cold-state-clear invariant encoded in code order; hard-coded telemetry constants untestable.
5. [05-contract-scan.md](05-contract-scan.md) — verified: `MissingChunkLite` aliases are vestigial; `_lastFilteredRequests` is last-dataset-wins (real multi-dataset bug); `planningState` not cleared on member removal; `workerWantedSet` is dead state. Plus: `SliceChunk` ≡ `VolumeChunk`, vestigial array shape, `clearMemberResources` shape ambiguity.
6. [06-composability-scan.md](06-composability-scan.md) — extractable units: `buildColdState`, `buildViewHotState`, `buildRoster`, `buildManifestByImage`, `buildDisplayStateByChannel`, `DeliveryTracker`, drain/resend filter classifiers, dispatch helpers, telemetry pipelines, sustained-condition detector. Asset-abstraction-over-chunk-and-proxy explicitly **NOT recommended** (helper bodies are too small to justify).
7. [07-testability-scan.md](07-testability-scan.md) — `orchestrator.test.ts` (20 tests, 1024 LOC) covers planning + cold-state-display-state + viewHotState + proxy delivery, but **chunk delivery has zero direct tests**. Pre-refactor: add ~525 LOC of new tests for chunk delivery, eviction, multi-dataset, lifecycle invariant, plus pure-function unit tests for `synthesizeWellRosterEntry` and `computeScissorRect`.
8. [08-refactor-sequencing.md](08-refactor-sequencing.md) — 11 slices ordered by precondition. Slice 0 = directory scaffold. Slice 1 = ~525 LOC of pre-refactor tests. Slices 3-4 = real bug fixes (drop dead state, fix multi-dataset resend). Slices 5-9 = sub-module extractions. Slice 10 = `Orchestrator` shrinks to planner-only (~400 LOC, was 2027); new `Uploader` class wires the collaborators. Two deferred slices (`UploadClient` interface, devtools move) wait for explicit triggers.

## Two bugs surfaced

1. **Multi-dataset resend under-resends.** `_lastFilteredRequests` and `_lastProxyRequests` are flat fields written per-dataset in the planning loop — only the **last dataset's** requests survive. The chunk/proxy resend pass therefore only resends for the last dataset processed in the rebuild. Other datasets' worker-evicted chunks have to wait for the next full plan cycle. Pass 5 #2 verified by reading the source. Manifests as "second dataset takes longer to recover from a transient eviction storm." Fixed in Slice 4 by converting the fields to per-dataset Maps.

2. **`workerWantedSet` is documented but dead.** CHUNK_PIPELINE.md claims `deliverToWorker` filters drained chunks against the worker's wanted-set ("don't waste bandwidth on chunks the worker no longer needs"). The field exists, gets populated from `wantedSetDelta`, and is **never read** (verified by grep across `lucida-web/src/`). Pass 1 / Pass 5 confirmed. Fixed in Slice 3 by deleting the field + updating the doc — subtractive change. (Could instead implement the filter; recommendation is to delete because there's no production evidence the filter would help.)

A possible third issue: `planningState` is not cleared in `clearMemberResources`, so per-dataset planner state survives dataset removal. May be intentional (preserve hysteresis across removals) or a small leak. Pass 5 verified the absence; Slice 4 fixes by adding `this.planningState.delete(id)`.

## Doc drift to fix

CHUNK_PIPELINE.md sections 5c and 8 contain two factual errors on the upload side:

- Says `MAIN_VIEW_UPLOAD_BUDGET_BYTES = 16 MB`. Code says **8 MB** (`renderLoopTypes.ts:45`).
- Says the upload pass "Filter[s] to those in `workerWantedSet`." Code does **no such filter**.

Both are fixed in Slice 3 alongside the dead-state cleanup. Slice 13 sweeps any remaining wiki articles after the refactor stabilizes.

## Estimated effort

**~12 PR-days for slices 0-10.** Comparable to the fetch refactor (~11 days). Slice 1 is the biggest single piece (~2 PR-days of test writing); worth doing in one focused effort rather than amortizing across structural slices.

Defer slice 11 (`UploadClient` interface) and slice 12 (devtools move) to opportunism.

## Comparison to the fetch refactor

| | Fetch refactor | Upload refactor |
|---|---|---|
| God file size | 1627 LOC | 2027 LOC |
| Number of fields | 35 | 36 |
| Concerns fused | 12 | 20 |
| Existing direct tests | 1427 LOC, 68 cases | 1024 LOC, 20 cases |
| Direct tests for sub-units | 0 | 0 (orchestrator is the only test file) |
| Worker-side test coverage | n/a | Heavy (`descriptorBuffer.test.ts` etc.) |
| Top extraction targets | scheduler, store, eviction, telemetry, retry, rejection, interactionMode | uploader, deliveryTracker, coldState builders, drain/resend, telemetry, sustainedCondition |
| Highest-payoff deferred work | `AssetTransport` over chunk/proxy (medium-risk) | None — chunk/proxy unification explicitly NOT recommended |
| Real bugs fixed mid-refactor | `imageWireFormats` leak, transient/permanent misclassification | `_lastFilteredRequests` last-dataset-wins, `workerWantedSet` dead state |
| Total slices | 11 (with 2 deferred) | 11 (with 2 deferred) |
| Estimated effort | ~11 PR-days | ~12 PR-days |

## Suggested next step

Hand this to `/code` to scope each slice into a PRD or ticket-level work item, OR run `/code` per-slice as the project cadence prefers. The fetch refactor used a "PRD per slice" model with independently-gated validation checks; the same model works here.

The Slice 1 test investment is the single biggest piece. It's worth doing in one focused effort because the tests need to exist before any extraction starts — they are the safety net that lets every later slice land cleanly.
