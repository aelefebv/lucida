---
created: 2026-04-18
modified: 2026-05-16
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
- `sliceChunkData { epochs, memberId, chunks[], level, z, t, c, ... }` — typed array transfer of decoded chunks for the slice path. The owner key is **memberId** (renamed from `datasetId` in PRD #622 Slice 1 — the field carried a memberId all along).
- `volumeChunkData { epochs, memberId, chunks[], level, t, c, ... }` — same for volume.
- `proxyAsset` — S5: a generated proxy asset (`[Z, Y, X]` u16 voxel buffer + identifying metadata). Stays `datasetId`-keyed (proxies are routed per dataset, not per member).
- `requestEpoch` — bumps the request epoch so the worker re-evaluates.
- `setUploadBudget` — runtime tunable.

**Worker → main** (state pull):

- `wantedSetDelta` — what the worker wants but doesn't have. Discriminated union over `MissingChunk` (chunks the worker's atlas lacks) and `MissingProxy` (proxies its proxy atlas lacks). Drives the next `submit`. Established by PRD #607; unchanged by PRD #622.
- `chunksEvicted { memberId, keys, skipped? }` — keys evicted (+ keys it skipped because they were never actually present). The main thread clears delivery tracking so the next drain re-uploads. The `memberId` field was `datasetId` pre-Slice-1.
- `intensityRange { datasetId, min, max }` — running min/max from `sampleIntensityRange` after a chunk upload, batched on the main side via `useIntensityBatcher`.
- `frameStats` — per-frame timing/budget telemetry surfaced in the [[lucida-web|debug panel]].
- `ready` — handshake after `init`/`resize`.

## Cold state, hot state, deltas

Three different update cadences, by design:

- **Cold state** is the worker's worldview — everything it needs to plan its own work without round-tripping. Rebuilt rarely (epoch-gated).
- **Hot state** is the per-frame view-only data (ray-pick coords for eviction distance). Rebuilt only when `view` epoch bumps.
- **Chunk and proxy data** are deltas — typed array transfers, one slice/volume/proxy at a time, carrying the planning epochs so the worker can ignore stale uploads.

## `ColdStateActiveEntry` as a discriminated union

Per-entity records in `ColdStateMessage.activeSet` are a `kind: "field" | "well-as-proxy"` discriminated union (Slice 11 of PRD #622):

- **`kind: "field"`** — image member with a real `imageId: string` and `parentWellId: string | null`; `mode: "fields-with-detail" | "fields-with-proxy-fallback"`.
- **`kind: "well-as-proxy"`** — synthesised well-level entry with no backing image; `imageId?: never`. The worker renders the well's proxy directly and uses `entityId` as the routing key.

Both variants share a `ColdStateActiveEntryBase` (entityId, targetLod, detailOwnedLodRange, levels, proxy fields, modelMatrix, invModelMatrix, displayStateByChannel). The wire bytes are unchanged from the pre-Slice-11 shape — the producer always emitted `mode`; the consumer now also receives `kind`, which lets TypeScript narrow the variant without sniffing `imageId === ""`. This mirrors [[decisions/0026-discriminated-active-set-and-entity-types]] on the planning side; see [[decisions/0035-gpu-worker-split-into-renderer-subdirectories]] for the slice-level rationale. The legacy `mode` field is retained for backward compat (logging, debug, existing inspection paths); future work can drop it once every consumer routes through `kind`.

The canonical way to derive a memberId from an entry is `memberIdForColdEntry(entry, channel, multiCh)` in `renderer/descriptorBuffer.ts`. Inline `${entry.imageId}:ch${channel}` is wrong for `kind: "well-as-proxy"` (where `imageId` is absent) — the discriminated union makes the type checker refuse the inline form.

## Interactions

- **Main side**: the [[upload-pipeline|Uploader]] (post-PRD #607) is the only sender, via `client` (a thin `UploadClient` facet of `RenderClient`). It owns `coldState`, `viewHotState`, `sliceChunkData`, `volumeChunkData`, `proxyAsset` emission and the worker → main feedback callbacks.
- **Worker side**: the entry point `renderer/gpu.worker.ts` (~34 LOC post-PRD #622) delegates to `worker/dispatch.ts`, which routes each typed message to its handler under `coldState/`, `proxy/`, `volume/`, `slice/`, `worker/`. See [[gpu-residency]] for the module layout.
- **`renderer/workerContext.ts`** still holds the worker's running state, but per-session Maps now live on `WorkerCtx.state: RendererState` (Slice 8 of PRD #622). Renderer-class singletons and persistent GPU resources stay at module scope in `worker/resources.ts`.

## Invariants

- **Every chunk/proxy data message carries the planning epochs.** The worker compares against its current epochs and drops stale uploads. Don't strip the epochs as an "optimization" — the staleness check is what keeps the worker from thrashing on a flurry of in-flight uploads after a viewport change.
- **`coldState` is the full active-set worldview, not a delta.** Sending a partial cold state would let stale entries linger in the worker. The worker rebuilds atlases / descriptor buffer / wanted-set from each cold-state on receipt.
- **`OffscreenCanvas` is transferred once, on `init`.** It cannot be transferred back; closing the worker means losing the canvas. Re-init requires a new canvas.
- **`wantedSetDelta` is a delta, not a full set.** Adds and removes are both expressed.
- **`memberId` is the owner key on every member-routed message** (`chunksEvicted`, `volumeChunkData`, `sliceChunkData`). The remaining `datasetId` fields (on `coldState`, `viewHotState`, `proxyAsset`, `intensityRange`, `MissingProxy`) are correctly per-dataset.

## Gotchas

- **Don't bypass the protocol with raw `postMessage`** for one-off messages. Adding an untyped channel breaks the "one place to look" property and reintroduces silent drift.
- **Typed array transfers are zero-copy via the transfer list.** Forgetting to transfer means a costly clone — visible as upload-bandwidth pressure in the debug panel.
- **The worker's wanted-set is reactive to cold-state.** If you want to force a worker re-evaluation without changing cold state, use `requestEpoch`. Sending a redundant cold state works too but is wasteful.
- **`frameStats` cadence depends on the worker's render path.** Slice and volume don't emit on identical schedules; consumers (debug panel) treat the data as best-effort, not authoritative.
- **Discriminate via `entry.kind`, not `imageId === ""`.** Code from before Slice 11 may still sentinel-sniff; replace with `if (entry.kind === "well-as-proxy") { … }` to get the type narrowing.
