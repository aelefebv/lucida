# Refactoring Analysis

Survey of files across the repo that genuinely look worth splitting.
The ranking favors mixed responsibilities, lifecycle complexity, and state ownership over raw line count.
Files that are long mainly because of tests, or that are large but still cohesive, are intentionally ranked lower.

---

## Priority Ranking

| Priority | File | Lines | Payoff |
|----------|------|-------|--------|
| 1 | `lucida-web/src/renderLoop.ts` | 647 | Highest coordination complexity; owns RAF scheduling plus three render/upload paths |
| 2 | `lucida-web/src/renderer/gpu.worker.ts` | 591 | Giant message switch with three mostly independent GPU state machines |
| 3 | `lucida-server/src/main.rs` | 419 | Per-client lifecycle is trapped inside one large spawned async block |
| 4 | `lucida-web/src/components/minimapOverlay.ts` | 618 | Large but mostly pure helper code; split is clean, payoff is moderate |
| 5 | `lucida-core/src/camera.rs` | 669 | Matrix helpers can move out, but the current coupling is still local |
| 6 | `lucida-core/src/scene.rs` | 683 | Production code is moderate size; tests dominate the file |
| 7 | `lucida-store/src/ingest/pyramid.rs` | 705 | Planning/execution split is possible, but current ingest still uses both together |

---

## Detailed Analysis

### 1. `lucida-web/src/renderLoop.ts` (647 lines) — SPLIT, BUT START COARSE

**What it does:** Pull-based render loop that coalesces chunk arrivals into RAF ticks. One class currently owns scheduling, dataset lifecycle, slice uploads/renders, volume uploads/renders, minimap overview seeding, and minimap render/overlay preparation.

**What is actually coupled:**

1. **Core lifecycle**: RAF scheduling, `dirty` handling, dataset subscriptions, add/remove/reset logic.
2. **Slice path**: slice LOD tracking, upload budgeting, `SliceLayerParams` construction, `sliceRenderMultiPass`.
3. **Volume path**: per-dataset volume LRU state, upload budgeting, `VolumeLayerParams` construction, `volumeRenderMultiPass`.
4. **Minimap overview path**: overview seeding, progressive uploads, deferred fetch bookkeeping.
5. **Minimap render path**: minimap camera setup, `MinimapLayerParams`, overlay data construction.

This is still the right top priority, but the coupling is a bit stronger than a line-count pass suggests:

- Slice, volume, and minimap all depend on shared scene snapshots and dataset ownership.
- `minimapPendingFetch` feeds back into the main slice/volume fetch paths.
- The exported `MinimapOverlayData` type is consumed by `minimapOverlay.ts`, so minimap extraction has a type-boundary consequence.

**Recommended first split:**

| New file | What moves | Notes |
|----------|-----------|-------|
| `renderLoop.ts` | lifecycle, dataset management, `tick()` dispatch, shared mutable state | Keep the orchestrator here |
| `slicePath.ts` | slice upload/render path and per-dataset slice tracking | Natural unit |
| `volumePath.ts` | volume upload/render path and LRU tracking | Natural unit |
| `minimapPath.ts` | minimap overview seeding plus minimap render/overlay prep | Keep overview + render together at first |

If the minimap path moves out, also move `MinimapOverlayData` to a neutral module such as `minimapTypes.ts`.

**Verdict:** Strong refactor candidate, but avoid an immediate five-file split. A coarse extraction into a few collaborator modules is the better first pass.

---

### 2. `lucida-web/src/renderer/gpu.worker.ts` (591 lines) — SPLIT

**What it does:** WebGPU render worker. A single `switch` on `msg.type` handles initialization, slice uploads/renders, volume uploads/renders, minimap uploads/renders, per-layer cleanup, and full teardown.

**Why this is a strong candidate:**

The file already contains three distinct state machines:

1. **Slice state**: `tileStatePerDataset`, `fallbackPerDataset`, slice uploads, slice compositing.
2. **Volume state**: `volCache`, `activeVolKeyPerDataset`, LRU eviction, volume compositing.
3. **Minimap state**: `minimapOverviewPerDataset`, minimap context, minimap offscreen pool.

The shared dependencies are straightforward:

- `device`, `context`, `format`
- lazy renderer/compositor getters
- offscreen pool helpers
- resource cleanup paths

**Recommended split:**

| New file | What moves | Notes |
|----------|-----------|-------|
| `gpu.worker.ts` | `onmessage` dispatch, init, destroy, shared context setup | Main entrypoint only |
| `sliceHandlers.ts` | slice-related handlers and slice state | Clear boundary |
| `volumeHandlers.ts` | volume-related handlers and LRU logic | Clear boundary |
| `minimapHandlers.ts` | minimap-related handlers and minimap state | Clear boundary |
| `workerResources.ts` | optional shared cleanup/pool helpers | Only if duplication appears |

**Verdict:** Probably the cleanest split in the repo. The current switch is doing too much, and the handler clusters are already obvious.

---

### 3. `lucida-server/src/main.rs` (419 lines) — SPLIT

**What it does:** Tokio WebSocket server. `main()` owns the accept loop, then each client connection is handled by a large inline `tokio::spawn` block that performs setup, snapshot send, outbound forwarding, inbound routing, and disconnect cleanup.

**Why it ranks above `minimapOverlay.ts`:**

This is not just a long file; it is a long lifecycle closure with protocol routing and cleanup logic mixed together. That hurts readability and makes future changes riskier than a pure-helper file of similar size.

**What's separable:**

1. **Accept loop + shared state**: listener setup, ID allocation, channel creation.
2. **Per-client handler**: split socket, subscribe, add client, send snapshot.
3. **Outbound forwarding**: broadcast and unicast forwarding task.
4. **Inbound routing**: `ClientMessage`, `ChunkMessage`, and binary chunk forwarding.
5. **Cleanup**: remove client, clear data-source ownership, send `PeerLeft` and redirected follow updates.

**Recommended split:**

| New file | What moves | Notes |
|----------|-----------|-------|
| `main.rs` | accept loop and shared infrastructure | Keep startup here |
| `handler.rs` | `handle_client(...)` with setup, outbound, inbound, cleanup | First extraction |

`BroadcastItem` can stay in `main.rs` at first or move to a small shared module if multiple files need it.

**Verdict:** High-value refactor. Extracting `handle_client()` would materially improve the file without changing architecture.

---

### 4. `lucida-web/src/components/minimapOverlay.ts` (618 lines) — OPTIONAL SPLIT

**What it does:** 2D canvas overlay drawing for the minimap: bounding boxes, axis arrows, orientation cube, slice plane indicators, viewport rectangles, and 3D frustum-volume intersection visualization.

**Why the payoff is moderate rather than high:**

This file is large, but it is mostly pure helper code with one entry point. Unlike `renderLoop.ts` or `main.rs`, it does not also own caches, lifecycle, or protocol flow.

**What's cleanly separable:**

1. **Math helpers**: matrix multiply, point transform, projection.
2. **Orientation cube**: self-contained drawing block.
3. **Frustum clipping**: computational geometry block, by far the most complex part.
4. **Slice overlays**: slice plane and viewport rectangle helpers.

**Recommended split:**

| New file | What moves | Notes |
|----------|-----------|-------|
| `minimapMath.ts` | `mulMat4Vec4`, `mulMat4`, `projectToCanvas`, `transformPoint` | Easiest win |
| `orientationCube.ts` | orientation cube helpers/drawing | Clean extraction |
| `frustumOverlay.ts` | clipping and frustum intersection drawing | Only if this code keeps growing |

Keep `drawMinimapOverlays()` in `minimapOverlay.ts` until the helper boundaries settle.

**Verdict:** Reasonable cleanup, but not urgent. Start with extracting math helpers; do not prioritize this over server or worker refactors.

---

### 5. `lucida-core/src/camera.rs` (669 lines) — SMALL SPLIT

**What it does:** Camera types, 2D/3D camera behavior, visible-region computation, frustum math, plus a private block of 4x4 matrix helpers and tests.

**What's separable:**

1. **Camera types + behavior**: `Camera`, `View2D`, `View3D`, visible-region computation.
2. **Private math helpers**: `perspective`, `look_at`, `mul4`, inverses, vector ops, `unproject`, `transform_point`.

**Caveat:** The helper block is real, but it is still private and only serves `View3D` in this file. Extracting it improves readability more than architecture.

**Recommended split:**

| New file | What moves | Notes |
|----------|-----------|-------|
| `mat4.rs` | matrix/vector helpers | Low-risk extraction |
| `camera.rs` | camera types and visible-region logic | Keep behavior local |

**Verdict:** Worth doing only if you are already touching this file. The benefit is modest compared with the top three items.

---

### 6. `lucida-core/src/scene.rs` (683 lines) — MARGINAL / SKIP FOR NOW

**What it does:** Scene state, dataset/layer metadata, chunk-plan helpers, and a large test block.

**Why this should stay low priority:**

- The production code is only about half the file.
- The data types and `Scene` behavior are closely related.
- Splitting the type definitions into `types.rs` would mostly create import churn without reducing conceptual load much.

**When a split would make sense:**

- Another module needs `Dataset`, `Layer`, `LevelInfo`, or `LayerDisplaySettings` without depending on `Scene`.
- The non-test code grows substantially past its current size.

**Verdict:** The current file is large, but still cohesive enough. Not a refactor target yet.

---

### 7. `lucida-store/src/ingest/pyramid.rs` (705 lines) — MARGINAL / SKIP FOR NOW

**What it does:** Anisotropy-aware pyramid planning plus XY/Z/XYZ downsampling kernels and tests.

**What's conceptually separable:**

1. **Schedule planning**: `VoxelSize`, `LevelSpec`, `compute_downsample_schedule`.
2. **Execution**: `Level`, `downsample`, `downsample_xy`, `downsample_z_only`, `downsample_xyz`, `build_pyramid`.

**Why the payoff is lower than it first appears:**

- The file is heavily test-driven, which inflates its size.
- The planner and executor are still connected in the ingest pipeline.
- `convert_tiff_to_zarr()` computes the schedule, materializes metadata from it, then uses `pyramid::downsample()` level-by-level.

**Recommended split only if needed later:**

| New file | What moves | Notes |
|----------|-----------|-------|
| `schedule.rs` | `VoxelSize`, `LevelSpec`, `compute_downsample_schedule` | Only if reuse grows |
| `pyramid.rs` | downsampling kernels and `Level` | Keep execution together |

**Verdict:** Low priority. Possible cleanup, but not where the repo's complexity is really coming from right now.

---

## Best Next Refactors

If only a few items get done, the highest-value sequence is:

1. Coarse extraction inside `renderLoop.ts`
2. Handler-module split in `gpu.worker.ts`
3. `handle_client()` extraction from `lucida-server/src/main.rs`

Those three changes attack the actual coordination hot spots in the repo.
