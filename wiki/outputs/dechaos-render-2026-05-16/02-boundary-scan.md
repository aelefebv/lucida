# Pass 2: Boundary Scan — render phase

What follows is a ranked list of seams where responsibilities are blended together in the render code today.

## Top seams (severity-ordered)

### Seam A — Cold-state ingestion inside the worker dispatch (`gpu.worker.ts:506–753`)

The 200+-line `case "coldState"` block does, inline:

1. Refreshes `wellToFields` from `parentWellId`.
2. Registers `memberToDataset` (with two key conventions: imageId vs entityId, single vs multi-channel).
3. For each pool group `(channel × chunkDims)`: builds `entityMetas` with absolute offsets, then calls `getOrCreateVolumePool` + `resizeIndirection` + `remapIndirection`.
4. Captures `currentEntityMetasByDataset` snapshot.
5. Rebuilds the per-dataset descriptor buffer.
6. Posts `wantedSetDelta`.

The **same logic runs in two near-duplicate branches** for `viewMode === "volume"` vs `"slice"`. Pure data flow inside an I/O dispatcher.

**Suggested boundary:** `renderer/coldState/` with one entry function `applyColdState(ctx, msg, state) → wantedSetSeed` and submodules: `groupEntries.ts`, `entityMetas.ts`, `memberRegistry.ts`, `apply.ts`. The dispatch case shrinks to ~20 lines.

### Seam B — Atlas-state-and-driver fusion (`volumeHandlers.ts` + `sliceHandlers.ts`)

Each "handler" file mixes:

- **Atlas allocation/destruction** (`createVolumeAtlas`, `destroyAtlas`) — needs `device`, GPU-touching.
- **Indirection remap** (`remapIndirection`) — pure, no GPU.
- **Chunk upload** (`handleVolumeChunkData`) — staleness check + LRU eviction + `device.queue.writeTexture` + intensity sampling + post-message reporting.
- **Render-multipass orchestration** (`handleVolumeRenderMultiPass`) — iterate layers + descriptor lookup + atlas lookup + hasDetail gating + proxy texture resolution + renderer state setup + composite + cursor draw.
- **Eviction policy** (`findFarthestSlot` + `chunkDistSq`) — pure, depends on `rayHitPerEntity`/`cameraUVPerEntity`.

The render-multipass functions are **doing the work of an orchestrator** in the same module that owns the atlas state.

**Suggested split per mode:**
- `renderer/volume/atlas.ts` — pool create/destroy + chunk upload + eviction.
- `renderer/volume/remap.ts` — pure remap (already tested).
- `renderer/volume/render.ts` — render-multipass driver.
- (parallel for slice/)

### Seam C — Member/pool registry as ambient state (worker)

`memberToDataset`, `memberToPool`, `currentEntityMetasByDataset` are populated in `case "coldState"` and read by chunk handlers and render handlers. They're effectively a small **routing registry**, but they live as bare Maps.

**Suggested boundary:** `renderer/worker/memberRegistry.ts` — a single small object passed via `WorkerCtx` rather than top-level Maps. Makes the contract "writers update this, dispatchers read this" explicit, and gives tests a handle.

### Seam D — Proxy lifecycle orchestrator (`handleProxyAssetData`)

`handleProxyAssetData` (gpu.worker.ts:268–364) is ~100 lines doing:

1. Staleness check.
2. Buffer length validation.
3. Pool get-or-create.
4. Slot allocation (with eviction counter side effect).
5. `device.queue.writeTexture`.
6. Descriptor entity table update.
7. Well-to-fields fan-out (mutates many entity descriptors).
8. Per-dataset descriptor buffer rebuild (only if cold state matches).
9. `postWantedSet`.

The well-to-fields fan-out is its own concern (propagation), as is the descriptor-buffer rebuild trigger.

**Suggested split:**
- `renderer/proxy/upload.ts` — handleProxyAssetData reduced to: validate → allocate → upload → record → return changeset.
- `renderer/proxy/propagate.ts` — well-to-fields propagation (pure).
- A small "descriptor invalidator" that the worker subscribes to.

### Seam E — Module-level mutable state across 4 files

`atlasPerDataset` exists in **both** `volumeHandlers.ts` AND `sliceHandlers.ts` (different Maps, same variable name). `gpu.worker.ts` has 8 more module-level Maps; `minimapHandlers.ts` has 5 more.

This makes:
- Concurrent rendering of two datasets reliable only because the worker is single-threaded.
- Testing of the handlers requires either Vitest module-cache resets or accepting that the second test sees prior state.
- Tracing "what does this depend on" requires reading the entire module file.

**Suggested boundary:** instantiate atlas state per dataset/pool in a `RendererState` object owned by `WorkerCtx`. The handlers' module globals become injected dependencies.

### Seam F — `EntityDescriptor` byte layout duplicated across 4 sites

- `descriptorBuffer.ts` `serializeEntityDescriptor` (hardcoded `u32[33]`, `u32[40]`, etc).
- `descriptorBuffer.ts` declares offset constants (`DESCRIPTOR_LODS_OFFSET = 224`, etc.) but the serializer uses *hardcoded indices* in the same file rather than reading from those constants.
- `volumeRenderer.setTransientDescriptor` (separate serializer for minimap path — same byte offsets, separate code).
- `volume.wgsl` and `slice.wgsl` both declare the struct (identical text in both shaders).

The test in `descriptorBuffer.test.ts` locks the TS byte layout. Nothing locks shader struct ↔ TS layout agreement (only convention + the proxy-shader-binding tests' uniform-size locks).

**Suggested boundary:**
- `renderer/descriptor/layout.ts` — declare every offset/size as a constant, used by both serializers + a generated WGSL string snippet.
- Or: a build-time codegen step that emits the WGSL struct from the TS layout.

### Seam G — Member-id construction logic scattered across 4 sites

The convention is:
- Single-channel field: `entry.imageId`
- Multi-channel field: `${entry.imageId}:ch${channel}`
- well-as-proxy single: `entry.entityId`
- well-as-proxy multi: `${entry.entityId}:ch${channel}`

Sites that rebuild this convention:
- `gpu.worker.ts` cold-state handler (lines 533–551, 583, 668) — *conditional inline*
- `descriptorBuffer.ts` `memberIdForColdEntry()` — *canonical helper exists*
- `wantedSet.ts` chunk wanted-set block (lines 191–197) — *conditional inline*
- Various render-handler `layerToPool` callbacks (gpu.worker.ts:435–469).

**Suggested boundary:** force every site through `memberIdForColdEntry` / a small `MemberIdParser`. Eliminate the inline reconstructions.

### Seam H — Pool-key encoding is two different schemes

Chunk pool keys (built inline in cold-state handler):
- Single-channel: `${datasetId}:${chunkX}x${chunkY}x${chunkZ}`
- Multi-channel:  `${datasetId}:ch${channel}:${chunkX}x${chunkY}x${chunkZ}`

Proxy pool keys (`proxyAtlas.proxyPoolKey`):
- `${datasetId}|proxy|${kind}|${x}x${y}x${z}|ch${channel}`

Different separators (`:` vs `|`), different field orderings, no shared helper.

**Suggested boundary:** `renderer/poolKeys.ts` — `chunkPoolKey(datasetId, channel, chunkDims, isMultiCh)` + reuse `proxyPoolKey`. Same module documents the conventions.

### Seam I — Chunk-key parsing in the wrong place

`parseChunkKey`, `makeCompositeKey`, `parseCompositeKey`, `derivePoolKey` all live in `volumeHandlers.ts` and are imported by `sliceHandlers.ts` (and by `wantedSet.ts` via similar string concatenation inline). The volume handler is the de-facto owner of a wire-format concern that isn't volume-specific.

**Suggested boundary:** `renderer/chunkKeys.ts` (or `pipeline/upload/keys.ts` since `pipeline/upload/proxyKeys.ts` already exists for proxies). Single source of truth for the `level/t/c/z/y/x` format.

### Seam J — Renderer classes (`SliceRenderer`/`VolumeRenderer`) carry transient draw state across calls

`SliceRenderer` has setters (`setAtlas`, `setProxyTextures`, `setColormapTexture`, `setDescriptorBinding`, `setTransform`) called in arbitrary order per layer. Whether the bind group is rebuilt is decided by the setter (some always rebuild, some only set the field). After a `renderTo`, internal state is "still set". Re-use across layers (in render-multipass) depends on the caller knowing what was/wasn't changed.

This is well-encapsulated within the class but the **contract about "what carries over" is implicit**.

**Suggested boundary:** either (a) make `renderTo(params)` accept a `DrawParams` value and have the class be stateless across draws, or (b) document the carry-over contract on the class doc comment + test.

### Seam K — Minimap is a parallel mini-pipeline that reuses `VolumeRenderer`

`minimapHandlers.ts` has its own offscreen pool, its own overview-volume state, and calls `volumeRenderer.setVolume(...)` + `volumeRenderer.setTransientDescriptor(...)`. `VolumeRenderer.setTransientDescriptor` exists *only* to serve the minimap path and is a third site of the descriptor byte-layout duplication (Seam F).

**Suggested boundary:** consider a parallel `MinimapRenderer` that doesn't piggyback on `VolumeRenderer`, OR a small `DescriptorBuilder` shared by all paths.

### Seam L — `gpu.worker.ts` resource-singleton soup

Mixed into the worker file: LUT cache, offscreen pool, dummy 2D texture, dummy 3D texture, `currentColdState`, `currentEpochs`, `proxyStats` (devtools), `__lucidaProxyPools` global, `__lucidaProxyDescriptors` global.

Three different concerns share the file: dispatch, lifecycle, devtools/HITL.

**Suggested boundary:**
- `renderer/worker/resources.ts` — LUT cache + offscreen pool + dummy textures.
- `renderer/worker/devtools.ts` — `self.__lucidaXxx` exports.
- `renderer/worker/lifecycle.ts` — `destroy` handler.

### Seam M — `intensitySampler` import inside chunk handlers

`sliceHandlers.ts` and `volumeHandlers.ts` both call `sampleIntensityRange` from `../zarr/intensitySampler.ts` and post an `intensityRange` message on change. This is **telemetry that happens to live inside chunk upload** — it's correct functionally (sampling here avoids a second pass), but mixing intensity reporting in with atlas mutation makes both harder to reason about.

**Suggested boundary:** keep the sampling call but extract `reportIntensityRange(ctx, atlas, member)` as a tiny helper that's clearly a side reporting channel.

### Seam N — `chunksEvicted` carries memberId in a `datasetId` field

Wire-protocol misnomer. The handlers post `{ type: "chunksEvicted", datasetId: memberId, ... }`. Downstream `RenderClient.onChunksEvicted` re-emits as a `(datasetId, keys, skipped)` triple, and `pipeline/upload/delivery/feedback.ts` treats the value as a member id. The field name is **wrong everywhere except the type declaration**.

**Suggested boundary:** rename to `memberId` in `workerProtocol.ts` and downstream handlers. (Same applies to `volumeChunkData.datasetId` and `sliceChunkData.datasetId`.) Pure-rename change.

### Seam O — Cross-pool intensity reporting

When two pools serve the same dataset (different chunk dims), each pool tracks its own `intensityMin/Max` and reports `{ datasetId: memberId, min, max }` independently. The downstream consumer (`useIntensityBatcher.ts`) doesn't know there are multiple pools — it sees per-member intensity reports. Today this happens to work because intensity is per-member-resolved, but the bookkeeping (intensity per pool) feels misplaced.

**Suggested boundary:** intensity tracking belongs in a per-member ledger, not per-pool. Or move it out of chunk upload entirely and compute it as a separate concern.

## Summary

15 seams identified. The high-severity ones (A–E) all stem from the same shape: **mutation-heavy ingestion code embedded in the dispatch file**, with state spread across module globals. The pattern matches the pre-refactor planning.ts and cpuCache.ts shapes exactly.

Seams F–J are about **contract clarity** — duplicate byte layouts, duplicated string-building conventions. These are independent low-risk wins.

Seams K–O are **smaller cleanups** that may or may not warrant their own slices.
