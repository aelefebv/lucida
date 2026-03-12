# Minimap Implementation Plan

## Goal

Add a persistent minimap panel that preserves spatial context in both 2D and 3D:

- In 3D: show a small volume overview plus a "what the main camera sees" indicator
- In 2D: show the current Z slice and the current XY viewport location within that slice

The minimap volume should track the current `t / c` selection. The active `z` stays a geometric overlay, not a separate replacement for the 3D overview render.

The minimap should fit the current renderer architecture:

- one main-thread `RenderLoop`
- one GPU worker / one `GPUDevice`
- per-dataset transforms from `lucida-core`
- mixed local and remote datasets

## Constraints From The Current Code

1. `RenderLoop` is the only place that already knows chunk arrival, layer visibility, current mode, and per-dataset metadata.
2. The worker already supports one canvas context plus multi-layer compositing, so the minimap should reuse that worker rather than adding a second renderer stack.
3. Per-dataset transforms already exist in WASM via `model_matrix_for(datasetId)` and `inv_model_matrix_for(datasetId)`.
4. Dataset removal currently clears main-thread bookkeeping, but worker-side GPU resources are only destroyed on full worker shutdown.
5. Remote datasets are seeded in `App.tsx` with zero-filled placeholder volumes. Those placeholders must not be treated as valid minimap overview data.
6. The eagerly assembled local volume in `App.tsx` is only the initial coarsest `t=0 / c=0` volume, so current-`t/c` minimap updates cannot rely on `volumeMap` alone.


## Design Decisions

1. Single RAF source of truth
   The existing `RenderLoop` remains the only animation driver. Main view render and minimap render happen in the same tick.

2. Same worker, second canvas context
   The worker owns both the main `GPUCanvasContext` and a minimap `GPUCanvasContext`, both configured against the same `GPUDevice`.

3. Pinned minimap overview textures
   The minimap uses a dataset-scoped pinned overview texture for the current `t / c`. It is separate from the main `volCache` and never LRU-evicted.

4. Explicit loop ownership in React
   The parent `App` tracks the current live `RenderLoop` in state and passes it to `Minimap`. Do not rely on sibling effect ordering.

5. Per-dataset overlays only
   Every overlay path iterates visible datasets and uses `model_matrix_for(datasetId)` / `inv_model_matrix_for(datasetId)`.

6. Two indicators in 2D
   The 2D minimap shows both:
   - the active Z plane
   - the current XY viewport rectangle projected onto that plane

7. Two orientation affordances
   The minimap includes both world-space axis arrows and a small orientation cube.

## Stage 1: Surface And Plumbing

**Goal:** render a minimap volume panel from the same RAF tick, without touching the main render behavior.

### `lucida-core/src/camera.rs`

Expose a `view_proj()` helper alongside the existing `inv_view_proj()`:

```rust
pub fn view_proj(&self) -> [f32; 16] {
    let vp = self.view_proj_f64();
    let mut out = [0.0f32; 16];
    for i in 0..16 {
        out[i] = vp[i] as f32;
    }
    out
}
```

### `lucida-core/src/wasm.rs`

Add minimap-facing camera exports:

- `camera_theta() -> f64`
- `camera_phi() -> f64`
- `minimap_camera(theta, phi, w, h) -> Vec<f32>`

`minimap_camera()` should return:

- `invViewProj[16]`
- `eye[3]`
- `viewProj[16]`

The minimap camera mirrors the current 3D rotation but uses a fixed target, distance, and FOV. In 2D mode it falls back to default `theta / phi`.

### `lucida-web/src/renderer/workerProtocol.ts`

Add minimap render messages:

- `MinimapInitMessage`
- `MinimapRenderMessage`
- `MinimapDestroyMessage`

Add dataset cleanup message:

- `RemoveLayerResourcesMessage`

Add minimap layer params:

```ts
export interface MinimapLayerParams {
  datasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
}
```

### `lucida-web/src/renderer/gpu.worker.ts`

Add:

- `minimapContext: GPUCanvasContext | null`
- `minimapOffscreenPool`
- `minimapOverviewPerDataset`

`minimapRender` should:

- use the pinned overview texture map, not `activeVolKeyPerDataset`
- reuse `VolumeRenderer` and `LayerCompositor`
- render to the minimap canvas context
- composite all minimap layers with alpha blending and opacity `1.0`

`removeLayerResources` should destroy all GPU resources for a dataset:

- slice fallback
- slice tile texture
- volume LRU entries
- active volume key
- minimap overview texture

This message is required for correct dataset removal.

### `lucida-web/src/renderer/renderClient.ts`

Add:

- `minimapInit(canvas: HTMLCanvasElement)`
- `minimapRender(...)`
- `minimapDestroy()`
- `removeLayerResources(datasetId: string)`

### `lucida-web/src/renderLoop.ts`

Add minimap state:

```ts
private minimapEnabled = false;
private minimapSize = 200;
private minimapOverlayCallback:
  ((data: MinimapOverlayData) => void) | null = null;
```

Add:

- `setMinimap(enabled, size?, overlayCallback?)`
- `tickMinimap()`

`tickMinimap()` should:

1. read `theta / phi` from WASM
2. compute minimap backing size in device pixels
3. call `scene.minimap_camera(...)`
4. build minimap layer params from visible datasets
5. send `client.minimapRender(...)`
6. invoke the overlay callback with projection data and per-dataset metadata

### `lucida-web/src/App.tsx`

Track the live loop explicitly:

```ts
const [activeLoop, setActiveLoop] = useState<RenderLoop | null>(null);
```

Pass `setActiveLoop` into `SliceViewer` and `VolumeViewer`. Keep the existing `loopRef` for imperative calls from `App`; `activeLoop` is the reactive version used by `Minimap`.

Also call `client.removeLayerResources(id)` anywhere a dataset is removed.

### `lucida-web/src/components/SliceViewer.tsx`
### `lucida-web/src/components/VolumeViewer.tsx`

On mount:

- create the loop
- assign `loopRef.current`
- assign `parentLoopRef.current`
- call `onLoopChange(loop)`

On cleanup:

- stop the loop
- clear `parentLoopRef.current`
- call `onLoopChange(null)`

### `lucida-web/src/components/Minimap.tsx`

Create a persistent floating panel with two stacked canvases:

- GPU canvas
- Canvas2D overlay canvas

Lifecycle:

- on mount: `client.minimapInit(gpuCanvas)`
- on unmount: `client.minimapDestroy()`
- on `activeLoop` change: register or unregister via `loop.setMinimap(...)`

Do not depend on JSX ordering or sibling effect timing.

### `lucida-web/src/components/Minimap.css`

Use a fixed-size floating panel in the bottom-right of the render area. The panel can stay mounted across mode switches.

### Stage 1 Acceptance

1. Local dataset in 3D renders in the minimap.
2. Switching between 2D and 3D keeps the minimap mounted and rebinds it to the new loop.
3. Removing a dataset does not leave stale minimap layers or leaked worker textures.

## Stage 2: Overview Population And Remote Support

**Goal:** make the minimap overview texture valid for both local and remote datasets, and keep it synchronized to the current `t / c`.

### Core rule

Never create a minimap overview texture from the zero-filled placeholder volumes used for remote datasets in `App.tsx`.

The minimap overview must track the current `t` and `c`. The current `z` remains a slice-plane overlay.

### `lucida-web/src/renderer/workerProtocol.ts`

Add explicit overview upload messages:

- `MinimapSetOverviewForLayerMessage`
- `MinimapUploadOverviewChunksForLayerMessage`

Both messages must include `t` and `c` so the worker can reject stale uploads after a view-state change.

The first seeds a whole coarsest volume at once. The second incrementally fills the overview texture by chunk.

### `lucida-web/src/renderer/gpu.worker.ts`

Maintain pinned overview state per dataset:

```ts
interface MinimapOverviewEntry {
  texture: GPUTexture;
  uploaded: Set<string>;
  t: number;
  c: number;
  width: number;
  height: number;
  depth: number;
  intensityMin: number;
  intensityMax: number;
}
```

Support two population paths:

1. Full upload
   Used when a whole coarsest volume for the current `t / c` is already available in memory.

2. Chunked upload
   Used whenever the current `t / c` overview must be built progressively from coarsest-level chunks.

### `lucida-web/src/App.tsx`

When eagerly pre-uploading datasets:

- keep `client.volumeSetInitialForLayer(...)` for the main renderer
- only call `client.minimapSetOverviewForLayer(...)` when the buffered coarsest volume actually matches the current `t / c`
- skip minimap seeding for remote placeholder datasets

Local vs remote can be decided from `datasetsRef.current.get(id)?.fileIndex`.

The existing `volumeMap` fast path only covers the initial local `t=0 / c=0` state. All later `t / c` changes must go through the explicit minimap overview upload path.

### `lucida-web/src/renderLoop.ts`

Add minimap overview bookkeeping for datasets that do not have a seeded overview:

- track the current minimap overview key per dataset, for example `${datasetId}/${level}/${t}/${c}`
- reset per-dataset overview upload state when `t` or `c` changes
- track which coarsest overview chunks for the active `t / c` have been uploaded
- request missing coarsest chunks from the `ChunkStore`
- upload available chunks to the worker with a small independent budget

This path must run even in 2D mode so remote datasets eventually gain a minimap overview without requiring the user to enter 3D.

Keep the overview scope deliberately bounded:

- coarsest level only
- current `t`
- current `c`

### Stage 2 Acceptance

1. Local datasets show a minimap immediately when the current `t / c` overview is already buffered.
2. Changing `t` or `c` invalidates the old minimap overview and rebuilds the new one for the active selection.
3. Remote datasets start blank, then progressively gain a minimap overview for the active `t / c` as coarsest chunks arrive.
4. Remote datasets in 2D mode still get a minimap overview without first visiting 3D.
5. Dataset removal clears overview state on both main thread and worker.

## Stage 3: Bounding Boxes And Mode-Specific "You Are Here" Overlays

**Goal:** add the actual spatial indicators.

### `lucida-web/src/renderLoop.ts`

Export richer overlay data:

```ts
export interface MinimapOverlayData {
  viewProj: Float32Array;
  layers: {
    datasetId: string;
    modelMatrix: Float32Array;
    invModelMatrix: Float32Array;
  }[];
  mode: "slice" | "volume";
  theta: number;
  phi: number;
  canvasW: number;
  canvasH: number;
  currentZ: number;
  datasetDims: Map<string, { width: number; height: number; depth: number }>;
  sliceViewBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  mainInvViewProj: Float32Array | null;
}
```

`sliceViewBounds` should be computed from the same center / zoom / canvas dimensions already used by the 2D renderer.

### `lucida-web/src/components/minimapOverlay.ts`

Create reusable overlay helpers:

- `mulMat4Vec4`
- `mulMat4`
- `projectToCanvas`

Add these draw paths:

1. `drawBoundingBox(...)`
   Draw one wireframe unit cube per visible dataset.

2. `drawAxisArrows(...)`
   Draw world-space axis arrows in the shared normalized frame used by the dataset model transforms.

Suggested anchor:

- origin near a cube corner such as `[0.12, 0.12, 0.12]`
- X arrow to `[0.28, 0.12, 0.12]`
- Y arrow to `[0.12, 0.28, 0.12]`
- Z arrow to `[0.12, 0.12, 0.28]`

Project these directly through `viewProj`, then draw arrowheads and labels.

3. `drawSlicePlane(...)`
   Draw the active Z plane per dataset using normalized Z:

```ts
const nz = currentZ / Math.max(depth - 1, 1);
```

4. `drawSliceViewportRect(...)`
   In 2D mode, project the current XY view bounds onto the active Z plane.

For each dataset:

- normalize `minX / maxX` by dataset width
- normalize `minY / maxY` by dataset height
- clamp into `[0, 1]`
- draw the rectangle on the Z plane after the dataset model transform

5. `drawFrustumIntersection(...)`
   In 3D mode:
   - unproject the main camera's 8 NDC corners through `mainInvViewProj`
   - transform them into dataset unit space via `invModelMatrix`
   - build the frustum polyhedron as 6 convex polygon faces in unit space
   - clip that convex polyhedron against the 6 cube half-spaces:
     - `x >= 0`, `x <= 1`
     - `y >= 0`, `y <= 1`
     - `z >= 0`, `z <= 1`
   - preserve polygon faces during clipping and generate cut faces when a clip plane slices the frustum
   - if the clipped polyhedron is empty, draw nothing
   - extract unique edges from the surviving faces
   - transform all surviving vertices back via `modelMatrix`
   - project through the minimap `viewProj`
   - draw the resulting exact convex intersection wireframe

Do not replace this with an AABB approximation.

### Stage 3 Acceptance

1. Each visible dataset has a bounding box in the minimap.
2. World-space axis arrows remain visible and correctly oriented in both 2D and 3D.
3. In 2D mode, the minimap shows both the current Z plane and the current XY viewport rectangle.
4. In 3D mode, the minimap shows the exact convex frustum intersection and it responds to pan / zoom / rotation.
5. Multiple datasets with different transforms produce distinct, correctly aligned overlays.

## Stage 4: Orientation Cube

**Goal:** add a compact, always-readable orientation affordance.

### `lucida-web/src/components/minimapOverlay.ts`

Add `drawOrientationCube(ctx, theta, phi, w, h)`:

- render into a small inset region
- use the same spherical rotation convention as `View3D.eye_position()`
- sort faces back-to-front
- color axis pairs consistently
- label visible faces

This is separate from the main minimap volume and does not need more worker or WASM changes beyond the `theta / phi` values already exposed in Stage 1.
It complements the world-space axis arrows rather than replacing them.

### Stage 4 Acceptance

1. The cube rotates with the main 3D camera orientation.
2. Face colors and labels stay legible across angles.
3. The cube does not materially obscure minimap content.

## DPR And Canvas Rules

Apply these rules to both minimap canvases:

1. CSS size stays fixed, for example `200 x 200`.
2. Backing store size is `Math.round(cssSize * devicePixelRatio)`.
3. GPU and overlay canvases use the same backing size.
4. Overlay drawing coordinates should use backing-store pixels so overlays line up exactly with the GPU render.

## Test Matrix

### Functional

1. Local dataset, 3D mode, rotate camera: minimap volume and overlays track correctly.
2. Change `t` or `c`: minimap overview swaps to the active selection rather than staying on `0 / 0`.
3. Local dataset, 2D mode, pan / zoom / scrub Z: slice plane and XY viewport rectangle move correctly.
4. Remote dataset, 2D mode only: minimap overview for the active `t / c` appears progressively without entering 3D.
5. Main view partially exits a dataset in 3D: the minimap shows the clipped convex frustum intersection, not an enclosing box.
6. Multiple datasets with different physical scales: per-dataset boxes and indicators stay distinct.
7. Dataset removal: no stale minimap layer and no worker-side leak.

### Regression

1. Main canvas rendering remains unchanged when minimap is disabled.
2. Mode switching still recreates the main loop correctly.
3. Presence / follow mode still marks the active loop dirty and updates the minimap.
4. HiDPI displays render sharp minimap content and aligned overlays.

## Key Files

| File | Change |
|------|--------|
| `lucida-core/src/camera.rs` | Add `view_proj()` |
| `lucida-core/src/wasm.rs` | Add minimap camera exports |
| `lucida-web/src/renderer/workerProtocol.ts` | Add minimap and cleanup messages |
| `lucida-web/src/renderer/gpu.worker.ts` | Add minimap context, overview textures, dataset cleanup |
| `lucida-web/src/renderer/renderClient.ts` | Add minimap init / render / destroy and per-dataset cleanup |
| `lucida-web/src/renderLoop.ts` | Add minimap render path, current-`t/c` overview population, overlay payload |
| `lucida-web/src/App.tsx` | Track `activeLoop`, seed minimap fast path only when it matches current `t / c`, call worker cleanup on removal |
| `lucida-web/src/components/SliceViewer.tsx` | Report loop mount / unmount explicitly |
| `lucida-web/src/components/VolumeViewer.tsx` | Report loop mount / unmount explicitly |
| `lucida-web/src/components/Minimap.tsx` | New panel component |
| `lucida-web/src/components/Minimap.css` | New minimap layout styles |
| `lucida-web/src/components/minimapOverlay.ts` | New overlay math and drawing helpers, axis arrows, exact frustum clipping |
