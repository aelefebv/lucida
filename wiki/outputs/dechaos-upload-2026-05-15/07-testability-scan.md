# Pass 7 — Testability Scan: upload phase

Goal: determine where current behavior is protected by tests, what gaps exist, and what tests should land before structural changes.

## Existing test surface

### Main-thread side

| File | LOC | Coverage style |
|---|---|---|
| `pipeline/orchestrator.test.ts` | 1024 | Integration-style with hand-built mocks for CpuCache, WasmScene, RenderClient |
| `pipeline/orchestrator.upload.test.ts` | — | **does not exist** |
| `slicePath.test.ts` / `volumePath.test.ts` | — | **do not exist** |

### Worker-side (upload-phase consumers)

| File | LOC | Coverage |
|---|---|---|
| `renderer/descriptorBuffer.test.ts` | 30,516 | Heavy — covers `computeMemberIndexMap`, `iterateColdMembers`, descriptor buffer build |
| `renderer/wantedSet.test.ts` | 23,569 | Heavy — wanted-set delta computation |
| `renderer/residency.test.ts` | 12,151 | GPU residency rules |
| `renderer/proxyAtlas.test.ts` | 9,327 | Proxy pool slot management |
| `renderer/proxyShaderBinding.test.ts` | 5,296 | Shader binding for proxies |
| `renderer/epochCheck.test.ts` | 2,167 | The `isStaleDelivery` predicate |
| `renderer/dataTypeUtil.test.ts` | 913 | u8/u16 normalization helpers |

The worker side of the boundary is well-protected. The main-thread (orchestrator) side has partial coverage with significant gaps.

### `orchestrator.test.ts` describe-block inventory

```
1. epoch caching                  — 5 tests   (planAndFetch cache hit/rebuild)
2. multi-dataset planning         — 3 tests   (per-dataset PlanningState)
3. proxy delivery tracking        — 5 tests   (deliverToWorker proxy path,
                                                proxyDeliveredToWorker semantics,
                                                handleWantedSetDelta proxy branch)
4. cold-state display state       — 3 tests   (per-channel display state in cold msg)
5. viewHotState emission          — 4 tests   (when viewHotState fires/doesn't)
                                  Total: 20 tests
```

**The chunk delivery side has zero direct tests.** Specifically uncovered:
- The drain pass for chunks (lane filter, target-LOD filter).
- The `sendDeliveryToWorker` slice/volume branch.
- The chunk resend pass.
- `handleChunksEvicted` behavior (full eviction + skipped → markRejected dispatch).
- The `workerWantedSet` chunk branch (which is dead anyway — see Pass 5).
- Telemetry: cold-state churn detector.
- Telemetry: upload anomaly detectors (3).
- Telemetry: rolling windows / p50/p95 / event accumulation.
- Multi-dataset behavior (`_lastFilteredRequests` last-dataset-wins; `deliverySentToWorker.clear` all-or-nothing).
- The cold-state lifecycle invariant (`deliverySentToWorker.clear()` follows `sendColdState`).
- `clearMemberResources` shape ambiguity (member vs dataset id branches).

### Mock factory surfaces

`createMockCpuCache()` (orchestrator.test.ts:23-36) — duck-typed CpuCache with 10 stubbed methods. Each test resets via `vi.fn()`. The `getCachedChunk` method is **missing** from the mock (only `getCached`, an older name). Adding chunk-delivery tests will need to add it.

`createMockScene()` (orchestrator.test.ts:69-145) — a 76-line stub that satisfies the wide `WasmScene` surface. Configurable via `Partial<MockSceneConfig>` overrides. Healthy.

`createMockContent()` (orchestrator.test.ts:147-189) — a manifest factory for a single-dataset, single-image, two-LOD setup. Used as the baseline; tests override fields when needed.

These are good but rebuilt per `beforeEach` and expanding for new test scenarios is moderately verbose.

## Indirect coverage gaps (specific to upload phase)

### `synthesizeWellRosterEntry`

93-LOC pure function (modulo `ctx.scene.member_model_matrix`). Tested only via end-to-end planAndFetch in the multi-dataset describe block, which doesn't exercise well-as-proxy paths.

**Suggested:** ~5 unit tests for the helper:
- Two visible fields → AABB unions correctly (3D + 2D).
- One visible field → AABB matches that field's matrix.
- Zero visible fields → returns null (defensive).
- Field with degenerate matrix (zero span) → returns null.
- Field whose `model_matrix.length !== 16` → skipped.

~80 LOC. Pure function with a small scene stub.

### `computeScissorRect`

50-LOC pure function in `volumePath.ts:16-65`. Currently no test.

**Suggested:** ~5 unit tests:
- Identity model + identity viewProj → full canvas rect.
- Off-screen well (clipW <= 0) → conservative full-screen fallback.
- Partially-clipped well → integer-clamped rect within canvas.
- Fully off-screen → returns null.
- Tiny well → 1×1 minimum rect (or whatever the actual contract is).

~70 LOC. Pure.

### `proxyKeyFromX` helpers

Three pure helpers (orchestrator.ts:1766-1776). Tested only indirectly via the proxy delivery tests.

**Suggested:** trivial 3-test table asserting all three produce the same string for equivalent input shapes. ~15 LOC.

### Cold-state telemetry pipeline

The hit/rebuild counters, cause attribution, churn detector, p50/p95 — currently unverified end-to-end. `debugStats.orch.coldState` is read by the panel but no test asserts it has the right shape after a series of ticks.

**Suggested:** ~6 tests on the telemetry alone:
- After 5 hits → cacheHits=5, hitRate=1.
- After 1 rebuild + 4 hits → causeLastSecond reflects the rebuild's causes.
- After many non-view rebuilds in 2s → churn log fires once (rate-limit verified).
- p50/p95 computed from rebuild duration samples.
- Cause attribution diffs (epochs change → causes populated).

These tests need a `Clock` injection (Pass 4) or `vi.useFakeTimers()` to time-travel.

### Upload telemetry pipeline + anomaly detectors

Three anomaly detectors with ~250 LOC of bookkeeping. None tested.

**Suggested:** ~10 tests:
- Drain N chunks → `drainedChunks`, `uploadedChunks`, `bytesUploaded` reflect.
- Skip due to lane=prefetch/overview → respective skip counters bump.
- Skip due to wrong LOD → `skippedWrongLod` bumps.
- Skip due to already-sent → `skippedAlreadySent` bumps.
- Resend pass: cached-not-found, already-sent, rejected → respective counters bump.
- Rolling: events older than 1s are pruned.
- p50/p95: 120 samples → percentiles computed.
- Anomaly: `budget_exhausted_sustained` fires after N consecutive ticks.
- Anomaly: `resend_storm` fires after sustained > 0.5 ratio for 2s.
- Anomaly: `drain_waste` fires after sustained > 0.5 filter ratio for 2s.

Same Clock injection requirement.

### `handleChunksEvicted`

Currently no test. The asymmetric `evicted` vs `skipped` branches are critical to upload correctness — eviction should re-enable upload, skipped should mark rejected.

**Suggested:** ~5 tests:
- `evicted` keys removed from `deliverySentToWorker` (resend can re-upload).
- `evicted` keys removed from `deliveryRejectedByWorker` (acceptance proves deliverable).
- `skipped` keys added to `deliveryRejectedByWorker`.
- `skipped` keys forward to `cpuCache.markRejected(entityId, key)` with correct entityId.
- Worker member id with no `widToEntityId` entry → `markRejected` not called.

~80 LOC.

### `handleWantedSetDelta` chunk branch

Today this writes to dead state. Tests should pin "this branch is supposed to do X" — once Pass 8 decides on implement-vs-delete, the test asserts the chosen behavior.

**Suggested (post-decision):** ~3 tests:
- If chunk filter is implemented: a stale chunk drains but is filtered before send.
- If field is deleted: the chunk-side branch should be a no-op.

### `clearMemberResources` shape ambiguity

The dataset-vs-member id ambiguity isn't tested. **Suggested:** ~4 tests:
- Pass a dataset id → all dataset-scoped maps cleared (lastViewEpoch, planning.byDataset, _lastPlanByDataset).
- Pass a member id → only delivery trackers cleared.
- Pass a composite member id (`imageId:chN`) → tracker entries cleared by exact key.
- After clear, getTrackedMemberIds() doesn't return the cleared key.

~40 LOC. Pins the current "best-effort" behavior so the typed-id refactor (Seam F) can preserve it.

### Multi-dataset behavior

The single-most-important characterization test set. Pass 5 #2 confirms `_lastFilteredRequests` last-dataset-wins is a real bug. A test should pin behavior — current or fixed:

**Suggested (current behavior):** 
- Plan two datasets in one tick. Worker evicts a chunk from dataset A. `deliverToWorker`'s resend pass should NOT find it (current bug). Pin the bug; mark the test `it.fails(...)` or document.

**Suggested (post-fix):**
- Same setup. Resend pass finds the chunk via `cpuCache.getCachedChunk` and re-uploads.

Plus:
- `deliverySentToWorker.clear()` runs once-per-rebuild, not per-dataset-step.
- Multi-dataset cold state emission: each dataset gets its own coldState message.
- Multi-dataset viewHotState emission: each dataset gets its own viewHotState (only when its viewEpoch advances).

~100 LOC. Highest-value gap — tests would have caught the bug.

### Cold-state lifecycle invariant

"Every `sendColdState` is followed by `deliverySentToWorker.clear()`."

**Suggested:** 1 test:
- Send delivery (chunk lands in `deliverySentToWorker`). Trigger cold-state rebuild. Assert the chunk is no longer in `deliverySentToWorker`.

After the Seam B refactor folds the clear into `sendColdState`, this test guards against regressions. ~30 LOC.

### Cold-state assembly (per-variant entry mapping)

The three variant branches (well-as-proxy, invisible, field) at `sendColdState:1924-1977` are tested only by the cold-state-display-state describe block, which exercises field entries with display state. Well-as-proxy and invisible variants are uncovered.

**Suggested:** ~6 tests on `buildColdState` (after extraction):
- Field entry → `mode`, `targetLod`, `detailOwnedLodRange`, `proxyKind`, etc. forwarded.
- Well-as-proxy entry → `mode: "well-as-proxy"`, `targetLod: 0`, `proxyKind: "WellProxy3D"`, synthesized matrix.
- Invisible entry → `mode: "fields-with-detail"` (legacy encoding), `proxyKind: undefined`.
- Empty active set → empty cold message.
- Multiple datasets (after the multi-dataset sendColdState extraction).
- Display state: per-channel override falls back to dataset-level.

~100 LOC. Pure builder = mock-free.

### `requestTestProxy`

HITL hook; no test. Could be left untested or get a smoke test that verifies the submit happens.

**Suggested (low priority):** 1 test asserting `cpuCache.submit` is called with a single proxy request matching the input.

## Tests that should land BEFORE the refactor

In dependency order:

### 1. Pure-function characterization

- `synthesizeWellRosterEntry` — 5 tests (~80 LOC).
- `computeScissorRect` — 5 tests (~70 LOC).
- `proxyKeyFromX` helpers — 3-test table (~15 LOC).

**Why first:** these are pure functions, zero infrastructure. They lock down behavior before any Seam B / C / L move.

### 2. Cold-state assembly characterization

- ~6 tests on the *current* behavior of `sendColdState` (all three variants, display-state fallback, message shape).

**Why second:** locks the contract before extracting `buildColdState`. Today only 3 tests in the cold-state-display-state describe block cover the field branch. After characterization, the extraction is a mechanical move.

### 3. Chunk delivery + resend characterization

- ~10 tests on `deliverToWorker` chunk path:
  - Drain happy path (chunk → `sliceChunkData` / `volumeChunkData` called).
  - Lane filter (prefetch + overview) → respective counter bumps.
  - Wrong-LOD filter → `skippedWrongLod` bumps.
  - Already-sent guard → `skippedAlreadySent` bumps.
  - Manifest-not-found (dataset removed mid-tick) → `skippedNoMeta` bumps.
  - Resend pass: chunk in `_lastFilteredRequests` not in `deliverySentToWorker` → re-uploaded.
  - Resend pass: rejected chunk → skipped, `resendChunksRejected` bumps.
  - Resend pass: cache miss → `resendChunksNotCached` bumps.
  - Budget exhausted: drain stops after one oversize chunk.
  - View mode dispatch (slice → `sliceChunkData`; volume → `volumeChunkData`).

**Why third:** the largest blind spot today. Locks the Pass 5 contracts so the dispatch/filter/resend extractions can be safe.

### 4. `handleChunksEvicted` characterization

- 5 tests (above).

**Why fourth:** small but semantically critical. The `markRejected` dispatch is the only orchestrator → cache feedback edge.

### 5. Multi-dataset characterization

- 4 tests (above).

**Why fifth:** would catch the `_lastFilteredRequests` bug AND pin the cold-state-clear-all behavior.

### 6. Telemetry characterization

- ~16 tests across cold-state + upload telemetry + anomaly detectors.

**Why last (in pre-refactor):** telemetry is observability; bugs here are visible (the panel shows wrong numbers) but don't break user-visible features. Lower urgency than chunk delivery. Add as the telemetry modules get extracted (Seam H + I).

Total pre-refactor test work: ~250-400 LOC of new tests, depending on how thorough.

## Tests that the refactor will need

For each candidate sub-module from Pass 6:

### `buildColdState` / `buildColdActiveEntry`

The 6 tests above (item 2). After extraction they test pure functions; mocks shrink.

### `buildViewHotState`

~3 tests:
- Given coldMsg with N members, returns ViewHotState with N rayHits.
- Composite member ids deduped (the `seen` Set logic).
- Empty cold msg → empty rayHitsByEntity.

~30 LOC.

### `buildRoster`

~5 tests:
- Field entries → roster entries with imageId, position, mode.
- Well-as-proxy entries → synthetic roster entries with synthesized matrices.
- Invisible entries → skipped.
- Empty active set → empty roster.
- `matricesByEntity` populated for each rendered entry.

~80 LOC.

### `buildManifestByImage`

~3 tests:
- Single-dataset, single-image → one entry.
- Multi-dataset, multi-image → all entries.
- Image not in any dataset → not in map.

~30 LOC.

### `buildDisplayStateByChannel`

~4 tests:
- Single visible channel, no override → uses dataset-level contrast/gamma/opacity.
- Multi-channel, per-channel overrides → each channel gets its own.
- Missing dsSettings → defaults (0/65535/1/etc.).
- Empty visibleChannels → empty record.

~40 LOC.

### `DeliveryTracker`

Most tests can lift from the existing `proxy delivery tracking` describe block; new tests for the chunk-tracker side and the typed-id system. ~50 LOC.

### `classifyDelivery` / `classifyResend` (FilterVerdict / ResendVerdict)

Pure functions; table-driven tests. ~30 LOC each.

### `dispatchChunk` / `dispatchProxy`

Tests assert the right `client.X` method is called with the right args derived from a delivery + level meta. ~50 LOC.

### `ColdStateTelemetry` / `UploadTelemetry`

Per-class tests (item 6 above) become more focused after extraction. Each class gets ~6-10 tests.

### `SustainedCondition` + `ConsecutiveTickDetector`

Pure helpers; trivial tests:
- Predicate true for less than sustainMs → no log.
- Predicate true for sustainMs → log fires.
- Predicate true for 2 × sustainMs → only one log (rate-limit).
- Predicate false → state resets.

~30 LOC each.

### `publishOrchDebug`

Pure aggregator; ~3 tests asserting it scrapes from the right inputs.

## Test infrastructure observations

### Mocking the CpuCache in chunk-delivery tests

The current `createMockCpuCache` is missing `getCachedChunk`. Adding chunk-delivery tests will require this. **Suggested:** extract a `createMockCpuCacheBuilder` that takes `{ drainResult, cachedChunks, cachedProxies }` and returns a fully-stubbed mock with all methods. Pattern matches `cpuCache.test.ts:43-119`'s `createMockContentSource`.

### Mocking the RenderClient

Today: 3 stubbed methods (`coldState`, `viewHotState`, `proxyAssetData`). Chunk-delivery tests will need `sliceChunkData`, `volumeChunkData`, `removeLayerResources`, plus the two callback fields (`onChunksEvicted`, `onWantedSetDelta`).

**Suggested:** extract a `createMockRenderClient` that returns all stubs typed as `RenderClient`. Lives in `pipeline/orchestrator.testHelpers.ts`. Same pattern that `createMockScene` already follows.

### Time mocking

The proxy-delivery test set already uses `vi.useFakeTimers()` (`orchestrator.test.ts:700-731`). Telemetry tests will need it in many places (window pruning, sustained-condition detection). A `Clock` injection (Pass 4 #1) makes this cleaner than `vi.useFakeTimers` everywhere.

### Multi-dataset fixture

The current `createMockContent` assumes single-dataset. Multi-dataset tests will need either a per-test override or a `createMockContent({ datasetIds: ["ds1", "ds2"] })` factory. ~20 LOC extension.

### Worker-side stubs

Tests that exercise the round-trip (orchestrator emits → worker handles → callback fires) would need a worker stub. Today no orchestrator test does this — they assert what the orchestrator *posts*, not what the worker *receives*. That's fine for unit-level testing of the orchestrator's logic; round-trip tests would belong in `e2e/` (which doesn't exist for the renderer).

**Recommendation:** stay at unit level for the upload-phase refactor. Don't try to add worker round-trip tests.

## Risk-coverage matrix

| Refactor | Coverage today | Risk if refactored without new tests |
|---|---|---|
| Drop `MissingChunkLite` aliases | None (pure rename) | None — no behavior change |
| Move `proxyKeyFromX` to `proxyKeys.ts` | Indirect via proxy delivery tests | Low — pure functions |
| Move `MAIN_VIEW_UPLOAD_BUDGET_BYTES` | None | Low — constant move |
| Identity-matrix factory shared helper | None | Low — micro |
| Extract `buildDisplayStateByChannel` | Indirect via cold-state-display-state tests | Low — small pure fn |
| Extract `buildColdState` / `buildColdActiveEntry` | Partial (field branch only) | Medium — cover well-as-proxy + invisible variants first |
| Extract `buildViewHotState` | Partial (4 tests) | Low |
| Extract `buildRoster` | None directly; integration only | Medium — write the 5 tests first |
| Extract `buildManifestByImage` | None | Low — pure fn, but pin "skip on missing" before |
| Extract `dispatchChunk` (slice/volume branch) | None directly | Medium-high — chunk delivery has zero direct tests today |
| Extract `classifyDelivery` / `classifyResend` | None directly | Medium — pin filter behavior first |
| Extract `DeliveryTracker` (Seam F) | Partial (proxy side) | Medium-high — chunk side untested; pin first |
| Extract `ColdStateTelemetry` / `UploadTelemetry` | None | Medium — telemetry is debug-visible only |
| Extract `SustainedCondition` helper | None | Medium — anomaly logs would silently change |
| Extract `publishOrchDebug` | None | Low — debug-only |
| Extract `Uploader` class (Seam A — biggest split) | Partial via `orchestrator.test.ts` | **High** — public surface changes; tests need to be re-routed; do this last |

## Recommendation

**Before any refactor:**
1. Add 3 pure-function tests (synthesizeWellRosterEntry, computeScissorRect, proxyKeyFromX) — quick win, ~165 LOC.
2. Add chunk-delivery characterization tests (~10 tests, ~150 LOC) — closes the largest blind spot.
3. Add `handleChunksEvicted` characterization (~5 tests, ~80 LOC).
4. Add multi-dataset characterization (~4 tests, ~100 LOC) — pins the bug behavior.
5. Add cold-state lifecycle invariant test (~1 test, ~30 LOC).
6. Defer telemetry characterization until the telemetry modules are about to extract (let the Seam H/I refactor drive those tests).

Total: ~525 LOC of new tests across ~30 cases. Brings the upload phase's test coverage from "20 tests / partial" to "50 tests / well-protected at the public surface."

**During the refactor:** the existing `orchestrator.test.ts` is the safety net for the public surface. Don't change it during structural moves; add new per-module tests for extracted units. Once the structure stabilizes, optionally migrate some `orchestrator.test.ts` cases down into the per-module tests they now belong to (especially the cold-state-display-state and viewHotState describe blocks → `buildColdState.test.ts` / `buildViewHotState.test.ts`).

**Defer indefinitely:** worker round-trip tests (already covered at the worker side in `descriptorBuffer.test.ts` etc. — keep separation).

## Severity ranking

| Test gap | Severity | Why |
|---|---|---|
| Multi-dataset characterization | High | Would have caught the `_lastFilteredRequests` bug; multiple Pass 5 risks live here |
| Chunk delivery (drain + dispatch) | High | Zero direct tests today; the biggest production-path blind spot |
| `handleChunksEvicted` characterization | Medium-high | Cross-phase callback to cpuCache; semantic correctness matters |
| `synthesizeWellRosterEntry` direct test | Medium-high | Complex pure function; well-as-proxy correctness matters for plates |
| Cold-state lifecycle invariant | Medium | One test pins a footgun-prone implicit contract |
| `buildColdState` characterization (post-extraction) | Medium | Pin pre-extraction behavior |
| `clearMemberResources` shape characterization | Medium | Pins current "best-effort" before typed-id refactor |
| `computeScissorRect` direct test | Medium-low | Pure function; visual-correctness matters |
| Telemetry characterization | Medium-low | Debug-only; lower urgency |
| `proxyKeyFromX` direct test | Low | Trivial; can land alongside the helper move |
| `requestTestProxy` test | Low | HITL hook |
| `MissingChunkLite` rename test | None | No behavior change |

## Next pass

Pass 8 (Refactor Sequencing) turns all of the above into an ordered plan: which tests land first, which extractions follow each, and where the boundaries are between "small mechanical wins" and "ambitious structural change."
