---
created: 2026-04-18
modified: 2026-05-17
---

# GPU Residency

How chunk bytes become atlas slots become indirection-buffer entries become shader-sampled pixels. Lives in `lucida-web/src/renderer/`. All WebGPU work happens inside `gpu.worker.ts` (now a ~34 LOC entry point) on a dedicated Web Worker — see [[decisions/0003-gpu-on-dedicated-worker]].

## Module layout

`renderer/` is a tree of focused modules organized around the worker entry point. The entry point wires five collaborators in `worker/` ([[decisions/0035-gpu-worker-split-into-renderer-subdirectories]]):

- `worker/bootstrap.ts` — `init` handler: builds `WorkerCtx`, creates GPU device + canvas context, instantiates the per-mode renderers (slice, volume, cursor, compositor), and constructs the per-session `RendererState`.
- `worker/dispatch.ts` — message switch: routes every typed `MainToWorkerMessage` to its handler.
- `worker/resources.ts` — LUT cache + offscreen-canvas pool + dummy textures/buffers (the persistent GPU resources that outlive a single cold state).
- `worker/devtools.ts` — `self.__lucidaProxyStats` and friends.
- `worker/lifecycle.ts` — `destroy` handler: tears down atlases + descriptor buffers + proxy pools.
- `worker/state.ts` — the `RendererState` interface (see "De-globalized session state" below).

The mode-specific code lives in three sibling subdirectories: `volume/` (`atlas.ts`, `upload.ts`, `eviction.ts`, `render.ts`, `remap.ts`), `slice/` (same plus `zRetarget.ts`), and `coldState/` (`apply.ts`, `groupEntries.ts`, `entityMetas.ts` — the 200-LOC cold-state ingestion block). The proxy lifecycle lives in `proxy/` (`upload.ts`, `propagate.ts`). Descriptor serialization is in `descriptor/` (`layout.ts` for the byte-layout SSoT, `transient.ts` for the minimap path). Top-level helpers `chunkKeys.ts` (`parseChunkKey`, `makeCompositeKey`, `derivePoolKey`) and `poolKeys.ts` (`chunkPoolKey`) live at the top of `renderer/` rather than being trapped inside a single mode's handler file.

The algorithmic core (`wantedSet.ts`, `proxyAtlas.ts`, `descriptorBuffer.ts`, `epochCheck.ts`, `dataTypeUtil.ts`) is unchanged — it was already well-tested and structurally healthy.

## Atlases and indirection

The GPU side never holds "one texture per chunk." That would shred VRAM and the bind-group cache. Instead:

- **Slice atlas** — one per dataset, ~64 MB, X-Y grid layout. Holds 2D slice tiles. State lives in `slice/atlas.ts` (per-pool `SliceAtlasState`).
- **Volume atlas** — shared per dataset, ~512 MB, partitioned into per-entity-LOD sections (Shared Pools v1). State lives in `volume/atlas.ts` (per-pool `AtlasState`).
- **Proxy atlases** (`renderer/proxyAtlas.ts`) — one **pool** per `(datasetId, kind, slotDims, channel)`. 64 slots/pool, 1-D layout along X. Pure LRU.

An **indirection buffer** (a `array<u32>` storage buffer) maps logical `(entity, lod, z, y, x)` → atlas slot coords. The shader reads it before sampling the atlas texture. Indirection is only flushed when chunk residency actually changes (atlas write/evict), not every frame — this is a big perf win because indirection writes are otherwise per-frame and bandwidth-bound.

The LRU eviction kernel (`eviction.ts` at the top of `renderer/`) and the indirection-remap kernel (`remap.ts` in each of `volume/` and `slice/`) share one implementation across 2D and 3D — the 2D form is "3D form with Z fixed to one chunk."

## Descriptor buffer

`renderer/descriptorBuffer.ts` — a GPU storage buffer of `EntityDescriptor[]`. Each entry contains:

- `modelMatrix`, `invModelMatrix`
- contrast / gamma / opacity
- colormap LUT index (into the LUT texture)
- per-LOD info (shape, indirection offset)
- proxy slot handles (`fieldProxyPoolIndex`, `fieldProxySlotIndex`, well-proxy equivalents)

Shaders use `entityIndex` to look up its descriptor. The tick coordinator and worker share an explicit ordered `(memberId → index)` map so indices match by construction — both sides iterate the same active set in the same order.

The byte layout is owned by `renderer/descriptor/layout.ts` as named offset constants (`OFFSET_MODEL_MATRIX`, `OFFSET_FIELD_PROXY_DIMS`, `LOD_OFFSET_CHUNK_DIMS`, etc.). Both writers — the canonical `descriptorBuffer.serializeEntityDescriptor` and the transient `descriptor/transient.serializeTransientDescriptor` (minimap path) — read offsets from that file. `renderer/descriptor/layout.test.ts` parses the `EntityDescriptor` struct from both `slice.wgsl` and `volume.wgsl` and asserts agreement against the TS constants; if the WGSL struct changes without updating `layout.ts` (or vice versa) the lock test fails. See ADR 0035 for the design rationale.

## Semantic fallback chain

Per fragment in `slice.wgsl` / `volume.wgsl`:

1. Read `descriptors[entityIndex]`.
2. Project fragment to entity-local voxel coords.
3. Compute `(z, y, x)` cell within the chosen LOD.
4. Read `indirection[lod.indirectionOffset + cellIndex]` → atlas slot.
5. **Fallback chain** (DOMAINS step 9, merged in `4aec276`):
   - Try detail at target LOD.
   - Fallback: coarser detail LODs in range.
   - Fallback: field proxy texture.
   - Fallback: well proxy texture.
   - Last resort: blank.
6. Apply contrast → gamma → LUT sample → opacity.

The chain runs **inside the volume ray-march loop** as well, so a ray that crosses a region with missing detail still produces something coherent. Commit `b0a5985` hoisted the `EntityDescriptor` read out of the inner loop — significant on volume because it was being re-read per ray step.

## Cold-state ingestion

`coldState/apply.ts` is the cold-state orchestration. On every cold-state message it: (1) clears the routing Maps owned by the removed wells; (2) walks `iterateColdMembers(msg)` to repopulate `state.memberToDataset` + `state.memberToPool` via the canonical `memberIdForColdEntry` helper (the helper that fixes the well-as-proxy `imageId === ""` pool-registry bug — see ADR 0035); (3) rebuilds the per-dataset `entityMetas` snapshot; (4) rebuilds the descriptor buffer.

`coldState/groupEntries.ts` and `coldState/entityMetas.ts` are the pure pieces apply.ts delegates to. The discriminated `ColdStateActiveEntry` union (`kind: "field" | "well-as-proxy"`, replacing the `imageId === ""` sentinel) lives in [[worker-protocol]]; the apply pipeline narrows via `entry.kind` instead of sentinel-sniffing.

## Proxy lifecycle

`proxy/upload.ts` handles a `proxyAsset` message: validates the asset, allocates a slot in the right `(datasetId, kind, slotDims, channel)` pool, writes the u16 voxel buffer, and updates the descriptor handle pair on `state.proxyDescriptorsByEntity`.

`proxy/propagate.ts` is the well→fields fan-out: when a `WellProxy3D` lands for a well, every child field whose descriptor references that well gets its `wellProxyPoolIndex` / `wellProxySlotIndex` updated. The fan-out reads `state.wellToFields` (built per cold state) so each upload is O(children) instead of O(all-entities).

## De-globalized session state

Per-session state lives on a single `RendererState` interface owned by `WorkerCtx.state` and created in `worker/bootstrap.ts`. Every handler reads `ctx.state.<field>` rather than a module global. The state fields cluster into five groups: cold-state routing (`memberToDataset`, `memberToPool`, `wellToFields`, `wellsByDataset`, `currentEntityMetasByDataset`), proxy + descriptor registries (`proxyPoolsByDataset`, `proxyDescriptorsByEntity`, `descriptorBuffersByDataset`), per-mode atlas registries (`volumeAtlases`, `sliceAtlases`), per-entity eviction reference points (`rayHitPerEntity`, `cameraUVPerEntity`), and cold-state/epoch tracking (`currentEpochs`, `currentColdState`). Explicit state ownership is also what makes `removeLayerResources` clear the routing Maps alongside the atlas pools and descriptor buffers — see ADR 0035.

Renderer-class singletons (slice/volume/cursor/compositor) and persistent GPU resources (LUT cache, offscreen pool, dummy textures/buffers) intentionally stay at module scope in `worker/resources.ts` because they outlive any single session.

## Eviction and re-fetch loop

When the worker evicts an atlas slot to make room:

1. Posts a `chunksEvicted` message (evicted + skipped keys), keyed by `memberId`.
2. Includes the now-missing chunks in the next `wantedSetDelta`.
3. Main thread clears `proxyDeliveredToWorker` for the missing keys → next drain re-uploads if the chunk is still in the [[cpu-cache]], or re-requests if it's already gone.

This is why **plate FPS is sensitive to pool capacity and CPU-cache size** — eviction churn cascades. See [[decisions/0004-multi-pool-atlases]].

## Interactions

- **Upstream**: the [[upload-pipeline|Uploader]] posts `coldState`, `viewHotState`, `sliceChunkData`, `volumeChunkData`, `proxyAsset` messages over [[worker-protocol]]. The planner-only TickCoordinator drives the Uploader.
- **Downstream**: the worker presents to the OffscreenCanvas; communicates back via `wantedSetDelta`, `chunksEvicted`, `frameStats`, `intensityRange`.

## Invariants

- **`entityIndex` matches between CPU and GPU.** Both sides build their lists by iterating the active set in identical order. Drift here is a class of bug that only surfaces visually (wrong colormap on the wrong entity).
- **Every per-session Map lives on `WorkerCtx.state`.** Module-level mutable state in render-side files is a regression; the lint to enforce is `grep -E '^(const|let|var) .* = new Map' renderer/{volume,slice,coldState,proxy,worker}/*.ts` — should return nothing.
- **memberId is the canonical owner key on every wire message** (`chunksEvicted.memberId`, `volumeChunkData.memberId`, `sliceChunkData.memberId`). `proxyAsset` and `coldState` correctly stay `datasetId`-keyed because they really are per-dataset; every member-routed message uses `memberId`.
- **Descriptor byte offsets live only in `descriptor/layout.ts`.** Both TS writers and both WGSL shaders must agree; `layout.test.ts` enforces this by parsing the shaders at test time.
- **Atlas slot IDs are pool-local.** A slot ID `42` in pool A is unrelated to slot `42` in pool B. The descriptor's per-LOD info encodes which pool to read.
- **Indirection writes are batched per frame** — many residency changes coalesce into one mapped buffer write. Don't add a per-chunk write call.
- **Cold state is rebuilt only when WASM epochs say something changed.** The tick coordinator's epoch fast-path skips ~95% of frames, ~5% rebuild. Forcing a rebuild every frame turns a 60fps view into a slideshow.

## Gotchas

- **Worker eviction is asynchronous from the main thread's perspective.** Don't assume `client.volumeChunkData(...)` lands instantly; the worker may have evicted by the time the next tick reads back. The reconciliation path through `wantedSetDelta` is what keeps things correct.
- **Pool keys include `channel`** — `(datasetId, kind, slotDims, channel)`. Adding multi-channel mode without re-keying pools regresses to all-channels-fight-for-one-pool, which kills plate FPS.
- **`memberIdForColdEntry` is the only correct way to derive a memberId.** Inline `${entry.imageId}:ch${channel}` produces `:ch5` for well-as-proxy entries (where `imageId` is absent on the discriminated `kind: "well-as-proxy"` variant). The discriminated union makes the type checker refuse the inline form.
- **Volume's per-entity scissor for well-as-proxy entries** lives in `volumePath.ts:15-65`. Skips fragments outside the well's screen-space AABB. If a well is rendering visibly outside its footprint, this is the place to look.
- **Compositor key naming is asymmetric**: `imageId:chN` for multichannel, bare `imageId` for single-channel. Mixing the two halves silently produces the wrong final composite.
