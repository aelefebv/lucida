# Multi-Dataset Layer Support

## Context

Lucida currently supports viewing a single dataset at a time. This plan adds multi-dataset support: opening multiple datasets simultaneously, compositing them with per-layer controls (opacity, contrast, gamma, blend mode, visibility), and reordering layers independently per user. This enables comparing before/after scans, overlaying segmentations on raw data, and multi-channel visualization.

**Key design decisions from discussion:**
- Document-level: dataset add/remove only (synced to all clients)
- Viewport-level: layer ordering + display settings (per-user, synced via presence for follow mode)
- Multi-pass rendering: each volume rendered independently, then 2D composited
- Volumes corner-aligned at (0,0,0), physical spacing respected
- Presence split: `layer_order` (rare changes) vs `layer_settings` (frequent changes)

**Naming note:** The existing `Layer` type in `scene.rs` represents an image pyramid within a dataset (has `num_levels`, `chunk_size`, `data_shape`). The new "layer" concept refers to a dataset's position and display settings in the compositing stack. These are kept separate — no renaming of the existing type.

---

## Part 1: Per-Dataset Display Settings in Rust Core

**Goal:** Add `LayerDisplaySettings` and `BlendMode` types. Wire layer settings into the WASM API. App continues to work with a single dataset but the data model supports multiple.

### Files to modify

**`lucida-core/src/scene.rs`**
- Add new types:
  ```rust
  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
  pub enum BlendMode { Alpha, Additive, Max }

  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct LayerDisplaySettings {
      pub visible: bool,
      pub opacity: f32,
      pub contrast_min: f64,
      pub contrast_max: f64,
      pub gamma: f64,
      pub blend_mode: BlendMode,
  }
  ```
- Add to `Scene`:
  ```rust
  /// Per-dataset display settings (viewport-level, not shared).
  /// Key is dataset ID. Order is maintained separately.
  #[serde(default)]
  pub layer_order: Vec<String>,
  #[serde(default)]
  pub layer_settings: HashMap<String, LayerDisplaySettings>,
  ```
- In `Scene::add_dataset()`: auto-append dataset ID to `layer_order`, insert default `LayerDisplaySettings` into `layer_settings`
- In `Scene::remove_dataset()`: remove from `layer_order` and `layer_settings`
- Keep existing `DisplayState` and `display` field for now (backward compat), but new per-layer settings take priority when present

**`lucida-core/src/command.rs`**
- Add viewport-level commands (NOT document commands):
  - `SetLayerOrder { order: Vec<String> }`
  - `SetLayerVisible { dataset_id: String, visible: bool }`
  - `SetLayerOpacity { dataset_id: String, opacity: f32 }`
  - `SetLayerContrast { dataset_id: String, min: f64, max: f64 }`
  - `SetLayerGamma { dataset_id: String, gamma: f64 }`
  - `SetLayerBlendMode { dataset_id: String, blend_mode: BlendMode }`
- Implement `Scene::apply()` for each

**`lucida-core/src/wasm.rs`**
- Add `layer_order(&self) -> String` — JSON array of dataset IDs
- Add `layer_display_settings(&self, dataset_id: &str) -> String` — JSON of `LayerDisplaySettings`
- Add `all_layer_settings(&self) -> String` — JSON of full `HashMap<String, LayerDisplaySettings>`
- Add `export_layer_presence(&self) -> String` — serializes `{ layer_order, layer_settings }`
- Add `import_layer_presence(&mut self, json: &str)` — for follow mode
- Add `model_matrix_for(&self, dataset_id: &str) -> Vec<f32>`
- Add `inv_model_matrix_for(&self, dataset_id: &str) -> Vec<f32>`
- Add `dataset_ids(&self) -> String` — JSON array of dataset IDs in document

### Verification
- `cargo test` in lucida-core passes
- Existing WASM API still works (backward compat via `#[serde(default)]`)
- New commands round-trip through JSON serialization

---

## Part 2: Corner-Aligned Volume Transform

**Goal:** Change volume positioning from centered-at-origin to corner-aligned at (0,0,0). Update 3D camera defaults.

### Files to modify

**`lucida-core/src/transform.rs`**
- Modify `compute_volume_transform()` to corner-align:
  - Model matrix: `Scale(sx, sy, sz)` with no translation (origin at corner)
  - `model[12..15]` becomes `(0, 0, 0)` instead of `(-sx/2, -sy/2, -sz/2)`
  - Inverse model: `Scale(1/sx, 1/sy, 1/sz)` with `inv_model[12..15]` = `(0, 0, 0)` instead of `(0.5, 0.5, 0.5)`
- Update tests to expect corner-aligned values

**`lucida-core/src/camera.rs`**
- Update `View3D::new()` default `target` to `[0.5, 0.5, 0.5]` (center of a unit-sized volume at origin) instead of `[0.0, 0.0, 0.0]`
- This ensures the camera orbits around the center of the volume rather than the corner

**`lucida-web/src/renderer/volume.wgsl`**
- Change background return on ray miss from hardcoded color to `vec4f(0.0, 0.0, 0.0, 0.0)` (transparent) — needed for multi-pass compositing in Part 4
- No change to ray-AABB intersection (already uses `[0,1]^3`)

**`lucida-web/src/components/VolumeViewer.tsx`**
- Verify initial camera setup still works with corner-aligned volumes (may need to adjust initial orbit distance)

### Verification
- 3D volume renders correctly (visual test — volume should appear in same screen position, just with different world-space coordinates)
- `cargo test` passes with updated transform tests
- Camera orbits around volume center, not corner

---

## Part 3: Multi-Dataset Chunk Loading

**Goal:** Make the frontend load and manage chunks for multiple datasets simultaneously. Only the "selected" dataset renders for now (multi-pass rendering comes in Part 4).

### Files to modify

**`lucida-web/src/renderLoop.ts`**
- Change constructor signature: replace single `store`/`datasetInfo` with `datasets: Map<string, { store: ChunkStore; info: DatasetInfo }>`
- Add `selectedDatasetId: string` to track which dataset to render
- Add `setSelectedDataset(id: string)` method
- Add `addDataset(id, store, info)` and `removeDataset(id)` methods for dynamic updates
- `tickVolume()`: iterate over all datasets for chunk loading (call `store.ensureFetched()` for each), but only render the selected one
- `tickSlice()`: same pattern
- Per-dataset volume cache: `volumeUploaded` keyed as `${datasetId}/${level}/${t}/${c}`

**`lucida-web/src/App.tsx`**
- Remove `storeRef` (single store) — use `datasetsRef` exclusively
- When opening a new dataset:
  1. Create `ChunkStore`, store in `datasetsRef`
  2. Send `AddDataset` command
  3. Call `renderLoop.addDataset(id, store, info)`
  4. Set as selected dataset if it's the first one
- When receiving remote `AddDataset` command: create a remote `ChunkStore`, add to `datasetsRef` and render loop
- On `RemoveDataset`: remove from `datasetsRef` and render loop
- Add `selectedDatasetId` state

**`lucida-web/src/renderer/renderClient.ts`**
- No changes yet — single-dataset render API still used, just called with different datasets

### Verification
- Open one dataset: works identically to before
- Open a second dataset: chunks load for both, but only selected one renders
- Switch selected dataset: other dataset renders, already-loaded chunks appear immediately

---

## Part 4: Multi-Pass Rendering and Compositing

**Goal:** Render each visible layer to an offscreen texture, then composite them in layer order with per-layer opacity and blend mode. Covers both 3D volume and 2D slice modes.

### Files to modify

**`lucida-web/src/renderer/volume.wgsl`**
- Change fragment output: return `vec4f(color, alpha)` instead of blending with background
- Remove background blending lines (`let bg = ...; let final_color = color + (1.0 - alpha) * bg;`)
- Return `vec4f(0.0, 0.0, 0.0, 0.0)` on ray miss (transparent)
- Add `opacity` to uniforms (pack into `displayParams.y`)

**New: `lucida-web/src/renderer/compositor.wgsl`**
- Full-screen triangle shader that samples a 2D texture and outputs with opacity multiplier
- Simple: `return vec4f(texColor.rgb * texColor.a * opacity, texColor.a * opacity)` (premultiplied alpha)

**`lucida-web/src/renderer/volumeRenderer.ts`**
- Add `renderToTexture(target: GPUTexture)` method that renders to an offscreen texture instead of the canvas
- Keep existing `render()` as convenience for single-layer case (renders directly to canvas with background)

**New: `lucida-web/src/renderer/layerCompositor.ts`**
- New class that composites N offscreen textures to the canvas
- Constructor: create pipeline with `compositor.wgsl`, blend state configurable per draw
- `composite(layers: { texture: GPUTexture, opacity: number, blendMode: BlendMode }[])`:
  1. Clear canvas with background color
  2. For each layer (back-to-front): draw full-screen quad sampling layer's texture, with GPU blend state set per blend mode:
     - Alpha: standard premultiplied alpha blending (`src + (1-srcAlpha) * dst`)
     - Additive: `src + dst`
     - Max: `max(src, dst)`

**`lucida-web/src/renderer/gpuContext.ts`**
- Add `createOffscreenTarget(width, height): GPUTexture` — rgba8unorm or rgba16float, usage: TEXTURE_BINDING | RENDER_ATTACHMENT

**`lucida-web/src/renderer/workerProtocol.ts`**
- Add `VolumeUploadChunksForLayerMessage` — like `VolumeUploadChunks` but with `datasetId: string`
- Add `VolumeRenderMultiPassMessage`:
  ```typescript
  interface LayerRenderParams {
    datasetId: string;
    modelMatrix: Float32Array;
    invModelMatrix: Float32Array;
    contrastMin: number;
    contrastMax: number;
    gamma: number;
    opacity: number;
    blendMode: "alpha" | "additive" | "max";
  }
  interface VolumeRenderMultiPassMessage {
    type: "volumeRenderMultiPass";
    layers: LayerRenderParams[];
    invViewProj: Float32Array;
    eye: Float32Array;
    canvasW: number;
    canvasH: number;
  }
  ```

**`lucida-web/src/renderer/gpu.worker.ts`**
- Per-dataset volume cache: `volCache` becomes `Map<string, Map<string, VolCacheEntry>>` (outer key = datasetId)
- Handle `volumeUploadChunksForLayer`: route to per-dataset cache
- Handle `volumeRenderMultiPass`:
  1. For each layer (back-to-front):
     - Look up dataset's active texture from its cache
     - Set up VolumeRenderer with that texture's uniforms (model, contrast, gamma)
     - Render to offscreen texture
  2. Run LayerCompositor to composite all offscreen textures to canvas
- Manage a small pool of offscreen render targets (reuse across frames, resize as needed)

**`lucida-web/src/renderer/renderClient.ts`**
- Add `volumeUploadChunksForLayer(datasetId, ...)` method
- Add `volumeRenderMultiPass(layers, invViewProj, eye, canvasW, canvasH)` method

**`lucida-web/src/renderLoop.ts`**
- `tickVolume()` now:
  1. Get layer order and settings from WASM scene
  2. For each dataset (all, not just visible — to keep chunks warm): compute chunk plan, upload
  3. Build `LayerRenderParams[]` for visible layers only
  4. Call `client.volumeRenderMultiPass(layers, ...)`
- Per-dataset model matrices from `scene.model_matrix_for(datasetId)`

**2D Slice Multi-Pass (same approach, simpler):**

**`lucida-web/src/renderer/slice.wgsl`**
- Same change as volume shader: return `vec4f(color, alpha)` instead of opaque output
- Per-layer contrast/gamma already applied per-slice — just needs transparent background on empty regions

**`lucida-web/src/renderer/sliceRenderer.ts`**
- Add `renderToTexture(target: GPUTexture)` method (mirrors volumeRenderer change)
- Each dataset's slice rendered to its own offscreen texture

**`lucida-web/src/renderer/workerProtocol.ts`**
- Add `SliceUploadTilesForLayerMessage` — like `SliceUploadTiles` but with `datasetId: string`
- Add `SliceRenderMultiPassMessage` — same structure as `VolumeRenderMultiPassMessage` but with slice-specific params (zoom, cx, cy, dataW, dataH per layer)

**`lucida-web/src/renderer/gpu.worker.ts`**
- Per-dataset slice tile state: `tileState` becomes `Map<string, TileState>` (keyed by datasetId)
- Handle `sliceUploadTilesForLayer`: route to per-dataset tile state
- Handle `sliceRenderMultiPass`: render each layer's slice to offscreen texture, composite via LayerCompositor

**`lucida-web/src/renderer/renderClient.ts`**
- Add `sliceUploadTilesForLayer(datasetId, ...)` and `sliceRenderMultiPass(...)` methods

**`lucida-web/src/renderLoop.ts`**
- `tickSlice()` updated to mirror `tickVolume()` multi-dataset pattern: load chunks for all datasets, render visible layers via multi-pass

**The `LayerCompositor` is shared between 2D and 3D modes** — it just composites 2D textures regardless of how they were produced.

### Verification
- Single dataset: renders identically in both 2D and 3D (one layer, full opacity, alpha blend)
- Two datasets: both visible and correctly composited in both modes
- Opacity slider on top layer: bottom layer shows through
- Blend modes: additive brightens overlapping regions, max produces MIP-like
- Segmentation mask (voxel 0 = transparent): raw data visible where mask is 0
- 2D slice mode: multiple slices overlay correctly with independent contrast/gamma

---

## Part 5: Layer Panel UI

**Goal:** Add left sidebar with layer panel. Replace Open File/Folder buttons with "Add Layer". Per-layer controls. Selected layer concept.

### Files to create/modify

**New: `lucida-web/src/components/LayerPanel.tsx`**
- Left sidebar component
- Props: layer order, layer settings map, selected layer ID, dataset names map, callbacks
- Each layer row (collapsed):
  - Drag handle (or up/down buttons initially)
  - Eye icon toggle (visibility)
  - Dataset name
  - Opacity slider (always visible)
  - Expand arrow
- Each layer row (expanded):
  - Contrast min/max range slider
  - Gamma slider
  - Blend mode selector (dropdown: Alpha, Additive, Max)
  - "Remove" button (deletes dataset from document, with confirmation)
- Click row to select (highlight)
- "Add Layer" button at bottom — triggers folder/file picker
- Selected layer gets visual highlight (border or background tint)

**`lucida-web/src/App.tsx`**
- Add `selectedLayerId` state
- Remove standalone "Open File" / "Open Folder" buttons
- Remove standalone `ContrastControls` component (controls move into layer panel)
- Add `<LayerPanel>` to the left of the canvas in a flex layout
- Wire callbacks:
  - Visibility toggle: `applyViewportCommand(scene, { type: "set_layer_visible", ... })` + `emitPresence()`
  - Opacity: `applyViewportCommand(scene, { type: "set_layer_opacity", ... })` + `emitPresence()`
  - Contrast/gamma: same pattern
  - Blend mode: same pattern
  - Reorder: `applyViewportCommand(scene, { type: "set_layer_order", ... })` + `emitPresence()`
  - Remove: `applyDocumentCommand(scene, { type: "remove_dataset", ... })` with confirmation dialog
  - Add Layer: trigger file picker, then run existing dataset loading flow
- Track per-layer `dataRange` (intensity range from GPU worker) for contrast slider bounds
- `dataRange` becomes `Map<string, { min: number; max: number }>` keyed by dataset ID

**`lucida-web/src/App.css`**
- Add `.layer-panel` sidebar styles (fixed width, dark background, scrollable)
- `.layer-row`, `.layer-row-selected` styles
- `.layer-eye-toggle`, `.layer-drag-handle` styles
- `.layer-expanded-controls` styles
- Update `.app` layout to flex row (sidebar + viewport)

### Verification
- Layer panel shows all datasets
- Eye toggle hides/shows individual layers
- Per-layer contrast/gamma adjustments work independently
- Opacity slider blends layers correctly
- "Add Layer" opens picker and adds dataset
- "Remove" deletes dataset (with confirmation) — all clients see removal
- Selected layer has visual indicator

---

## Part 6: Layer Presence Sync and Follow Mode

**Goal:** Broadcast layer arrangement via presence so follow mode syncs layer settings. Split into separate message from camera presence for efficiency.

### Files to modify

**`lucida-core/src/protocol.rs`**
- Add to `ClientMessage`:
  ```rust
  LayerPresence {
      layer_order: Vec<String>,
      layer_settings: HashMap<String, LayerDisplaySettings>,
  }
  ```
- Add to `ServerMessage`:
  ```rust
  LayerPresenceUpdate {
      client_id: ClientId,
      layer_order: Vec<String>,
      layer_settings: HashMap<String, LayerDisplaySettings>,
  }
  ```
- Add `layer_order` and `layer_settings` to `PresenceState` with `#[serde(default)]` (included in snapshots)

**`lucida-server/src/session.rs`**
- Store per-client `layer_order: Vec<String>` and `layer_settings: HashMap<String, LayerDisplaySettings>`
- Add `update_layer_presence()` method
- Include in snapshot

**`lucida-server/src/main.rs`**
- Handle `LayerPresence` message: store + broadcast as `LayerPresenceUpdate`
- Add to `BroadcastItem` enum

**`lucida-web/src/bridge.ts`**
- Add `sendLayerPresence(json: string)` with separate throttle (~200ms)
- Handle `layer_presence_update` in message handler
- Add `onLayerPresenceUpdate` callback

**`lucida-web/src/App.tsx`**
- On layer order/settings change: call `bridge.sendLayerPresence(scene.export_layer_presence())`
- On follow mode + receiving `LayerPresenceUpdate` from leader: call `scene.import_layer_presence(json)`, update React state
- Editing layer settings while following: break follow (consistent with existing camera behavior)

### Verification
- Two browser tabs connected to same server
- Tab A adds two datasets, reorders, adjusts opacity/contrast
- Tab B follows Tab A: sees same layer arrangement
- Tab B adjusts a layer setting: follow breaks
- Disconnect/reconnect: snapshot includes layer presence
- Tab A changes settings: Tab B (following) syncs within ~200ms

---

## Implementation Order and Dependencies

```
Part 1 (Display Settings Model)  ←  no dependencies, start here
    ↓
Part 2 (Corner-Aligned Transform)  ←  independent of Part 1, can be parallel
    ↓
Part 3 (Multi-Dataset Chunk Loading)  ←  needs Part 1 for layer state
    ↓
Part 4 (Multi-Pass Rendering)  ←  needs Parts 1, 2, 3
    ↓
Part 5 (Layer Panel UI)  ←  needs Part 4 for visual feedback
    ↓
Part 6 (Presence Sync)  ←  needs Parts 1, 5
```

Parts 1 and 2 can be done in parallel. Each subsequent part leaves the app in a working state.

## Risk Areas

- **GPU memory:** Multiple 3D textures can exhaust VRAM. The 8GB LRU budget needs to be shared across datasets (not per-dataset). Consider a global byte counter.
- **Shader alpha output (Part 4):** Current shader bakes in a background color and returns alpha=1.0. Changing to premultiplied alpha output requires the compositor to supply the background. Single-layer rendering must still look correct.
- **Existing `Layer` naming:** The existing `Layer` type (image pyramid) and the new "layer" concept (compositing stack entry) share a name. The code uses `LayerDisplaySettings` for the new concept to avoid ambiguity, but documentation should be clear.
