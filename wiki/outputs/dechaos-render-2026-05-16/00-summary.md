# Dechaos: render phase — summary

Date: 2026-05-16. Scope: everything in `lucida-web/src/renderer/` (gpu.worker.ts, slice/volume handlers, atlas + descriptor + wanted-set modules, shaders, RenderClient) plus the worker-touching surfaces of `pipeline/upload/uploadClient.ts`. Completes the four-pass dechaos sequence covering plan → fetch/decode → upload → **render**.

## TL;DR

The render phase is **structurally smaller than the prior three god files** (`gpu.worker.ts` is 815 LOC vs upload's 2027 / fetch's 1627 / planning's 1800) but suffers from the same shape: a single dispatch file with 14 distinct responsibilities, 14 module-level Maps spread across 4 files, and a 200-line cold-state ingestion block embedded in a message switch.

**Critical difference from prior passes:** the algorithmic core is already well-tested. `wantedSet.ts`, `proxyAtlas.ts`, `descriptorBuffer.ts`, `epochCheck.ts`, `dataTypeUtil.ts`, and the indirection-remap functions all have strong tests (~2168 LOC across 31 suites). The slop is in **orchestration** — cold-state ingestion, proxy lifecycle, member-id routing — which has zero direct tests today.

Proposed plan: **11 incremental slices** mirroring the planning/fetch/upload cadence, ordered by precondition. The output is a `renderer/` directory with `coldState/`, `proxy/`, `volume/`, `slice/`, `worker/`, and `descriptor/` subdirectories — each a small focused module. `gpu.worker.ts` shrinks from 815 → ~30 LOC (entry point only).

Estimated effort: **~10 PR-days for slices 0–11.** Pre-refactor test investment: ~800 LOC (more than upload's 525, less than fetch's heavier work — most of it lands *with* the extractions, not before).

## Per-pass outputs

1. [01-system-map.md](01-system-map.md) — file inventory, entry points, workflows, module-level state (14 Maps across 4 files), high-risk areas. Comparison table with planning/fetch/upload reveals render is structurally smallest but has the same disease.
2. [02-boundary-scan.md](02-boundary-scan.md) — 15 seams ranked by severity. Top five: cold-state ingestion inside dispatch, atlas-state-and-driver fusion in volume/slice handlers, member/pool registry as ambient state, proxy lifecycle orchestrator, module-level mutable state spread across 4 files.
3. [03-responsibility-scan.md](03-responsibility-scan.md) — `gpu.worker.ts` owns 14 distinct responsibilities; `volumeHandlers.ts` and `sliceHandlers.ts` each own 8; render-multipass functions are 150-line orchestrators nested inside "handlers." Pure modules (`wantedSet`, `proxyAtlas`, `epochCheck`, `dataTypeUtil`) are healthy and shouldn't be touched.
4. [04-dependency-scan.md](04-dependency-scan.md) — 10 dependency problems. Biggest: WorkerCtx is partial DI (handlers reach back to module globals anyway), implicit message-ordering invariants that silently no-op when violated, hardcoded GPU device limits inconsistent across files (8192 vs 2048 vs queried).
5. [05-contract-scan.md](05-contract-scan.md) — 15 contract issues. Verified: `EntityDescriptor` byte layout mirrored in 4 sites (one tested, three not); `chunksEvicted.datasetId` field carries memberId (wire-protocol misnomer); axis-order inconsistency inside one descriptor (LodInfo `[X,Y,Z]` vs proxyDims `[Z,Y,X]`); member-id construction restated inline at 4+ sites; `well-as-proxy` modeled as `imageId === ""` sentinel rather than discriminated union. Worker→main `RenderClient` does `.slice(0)` on every chunk + proxy buffer — copies before transferring; investigate whether necessary.
6. [06-composability-scan.md](06-composability-scan.md) — 14 extractable units. Top three: pool-grouping primitive (collapses 2D/3D duplicate code), eviction distance + farthest-slot finder (same), indirection remap (same). Anti-patterns to AVOID: generic AtlasUploadStrategy interface, unified slice+volume shader.
7. [07-testability-scan.md](07-testability-scan.md) — `gpu.worker.ts` cold-state, `handleProxyAssetData`, chunk-upload eviction, member-registry, and descriptor-rebuild trigger have **zero direct tests** today. Suites A–E (~660 LOC) needed before/during refactor. Different cadence from upload: ~60% of test work lands *post*-extraction because the orchestration must be extractable first.
8. [08-refactor-sequencing.md](08-refactor-sequencing.md) — 11 slices ordered by precondition. Slice 0 = scaffold. Slice 1 = renames (low risk, all later slices depend on the renamed keys). Slice 4 = cold-state extraction (the centerpiece, the upload-pass analogue of "extract Uploader"). Slices 5–9 progressively split + de-globalize. Slices 11 (discriminated-union) is wire-protocol work. Slices 12–13 deferred until motivated.

## Bugs / latent issues surfaced

1. **Well-as-proxy memberId mis-registered in pool registry**. The cold-state handler's pool loop builds `memberId = isMultiCh ? \`${entry.imageId}:ch${channel}\` : entry.imageId` (gpu.worker.ts:583, 668) — when `imageId === ""` (well-as-proxy convention), this produces `:ch5` rather than the canonical `${entityId}:ch5`. Today this is rescued only because well-as-proxy entries have empty `levels[]` and the pool loop short-circuits. Slice 2 surfaces and fixes by forcing every site through `memberIdForColdEntry`.
2. **`removeLayerResources` leaks `memberToDataset` / `memberToPool` entries**. The handler clears atlas pools + descriptor buffers but doesn't clear the routing Maps. Member IDs accumulate forever. Minor memory leak. Fix in Slice 8 alongside state ownership cleanup.
3. **Intensity tracking per-pool but reported per-member**. When two members share a pool, an intensity update from one carries the running min/max contributed by the other. Probably benign (intensities are usually similar) but incorrect. Fix opportunistically.
4. **Hardware-limit assumptions inconsistent**. `volumeHandlers.ts` hardcodes `2048`, `sliceHandlers.ts` hardcodes `8192`, `proxyAtlas.ts` queries `device.limits.maxTextureDimension3D`. Slice 10 unifies.
5. **`RenderClient.proxyAssetData` / `volumeChunkData` / `sliceChunkData` call `.slice(0)` on every buffer before transferring**. The comment claims "Take ownership of the buffer for transfer" but `.slice(0)` is a heap copy. For a 256³ u16 chunk that's 32 MB copied per delivery on the main thread before postMessage. Investigate: if source buffers aren't reused, the copies are pure overhead and can be removed.

## Wire-protocol cleanups in scope

- Rename `chunksEvicted.datasetId` → `memberId` (Slice 1). Affects `RenderClient.onChunksEvicted`, `ChunksEvictedHandler`, `pipeline/upload/delivery/feedback.ts`.
- Rename `volumeChunkData.datasetId` / `sliceChunkData.datasetId` → `memberId` (Slice 1).
- Discriminated union for `ColdStateActiveEntry` (`kind: "field" | "well-as-proxy"`) replacing the `imageId === ""` sentinel (Slice 11).
- Possible: add `datasetId` to `MissingChunk` for symmetry with `MissingProxy` (open question).

## Doc-drift implications

`CHUNK_PIPELINE.md` and the wiki articles (`wiki/systems/subsystems/...`) cite specific behaviors that survive this refactor unchanged:

- The semantic fallback chain (target detail → coarser → field proxy → well proxy → blank) stays in `volume.wgsl` and `slice.wgsl` — same shape.
- The shared pool design (per `(datasetId, channel, chunkDims)`) survives; the implementation just moves to `volume/atlas.ts` + `slice/atlas.ts`.
- Proxy atlas per `(datasetId, kind, slotDims, channel)` is unchanged; `proxyAtlas.ts` is healthy and untouched.
- Cold-state shape is unchanged at the message level (only `imageId === ""` may become `kind: "well-as-proxy"` in Slice 11).

The articles that will need refresh after Slice 9 land are mostly **module pointers** (file paths). Behavior descriptions are stable.

## Comparison with prior /dechaos passes

| | planning | fetch | upload | **render** |
|---|---|---|---|---|
| God file LOC pre-refactor | 1800 | 1627 | 2027 | **815** |
| Number of responsibilities fused | ~12 | ~13 | 20 | **14** |
| Direct tests on god file | 0 | 0 | 1024 LOC | **0** |
| Algorithmic core test coverage | partial | partial | partial | **heavy** (2168 LOC, 31 suites) |
| Wire-protocol contract changes | – | yes (`Chunk` union) | yes (clarifications) | **yes** (datasetId→memberId, ColdStateActiveEntry union) |
| Slices proposed | ~10 | 13 | 11 | **11** |
| Pre-refactor test investment | – | – | ~525 LOC | **~800 LOC, ~60% post-extraction** |
| Real bugs fixed mid-refactor | ? | imageWireFormats leak, transient/permanent misclass | `_lastFilteredRequests` last-dataset-wins, `workerWantedSet` dead state | **memberId in pool loop, removeLayerResources leak, possibly .slice(0) overhead** |
| Estimated effort | ~10 PR-days | ~11 PR-days | ~12 PR-days | **~10 PR-days** |

## Suggested next step

Hand off to `/code` to scope each slice into a PRD-level work item. The upload refactor's "PRD per slice" cadence is the right precedent.

Three slices are obvious starting points and can ship in week 1:

1. **Slice 1** (renames + chunkKeys/poolKeys relocation) — pure cleanup, no test investment beyond two small spec files. Low risk, immediate readability win.
2. **Slice 3** (descriptor byte-layout SSoT + WGSL lock test) — small, isolated, prevents a class of future bugs.
3. **Slice 0** (directory scaffold) — just `mkdir` + empty index files.

After those land, **Slice 4** (cold-state extraction with Suite A) is the centerpiece — ~2 PR-days including the test suite. Every subsequent slice then becomes a 1-day mechanical move.

The render phase is the most-prepared of the four for a refactor: the test surface is partially there, the wire boundary is stable, and the prior three passes have already proven the pattern. The path from here to a clean `renderer/` directory is straightforward — it's a question of staging and care, not invention.
