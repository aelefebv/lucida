# Pass 3: Responsibility Scan — render phase

Goal: identify files / functions / classes that can't be summarized in a single sentence and the responsibilities those units actually carry.

## Overloaded units, ranked by impact

### Unit: `gpu.worker.ts` (815 LOC)

**Current name suggests:** "the GPU render worker."

**Actual responsibilities (14):**

1. Worker bootstrap (`init` handling, `initGPU`, WorkerCtx assembly).
2. Dispatch (the message-type switch).
3. Cold-state ingestion — pool grouping, entity-meta computation, indirection resize/remap, descriptor build (200+ lines inline).
4. Proxy upload pipeline — staleness, pool resolve/create, slot allocate, GPU write, descriptor update, well-fanout, descriptor rebuild, wanted-set re-emit (`handleProxyAssetData`).
5. Member/pool routing registry (3 Maps).
6. Well→fields parent registry (1 Map, populated from cold state).
7. Per-dataset descriptor buffer registry (1 Map + lifecycle).
8. Per-dataset proxy pools registry (1 Map + lifecycle).
9. Per-entity proxy descriptor registry (1 Map + lifecycle).
10. LUT texture cache (read-through cache from colormap names).
11. Shared offscreen texture pool (count × W × H reuse).
12. Dummy 2D/3D textures (lazy allocation, format hardcoded).
13. Devtools/HITL hooks (`__lucidaProxyStats`, `__lucidaProxyPools`, `__lucidaProxyDescriptors`).
14. Lifecycle (`destroy` case — 35 lines tearing down all of the above).

**Diagnosis:** equivalent to pre-slice `planning.ts`, `cpuCache.ts`, `orchestrator.ts`. Cannot be summarized in one sentence.

**Suggested split:**
- `worker/bootstrap.ts` — initGPU + WorkerCtx assembly + lazy renderer accessors.
- `worker/dispatch.ts` — the message switch.
- `worker/coldState.ts` — cold-state ingestion (Pass 2 Seam A).
- `worker/proxy.ts` — handleProxyAssetData (Pass 2 Seam D).
- `worker/memberRegistry.ts` — member→dataset, member→pool, well→fields (Pass 2 Seams C, G).
- `worker/resources.ts` — LUT cache, offscreen pool, dummy textures (Pass 2 Seam L).
- `worker/devtools.ts` — `self.__lucidaXxx` exports.
- `worker/lifecycle.ts` — `destroy` handler.

### Unit: `volumeHandlers.ts` (646 LOC)

**Current name suggests:** "handlers for volume messages."

**Actual responsibilities (8):**

1. `AtlasState` type + `LodIndirectionMeta` type — owned here even though `sliceHandlers.ts` and `wantedSet.ts` mirror them.
2. Chunk-key + composite-key parsing (`parseChunkKey`, `makeCompositeKey`, `parseCompositeKey`, `derivePoolKey`).
3. Atlas allocation/destruction (`createVolumeAtlas`, `destroyAtlas`, `getOrCreateVolumePool`).
4. Indirection remap (`remapIndirection`) — pure, tested.
5. Chunk upload (`handleVolumeChunkData`) — eviction policy + intensity sampling + post-message demux.
6. Eviction policy (`chunkDistSq`, `findFarthestSlot`).
7. View hot-state application (`applyViewHotState`, `rayHitPerEntity`).
8. Render-multipass orchestration (`handleVolumeRenderMultiPass`) — descriptor lookup + atlas check + hasDetail gate + proxy resolve + render-call sequencing + cursor draw.

**Diagnosis:** the file is "volume mode everything" — atlas, eviction, ingestion, render driver. The render-multipass function alone is ~150 LOC of orchestration.

**Suggested split:**
- `volume/atlas.ts` — atlas state + create/destroy/get-or-create.
- `volume/remap.ts` — `remapIndirection`.
- `volume/upload.ts` — `handleVolumeChunkData`.
- `volume/eviction.ts` — `chunkDistSq` + `findFarthestSlot` + `rayHitPerEntity` + `applyViewHotState`.
- `volume/render.ts` — `handleVolumeRenderMultiPass`.
- `chunkKeys.ts` (shared) — `parseChunkKey`, `makeCompositeKey`, etc.

### Unit: `sliceHandlers.ts` (554 LOC)

Parallel structure to `volumeHandlers.ts` minus the depth texture. Same eight responsibilities, plus:

9. Z-slice retargeting on `currentZ` change (`computeTargetChunkZ`, `staleSliceKeys` tracking).
10. Per-entity Z metadata (`SliceEntityZInfo`) — captured on first chunk arrival.

**Diagnosis:** same disease as `volumeHandlers.ts`. The Z-slice retargeting is a slice-specific responsibility that should stay together but doesn't need to live in the same module as eviction or render orchestration.

**Suggested split:** parallel to volume above, with the slice-specific Z math in `slice/zRetarget.ts`.

### Unit: `minimapHandlers.ts` (194 LOC)

**Actual responsibilities (5):**

1. Minimap canvas context init.
2. Per-dataset overview volume registry (`minimapOverviewPerDataset`).
3. Overview texture upload — full (`handleMinimapSetOverview`) and chunked (`handleMinimapUploadOverviewChunks`).
4. Minimap render orchestration — reuses `VolumeRenderer` with a transient descriptor (Pass 2 Seam K).
5. Lifecycle (destroy / per-dataset cleanup).

**Diagnosis:** more cohesive than the slice/volume handlers, but it owns a parallel offscreen pool with the same code shape as `gpu.worker.ts`'s pool. Sharing the worker's `ensureOffscreenPool` would reduce duplication.

**Suggested:** keep as one file for now; consolidate offscreen-pool helpers into `worker/resources.ts`.

### Unit: `descriptorBuffer.ts` (400 LOC)

**Actual responsibilities (5):**

1. Wire constants for the byte layout (size, offsets, sentinel, max LODs).
2. Canonical iteration (`memberIdForColdEntry`, `iterateColdMembers`, `computeMemberIndexMap`).
3. `EntityDescriptorIndex` type (the result wrapper).
4. `buildDescriptorBuffer` — two-pass build: assign indices in pass 1, serialize in pass 2; allocates the GPU buffer.
5. `serializeEntityDescriptor` — byte-level write of one descriptor (~90 LOC, hardcoded u32 indices).

**Diagnosis:** mostly cohesive; the two-pass build + serialization belongs together. **The hardcoded u32 indices in `serializeEntityDescriptor` are the responsibility that needs separating** — they encode the same offsets that the named constants up top declare, but as magic numbers.

**Suggested cleanup:** make `serializeEntityDescriptor` use named field-offset constants throughout. Then a `layout.ts` module is the single source of byte-layout truth.

### Unit: `handleSliceRenderMultiPass` / `handleVolumeRenderMultiPass`

Each ~150 LOC. Per layer they:

1. Resolve member→pool→datasetId.
2. Lookup the per-dataset entity descriptor buffer.
3. Lookup the atlas + entity LOD metas (or skip if missing).
4. Compute `hasDetail` (a derived flag with downstream effect).
5. (slice only) Update `cameraUVPerEntity` for the next eviction round.
6. Write atlas indirection buffer if dirty.
7. Resolve proxy texture handles from descriptor via `lookupProxyDescriptor`.
8. Skip-render if neither detail nor resident proxy.
9. Set proxy textures on the renderer.
10. Set atlas (real or dummy with proxy dims).
11. Resolve colormap LUT.
12. Bind transform / matrices / descriptor.
13. Submit render to offscreen.
14. Push to renderedLayers for composite.

After the loop: composite all layers, then cursor draw.

**Diagnosis:** an orchestrator nested inside a "handler." 14 responsibilities per layer. Several derived states (`hasDetail`, `wellProxySlotResident`, `wellSlotDimsForVolumeFallback`) computed inline.

**Suggested:** extract `LayerDrawPlan` (a value object with all resolved bindings) computed once per layer in a pure function; the render loop is then a thin "for layer in plan: configure + draw."

### Unit: `SliceRenderer` / `VolumeRenderer` classes

Each carries:
- WebGPU pipeline + bind-group layouts.
- A uniform buffer + entity-ref buffer + dummy texture(s).
- "Current" bindings: `atlasTexture`, `indirectionBuffer`, `lutTexture`, `fieldProxyTexture`, `wellProxyTexture`, `currentDescriptorBuffer`, `bindGroup`, `descriptorBindGroup`.
- Configuration setters: `setAtlas`, `setProxyTextures`, `setColormapTexture`, `setDescriptorBinding`, `setTransform` / `setMatrices`.
- `renderTo(target, encoder, ...)` — actually draws.
- (`VolumeRenderer` additionally) `setTransientDescriptor`, `setVolume`, single-slot indirection buffer, transient depth texture.

**Diagnosis:** these classes blend **pipeline ownership** with **per-draw state staging**. They work because the worker calls them in a known sequence, but the contract about what carries over between draws is implicit. `VolumeRenderer.setTransientDescriptor` is a minimap-only escape hatch that duplicates the descriptor byte layout.

**Suggested:** rename to make the responsibilities visible (`SlicePipeline` for the pipeline-owning part; a separate `SliceDrawCall` value object passed to `renderTo`). Move `setTransientDescriptor` into a `descriptor/transient.ts` shared by all paths that need a single-entity descriptor.

### Unit: `RenderClient` (305 LOC)

**Actual responsibilities (3):**

1. Worker construction + `init` postMessage + ready promise.
2. Method-per-message-type wrapper (15 methods).
3. Message-type-to-callback fan-out (`onIntensityRange`, `onChunksEvicted`, `onWantedSetDelta`, `onMessage` switch).

**Diagnosis:** cohesive. The class is the wire boundary. The 15 method wrappers are repetitive but each does meaningful transferable-buffer slicing.

**Suggested:** keep as-is. Possibly extract the buffer-transfer pattern into a tiny helper.

### Unit: `proxyAtlas.ts` (228 LOC)

Already pure + cohesive. Eight exports, all related to "a proxy atlas pool":
- Types (`ProxyAtlasState`, `ProxyHandle`).
- Key helpers (`proxyPoolKey`, `proxySlotKey`).
- Lifecycle (`createProxyAtlas`, `destroyProxyAtlas`).
- Slot management (`allocateProxySlot`, `lookupProxySlot`, `touchProxySlot`).
- Geometry (`proxySlotOrigin`).
- Pure LRU policy.

**Diagnosis:** healthy. Don't touch.

### Unit: `wantedSet.ts` (310 LOC)

Already pure + cohesive. One main export `computeWantedSet`, two supporting types. Heavily tested. Don't touch.

### Unit: `epochCheck.ts` (16 LOC)

One function. Don't touch.

### Unit: `dataTypeUtil.ts` (52 LOC)

Two functions, both about coercing incoming raw chunk buffers. Don't touch.

### Unit: `workerProtocol.ts` (431 LOC)

Single concern: wire-protocol message types. The file is long but every export is a message type or constant. Some structural fixes already landed (the unified `Chunk` type per pass 5 finding).

**Soft issue:** `chunksEvicted.datasetId` is mis-named (carries memberId). Rename in next pass.

## Naming inconsistencies

- `atlasPerDataset` (in 2 modules) is **not actually per-dataset** — it's per-poolKey. Pool keys can have multiple per dataset (per channel × chunk dims). Misnomer.
- `handle*ChunkData` and `handle*RenderMultiPass` are "handlers" only in the message-dispatcher sense; functionally they're orchestrators.
- `chunksEvicted.datasetId` carries memberId.
- `volumeChunkData.datasetId` / `sliceChunkData.datasetId` carry memberId.
- `setVolume` (`VolumeRenderer`) wraps a "monolithic single-slot atlas" — a name like `setSingleSlotAtlas` would be clearer.
- `dummyTexture` / `dummy3DTexture` / `dummyProxyTexture` / `dummyIndirectionBuf` / `dummySliceIndirectionBuf` — five dummy resources, each defined separately. Cohesion problem: each handler/renderer has its own dummies.

## "Same concept scattered" findings

| Concept | Sites |
|---|---|
| Member-id construction | gpu.worker.ts (4 places inline), descriptorBuffer.ts (canonical helper), wantedSet.ts (inline) |
| Pool-key encoding | gpu.worker.ts cold-state (2 inline schemes for chunk pools), proxyAtlas.ts (proxy pools) |
| `EntityDescriptor` byte layout | descriptorBuffer.ts (writer), volumeRenderer.ts (transient writer), volume.wgsl (struct), slice.wgsl (struct) |
| LRU eviction with distance | volumeHandlers.ts `findFarthestSlot` + `chunkDistSq` (3D), sliceHandlers.ts `findFarthestSlot2D` + `chunkDistSq2D` (2D) |
| `remapIndirection` | volumeHandlers.ts (3D), sliceHandlers.ts (2D with Z filter) |
| Dummy textures/buffers | gpu.worker.ts (`dummyTexture`, `dummy3DTexture`), sliceHandlers.ts (`dummySliceIndirectionBuf`), volumeHandlers.ts (`dummyIndirectionBuf`), sliceRenderer.ts (`dummyTexture`, `dummyIndirectionBuffer`, `dummyProxyTexture`), volumeRenderer.ts (`dummyProxyTexture`, `singleSlotIndirectionBuf`) |
| Offscreen pool | gpu.worker.ts (main), minimapHandlers.ts (parallel copy) |
| Intensity-range sampling | sliceHandlers.ts + volumeHandlers.ts + minimapHandlers.ts (each calls the same `sampleIntensityRange` and posts the same message type) |

## Summary

The five biggest units (`gpu.worker.ts`, `volumeHandlers.ts`, `sliceHandlers.ts`, `descriptorBuffer.ts`'s serializer, `minimapHandlers.ts`) all suffer from blending **pipeline state**, **registry state**, and **per-draw orchestration**. The pure pieces (`proxyAtlas.ts`, `wantedSet.ts`, `epochCheck.ts`, `dataTypeUtil.ts`, `descriptorBuffer.ts`'s build/iterate side) are already well-factored; the orchestration is the slop.

The biggest single win is splitting the cold-state ingestion out of the worker file. That alone shrinks `gpu.worker.ts` by ~25% and gives the cold-state path a testable seam.
