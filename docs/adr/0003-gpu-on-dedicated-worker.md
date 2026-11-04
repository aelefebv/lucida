# All GPU Work on a Dedicated Web Worker

Status: Accepted.

## Context

Rendering large volumes keeps the GPU busy every frame. On the main thread that work competes with React, scrolling, and input dispatch, and the UI janks under sustained load. WebGPU objects (device, queue, atlases, bind groups) are long-lived and expensive to rebuild.

## Decision

All WebGPU calls happen inside `lucida-web/src/renderer/gpu.worker.ts`. The main thread never touches the WebGPU API. The canvas is transferred once, as an `OffscreenCanvas`, when the worker starts. Main thread and worker talk through a typed `postMessage` protocol (`workerProtocol.ts`).

The worker owns the device, queue, atlases, descriptor buffer, and bind groups for the life of the session, so component renders cannot recreate or collect them. The main thread sends state and chunk data. The worker reports back wanted-set deltas, evictions, and other telemetry.

## Rejected alternatives

- Render on the main thread. UI jank under sustained render load was the reason for the move.
- Render on the main thread and move only decode to workers. An earlier version did this. Bind-group lifecycle pain and frame rate under load pushed the GPU fully off the main thread.
- One GPU worker per dataset. Atlases, bind groups, and the descriptor buffer are shared across datasets and would have to be duplicated per worker.

## Consequences

Every state change crosses a serialization boundary. The protocol splits cold state, hot state, and deltas to keep messages small. Chunk bytes stay in the CPU cache on the main thread so they can be resent, so each upload copies the buffer before transferring it. An `OffscreenCanvas` can be transferred only once, so a worker crash loses the canvas, with no in-place recovery. Worker debugging tools are weaker than main-thread profiling.
