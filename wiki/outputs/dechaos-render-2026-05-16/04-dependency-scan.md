# Pass 4: Dependency Scan — render phase

Goal: find code that's hard to change because it depends on too much, or where dependencies are implicit.

## Problem types, ranked

### Problem 1 — Module-level mutable state (4 files, 14 Maps)

**Sites:**

- `gpu.worker.ts`: `memberToDataset`, `memberToPool`, `currentEntityMetasByDataset`, `proxyPoolsByDataset`, `proxyDescriptorsByEntity`, `wellToFields`, `descriptorBuffersByDataset`, plus `currentEpochs`, `currentColdState`, `proxyStats`, `lutCache`, `offscreenPool`, `dummyTexture`, `dummy3DTexture`.
- `volumeHandlers.ts`: `atlasPerDataset`, `rayHitPerEntity`, `depthTexture`, `dummyIndirectionBuf`.
- `sliceHandlers.ts`: `atlasPerDataset` (separate Map!), `cameraUVPerEntity`, `dummySliceIndirectionBuf`.
- `minimapHandlers.ts`: `minimapOverviewPerDataset`, `minimapContext`, `minimapOffscreenPool`, `minimapPoolWidth`, `minimapPoolHeight`.

**Impact:** the handler functions read these globals **after** being called with `WorkerCtx`. Their signatures hide the dependency. Tests must do module-cache resets (`vi.resetModules`) between cases or accept leakage.

**Suggested change:** treat `WorkerCtx` as the actual DI seam. Move each module-level Map/singleton into a state object that `WorkerCtx` exposes. Handlers receive their state explicitly.

**Design principle:** make dependencies explicit; state ownership should be visible from the function signature.

### Problem 2 — Implicit message-ordering invariants with silent failure modes

**Sites:**

| Invariant | Where violated → what happens |
|---|---|
| `memberToPool` set before `volumeChunkData` / `sliceChunkData` arrives | `if (!poolKey) break;` — silent drop, no log, no metric |
| `descriptorBuffersByDataset[dsId]` exists before `volumeRenderMultiPass` / `sliceRenderMultiPass` | `if (!descIndex) continue;` — silent skip |
| `proxyPoolsByDataset[dsId][poolKey]` exists before render | resolved via descriptor's `proxyPoolsByIndex` array — silent fallback to no proxy if absent |
| `viewHotState` arrives before next render for accurate ray-pick eviction | works but with stale `[0.5, 0.5, 0.5]` default — eviction picks wrong "farthest" chunk |
| Cold-state arrives before any chunk for that dataset | otherwise `entityMetas.get(memberId)` returns undefined → handler warns + returns |
| `init` completes before any other message | `if (!device) return;` in `handleProxyAssetData`; other handlers will throw on undefined |

**Impact:** out-of-order messages drop silently in the worker. Hard to diagnose. The orchestrator side **must** uphold these orderings; nothing enforces them.

**Suggested change:** at minimum, log when these silent drops happen with a debug counter. Better: a small `ReadyGuard` that buffers chunk/render messages until cold state arrives for the dataset.

**Design principle:** failures should be local and visible.

### Problem 3 — Hidden configuration constants

| Constant | Defined at | Could be DI |
|---|---|---|
| `PROXY_POOL_CAPACITY = 64` | `gpu.worker.ts:98` | Yes (per dataset/kind/dims) |
| `VOLUME_ATLAS_BUDGET = 512 MB` | `workerProtocol.ts:7` | Yes (env-derived) |
| `SLICE_ATLAS_BUDGET = 64 MB` | `workerProtocol.ts:10` | Yes (env-derived) |
| `DESCRIPTOR_MAX_LODS = 8` | `descriptorBuffer.ts:33` | No (shader-coupled) |
| `OFFSCREEN_FORMAT = "rgba16float"` | `gpuContext.ts:3` | No (shader-coupled) |
| `MAX_CURSORS = 16` | `cursorRenderer.ts:9` | Reasonable to keep |
| `2048` (max texture dim heuristic) | `volumeHandlers.ts:192–194`, `sliceHandlers.ts:134–135` | Should query device limits like `proxyAtlas.ts` does |
| `8192` (slice atlas max axis) | `sliceHandlers.ts:134–135` | Same |
| `BG = {r:0.05, g:0.05, b:0.08, a:1}` | `layerCompositor.ts:11` | Theme-relevant; could move to a config |
| `border_width = 1.5` (slice border) | `slice.wgsl:123` | Hardcoded; reasonable |

**Impact:** budgets baked in. Atlas pool sizing assumes generous device limits without checking. Slice and volume use **different** texture-limit assumptions (`8192` vs `2048`) hardcoded inline; only `proxyAtlas.ts` queries `device.limits.maxTextureDimension3D`.

**Suggested change:** centralize hardware queries in `gpuContext.ts` (`getDeviceLimits(device)`), use them across all atlas builders. Centralize budgets in `workerProtocol.ts` (already partial) or a `renderer/config.ts`.

### Problem 4 — `WorkerCtx` is partial DI; handlers reach back to module globals anyway

`WorkerCtx` (workerContext.ts) exposes `device`, lazy renderer accessors, lookup helpers (`lookupProxyDescriptor`, `lookupProxyPool`, `lookupEntityDescriptor`). Handlers accept it. But:

- `volumeHandlers.handleVolumeRenderMultiPass` accesses `atlasPerDataset` (module-local), `cameraUVPerEntity` (module-local), `rayHitPerEntity` (module-local), AND `ctx`.
- `gpu.worker.ts` exposes `memberToPool` via a closure passed to `handle*RenderMultiPass`, but accesses other registries (`memberToDataset`, `wellToFields`, `proxyPoolsByDataset`, `proxyDescriptorsByEntity`) inline.

**Impact:** moving a handler to a new file would require either replicating its module-local state there or making it ctx-aware. DI is half-implemented.

**Suggested change:** the `WorkerCtx.lookupProxyDescriptor` / `lookupProxyPool` pattern is the right one. Extend it: every Map currently at module-level should become a ctx accessor.

### Problem 5 — Devtools/HITL global pollution

`(self as unknown as { ... }).__lucidaProxyStats = proxyStats;` (gpu.worker.ts:106–111) — three different debug singletons attached to `self`. Useful for HITL but they couple the worker to a debug surface that doesn't appear in the type system.

**Impact:** moving state around requires updating the debug exports. Not a correctness risk; a maintenance one.

**Suggested change:** `worker/devtools.ts` with a single `installDevtools(state)` call that wires everything once.

### Problem 6 — Hard-coded GPU resource construction inside business code

| Site | Hard-coded resource |
|---|---|
| `gpu.worker.ts:120-127` | `getOrCreateLUT` builds rgba8unorm 256×1 textures |
| `gpu.worker.ts:153-160` | `getDummyTexture` builds r16uint 1×1 |
| `gpu.worker.ts:165-174` | `getDummy3DTexture` builds r16uint 1×1×1 3D |
| `sliceHandlers.ts:53-62` | `getDummySliceIndirection` builds a 4-byte storage buffer |
| `sliceHandlers.ts:140` | `createSliceAtlas` calls `createSliceTexture` — but format/usage are baked |
| `sliceRenderer.ts:126-150` | `dummyTexture`, `dummyIndirectionBuffer`, default LUT all created inline in constructor |
| `volumeRenderer.ts:152-163` | Default LUT created inline in constructor |
| `volumeRenderer.ts:181-189` | `getDummyProxyTexture` builds r16uint 1×1×1 3D |

**Impact:** every renderer / handler / worker file has its own private dummies and pads. Five separate "1×1 dummy" textures across the codebase.

**Suggested change:** `renderer/worker/resources.ts` owns all dummies + LUT cache + offscreen pool. Pass through `WorkerCtx`. Renderers receive their dummies from outside rather than building their own.

### Problem 7 — `RenderClient` is implicitly the only `Worker` factory

`RenderClient` is constructed once per main-thread session (in `useRenderClient.ts`). The class instantiates the worker via `new Worker(new URL("./gpu.worker.ts", ...))`. This is mostly fine — but **tests can't construct a `RenderClient` without a real Worker**. The `UploadClient` interface mitigates this on the upload side, but for the render side (`sliceRenderMultiPass`, `volumeRenderMultiPass`, etc.) the only injection point is the entire `RenderClient`.

**Impact:** integration tests of render-related dispatch must use a fake `UploadClient` and stop short of the worker boundary. The render-multipass methods aren't currently wrapped in an interface like upload's.

**Suggested change:** if testability of slice/volumePath wiring matters, add a `RenderDispatcher` interface that the path modules call into. Today this is **acceptable** because the path modules are thin.

### Problem 8 — Implicit cross-file state coupling around `currentEpochs`

`currentEpochs` is set in the `coldState` case (gpu.worker.ts:508), read by:

- `isStaleDelivery` in every chunk/proxy handler (via the `currentEpochs` parameter passed by the dispatch case — clean).
- `handleProxyAssetData` reads `currentEpochs` directly from the module global (not via parameter — **inconsistent with chunk handlers**).
- `postWantedSet` reads it as a guard.

**Impact:** the dispatch shape is "for chunk handlers, pass `currentEpochs`; for proxy handler, read the global." Asymmetric.

**Suggested change:** consistent — always pass via parameter, or always read from a shared state object.

### Problem 9 — Renderer classes mutate shared device state across draws

`SliceRenderer.setColormapTexture(tex)` rebuilds the bind group. So does `setAtlas(...)`. So does `setProxyTextures(...)`. If a layer changes only the colormap, the bind group is rebuilt with stale atlas + proxy bindings from the previous layer (which works only because those textures are still bound).

This is correct today (every layer calls all setters), but the **carry-over contract is implicit**. A reader can't tell whether `setColormapTexture` alone is a valid call.

**Impact:** future bugs when someone calls a subset of setters.

**Suggested change:** either document the "all setters required per draw" contract on each setter, or move to a single `renderTo(drawParams)` that takes a value object.

### Problem 10 — Lookup helpers are slow path but called per-frame

`WorkerCtx.lookupProxyDescriptor`, `lookupProxyPool`, `lookupEntityDescriptor` each do a `Map.get` per layer per frame. That's fine. But they're declared inline in the worker's `init` case (gpu.worker.ts:404–414) as closures over module globals.

**Impact:** moving state out of the worker file requires changing the WorkerCtx assembly inline in `init`. The closures encode the module global locations.

**Suggested change:** assemble `WorkerCtx` from explicit pieces (`registries`, `pools`, `descriptors`) rather than closures over file-local globals.

## Things that are already good

- `wantedSet.computeWantedSet` is signature-pure: every dependency is an argument. Trivial to test.
- `proxyAtlas` functions take an explicit `atlas` argument. Pure.
- `descriptorBuffer.serializeEntityDescriptor` is signature-pure (writes into an `ArrayBuffer`). Tested.
- `epochCheck.isStaleDelivery` is two-parameter pure.
- `dataTypeUtil` is pure.

## Summary

The render code has a **partial DI pattern (`WorkerCtx`)** that the pure modules respect but the handler files bypass via module-level globals. The biggest dependency-clarity win is finishing what `WorkerCtx` started: every Map currently at module level becomes a ctx accessor.

The implicit-ordering failures (Problem 2) are the highest-risk: they fail silently. A `ReadyGuard` + debug counters around the silent drops would be a quick, low-risk improvement that surfaces bugs without changing structure.

Hard-coded GPU limits (Problem 3) and per-file dummies (Problem 6) are cleanup-quality issues — easy to do, no behavior change.
