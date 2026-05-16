# Pass 8: Refactor Sequencing — render phase

Goal: turn the findings from passes 1–7 into an ordered, incremental plan. Mirrors the cadence of the planning, fetch, and upload refactors (each one a `pipeline/{phase}/` carve in many small slices).

## Guiding constraints

- Each slice should land independently and pass the existing test suite.
- Tests land **before** structural change wherever possible — but pure-extraction slices can land first since their tests live with them.
- Renames + boundary cleanups go first (low risk, high payoff in clarity).
- The 200-line cold-state block is the centerpiece; everything else clusters around it.
- Don't ship a `RenderClient` interface split (analogous to upload's `UploadClient`) until/unless a real second renderer implementation becomes plausible.

## Slice 0 — Directory scaffold

Create the layout the later slices will fill:

```
renderer/
  chunkKeys.ts          ← new (Seam I, Composability Unit 6)
  poolKeys.ts           ← new (Seam H, Contract Issue 4)
  descriptor/
    layout.ts           ← new (Seam F, Contract Issue 1)
    transient.ts        ← new (Seam K, where setTransientDescriptor goes)
  coldState/
    groupEntries.ts     ← new (Seam A, Composability Unit 1)
    entityMetas.ts      ← new (Seam A, Composability Unit 2)
    apply.ts            ← new (Seam A — orchestrator entry)
    memberRegistry.ts   ← new (Seam C)
  proxy/
    upload.ts           ← new (Seam D)
    propagate.ts        ← new (Composability Unit 10)
  volume/
    atlas.ts            ← from volumeHandlers.ts
    remap.ts            ← from volumeHandlers.ts
    upload.ts           ← from volumeHandlers.ts
    eviction.ts         ← from volumeHandlers.ts
    render.ts           ← from volumeHandlers.ts
  slice/
    atlas.ts            ← from sliceHandlers.ts
    remap.ts            ← from sliceHandlers.ts
    upload.ts           ← from sliceHandlers.ts
    eviction.ts         ← from sliceHandlers.ts
    render.ts           ← from sliceHandlers.ts
    zRetarget.ts        ← from sliceHandlers.ts
  worker/
    bootstrap.ts        ← from gpu.worker.ts (initGPU + ctx assembly)
    dispatch.ts         ← from gpu.worker.ts (message switch)
    resources.ts        ← from gpu.worker.ts (LUT, offscreen pool, dummies)
    devtools.ts         ← from gpu.worker.ts (self.__lucidaXxx)
    lifecycle.ts        ← from gpu.worker.ts (destroy)
    state.ts            ← new (the Maps as a ctx-owned object)
```

Empty placeholder files in this slice; subsequent slices fill them.

**Risk:** none. Pure scaffolding.

## Slice 1 — Clarify: renames + key consolidation

Pure-rename + pure-relocation, no behavior change.

**Changes:**

1. Rename `chunksEvicted.datasetId` → `memberId` in `workerProtocol.ts`, `RenderClient.onChunksEvicted`, `ChunksEvictedHandler` (upload/uploadClient.ts), `pipeline/upload/delivery/feedback.ts`, and the handlers that post them. (Contract Issue 3, Seam N.)
2. Same for `volumeChunkData.datasetId` and `sliceChunkData.datasetId` — rename to `memberId`. Update `RenderClient.volumeChunkData` / `sliceChunkData` callers in `pipeline/upload/delivery/dispatch.ts`.
3. Move `parseChunkKey`, `makeCompositeKey`, `parseCompositeKey`, `derivePoolKey` from `volumeHandlers.ts` → `renderer/chunkKeys.ts`. Update imports (`sliceHandlers.ts`, `wantedSet.ts` indirectly).
4. Add `chunkPoolKey(dsId, channel, chunkDims, isMulti)` helper to `renderer/poolKeys.ts`. Don't migrate call sites yet — that's a later slice. Just declare + test the helper.
5. Add doc comments to render messages explaining stale-tolerance (Contract Issue 13).

**Tests:** add `chunkKeys.test.ts`, `poolKeys.test.ts`. No behavior change to existing tests.

**Risk:** very low. Pure renames + relocations.

**Why first:** all later slices reference these helpers. Renaming `chunksEvicted.datasetId` requires touching ~10 call sites and shouldn't be conflated with structural change.

## Slice 2 — Force every member-id construction through the canonical helper

**Changes:**

1. Audit every `${entry.imageId}:ch${channel}` and `entry.imageId` construction; replace with `memberIdForColdEntry(entry, channel, multiCh)`.
2. Sites: gpu.worker.ts cold-state handler (3 places), wantedSet.ts chunk wanted-set (1 place), any other inline reconstruction.
3. Suite D from the testability scan (~80 LOC) — member-registry invariants — lands here to lock the behavior.

**Risk:** low-medium. The fix surfaces and corrects the latent well-as-proxy `imageId === ""` issue (Contract Issue 5 detail) — silently changes behavior for any caller that was getting the buggy `:ch5` member-id with an empty imageId. Suite D pins what's expected.

**Why second:** member-id consistency is a precondition for trusting any later test that checks "did the right pool register?"

## Slice 3 — Descriptor byte-layout single source of truth

**Changes:**

1. Move `DESCRIPTOR_*` constants from `descriptorBuffer.ts` into `renderer/descriptor/layout.ts`. Add named **field offsets** (`FIELD_OFFSET_CONTRAST_MIN = 192`, etc.) — one per `u32`/`f32` slot.
2. Rewrite `descriptorBuffer.serializeEntityDescriptor` to use the named offsets — eliminate the magic-index style.
3. Move `volumeRenderer.setTransientDescriptor` body into `renderer/descriptor/transient.ts` as `serializeTransientDescriptor(target, params)`. `volumeRenderer` calls into it. Eliminates the second hardcoded-offset writer.
4. Extend `descriptorBuffer.test.ts` with a "transient descriptor matches canonical descriptor for equivalent params" test.
5. Add `descriptorWGSLLock.test.ts` that parses the `struct EntityDescriptor` from both `.wgsl` files, computes the implied byte layout from the field order, and asserts agreement with `layout.ts`.

**Risk:** low. The serializer rewrite is mechanical; the WGSL lock test is additive.

**Why third:** later slices that extract proxy upload / cold-state ingestion will need the descriptor rebuild trigger to be clean. Doing this now means those extractions can call a simple `rebuildDescriptorBuffer(...)` and stop carrying byte-layout knowledge.

## Slice 4 — Extract cold-state ingestion (the big one)

This is the analogue of upload's "extract `Uploader`" slice. Removes 200+ lines from `gpu.worker.ts`.

**Changes:**

1. Suite A from the testability scan (~250 LOC) lands first as **dispatch-mocked tests** asserting current behavior. Use a faux WorkerCtx + mocked device.
2. Extract pure helpers:
   - `coldState/groupEntries.ts` — `groupEntriesByPool(cold, dimArity)` (Composability Unit 1).
   - `coldState/entityMetas.ts` — `computeEntityMetas(entry, poolChunkDims, startOffset)` (Composability Unit 2).
3. Extract the orchestrator: `coldState/apply.ts` exports `applyColdState(ctx, msg, state) → { wantedSetSeed }`. The function:
   - Refreshes well→fields.
   - Registers memberToDataset (via canonical helper from Slice 2).
   - Iterates pool groups (via Unit 1).
   - For each group: getOrCreate pool, compute entityMetas (via Unit 2), resize + remap indirection.
   - Captures `currentEntityMetasByDataset`.
   - Rebuilds descriptor buffer.
   - Returns wanted-set seed.
4. The `case "coldState"` in `gpu.worker.ts` shrinks to ~20 lines calling `applyColdState` + `postWantedSet`.
5. Suite A's tests are now testing `applyColdState` directly.

**Risk:** medium. This is the riskiest single slice — 200 lines moving with mutable state at three pools (`atlasPerDataset` × 2, `descriptorBuffersByDataset`). Mitigations:
- Suite A pins behavior before extraction.
- Move-then-rename pattern: copy code first, swap call site, delete original.
- Keep `atlasPerDataset` Maps in place during this slice (don't combine with the de-globalization slice — that's Slice 8).

**Why fourth:** unblocks every later cold-state-adjacent slice. Also delivers immediate readability win (gpu.worker.ts → ~600 LOC after).

## Slice 5 — Extract proxy lifecycle

**Changes:**

1. Suite B from the testability scan (~150 LOC) lands first.
2. Move `handleProxyAssetData` body into `proxy/upload.ts` as `handleProxyUpload(ctx, msg, state) → { rebuildDescriptor: boolean; wantedSetChanged: boolean }`.
3. Move well→fields fan-out into `proxy/propagate.ts` as `propagateWellProxyToFields(handle, wellId, wellToFields, descriptors)`.
4. Worker's `case "proxyAssetData"` reduces to: validate → call handleProxyUpload → conditionally rebuild descriptor → post wanted set.

**Risk:** low-medium. Pure relocation. Behavior unchanged.

**Why fifth:** removes another ~100 lines from gpu.worker.ts; isolates the well-fanout for future correctness work.

## Slice 6 — Collapse 2D/3D duplicated primitives

**Changes:**

1. Suite C (chunk upload eviction + demux, ~120 LOC) lands first.
2. Collapse `chunkDistSq` + `chunkDistSq2D` → one function with optional Z.
3. Collapse `findFarthestSlot` + `findFarthestSlot2D` → one parameterized function.
4. Consolidate `remapIndirection` + `remapSliceIndirection` if the shape allows; otherwise leave separate but share the inner kernel.
5. Move shared bits into `renderer/eviction.ts` and `renderer/remap.ts` (or `volume/`+`slice/` shared kernel).

**Risk:** low. Pure functions, well-isolated.

## Slice 7 — Split volumeHandlers + sliceHandlers into directories

**Changes:**

1. Move pieces of `volumeHandlers.ts` into:
   - `volume/atlas.ts` — `AtlasState` type, `createVolumeAtlas`, `destroyAtlas`, `getOrCreateVolumePool`, `resizeIndirection`.
   - `volume/upload.ts` — `handleVolumeChunkData`.
   - `volume/eviction.ts` — `rayHitPerEntity`, `applyViewHotState`, `findFarthestSlot` (using shared kernel from Slice 6).
   - `volume/render.ts` — `handleVolumeRenderMultiPass`.
   - `volume/remap.ts` — `remapIndirection`.
2. Mirror for `slice/`.
3. Re-export legacy names from the old `volumeHandlers.ts` / `sliceHandlers.ts` until call sites migrate, then delete.

**Risk:** low. Mechanical splits. No behavior change.

**Why seventh:** preconditions (Slices 1–6) have all landed. Now the split is just moving stuff.

## Slice 8 — De-globalize state via `WorkerCtx`

This is the slice that pays off the partial-DI debt.

**Changes:**

1. Define `RendererState` (or call it `WorkerState`) — an interface with:
   - `volumeAtlases: Map<poolKey, AtlasState>`
   - `sliceAtlases: Map<poolKey, SliceAtlasState>`
   - `proxyPoolsByDataset: Map<...>`
   - `proxyDescriptorsByEntity: Map<...>`
   - `wellToFields: Map<...>`
   - `descriptorBuffersByDataset: Map<...>`
   - `memberToDataset`, `memberToPool`, `currentEntityMetasByDataset`
   - `rayHitPerEntity`, `cameraUVPerEntity`
   - `currentEpochs`, `currentColdState`
2. `WorkerCtx` gains `state: RendererState` field.
3. Convert handlers to read `ctx.state.foo` instead of module globals.
4. `worker/state.ts` exports `createInitialState() → RendererState`.
5. `worker/bootstrap.ts` builds the state once and passes through ctx.

**Risk:** medium-high. Touches every handler. Mitigations:
- Land after Slice 7 so handlers are already in their own files.
- Migrate one Map at a time. Each commit is a small `git diff`.
- Keep module globals as `let` rebound to `state.xxx` during transition.

**Why eighth:** by now the structural split is complete; this is the "make dependencies explicit" cleanup.

## Slice 9 — Split `gpu.worker.ts` into `worker/` directory

After Slices 4, 5, and 8, `gpu.worker.ts` should already be down to ~300 LOC: just dispatch + resources + lifecycle.

**Changes:**

1. `worker/bootstrap.ts` — initGPU + ctx assembly + ready post.
2. `worker/dispatch.ts` — the `self.onmessage` switch, importing each case handler from its file.
3. `worker/resources.ts` — `getOrCreateLUT`, `ensureOffscreenPool`, dummy textures.
4. `worker/devtools.ts` — `self.__lucidaXxx` installation.
5. `worker/lifecycle.ts` — `destroy` handler.
6. `gpu.worker.ts` becomes the entry point: imports from `worker/`, exports nothing.

**Risk:** low. By now everything is set up to land cleanly.

## Slice 10 — Hardware-limit centralization + atlas-sizing extraction

**Changes:**

1. `gpuContext.ts` gains `getDeviceLimits(device)` returning a typed object.
2. `volume/atlas.ts` and `slice/atlas.ts` use the typed limits (replacing hardcoded `2048` and `8192`).
3. Extract `computeAtlasGeometry(device, chunkDims, budget)` to a shared helper (Composability Unit 13).

**Risk:** very low. Atlas sizing converges to one place; no behavior change unless a device's limits actually differ from the hardcoded constants (in which case it's a bug fix).

## Slice 11 — `ColdStateActiveEntry` discriminated union

**Changes:**

1. Replace the `imageId === ""` sentinel with a discriminated union (Contract Issue 7):
   ```ts
   type ColdStateActiveEntry =
     | { kind: "field"; imageId: string; entityId: string; parentWellId: string | null; ... }
     | { kind: "well-as-proxy"; entityId: string; parentWellId: null; ... }
   ```
2. Update orchestrator-side construction in `pipeline/upload/coldState/build.ts`.
3. Update worker-side consumers (the `entry.imageId` checks become `entry.kind === "field"`).

**Risk:** medium. Touches the wire protocol and the orchestrator. Surfaces every well-as-proxy special case to the type checker.

**Why eleventh:** lots of preparation needed; nothing earlier blocks on this. Land it once everything else is in place.

## Slice 12 — Deferred: render-multipass `LayerDrawCall` extraction

Composability Unit 5. Risky-but-valuable. Defer until there's a concrete motivator (a new render mode, a debug overlay reading the resolved bindings, etc.).

## Slice 13 — Deferred: WGSL struct codegen

Generate `EntityDescriptor` WGSL struct from `descriptor/layout.ts`. Requires Vite plugin or build step. Defer; the WGSL lock test (Slice 3) catches drift cheaply.

## Order summary

| Slice | What | LOC delta | Risk | Tests added |
|---|---|---|---|---|
| 0 | Scaffold dirs | 0 | none | – |
| 1 | Rename `datasetId`→`memberId`; relocate chunk-key helpers | small | very low | ~80 |
| 2 | Force canonical memberId helper | small | low-med | Suite D ~80 |
| 3 | Descriptor layout SSoT + WGSL lock | small | low | ~120 |
| 4 | Extract `applyColdState` | -200 from gpu.worker | medium | Suite A ~250 |
| 5 | Extract proxy upload | -100 from gpu.worker | low-med | Suite B ~150 |
| 6 | Collapse 2D/3D primitives | small | low | Suite C ~120 |
| 7 | Split volumeHandlers + sliceHandlers | mechanical | low | – |
| 8 | De-globalize state via WorkerCtx | mechanical | med-high | – |
| 9 | Split gpu.worker.ts → worker/ | mechanical | low | – |
| 10 | Centralize hardware limits + atlas sizing | small | very low | small |
| 11 | ColdStateActiveEntry discriminated union | medium | medium | – |
| 12 | (deferred) LayerDrawCall extraction | – | – | – |
| 13 | (deferred) WGSL struct codegen | – | – | – |

**Total test investment:** ~800 LOC across Suites A–E + slice-local tests.
**Total estimated effort:** ~10 PR-days (each slice ~1 day, some smaller).

Comparable to upload's 12-day estimate, slightly lower because:
- god file is half the size (815 vs 2027 LOC);
- pure algorithmic pieces are already extracted + tested;
- no wire-protocol changes that ripple across many phases.

## Bugs / improvements that surface naturally

1. **Well-as-proxy memberId construction silently wrong in pool registry** (Slice 2 surfaces and fixes via Suite D). Today: multi-channel well-as-proxy entries don't register a chunk pool key correctly, but it's masked because they have no `levels[]` and the pool loop short-circuits. Fix: use `memberIdForColdEntry` everywhere.
2. **`removeLayerResources` doesn't clean memberToDataset / memberToPool** (Suite D surfaces). Today: entries remain forever after dataset removal. Minor memory leak; future risk if memberIds collide across datasets. Fix in Slice 8 when state ownership becomes explicit.
3. **Intensity tracking per-pool but reported per-member** (Contract Issue 12). May surface during Slice 7 split. Fix opportunistically: track per-member intensity instead of per-pool.
4. **Renderer hardware-limit assumptions inconsistent** (Slice 10 fixes). `volumeHandlers` uses `2048`, `sliceHandlers` uses `8192`, `proxyAtlas` queries device. Pick one.
5. **`RenderClient` `.slice(0)` on every chunk + proxy buffer** (Contract Issue 15). Investigate during Slice 1 or as a one-off. If unnecessary, removing it is a free perf win.

## Comparison with prior /dechaos passes

| | planning | fetch | upload | render |
|---|---|---|---|---|
| God file LOC pre-refactor | 1800 | 1627 | 2027 | **815** |
| Slices proposed | similar shape (~10-12) | 13 (incl scaffold) | 11 (with 2 deferred) | **11 (with 2 deferred)** |
| Pre-refactor test investment | – | – | ~525 LOC | ~800 LOC (~60% post-extraction) |
| Algorithmic core already tested? | partial | partial | partial | **yes (strong)** |
| Wire-protocol changes | – | yes (Chunk type) | yes (clarify) | yes (datasetId → memberId; ColdStateActiveEntry union) |
| Estimated effort | ~10 PR-days | ~11 PR-days | ~12 PR-days | **~10 PR-days** |

## Suggested next step

Hand off to `/code` to scope each slice into a PRD with specific file moves and validation checks. The upload refactor's "PRD per slice" cadence is the right model.

Slice 1 (renames) and Slice 3 (descriptor SSoT) are the obvious starting points: low risk, immediate readability wins, no test investment beyond a few new spec files. They can ship in the same week.

Slice 4 (cold-state extraction with Suite A) is the centerpiece — ~2 PR-days. After it lands, the rest of the slices each feel like 1-day work.
