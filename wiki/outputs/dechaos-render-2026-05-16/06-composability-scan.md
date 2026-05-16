# Pass 6: Composability Scan — render phase

Goal: identify logic trapped inside large workflows that could be extracted as reusable units.

## Extractable units, ranked by clarity payoff

### Unit 1 — Pool grouping (volume + slice) → `groupEntriesByPool(activeSet, channels, dimArity)`

**Currently trapped in:** `gpu.worker.ts:566–595` (volume) and `gpu.worker.ts:649–679` (slice). Near-identical code differing only in `chunkDimsKey` arity (3D vs 2D) and the `chunkDims` tuple shape.

**Extracted shape:**

```ts
interface PoolGroup<D extends [number, number] | [number, number, number]> {
  poolKey: string;
  channel: number;
  chunkDims: D;
  entries: Array<{ entry: ColdStateActiveEntry; memberId: string }>;
}

function groupEntriesByPool<D>(
  cold: ColdStateMessage,
  toChunkDims: (level: LevelInfo) => D,
  poolKeyFor: (dsId: string, channel: number, dims: D, isMulti: boolean) => string,
): Map<string, PoolGroup<D>>
```

**Composability win:** the cold-state handler shrinks from ~200 lines to ~30. Test in isolation.

### Unit 2 — Per-entity LOD section computation → `computeEntityMetas(entry, chunkDims) → LodIndirectionMeta[]`

**Currently trapped in:** `gpu.worker.ts:600-636` (volume) and `gpu.worker.ts:684-720` (slice). Iterates `[finest, coarsest]` LODs, filters by matching `chunkDims`, computes per-LOD offset into a flat indirection buffer. Fallback to "target LOD only" when no LODs match.

**Extracted shape:**

```ts
function computeEntityMetas(
  entry: ColdStateActiveEntry,
  poolChunkDims: [number, number, number],
  startOffset: number,
): { metas: LodIndirectionMeta[]; nextOffset: number }
```

**Composability win:** pure function. Tunable for "what counts as a matching LOD" (today: full chunk-dim match; could extend to "matches in X,Y; Z mismatch is OK" for slice).

### Unit 3 — Eviction distance + farthest-slot finder → `findFarthestSlot(atlas, lookup)`

**Currently trapped in:** `volumeHandlers.ts:266-300` (`findFarthestSlot` + `chunkDistSq` 3D), `sliceHandlers.ts:232-263` (`findFarthestSlot2D` + `chunkDistSq2D` 2D). Same algorithm; 2D form is just 3D with Z stripped.

**Extracted shape:**

```ts
function findFarthestSlot<T extends AtlasState>(
  atlas: T,
  cameraLookup: (memberId: string) => Vec3,    // [x, y, z] in [0,1]
  chunkPosition: (lodMeta, chunk) => Vec3,
): { key: string; dist: number }
```

**Composability win:** one eviction policy, parameterized by camera coordinate source. Slice supplies a constant Z; volume supplies the rayHit.

### Unit 4 — Indirection remap → `remapIndirection(slots, entityMetas, currentT, currentC, zFilter?)`

**Currently trapped in:** `volumeHandlers.remapIndirection` (no Z filter), `sliceHandlers.remapSliceIndirection` (with per-entity Z filter). The 2D form is "3D form with Z fixed to one chunk."

**Already exported as separate functions** and tested independently. The opportunity is to unify the implementation:

```ts
function remapIndirection(
  atlas: AtlasStateLike,
  filter: { t: number; c: number; z?: (memberId: string) => number | null },
): void
```

**Composability win:** smaller, one tested function instead of two.

### Unit 5 — Render-multipass loop → `forEachLayerDrawCall(layers, lookups) → DrawCall[]`

**Currently trapped in:** `volumeHandlers.handleVolumeRenderMultiPass` and `sliceHandlers.handleSliceRenderMultiPass`. Each iterates layers, resolves bindings, gates on hasDetail/wellProxyResident, configures renderer state, draws, composites.

**Extracted shape:**

```ts
interface ResolvedLayerDrawCall {
  entityIndex: number;
  atlas: AtlasState | null;
  hasDetail: boolean;
  proxyBindings: { field: GPUTexture | null; well: GPUTexture | null; wellSlotDims: [number,number,number] };
  colormapName: string;
  // ... everything the renderer needs to draw
}

function resolveLayerDrawCall(layer, lookups) → ResolvedLayerDrawCall | null
```

The render driver becomes "resolve → configure renderer → draw to offscreen → composite."

**Composability win:** the resolution step is testable; the draw step is the only GPU-touching part. Currently they're interleaved.

### Unit 6 — Chunk-key helpers → `renderer/chunkKeys.ts`

`parseChunkKey`, `makeCompositeKey`, `parseCompositeKey`, `derivePoolKey` are in `volumeHandlers.ts` and imported across files. These are wire-format helpers, not volume-specific.

**Composability win:** moving to a shared module is mechanical and eliminates a "volume handler is the de-facto wire library" smell.

### Unit 7 — Member-id construction → existing `memberIdForColdEntry`

Already exists in `descriptorBuffer.ts`. The composability problem is that **callers don't use it** (Contract Issue 5). The unit is fine; the extraction is enforcement.

### Unit 8 — Dummy texture / buffer factory → `renderer/worker/dummies.ts`

Today every renderer / handler / worker file has its own dummy textures (Dependency Problem 6). A `getDummy2D()`, `getDummy3D()`, `getDummyIndirection()` set on `WorkerCtx` would eliminate ~50 lines of duplicated lazy-init code across 5 files.

**Composability win:** one place to update if a dummy format needs to change.

### Unit 9 — Offscreen pool → already shared in `gpu.worker.ts:ensureOffscreenPool`, but minimap has its own

`minimapHandlers.ts:31-41` declares a parallel `ensureMinimapOffscreenPool`. Same shape as `ensureOffscreenPool` in `gpu.worker.ts`.

**Composability win:** unify via WorkerCtx. The minimap render path can use the worker's pool.

### Unit 10 — Proxy descriptor update + well-fanout → `renderer/proxy/propagate.ts`

`gpu.worker.ts:316-330` does:

```ts
if (msg.kind === "FieldProxy3D") {
  desc.fieldProxyHandle = handle;
} else {
  desc.wellProxyHandle = handle;
  for (const fid of wellToFields.get(msg.entityId) ?? []) {
    getOrCreateProxyDescriptor(fid).wellProxyHandle = handle;
  }
}
```

The well→fields fan-out is a self-contained pure operation over the proxy-descriptor registry.

**Composability win:** pure function, easy to test.

### Unit 11 — Descriptor-buffer rebuild trigger → `renderer/descriptor/invalidate.ts`

`handleProxyAssetData` rebuilds the descriptor buffer (lines 347-360) only when the proxy's dataset matches the current cold state. The trigger pattern (build new buffer + destroy old + update map) is repeated in the cold-state handler (lines 738-749).

**Composability win:** one `rebuildDescriptorBuffer(ctx, datasetId)` function called from both sites. Eliminates a small amount of duplication and centralizes the "when do we rebuild?" decision.

### Unit 12 — Stale-delivery skip + report → `renderer/staleSkip.ts`

Two near-identical blocks:

```ts
// volumeHandlers.ts:349-355
if (isStaleDelivery(msg.epochs, currentEpochs)) {
  const skippedKeys = msg.chunks.map(c => c.key);
  if (skippedKeys.length > 0) {
    ctx.post({ type: "chunksEvicted", datasetId: memberId, keys: [], skipped: skippedKeys });
  }
  return;
}
```

Slice handler has the same shape. Proxy handler has a similar (but simpler) shape — just increments `proxyStats.dropped`.

**Composability win:** `staleSkipAndReport(ctx, msg, currentEpochs, memberId)` → boolean.

### Unit 13 — Atlas creation sizing → `renderer/atlasSizing.ts`

`createVolumeAtlas` and `createSliceAtlas` both compute slot grid from `BUDGET / (chunkVoxels × 2)` with a hardcoded device-limit clamp. Different limit values (`8192` vs `2048`), neither queries the device.

**Composability win:** `computeAtlasGeometry(device, format, chunkDims, budget)` → `{slotsX, slotsY, slotsZ, totalSlots}`. Single source for max-dim queries and budget math.

### Unit 14 — Bind-group builders inside renderers

`SliceRenderer.rebuildBindGroup` and `VolumeRenderer.setAtlas` both build a bind group with: uniform buffer, atlas texture, indirection, LUT, sampler, fieldProxy, wellProxy. Layout-equivalent.

**Composability win:** small. Renderers are class-internal already.

## Things NOT worth extracting

### Anti-pattern 1 — Generic "AtlasUploadStrategy" interface

The slice/volume upload functions look similar but have enough mode-specific bits (Z-slice retargeting, `staleSliceKeys` for slice; 3D writeTexture vs writeSliceRegion) that a strategy interface would add ceremony without payoff.

### Anti-pattern 2 — Generic "RenderHandler" interface

Same concern. Volume vs slice rendering have different uniform layouts, depth handling, blend modes, and composite paths. The orchestration shape is similar, but the differences are real.

### Anti-pattern 3 — Generic "GPUResource" lifecycle interface

`destroy()` is already polymorphic by texture/buffer kind. Wrapping in an interface adds nothing.

### Anti-pattern 4 — Unified shader for slice + volume

`slice.wgsl` and `volume.wgsl` share the descriptor struct + fallback chain shape but differ fundamentally in dimensionality (2D vs 3D sampling, ray-march vs flat fragment). Single shader with `#ifdef`s would be worse than two files.

## Summary

The biggest composability win is **collapsing the four duplicated-by-arity primitives** (Unit 1 pool grouping, Unit 2 entity metas, Unit 3 eviction, Unit 4 remap) into shared functions parameterized by 2D/3D. Each is ~50 lines today, ~30 lines collapsed, with the shared form testable independently.

The mechanical wins (Unit 6 chunkKeys, Unit 8 dummies, Unit 9 offscreen pool, Unit 10 propagate, Unit 12 staleSkip) are low-risk one-day refactors with no behavior change.

The structural wins (Unit 5 ResolvedLayerDrawCall, Unit 11 rebuildDescriptorBuffer trigger) restructure how the worker thinks about its job — bigger payoff, more risk.

Extracting these in order — mechanical first, then collapsed primitives, then structural — would shrink `gpu.worker.ts` + `volumeHandlers.ts` + `sliceHandlers.ts` by ~40% combined while keeping the actual GPU code untouched.
