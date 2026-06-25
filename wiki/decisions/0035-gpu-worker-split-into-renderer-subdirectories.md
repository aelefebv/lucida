---
created: 2026-05-16
modified: 2026-06-25
---

# `gpu.worker.ts` split into `renderer/` subdirectories

## Decision

`lucida-web/src/renderer/gpu.worker.ts` (815 lines, 14 distinct responsibilities, 14 module-level Maps spread across 4 files) is split into a tree of focused modules under `lucida-web/src/renderer/`. The 200-line cold-state ingestion block, the proxy lifecycle orchestrator, the member/pool registry, and the volume/slice handlers each move into their own subdirectory; `gpu.worker.ts` shrinks to a ~30 LOC entry point that wires `worker/bootstrap`, `worker/dispatch`, `worker/resources`, `worker/devtools`, and `worker/lifecycle` together.

The destination layout (six new subdirectories): `coldState/` (`apply.ts`, `groupEntries.ts`, `entityMetas.ts`, `memberRegistry.ts`); `proxy/` (`upload.ts`, `propagate.ts`); `volume/` (`atlas.ts`, `upload.ts`, `eviction.ts`, `render.ts`, `remap.ts`); `slice/` (`atlas.ts`, `upload.ts`, `eviction.ts`, `render.ts`, `remap.ts`, `zRetarget.ts`); `worker/` (`bootstrap.ts`, `dispatch.ts`, `resources.ts`, `devtools.ts`, `lifecycle.ts`, `state.ts`); `descriptor/` (`layout.ts`, `transient.ts`); plus top-level `chunkKeys.ts` and `poolKeys.ts`. Per-module test files land alongside, and the algorithmic core (`wantedSet.ts`, `proxyAtlas.ts`, `descriptorBuffer.ts`, `epochCheck.ts`, `dataTypeUtil.ts`) stays put — it is already well-tested (~2168 LOC across 31 suites) and structurally healthy.

## Why this shape

The eight-pass dechaos analysis under `wiki/outputs/dechaos-render-2026-05-16/` makes the structural case: `gpu.worker.ts` owns 14 distinct responsibilities (cold-state ingestion, message dispatch, GPU bootstrap, devtools, lifecycle, LUT/offscreen-pool resources, proxy upload, descriptor rebuilds, member-registry routing, well→fields fan-out, render-loop ticks, eviction triggers, atlas state, transient descriptors) and `volumeHandlers.ts` (646 LOC) + `sliceHandlers.ts` (554 LOC) each own 8 responsibilities of their own. The orchestration code — the parts that wire pure algorithmic units together — has zero direct tests today and is the source of the file's reasoning load.

Pass 2 of the dechaos identified 15 seams ranked by severity; the top five (cold-state ingestion inside dispatch, atlas-state/driver fusion in handlers, member/pool registry as ambient state, proxy lifecycle, module-level mutable state across 4 files) map one-to-one onto the directory tree above. Pass 6 identified 14 extractable composability units; the top three (pool-grouping primitive, eviction distance + farthest-slot finder, indirection remap) collapse 2D/3D duplicate code that today exists in parallel in `volumeHandlers.ts` and `sliceHandlers.ts`. Pass 7 confirmed which test suites need to land before each extraction — and crucially, that ~60% of the test investment lands *post*-extraction because the orchestration must be extractable first.

The split mirrors [[decisions/0034-orchestrator-split-into-pipeline-upload]] and [[decisions/0032-cpucache-split-into-pipeline-fetch]] in shape: an overgrown god file (or here, a god-file *cluster*) becomes a coordinator plus a directory of 50–250 LOC modules, behaviour-preserving except for explicit named bug fixes. Together the four refactors — planning (PRD #545 / [[decisions/0029-planning-index-split-into-per-concern-files]]), fetch/decode (PRD #592 / 0032), upload (PRD #607 / 0034), and now render (PRD #622) — complete the chunk pipeline's structural cleanup end-to-end. Adopting the same shape on every phase means the pipeline reads as one consistent system rather than four unrelated styles.

This ADR does not cite a principle. `principles/render-pipeline.md` does not yet exist; an INTERVIEW pass is queued for after this refactor settles, following the same deferral pattern as `principles/cpu-cache.md` and `principles/upload-pipeline.md` (each captured post-refactor against the cleaned-up surface rather than speculatively against the god-file shape).

## Decision: 11 incremental slices

The dechaos's Pass 8 sequencing (`wiki/outputs/dechaos-render-2026-05-16/08-refactor-sequencing.md`) lays out 11 slices ordered by precondition. Summary:

- **Slice 0** — directory scaffold (empty placeholder files for the layout above).
- **Slice 1** — renames (`chunksEvicted.datasetId` → `memberId`; same for `volumeChunkData.datasetId` / `sliceChunkData.datasetId`) + relocate `parseChunkKey` / `makeCompositeKey` / `derivePoolKey` to `chunkKeys.ts` + declare `chunkPoolKey(...)` in `poolKeys.ts`.
- **Slice 2** — force every member-id construction through `memberIdForColdEntry`; Suite D (~80 LOC) locks the invariant and surfaces the well-as-proxy `imageId === ""` bug fix.
- **Slice 3** — descriptor byte-layout SSoT in `descriptor/layout.ts` with named field offsets + a lock test (landed as `descriptor/layout.test.ts`) that asserts agreement with the WGSL `struct EntityDescriptor` declarations.
- **Slice 4** — extract `applyColdState` (the centerpiece, analogue of upload's "extract `Uploader`"); Suite A (~250 LOC) pins behavior pre-extraction; gpu.worker.ts shrinks ~200 LOC.
- **Slice 5** — extract proxy upload + well→fields propagation into `proxy/upload.ts` and `proxy/propagate.ts`; Suite B (~150 LOC).
- **Slice 6** — collapse 2D/3D duplicated primitives (`chunkDistSq`/`chunkDistSq2D`, `findFarthestSlot`/`findFarthestSlot2D`, `remapIndirection`/`remapSliceIndirection`); Suite C (~120 LOC).
- **Slice 7** — split `volumeHandlers.ts` and `sliceHandlers.ts` into their respective `volume/` and `slice/` subdirectories.
- **Slice 8** — de-globalize the 14 module-level Maps via a `RendererState` interface owned by `WorkerCtx`; fixes the `removeLayerResources` Map cleanup leak.
- **Slice 9** — split `gpu.worker.ts` into `worker/` subdirectory; the surviving file becomes a ~30 LOC entry point.
- **Slice 10** — centralize hardware-limit assumptions (`2048`/`8192`/`device.limits.maxTextureDimension3D`) via `getDeviceLimits(device)` in `gpuContext.ts` + a shared `computeAtlasGeometry(...)` helper.
- **Slice 11** — `ColdStateActiveEntry` discriminated union (`kind: "field" | "well-as-proxy"`) replaces the `imageId === ""` sentinel; wire-protocol change touching both the upload-side builder and worker-side consumers.

Slices 12 (LayerDrawCall extraction) and 13 (WGSL struct codegen) are deferred — captured in dechaos Pass 8 — and land only when a concrete motivator surfaces. See section 8 of the dechaos for per-slice file diagrams, risk callouts, and the order-summary table.

## Why two latent bugs ride along inside slices

The dechaos surfaced two real bugs that fix cleanly inside the slices that surface them, following the same pattern as PRD #592 (`imageWireFormats` leak + transient/permanent misclass) and PRD #607 (`workerWantedSet` dead state + multi-dataset resend under-resend):

1. **Well-as-proxy memberId silently wrong in pool registry** (Slice 2). The cold-state pool loop builds `memberId = isMultiCh ? \`${entry.imageId}:ch${channel}\` : entry.imageId` — when `imageId === ""` (well-as-proxy convention), the multi-channel branch produces `:ch5` instead of the canonical `${entityId}:ch5`. Today it's rescued only because well-as-proxy entries have empty `levels[]` and the loop short-circuits. The fix forces every site through `memberIdForColdEntry(entry, channel, multiCh)`.
2. **`removeLayerResources` leaks `memberToDataset` / `memberToPool` entries** (Slice 8). The handler clears atlas pools + descriptor buffers but never clears the routing Maps. Member IDs accumulate forever — minor memory leak, future risk if memberIds collide across datasets. Fixed when state ownership becomes explicit in Slice 8.

Pulling either into a separate PR would either land it speculatively (before the structure that makes it obvious) or duplicate the structural work. They ride along.

## Why two wire-protocol field renames land in this refactor

Slice 1 renames `chunksEvicted.datasetId` → `memberId` (and the same for `volumeChunkData.datasetId` / `sliceChunkData.datasetId`). The field has carried a memberId since the upload pipeline started routing chunks per-member, but the name has lagged. Renaming as a pure mechanical change with no behavior delta is cheaper now than during a future change with semantic intent.

Slice 11 promotes `ColdStateActiveEntry` to a `kind: "field" | "well-as-proxy"` discriminated union, replacing the `imageId === ""` sentinel. This surfaces every well-as-proxy special case to the type checker — Contract Issue 7 from Pass 5 — and matches the discrimination pattern that landed in [[decisions/0026-discriminated-active-set-and-entity-types]] on the planning side.

Both renames are explicit named exceptions to the otherwise behaviour-preserving guarantee of the refactor. Every other change is structural.

## Why no `RenderClient` interface split

Pass 8 explicitly recommends **against** producing a `RenderClient` interface split analogous to upload's `UploadClient` (Slice 11 of PRD #607). A second renderer implementation is not on the horizon, and the abstraction would add overhead without a consumer. This asymmetry is intentional — the same spirit as [[decisions/0034-orchestrator-split-into-pipeline-upload]]'s explicit decision to NOT pursue chunk/proxy asset-abstraction in the upload phase.

## How this decision shows up in code

- `lucida-web/src/renderer/coldState/`, `proxy/`, `volume/`, `slice/`, `worker/`, `descriptor/` — the six new subdirectories.
- `lucida-web/src/renderer/gpu.worker.ts` — ~30 LOC entry point after Slice 9 (down from 815).
- `lucida-web/src/renderer/volumeHandlers.ts` — deleted in Slice 7 (646 LOC migrate into `volume/`).
- `lucida-web/src/renderer/sliceHandlers.ts` — deleted in Slice 7 (554 LOC migrate into `slice/`).
- `lucida-web/src/renderer/chunkKeys.ts`, `poolKeys.ts` — extracted helpers (Slice 1).
- `lucida-web/src/renderer/descriptor/layout.ts` — named field-offset constants, SSoT for the `EntityDescriptor` byte layout (Slice 3).
- `lucida-web/src/renderer/descriptor/transient.ts` — second descriptor writer body (was in `volumeRenderer.setTransientDescriptor`).
- `lucida-web/src/renderer/coldState/apply.ts` — extracted `applyColdState(ctx, msg)` (Slice 4).
- `lucida-web/src/renderer/proxy/upload.ts`, `propagate.ts` — extracted proxy lifecycle (Slice 5).
- `lucida-web/src/renderer/worker/state.ts` — `RendererState` interface owning the 14 Maps (Slice 8).
- `lucida-web/src/renderer/descriptor/layout.test.ts` — WGSL-vs-TS layout-agreement test (Slice 3).
- Per-module test files alongside each new module.
- `pipeline/upload/delivery/feedback.ts` and `pipeline/upload/delivery/dispatch.ts` — updated to use `memberId` field name (Slice 1).
- `pipeline/upload/coldState/build.ts` — updated for `ColdStateActiveEntry` discriminated union (Slice 11).

## Consequences

**Positive:**

- Per-module cohesion: each file owns one responsibility (cold-state ingestion, proxy upload, volume eviction, etc.) rather than fourteen sharing a dispatch switch.
- Testability of orchestration: the 200-line cold-state block, `handleProxyAssetData`, chunk-upload eviction, member-registry, and descriptor-rebuild trigger all gain direct tests (Suites A–E, ~800 LOC across the refactor) where today they have none.
- Two named bug fixes (well-as-proxy memberId in pool loop, `removeLayerResources` Map cleanup leak) land cleanly inside the slices that surface them.
- Contract clarity: descriptor byte layout has a single source of truth (`descriptor/layout.ts`) instead of being mirrored across 4 sites; `ColdStateActiveEntry` is a discriminated union instead of an `imageId === ""` sentinel.
- The pipeline reads as one consistent system once render mirrors the planning/fetch/upload shape.

**Negative:**

- Touches many files: ~20 new module files plus updates to wire-protocol field names across upload + render boundaries.
- Eleven incremental slices to land, sequenced by precondition; the centerpiece (Slice 4) carries the highest single-slice risk.
- The full plan is ~10 PR-days of work — comparable to PRD #607's 12-day spread.

**Neutral:**

- Preserves all existing behavior except the three named exceptions: (1) the well-as-proxy memberId fix in Slice 2 silently changes registry behavior for any caller that was getting the buggy `:ch5` member-id with an empty imageId; (2) the `removeLayerResources` Map cleanup in Slice 8 stops a long-session leak; (3) the wire-protocol field renames `chunksEvicted.datasetId → memberId` (Slice 1) and `ColdStateActiveEntry` discriminated union (Slice 11) are mechanical breaks for any external consumer of the worker protocol.

## Related

- [[decisions/0034-orchestrator-split-into-pipeline-upload]] — sister-refactor on the upstream half of the upload pipeline; shape and cadence mirrored here
- [[decisions/0032-cpucache-split-into-pipeline-fetch]] — earlier ADR in the same arc; the original template for the directory-of-small-files shape
- [[decisions/0029-planning-index-split-into-per-concern-files]] — first refactor in the chunk-pipeline arc; precedent for the cadence and the integration-tests-stay-monolithic discipline
- [[decisions/0003-gpu-on-dedicated-worker]] — establishes the worker boundary this refactor cleans up inside of
- [[decisions/0026-discriminated-active-set-and-entity-types]] — the discrimination pattern Slice 11 mirrors on the cold-state wire boundary
- [[chunk-lifecycle]] — overarching pipeline architecture; will be refreshed after the refactor stabilizes
- PRD #622 — the work item this ADR was created during
- PRDs #545 / #592 / #607 — the cumulative arc this refactor completes
- `wiki/outputs/dechaos-render-2026-05-16/` — the eight-pass design exploration that produced the slice plan
