# Pass 8 — Refactor Sequencing: upload phase

Goal: turn the previous seven passes into an ordered, low-risk plan. What ships first, what waits, where the test investment goes.

## Guiding principles

- **Mirror the fetch refactor's shape.** The fetch refactor moved `cpuCache.ts` from a 1627-LOC god file into a `pipeline/fetch/` directory of 100–500 LOC files (`scheduler.ts`, `eviction.ts`, `chunkStore.ts`, `proxyStore.ts`, `telemetry.ts`, `interactionMode.ts`, `retry.ts`, `rejection.ts`, `wireProtocol.ts`, plus tests per concern). Same shape applies here: `pipeline/upload/` directory.
- **Smallest credible step per slice.** No slice should both rename + change behavior + extract a module. Pick one axis per slice. (This is the rule the fetch refactor followed.)
- **Tests first, then structure.** Pre-write the characterization tests for the gaps Pass 7 identified. They become the safety net for everything after.
- **Defer abstractions until they earn it.** The asset-abstraction-over-chunk-and-proxy was high payoff for `cpuCache` (saved hundreds of LOC of duplication) but lower payoff for the upload phase (helper bodies are smaller, ~30 LOC each). Pass 6 explicitly recommended NOT pursuing this.
- **Keep `orchestrator.test.ts` green at every step.** It's the integration safety net for the planning + upload boundary. New per-module tests live alongside the new modules; the integration tests stay put (and migrate piecemeal at the end).
- **Two real bugs to fix during the refactor:** `_lastFilteredRequests` last-dataset-wins (Pass 5 #2) and `workerWantedSet` dead state vs documented filter (Pass 1 B / Pass 5 #4). Schedule each as its own behavior-change slice with a paired test.

## The shape of the destination

```
lucida-web/src/pipeline/
  upload/                              ← new directory
    index.ts                           barrel — public surface
    uploader.ts                        thin coordinator (~200 LOC)
    constants.ts                       MAIN_VIEW_UPLOAD_BUDGET_BYTES, UPLOAD_*, COLD_STATE_*
    proxyKeys.ts                       three composer helpers
    devtools.ts                        requestTestProxy
    uploadClient.ts                    UploadClient interface (subset of RenderClient)
    coldState/
      build.ts                         buildColdState + buildColdActiveEntry (pure)
      hotState.ts                      buildViewHotState (pure)
      roster.ts                        buildRoster + synthesizeWellRosterEntry
      displayState.ts                  buildDisplayStateByChannel
      identity.ts                      identityMatrix (shared util)
    delivery/
      tracker.ts                       DeliveryTracker (5 maps under one API)
      drain.ts                         classifyDelivery + runDrainPass
      resend.ts                        classifyResend + runChunkResend + runProxyResend
      dispatch.ts                      dispatchChunk + dispatchProxy
      manifestIndex.ts                 buildManifestByImage (per-tick memo)
      feedback.ts                      handleChunksEvicted + handleWantedSetDelta
    telemetry/
      upload.ts                        UploadTelemetry
      coldState.ts                     ColdStateTelemetry
      sustained.ts                     SustainedCondition + ConsecutiveTickDetector
    coldState/build.test.ts            new
    coldState/roster.test.ts           new
    coldState/hotState.test.ts         new
    coldState/displayState.test.ts     new
    delivery/tracker.test.ts           new
    delivery/drain.test.ts             new
    delivery/resend.test.ts            new
    delivery/dispatch.test.ts          new
    delivery/feedback.test.ts          new
    telemetry/upload.test.ts           new
    telemetry/coldState.test.ts        new
    telemetry/sustained.test.ts        new
    proxyKeys.test.ts                  new
    uploader.test.ts                   thin integration tests; replaces upload sections of orchestrator.test.ts
  orchestrator.ts                      (planner only; ~400 LOC, was 2027)
  orchestrator.test.ts                 (planner-only tests; upload sections migrated out)
```

Compare to today: orchestrator.ts at 2027 LOC + orchestrator.test.ts at 1024 LOC. Two giant files become a directory of 15-20 small files of 50–250 LOC each, plus a planner-only orchestrator.

The upload module is similar in shape and scale to `pipeline/fetch/` after Slice 11 of that refactor (one umbrella + sub-folders for tightly-related concerns).

## Slices

Each slice is one PR, one focused diff. Roughly ordered by precondition: items higher in the list unblock items lower.

### Slice 0 — Establish output shape, no behavior change

- Create `lucida-web/src/pipeline/upload/`.
- Add `pipeline/upload/index.ts` barrel that re-exports placeholder symbols (just stubs; no actual code yet).
- Don't move anything yet.

**Risk:** zero (empty module).

**Why first:** establishes the directory contract used by every subsequent slice. Mirrors the early `fetch/` directory creation in the fetch refactor (Slice 0 in `wiki/outputs/dechaos-fetch-decode-2026-05-15/08-refactor-sequencing.md`).

### Slice 1 — Pre-refactor characterization tests

**Tests only, no production change.** ~525 LOC of new tests across:

- `synthesizeWellRosterEntry` — 5 tests on the existing free function (~80 LOC).
- `computeScissorRect` — 5 tests on the existing helper in `volumePath.ts` (~70 LOC).
- `proxyKeyFromX` helpers — 3-test table (~15 LOC).
- Chunk delivery characterization — 10 tests on `deliverToWorker`'s chunk path (~150 LOC):
  - drain happy path → `sliceChunkData` / `volumeChunkData` called with expected args.
  - lane filter (prefetch + overview) → respective counter bumps.
  - wrong-LOD filter → `skippedWrongLod` bumps.
  - already-sent guard → `skippedAlreadySent` bumps.
  - manifest-not-found → `skippedNoMeta` bumps.
  - resend pass: chunk in `_lastFilteredRequests` not in `deliverySentToWorker` → re-uploaded.
  - resend pass: rejected chunk → skipped, `resendChunksRejected` bumps.
  - resend pass: cache miss → `resendChunksNotCached` bumps.
  - budget exhausted: drain stops after one oversize chunk.
  - view mode dispatch (slice → `sliceChunkData`; volume → `volumeChunkData`).
- `handleChunksEvicted` characterization — 5 tests (~80 LOC).
- Multi-dataset characterization — 4 tests (~100 LOC). Pin `_lastFilteredRequests` last-dataset-wins as `it.fails(...)` or as `it.skip(...)` with comment "documents bug; fixed in Slice 5."
- Cold-state lifecycle invariant — 1 test (~30 LOC).

Plus extend `createMockCpuCache` to include `getCachedChunk` (currently missing).

**Risk:** zero (tests only). May surface a small bug; if so, write up as a separate small slice.

**Why second:** safety net for everything after. Pass 7 specifies them.

### Slice 2 — Mechanical placements

Six small, independent moves. Bundle into one slice OR split as PR-cadence dictates.

- **Drop `MissingChunkLite` / `MissingProxyLite` aliases.** Pure rename in `orchestrator.ts:16-17`. Verified no collision.
- **Move `proxyKeyFromX` helpers** from class methods to `pipeline/upload/proxyKeys.ts` as free functions. Update three call sites.
- **Move telemetry constants** (`UPLOAD_*` and `COLD_STATE_*` blocks) to `pipeline/upload/constants.ts`. Update imports.
- **Move `MAIN_VIEW_UPLOAD_BUDGET_BYTES`** from `renderLoopTypes.ts` to `pipeline/upload/constants.ts`. Update three call sites (`slicePath.ts`, `volumePath.ts`, `orchestrator.test.ts`).
- **Tighten `parentWellId?: string | null` to `string | null`** in `ColdStateActiveEntry`. Producer never emits undefined.
- **Extract identity-matrix factory** to `pipeline/upload/coldState/identity.ts`. Update 2-3 call sites (`sendColdState`, `renderLoop` empty-render fallback).

**Risk:** very low (each move is a few-line diff). Slice 1 tests protect.

**Why third:** clears the type/import noise so subsequent extractions are clean diffs.

### Slice 3 — Drop `workerWantedSet` dead state + fix CHUNK_PIPELINE.md

The Pass 1 / Pass 5 risk: `workerWantedSet` is populated but never read. CHUNK_PIPELINE.md claims a filter exists; code doesn't implement it.

**Decision:** delete the field + the chunk branch in `handleWantedSetDelta`, and update CHUNK_PIPELINE.md.

Rationale:
- Subtractive change (less code, no new behavior to verify).
- The filter would change upload semantics — chunks in the drain queue would get filtered against worker-side wanted-set, reducing wasted bandwidth. It's a reasonable feature but no production evidence it's needed.
- If we ever want it, implementing fresh is cleaner than reviving a dead branch.

Changes:
- `orchestrator.ts:380` — delete `workerWantedSet` field.
- `orchestrator.ts:1583-1604 handleWantedSetDelta` — collapse to just the proxy branch:
  ```
  for (const entry of missing) {
    if (entry.kind === "proxy") this.proxyDeliveredToWorker.delete(this.proxyKeyFromMissing(entry));
  }
  ```
- `CHUNK_PIPELINE.md:228-232` — remove the "Filter to those in workerWantedSet" claim. Document the actual behavior: drain → filter by lane/LOD → send.
- `CHUNK_PIPELINE.md:345` — fix `MAIN_VIEW_UPLOAD_BUDGET = 16 MB` → `8 MB` (or move the constant to docs more carefully so it doesn't drift again).

**Risk:** low. One characterization test (Pass 7 #4) pins the proxy branch; the chunk branch was dead.

**Why fourth:** subtractive, unblocks future structural work without dragging dead code into the new module.

### Slice 4 — Multi-dataset fix: convert `_lastFilteredRequests` / `_lastProxyRequests` to per-dataset

The Pass 5 #2 verified bug: these fields are flat, set per-dataset in the planning loop, last-dataset-wins. The resend pass therefore only resends the most recent dataset.

Changes:
- Field types: `_lastFilteredRequests: Map<string, ChunkRequest[]>`, `_lastProxyRequests: Map<string, ProxyRequest[]>`.
- Producer (planAndFetch:659, 666): `this._lastProxyRequests.set(dsId, result.proxyRequests); this._lastFilteredRequests.set(dsId, result.requests);`.
- Consumer (deliverToWorker resend passes): iterate `for (const requests of this._lastFilteredRequests.values()) for (const req of requests) { ... }`.
- Consumer (`targetLevelByImage` build, line 1374): merge across all datasets.
- `clearMemberResources(dsId)` deletes from both maps.
- Same fix for the debug snapshot fields (`_lastEntities`, `_lastVisibleRegion`, `_lastCachedKeyCounts`) — convert to per-dataset maps. Update the debug aggregator to iterate all datasets.

Plus while in the area: **add `this.planningState.delete(id)` to `clearMemberResources`** (Pass 5 verified leak).

**Risk:** medium. Behaviour change (multi-dataset resend now actually works). Slice 1 tests pin both before and after.

The `it.fails(...)` test from Slice 1 flips to `it(...)` here.

**Why fifth:** real bug fix; clears semantic debt before structural extraction. Doing it after Slice 5+ would mean each extracted module has to handle the bug differently, which is harder.

### Slice 5 — Extract `DeliveryTracker` (Seam F)

`pipeline/upload/delivery/tracker.ts`:

```ts
class DeliveryTracker {
  // Chunk side
  markChunkSent(workerMemberId, entityId, chunkKey): void;     // also writes widToEntityId
  wasChunkSent(workerMemberId, chunkKey): boolean;
  markChunkEvicted(workerMemberId, evicted: string[], skipped: string[]): { rejectedNew: Array<{entityId, chunkKey}> };
  wasChunkRejected(workerMemberId, chunkKey): boolean;
  entityIdFor(workerMemberId): string | null;

  // Proxy side
  markProxyDelivered(key: string): void;
  wasProxyDelivered(key: string): boolean;
  clearProxyDelivered(missing: MissingProxy): void;

  // Lifecycle
  onColdStateRebuild(): void;     // clears delivery + rejection maps + widToEntityId
  clearMember(workerMemberId): void;
  clearDataset(datasetId): void;  // best-effort prefix delete on proxy keys
  trackedKeys(): IterableIterator<string>;
}
```

Initially the tracker is a private collaborator on `Orchestrator`; methods that touched the 5 maps directly now go through it. The `Orchestrator.handleChunksEvicted` body becomes:

```ts
const { rejectedNew } = this.deliveryTracker.markChunkEvicted(workerMemberId, evicted, skipped);
for (const { entityId, chunkKey } of rejectedNew) cpuCache.markRejected(entityId, chunkKey);
```

Cleaner cross-phase contract.

**Risk:** medium. Five maps' worth of state migration; existing tests cover the proxy side (5 tests in `proxy delivery tracking`); chunk side is now covered by the Slice 1 characterization tests.

**Why sixth:** typed key system unblocks the rename of `workerMemberId` and the `clearMemberResources` simplification. Other extractions depend on the tracker being a real type.

### Slice 6 — Extract pure cold-state builders

Separate slices, can bundle:

#### 6a — `buildDisplayStateByChannel`
- `pipeline/upload/coldState/displayState.ts` — pure function; ~15 LOC.
- Tests: 4 cases (single visible channel + override, multi-channel + per-channel overrides, missing dsSettings → defaults, empty visibleChannels).

#### 6b — `synthesizeWellRosterEntry` move
- Move from `orchestrator.ts:193-285` (free function) to `pipeline/upload/coldState/roster.ts`.
- Tests already exist (Slice 1).

#### 6c — `buildRoster` extraction
- `pipeline/upload/coldState/roster.ts` — combined roster + matrices builder.
- Replaces the `planAndFetch:684-744` loop.
- Tests: 5 cases (Pass 7 specs).

#### 6d — `buildColdActiveEntry` + `buildColdState` extraction
- `pipeline/upload/coldState/build.ts` — collapses the three near-duplicate variant literals into one function with branching.
- `buildColdState` is the end-to-end pure builder.
- `Orchestrator.sendColdState` becomes:
  ```ts
  const msg = buildColdState({ datasetId, activeSet, entities, ... });
  ctx.client.coldState(msg);
  this.deliveryTracker.onColdStateRebuild();   // invariant becomes explicit (see Slice 5)
  return msg;
  ```
- Tests: 6 cases (Pass 7 specs).

#### 6e — `buildViewHotState` extraction
- `pipeline/upload/coldState/hotState.ts` — pure builder; replaces `sendViewHotState:2010-2024`.
- Tests: 3 cases.

#### 6f — `computeScissorRect` move
- Move from `volumePath.ts:16-65` to `pipeline/upload/coldState/scissor.ts` (or wherever the geometry helpers want to live — could be a sibling not under coldState/).
- Tests already exist (Slice 1).

**Risk:** low (each is a pure-function extraction with characterization tests in place).

**Why seventh:** these are the easy mock-free wins. Each shrinks `orchestrator.ts` and adds focused tests.

### Slice 7 — Extract drain + resend + dispatch + manifest index (Seams D + E + the manifest scan fix)

Four sub-extractions, can bundle:

#### 7a — `buildManifestByImage`
- `pipeline/upload/delivery/manifestIndex.ts` — pure function, built once per `deliverToWorker` call.
- Eliminates the O(D × I) manifest scan in `sendDeliveryToWorker:1664-1670`.
- Tests: 3 cases.

#### 7b — `dispatchChunk` + `dispatchProxy`
- `pipeline/upload/delivery/dispatch.ts` — wraps `client.sliceChunkData` / `client.volumeChunkData` / `client.proxyAssetData` with structured args.
- Could live as methods on `UploadClient` (Slice 9) or as free functions taking the client.
- Tests: 3 cases per function.

#### 7c — `classifyDelivery` (FilterVerdict)
- `pipeline/upload/delivery/drain.ts` — pure function returning `{ action: "send" | "skip", reason? }`.
- The drain pass loop becomes "for each delivery, classify, then dispatch + count."
- Tests: table-driven, 6+ cases.

#### 7d — `classifyResend` (ResendVerdict)
- Same module — pure function for the resend pass.
- Two variants: `classifyChunkResend(req, ...)` and `classifyProxyResend(req, ...)`.
- Tests: table-driven.

#### 7e — `runDrainPass` + `runChunkResendPass` + `runProxyResendPass`
- `pipeline/upload/delivery/drain.ts` and `pipeline/upload/delivery/resend.ts` — encapsulate the loops, return counter aggregates.
- `Orchestrator.deliverToWorker` shrinks to ~30 LOC of composition.

**Risk:** medium-high. The body of `deliverToWorker` is the most-trafficked production code path. Slice 1 tests are the safety net.

**Why eighth:** with the tracker (Slice 5) and the cold-state builders (Slice 6) extracted, the drain/resend extraction has clean dependencies.

### Slice 8 — Extract worker-feedback handler (Seam G)

`pipeline/upload/delivery/feedback.ts` — consolidates `handleChunksEvicted` and `handleWantedSetDelta` (the latter was simplified in Slice 3 to just the proxy branch). Owns its dependencies (DeliveryTracker, CpuCache reference).

The orchestrator's surface methods become thin delegations:
```ts
handleChunksEvicted(workerMemberId, evicted, skipped, cpuCache) {
  this.feedback.handleChunksEvicted(workerMemberId, evicted, skipped, cpuCache);
}
handleWantedSetDelta(missing) { this.feedback.handleWantedSetDelta(missing); }
```

Or — better — consider whether `handleChunksEvicted`'s `cpuCache` parameter can drop. The orchestrator owns no cpuCache reference today (it gets one through `ctx.cpuCache` in tick methods); after Seam A (Slice 10) the Uploader could hold its own.

**Risk:** low (small extraction; characterization tests in place).

### Slice 9 — Extract telemetry modules (Seam H)

Three sub-extractions, can bundle:

#### 9a — `SustainedCondition` + `ConsecutiveTickDetector` helpers
- `pipeline/upload/telemetry/sustained.ts` — small pure helpers (Pass 6 spec).
- Tests: 4 cases per helper.

#### 9b — `UploadTelemetry`
- `pipeline/upload/telemetry/upload.ts` — `class UploadTelemetry` with `recordEvent / recordTickStats / publishTo`.
- Internally uses the `SustainedCondition` helper for the 3 anomaly detectors (`upload.budget_exhausted_sustained`, `upload.resend_storm`, `upload.drain_waste`).
- Tests: ~10 cases (Pass 7 specs).

#### 9c — `ColdStateTelemetry`
- `pipeline/upload/telemetry/coldState.ts` — `class ColdStateTelemetry` with `recordHit / recordRebuild / publishTo`.
- Internally uses `SustainedCondition` for `cold_state.churn`.
- Tests: ~6 cases.

`Orchestrator` constructs both at construction; calls `record*` verbs at the right sites.

**Risk:** medium. Lots of mutation sites to update. Tests are good but counter scatter is exactly what makes verification tedious. Same shape as the fetch refactor's Slice 4 (TelemetryCounters extraction).

**Why ninth:** telemetry is observability; bugs here are visible in the panel but don't break user-visible features. Lower urgency than chunk delivery, so can land later. Unblocks the final Uploader extraction.

### Slice 10 — Extract `Uploader` (Seam A — the big split)

After Slices 5-9, `Orchestrator` has shed most of its upload responsibilities. The remaining upload state on the class is just: `lastEpochs` (shared with planner), `requestEpoch`, `lastViewEpochByDataset`. The upload-method bodies are now thin delegations.

This slice:
- Create `pipeline/upload/uploader.ts` — `class Uploader` consuming `DeliveryTracker`, `UploadTelemetry`, `ColdStateTelemetry`, `WorkerFeedback`, `UploadClient`, `CpuCache`.
- Move the upload-method bodies into `Uploader`:
  - `sendColdState` (now thin wrapper around `buildColdState` + `client.coldState` + `tracker.onColdStateRebuild`)
  - `sendViewHotState` (thin wrapper)
  - `deliverToWorker` (composition of `runDrainPass`, `runChunkResendPass`, `runProxyResendPass`)
  - `handleChunksEvicted` / `handleWantedSetDelta` (delegate to feedback)
  - `clearMemberResources` (split into `clearMember` and `clearDataset`)
  - `getTrackedMemberIds` → `tracker.trackedKeys()`
  - `dispose` (own subscriptions, telemetry teardown)
- `Orchestrator.planAndFetch` calls `this.uploader.applyTick(bundle)` after `plan()` returns. The bundle includes everything the Uploader needs.
- `Orchestrator` keeps the planner role: `planAndFetch` body, `planningState`, `cachedResult`, `lastEpochs`, the configStore subscription, `_lastPlanByDataset` (debug), `cachedDebugMemberSnapshot`.
- `RenderLoop.start` wires `client.onChunksEvicted` → `uploader.handleChunksEvicted` directly. (Today it goes through `orchestrator.handleChunksEvicted`.)
- `slicePath.ts` / `volumePath.ts` call `uploader.deliverToWorker(ctx, budget, sliceZ)` directly. (Today they call `orchestrator.deliverToWorker`.)

`Orchestrator` final size estimate: ~400 LOC (down from 2027). `Uploader` final size estimate: ~250 LOC.

**Risk:** medium. Public surface changes (callers must switch from `orchestrator.X` to `uploader.X`). Tests need to be re-routed: keep the planning-side tests on `orchestrator.test.ts`; migrate the upload-side tests (proxy delivery tracking, cold-state display state, viewHotState emission) into the new per-module tests where they belong.

**Why last (in core slices):** every previous slice de-risked this one. The Uploader becomes a wiring class composed of well-tested collaborators.

### Slice 11 (optional) — `UploadClient` interface (Seam O)

`pipeline/upload/uploadClient.ts`:

```ts
interface UploadClient {
  coldState(msg: ColdStateMessage): void;
  viewHotState(msg: ViewHotStateMessage): void;
  sliceChunkData(...): void;
  volumeChunkData(...): void;
  proxyAssetData(...): void;
  removeLayerResources(datasetId: string): void;
  onChunksEvicted(handler: ChunksEvictedHandler | null): void;     // event-based, not field assignment
  onWantedSetDelta(handler: WantedSetHandler | null): void;
}
```

`RenderClient implements UploadClient`. `RenderLoop` consumes via the interface for the upload-side wiring; the render-side wiring stays on `RenderClient`.

Optionally: collapse `SliceChunk` and `VolumeChunk` (structurally identical types) into a single `Chunk` type. Drop the array shape (`chunks: Chunk[]`) in favor of `chunk: Chunk` since the orchestrator only ever sends one — OR — adapt the dispatch to actually batch (Pass 5 #2-arrays).

**Risk:** low. Type-only change with backward-compat impl.

**Why optional:** real win for testability but not blocking the structural refactor.

### Slice 12 (deferred) — `requestTestProxy` move (Seam M)

Move `Orchestrator.requestTestProxy` to `pipeline/upload/devtools.ts`. App.tsx exposes the devtools module on `window` instead of the whole orchestrator.

**Risk:** very low. Mechanical move.

**Why optional:** dev console only; no functional impact.

### Slice 13 (deferred) — Wiki & doc alignment

After Slices 0-10:
- Update CHUNK_PIPELINE.md sections 5 (CPU → GPU hand-off), 6 (GPU residency), 8 (prioritization summary), 9 (one-paragraph summary), 10 (key constants), 11 (key file map) to reflect the new module structure.
- Add new wiki articles or update existing:
  - `wiki/systems/subsystems/upload-pipeline.md` — new article on the upload module.
  - `wiki/systems/subsystems/chunk-pipeline.md` — link to the new article.
  - `wiki/decisions/` — ADR for "split orchestrator into Planner + Uploader" (mirrors the cpuCache split ADR if one exists).

**Risk:** none.

**Why deferred:** wiki updates lag code by design; do once in a single sweep after the refactor stabilizes.

## Estimated effort

Generous estimates per slice, in PR-day units:

| Slice | Estimate | Notes |
|---|---|---|
| 0 — directory scaffold | 0.25 | Empty barrel only |
| 1 — pre-refactor characterization tests | 2.0 | Largest test investment |
| 2 — mechanical placements | 0.5 | Bundleable |
| 3 — drop `workerWantedSet` + doc fix | 0.25 | Subtractive |
| 4 — multi-dataset bug fix | 1.0 | Real behavior change; tests in place |
| 5 — DeliveryTracker | 1.5 | State-migration risk |
| 6 — pure cold-state builders | 1.5 | Six sub-extractions; each small |
| 7 — drain/resend/dispatch/manifest | 2.0 | Most-trafficked code path |
| 8 — worker-feedback handler | 0.5 | Small wrap |
| 9 — telemetry modules | 1.5 | Counter scatter is tedious |
| 10 — Uploader extraction | 1.5 | Wiring class; thin if previous slices went clean |
| 11 — UploadClient interface (optional) | 0.5 | Type change |
| 12, 13 — deferred | — | |

**Total core slices (0-10): ~12 PR-days.** Comparable to the fetch refactor cadence (~11 days).

## Categorized actions

### Clarify
- Drop `MissingChunkLite` / `MissingProxyLite` aliases (Slice 2).
- Tighten `parentWellId?: string | null` → `string | null` (Slice 2).
- Rename `_lastFilteredRequests` → `lastRequestsByDataset` (during Slice 4).
- Rename `_lastProxyRequests` → `lastProxyRequestsByDataset` (during Slice 4).
- Rename `widToEntityId` → `entityIdByMember` (during Slice 5, when the typed memberId arrives).
- Document the cold-state lifecycle invariant in `Uploader.sendColdState` JSDoc (Slice 6d).
- Document the soft-byte-budget overshoot behavior in `deliverToWorker` JSDoc (Slice 7).

### Protect
- Pre-refactor tests for chunk delivery, eviction, multi-dataset, lifecycle (Slice 1).
- Keep `orchestrator.test.ts` integration-green throughout.
- Per-module tests added with each extraction (Slices 5-10).
- Migrate upload-related orchestrator tests to per-module tests at the end of Slice 10.

### Separate
- Move telemetry constants + budget constant (Slice 2).
- Move `proxyKeyFromX` helpers (Slice 2).
- Extract `DeliveryTracker` (Slice 5).
- Extract pure cold-state builders (Slice 6).
- Extract drain/resend/dispatch (Slice 7).
- Extract worker-feedback handler (Slice 8).
- Extract telemetry modules (Slice 9).
- Extract `Uploader` (Slice 10).

### Stabilize
- Type the `workerMemberId` (branded type or typed key system) inside `DeliveryTracker` (Slice 5).
- `UploadClient` interface (Slice 11).
- Eventually: `Asset` abstraction over chunk/proxy — **NOT recommended** (Pass 6 explicit defer).

### Fix (real behavior changes)
- Drop `workerWantedSet` dead state (Slice 3).
- Multi-dataset resend bug (`_lastFilteredRequests` last-dataset-wins) (Slice 4).
- `planningState` not cleared on member removal (Slice 4 add-on).

## Risk concentrations

| Risk | Mitigation |
|---|---|
| Multi-dataset bug fix (Slice 4) regresses single-dataset behavior | Slice 1 covers single-dataset cases; Slice 4 adds the multi-dataset case |
| `DeliveryTracker` migration loses parity for edge-case key shapes | Slice 5 keeps the `clearMemberResources` characterization test from Slice 1 |
| `buildColdState` extraction silently changes a per-variant default | Slice 6d's tests cover all three variants explicitly (post-extraction); Slice 1 didn't characterize the well-as-proxy / invisible variants — a small gap. **Add those characterization cases inside Slice 6d before extracting.** |
| `runDrainPass` extraction changes counter semantics | Slice 7's tests are structured to count each skip cause explicitly |
| Telemetry extraction loses anomaly-log parity | Slice 9 includes `SustainedCondition` tests covering each detector |
| Uploader extraction breaks the `client.onChunksEvicted` wiring | Slice 10 adds a `RenderLoop.start` integration test if not already there |
| `cpuCache.markRejected` ordering with the rebuild clear | Slice 5 (DeliveryTracker) preserves the existing `markChunkEvicted → returns rejectedNew → orchestrator forwards to cpuCache` flow; no new ordering |
| `deliverySentToWorker.clear()` once vs per-dataset | Slice 4 makes it once-per-rebuild; Slice 1 has the lifecycle invariant test |
| `workerWantedSet` removal misses an undiscovered consumer | Pass 4 grep confirmed no consumer; Slice 1 tests would catch any reliance |

## What this is NOT

- **Not just a behavior change.** Slices 3 + 4 are real bug fixes. Both are documented with characterization tests so the refactor catches them. The rest are pure structural.
- **Not a perf optimization.** The shape is preserved. Slice 7's `buildManifestByImage` memo is the only perf-shaped change (eliminates the O(D × I) per-chunk scan). Quantitatively small but architecturally clean.
- **Not an extension of the public API.** `Orchestrator.X` callers will rewire to `Uploader.X` after Slice 10, but the underlying behavior is identical.
- **Not premature interface introduction.** `UploadClient` (Slice 11) is optional and only introduced when there's a real consumer benefit (testability). The asset-abstraction-over-chunk-and-proxy is explicitly NOT pursued (Pass 6 recommendation).

## Suggested next step

Hand this output to `/code` to convert each slice into a PRD or ticket-level work item.

The fetch refactor's PR sequence (visible in `git log`: `refactor(fetch): Slice 9 — extract RejectionTracker (#603)`, `refactor(fetch): Slice 10 — cpuCache.ts becomes thin coordinator (#604)`, etc.) used a "PRD per slice" model. Same model applies here — each slice is a self-contained PR with its own characterization tests and a clean diff.

The Slice 1 test investment is the biggest single piece (~2 PR-days of test writing). It's worth doing in one focused effort rather than amortizing across the structural slices, because the tests need to exist before any extraction starts.
