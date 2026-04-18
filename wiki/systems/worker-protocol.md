---
created: 2026-04-18
modified: 2026-04-18
---

# Worker Protocol

`lucida-web/src/renderer/workerProtocol.ts` — the discriminated-union message contract between the main thread and the GPU worker. PRD #378 established the cold-state model; this article captures the *why* and the invariants downstream code relies on.

## Why a typed protocol over `postMessage`

`postMessage` accepts any structured-cloneable value, but if main and worker drift on the message shape they don't crash — they silently misbehave. The discriminated-union types in `workerProtocol.ts` give both sides one place to look and let the TypeScript compiler refuse to ship a mismatched send/handle pair.

## Two halves: state push and state pull

**Main → worker** (state push):

- `init { canvas: OffscreenCanvas }` — once, on worker start
- `resize { width, height }` — on canvas resize
- `coldState` — full `ColdStateMessage` payload: epochs, currentT, currentZ, visible channels, visible region, active set with per-entity LOD/mode/proxy/display-state, viewMode. **Rebuilt only when WASM epochs say something changed** — see [[scene-state-and-epochs]].
- `viewHotState` — view-only fast path; carries ray-pick coords used for GPU eviction distance. Sent only when `view` epoch bumps.
- `sliceChunkData { epochs, datasetId, chunks[], level, z, t, c, ... }` — typed array transfer of decoded chunks for the slice path.
- `volumeChunkData { epochs, datasetId, chunks[], level, t, c, ... }` — same for volume.
- `proxyAsset` — S5: a generated proxy asset (`[Z, Y, X]` u16 voxel buffer + identifying metadata).
- `requestEpoch` — bumps the request epoch so the worker re-evaluates.
- `setUploadBudget` — runtime tunable.

**Worker → main** (state pull):

- `wantedSetDelta` — what the worker wants but doesn't have (missing chunks + missing proxies). Drives the next `submit`.
- `chunksEvicted` — keys evicted (+ keys it skipped because they were never actually present). The main thread clears delivery tracking so the next drain re-uploads.
- `frameStats` — per-frame timing/budget telemetry surfaced in the [[lucida-web|debug panel]].
- `ready` — handshake after `init`/`resize`.

## Cold state, hot state, deltas

Three different update cadences, by design:

- **Cold state** is the worker's worldview — everything it needs to plan its own work without round-tripping. Rebuilt rarely (epoch-gated).
- **Hot state** is the per-frame view-only data (ray-pick coords for eviction distance). Rebuilt only when `view` epoch bumps.
- **Chunk and proxy data** are deltas — typed array transfers, one slice/volume/proxy at a time, carrying the planning epochs so the worker can ignore stale uploads.

## Interactions

- **`pipeline/orchestrator.ts`** is the only sender on the main side. It owns `client` (the `RenderClient` wrapper around `postMessage`) and decides when to send each message type.
- **`renderer/gpu.worker.ts`** is the only receiver. Each message type has a handler in `slice/volume/minimap` handlers under `renderer/`.
- **`renderer/workerContext.ts`** holds the worker's running state — atlases, indirection, descriptor buffer, residency.

## Invariants

- **Every chunk/proxy data message carries the planning epochs.** The worker compares against its current epochs and drops stale uploads. Don't strip the epochs as an "optimization" — the staleness check is what keeps the worker from thrashing on a flurry of in-flight uploads after a viewport change.
- **`coldState` is the full active-set worldview, not a delta.** Sending a partial cold state would let stale entries linger in the worker. The worker rebuilds atlases / descriptor buffer / wanted-set from each cold-state on receipt.
- **`OffscreenCanvas` is transferred once, on `init`.** It cannot be transferred back; closing the worker means losing the canvas. Re-init requires a new canvas.
- **`wantedSetDelta` is a delta, not a full set.** Adds and removes are both expressed.

## Gotchas

- **Don't bypass the protocol with raw `postMessage`** for one-off messages. Adding an untyped channel breaks the "one place to look" property and reintroduces silent drift.
- **Typed array transfers are zero-copy via the transfer list.** Forgetting to transfer means a costly clone — visible as upload-bandwidth pressure in the debug panel.
- **The worker's wanted-set is reactive to cold-state.** If you want to force a worker re-evaluation without changing cold state, use `requestEpoch`. Sending a redundant cold state works too but is wasteful.
- **`frameStats` cadence depends on the worker's render path.** Slice and volume don't emit on identical schedules; consumers (debug panel) treat the data as best-effort, not authoritative.
