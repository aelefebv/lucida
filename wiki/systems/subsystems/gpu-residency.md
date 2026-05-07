---
created: 2026-04-18
modified: 2026-05-07
---

# GPU Residency

How chunk bytes become atlas slots become indirection-buffer entries become shader-sampled pixels. Lives in `lucida-web/src/renderer/`. All WebGPU work happens inside `gpu.worker.ts` on a dedicated Web Worker — see [[decisions/0003-gpu-on-dedicated-worker]].

## Atlases and indirection

The GPU side never holds "one texture per chunk." That would shred VRAM and the bind-group cache. Instead:

- **Slice atlas** — one per dataset, ~64 MB, X-Y grid layout. Holds 2D slice tiles.
- **Volume atlas** — shared per dataset, ~512 MB, partitioned into per-entity-LOD sections (Shared Pools v1).
- **Proxy atlases** (`renderer/proxyAtlas.ts`) — one **pool** per `(datasetId, kind, slotDims, channel)`. 64 slots/pool, 1-D layout along X. Pure LRU.

An **indirection buffer** (a `array<u32>` storage buffer) maps logical `(entity, lod, z, y, x)` → atlas slot coords. The shader reads it before sampling the atlas texture. Indirection is only flushed when chunk residency actually changes (atlas write/evict), not every frame — this is a big perf win because indirection writes are otherwise per-frame and bandwidth-bound.

## Descriptor buffer

`renderer/descriptorBuffer.ts` — a GPU storage buffer of `EntityDescriptor[]`. Each entry contains:

- `modelMatrix`, `invModelMatrix`
- contrast / gamma / opacity
- colormap LUT index (into the LUT texture)
- per-LOD info (shape, indirection offset)
- proxy slot handles (`fieldProxyPoolIndex`, `fieldProxySlotIndex`, well-proxy equivalents)

Shaders use `entityIndex` to look up its descriptor. The orchestrator and worker share an explicit ordered `(memberId → index)` map so indices match by construction — both sides iterate the same active set in the same order.

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

## Eviction and re-fetch loop

When the worker evicts an atlas slot to make room:

1. Posts a `chunksEvicted` message (evicted + skipped keys).
2. Includes the now-missing chunks in the next `wantedSetDelta`.
3. Main thread clears `proxyDeliveredToWorker` for the missing keys → next drain re-uploads if the chunk is still in the [[cpu-cache]], or re-requests if it's already gone.

This is why **plate FPS is sensitive to pool capacity and CPU-cache size** — eviction churn cascades. See [[decisions/0004-multi-pool-atlases]].

## Interactions

- **Upstream**: the [[chunk-pipeline|orchestrator]] posts `coldState`, `viewHotState`, `sliceChunkData`, `volumeChunkData`, `proxyAsset` messages over [[worker-protocol]].
- **Downstream**: the worker presents to the OffscreenCanvas; communicates back via `wantedSetDelta`, `chunksEvicted`, `frameStats`.

## Invariants

- **`entityIndex` matches between CPU and GPU.** Both sides build their lists by iterating the active set in identical order. Drift here is a class of bug that only surfaces visually (wrong colormap on the wrong entity).
- **Atlas slot IDs are pool-local.** A slot ID `42` in pool A is unrelated to slot `42` in pool B. The descriptor's per-LOD info encodes which pool to read.
- **Indirection writes are batched per frame** — many residency changes coalesce into one mapped buffer write. Don't add a per-chunk write call.
- **Cold state is rebuilt only when WASM epochs say something changed.** The orchestrator's epoch fast-path skips ~95% of frames, ~5% rebuild. Forcing a rebuild every frame turns a 60fps view into a slideshow.

## Gotchas

- **Worker eviction is asynchronous from the main thread's perspective.** Don't assume `client.volumeChunkData(...)` lands instantly; the worker may have evicted by the time the next tick reads back. The reconciliation path through `wantedSetDelta` is what keeps things correct.
- **Pool keys include `channel`** — `(datasetId, kind, slotDims, channel)`. Adding multi-channel mode without re-keying pools regresses to all-channels-fight-for-one-pool, which kills plate FPS.
- **Volume's per-entity scissor for well-as-proxy entries** lives in `volumePath.ts:15-65`. Skips fragments outside the well's screen-space AABB. If a well is rendering visibly outside its footprint, this is the place to look.
- **Compositor key naming is asymmetric**: `imageId:chN` for multichannel, bare `imageId` for single-channel. Mixing the two halves silently produces the wrong final composite.
