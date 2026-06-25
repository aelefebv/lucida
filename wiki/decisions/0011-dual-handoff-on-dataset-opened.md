---
created: 2026-04-18
modified: 2026-06-25
---

# Dual Hand-off on DatasetOpened (WASM + JS)

## Decision

When the web client receives a `dataset_opened` broadcast, it splits the work in **two parallel hand-offs**:

- **WASM side**: `scene.apply_command(commandJson)` — the Rust [[lucida-core]] Scene ingests entities, transforms, images, and layouts. From here, all spatial/visibility logic is WASM-driven.
- **JS side**: in `useBridge.setupFetchPipeline`, five steps in order:
  1. `contentSource.registerImage(image_id, wire_format)` per image
  2. `datasetsRef.set(datasetId, {id, name, manifest, fetch})`
  3. `initLayerMaps(datasetId)` for per-channel display state
  4. a single grow-the-vec `set_channel_visible` for the *last* channel (`channel: channelCount - 1`), only when `channelCount > 1`, so the WASM-side per-channel vec is sized to the data; channel count derives from `levels[0].shape[Axis.C]`
  5. `loopRef.current.addDataset(datasetId, manifest)` and flip `interactiveDirty=true`

Both sides observe the same `DatasetOpened` event but consume different parts of it. `setupFetchPipeline` is skip-if-existing-guarded — it's a no-op when the dataset is already registered.

## Why two paths

A single ingestion path would force one of two compromises:

- **WASM does everything**, including managing JS-side fetch state — but fetch state lives in JS (promise tables, network plumbing, decode pool). Crossing the WASM boundary for every fetch detail is expensive.
- **JS does everything**, including building Scene state — but that reimplements [[lucida-core]] and breaks the [[decisions/0007-wasm-scene-as-source-of-truth|WASM-as-source-of-truth invariant]].

Splitting at the event boundary is the cleanest cut: each side does what it owns; the event is the synchronization point.

## Order matters

Within JS-side, the order is intentional:

- `contentSource.registerImage` first, so when the planner runs and the cache calls `contentSource.fetch(req)`, the image is registered.
- `datasetsRef.set` before `initLayerMaps` so layer-map setup can read the manifest.
- the grow-the-vec `set_channel_visible` **after** the dataset is registered with WASM — the call goes through `wasmScene.apply_command` and would fail otherwise.
- `loopRef.current.addDataset(...)` last on the JS side because flipping `interactiveDirty` triggers the next tick, and the tick must see the fully set-up state.

Reordering breaks subtly — see [[gotchas/app-tsx-hook-order]] for the related hook-order rule.

## How this decision shows up in code

- `lucida-web/src/hooks/useBridge.ts` — the `dataset_opened` command handler.
- `lucida-web/src/hooks/useBridge.ts::setupFetchPipeline` — the JS-side hand-off.
- `lucida-web/src/manifestTypes.ts` mirrors the manifest shape on the TS side so both `apply_command` and `setupFetchPipeline` see the same structure.
- See the dataset-opening flow article: [[flows/dataset-opening]].

## Related

- [[scene-state-and-epochs]]
- [[chunk-lifecycle]]
- [[flows/dataset-opening]]
