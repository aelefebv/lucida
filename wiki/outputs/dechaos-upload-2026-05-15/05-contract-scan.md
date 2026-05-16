# Pass 5 — Contract Scan: upload phase

Goal: are the data contracts at upload-phase boundaries explicit enough to safely change the code? Verify the assumptions flagged in earlier passes; flag implicit / asymmetric / silently-permissive interfaces.

## Public surfaces of the upload phase

Three boundaries to scrutinize:

1. **Orchestrator → callers** — `deliverToWorker`, `handleChunksEvicted`, `handleWantedSetDelta`, `clearMemberResources`, `getTrackedMemberIds`, `getProxyDeliveredKeys`, `requestTestProxy`, `dispose`.
2. **Orchestrator → CpuCache** — `drain(budget)`, `getCachedChunk(eid, key)`, `getCachedProxy(...)`, `markRejected(eid, key)`, `clearRejected()`, `submit(plan)`.
3. **Orchestrator → RenderClient → GPU worker** — typed in `workerProtocol.ts`. Six message types out, two callbacks back.

Plus the implicit data contracts on shared state: `lastEpochs`, `_lastFilteredRequests`, `_lastProxyRequests`, `widToEntityId`, the five trackers.

## Verification of assumptions flagged in earlier passes

### Verified — `MissingChunkLite` / `MissingProxyLite` aliasing is unnecessary (Pass 4 #6)

`orchestrator.ts:16-17` imports `MissingChunk as MissingChunkLite, MissingProxy as MissingProxyLite`. Searched for any other `MissingChunk` / `MissingProxy` symbol that could collide: none in `pipeline/planning/index.ts`, none in `pipeline/fetch/types.ts`, none anywhere else. The alias is a fossil — almost certainly the result of an in-progress rename that left the import side aliased.

**Action:** drop the aliases in the Pass 8 cleanup. Pure rename, no behaviour change.

### Verified — Multi-dataset bug: `_lastFilteredRequests` is last-dataset-wins (Pass 4 inline)

`_lastFilteredRequests` is a flat `ChunkRequest[]` field. `planAndFetch` sets it in the per-dataset loop:

> line 666: `this._lastFilteredRequests = result.requests;`

Each dataset *overwrites* the prior dataset's entry. After a multi-dataset rebuild, the field holds only the **last** dataset's requests. The resend pass at lines 1437-1473 iterates this field — so on a multi-dataset tick, the resend pass only considers chunks for the **last** dataset.

Same shape applies to `_lastProxyRequests` (line 659).

**Impact:** under multi-dataset workloads with worker-side eviction, only the last dataset's evictions get resent from CPU cache. Other datasets' missing chunks land back in the wanted-set delta, the worker re-asks, and the orchestrator's resend pass *can't* find them — it has to wait for the next full plan cycle. Probably manifests as "second dataset takes longer to recover from a transient eviction storm."

**Suggested contract:** `_lastFilteredRequests: Map<datasetId, ChunkRequest[]>` (and same for proxies). The resend pass iterates all datasets. Or: per-dataset trackers entirely (see Seam F).

### Verified — `planningState` is not cleared on dataset removal (Pass 4 inline)

`planningState: Map<string, PlanningState>` is set per-dataset in `planAndFetch:634`. `clearMemberResources` (lines 1612-1638) does not delete from this map. So if a dataset is removed and re-added, the prior planning state (`previousActiveSet` etc.) survives.

This may be intentional (preserve hysteresis — though hysteresis lives in the planner's per-well state, not on the orchestrator) or a small leak.

**Suggested contract:** add `this.planningState.delete(id)` to `clearMemberResources` (or document the persist-across-removal behaviour).

### Verified — `workerWantedSet` is dead state (Pass 1 Risk B, Pass 4 #1)

`workerWantedSet: Map<string, Set<string>>` is declared at line 380 and populated in `handleWantedSetDelta` lines 1586-1596. Never read anywhere in the codebase (verified by grep).

CHUNK_PIPELINE.md line 230 claims `deliverToWorker` does "Filter to those in `workerWantedSet`" — the filter does not exist in code.

**Action:** either implement the filter (the doc-aligned behavior) or delete the field + the chunk-side branch in `handleWantedSetDelta` + fix the doc. **Choose at the Pass 8 sequencing step** — adding the filter changes upload behaviour (drains chunks the worker doesn't want any more get filtered), deleting the field is purely subtractive.

### Verified — `deliverySentToWorker.clear()` clears for ALL datasets each per-dataset rebuild (Pass 4 #4)

`planAndFetch:773` is `this.deliverySentToWorker.clear()` (no per-dataset key). It runs inside the per-dataset loop, after `sendColdState` for that dataset. So in a multi-dataset rebuild:

```
Dataset A: planning..., sendColdState(A), deliverySentToWorker.clear()  ← clears A AND B
Dataset B: planning..., sendColdState(B), deliverySentToWorker.clear()  ← clears B (already empty) + nothing for A
```

Effects:
- Cleared chunks from A re-upload on next `deliverToWorker`. Already-sent guard (line 1697) is reset by the clear, so any inbound duplicates re-up.
- The clear for B is a near-noop (only B's just-added entries from this same call would be present, which is none — `sendColdState` doesn't write to `deliverySentToWorker`).

So the clear is logically equivalent to "clear once at the top of the rebuild." Performing it per-dataset is wasteful but not wrong. After the Seam A split, this becomes "clear at the top of `Uploader.applyTick`" — a single explicit invariant.

**Suggested contract:** make the clear once-per-rebuild and document the invariant.

### Verified — `_lastEntities`, `_lastVisibleRegion`, `_lastCachedKeyCounts` are last-dataset-wins (Pass 1 K)

Same pattern as `_lastFilteredRequests`. These are debug-only (consumed in the `orchDebug` aggregation block). The "last dataset wins for activeSet — fine for single-dataset debug" comment (orchestrator.ts:836) acknowledges this. Multi-dataset debug is partially incorrect today.

**Suggested contract:** hold per-dataset, expose as a `Map<dsId, …>` to the debug aggregator. Or accept the limitation explicitly in the type.

## Per-method contract checklist

### `Orchestrator.deliverToWorker(ctx, budget, sliceZ): boolean`

**Signature:** `deliverToWorker(ctx: TickContext, budget: number, sliceZ: number | null): boolean`.

**Inputs:**
- `ctx: TickContext` — implicit dependencies bag. The method actually reads `ctx.scene.multi_channel()`, `ctx.cpuCache.drain/getCachedChunk/getCachedProxy`, `ctx.client.X`, `ctx.datasets`, `ctx.mode`. The full TickContext interface is wider; the function uses ~5 fields.
- `budget: number` — bytes. Soft cap (see below).
- `sliceZ: number | null` — only meaningful in slice mode; `null` for volume. Forwarded into `sendDeliveryToWorker` regardless of mode and asserted with `!`. **Implicit contract:** if `ctx.mode === "slice"`, then `sliceZ !== null`. Today this is enforced by call-site (slicePath always passes a number; volumePath always passes null). Not encoded in the type.

**Output:** `boolean` — `true` if either `deliveries.length > 0` (work done) or `budgetExhausted` (need another tick). Caller (`tickSlice` / `tickVolume`) returns this up to the renderLoop, which uses it to decide if another RAF should be scheduled.

The "or" is a loose contract — both conditions imply "schedule another tick" but they mean different things. A more honest return shape: `{ workDone: boolean, exhausted: boolean }` or `"idle" | "more-work-pending" | "budget-exhausted"`.

**Soft byte budget:** the method decrements `remaining` after each `sent > 0`. The check `if (remaining <= 0) { budgetExhausted = true; break; }` runs *after* the decrement. So a single oversize chunk overshoots the budget by `chunk_bytes - remaining`. With `MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 MB` and a 4 MB chunk, the actual upload could be up to 12 MB before the loop stops. Documented behavior in `UploadTickStats.budgetExhausted` (line 313-318: "NOT a function of bytesUploaded reaching bytesBudget…").

### `Orchestrator.handleChunksEvicted(workerMemberId, evicted, skipped, cpuCache): void`

**Signature:** `handleChunksEvicted(workerMemberId: string, evicted: string[], skipped: string[], cpuCache: CpuCache): void`.

**Implicit contract:** `cpuCache` argument duplicates the cache reference that's already on `TickContext`. Why is it a separate parameter? Looking at the call site (`renderLoop.ts:96`), the renderLoop owns the cpuCache reference and passes it explicitly:

```
this.client.onChunksEvicted = (datasetId, evicted, skipped) => {
  this.orchestrator.handleChunksEvicted(datasetId, evicted, skipped, this.session.cpuCache);
};
```

The orchestrator could hold its own `CpuCache` reference (passed at construction) and not need this argument. **Suggested contract:** drop the `cpuCache` parameter; inject at construction or via `applyTick(ctx)` style.

**Asymmetric branches:** `evicted` removes from BOTH `deliverySentToWorker` AND `deliveryRejectedByWorker` (acceptance proves deliverable); `skipped` removes from `deliverySentToWorker` BUT adds to `deliveryRejectedByWorker` AND notifies the cache. The two cases are different domains:

- **evicted** — atlas had it, then displaced; we may want it back (resend).
- **skipped** — atlas full + incoming farther than farthest existing; refusal upfront. Don't re-attempt under same camera.

The signature flattens both into `string[]`. A typed shape would be `EvictionReport = { evicted: ChunkRef[], skipped: ChunkRef[] }` — but TypeScript-side only.

### `Orchestrator.handleWantedSetDelta(missing): void`

**Signature:** `handleWantedSetDelta(missing: Array<MissingChunkLite | MissingProxyLite>): void`.

**Lite-alias issue** flagged above. The discriminated union shape is correct — the worker contract guarantees `kind: "chunk" | "proxy"` on each entry.

**The chunk branch updates `workerWantedSet` which nothing else reads.** This is a write-only mutation today. Either delete or implement.

### `Orchestrator.clearMemberResources(workerMemberId): void`

**Signature:** `clearMemberResources(workerMemberId: string): void`.

**The same string parameter encodes three different semantic id shapes:**
- A bare `imageId` (single-channel single dataset member).
- An `imageId:chN` composite (multi-channel member).
- A `datasetId` (whole-dataset cleanup).

The function defends against the ambiguity by:
- Direct-deleting from `deliverySentToWorker / deliveryRejectedByWorker / widToEntityId` (works for all three shapes).
- Best-effort-prefix-deleting from `proxyDeliveredToWorker` (matches dataset-shaped ids only, no-op for member-shaped ones).
- Direct-deleting from `lastViewEpochByDataset / debugStats.planning.byDataset / _lastPlanByDataset` (no-op for non-dataset shapes).

This pattern is "do everything, hope something matches." It works because each map's key shape doesn't overlap, but it's not a clean contract.

**Suggested contract:** two methods — `clearMember(workerMemberId)` and `clearDataset(datasetId)`. Caller picks based on what kind of id it has. Removes the shape-guessing.

### `Orchestrator.getTrackedMemberIds(): string[]`

Returns `[...this.deliverySentToWorker.keys()]`. The keys are workerMemberIds — but the consumer (`RenderLoop.collectMemberIds`) treats them as member-or-dataset ids and pattern-matches against a `${dsId}:` prefix. The function name and return type don't reveal that members may include "the dataset itself."

**Suggested contract:** rename to `getTrackedKeys()` (more honest about not knowing the shape) or expose two methods (`getTrackedMembers(dsId): string[]` and `getTrackedDatasetIds()`).

### `Orchestrator.getProxyDeliveredKeys(): Set<string>`

`@internal`. Returns the live private Set; mutations on the Set affect the orchestrator. Tests use this to assert + manipulate state directly. Acceptable for a typed test backdoor; would be friendlier as `Readonly<Set<string>>` (not enforced at runtime, but signals intent).

## RenderClient method contracts

### `RenderClient.sliceChunkData` and `volumeChunkData`

Both take long positional arg lists (14 and 12 args respectively). The contract for "what's in the chunk array" is that `chunks: SliceChunk[]` (or `VolumeChunk[]`) — but **the orchestrator only ever sends an array of one** (line 1712 / 1720: `[chunkData]`). The plural shape is vestigial.

**`SliceChunk` and `VolumeChunk` are structurally identical:**

```ts
interface SliceChunk  { data: ArrayBuffer; dataType: string; x,y,z: number; key: string }
interface VolumeChunk { data: ArrayBuffer; dataType: string; x,y,z: number; key: string }
```

Identical fields. The only reason to have two types is historical or to mark the *destination context*. Either fold into one (`Chunk`) or differentiate by adding a discriminator (which would let the type system tell them apart at usage sites).

**`dataType: string`** — a string instead of a union. Could be tightened to `"uint8" | "uint16" | "u16" | ...` (the worker accepts whatever shows up; current production values are `"uint8"` and `"uint16"`).

### `RenderClient.proxyAssetData`

Hard-coded `dataType: "u16"` in the body (line 185). The `ProxyAssetDataMessage.dataType` type is `"u16"` (a literal type, line 93 of workerProtocol.ts) — so the contract is pinned at the worker side. Today the parser only accepts dtype code 0 = u16, so this is consistent. Both sides should change together if a second dtype lands.

**Lossy:** the orchestrator passes `delivery.header` (with parsed dtype) into `sendProxyDeliveryToWorker`, but `RenderClient.proxyAssetData` only takes `dims` from the header. The dtype is dropped at the boundary because the contract says "u16."

**Suggested contract:** either tighten everything to `"u16"` literal, or pipe `delivery.header.dtype` through and drop the hard-code. Pick when the second dtype lands.

### `RenderClient.coldState(msg)` and `viewHotState(msg)`

Both take fully-built messages. Healthy delegation; the message types are explicit.

### `RenderClient.onChunksEvicted` and `onWantedSetDelta` callback fields

Public assignable fields, not subscribers. Callback-overwrite contract:

```
onChunksEvicted: ((datasetId: string, evicted: string[], skipped: string[]) => void) | null
onWantedSetDelta: ((epochs: SceneEpochs, missing: Array<...>) => void) | null
```

`onChunksEvicted` doesn't pass `epochs`; `onWantedSetDelta` does. **Asymmetry.** The worker passes `epochs` on `wantedSetDelta` (line 217 of `gpu.worker.ts`: `post({ type: "wantedSetDelta", epochs: currentEpochs, ... })`) and on `chunksEvicted` (would need to verify but probably `currentEpochs` similarly) — `onMessage` extracts it but only forwards on the wanted-set callback.

The orchestrator's `handleChunksEvicted` doesn't use epochs today. So the absence is harmless. But it's a contract asymmetry.

## CpuCache surface used by the upload phase

The upload phase calls a 5-method subset of `CpuCache`:
- `submit(plan)` — writes (per dataset, in `planAndFetch`).
- `drain(budget): ReadyDelivery[]` — reads + advances ready queue.
- `getCachedChunk(entityId, chunkKey): ReadyChunkDelivery | null` — read.
- `getCachedProxy(datasetId, entityId, kind, t, c): ReadyProxyDelivery | null` — read.
- `markRejected(entityId, chunkKey)` — write (from `handleChunksEvicted`).
- `clearRejected()` — write (from `planAndFetch:576`).

Plus `snapshot()` (used by both planning telemetry — `:624` — and DebugOverlays).

**Implicit contracts in this subset:**

- **`drain(budget)`** — no documented stop condition. From the cpuCache implementation it returns "as many ready entries as fit within `budgetBytes`." But the orchestrator's caller already implements a soft byte budget; the cache's budget is a separate notion. Two byte-budgets in series; only the cache's is a hard stop.
- **`getCachedChunk` returns `ReadyChunkDelivery | null`** — `null` if the chunk isn't in the cache. Doesn't distinguish "never fetched" vs "evicted" vs "fetched but failed." The resend pass treats `null` as "skip" without escalation — appropriate, but the contract loses information.
- **`markRejected(entityId, chunkKey)`** — no observable effect at call time; just sets a flag. The next `submit()` will dedup against this set. Implicit ordering: must be called before the next submit referencing this chunk.
- **`clearRejected()`** — wipes ALL rejection markings, no per-dataset / per-entity scope. The orchestrator calls it on every cold-state rebuild. There's no "rejection reason expired" semantics.

## Worker protocol contracts (`workerProtocol.ts`)

### `MissingChunk` lacks `datasetId`; `MissingProxy` has it (asymmetry)

```ts
type MissingChunk = { kind: "chunk"; entityId: string; chunkKey: string };
type MissingProxy = { kind: "proxy"; datasetId: string; entityId: string; proxyKind, t, c };
```

The proxy variant carries `datasetId` so the orchestrator can index `proxyDeliveredToWorker` by composite key without scanning. The chunk variant doesn't carry it because the (dead) chunk consumer indexes by `entityId` directly.

If the chunk-wanted-set filter ever lands (Pass 8 decision), it would need to look up `cpuCache.getCachedChunk(entityId, chunkKey)` — entityId alone is enough. So the absence is consistent with the (intended-but-dead) consumer.

**Pass 8 decision point:** if implementing the filter, the contract is fine. If deleting `workerWantedSet`, the chunk variant's existence is even more questionable.

### `ColdStateActiveEntry.parentWellId?: string | null`

Both `undefined` and `null` are valid. From the cold-state builder (line 1911-1912):

```ts
const parentWellId = entity?.kind === "Field" ? entity.parentId : null;
```

So the value is always a string or `null` — never `undefined`. The `?:` makes `undefined` valid in the type but unreachable in practice. Mild contract sloppiness.

**Suggested contract:** `parentWellId: string | null` (drop the `?`). Removes one inhabitant of the type that nothing produces.

### `ColdStateActiveEntry.proxyKind?: "WellProxy3D" | "FieldProxy3D"`

Optional. From the builder:
- `well-as-proxy` → `proxyKind: "WellProxy3D"` (always set).
- `invisible` → `proxyKind: undefined` (line 1953).
- `field` → forwards `entry.proxyKind` (which is `proxyKind: "FieldProxy3D" | undefined` from the planning ActiveSetEntry).

So `undefined` is reachable for invisibles and for fields without a proxy. The contract honestly reflects "this entry has no preferred proxy kind." OK.

### `ColdStateMessage.viewMode: "slice" | "volume"` AND `Orchestrator.sendDeliveryToWorker` branches on `ctx.mode`

Two sources of truth for view mode within the same tick:
- The cold state carries `viewMode` (from `selection.renderMode` — `sendColdState:1989`).
- The chunk-data dispatch reads `ctx.mode` directly (`sendDeliveryToWorker:1660`).

If these two ever disagreed, the orchestrator would dispatch on `ctx.mode` but the worker would have the active set sized for the cold state's `viewMode`. They can't disagree today because both ultimately come from the same renderLoop construction (`ctx.mode === "slice" | "volume"` from `RenderLoopOptions.mode`, and `selection.renderMode` is built from `getSceneSettings(ctx.scene)` reading the same WASM state). But the contract has redundant fields.

**Suggested contract:** the cold state's `viewMode` is authoritative; the chunk-data dispatch reads it from there, not from `ctx.mode`. Or remove `viewMode` from cold state if it's derivable elsewhere on the worker side.

### `SceneEpochs` flows through every chunk/proxy/cold/view-hot message

Stamped on the way out, stamped on the way back. The worker drops stale deliveries (`gpu.worker.ts:272`: `if (isStaleDelivery(msg.epochs, currentEpochs)) { ... return; }`).

This is a real, working contract. The worker tracks `currentEpochs` from the most recent `coldStateMessage` and compares incoming chunks/proxies against it. Stale = older epoch on a higher-priority axis. The check happens before the GPU upload, so stale deliveries don't waste bandwidth on writeTexture.

**Suggested contract test:** a mock worker that explicitly drops a stale chunk; orchestrator should not see any acknowledgment, but cpu cache shouldn't release the buffer. (Pass 7 testability.)

### `ChunksEvictedMessage.skipped?: string[]` is optional

Optional with default `[]`. The renderClient code (`renderClient.ts:61`) handles the absence: `this.onChunksEvicted(msg.datasetId, msg.keys, msg.skipped ?? [])`. Acceptable; signals "older worker builds don't send `skipped`."

## TickContext as a shared dependency bag

```ts
interface TickContext {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
  renderScale: number;
  cpuCache: CpuCache;
  assetCatalog: AssetCatalog;
}
```

Eight fields. The upload phase uses: `scene` (model matrix + ray hit + multi_channel + epochs), `datasets` (manifest scan in sendDeliveryToWorker), `client` (every send), `mode` (chunk dispatch branch), `cpuCache` (drain + cached lookups + markRejected + clearRejected). It does NOT use `canvas`, `renderScale`, `assetCatalog`.

So the upload phase has a 5-field implicit contract while consuming an 8-field type. The unused fields are paid for in test setup (`orchestrator.test.ts:625-645` constructs every field even when most aren't read).

**Suggested contract:** narrow `TickContext` for upload-phase methods (e.g., `UploadContext` extends a subset). Or skip the bag and accept individual deps.

## Pure-function candidates locked inside methods

These are pieces of the upload phase that are pure (no I/O, no shared state) but currently live inside larger methods:

- The drain-pass filter (lane / target-LOD checks).
- The resend-pass dedup checks.
- The cold-state per-entry mapping.
- The composite-key composers.
- The well roster synthesis.
- The scissor-rect projection (`volumePath.computeScissorRect`).
- The model-matrix identity factory.
- The viewport / ray-hit fan-out in `sendViewHotState`.

Each is a contract candidate: explicit input, explicit output, no environment. Pass 6 (Composability) will pick them up.

## Hidden assumptions surfaced this pass

1. **`SliceChunk` ≡ `VolumeChunk` structurally; the duplication is vestigial.** Fold into one type or add a discriminator.

2. **`chunks: SliceChunk[]` / `VolumeChunk[]` arrays carry exactly one element from the orchestrator.** The plural shape is vestigial. Either drop the array (`chunk: SliceChunk`) or batch multiple per call.

3. **`workerMemberId: string` is overloaded** — bare imageId, composite, dataset id. No type help.

4. **`sliceZ` is `number | null` but always non-null in slice mode.** Encoded by call-site, not by type.

5. **Soft byte budget** — `deliverToWorker` overshoots by up to one chunk size. Documented in `UploadTickStats`.

6. **`drain(budget)` and `deliverToWorker(ctx, budget)` use the same number for two different soft caps.** Both can over-deliver.

7. **`ChunksEvictedMessage` carries `currentEpochs` but the renderClient drops them before invoking `onChunksEvicted`.** Verify if `chunksEvicted` actually has epochs in its envelope and if so whether the orchestrator needs them. (Worth tracing in Pass 7.)

8. **`MissingChunk` and `MissingProxy` carry different field sets** — proxy has datasetId, chunk doesn't. Asymmetry justified by today's consumers but should be revisited if the chunk-side filter lands.

9. **`ColdStateMessage.viewMode` and `ctx.mode` are two sources of truth for the same value.**

10. **`parentWellId?: string | null` allows three states; the producer only emits two.**

11. **`ColdStateActiveEntry.modelMatrix` and `invModelMatrix` are `Float32Array` (no length encoded).** The worker assumes 16; the producer always emits 16. Mild.

12. **`CpuCache.snapshot()` returns `{ cached: Map<string, Set<string>>, inFlight: ... }`.** Used by both planning telemetry and orchestrator. Mutability of the returned shapes is unspecified.

13. **`getCachedChunk(entityId, chunkKey)` returns `ReadyChunkDelivery | null`** — null is overloaded across "evicted," "never fetched," "fetched but failed." Lossy, but appropriate for the resend pass.

14. **`epochs` field on `MissingProxy` (via `WantedSetDeltaMessage`) — the orchestrator doesn't pass through to `cpuCache.getCachedProxy`.** Probably benign; verify whether the cache's hit could be stale.

## Severity ranking

| Contract issue | Severity | Why |
|---|---|---|
| `_lastFilteredRequests` last-dataset-wins | High | Real multi-dataset bug in the resend pass |
| `_lastProxyRequests` last-dataset-wins | High | Same shape |
| `workerWantedSet` dead state vs documented filter | High | Doc says one thing, code does another; need a decision in Pass 8 |
| `MissingChunkLite` / `MissingProxyLite` aliasing | High (low risk, high cleanup signal) | Pure rename; clean up before relying on the typenames |
| `clearMemberResources` shape ambiguity | Medium-high | "find every map and remove" symptom of a missing typed-id system |
| `SliceChunk` ≡ `VolumeChunk` duplication | Medium | Mechanical type fold |
| `chunks: X[]` arrays for single-item callers | Medium | Tighten or batch — pick one |
| `sliceZ: number \| null` for cross-mode helper | Medium | Tighten via per-mode helpers |
| `handleChunksEvicted(cpuCache)` redundant param | Medium | One-line drop after orchestrator holds its own ref |
| `RenderClient.proxyAssetData` hard-codes `"u16"` | Medium | Pinned at worker; revisit when 2nd dtype lands |
| `ColdStateMessage.viewMode` vs `ctx.mode` | Medium | Two sources of truth |
| `planningState` not cleared on member removal | Medium | Possible small leak on dataset re-add |
| Soft byte budget overshoot | Low | Documented; OK |
| `parentWellId?: string \| null` (three states for two values) | Low | Type cleanup |
| Wide TickContext for narrow consumer | Low | Test friction; helpful but optional |
| `getProxyDeliveredKeys` returns mutable | Low | Test backdoor; document |
| Optional `skipped?` on `ChunksEvictedMessage` | Low | Backwards-compat guard |
| `ChunksEvictedMessage` epochs parameter asymmetry | Low | Verify existence + need; likely no-op |

## Next pass

Pass 6 (Composability Scan) extracts the pure-function candidates flagged above and identifies what other reusable pieces are trapped inside the orchestrator's large methods.
