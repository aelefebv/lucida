# Pass 3 — Responsibility Scan: upload phase

Goal: per-unit cohesion check. Does each file/class/function in the upload phase have one clear reason to exist?

## Files

### `pipeline/orchestrator.ts` — 2027 LOC, 1 class, ~30 methods

**One-sentence summary attempt:** "Assembles a planning snapshot, runs `plan()`, and routes the output to CpuCache and the GPU worker." (paraphrasing the actual header)

Reality: this file is *two* coordinators in one. The header doc captures the planning role. The upload role isn't even named in the header — it leaks in via "routes the output to CpuCache and the GPU worker."

The class owns 20 distinct responsibilities (Pass 2 list). The upload portion alone owns: cold-state assembly + emit, view-hot-state emit, well-roster synthesis, drain + filter, chunk/proxy dispatch, two resend passes, five delivery-tracking maps, two telemetry pipelines (cold + upload), worker-feedback handlers, lifecycle teardown, debug aggregation, HITL test hook, and three composite-key helpers.

**Diagnosis:** Vague core responsibility. The name "Orchestrator" is honest about its size — orchestrators tend to grow — but it has crossed from coordination to god-object. The ratio (planning role: ~600 LOC, upload role: ~750 LOC, telemetry: ~400 LOC, debug aggregation + HITL + helpers: ~300 LOC) shows two real classes wearing one hat.

**Suggested split:** see Pass 2 "Visualization: target shape." Concretely, after the upload extraction:
- `pipeline/upload/uploader.ts` — thin coordinator (target ~250 LOC); applyTick, sendColdState (delegating), deliverToWorker (delegating), dispose
- `pipeline/upload/coldState/build.ts` — pure `buildColdState(...)` (~150 LOC)
- `pipeline/upload/coldState/roster.ts` — `buildRoster + synthesizeWellRosterEntry` (~150 LOC)
- `pipeline/upload/delivery/{drain,resend,dispatch,tracker,feedback}.ts` (each ~80–150 LOC)
- `pipeline/upload/telemetry/{upload,coldState,sustained}.ts` (~100, ~100, ~30 LOC)
- `pipeline/upload/proxyKeys.ts` (~25 LOC)
- `pipeline/upload/devtools.ts` (~40 LOC, requestTestProxy)
- `pipeline/orchestrator.ts` — keeps the planner role; target ~400 LOC

### `renderer/renderClient.ts` — 303 LOC, 1 class, ~15 methods

**One-sentence summary attempt:** "Main-thread API wrapping the GPU render worker."

Reality:
1. Worker construction + ready promise.
2. Inbound message dispatch (`onMessage`) into three callback fields: `onIntensityRange`, `onChunksEvicted`, `onWantedSetDelta`.
3. Outbound chunk/proxy upload methods (`sliceChunkData`, `volumeChunkData`, `proxyAssetData`).
4. Outbound state messages (`coldState`, `viewHotState`).
5. Outbound render messages (`sliceRenderMultiPass`, `volumeRenderMultiPass`).
6. Outbound minimap methods (`minimapInit`, `minimapRender`, `minimapSetOverviewForLayer`, `minimapUploadOverviewChunksForLayer`, `minimapDestroy`).
7. Outbound misc (`resize`, `updateCursorData`, `removeLayerResources`, `destroy`).

**Diagnosis:** The class summary is honest — it really is the postMessage wrapper. But the surface has grown large enough that "upload" and "render" and "minimap" have become three sub-personalities. The `onChunksEvicted` / `onWantedSetDelta` fields are publicly assignable, which is a minor encapsulation leak (any holder can overwrite them).

**Suggested split:** Probably defer until after the upload-phase refactor. The candidate is to expose three facets via accessors (`uploadClient`, `renderClient`, `minimapClient`) all backed by the same Worker. Or: keep the class flat but switch `on*` fields to a typed `subscribe(event, handler)` pattern. Low priority; size is manageable.

### `renderer/workerProtocol.ts` — 429 LOC

**One-sentence summary attempt:** "Typed message envelopes between main and worker."

Reality: matches the summary. Pure types + a few small utility types. Healthy.

**Diagnosis:** No changes recommended. Maybe split into `protocol/upload.ts`, `protocol/render.ts`, `protocol/minimap.ts` once the upload module exists, but the file is currently fine.

### `slicePath.ts` / `volumePath.ts` — 194 / 268 LOC

**One-sentence summary attempt (slice):** "Run plan+fetch via Orchestrator, then upload + render the slice multi-pass."

**One-sentence summary attempt (volume):** "Run plan+fetch via Orchestrator, then upload + render the volume multi-pass."

Reality matches. Both files structurally:
1. `tickX(ctx, orchestrator, ..., shouldRender)` — set viewport, run `planAndFetch`, build `PlanResult`, hand to `uploadAndRenderX`.
2. `uploadAndRenderX(ctx, orchestrator, plan, shouldRender)` — call `deliverToWorker`, build per-layer params from member roster + entityIndex, render multi-pass.

**Diagnosis:** Healthy structure (already has the plan/upload/render phases as named functions). Two minor smells:
- Both files duplicate the `members = memberRoster.get(dsId) ?? [{ imageId: dsId, position: [0, 0] }]` fallback pattern — a synthetic 1-member roster when the planning pipeline didn't populate one. This is a "we forgot to fetch the roster" defensive default that shouldn't happen in steady state.
- `volumePath.computeScissorRect` (15-65) is a pure function locked inside the volume-render file. It's used only there today; minor code-smell that the file got bigger because of it. Could move to `pipeline/upload/coldState/scissor.ts` if the upload module forms.

### `renderLoop.ts` — 504 LOC

**One-sentence summary attempt:** "Pull-based RAF loop: coalesces chunk arrivals into a single tick."

The upload-phase touchpoints (lines 95-110, 120, 165-182, 207-220) are small slices of this file. The rest is loop wiring, dirty-flag management, multi-channel transition, frame sampling, and HITL hooks.

**Diagnosis:** Out of scope for this scan — the loop file is its own beast. Just note that `renderLoop.start` (lines 92-112) is the canonical wiring point that becomes "wire the Uploader's feedback handlers" after the refactor.

### `renderLoopTypes.ts` — 63 LOC

`MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB` lives here. Mentioned in Pass 2 Seam N as a candidate to relocate.

### `pipeline/orchestrator.test.ts` — 1024 LOC

**One-sentence summary attempt:** "Behavior tests for the orchestrator."

Reality: 5 describe blocks — epoch caching, multi-dataset planning, proxy delivery tracking, cold-state display state, viewHotState emission. Heavy on planning + cold-state behavior; only the "proxy delivery tracking" block exercises `deliverToWorker`. Chunk delivery has no test. The drain pass, resend pass, telemetry, and `handleChunksEvicted` are all uncovered.

**Diagnosis:** The test file mirrors the file under test — it'll need to split alongside the orchestrator refactor. Hold for Pass 7.

## Methods inside `Orchestrator` worth calling out

### `Orchestrator.planAndFetch` (lines 511-973, ~462 LOC)

**Phases (numbered as in the source):**
1. Epoch check, diff, cause attribution (517-548).
2. Cache-hit short-circuit: replay member-stats, return cached result (550-567).
3. Rebuild path: clear worker-rejection state on both sides (568-577).
4. Build settings + multiChannel + planning config (578-587).
5. Per-dataset loop (592-832):
   - 5a. Skip invisible.
   - 5b. Build planning snapshot.
   - 5c. Cache occupancy telemetry.
   - 5d. Run `plan()`, store carry-forward state, save last requests + region + entities + plan.
   - 5e. Per-dataset planning debug snapshot.
   - 5f. Stash `_lastProxyRequests`, `_lastFilteredRequests`, build `widToEntityId`.
   - 5g. Member roster build (with `well-as-proxy` synthesis).
   - 5h. Matrix lookup build.
   - 5i. Send cold state.
   - 5j. Compute `entityIndex` map.
   - 5k. Conditional view-hot-state emit.
   - 5l. Clear `deliverySentToWorker`.
   - 5m. `cpuCache.submit(...)`.
   - 5n. Member debug stats accumulation.
6. Orchestrator debug snapshot aggregation (834-947).
7. Cache + return + cold-state telemetry record (949-972).

**Diagnosis:** The longest method in the file by far. It does ~10 different things in order, with some genuinely planning (5a–5d), some genuinely upload (5g–5l), and some debug-only (5e, 5n, 6). The mixing of upload concerns into the planning-driver loop is exactly the dual-personality issue from Pass 2 Seam A.

**Suggested target after Seam A:**
```
planAndFetch(ctx, minimap):                        # planner role
  if epochsHit: replayDebugSnapshot(); return cachedResult
  for each dataset:
    snapshot = buildPlanningSnapshot(...)
    plan      = plan(snapshot, state, config)
    bundle.add(dataset, plan, snapshot)
  publishOrchDebug(bundle)                         # debug aggregation moves to its own pass
  return bundle                                    # caller forwards to Uploader.applyTick
```

The upload portion (5g–5l) moves into `Uploader.applyTick(bundle)`.

### `Orchestrator.deliverToWorker` (lines 1359-1515, ~157 LOC)

**Phases:**
1. Reset stats; record tickStart (1364-1367).
2. Compute multiChannel + epochs + remaining budget (1368-1371).
3. Build `targetLevelByImage` from `_lastFilteredRequests` (1373-1377).
4. `cpuCache.drain(budget)` + bin into chunks vs proxies (1379-1384).
5. Drain pass: per-delivery branch (proxy → send; chunk → 3 filters → send) (1387-1432).
6. Chunk resend pass (1437-1473).
7. Proxy resend pass (1482-1509).
8. Set budget-exhausted flag; publish telemetry; return (1511-1514).

**Diagnosis:** Three loops in one method; counter-mutation scattered across all three. Probably the second-longest method in the file. Each loop has a different intent, different counter set, different terminal condition (only the first two are guarded by `budgetExhausted`; the third also stops on it). 

**Suggested target after Seams D + E:**
```
deliverToWorker(ctx, budget, sliceZ):
  stats = beginTick(budget)
  ctx_cached = buildDispatchContext(ctx, sliceZ)    # holds manifestByImage + multiChannel
  remaining = budget
  remaining = runDrainPass(cpuCache.drain(budget), targetByImage, sentTracker, dispatch, stats, remaining)
  if remaining > 0: remaining = runChunkResend(_lastFilteredRequests, sentTracker, rejTracker, cpuCache, dispatch, stats, remaining)
  if remaining > 0: remaining = runProxyResend(_lastProxyRequests, proxyTracker, cpuCache, dispatch, stats, remaining)
  stats.budgetExhausted = remaining <= 0
  uploadTelemetry.publish(now, stats)
  return stats
```

Each pass is unit-testable in isolation; the outer method becomes a 15-LOC composition.

### `Orchestrator.sendColdState` (lines 1840-1994, ~155 LOC)

**Phases:**
1. Build `entityById` (1851).
2. Define `identityMatrix` factory (1853-1857).
3. Build `displayStateByChannel` (1864-1879).
4. Map activeSet → `coldActiveSet` with per-variant narrowing (1888-1978):
   - Per entry: derive `levels`, `parentWellId`, model + inv matrices.
   - Switch on `kind`: `well-as-proxy` literal, `invisible` literal, `field` literal — three near-identical literals with a few field swaps.
5. Build the `ColdStateMessage` (1980-1990).
6. `client.coldState(msg)` + return msg (1992-1993).

**Diagnosis:** "One pure builder + one emit" — see Pass 2 Seam B. The three nearly-identical literal branches at the bottom (1924-1977) are 50+ LOC and could collapse to a small `coldStateActiveEntryFromActive(entry, ...)` helper that returns the right shape.

**Suggested target after Seam B:**
```
sendColdState(...):
  msg = buildColdState({activeSet, entityById, matricesByEntity, dsSettings, selection, visibleRegion, epochs, datasetId})
  client.coldState(msg)
  this.deliverySentToWorker.clear()    # invariant becomes explicit
  return msg
```

### `Orchestrator.sendViewHotState` (lines 2004-2025, ~22 LOC)

Tiny. One pure ray-pick query + one fan-out + one postMessage. Healthy in isolation.

**Diagnosis:** Could be a free function `buildViewHotState(coldMsg, rayHit, epochs, datasetId)` and a one-line emit; pairs with `sendColdState` extraction.

### `Orchestrator.sendDeliveryToWorker` (lines 1653-1730, ~78 LOC)

**Phases:**
1. Compute `workerMemberId` (composite vs bare).
2. **Manifest scan** — walk `ctx.datasets` to find one whose `images` contains `delivery.imageId`. O(D × I).
3. Lookup `imageSpec` and `levelMeta`; bail with `skippedNoMeta` if not found.
4. Extract `(levelDepth, levelHeight, levelWidth)`, `(chunkZ, chunkY, chunkX)`.
5. `sentSet` lookup + already-sent guard.
6. Branch on `viewMode === "slice"`: call `client.sliceChunkData` or `client.volumeChunkData` with arg lists tailored per branch.
7. Track sent + return bytes.

**Diagnosis:** Two unrelated concerns:
- *Resolve metadata* — manifest scan + level lookup. Could be cached: `dispatchContext.manifestByImage: Map<imageId, {manifest, image, levelByLevel}>` built once per tick. Eliminates O(D × I) per chunk.
- *Dispatch + track* — the `client.X(...)` call + sentSet bookkeeping.

The slice/volume branch contains different argument lists for the same conceptual "send chunk data" operation. The arg shapes are close but not identical. The two `client` methods themselves take 14 and 12 positional args respectively; that's a smell that wants a struct.

**Suggested target after Seams D + F:**
- `dispatch.sendChunk(ctx, delivery, dispatchContext, sentTracker, sliceZ, viewMode): number`
- Arg lists for `sliceChunkData` / `volumeChunkData` get factored into call-site structs.

### `Orchestrator.sendProxyDeliveryToWorker` (lines 1739-1757, ~19 LOC)

Tiny. Forwards to `client.proxyAssetData` and records the composite key. Healthy.

**Diagnosis:** Lives next to `sendDeliveryToWorker`, but doesn't do the manifest scan. The asymmetry is fine — proxies don't need level/shape extraction (they're pre-baked at fixed dims).

### `Orchestrator.handleChunksEvicted` (lines 1538-1569, ~32 LOC)

**Phases:**
1. Update `deliverySentToWorker[wid]` (drop both evicted + skipped).
2. For evicted: drop from `deliveryRejectedByWorker[wid]`.
3. For skipped: add to `deliveryRejectedByWorker[wid]` AND forward to `cpuCache.markRejected(entityId, key)`.

**Diagnosis:** Three updates across three maps + one cross-phase callback. The body is dense but readable. Belongs next to the trackers (Seam F + G).

The only behavioural subtlety is the asymmetric handling of "evicted" vs "skipped" (eviction means accepted-then-displaced; skipped means refused upfront). That's a real domain distinction; preserve it in the extraction.

### `Orchestrator.handleWantedSetDelta` (lines 1583-1604, ~22 LOC)

**Phases:**
1. Clear `workerWantedSet`.
2. Walk `missing[]`, switch on `kind`:
   - chunk: add to `workerWantedSet[entityId]`.
   - proxy: clear from `proxyDeliveredToWorker`.

**Diagnosis:** **`workerWantedSet` is a dead write.** Verified in Pass 1, Risk B. The only consumer of `workerWantedSet` is internal to this method (the `Set` it builds). After the refactor, this method should drop the chunk-side branch entirely (or implement the filter that CHUNK_PIPELINE.md *thought* existed).

### `Orchestrator.clearMemberResources` (lines 1612-1638, ~27 LOC)

**Phases:**
1. Drop `deliverySentToWorker[id]`.
2. Drop `deliveryRejectedByWorker[id]`.
3. Drop `widToEntityId[id]`.
4. Best-effort prefix scan: drop `proxyDeliveredToWorker` keys starting with `${id}|`.
5. Drop `lastViewEpochByDataset[id]` (no-op for image ids).
6. Drop `debugStats.planning.byDataset[id]` (no-op for image ids).
7. Drop `_lastPlanByDataset[id]` (no-op for image ids).

**Diagnosis:** A 7-step "find every Map and remove" function — same pattern as `cancelDataset` / `reset` in `cpuCache.ts` was. The "no-op for image ids" comments (5–7) are a code smell: the function doesn't know what kind of id it received and defensively does the operation in case. The "best-effort prefix" (4) likewise.

After Seam F, this becomes `tracker.clearMember(id)` + `coldStateTelemetry.clearDataset(id)` etc., each owning its own state and knowing what id shape it expects.

### `Orchestrator.publishUploadStats` (lines 1120-1235, ~116 LOC)

**Phases:**
1. Sum the skip categories from `currentUploadStats` (1121-1126).
2. Push `uploadTickWindow` entry (1131-1143).
3. Prune both ring buffers (1145-1151).
4. Walk `uploadEvents` for window aggregates (1153-1160).
5. Walk `uploadTickWindow` for window aggregates (1161-1180).
6. Compute upload-bound vs non-upload-bound subtotals (1188-1195).
7. Compute p50/p95 (1196-1202).
8. Build `UploadRollingStats` literal (1204-1219).
9. Call anomaly detector (1221-1227).
10. Publish to `debugStats.upload` (1229-1234).

**Diagnosis:** "Aggregate two ring buffers into one struct + run anomaly detection" is one job, but the body is dense and hard to skim. The two-loop walk (4 + 5) could be one accumulator pattern. The "upload-bound vs not" arithmetic (6) is a derived concept that should probably be a named local.

**Suggested target after Seam H:**
- Split into `UploadTelemetry.tick(stats, now): RollingStats` (single accumulator pass; returns the struct) and `UploadTelemetry.publish(rolling, debugStats)` (one-line struct copy). Anomaly detection is a separate `SustainedConditionDetector.tick()` call.

### `Orchestrator.maybeLogUploadAnomalies` (lines 1250-1347, ~98 LOC)

**Three detectors with shared structure:**

1. **Budget exhausted** (1268-1283) — counter-based; bumps `uploadConsecutiveExhausted` on true, resets on false; logs when ≥ N AND rate-limit elapsed.
2. **Resend storm** (1286-1308) — timestamp-based; sets `resendStormSince` on first true, fires when `now − since ≥ 2s` AND rate-limit elapsed.
3. **Drain waste** (1311-1346) — same shape as resend storm.

**Diagnosis:** Three sustained-condition detectors with shared behaviour but in-line code. The budget detector is counter-based (consecutive ticks) while the others are timestamp-based (sustained millis). Both shapes can be expressed via a common helper.

**Suggested target after Seam I:**
- A `SustainedConditionDetector(name, sustainMs, rateLimitMs, log)` helper.
- The budget detector becomes a `ConsecutiveTickDetector(name, threshold, rateLimitMs, log)`.
- Each is a one-line `detector.tick(now, condition)` call.

### `Orchestrator.recordColdStateRebuild` + `maybeLogColdStateChurn` + `publishColdStateDebug` (lines 986-1098, ~113 LOC)

Same shape as the upload telemetry. Single counter set + single ring buffer + single sustained-condition detector + single struct publisher. Not as long as the upload counterpart; that's because cold-state has only one anomaly detector vs upload's three.

**Diagnosis:** Pulls out cleanly into `ColdStateTelemetry`. See Seam H.

### `synthesizeWellRosterEntry` (free function, lines 193-285, ~93 LOC)

**Phases:**
1. Compute 3D world-space AABB by unioning each visible field's `[0,1]^3` cube transformed by its model matrix (212-249).
2. Compute 2D voxel-space AABB independently (216-227 interleaved).
3. Validate non-zero spans on both (250-257).
4. Build column-major model + inverse matrices (259-270).
5. Return roster entry literal (271-284).

**Diagnosis:** A pure function (modulo `ctx.scene.member_model_matrix` reads). Good single responsibility ("compute the synthetic AABB matrix for a well from its child fields"). The only smell is that 3D and 2D AABB computations are interleaved in one pass; could be two named helper passes for readability. Length is fine for what it does.

The matrix building (lines 259-270) is column-major direct construction — there's no shared "build TRS matrix" helper anywhere in the codebase; this is an isolated formula.

### `Orchestrator.requestTestProxy` (lines 1800-1836, ~37 LOC)

**Diagnosis:** Tiny, pure-of-side-effects-on-orch-state, exists only for the dev console. Move out of the production class. See Seam M.

### Composite-key helpers (lines 1766-1776)

Three 4-line free functions that build the same `${ds}|${e}|${k}|${t}|${c}` string from three different shapes. The duplication is benign because each input has a different field name (`proxyKind` vs `kind` vs `proxyKind` again — yes, two of the three call it `proxyKind`).

**Diagnosis:** Move to `pipeline/upload/proxyKeys.ts` (or onto the tracker module). Trivial.

## Methods inside `RenderClient` worth calling out

### `RenderClient.sliceChunkData` / `volumeChunkData` / `proxyAssetData` (lines 73-190)

All three slice-then-transfer the ArrayBuffer for zero-copy. All three take many positional args (12, 14, 9). The `proxyAssetData` method hard-codes `dataType: "u16"` (line 185).

**Diagnosis:** The positional-arg sprawl is real. Each call site (in the orchestrator) constructs the args from a `ReadyChunkDelivery` or `ReadyProxyDelivery`. A target shape would be:
```
client.sendChunk(delivery: ReadyChunkDelivery, levelMeta: LevelMeta, viewMode, sliceZ?)
client.sendProxy(delivery: ReadyProxyDelivery)
```
and `RenderClient` does the postMessage construction internally. Reduces the call-site arg list to one delivery + ambient context.

Hard-coded `dataType: "u16"` for proxies is a separate question — proxies are u16 by construction today, but the worker accepts a `dataType` field in its `proxyAssetData` envelope. Either remove the field from the envelope (proxies are always u16) or pipe the actual value from the delivery (`delivery.header.dtype`). Today it's load-bearing only because of the `header.dtype === "u16"` invariant in the parser.

### `RenderClient.coldState` / `viewHotState` (lines 145-155)

Trivial postMessage forwards. Healthy.

### `RenderClient.removeLayerResources` (lines 295-297)

Single postMessage. Healthy. The semantics ("free GPU resources for this id") are clear at the worker side; the call site (`RenderLoop.removeDataset`) is the only consumer.

## Naming review (upload-phase)

Most names are good. The few that might want to change after a refactor:

- **`workerMemberId`** vs **`memberId`** vs **`imageId`** — three names for overlapping shapes. After Seam F this becomes a typed branded type (`type WorkerMemberId = string & {__brand}`) so consumers don't accidentally pass a bare imageId where a composite is expected.
- **`deliverySentToWorker`** — verbose but unambiguous; keep.
- **`deliveryRejectedByWorker`** — mirrors above; keep.
- **`widToEntityId`** — `wid` is opaque; once the type is named (above) it becomes `entityIdByMember` or similar.
- **`proxyDeliveredToWorker`** — Set, not a Map; "delivered" vs "sent" — same concept under two names. Pick one (`sent` for both, "delivered" is the historical CpuCache term).
- **`workerWantedSet`** — keep the name but **delete the field** if the filter contract is abandoned; OR implement it.
- **`_lastFilteredRequests`** — the leading underscore + the historical "filtered" (no longer filtered, see comment line 663) — both are fossils. Rename to `lastRequestsByDataset` after the planner extraction.
- **`_lastProxyRequests`** — same. Rename.
- **`_lastEntities` / `_lastVisibleRegion` / `_lastCachedKeyCounts` / `_lastPlanByDataset`** — five fields with the `_last` prefix; honest about being snapshots-for-debug. After Seam J they collapse into one `OrchDebugSnapshot` object.
- **`currentUploadStats`** — the name is clear; "current" reads as "this tick." Keep.
- **`coldStateDebug`** — clear.
- **`uploadLogState`** — vague; rename to `anomalyDetectorState` or similar.

## Cross-cutting smell: 30+ fields of state on one class

Fields from the class declaration (excluding private telemetry sub-records like `coldStateChurnState` and `uploadLogState`):

```
planningState, lastEpochs, cachedResult, cachedDebugMemberSnapshot,
requestEpoch, lastViewEpochByDataset,
_lastRequests, _lastVisibleRegion, _lastEntities, _lastCachedKeyCounts,
_lastFilteredRequests, _lastPlanByDataset, _lastProxyRequests,
deliverySentToWorker, deliveryRejectedByWorker, widToEntityId,
proxyDeliveredToWorker, workerWantedSet,
coldStateEvents, coldStateRebuildCount, coldStateHitCount,
coldStateCauseTotal, coldStateRebuildDurations,
coldStateLastRebuildAt, coldStateLastRebuildMs,
coldStateDebug, coldStateChurnState,
currentUploadStats, uploadEvents, uploadTickWindow,
uploadSizeSamples, uploadTotalBytes, uploadTotalUploads,
uploadConsecutiveExhausted, uploadLogState,
configStoreUnsub
```

That's ~36 fields on one class. Roughly:
- 4 are planner-role state (planningState, lastEpochs, cachedResult, cachedDebugMemberSnapshot)
- 7 are debug snapshots (`_last*`)
- 5 are delivery trackers
- 9 are cold-state telemetry
- 8 are upload telemetry
- 1 is config-store lifecycle
- 2 are inter-phase glue (requestEpoch, lastViewEpochByDataset)

This is the strongest single quantitative argument for the split (mirrors the `CpuCache` 35-field smell from the fetch-decode pass).

## Severity ranking

| Unit | Severity | Rationale |
|---|---|---|
| `orchestrator.ts` (whole file) | **High** | God object; 36 fields; 20 responsibilities; 2027 LOC; two roles in one class |
| `Orchestrator.planAndFetch` | High | 462 LOC; 7 numbered phases mixing planning and upload |
| `Orchestrator.deliverToWorker` | High | 157 LOC; three loops with three counter sets |
| `Orchestrator.sendColdState` | Medium-high | 155 LOC; pure builder mixed with emit + three near-duplicate variant literals |
| `Orchestrator.publishUploadStats` | Medium-high | 116 LOC; two-pass aggregation + derived arithmetic + anomaly trigger |
| `Orchestrator.maybeLogUploadAnomalies` | Medium-high | 98 LOC; three detectors sharing structure but no shared code |
| `Orchestrator.sendDeliveryToWorker` | Medium | 78 LOC; manifest scan + dispatch interleaved |
| `Orchestrator.handleChunksEvicted` | Medium | Healthy size but cross-phase callback; belongs next to the tracker |
| `Orchestrator.clearMemberResources` | Medium | 7-step "find every map and remove"; symptom of fragmented state |
| `Orchestrator.handleWantedSetDelta` | Medium | Tiny; the chunk-side branch is dead — fix or delete |
| Cold-state telemetry helpers | Medium-low | Resolves with H |
| `synthesizeWellRosterEntry` | Low | Healthy; minor 2D/3D pass interleave readability |
| `RenderClient` (chunk/proxy/cold methods) | Low | Positional-arg sprawl; mechanical cleanup |
| `RenderClient.proxyAssetData` hard-coded `"u16"` | Low | Real but contained |
| `requestTestProxy` placement | Low | One-file move |
| Composite-key helpers | Low | Move with F |
| `slicePath.ts` / `volumePath.ts` | None | Healthy with minor synthetic-roster fallback smell |
| `workerProtocol.ts` | None | Pure types; healthy |

## Next pass

Pass 4 (Dependency Scan) checks: hidden globals (`debugStats` is mutated from many sites), hard-coded constants, hidden coupling (the `_last*` snapshots that flow between planAndFetch and deliverToWorker), and whether the proposed sub-modules can actually be constructed/tested in isolation given current imports.
