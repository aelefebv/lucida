# Pass 4 — Dependency Scan: upload phase

Goal: find code that's hard to change because it depends on too much. Hidden globals, hard-coded implementations, hidden coupling, implicit ordering.

## Direct environmental dependencies

### `performance.now()` — 3 sites in `orchestrator.ts`, 0 in `renderClient.ts`

Sites: `planAndFetch:515` (tickStart), `planAndFetch:966` (tickEnd, for cold-state rebuild duration), `deliverToWorker:1364` (tickStart, for upload telemetry timestamps).

Indirectly more — every `recordUploadEvent / publishUploadStats / recordColdStateRebuild` call takes a `now: number` arg sourced from one of the three above. So the timing graph is "compute once at the top of the method, pass downward." That's actually clean.

**Impact:** No tests today inject a fake clock through this surface. `orchestrator.test.ts` uses `vi.useFakeTimers()` for the `setTimeout`-based proxy delivery test (line 700-731) but not for the `performance.now`-based telemetry. Telemetry behaviour (rolling windows, sustained-anomaly thresholds) is currently uncovered by tests.

**Suggested change:** an injectable `Clock` interface (`now(): number`). The CpuCache could share the same Clock. Tests inject `FakeClock` and time-travel deterministically. Higher payoff once telemetry tests get written (Pass 7).

### `debugStats` global object — read/written from 34 sites in `orchestrator.ts`

This is the single biggest hidden dependency in the upload phase. The orchestrator imports `debugStats, emptyColdStateDebug, emptyUploadTickStats, type OrchDebug, type ColdStateDebug, type ColdStateCauseCounts, type UploadTickStats, type UploadRollingStats` from `../debug/debugStats.ts`. It then:

- **Reads** `debugStats.enabled` 9 times to gate work.
- **Mutates** `debugStats.orch.epochCacheHit`, `debugStats.orch.coldState`, `debugStats.upload`, `debugStats.planning.byDataset[dsId]`, `debugStats.visibleMembers`, `debugStats.totalMembers`, `debugStats.memberStats`, `debugStats.selectedLevel`, `debugStats.numLevels`.
- **Saves snapshots** of `debugStats.memberStats` (etc.) to `cachedDebugMemberSnapshot` so the cache-hit path can replay them.

`debugStats` is a module-level mutable singleton. It's the canonical anti-pattern (a global), and it lives in the chunk pipeline because the DebugPanel polls it on a timer.

**Impact:** Several orchestrator behaviours fork on `debugStats.enabled` — when enabled, additional state is gathered (`_lastCachedKeyCounts`, `_lastEntities`, `cachedDebugMemberSnapshot`). Disabled production builds skip this work; tests need to manage `debugStats.enabled` explicitly.

The cache-hit short-circuit (`planAndFetch:550-567`) replays member stats from the snapshot for debug visibility — this is a workaround for the global being shared. If `debugStats` were per-instance or behind an injected interface, the replay wouldn't be necessary at this layer.

**Suggested change:** define a `DebugSink` interface (`{ enabled: boolean; recordOrch(...); recordUpload(...); recordPlanning(...) }`) and inject it into `Orchestrator`'s constructor. Default to a `GlobalDebugSink` that mutates `debugStats` for backwards compat. Tests inject a `NullDebugSink` or a `RecordingDebugSink` for assertions. Major payoff for testability; mechanical change.

### `debugLog` from `debug/logging.ts` — used by anomaly detectors

Imported in `orchestrator.ts:64`. Called from `maybeLogColdStateChurn`, `maybeLogUploadAnomalies` (3 detectors), and indirectly through other paths. Acceptable cross-cutting dep. Could be injected for "did we log this?" tests but not necessary today.

### `JSON.parse(ctx.scene.epochs())` — `planAndFetch:518`

The orchestrator reads epochs by parsing a JSON string returned by WASM. This is a perf concern (allocations every tick) and a contract concern (the JSON shape is implicit). Not an upload-phase issue per se but flows into `lastEpochs`, which the upload phase reads.

The follow-up `typeof ctx.scene.asset_epoch === "function"` check (lines 527-529) is defensive against older WASM builds; the comment notes it. Mild.

### No filesystem, no network, no environment variables

Upload phase touches none. ✅ All I/O goes through the WASM scene + RenderClient (worker) + CpuCache.

## Hard-coded constants

### Cold-state telemetry constants (top of `orchestrator.ts`, lines 75-96)

```
COLD_STATE_WINDOW_MS                    = 1000
COLD_STATE_DURATION_SAMPLES             = 60
COLD_STATE_CHURN_THRESHOLD_PER_SEC      = 30
COLD_STATE_CHURN_SUSTAIN_MS             = 2000
COLD_STATE_CHURN_LOG_RATE_LIMIT_MS      = 2000
```

All five hard-coded. None overridable. None on the planning configStore (since they're not user-tunable). Acceptable today — these are observability-level tuning knobs. Worth noting that **none of them are tested** (no test changes the rolling window or fires a churn log).

### Upload telemetry constants (lines 102-125)

```
UPLOAD_WINDOW_MS                          = 1000
UPLOAD_SIZE_SAMPLES                       = 120
UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD  = 3
UPLOAD_RESEND_RATIO_THRESHOLD             = 0.5
UPLOAD_FILTER_RATIO_THRESHOLD             = 0.5
UPLOAD_LOG_SUSTAIN_MS                     = 2000
UPLOAD_LOG_RATE_LIMIT_MS                  = 2000
```

Same story. Five thresholds + window + sample buffer — all hard-coded, all untestable without source edits. The two thresholds (`0.5`) are **operational tuning numbers**; in a different deployment they'd want to live in some config.

### `MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB` in `renderLoopTypes.ts:45`

Hard-coded; passed by `slicePath` and `volumePath` into `deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, sliceZ?)`. Not on configStore. Not test-overridable except by replacing the whole constant.

This budget directly drives the upload telemetry behaviour (filter ratio, exhaustion, p50/p95 sample distribution). Bumping it would change every anomaly detector's behaviour.

**Suggested change:** include in the upload constants module (Pass 2 Seam N); consider exposing on `configStore` if perf debugging needs runtime tweaks.

### `RESIDENCY_RENDER_INTERVAL_MS = 33` in `renderLoopTypes.ts:39`

Lives on the render-loop side; the upload phase doesn't read it directly. Mentioned for completeness — sets the "≈30 fps cap on chunk-arrival redraws."

### Magic strings: `"slice"` and `"volume"`

Mode dispatch in `sendDeliveryToWorker:1709-1727`. Same convention used in `TickContext.mode` and elsewhere. Not promoted to a const. Mild.

### `proxyAssetData`'s hard-coded `dataType: "u16"` (`renderClient.ts:185`)

Hard-coded in the postMessage payload despite `delivery.header.dtype` being available. Cross-language contract: the proxy header parser (`parseProxyHeader`) only accepts dtype code 0 (= u16). So today this is consistent with the wire format — but if the wire ever supports a second dtype, this hard-code becomes a bug.

**Suggested change:** pipe `delivery.header.dtype` through `RenderClient.proxyAssetData(...)` so the contract is one-sided (worker trusts whatever the parser produced).

### `identityMatrix()` factory inline in `sendColdState:1853-1857`

Allocates a new `Float32Array(16)` and sets the diagonal. Used as fallback for entries without a roster match. Three lines duplicated from `volumePath.ts` (and likely elsewhere). Should be a shared utility. Minor.

## Hard-coded implementations / single-impl interfaces

### `RenderClient` is concrete; `Orchestrator` types its parameter as `RenderClient`

Orchestrator's `sendDeliveryToWorker / sendProxyDeliveryToWorker / sendColdState / sendViewHotState` all call `ctx.client.X(...)` where `ctx.client: RenderClient`. There's no `RenderClient` interface; it's the concrete class.

Tests work around this by building a partial object cast as `unknown as TickContext['client']` (`orchestrator.test.ts:634-638`). Three methods stubbed: `coldState, viewHotState, proxyAssetData`. The chunk-data methods (`sliceChunkData`, `volumeChunkData`) aren't stubbed because the tests don't exercise chunk delivery.

**Impact:** Adding chunk-delivery tests requires casting in the missing methods. The existing pattern is fine but doesn't scale gracefully.

**Suggested change:** introduce `interface UploadClient { coldState(msg); viewHotState(msg); sliceChunkData(...); volumeChunkData(...); proxyAssetData(...); onChunksEvicted: (...) => void; onWantedSetDelta: (...) => void; }`. `RenderClient implements UploadClient`. Tests get type help when stubbing. Pairs with Pass 2 Seam O.

### `WasmScene` is the wasm-side class; orchestrator types `ctx.scene: WasmScene`

Used for: `multi_channel()`, `epochs()`, `asset_epoch()`, `member_model_matrix(dsId, imageId)`, `inv_member_model_matrix(...)`, `ray_hit_local_image(...)`. Plus the planning snapshot consumes `view_query`, `member_positions`, `visible_region`.

The upload-phase scene calls (`member_model_matrix`, `inv_member_model_matrix`, `ray_hit_local_image`, `multi_channel`, `epochs`, `asset_epoch`) are all read-only and well-defined. Tests stub by casting `as unknown as WasmScene` (e.g., `orchestrator.test.ts:630-632` provides `multi_channel: () => false` and casts).

**Impact:** Adding cold-state tests requires stubbing all the matrix/ray-pick/epoch methods. Manual labour for each test. A typed `SceneReadOnlyView` interface would tighten this.

**Suggested change:** define a narrow interface for what the orchestrator (and especially the upload phase) actually needs from WASM. Same pattern as separating `UploadClient` from `RenderClient`.

### `CpuCache` is the concrete class

Already typed via `import type { CpuCache } from "./fetch/index.ts"`. Tests build `makeMockCpuCache(...)` factory (`orchestrator.test.ts:595-622`). The mock duck-types `submit, drain, snapshot, getCached, getCachedProxy, telemetry, updateConfig, subscribe, reset, markRejected, clearRejected` and casts as `unknown as CpuCache`.

**Impact:** Same as RenderClient. The existing fetch refactor produced a clean `CpuCache` interface (post-Slice-9+); the upload phase is the natural consumer of it. Once the upload module forms, this seam is healthy.

### `AssetCatalog` is concrete

Tests construct with `new AssetCatalog({ apply_asset_catalog_delta: () => {} })` (a stub WASM scene). Healthy — `AssetCatalog` is itself a small adapter; its constructor takes the dependency, no hidden globals.

## Implicit ordering / call-order dependencies

### `lastEpochs` is set at end of `planAndFetch` and read at top of `deliverToWorker`

`planAndFetch` line 950: `this.lastEpochs = currentEpochs`.
`deliverToWorker` line 1369: `const epochs = this.lastEpochs ?? { content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 };`

If `deliverToWorker` runs before any `planAndFetch` (which it can't in production but could in a test), the epochs default to all zeros and propagate to every emitted message. The fallback is silent — no warning.

**Impact:** Test setup must call `planAndFetch` before `deliverToWorker` for realistic epochs. Tests today work around this by setting up the initial plan via a single `planAndFetch` call before delivery exercises.

**Suggested change:** either make `deliverToWorker` require `epochs` as a parameter (passed by the renderLoop tick), or assert `this.lastEpochs !== null` and throw. Encodes the ordering contract in the type, not in a fallback.

### `sendColdState` MUST be followed by `deliverySentToWorker.clear()`

Comment in `planAndFetch:770-772`: "Worker rebuilds slice/volume atlas pools on each cold state, so all chunks must be re-uploaded to fill the rebuilt atlases." The clear is on line 773.

If anyone adds a new code path that calls `sendColdState` without the clear, chunks won't re-upload after the worker drops them. This is a real footgun.

**Suggested change:** fold the clear into `sendColdState` itself (post-`client.coldState(msg)`). Encodes the invariant in the method, not in a comment + code order.

### `sendViewHotState` MUST be sent before subsequent chunk-data messages

Comment in `planAndFetch:759-763`: "Posted before subsequent render messages so the worker's `rayHitPerEntity` is current when chunk-data eviction fires." This depends on the renderLoop's tick structure (planAndFetch → deliverToWorker → render).

**Impact:** if anyone reorders the tick to `deliverToWorker` first, then `planAndFetch`, eviction fires against stale ray-pick coords until the next `sendViewHotState`. Today the order is fixed; the dependency is documented.

**Suggested change:** make the worker accept a `currentEpochs` field on each chunk-data message that includes the latest viewEpoch's hot data, OR accept a `hotState` in the same envelope. Eliminates the implicit ordering. (Probably out of scope; mention only.)

### `widToEntityId` populated in `planAndFetch`, consumed by `handleChunksEvicted`

Lines 672-675 populate; line 1563 reads. The lifetime is "between cold-state rebuilds." There's no encoded type or contract — just call ordering and the `clear()` on rebuild (line 575).

**Impact:** if `handleChunksEvicted` fires for a member that hasn't been planned in the current rebuild (e.g., the member was just removed), `widToEntityId.get(workerMemberId)` returns undefined and `cpuCache.markRejected` is silently skipped. The cache may keep re-fetching until something else clears it.

**Suggested change:** wrap the population + lookup in a `DeliveryTracker.entityIdFor(workerMemberId): string | null` method (Pass 2 Seam F). The `null` case can be logged/asserted.

### `_lastFilteredRequests` populated in `planAndFetch`, consumed by `deliverToWorker` resend pass

Lines 666 populates; lines 1375 (build target map) and 1438 (iterate) consume. Same pattern as `widToEntityId`. Lifetime: "between cold-state rebuilds for this dataset."

**Caveat:** `_lastFilteredRequests` is single-valued but updated **per-dataset** in the planning loop (line 666 is inside the per-dataset loop). For multi-dataset rebuilds, only the **last** dataset's requests survive. The resend pass therefore only re-uploads chunks for the last dataset, not all of them.

**Verify in Pass 5.** This may be a multi-dataset bug.

### `_lastProxyRequests` — same shape as above

Line 659 populates per-dataset; line 1483 iterates. Same multi-dataset concern.

### `cpuCache.clearRejected()` called from `planAndFetch:576` on every cold-state rebuild

Tells the cache "anything previously rejected by the worker is now eligible to be re-fetched." The cache trusts the orchestrator's clear cadence.

This is a feedback channel that crosses the upload/fetch boundary in both directions:
- Worker → Orch → Cache: `handleChunksEvicted(skipped)` → `cpuCache.markRejected(entityId, key)`.
- Orch → Cache: `planAndFetch` cold-state rebuild → `cpuCache.clearRejected()`.

**Impact:** the cache has no internal way to expire rejection markings. If the orchestrator forgets to call `clearRejected`, rejection markings stick forever.

**Suggested change:** Either add a TTL inside the cache (`rejected for ≥ N submits → expire`) or pass the rebuild signal as a typed event. Today it works because exactly one caller exists; not bug-prone, just fragile. Mirrors a Pass 4 finding from the fetch-decode pass.

### Constructor subscribes to `configStore`; `dispose()` unsubscribes

`Orchestrator` constructor (lines 489-503) subscribes; `dispose()` (lines 506-509) unsubscribes. This is a real lifecycle dependency: tests that construct an Orchestrator without calling `dispose()` leak a subscription.

`orchestrator.test.ts` calls `vi.resetModules()` before each test and re-imports `Orchestrator` — that causes the configStore subscription to leak into the module-level state of the planning module. As long as configStore isn't modified during the test, this is harmless. But it's a real subscription leak.

**Suggested change:** make `Orchestrator` accept a configStore reference (`new Orchestrator(configStore)`) so tests can inject a fresh store per test, OR document that tests must call `dispose()`. Currently neither is enforced.

## Shared mutable state / hidden coupling

### Five delivery trackers all owned by the Orchestrator

Pass 2 Seam F enumerated the trackers. From a coupling standpoint:
- `deliverySentToWorker` — written by `sendDeliveryToWorker` + `handleChunksEvicted` + `planAndFetch` + `clearMemberResources`. Read by `sendDeliveryToWorker` + chunk resend pass.
- `deliveryRejectedByWorker` — written by `handleChunksEvicted` + `planAndFetch` + `clearMemberResources`. Read by chunk resend pass.
- `widToEntityId` — written by `planAndFetch` + `clearMemberResources`. Read by `handleChunksEvicted`.
- `proxyDeliveredToWorker` — written by `sendProxyDeliveryToWorker` + `handleWantedSetDelta` + `clearMemberResources`. Read by proxy resend pass + `sendProxyDeliveryToWorker` (via `getProxyDeliveredKeys`).
- `workerWantedSet` — written by `handleWantedSetDelta`. Read by **nobody** (dead).

Five maps × ~3 mutators each = 15 mutation sites distributed across 6 methods. Pass 3 already flagged this as the cohesion smell; from a dependency angle, every method that touches a tracker is implicitly bound to every other method that touches it.

### `currentUploadStats` is reset in `deliverToWorker` and mutated from helpers

`deliverToWorker` line 1365: `this.currentUploadStats = emptyUploadTickStats()`. Then:
- The drain pass directly mutates `this.currentUploadStats.drainedChunks++`, `skippedPrefetch++`, etc.
- `sendDeliveryToWorker` mutates `this.currentUploadStats.skippedAlreadySent++` and `skippedNoMeta++` from inside the helper.
- `sendProxyDeliveryToWorker` doesn't write to `currentUploadStats` (caller does the bookkeeping).
- The resend passes mutate their own counters.

The asymmetry between `sendDeliveryToWorker` (writes counters internally) and `sendProxyDeliveryToWorker` (caller writes) is a smell. The reason is historical: the chunk path has internal filters (already-sent, no-meta) that need to record skip reasons, so the helper has to write them.

**Suggested change:** the helpers return a typed `Result = { sent: number, skipReason?: SkipReason }`. The caller increments counters. Pure-data return removes the side-effect-on-caller-state dependency.

### `lastViewEpochByDataset` is read in `planAndFetch`, written in `planAndFetch`

Line 764 reads the cached value; line 767 writes the new one. Per-dataset map. Cleared in `clearMemberResources(dsId)`. Healthy single-method ownership.

### `deliverySentToWorker.clear()` happens in `planAndFetch` (per-dataset rebuild)

Line 773: `this.deliverySentToWorker.clear()` — clears the entire map, not per-dataset. So a multi-dataset planAndFetch tick sees:
- Dataset A processed → emits cold state → clears all of `deliverySentToWorker` (including B's entries).
- Dataset B processed → emits cold state → clears all of `deliverySentToWorker` again.

The all-or-nothing clear is correct because each cold-state emit triggers the worker to rebuild atlases for *that* dataset, and atlases are per-dataset shared pools. But after dataset A's clear, B's chunks are also marked "must re-upload" — that's a redundant but cheap re-upload that gets caught by `sendDeliveryToWorker`'s already-sent guard (which is now also reset).

**Verify in Pass 5.** Likely benign because the clear precedes B's submit, but worth tracing.

## Cross-module hidden coupling

### `orchestrator.ts` imports from `pipeline/planning/*`

```
import { plan, emptyPlanStats, groupByWell } from "./planning/index.ts";
import { configStore } from "./planning/configStore.ts";
import { buildPlanningSnapshot } from "./planning/snapshot.ts";
import { buildPlanningDatasetDebug } from "./planning/debug.ts";
import type { ActiveSetEntry, EntitySnapshot, ... } from "./planning/index.ts";
import type { ProxyRequest } from "./planning/index.ts";
```

Five separate `./planning/*` import lines. Acceptable — the orchestrator owns the planner role today. After Seam A (plan vs upload split), the upload module wouldn't import any of these directly; only the planner side would.

### `orchestrator.ts` imports `MissingChunk as MissingChunkLite, MissingProxy as MissingProxyLite` from `renderer/workerProtocol.ts`

The "Lite" suffix suggests these were renamed at import time to disambiguate. Looking at the workerProtocol file: there's no full vs lite distinction — they're just `MissingChunk` and `MissingProxy`. The "Lite" rename must be guarding against a name collision somewhere. Let me verify in Pass 5.

### `orchestrator.ts` imports `computeMemberIndexMap, iterateColdMembers` from `renderer/descriptorBuffer.ts`

These are pure helpers that walk a `ColdStateMessage` and produce an index map. They're imported by orchestrator and consumed in two places:
- `computeMemberIndexMap` — line 757, after `sendColdState`, to build the entity-index map for `entityIndexByDataset`.
- `iterateColdMembers` — `sendViewHotState:2013`, to fan out the ray hit per member.

These belong on the worker side **and** the orchestrator side — they're a shared helper. The `descriptorBuffer.ts` location (in `renderer/`) is fine; both sides import the same canonical iteration order. Healthy seam.

### `synthesizeWellRosterEntry` is a free function but reads `ctx.scene.member_model_matrix`

The function takes `ctx: TickContext` to access `scene`. It's not pure (depends on WASM scene state). Could be made pure by passing in a `(imageId) => Float32Array | null` matrix-lookup function instead of the whole TickContext. Minor.

## Internal-knowledge violations

### Orchestrator reaches into `RenderClient.onChunksEvicted` / `onWantedSetDelta`

These are public assignable fields on `RenderClient`. `RenderLoop.start` sets them (lines 95-110). `RenderLoop.stop` sets them to null (lines 119-120).

This is a documented event-listener pattern, but the public-field shape lets *anyone* with a RenderClient reference overwrite the handler. There's no "subscribe" / "unsubscribe" / list-of-listeners. Single subscriber is fine; multi-subscriber would require code change.

### `Orchestrator.getProxyDeliveredKeys()` returns the live Set

`@internal` annotation acknowledges this is for tests only. The returned Set is the actual private field; mutations on the test side affect the orchestrator's state directly. Acceptable for a typed test backdoor; surprising as a public API.

**Impact:** any code that calls `getProxyDeliveredKeys` can mutate the orchestrator's invariants. Today only tests use it; document and keep.

### `Orchestrator.getTrackedMemberIds()` returns a derived array

Returns `[...this.deliverySentToWorker.keys()]`. Read-only consumer; no mutation of internals. Healthy.

### `RenderLoop.collectMemberIds` uses `getTrackedMemberIds()` to "find members of this dataset" via prefix match

```
const prefix = dsId + ":";
for (const key of this.orchestrator.getTrackedMemberIds()) {
  if (key === dsId || key.startsWith(prefix)) ids.add(key);
}
```

This treats workerMemberId as "either a dataset id or `${dsId}:${suffix}`." That's a string-shape contract that nobody enforces — it relies on the planning side using `:` as a separator. If planning ever changes the convention, `collectMemberIds` silently breaks.

**Suggested change:** make workerMemberId a typed parsable shape (`{ dsId, suffix? }`) or expose a `tracker.memberIdsForDataset(dsId)` method that knows the convention from the inside.

## State ownership map (upload phase)

| State | Owner | Mutators |
|---|---|---|
| `lastEpochs` | Orchestrator | `planAndFetch` (final assignment) |
| `cachedResult` | Orchestrator | `planAndFetch` (build), config-store invalidation |
| `cachedDebugMemberSnapshot` | Orchestrator | `planAndFetch` (snapshot debug fields) |
| `requestEpoch` | Orchestrator | `planAndFetch` (assigned from plan().epochs.request) |
| `lastViewEpochByDataset` | Orchestrator | `planAndFetch` (write), `clearMemberResources` (delete) |
| `_lastRequests, _lastVisibleRegion, _lastEntities, _lastCachedKeyCounts` | Orchestrator | `planAndFetch` per-dataset (last-dataset wins; see Pass 5 verify) |
| `_lastFilteredRequests, _lastProxyRequests` | Orchestrator | `planAndFetch` per-dataset; consumed by `deliverToWorker` resend |
| `_lastPlanByDataset` | Orchestrator | `planAndFetch` per-dataset (correct map) |
| `deliverySentToWorker` | Orchestrator | `sendDeliveryToWorker` (add), `handleChunksEvicted` (delete), `planAndFetch` (clearAll), `clearMemberResources` (delete one) |
| `deliveryRejectedByWorker` | Orchestrator | `handleChunksEvicted` (add evicted/skipped), `planAndFetch` (clearAll), `clearMemberResources` (delete one) |
| `widToEntityId` | Orchestrator | `planAndFetch` (set), `planAndFetch` (clearAll), `clearMemberResources` (delete one) |
| `proxyDeliveredToWorker` | Orchestrator | `sendProxyDeliveryToWorker` (add), `handleWantedSetDelta` (delete on missing), `clearMemberResources` (best-effort prefix delete) |
| `workerWantedSet` | Orchestrator | `handleWantedSetDelta` (clear + add) — and that's all (dead state) |
| Cold-state telemetry fields (~10) | Orchestrator | `recordColdStateHit`, `recordColdStateRebuild`, `pruneColdStateWindow`, `publishColdStateDebug`, `maybeLogColdStateChurn` |
| Upload telemetry fields (~9) | Orchestrator | `recordUploadEvent`, `publishUploadStats`, `maybeLogUploadAnomalies` (3 detectors), `deliverToWorker` (resets and writes counters), `sendDeliveryToWorker` (writes skip counters) |
| `configStoreUnsub` | Orchestrator | constructor (set), `dispose` (call) |
| `planningState` | Orchestrator | `planAndFetch` per-dataset (set from plan().nextState), `clearMemberResources` (no — actually doesn't clear; possible leak) |

The Orchestrator row is dominant — same pattern as CpuCache before the fetch refactor. Each tracker / telemetry-field-set could become a sub-store with internal mutators.

**`planningState` is not cleared by `clearMemberResources`** — verify in Pass 5. If a dataset is removed and re-added, the per-dataset planning state may persist. Could be intentional (preserve hysteresis across removals) or could be a memory leak.

## Hidden assumptions worth surfacing

1. **`workerWantedSet` is populated but never consumed.** Pass 1 Risk B. Either implement the filter or delete the field.

2. **`lastEpochs == null` only at construction time.** `deliverToWorker` has a fallback to all-zero epochs. Tests can hit this if they call `deliverToWorker` before any plan. Production cannot.

3. **`_lastFilteredRequests` and `_lastProxyRequests` keep only the last dataset's requests.** Pass 4 inline note. Multi-dataset resend probably under-resends. Verify in Pass 5.

4. **`deliverySentToWorker.clear()` clears for ALL datasets on each cold-state rebuild.** Each per-dataset rebuild step also clears every other dataset's tracking. Probably benign because the rebuild loop processes datasets sequentially, but worth tracing.

5. **`proxyDeliveredToWorker` cleanup uses prefix matching** (`clearMemberResources:1622-1625`). Relies on the workerMemberId being a dataset-id-shaped key for proxy entries. If the convention shifts (e.g., a member id starts with another dataset's prefix), the prefix scan over-deletes.

6. **`MissingChunk as MissingChunkLite` import alias** — verify in Pass 5 if there's a namespace collision or if this is dead aliasing.

7. **Hard-coded `dataType: "u16"` for proxies in RenderClient.** Cross-language contract today; will break if a second proxy dtype is ever added.

8. **`handleWantedSetDelta` accepts `Array<MissingChunkLite | MissingProxyLite>` but the chunk-side branch has no consumer.** Both halves of the discriminated union arrive; only one is honored.

9. **`entityIndexByDataset` is computed from `coldMsg` after each cold-state emit.** If a future cold-state has different entities than a freshly built `cold.activeSet`, the index map could disagree with the worker. Today they agree by construction (same iteration order + same input data); the comment line 754-757 makes this explicit.

10. **The orchestrator reads `ctx.scene.epochs()` returning JSON.** If WASM ever changes the JSON schema (e.g., adds a field), the orchestrator silently ignores it. Wire contract not validated.

## Severity ranking

| Issue | Severity | Why |
|---|---|---|
| `debugStats` global with 34 sites | High | The single biggest hidden dep; blocks per-instance orchestrator construction; conflates production & test behaviour |
| `workerWantedSet` dead state | High | Bug-shaped; either implement or delete (resolves a doc-vs-code drift too) |
| `_lastFilteredRequests` / `_lastProxyRequests` last-dataset-wins | High (pending Pass 5 verification) | Possible multi-dataset resend bug |
| Implicit ordering: `lastEpochs` set→read across methods | Medium-high | Silent fallback to zero epochs if order changes; not enforced by types |
| Cold-state-clear invariant (deliverySentToWorker.clear after sendColdState) | Medium-high | Encoded in code order + comment; one-line refactor to fold into the helper |
| Hard-coded telemetry constants | Medium | Untested; would benefit from a config struct |
| `MAIN_VIEW_UPLOAD_BUDGET_BYTES` in `renderLoopTypes.ts` | Medium | Move to upload constants module after extraction |
| `RenderClient` is concrete; no upload interface | Medium | Test stub friction; tightens once interface lands |
| `WasmScene` is concrete; no narrow read interface | Medium | Same |
| `currentUploadStats` mutated from helpers | Medium | Asymmetric chunk-vs-proxy helper signature; helper-returns-Result fixes both |
| Constructor configStore subscription leaks in tests | Medium | `vi.resetModules()` works around it but `dispose()` should be enforced |
| `RenderClient.onChunksEvicted` public field assignment | Medium-low | Documented pattern; bug-prone if multi-subscriber ever needed |
| `RenderLoop.collectMemberIds` prefix match | Medium-low | Unenforced string convention |
| `proxyDeliveredToWorker` prefix-delete on cleanup | Low | Best-effort; documented as intentional |
| `MissingChunk as MissingChunkLite` aliasing | Low | Verify in Pass 5; possibly dead |
| `dataType: "u16"` hard-code for proxies | Low | Single-dtype today; defer until needed |
| `synthesizeWellRosterEntry` takes whole `ctx` | Low | Mechanical |
| `JSON.parse(ctx.scene.epochs())` per tick | Low | Allocations; perf concern only if profiling shows |

## Next pass

Pass 5 (Contract Scan) verifies the assumptions flagged above (especially #3, #4, #6 — the multi-dataset resend, the clear-all behaviour, and the dead `MissingChunkLite` alias) and inspects the type contracts at the upload-phase module boundaries (RenderClient methods, ReadyDelivery shape, ColdStateMessage shape, MissingChunk/MissingProxy shape).
