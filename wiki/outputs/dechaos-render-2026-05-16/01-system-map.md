# Pass 1: System Map — render phase

Date: 2026-05-16. Scope: everything in `lucida-web/src/renderer/` plus the worker-touching surfaces of `pipeline/upload/uploadClient.ts` and the four shader entry points. Previous /dechaos passes covered plan, fetch/decode, and upload; render is the holdout.

## Files (line counts)

```
gpu.worker.ts        815   ← god file (mirrors pre-refactor orchestrator/cpuCache shape)
descriptorBuffer.test.ts 712
wantedSet.test.ts    671
volumeHandlers.ts    646
sliceHandlers.ts     554
volumeRenderer.ts    437
workerProtocol.ts    431   ← 17 message types + ColdState + ViewHotState + 5 response shapes
descriptorBuffer.ts  400   ← canonical iteration + serialization + dense pool indices
volume.wgsl          383
residency.test.ts    314
wantedSet.ts         310   ← pure function — already clean
renderClient.ts      305   ← main-thread typed worker wrapper
sliceRenderer.ts     300
proxyAtlas.test.ts   251
proxyAtlas.ts        228   ← pure LRU + slot allocation
slice.wgsl           211
minimapHandlers.ts   194
cursorRenderer.ts    187
gpuContext.ts        161
cursors.wgsl         149
proxyShaderBinding.test.ts 134
layerCompositor.ts   104
epochCheck.test.ts    61
workerContext.ts      55   ← WorkerCtx DI interface
dataTypeUtil.ts       52
compositor.wgsl       23
epochCheck.ts         16
```

Total: ~8129 LOC including tests. Non-test render code is ~4900 LOC.

## Entry points

- **Main → worker (15 message types):**
  `init`, `resize`, `coldState`, `viewHotState`, `sliceChunkData`, `volumeChunkData`, `proxyAssetData`, `sliceRenderMultiPass`, `volumeRenderMultiPass`, `minimapInit`/`Render`/`SetOverview`/`UploadOverview`/`Destroy`, `removeLayerResources`, `updateCursorData`, `destroy`.
- **Worker → main (4 message types):** `ready`, `error`, `intensityRange`, `chunksEvicted`, `wantedSetDelta`.
- **Single worker entry**: `gpu.worker.ts` `self.onmessage` switch (lines 368–815).
- **Main-thread entry**: `RenderClient` constructor (`renderClient.ts`). Owns one worker, instantiates the offscreen canvas, registers callbacks. Implements `UploadClient` (narrow facet consumed by `pipeline/upload/uploader.ts`).

## Main workflows

Per render tick, the orchestrator sends:

1. `coldState` (when epochs change) — worker rebuilds pool groups, allocates atlases, computes entityMetas, resizes indirection, remaps indirection, builds per-dataset descriptor buffer, posts `wantedSetDelta`.
2. `viewHotState` (when `view` epoch advances) — worker updates `rayHitPerEntity` for chunk eviction.
3. `proxyAssetData` per delivered proxy — worker stale-checks, resolves/creates pool, allocates slot (may evict LRU), uploads to texture, updates descriptor, fans well-proxy out to child fields, rebuilds descriptor buffer, posts `wantedSetDelta`.
4. `volumeChunkData` / `sliceChunkData` per drained CPU-cache batch — worker resolves pool, allocates slots (may evict via `findFarthestSlot`), uploads chunks, updates indirection, samples intensity, posts `chunksEvicted` + `intensityRange` if needed.
5. `volumeRenderMultiPass` / `sliceRenderMultiPass` — worker iterates layers, looks up descriptor + atlas + proxy textures, configures renderer, draws to offscreen, composites onto canvas, draws cursors.
6. `minimapRender` (whenever minimap dirties) — separate sub-pipeline reusing the volume renderer with a transient descriptor.

## Modules — what each owns

| Module | Concern | State scope |
|---|---|---|
| `gpu.worker.ts` | Worker bootstrap, message dispatch, **cold-state ingestion (200+ lines inline)**, proxy upload, member→dataset/pool routing, LUT cache, dummy textures, offscreen pool, lifecycle | 8 module-level Maps + 5+ singletons |
| `workerContext.ts` | `WorkerCtx` DI interface: device + lazy renderer accessors + lookup helpers | (type-only) |
| `workerProtocol.ts` | Wire-protocol message types + ColdState shape + display state + missing-chunk/proxy union | (type-only) |
| `renderClient.ts` | Main-thread typed wrapper; transfer-list management; routes worker→main callbacks | One `Worker` + callback fields |
| `sliceHandlers.ts` | 2D atlas state + remap + chunk upload + render-multipass orchestration + LRU eviction (per-entity cameraUV) | `atlasPerDataset`, `cameraUVPerEntity`, `dummySliceIndirectionBuf` |
| `volumeHandlers.ts` | 3D atlas state + remap + chunk upload + render-multipass orchestration + LRU eviction (per-entity rayHit) + depth texture | `atlasPerDataset`, `rayHitPerEntity`, `depthTexture`, `dummyIndirectionBuf` |
| `minimapHandlers.ts` | Per-dataset overview volumes (full uploads + chunked uploads) + minimap render | `minimapOverviewPerDataset`, `minimapContext`, `minimapOffscreenPool` |
| `proxyAtlas.ts` | Pure: proxy pool LRU + slot allocation + key derivation | (none — caller owns state) |
| `wantedSet.ts` | Pure: diff active-set against atlases → `MissingChunk \| MissingProxy[]` | (none) |
| `descriptorBuffer.ts` | Canonical iteration order, byte-layout serialization, dense pool/colormap indices, GPU buffer build | (none — produces `EntityDescriptorIndex`) |
| `sliceRenderer.ts` | 2D WebGPU pipeline + bind groups + uniform write + draw | Per-instance: bind groups, uniform buffer, current descriptor |
| `volumeRenderer.ts` | 3D WebGPU pipeline + bind groups + uniform write + draw (+ transient descriptor for minimap) | Per-instance + transient depth + single-slot indirection buffers |
| `layerCompositor.ts` | Per-blend-mode pipelines + composite loop | (none beyond pipelines) |
| `cursorRenderer.ts` | Peer cursor crosshairs / rays | Per-instance buffers |
| `gpuContext.ts` | `initGPU`, offscreen target creation, slice/volume texture writers | (none) |
| `epochCheck.ts` | `isStaleDelivery` predicate | (pure) |
| `dataTypeUtil.ts` | `asUint16` / `asUint16Slice` for incoming chunks | (pure) |

## External callers (outside `renderer/`)

- `pipeline/orchestrator.ts` — imports `computeMemberIndexMap` from `descriptorBuffer.ts` (canonical entity-index agreement).
- `pipeline/upload/uploader.ts` — imports types from `workerProtocol.ts`; calls `UploadClient` methods (subset of `RenderClient`).
- `pipeline/upload/uploadClient.ts` — defines `UploadClient` interface (narrow facet) + imports `workerProtocol.ts` types.
- `pipeline/upload/coldState/build.ts` — builds `ColdStateMessage` from snapshot.
- `pipeline/upload/coldState/hotState.ts` — builds `ViewHotStateMessage`.
- `pipeline/upload/coldState/displayState.ts` — populates `ColdStateActiveEntry.displayStateByChannel`.
- `pipeline/upload/delivery/dispatch.ts`, `delivery/tracker.ts`, `delivery/feedback.ts`, `delivery/resend.ts`, `delivery/drain.ts` — all touch the worker via `UploadClient` and consume `chunksEvicted` / `wantedSetDelta` callbacks.
- `hooks/useRenderClient.ts` — creates the singleton `RenderClient`.
- `hooks/usePreUpload.ts`, `hooks/useIntensityBatcher.ts` — wire renderClient callbacks into React state.
- `slicePath.ts`, `volumePath.ts`, `minimapPath.ts` — call `client.sliceRenderMultiPass(...)` / `volumeRenderMultiPass(...)` / `minimapRender(...)` per tick.
- `renderLoopTypes.ts` — type re-exports used by the loop.

## Worker-internal call graph (textual)

```
self.onmessage (gpu.worker.ts dispatch)
├── case "init" → initGPU → assemble WorkerCtx (lazy accessors)
├── case "coldState" → 200+ lines inline:
│     ├── refresh wellToFields
│     ├── register memberToDataset
│     ├── for each (channel, chunkDims): build PoolGroup
│     │     ├── volumeHandlers.getOrCreateVolumePool
│     │     ├── volumeHandlers.resizeIndirection
│     │     └── volumeHandlers.remapIndirection
│     │     (parallel slice path with sliceHandlers analogues)
│     ├── descriptorBuffer.buildDescriptorBuffer
│     └── postWantedSet → wantedSet.computeWantedSet
├── case "proxyAssetData" → handleProxyAssetData
│     ├── isStaleDelivery
│     ├── getOrCreateProxyPool → proxyAtlas.createProxyAtlas
│     ├── proxyAtlas.allocateProxySlot
│     ├── device.queue.writeTexture
│     ├── update proxyDescriptorsByEntity + fan out to wellToFields children
│     ├── rebuild descriptorBuffersByDataset
│     └── postWantedSet
├── case "volumeChunkData" → volumeHandlers.handleVolumeChunkData
│     ├── isStaleDelivery
│     ├── for each chunk: allocate/evict via findFarthestSlot → writeVolumeChunk
│     ├── update indirection + slots
│     ├── post chunksEvicted / intensityRange
│     └── postWantedSet (only if evictions/skips happened)
├── case "sliceChunkData" → sliceHandlers.handleSliceChunkData (parallel)
├── case "volumeRenderMultiPass" → volumeHandlers.handleVolumeRenderMultiPass
│     ├── per layer: lookupEntityDescriptor → atlas check → hasDetail gate
│     ├── lookupProxyDescriptor → resolve pool textures
│     ├── volumeRenderer.setProxyTextures / setAtlas / setMatrices / setDescriptorBinding
│     ├── volumeRenderer.renderTo (compositor.composite per layer)
│     └── cursorRenderer.renderVolume
├── case "sliceRenderMultiPass" → sliceHandlers.handleSliceRenderMultiPass (parallel)
├── case "minimapRender" → minimapHandlers.handleMinimapRender
│     ├── volumeRenderer.setVolume + setTransientDescriptor
│     └── volumeRenderer.renderTo + compositor.composite
└── case "destroy" → tear down 12+ resources
```

## Module-level mutable state inventory

Worker has at least **8 module-level Maps** (in `gpu.worker.ts` alone) plus 5+ singletons (LUT cache, offscreen pool, dummy textures, ctx):

- `memberToDataset` — member id → dataset id (built from cold state, used by render dispatch)
- `memberToPool` — member id → pool key (built from cold state, used by chunk dispatch)
- `currentEntityMetasByDataset` — per-dataset snapshot of LOD metas (captured per cold state, consumed by descriptor build)
- `proxyPoolsByDataset` — per-dataset → per-poolkey → `ProxyAtlasState`
- `proxyDescriptorsByEntity` — entity id → `{fieldProxyHandle, wellProxyHandle}`
- `wellToFields` — well id → set of child field entity ids (built from cold state)
- `descriptorBuffersByDataset` — per-dataset `EntityDescriptorIndex`
- `currentColdState`, `currentEpochs` — singletons used by `postWantedSet` and stale checks
- `lutCache`, `offscreenPool`, `poolWidth`, `poolHeight`, `dummyTexture`, `dummy3DTexture` — resource singletons

`volumeHandlers.ts`: `atlasPerDataset`, `depthTexture`, `dummyIndirectionBuf`, `rayHitPerEntity` — also module-level.

`sliceHandlers.ts`: `atlasPerDataset` (separate Map!), `cameraUVPerEntity`, `dummySliceIndirectionBuf` — also module-level.

`minimapHandlers.ts`: `minimapOverviewPerDataset`, `minimapContext`, `minimapOffscreenPool`, `minimapPoolWidth`, `minimapPoolHeight` — also module-level.

The worker is essentially a singleton process with module-level state spread across 4 files; only `WorkerCtx` is passed explicitly, but the handlers reach back into their own module globals once invoked.

## High-risk / confusing areas to revisit

1. **`gpu.worker.ts` case "coldState" (lines 506–753)** — 200+ lines inline doing pool grouping, per-LOD section computation, indirection resize/remap, descriptor build. Volume and slice branches are near-duplicates. Single longest unbroken block in the render code.
2. **`volumeHandlers.ts` and `sliceHandlers.ts`** are misnamed: each is "atlas state + LRU eviction + chunk upload + render driver" combined. Render-multipass functions iterate layers, resolve descriptors, gate on hasDetail, configure renderer state, submit — they're orchestrators, not handlers.
3. **`EntityDescriptor` byte layout** is mirrored across 4 sites (`descriptorBuffer.ts` serializer + `descriptorBuffer.ts` transient builder + `volume.wgsl` struct + `slice.wgsl` struct + `volumeRenderer.setTransientDescriptor` for minimap). One test locks bytes; nothing locks the WGSL side.
4. **`chunksEvicted.datasetId` field actually carries memberId.** Wire-protocol misnomer documented inline (`// protocol still names it datasetId; orchestrator sends memberId here`). Same applies to `volumeChunkData.datasetId` and `sliceChunkData.datasetId`.
5. **Axis-order shift across boundaries.** TS `[Z, Y, X]` ↔ WGSL `vec3<u32>` with `.x=X, .y=Y, .z=Z` for LodInfo. For proxy dims: TS `[Z, Y, X]` ↔ WGSL `vec3<u32>` where `.x=Z, .y=Y, .z=X`. Two different conventions in the same descriptor. Documented in inline comments but easy to miss.
6. **Implicit message ordering invariants** with silent failure modes:
   - `memberToPool` must be set before chunk data arrives (silent no-op otherwise: `if (!poolKey) break;`).
   - `descriptorBuffersByDataset` must exist before render (silent `continue` skips the layer).
   - `viewHotState` should arrive before render for correct eviction priority (works but stale).
7. **Two parallel "atlasPerDataset" Maps** (one in `volumeHandlers.ts`, one in `sliceHandlers.ts`) keyed by **poolKey** despite the variable name suggesting per-dataset. Pool keys can have multiple per dataset (per channel × chunk dims).

## Where natural seams already exist (to lean on in later passes)

- `WorkerCtx` is shaped like a DI container. Handlers already accept it. The missing step is moving the module-level Maps into ctx-owned state.
- `wantedSet.ts` + `descriptorBuffer.ts` + `proxyAtlas.ts` are already pure / GPU-free at the algorithm layer. Good test coverage.
- `workerProtocol.ts` is the single wire contract. Healthy.
- Prior pass refactored `Chunk` into a unified type (replacing parallel `SliceChunk`/`VolumeChunk` — note the inline comment at workerProtocol.ts:30).
- `UploadClient` already exists as the narrow facet. The worker-internal split hasn't happened yet, but the boundary at the postMessage seam is real and stable.

## Comparison to prior /dechaos passes

| | planning | fetch | upload | **render** |
|---|---|---|---|---|
| God file LOC | 1800 (planning.ts) | 1627 (cpuCache.ts) | 2027 (orchestrator.ts) | **815 (gpu.worker.ts)** |
| Direct tests on god file | 0 | 0 | 1024 LOC (orchestrator.test.ts) | **0** |
| Tests on sub-units | 0 → some | 0 → none | descriptorBuffer/wantedSet/proxyAtlas | **strong** (5 healthy test files, ~2100 LOC) |
| Existing slice directory | `planning/` (now 15 files) | `fetch/` (now 27 files) | `upload/` (now 12 files + subfolders) | **none yet** |
| Wire-protocol decoupling | n/a | n/a | done (`UploadClient`) | partial (worker still bundles many concerns) |
| Cross-cutting GPU dep | n/a | n/a | n/a | **central** — many concerns are "GPU-adjacent but pure" |

Render is structurally smaller than the prior three god files but has a different shape: the pure pieces are already extracted and well-tested; the **non-pure orchestration** (cold-state ingestion, member routing, dispatch) is the slop. The refactor surface is narrower but the test investment will be lower, because so much of the algorithmic core is already protected.
