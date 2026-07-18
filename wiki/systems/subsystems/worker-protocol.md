---
type: Subsystem
title: "Worker Protocol"
description: "lucida-web/src/renderer/workerProtocol.ts — the discriminated-union message contract between the main thread and the GPU worker."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/worker-protocol.md
created: 2026-04-18
modified: 2026-07-16
---

# Worker Protocol

`lucida-web/src/renderer/workerProtocol.ts` — the discriminated-union message contract between the main thread and the GPU worker. This article captures the *why* of the cold-state model and the invariants downstream code relies on.

## Why a typed protocol over `postMessage`

`postMessage` accepts any structured-cloneable value, but if main and worker drift on the message shape they don't crash — they silently misbehave. The discriminated-union types in `workerProtocol.ts` give both sides one place to look and let the TypeScript compiler refuse to ship a mismatched send/handle pair.

## Two halves: state push and state pull

**Main → worker** (state push):

- `init { canvas: OffscreenCanvas }` — once, on worker start
- `resize { width, height }` — on canvas resize
- `coldState` — full `ColdStateMessage` payload: epochs, currentT, currentZ, visible channels, visible region, active set with per-entity detail/coarse levels, level metadata, display-state, transforms, and viewMode. **Rebuilt only when WASM epochs say something changed** — see [Scene State and Epochs](scene-state-and-epochs.md).
- `viewHotState` — view-only fast path; carries ray-pick coords used for GPU eviction distance. Sent only when `view` epoch bumps.
- `sliceChunkData { epochs, memberId, tier, chunks[], level, z, t, c, ... }` — typed array transfer of decoded chunks for the slice path. The owner key is **memberId** and the residency route is **tier** (`detail` or `coarse`).
- `volumeChunkData { epochs, memberId, tier, chunks[], level, t, c, ... }` — same for volume.
- **render + minimap messages** (also Main → worker): `resize`, `volumeRenderMultiPass`, `sliceRenderMultiPass`, `minimapInit` / `minimapRender` / `minimapDestroy` / `minimapUploadOverviewChunksForLayer`, `removeLayerResources`, `updateCursorData`, `destroy`. These drive draws and minimap residency, distinct from the cold/hot/chunk state push above.
- A `sliceRenderMultiPass` layer is either a normal per-member layer (one offscreen pass each) or an **aggregate layer** (`SliceAggregateParams`): members whose on-screen diagonal falls below the member-pass budget in `slicePath.ts` are batched into one layer whose quad records (rect in layer UV + entity descriptor index, 32 B each, transferred) render in a single instanced pass via the slice shader's `vsAggregate`/`fsAggregate` entry points. This keeps per-frame pass count bounded by screen size, not member count, on wide collections. Labels never batch.

The full `MainToWorker` union is in `MainToWorkerMessage` (workerProtocol.ts).

**Worker → main** (state pull). The complete `WorkerToMainMessage` union is
seven variants: `ready`, `error`, `framePresented`, `intensityRange`,
`thumbnailResult`, `chunksEvicted`, and `wantedSetDelta`. Treat the union in
`workerProtocol.ts` as the source of truth; this list is descriptive and must
move with it.

- `wantedSetDelta` — the tier-labeled chunks the worker wants but does not have. Drives the next `submit`.
- `chunksEvicted { memberId, keys, skipped? }` — keys evicted (+ keys it skipped because they were never actually present). The main thread clears delivery tracking so the next drain re-uploads.
- `intensityRange { datasetId, min, max }` — running min/max from `sampleIntensityRange` after a chunk upload, batched on the main side via `useIntensityBatcher`.
- `framePresented { frameId }` — GPU-complete presentation acknowledgement;
  capture readiness and frame telemetry consume this instead of equating a
  browser animation callback with completed GPU work. `RenderClient` also
  starts a presentation obligation when dirty view/residency work is scheduled,
  before the browser's animation callback. A successfully posted main-view
  render adopts the same obligation. If the oldest outstanding frame remains
  unacknowledged for 10 seconds while the page is visible, it raises a typed
  `frame_starvation` terminal failure through the normal UI recovery path
  (`Restart renderer`). New submissions cannot postpone that deadline;
  hidden-tab time is excluded, intentional loop stops/collapsed canvases cancel
  work that was never submitted, and direct non-empty renders also arm the
  watchdog.
- `thumbnailResult { id, bitmap }` — correlated minimap/collection-thumbnail
  response. The bitmap is transferred, and `null` means no resident overview
  could be drawn yet.
- `ready` / `error` — handshake / failure after `init`/`resize`.

## Cold state, hot state, deltas

Three different update cadences, by design:

- **Cold state** is the worker's worldview — everything it needs to plan its own work without round-tripping. Rebuilt rarely (epoch-gated).
- **Hot state** is the per-frame view-only data (ray-pick coords for eviction distance). Rebuilt only when `view` epoch bumps.
- **Chunk data** are deltas — typed array transfers, one slice/volume upload at a time, carrying tier labels and planning epochs so the worker can ignore stale uploads.

## Stale-rejection asymmetry

Render messages carry epochs but are **stale-tolerant**: the worker draws with current residency and a later render repairs it. Chunk data are stale-rejected, so wrong-epoch voxels never enter an atlas.

## `ColdStateActiveEntry`

Each active entry is image-backed and carries its real `imageId`, explicit
detail/coarse levels and geometry, transforms, and per-channel display state.
There is no synthesized group-proxy entry or proxy availability branch.

The canonical way to derive a memberId from an entry is `memberIdForColdEntry(entry, channel, multiCh)` in `renderer/descriptorBuffer.ts`. The canonical way to route a tier to a pool is `memberTierKey(memberId, tier)` from `renderer/poolKeys.ts`.

## Interactions

- **Main side**: the [Uploader](upload-pipeline.md) is the only sender. It owns cold/hot state, tier-labeled chunk delivery, and worker feedback callbacks.
- **Worker side**: `renderer/gpu.worker.ts` delegates to `worker/dispatch.ts`, which routes messages to `coldState/`, `volume/`, `slice/`, or `worker/` handlers.
- **`renderer/workerContext.ts`** holds the worker's running state; per-session Maps live on `WorkerCtx.state: RendererState`. Renderer-class singletons and persistent GPU resources stay at module scope in `worker/resources.ts`.

## Invariants

- **Every chunk data message carries planning epochs and is stale-rejected.** Do not strip them: they keep wrong-epoch voxels out after viewport changes.
- **Every default chunk upload carries a tier.** Missing or omitted tier is treated as legacy detail compatibility; new code must send `detail` or `coarse` explicitly.
- **`coldState` is the full active-set worldview, not a delta.** Sending a partial cold state would let stale entries linger in the worker. The worker rebuilds atlases / descriptor buffer / wanted-set from each cold-state on receipt.
- **`OffscreenCanvas` is transferred once, on `init`.** It cannot be transferred back; closing the worker means losing the canvas. Re-init requires a new canvas.
- **`wantedSetDelta` is a delta, not a full set.** Adds and removes are both expressed.
- **`memberId` is the owner key on every member-routed message** (`chunksEvicted`, `volumeChunkData`, `sliceChunkData`). Dataset-wide state and intensity feedback remain `datasetId`-keyed.
- **A non-empty main-view render must eventually produce `framePresented`.**
  Presentation liveness is measured from the oldest outstanding frame, not the
  newest request, so a busy producer cannot conceal a stalled GPU worker.

## Gotchas

- **Don't bypass the protocol with raw `postMessage`** for one-off messages. Adding an untyped channel breaks the "one place to look" property and reintroduces silent drift.
- **Typed array transfers are zero-copy via the transfer list.** Forgetting to transfer means a costly clone — visible as upload-bandwidth pressure in the debug panel.
- **The worker's wanted-set is reactive to cold-state.** To force a worker re-evaluation, send a fresh cold state — there is no separate request-epoch message.
- **Route by tier, not by the old detail fallback map.** Coarse uploads must look up `memberTierKey(memberId, "coarse")`; otherwise mismatched coarse/detail chunk shapes are silently sent to the wrong atlas.
