---
created: 2026-04-18
modified: 2026-04-18
---

# All GPU Work on a Dedicated Web Worker

> **Note**: This decision article is derived from code analysis. The rationale is inferred. If you have authoritative context, run `/repo-wiki-update` to enrich it.

## Decision

All WebGPU calls happen inside `lucida-web/src/renderer/gpu.worker.ts`. The main thread never touches the WebGPU API. The render canvas is transferred via `OffscreenCanvas` once, on `init`. Communication happens via a typed `postMessage` protocol — see [[worker-protocol]].

## Why

Three concrete benefits:

1. **The main thread stays responsive during GPU work.** A heavy render frame on the main thread janks the React UI, scroll handling, and event dispatch. Off-loading to a worker lets the renderer take 16ms while the UI stays at 60fps.
2. **Decode workers can transfer typed arrays directly to the GPU worker.** The decode pool's worker → main → GPU worker flow becomes worker → GPU worker (zero copies). Transferable typed arrays are zero-copy across worker boundaries.
3. **WebGPU bind-group thrash is contained.** The worker holds the device, queue, atlases, and bind groups for the lifetime of the session — they don't get GC'd or recreated by component renders.

## Tradeoffs

- **Debugging is harder.** Browser DevTools attach to workers but the tooling is less polished than main-thread profiling. The `frameStats` worker → main message exists partly to surface telemetry the DevTools won't.
- **Every state change crosses a serialization boundary.** Cold state, hot state, chunk uploads — all `postMessage`. We mitigate with the cold/hot/delta split (see [[worker-protocol]]) and typed array transfers, but it's a real cost.
- **Lifecycle is annoying.** `OffscreenCanvas` can be transferred only once. A worker crash means losing the canvas and re-initing. There's no graceful recovery path; we rely on workers not crashing.

## Alternatives considered (inferred)

- **Render on the main thread.** Rejected — UI jank under sustained render pressure was the original motivation.
- **Render on the main thread but offload only decode to workers.** This is what an earlier version did. The bind-group lifecycle pain and the 60fps requirement under load tipped the balance toward fully isolating GPU.
- **Multiple GPU workers (one per dataset).** Rejected — bind groups, atlases, and the descriptor buffer are shared across datasets and would have to be re-uploaded per worker. Single GPU worker preserves the shared state.

## How this decision shows up in code

- `lucida-web/src/renderer/renderClient.ts` — main-side wrapper around `postMessage`. Owns the channel.
- `lucida-web/src/renderer/gpu.worker.ts` — worker entry point. Holds the WebGPU device, the canvas, the atlas state, the descriptor buffer.
- `lucida-web/src/renderer/workerContext.ts` — running state inside the worker.
- `lucida-web/src/hooks/useRenderClient.ts` — React hook that wires the worker to the canvas (transfer happens here on first mount).
- The `init`/`resize`/`coldState`/`viewHotState`/`sliceChunkData`/`volumeChunkData`/`proxyAsset` message types in `workerProtocol.ts`.

## Related

- [[worker-protocol]] — the message contract
- [[gpu-residency]] — what lives in the worker
- [[chunk-pipeline]] — where the drain-to-worker step happens
