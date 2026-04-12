# Orchestrator Integration Spec

How the Planning domain gets wired into the live render loop, and the incremental migration path from the current monolithic pipeline to the DOMAINS.md architecture.

This spec does not re-define domain boundaries or contracts — DOMAINS.md is authoritative for that. This spec covers **how we get from here to there**: the adapter surface, the migration sequence, what gets deleted when, and what you can visually verify at each step.

---

## 1. System Identity

A thin **Orchestrator** that replaces the current `tickCommon.planAndFetchForDatasets()` planning path with the new `plan()` pure function from `pipeline/planning.ts`. The Orchestrator assembles a `PlanningSnapshot` from live WASM scene state and existing infrastructure, invokes `plan()`, and translates the `RequestPlan` output back into types the existing upload/render pipeline consumes.

The Orchestrator is the integration seam. It starts thin — adapting new Planning to old infrastructure — then becomes the coordination point as underlying layers (CPU Cache, Worker Protocol, GPU Residency, Rendering) are replaced one at a time.

---

## 2. Scope

### In scope (M0 — thin Orchestrator)

- Orchestrator class with `previousActiveSet` state
- Snapshot assembly: WASM queries + cache state + selection → `PlanningSnapshot`
- Single `plan()` invocation per planning cycle (all visible channels in one call)
- Output translation: `RequestPlan` → `MemberChunkPlan[]` adapter for `uploadCommon`
- `getCachedKeys(memberId): Set<string>` addition to `SharedChunkQueue`
- Epoch-based plan caching (skip `plan()` when no relevant epochs changed)
- Hard cutover: delete `evaluateChunkPlanFor` callers, `chunkPlan.ts` WASM wrapper, `planCacheKey` logic in slicePath/volumePath
- Fetch submission: convert `ChunkRequest[]` → `QualifiedChunkCoord[]` for `SharedChunkQueue.ensureFetched()`

### In scope (migration roadmap M1–M4)

- Sequencing, visual verification criteria, and deletion targets for each swap
- Boundary formalization as each layer is replaced

### Out of scope

- **Presentation Overlay / Asset Catalog** — orthogonal, slots into the Orchestrator's snapshot assembly when needed (see D12)
- **Collaboration changes** — no impact on collaboration protocol
- **Server-side changes** — Orchestrator is client-only
- **Implementation specs for M1–M4** — each gets its own spec when the time comes
- **Minimap planning** — continues using its existing path, appends fetch lists to `SharedChunkQueue` directly (see D11)

---

## 3. File Layout

### New files

```
lucida-web/src/
  pipeline/
    planning.ts          # (exists) Pure plan() function
    orchestrator.ts      # NEW — Orchestrator class
```

### Modified files

```
lucida-web/src/
  zarr/chunkStore.ts     # Add getCachedKeys() to SharedChunkQueue
  slicePath.ts           # Replace planAndFetchSlice → Orchestrator.planAndFetch()
  volumePath.ts          # Replace planAndFetchVolume → Orchestrator.planAndFetch()
  renderLoop.ts          # Create + hold Orchestrator instance
```

### Deleted files (at M0 cutover)

```
lucida-web/src/
  zarr/chunkPlan.ts      # evaluateChunkPlanFor wrapper — replaced by Planning
```

### Deleted exports (at M0 cutover)

- `tickCommon.planAndFetchForDatasets()` — replaced by Orchestrator
- `tickCommon.evaluateAndSortPlans()` — replaced by Planning
- `tickCommon.buildMemberFetchList()` — replaced by Planning's lane-based output
- `tickCommon.interleaveFetchLists()` — replaced by Orchestrator's fetch submission
- `slicePath.planAndFetchSlice()` — inlined into Orchestrator call
- `volumePath.planAndFetchVolume()` — inlined into Orchestrator call
- WASM `chunk_plan_for()` — no longer called from TypeScript (Rust function can remain for CLI/Python use)

### Retained (unchanged)

- `tickCommon.ts` — settings cache (`getSceneSettings`), multi-channel helpers (`compositeKey`, `parseChannel`, `getActiveChannels`, `flipY`) remain. Plan+fetch skeleton deleted.
- `uploadCommon.ts` — entirely unchanged. Consumes `MemberChunkPlan[]` as before.
- `renderLoop.ts` — RAF scheduling and dirty flags unchanged. Holds Orchestrator instance.

---

## 4. Data Model

### Input: PlanningSnapshot (assembled by Orchestrator)

The Orchestrator assembles this from existing infrastructure. Each field and its source:

```
PlanningSnapshot
├── epochs ──────────────── scene.epochs()  [WASM]
├── entities ────────────── scene.view_query(dsId)  [WASM, per dataset]
├── visibleRegion ───────── scene.visible_region(dsId)  [WASM]
├── selection
│   ├── t ───────────────── scene.t()
│   ├── c ───────────────── scene.c()
│   ├── z ───────────────── scene.z()
│   ├── visibleChannels ─── getActiveChannels(dsSettings)  [tickCommon]
│   ├── renderMode ──────── ctx.mode  [TickContext]
│   └── interactionState ── "idle"  [stub, future: from input handler]
├── cacheState
│   └── cached ──────────── sharedQueue.getCachedKeys(memberId)  [NEW method]
├── workerWantedSet
│   └── resident ────────── Map()  [stub until M3]
├── previousActiveSet ───── orchestrator.previousActiveSet  [own state]
└── assetCatalog ────────── null  [stub until Asset Catalog is built]
```

### Output: RequestPlan (from plan())

```
RequestPlan
├── requests: ChunkRequest[]     # Priority-ordered across all lanes
├── activeSet: ActiveSetEntry[]   # LOD state for next frame's hysteresis
└── epochs: PlanningEpochs        # Bumped requestEpoch
```

### Adapter output: MemberChunkPlan[] (for uploadCommon)

The Orchestrator translates `RequestPlan` into the shape `uploadCommon` expects:

```typescript
// Orchestrator groups ChunkRequests by entity, splits by lane:
//   detail-lane requests → MemberChunkPlan.needed
//   runway-lane requests → MemberChunkPlan.prefetch
//   overview-lane requests → separate MemberChunkPlan entries
//
// Entity positions come from EntitySnapshot.position
```

This adapter is **interim scaffolding** — it exists only because uploadCommon has not been replaced yet. It is deleted at M2 when CPU Cache replaces the fetch/upload path.

---

## 5. Core Architecture

### Orchestrator class

```typescript
class Orchestrator {
  private previousActiveSet: ActiveSetEntry[] = [];
  private cachedPlan: RequestPlan | null = null;
  private lastEpochs: PlanningEpochs | null = null;

  /**
   * Assemble snapshot, invoke plan() if epochs changed, translate output.
   *
   * Called from slicePath/volumePath in place of planAndFetchForDatasets().
   * Returns the shape uploadCommon expects (memberPlanCache + settings).
   */
  planAndFetch(
    ctx: TickContext,
    minimapPendingFetch: Map<string, ChunkCoord[]>,
  ): { memberPlanCache: Map<string, MemberChunkPlan[]>; settings: SceneSettings } | null;
}
```

### Frame flow (after M0)

```
RAF tick (renderLoop.ts)
  │
  ├─ orchestrator.planAndFetch(ctx, minimapPendingFetch)
  │   ├─ Set scene params (viewport, Z, T, C)
  │   ├─ Read epochs from WASM
  │   ├─ If epochs unchanged → return cached plan translation
  │   ├─ Assemble PlanningSnapshot
  │   │   ├─ scene.view_query(dsId) → EntitySnapshot[]
  │   │   ├─ scene.visible_region(dsId) → VisibleRegion
  │   │   ├─ getActiveChannels() → visibleChannels
  │   │   ├─ sharedQueue.getCachedKeys() → CacheStateSnapshot
  │   │   └─ this.previousActiveSet
  │   ├─ plan(snapshot) → RequestPlan
  │   ├─ this.previousActiveSet = requestPlan.activeSet
  │   ├─ this.cachedPlan = requestPlan
  │   ├─ Translate RequestPlan → MemberChunkPlan[] (adapter)
  │   ├─ Convert ChunkRequest[] → QualifiedChunkCoord[]
  │   ├─ sharedQueue.ensureFetched(qualifiedCoords)
  │   └─ Return { memberPlanCache, settings }
  │
  ├─ uploadAndRenderSlice/Volume(ctx, state, ..., planResult)
  │   └─ (unchanged — consumes memberPlanCache as before)
  │
  └─ Minimap tick (unchanged — appends its own fetch list directly)
```

### What changes in slicePath.ts / volumePath.ts

The `planAndFetchSlice()` / `planAndFetchVolume()` functions are replaced by a single call to `orchestrator.planAndFetch()`. The upload+render functions (`uploadAndRenderSlice`, `uploadAndRenderVolume`) are unchanged — they receive the same `memberPlanCache` shape they always have.

Before:
```typescript
// slicePath.ts
function tickSlice(ctx, state, z, t, c, minimapPendingFetch) {
  const planResult = planAndFetchSlice(ctx, state, z, t, c, minimapPendingFetch);
  return uploadAndRenderSlice(ctx, state, z, t, c, planResult);
}
```

After:
```typescript
// slicePath.ts
function tickSlice(ctx, state, orchestrator, minimapPendingFetch) {
  const planResult = orchestrator.planAndFetch(ctx, minimapPendingFetch);
  return uploadAndRenderSlice(ctx, state, sliceZ, sliceT, sliceC, planResult);
}
```

### Epoch-based plan caching

The Orchestrator compares the current WASM epochs against the last epochs used for planning. If none of the relevant epochs have changed, `plan()` is not called — the cached `RequestPlan` translation is returned directly.

Relevant epochs for replanning:
- `contentEpoch` — dataset added/removed
- `layoutEpoch` — layout changed
- `viewEpoch` — camera moved enough to change visibility/LOD
- `selectionEpoch` — T/C/Z or channel visibility changed

Cache state changes (new chunks arrived) do **not** trigger replanning — they trigger re-upload via the existing `dataDirty` flag and the upload phase pulls from `SharedChunkQueue` as before.

### SharedChunkQueue.getCachedKeys()

New boundary method on `SharedChunkQueue`:

```typescript
class SharedChunkQueue {
  /** Return the set of cached chunk keys for a member. */
  getCachedKeys(memberId: string): Set<string> {
    const memberCache = this.cache.get(memberId);
    if (!memberCache) return new Set();
    return new Set(memberCache.keys());
  }
}
```

This is queried by the Orchestrator during snapshot assembly and passed into `PlanningSnapshot.cacheState.cached` as an immutable snapshot. Planning uses it to skip already-cached chunks in `iterateChunks()`.

---

## 6. Migration Roadmap

### M0: Orchestrator + Planning live

**What:** Replace `tickCommon` planning with Orchestrator → `plan()` → adapter → existing upload/render.

**Changes:**
- New `pipeline/orchestrator.ts`
- `getCachedKeys()` on SharedChunkQueue
- slicePath/volumePath call `orchestrator.planAndFetch()` instead of `planAndFetchSlice/Volume()`
- Delete: `chunkPlan.ts`, `planAndFetchForDatasets()`, `evaluateAndSortPlans()`, `buildMemberFetchList()`, `interleaveFetchLists()`

**Visual verification:**
- Zoom in on a well: detail chunks load at the correct LOD (not just the coarsest level)
- Zoom out: entities demote to overview, detail chunks stop loading
- Promotion hysteresis: zoom slowly through the 40–80px band — no rapid flicker between overview and detail
- Three-lane loading: detail chunks for the focused entity load before runway (T+1/T+2) chunks
- Temporal runway: scrub T, then pause — next T's chunks are pre-warmed
- Multi-channel: all visible channels load with correct LOD selection
- Plate datasets: spatial culling — off-screen wells don't generate fetch requests

**Deleted code:** `chunkPlan.ts`, old planning callers in tickCommon, planCacheKey logic in slicePath/volumePath.

---

### M1: Worker Protocol formalization

**What:** Replace ad-hoc `postMessage` calls with typed message shapes carrying epoch tags. Same pixels, better correctness guarantees.

**Replaces:** Direct `client.sliceChunkData()` / `client.volumeChunkData()` calls with epoch-tagged protocol messages.

**Visual verification:**
- Scrub T rapidly — no stale-T frames flash on screen (epoch-tagged deliveries dropped if stale)
- Normal rendering unchanged

**Deletion target:** Ad-hoc message construction in renderClient.ts, replaced by typed protocol layer.

---

### M2: CPU Cache replaces SharedChunkQueue + uploadCommon

**What:** Domain-separated cache with content source abstraction. The Orchestrator passes `RequestPlan` directly to CPU Cache instead of going through the `MemberChunkPlan` adapter.

**Replaces:** `SharedChunkQueue`, `uploadCommon.ts`, the `MemberChunkPlan` adapter in the Orchestrator.

**Visual verification:**
- Same fetch behavior: concurrent requests, abort-on-view-change, LRU eviction
- Cache state now queryable by Planning directly (no `getCachedKeys` adapter needed)
- Fetch concurrency and spatial priority preserved

**Deletion target:** `SharedChunkQueue`, `uploadCommon.ts`, `MemberChunkPlan` type, Orchestrator's `RequestPlan → MemberChunkPlan` adapter.

---

### M3: GPU Residency

**What:** Atlas pools keyed by physical params, page table, wanted-set reporting back to main thread.

**Replaces:** Worker-side atlas management, `sentToWorker` tracking on main thread.

**Visual verification:**
- Same rendering, but wanted-set deltas flow from worker → Orchestrator → Planning snapshot
- `workerWantedSet` in PlanningSnapshot is real data instead of stub
- Multi-LOD entities: pages land in correct pools when chunk shape varies by level

**Deletion target:** `sentToWorker` in UploadState, worker-side ad-hoc atlas allocation, `chunksEvicted` message handling.

---

### M4: Rendering — semantic fallback chain

**What:** Progressive LOD with the full fallback chain: target LOD → coarser detail → overview proxy → nothing.

**Replaces:** Current single-LOD rendering (one atlas config per entity).

**Visual verification:**
- Zoom into a well: coarse detail LOD appears instantly (seed), refines progressively as finer pages arrive
- Overview is fallback below the detail-owned range, not a separate system
- Pan across a plate: newly visible wells show overview immediately, promote to detail as they grow on screen

**Deletion target:** Single-LOD atlas config messages, replaced by multi-LOD page table + descriptor system.

---

### Asset Catalog (orthogonal)

Asset Catalog is not sequenced in M0–M4 because it is **orthogonal** — it slots into the Orchestrator's snapshot assembly whenever proxy products or derived layouts are needed. Per DOMAINS.md, it should be built alongside the Orchestrator, not after it. Until then, `assetEpoch` remains 0 and `assetCatalog` remains null in the PlanningSnapshot.

---

## 7. Testing Strategy

### M0 testing

**Unit tests (vitest):**
- Planning already has 27 tests with synthetic snapshots — these are unaffected
- New tests for the Orchestrator:
  - Snapshot assembly: verify PlanningSnapshot is correctly built from mock WASM + cache state
  - Adapter translation: verify `RequestPlan → MemberChunkPlan[]` grouping and lane → needed/prefetch mapping
  - Epoch caching: verify `plan()` is skipped when epochs are unchanged
  - Epoch caching: verify `plan()` is called when any relevant epoch changes

**Visual testing (browser):**
- The verification criteria listed for M0 above — each is a manual visual check
- Debug panel: Planning tab already shows live PlanningSnapshot → RequestPlan output; verify it matches what actually renders

**Regression:**
- Existing rendering must not degrade — same datasets, same camera positions, same visual output
- Multi-channel rendering must work identically
- Minimap must continue working (it bypasses the Orchestrator)

### M1–M4 testing

Each migration step gets its own test plan when its spec is written. The visual verification criteria above define what "correct" looks like at each step.

---

## 8. Decision Log

| # | Decision | Rationale |
|---|---|---|
| D1 | Replace `tickCommon.planAndFetchForDatasets()`, keep uploadCommon and renderLoop as-is | tickCommon is exactly where chunk planning + fetch scheduling happens. Upload and render don't need to change yet. Smallest possible insertion point. |
| D2 | Hard cutover — old planning path deleted at M0 | Planning has 27 unit tests and a live debug panel. No value in maintaining two planning paths. Coexistence adds complexity without benefit. |
| D3 | Orchestrator is a lightweight class holding `previousActiveSet`, not extending UploadState | `previousActiveSet` is planning hysteresis state, not I/O state. The Orchestrator will accumulate more dependencies as layers are swapped in — a class gives that state a natural home. DOMAINS.md confirms: Orchestrator assembles snapshots, previousActiveSet is an input to Planning via PlanningSnapshot. |
| D4 | Add `getCachedKeys(memberId): Set<string>` to SharedChunkQueue | Planning needs cache state to skip already-cached chunks. This is a CPU Cache boundary query (per DOMAINS.md 6.0: Orchestrator reads from CPU Cache during snapshot assembly). Querying CPU cache, not GPU residency — the correct layer. |
| D5 | Orchestrator calls `plan()` once with all visible channels in SelectionState | Planning's `iterateChunks()` already iterates `selection.visibleChannels` internally. Per-channel Orchestrator iteration was cargo-culted from the old `scene.set_c(ch)` loop which is part of the replaced planning path. DOMAINS.md expects Planning to receive a complete snapshot. |
| D6 | Reconstruct `MemberChunkPlan` from `RequestPlan` as interim adapter | Keeps uploadCommon untouched — the Orchestrator is purely an adapter. MemberChunkPlan is an Orchestrator-owned adapter type, not a CPU Cache type. Deleted at M2 when CPU Cache replaces uploadCommon. |
| D7 | Migration sequence: M0 → M1 → M2 → M3 → M4 | Get Planning driving pixels first (M0), then formalize the boundaries it talks through (M1 protocol, M2 cache), then upgrade the GPU side (M3 residency, M4 rendering). Each step is visually testable. |
| D8 | Delete `chunkPlan.ts` callers and planCacheKey logic at M0 | Hard cutover (D2). WASM `chunk_plan_for()` Rust function may remain for CLI/Python use — only the TypeScript callers are deleted. |
| D9 | Single Orchestrator instance for both slice and volume paths | Planning is view-mode-agnostic — `VisibleRegion` encodes 2D vs 3D in its data (frustum planes present/absent). DOMAINS.md describes one Orchestrator, not per-view-mode variants. |
| D10 | Dirty flags drive RAF scheduling; epochs drive plan caching inside Orchestrator | Complementary, not competing. Dirty flags answer "should we call the Orchestrator this frame?" Epochs answer "should the Orchestrator re-run plan()?" DOMAINS.md says epochs are the primary *correctness* mechanism — dirty flags are a scheduling mechanism. Dirty flags go away when the full Orchestrator lifecycle (DOMAINS.md step 7) is built. |
| D11 | Minimap stays outside Orchestrator | Minimap is a separate viewport concern with its own coarse chunk needs. It continues appending fetch lists to SharedChunkQueue directly. Can be folded in later if needed. Not addressed in DOMAINS.md. |
| D12 | Asset Catalog is orthogonal, slots in alongside Orchestrator | Per DOMAINS.md, Presentation Overlay + Asset Catalog should be built alongside the Orchestrator (step 6), not deferred after it. `assetEpoch` is already a forward-compatible placeholder (0) in Planning. Asset Catalog plugs into snapshot assembly when proxy products are needed. |

---

## 9. Conformance Notes

This spec was checked against DOMAINS.md for alignment. Key conformance points:

- **Orchestrator does not own policy** (D1, D3) — it coordinates. Planning owns promotion/scheduling decisions.
- **Planning remains a pure function** (D5) — receives complete PlanningSnapshot, returns RequestPlan. No side-channel reads.
- **previousActiveSet flows through PlanningSnapshot** (D3) — Orchestrator holds it but passes it as an input, per DOMAINS.md 6.1.
- **Cache state is a boundary query** (D4) — Orchestrator queries SharedChunkQueue during snapshot assembly, per DOMAINS.md 6.0.
- **No disallowed dependencies** — Orchestrator reads from Scene State and CPU Cache (allowed), invokes Planning (allowed), feeds results to CPU Cache via upload path (allowed).
- **Ownership and replication rule** — previousActiveSet is an immutable snapshot. Cache state is an immutable snapshot. No mutable authoritative state crosses domain boundaries.
- **WASM output boundary** — Rust/WASM emits compact `ViewQueryResult` and `VisibleRegion`. TypeScript (Planning) expands into requests using cache state and selection. No chunk plans cross the WASM boundary.
- **Epoch-based correctness** — epochs drive replanning decisions. Stale plans are not re-applied. Future protocol formalization (M1) will add epoch tags to data deliveries.
