---
created: 2026-04-18
modified: 2026-05-19
---

# Worker Protocol

`lucida-web/src/renderer/workerProtocol.ts` — the discriminated-union message contract between the main thread and the GPU worker. This article captures the *why* of the cold-state model and the invariants downstream code relies on.

## Why a typed protocol over `postMessage`

`postMessage` accepts any structured-cloneable value, but if main and worker drift on the message shape they don't crash — they silently misbehave. The discriminated-union types in `workerProtocol.ts` give both sides one place to look and let the TypeScript compiler refuse to ship a mismatched send/handle pair.

## Two halves: state push and state pull

**Main → worker** (state push):

- `init { canvas: OffscreenCanvas }` — once, on worker start
- `resize { width, height }` — on canvas resize
- `coldState` — full `ColdStateMessage` payload: epochs, currentT, currentZ, visible channels, visible region, active set with per-entity detail/coarse levels, level metadata, display-state, transforms, and viewMode. **Rebuilt only when WASM epochs say something changed** — see [[scene-state-and-epochs]].
- `viewHotState` — view-only fast path; carries ray-pick coords used for GPU eviction distance. Sent only when `view` epoch bumps.
- `sliceChunkData { epochs, memberId, tier, chunks[], level, z, t, c, ... }` — typed array transfer of decoded chunks for the slice path. The owner key is **memberId** and the residency route is **tier** (`detail` or `coarse`).
- `volumeChunkData { epochs, memberId, tier, chunks[], level, t, c, ... }` — same for volume.
- `proxyAsset` — legacy bridge-only proxy asset (`[Z, Y, X]` u16 voxel buffer + identifying metadata). Stays `datasetId`-keyed because proxies are routed per dataset, not per member.
- `requestEpoch` — bumps the request epoch so the worker re-evaluates.
- `setUploadBudget` — runtime tunable.

**Worker → main** (state pull):

- `wantedSetDelta` — what the worker wants but doesn't have. `MissingChunk` carries the missing chunk and tier; `MissingProxy` is legacy bridge-only. Drives the next `submit`.
- `chunksEvicted { memberId, keys, skipped? }` — keys evicted (+ keys it skipped because they were never actually present). The main thread clears delivery tracking so the next drain re-uploads.
- `intensityRange { datasetId, min, max }` — running min/max from `sampleIntensityRange` after a chunk upload, batched on the main side via `useIntensityBatcher`.
- `frameStats` — per-frame timing/budget telemetry surfaced in the [[lucida-web|debug panel]].
- `ready` — handshake after `init`/`resize`.

## Cold state, hot state, deltas

Three different update cadences, by design:

- **Cold state** is the worker's worldview — everything it needs to plan its own work without round-tripping. Rebuilt rarely (epoch-gated).
- **Hot state** is the per-frame view-only data (ray-pick coords for eviction distance). Rebuilt only when `view` epoch bumps.
- **Chunk data** are deltas — typed array transfers, one slice/volume upload at a time, carrying tier labels and planning epochs so the worker can ignore stale uploads. Proxy data follow the same pattern only in legacy bridge mode.

## `ColdStateActiveEntry`

Per-entity records in `ColdStateMessage.activeSet` are field/image entries in the default path. Each carries:

- `imageId`, `entityId`, `parentWellId`
- `detailLevel` and optional `coarseLevel`
- `wantedLodLevels` and per-level geometry metadata
- `modelMatrix` / `invModelMatrix`
- `displayStateByChannel`

Legacy `kind: "well-as-proxy"` entries are still understood by the bridge code but should not be produced by the default planner. The clean path keeps wells as layout/grouping concepts and renders field/image chunks through explicit tier sources.

The canonical way to derive a memberId from an entry is `memberIdForColdEntry(entry, channel, multiCh)` in `renderer/descriptorBuffer.ts`. The canonical way to route a tier to a pool is `memberTierKey(memberId, tier)` from `renderer/poolKeys.ts`.

## Interactions

- **Main side**: the [[upload-pipeline|Uploader]] is the only sender, via `client` (a thin `UploadClient` facet of `RenderClient`). It owns `coldState`, `viewHotState`, tier-labeled `sliceChunkData` / `volumeChunkData`, legacy `proxyAsset` emission, and the worker → main feedback callbacks.
- **Worker side**: the ~34-LOC entry point `renderer/gpu.worker.ts` delegates to `worker/dispatch.ts`, which routes each typed message to its handler under `coldState/`, `proxy/`, `volume/`, `slice/`, `worker/`. See [[gpu-residency]] for the module layout.
- **`renderer/workerContext.ts`** holds the worker's running state; per-session Maps live on `WorkerCtx.state: RendererState`. Renderer-class singletons and persistent GPU resources stay at module scope in `worker/resources.ts`.

## Invariants

- **Every chunk/proxy data message carries the planning epochs.** The worker compares against its current epochs and drops stale uploads. Don't strip the epochs as an "optimization" — the staleness check is what keeps the worker from thrashing on a flurry of in-flight uploads after a viewport change.
- **Every default chunk upload carries a tier.** Missing or omitted tier is treated as legacy detail compatibility; new code must send `detail` or `coarse` explicitly.
- **`coldState` is the full active-set worldview, not a delta.** Sending a partial cold state would let stale entries linger in the worker. The worker rebuilds atlases / descriptor buffer / wanted-set from each cold-state on receipt.
- **`OffscreenCanvas` is transferred once, on `init`.** It cannot be transferred back; closing the worker means losing the canvas. Re-init requires a new canvas.
- **`wantedSetDelta` is a delta, not a full set.** Adds and removes are both expressed.
- **`memberId` is the owner key on every member-routed message** (`chunksEvicted`, `volumeChunkData`, `sliceChunkData`). The remaining `datasetId` fields (on `coldState`, `viewHotState`, legacy `proxyAsset`, `intensityRange`, `MissingProxy`) are correctly per-dataset.

## Gotchas

- **Don't bypass the protocol with raw `postMessage`** for one-off messages. Adding an untyped channel breaks the "one place to look" property and reintroduces silent drift.
- **Typed array transfers are zero-copy via the transfer list.** Forgetting to transfer means a costly clone — visible as upload-bandwidth pressure in the debug panel.
- **The worker's wanted-set is reactive to cold-state.** If you want to force a worker re-evaluation without changing cold state, use `requestEpoch`. Sending a redundant cold state works too but is wasteful.
- **`frameStats` cadence depends on the worker's render path.** Slice and volume don't emit on identical schedules; consumers (debug panel) treat the data as best-effort, not authoritative.
- **Route by tier, not by the old detail fallback map.** Coarse uploads must look up `memberTierKey(memberId, "coarse")`; otherwise mismatched coarse/detail chunk shapes are silently sent to the wrong atlas.
