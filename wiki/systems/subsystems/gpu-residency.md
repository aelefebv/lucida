---
type: Subsystem
title: "GPU Residency"
description: "How chunk bytes become atlas slots become indirection-buffer entries become shader-sampled pixels."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/gpu-residency.md
created: 2026-04-18
modified: 2026-07-16
---

# GPU Residency

How chunk bytes become atlas slots become indirection-buffer entries become shader-sampled pixels. Lives in `lucida-web/src/renderer/`. All WebGPU work happens inside `gpu.worker.ts` (now a ~34 LOC entry point) on a dedicated Web Worker — see [All GPU Work on a Dedicated Web Worker](../../decisions/0003-gpu-on-dedicated-worker.md).

## Truthful viewport-loading state

`ViewportLoadingTracker` joins three renderer-owned facts for discrete transitions such as time/channel/group changes and initial fits: the scene epoch snapshot at invalidation, each active dataset's worker `wantedSetDelta`, and the correlated GPU `framePresented` id. The viewer's loading chip retires only after every dataset reports zero missing chunks for an epoch at least as new as the transition and the target-or-newer frame completes. Continuous pan/zoom does not start a chip, and late worker messages from rapid scrubs cannot retire the latest transition. Keep this state in the render loop; React network flags do not know whether the visible GPU view is resident or presented.

## Module layout

`renderer/` is a tree of focused modules organized around the worker entry point. The entry point wires five collaborators in `worker/` ([`gpu.worker.ts` split into `renderer/` subdirectories](../../decisions/0035-gpu-worker-split-into-renderer-subdirectories.md)):

- `worker/bootstrap.ts` — `init` handler: builds `WorkerCtx`, creates GPU device + canvas context, instantiates the per-mode renderers (slice, volume, cursor, compositor), and constructs the per-session `RendererState`.
- `worker/dispatch.ts` — message switch: routes every typed `MainToWorkerMessage` to its handler.
- `worker/resources.ts` — LUT cache + offscreen-canvas pool + dummy textures/buffers (the persistent GPU resources that outlive a single cold state).
- `worker/devtools.ts` — renderer diagnostics exported to the debug surface.
- `worker/lifecycle.ts` — `destroy` handler: tears down atlases and descriptor buffers.
- `worker/state.ts` — the `RendererState` interface (see "De-globalized session state" below).

The mode-specific code lives in three sibling subdirectories: `volume/` (`atlas.ts`, `upload.ts`, `eviction.ts`, `render.ts`, `remap.ts`), `slice/` (same plus `zRetarget.ts`), and `coldState/` (`apply.ts`, `groupEntries.ts`, `entityMetas.ts`). Descriptor serialization is in `descriptor/`; `chunkKeys.ts` and `poolKeys.ts` own shared chunk/tier identities.

The algorithmic core (`wantedSet.ts`, `descriptorBuffer.ts`, `epochCheck.ts`, `dataTypeUtil.ts`) remains shared and well-tested.

## Atlases and indirection

The GPU side never holds "one texture per chunk." That would shred VRAM and the bind-group cache. Instead:

- **Slice atlas pools** — keyed by dataset, channel, slot dimensions, and tier (`detail` or `coarse`). Holds 2D slice tiles. State lives in `slice/atlas.ts` (per-pool `SliceAtlasState`).
- **Volume atlas pools** — keyed by dataset, channel, slot dimensions, and tier (`detail` or `coarse`). Holds 3D chunks. State lives in `volume/atlas.ts` (per-pool `AtlasState`).

An **indirection buffer** (a `array<u32>` storage buffer) maps logical `(entity, lod, z, y, x)` → atlas slot coords. The shader reads it before sampling the atlas texture. Indirection is only flushed when chunk residency actually changes (atlas write/evict), not every frame — this is a big perf win because indirection writes are otherwise per-frame and bandwidth-bound.

The LRU eviction kernel (`eviction.ts` at the top of `renderer/`) and the indirection-remap kernel (`remap.ts` in each of `volume/` and `slice/`) share one implementation across 2D and 3D — the 2D form is "3D form with Z fixed to one chunk."

## Descriptor buffer

`renderer/descriptorBuffer.ts` — a GPU storage buffer of `EntityDescriptor[]`. Each entry contains:

- `modelMatrix`, `invModelMatrix`
- contrast / gamma / opacity
- colormap LUT index (into the LUT texture)
- per-LOD info (shape, indirection offset)
- explicit chunk tier sources (`detail`, `coarse`) with level, grid/chunk dims, and indirection offsets

Shaders use `entityIndex` to look up its descriptor. The tick coordinator and worker share an explicit ordered `(memberId → index)` map so indices match by construction — both sides iterate the same active set in the same order.

The byte layout is owned by `renderer/descriptor/layout.ts` as named offset constants (`OFFSET_MODEL_MATRIX`, `OFFSET_TILE_PROXY_DIMS`, `LOD_OFFSET_CHUNK_DIMS`, etc.). Both writers — the canonical `descriptorBuffer.serializeEntityDescriptor` and the transient `descriptor/transient.serializeTransientDescriptor` (minimap path) — read offsets from that file. `renderer/descriptor/layout.test.ts` parses the `EntityDescriptor` struct from both `slice.wgsl` and `volume.wgsl` and asserts agreement against the TS constants; if the WGSL struct changes without updating `layout.ts` (or vice versa) the lock test fails. See ADR 0035 for the design rationale.

## Semantic fallback chain

Per fragment in `slice.wgsl` / `volume.wgsl`:

1. Read `descriptors[entityIndex]`.
2. Project fragment to entity-local voxel coords.
3. Compute `(z, y, x)` cell within the chosen LOD.
4. Read `indirection[lod.indirectionOffset + cellIndex]` → atlas slot.
5. **Fallback chain**:
   - Try the explicit `detail` tier source.
   - Fallback to the explicit `coarse` tier source when detail is missing for the fragment.
   - Last resort: blank.
6. Apply contrast → gamma → LUT sample → opacity.

The chain runs **inside the volume ray-march loop** as well, so a ray that crosses a region with missing detail still produces something coherent. Commit `b0a5985` hoisted the `EntityDescriptor` read out of the inner loop — significant on volume because it was being re-read per ray step.

## Cold-state ingestion

`coldState/apply.ts` is the cold-state orchestration. On every cold-state message it: (1) clears routing Maps owned by removed members; (2) walks `iterateColdMembers(msg)` to repopulate `state.memberToDataset`, legacy `state.memberToPool`, and tier-aware `state.memberTierToPool` via `memberTierKey(memberId, tier)`; (3) rebuilds the per-dataset `entityMetas` snapshot for each tier pool; (4) rebuilds the descriptor buffer.

`coldState/groupEntries.ts` and `coldState/entityMetas.ts` are the pure pieces apply.ts delegates to. They group detail and coarse sources separately, so mismatched detail/coarse chunk shapes become separate pools instead of forcing one shared atlas layout.

## De-globalized session state

Per-session state lives on one `RendererState` owned by `WorkerCtx.state`. It groups cold-state routing, descriptor registries, per-mode detail/coarse atlas registries, eviction reference points, and epoch tracking. `removeLayerResources` clears routing maps alongside atlases and descriptor buffers.

Renderer-class singletons (slice/volume/cursor/compositor) and persistent GPU resources (LUT cache, offscreen pool, dummy textures/buffers) intentionally stay at module scope in `worker/resources.ts` because they outlive any single session.

## Eviction and re-fetch loop

When worker residency changes or rejects an upload:

1. Posts chunk feedback keyed by `memberId`. `keys` are re-eligible chunks whose optimistic sent state should clear; `skipped` is reserved for atlas-policy rejection (atlas full + too far).
2. Includes missing detail/coarse chunks in the next `wantedSetDelta` from authoritative atlas state.
3. Main thread reconciles through [CPU Cache](cpu-cache.md): missing/re-eligible chunks clear sent state and true rejections enter `RejectionTracker`.
4. Next `getDeliverable()` pass re-uploads cached, wanted, not-rejected, not-sent assets without relying on a pan/zoom cold-state rebuild.

This is why **collection FPS is sensitive to pool capacity and CPU-cache size** — eviction churn cascades. See [Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)](../../decisions/0004-multi-pool-atlases.md).

## Interactions

- **Upstream**: the [Uploader](upload-pipeline.md) posts `coldState`, `viewHotState`, and tier-labeled `sliceChunkData`/`volumeChunkData` over [Worker Protocol](worker-protocol.md).
- **Downstream**: the worker presents to the OffscreenCanvas; communicates back via `wantedSetDelta`, `chunksEvicted`, `intensityRange`.

## Invariants

- **`entityIndex` matches between CPU and GPU.** Both sides build their lists by iterating the active set in identical order. Drift here is a class of bug that only surfaces visually (wrong colormap on the wrong entity).
- **Every per-session Map lives on `WorkerCtx.state`.** Module-level mutable *session* state in render-session files is a regression. The documented exception is `worker/resources.ts`, which intentionally holds module-scoped persistent resources (e.g. `lutCache`) that outlive any single session — scope the `new Map` lint to the render-session files and exclude `worker/resources.ts`.
- **memberId is the canonical owner key on every member-routed wire message** (`chunksEvicted`, `volumeChunkData`, `sliceChunkData`); cold state remains dataset-scoped.
- **Descriptor byte offsets live only in `descriptor/layout.ts`.** Both TS writers and both WGSL shaders must agree; `layout.test.ts` enforces this by parsing the shaders at test time.
- **Atlas slot IDs are pool-local.** A slot ID `42` in pool A is unrelated to slot `42` in pool B. The descriptor's tier source encodes which tier/indirection source to read.
- **Indirection writes are batched per frame** — many residency changes coalesce into one mapped buffer write. Don't add a per-chunk write call.
- **Cold state is rebuilt only when WASM epochs say something changed.** The tick coordinator's epoch fast-path skips ~95% of frames, ~5% rebuild. Forcing a rebuild every frame turns a 60fps view into a slideshow.

## Gotchas

- **Worker eviction is asynchronous from the main thread's perspective.** Don't assume `client.volumeChunkData(...)` lands instantly; the worker may have evicted by the time the next tick reads back. The reconciliation path through `wantedSetDelta` is what keeps things correct.
- **Pool keys include `channel` and `tier`** — `(datasetId, channel, slotDims, detail|coarse)`. Adding multi-channel or coarse/detail mode without re-keying pools regresses to channels or tiers fighting for one pool, which kills collection FPS and fallback reliability.
- **Cold state carries explicit `multiChannel`.** A multi-channel view can have one visible channel; member IDs and pool grouping still need the multi-channel `imageId:chN` shape.
- **`memberTierKey(memberId, tier)` is the tier routing key.** Falling back to the old `memberToPool` map for coarse uploads routes them through the detail pool and breaks mismatched chunk-shape cases.
- **Volume's per-entity scissor for collection tiles** is computed by `computeScissorRect` in `pipeline/upload/scissor.ts`. Skips fragments outside the tile's screen-space AABB. If a tile is rendering visibly outside its footprint, this is the place to look.
- **Compositor key naming is asymmetric**: `imageId:chN` for multichannel, bare `imageId` for single-channel. Mixing the two halves silently produces the wrong final composite.
