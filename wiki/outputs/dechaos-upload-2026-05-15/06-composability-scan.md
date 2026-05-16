# Pass 6 — Composability Scan: upload phase

Goal: identify logic trapped inside large workflows that could be lifted out as small, reusable, swappable pieces.

## Quick verifications from Pass 5

- ✅ **`MissingChunkLite` / `MissingProxyLite` aliases are unnecessary.** No collision in `pipeline/planning/index.ts` or `pipeline/fetch/types.ts` or anywhere else. Pure rename in Pass 8.
- ✅ **`_lastFilteredRequests` last-dataset-wins is real.** Grep confirms a single field assignment per-dataset with no map indirection. The resend pass therefore only resends the most recent dataset.
- ✅ **`planningState` is not cleared on member removal.** Verified via grep — `clearMemberResources` doesn't reach `planningState`.
- ✅ **`workerWantedSet` is dead state.** Verified by grep across `lucida-web/src/`.

## Composable units already present

A few already-extracted pieces work well as standalone units:

- `synthesizeWellRosterEntry` (free function in `orchestrator.ts:193-285`) — pure modulo a `ctx.scene.member_model_matrix` read; ~93 LOC. Computes a synthetic well AABB + matrices from child fields. ✅
- `computeMemberIndexMap` / `iterateColdMembers` (in `renderer/descriptorBuffer.ts`) — pure helpers walking a `ColdStateMessage`. Already shared between worker and orchestrator. ✅
- `computeScissorRect` (in `volumePath.ts:16-65`) — pure projection of an AABB to screen space. ~50 LOC. ✅
- The three `proxyKeyFromX` helpers (`orchestrator.ts:1766-1776`) — pure key composers. Move to `proxyKeys.ts` (Pass 2 Seam L). ✅
- `getActiveChannels`, `compositeKey` (in `tickCommon.ts`) — pure helpers, already shared by slicePath/volumePath/orchestrator. ✅

## Logic trapped inside `Orchestrator`

Each item below is a candidate for extraction into its own composable primitive.

### 1. The drain-pass filter (in `deliverToWorker`, lines 1387-1432)

Inside the per-delivery loop, three filter checks are inlined:

```
if (delivery.kind === "proxy") { send + accumulate; continue }
if (lane === "prefetch") { skip; continue }
if (lane === "overview") { skip; continue }
if (level !== targetByImage[imageId]) { skip; continue }
send + accumulate
```

Trapped because:
- Each "skip" branch increments a different counter.
- The "send" path branches further inside `sendDeliveryToWorker` (already-sent + no-meta).
- The byte-budget check happens after each send.

**Suggested primitive:**
```ts
type FilterVerdict =
  | { action: "send" }
  | { action: "skip"; reason: "prefetch" | "overview" | "wrongLod" };

function classifyDelivery(d: ReadyDelivery, targetByImage): FilterVerdict
```

The pure verdict makes the side-effect application explicit and lets the loop do counter accounting at the call site uniformly.

Reuse: 0 today, but unifies the chunk vs proxy treatment.

### 2. The resend-pass dedup checks (in `deliverToWorker`, lines 1437-1473)

Inside the chunk resend loop, four conditions are inlined:

```
if (req.lane === "prefetch") continue
if (sentSet.has(req.chunkKey)) continue           # already sent
if (rejectedSet.has(req.chunkKey)) continue        # worker rejected
const cached = cpuCache.getCachedChunk(...)
if (!cached) continue
send
```

Mirrors the cpuCache dedup ladder from the fetch-decode pass. Same shape works:

```ts
type ResendVerdict =
  | { action: "skip"; reason: "prefetch" | "alreadySent" | "rejected" | "notCached" }
  | { action: "send"; cached: ReadyChunkDelivery };

function classifyResend(req, sentTracker, rejTracker, cpuCache): ResendVerdict
```

Same shape applies to proxy resend (3 conditions instead of 4 — proxies have no rejection set).

### 3. Cold-state per-entry mapping (in `sendColdState`, lines 1888-1978)

Three near-duplicate literal branches (`well-as-proxy`, `invisible`, `field`) wrap the same shared computation (levels, parentWellId, modelMatrix, invModelMatrix, displayStateByChannel) with per-variant target/proxy/mode overrides.

**Suggested primitive:**
```ts
function buildColdActiveEntry(
  entry: ActiveSetEntry,
  entityById: Map<string, EntitySnapshot>,
  matricesByEntity: Map<string, {model, inv}>,
  displayStateByChannel: Record<number, ColdStateDisplayState>,
): ColdStateActiveEntry
```

50+ LOC of literal duplication collapses to ~30 LOC of branching logic + one common literal. The function is pure (no I/O, no orchestrator state).

### 4. The cold-state builder as a whole (in `sendColdState`, lines 1840-1990)

Pass 2 Seam B sketched this. The end-to-end builder is pure:

```ts
function buildColdState(args: {
  datasetId, activeSet, entities, selection, visibleRegion, epochs,
  matricesByEntity, dsSettings,
}): ColdStateMessage
```

The current `sendColdState` becomes:
```ts
sendColdState(args, ctx) {
  const msg = buildColdState(args);
  ctx.client.coldState(msg);
  this.deliverySentToWorker.clear();   // invariant becomes explicit
  return msg;
}
```

Pure builder = easy unit test (assert "given this active set and these matrices, the cold state has these entries"). Mock-free.

### 5. The view-hot-state builder (in `sendViewHotState`, lines 2010-2024)

Even smaller. Pure modulo `ctx.scene.ray_hit_local_image`:

```ts
function buildViewHotState(coldMsg, rayHit, epochs, datasetId): ViewHotStateMessage
```

Trivial extract; pairs with #4.

### 6. Member roster builder (in `planAndFetch`, lines 684-744)

Already partially extracted (`synthesizeWellRosterEntry` is a free function). The rest of the loop builds `rosterEntries` and `matricesByEntity` from the active set.

**Suggested primitive:**
```ts
function buildRoster(
  activeSet: ActiveSetEntry[],
  entities: EntitySnapshot[],
  scene: WasmScene,        // for member_model_matrix lookups
  datasetId: string,
): {
  entries: MemberRosterEntry[];
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
};
```

Used by `planAndFetch` (for slicePath/volumePath consumption) AND by `sendColdState` (for matrix sourcing). Two consumers; one builder.

### 7. Manifest-by-image index (currently rebuilt every chunk in `sendDeliveryToWorker:1665-1670`)

The manifest scan is O(D × I) per chunk per tick. Trivial to memoize per-tick:

```ts
function buildManifestByImage(datasets: Map<string, DatasetEntry>): Map<string, {
  manifest: DatasetManifest;
  image: ImageSpec;
  levels: LevelMeta[];
}>
```

Built once per `deliverToWorker` call; passed down to `sendDeliveryToWorker`. Eliminates the per-chunk scan.

Pure function; depends only on the datasets map. Healthy unit-test target.

### 8. Chunk dispatch slice/volume branch (in `sendDeliveryToWorker`, lines 1709-1727)

Two arg lists for the same conceptual operation. After #7 above, the dispatch becomes:

```ts
function dispatchChunk(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  levelMeta: LevelMeta,
  viewMode: "slice" | "volume",
  sliceZ: number | null,    // only used for slice
  fullResDepth: number,     // only used for slice
  fullResZ: number,         // only used for slice
  workerMemberId: string,
  epochs: SceneEpochs,
): void
```

Or two methods on `UploadClient`:
```ts
client.sendSliceChunk(workerMemberId, delivery, levelMeta, sliceZ, fullResDepth, fullResZ, epochs)
client.sendVolumeChunk(workerMemberId, delivery, levelMeta, epochs)
```

Either way, the orchestrator's helper shrinks to: build dispatch args, ask `UploadClient` to send.

### 9. Delivery trackers (Seam F, multiple maps)

Pass 2 Seam F sketched the API:

```ts
class DeliveryTracker {
  // Chunk side
  markChunkSent(workerMemberId, entityId, chunkKey): void;
  wasChunkSent(workerMemberId, chunkKey): boolean;
  markChunkEvicted(workerMemberId, evicted, skipped): void;       // → cpuCache.markRejected via callback
  wasChunkRejected(workerMemberId, chunkKey): boolean;
  entityIdFor(workerMemberId): string | null;

  // Proxy side
  markProxyDelivered(key): void;
  wasProxyDelivered(key): boolean;
  clearProxyDelivered(missing): void;

  // Lifecycle
  onColdStateRebuild(): void;
  clearMember(workerMemberId): void;
  clearDataset(datasetId): void;
  trackedKeys(): IterableIterator<string>;     // for renderLoop.collectMemberIds
}
```

Composable in the sense that the Uploader's "did we already send this?" / "is the worker rejecting this?" questions become method calls instead of map lookups across five fields with implicit lifetimes.

### 10. Cold-state telemetry pipeline (lines 986-1098, ~113 LOC)

Pass 2 Seam H. Self-contained ring-buffer + counters + churn detector + struct publisher.

```ts
class ColdStateTelemetry {
  recordHit(now: number): void;
  recordRebuild(now: number, causes: ColdStateCauseKey[], durationMs: number): void;
  publishTo(debugStats: DebugStats): void;
  // Internally manages: events, counts, durations, churn detector
}
```

Composable in the sense that *anyone* who needs "track hit/rebuild rates with cause attribution and a sustained-anomaly detector" can use the same shape.

### 11. Upload telemetry pipeline (lines 1099-1235, ~150 LOC)

Same shape as #10. `UploadTelemetry` with `recordEvent / recordTickStats / publishTo`.

### 12. Sustained-condition detector (Seam I)

Four detectors share the same pattern. Extract:

```ts
class SustainedCondition {
  constructor(args: {
    name: string;
    sustainMs: number;
    rateLimitMs: number;
    log: (now: number, payload: object) => void;
  });
  tick(now: number, condition: boolean, payload: () => object): void;
}

class ConsecutiveTickDetector {
  constructor(args: { name, threshold: number, rateLimitMs, log });
  tick(now: number, condition: boolean, payload: () => object): void;
}
```

Each call site shrinks from ~30 LOC of bookkeeping to one `detector.tick(now, predicate(), () => payloadFor(...))` call.

Reuse: 4 sites today; many more potential elsewhere in the codebase (cpuCache has the same pattern for cache backpressure).

### 13. Per-channel display state builder (in `sendColdState`, lines 1864-1879)

```ts
function buildDisplayStateByChannel(
  visibleChannels: number[],
  dsSettings: DatasetSettings | undefined,
): Record<number, ColdStateDisplayState>
```

15 LOC of "for each channel, fall back to dataset-level if no override." Pure. Easy extract.

### 14. Identity matrix factory (in `sendColdState`, lines 1853-1857)

```ts
const identityMatrix = (): Float32Array => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};
```

Three lines. Used as a fallback when matrices aren't found. Should be a shared utility (also referenced in `renderLoop.ts:193-194` for the empty-render fallback). Tiny, mechanical.

### 15. The orchDebug aggregation (in `planAndFetch`, lines 834-947)

80+ LOC of "scrape state from many places into one debug payload." Pure aggregation; takes member roster, planning state, last requests, last visible region, last entities, last cached counts → produces an `OrchDebug`.

```ts
function publishOrchDebug(args: {
  memberRoster, planningState, lastRequests, lastVisibleRegion,
  lastEntities, lastCachedKeyCounts, coldStateDebug,
}, debugStats: DebugStats): void
```

Already well-bounded; just lives in the wrong place.

## Logic trapped outside `Orchestrator`

### 1. Layer-params build in slicePath / volumePath

Both files do a similar "for each visible dataset, for each member, for each channel (multi-channel) or once (single-channel), build a layer-params object" loop. The differences:

- Slice path adds `dataW`, `dataH`, `offsetX`, `offsetY` to the layer params.
- Volume path computes a per-member `scissorRect` and adds `renderMode`.
- Slice path's `compKey` is `compositeKey(m.imageId, ch)`; volume path's is identical.
- Both look up `entityIndex` via `entityIndexByDataset.get(dsId)?.get(memberKey)`.

Not strictly composable today (the layer-params types differ enough that one builder can't satisfy both). But the iteration shape (datasets → members → channels) is identical. A shared helper:

```ts
function* iterateLayers(
  layerOrder, allSettings, datasets, memberRoster, multiChannel, viewT,
): Generator<{ dsId, ds, dsSettings, m, ch | null }>
```

Each path consumes the iterator and builds its own layer-params shape. Saves ~30 LOC of duplicated "outer loop" code.

### 2. The synthetic 1-member roster fallback (slicePath:78, volumePath:129)

Both files have `members = memberRoster.get(dsId) ?? [{ imageId: dsId, position: [0, 0] }]`. This "synthesize a default roster if planning didn't" pattern is duplicated.

It's a defensive fallback for "we forgot to populate the roster" that shouldn't happen in steady state. Better fix: make `OrchestratorResult.memberRoster.get(dsId)` always return a non-empty array (or `null` for "skip this dataset"); fall back at the orchestrator level once.

### 3. `RenderLoop.collectMemberIds` shape-guessing (renderLoop.ts:223-231)

Iterates `orchestrator.getTrackedMemberIds()` and pattern-matches against a `${dsId}:` prefix. The convention (composite member ids start with the dataset id + colon) is implicit.

After Seam F + the typed workerMemberId, this becomes `tracker.memberIdsForDataset(dsId)` — the convention lives inside the tracker.

## Repeated near-identical workflows

The chunk and proxy paths inside `Orchestrator` repeat a similar 5-step pattern with subtle variations. Counting:

| Step | Chunk | Proxy | Notes |
|---|---|---|---|
| Drain pass: skip if filter applies | 3 filters (lane×2, level) | none (proxy always passes) | proxy lacks lane/level concept |
| Drain pass: dispatch | sliceChunkData / volumeChunkData | proxyAssetData | identical "compute key + send + track" |
| Drain pass: skip-counter mutation | inside `sendDeliveryToWorker` | n/a | asymmetry |
| Resend pass: dedup | already-sent + rejected + cached | already-delivered + cached | proxy has no rejection set |
| Resend pass: dispatch | sendDeliveryToWorker (resend) | sendProxyDeliveryToWorker (resend) | identical |
| Track delivered | `deliverySentToWorker[wid]` add | `proxyDeliveredToWorker` add | different key shape |
| Worker eviction handling | `handleChunksEvicted` | `handleWantedSetDelta` proxy branch | asymmetric (different message types) |

The structural overlap is moderate but the differences are real (different key shapes, different filters). An `Asset` abstraction could unify them, but the payoff is smaller than the equivalent in cpuCache because:

- The orchestrator's helper bodies are smaller (~30 LOC each vs ~80 LOC for the cache).
- The proxy delivery has no lane/LOD filters — the parallelism is more "chunk has these extra steps" than "two truly identical pipelines."

**Recommendation:** keep chunk and proxy paths separate at the orchestrator level (one helper each), but factor the shared shapes (`DeliveryTracker`, `ResendVerdict`, `dispatchChunk`/`dispatchProxy`) so the two paths don't duplicate the bookkeeping.

This is **less of a composability win than the equivalent fetch-decode finding** — flag it but don't drive a deep abstraction.

## Boolean flags / mode-changing parameters

Looked for these; few exist:

- `ctx.mode: "slice" | "volume"` — drives the chunk dispatch branch in `sendDeliveryToWorker` and the layer-params shape in slicePath/volumePath. Modeled as a clean enum.
- `multiChannel: boolean` — drives the workerMemberId composition (`imageId` vs `imageId:chN`) in many sites. Threaded through method signatures.
- `shouldRender: boolean` — slicePath/volumePath gate; tells the upload-and-render function to skip the render call. Acceptable use of a flag.
- `entry.kind` (active set discriminator) — modeled as a discriminated union with three variants. Healthy.

No "god flags" that radically change behavior. ✅

## Summary: composable units to extract

In rough order of implementation difficulty:

| Unit | Effort | Win |
|---|---|---|
| Move `proxyKeyFromX` helpers to `proxyKeys.ts` | trivial | end three-helper-on-class pattern |
| Drop `MissingChunkLite` aliases | trivial | dead-rename removal |
| Identity-matrix factory shared helper | trivial | three-line de-dupe |
| `buildDisplayStateByChannel` extraction | trivial | testable LUT-style mapping |
| `buildViewHotState` extraction | trivial | pairs with `buildColdState` |
| `buildColdState` extraction | low-medium | enables mock-free cold-state tests |
| `buildColdActiveEntry` (per-variant entry mapper) | low-medium | collapses 50 LOC of literal duplication |
| `buildManifestByImage` (per-tick memo) | low | eliminates per-chunk O(D × I) scan |
| `buildRoster` (combined roster + matrices builder) | low-medium | one source of truth for matrix sourcing |
| `DeliveryTracker` (Seam F, 5 maps under one API) | medium | typed key system; ends scattered mutation |
| `dispatchChunk` (slice/volume branch as a typed call) | low | shrinks `sendDeliveryToWorker` helper to bookkeeping only |
| Drain-pass `classifyDelivery` (FilterVerdict) | low-medium | testable filter; uniform counter accounting |
| Resend-pass `classifyResend` (ResendVerdict) | low-medium | same shape, applies to both chunk and proxy |
| `ColdStateTelemetry` extraction | medium | self-contained module |
| `UploadTelemetry` extraction | medium | self-contained module |
| `SustainedCondition` + `ConsecutiveTickDetector` helper | medium | unifies 4 detector sites; reusable beyond upload |
| `publishOrchDebug` extraction | low | mechanical de-fluff of `planAndFetch` |
| `iterateLayers` shared helper for slicePath/volumePath | low-medium | small but visible cleanup |
| `UploadClient` interface (Pass 2 Seam O) | medium | tightens RenderClient seam; helps tests |
| Asset abstraction over chunk/proxy | high | recommended **not** to do — payoff smaller than fetch side |

## Pure-function candidates (testable today)

Once extracted, every item below can be unit-tested with primitive inputs:

- `buildColdState` — given (activeSet, entities, matrices, dsSettings, selection, visibleRegion, epochs, datasetId), assert ColdStateMessage shape.
- `buildColdActiveEntry` — given (entry, entityById, matricesByEntity, displayState), assert ColdStateActiveEntry shape per variant.
- `buildViewHotState` — given (coldMsg, rayHit, epochs, datasetId), assert ViewHotStateMessage shape.
- `buildRoster` — given (activeSet, entities, sceneStub, datasetId), assert (entries, matricesByEntity) shape.
- `buildManifestByImage` — given (datasets), assert keyed map shape.
- `buildDisplayStateByChannel` — given (visibleChannels, dsSettings), assert per-channel record.
- `synthesizeWellRosterEntry` — already extracted; needs a unit test.
- `classifyDelivery` — given (delivery, targetByImage), assert FilterVerdict.
- `classifyResend` — given (req, sentTracker, rejTracker, cpuCache), assert ResendVerdict.
- `dispatchChunk` — given (client, delivery, levelMeta, viewMode, sliceZ, ...), assert client method called with right args.
- `proxyKeyFromX` (three helpers) — already pure; need direct tests.
- `computeScissorRect` — already pure; needs a direct test.

That's 12+ pure functions ranging from 5 LOC to ~150 LOC, every one of which becomes a low-friction test target after extraction.

## Next pass

Pass 7 (Testability Scan) maps each candidate above to: *what does the test look like, and does the existing harness reach it?* Plus identifies what regression tests need to land **before** any structural changes (the characterization layer).
