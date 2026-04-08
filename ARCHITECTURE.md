# lucida-web Architecture

How the web rendering pipeline works, organized by system. Each section is self-contained — read the one relevant to what you're changing.

Check the [GLOSSARY.md](../GLOSSARY.md) for terminology.

## Overview

Three threads cooperate to get pixels on screen:

| Thread | Owns | Never touches |
|--------|------|---------------|
| **Main (React)** | WASM scene state, chunk cache, fetch queue, dirty flag | GPU textures |
| **GPU Worker** | Atlas textures, indirection buffers, shaders, compositing | WASM scene, network |
| **LZ4 Workers (pool of 4)** | Decompression | Everything else |

The high-level flow:

```
User action → WASM scene update → chunk plan → fetch from server →
cache on main thread → push chunks directly to worker → worker uploads
to atlas → render command → shader samples atlas (or fallback) → pixels
```

---

## 1. Scene State (WASM)

The WASM scene is the single source of truth for viewer state. TypeScript never reimplements camera math, LOD selection, or chunk planning — it calls into WASM.

**Owns:** Camera (slice/arcball/fly), viewport, Z/T/C indices, multi-channel toggle, dataset list, layer settings (including per-channel settings and colormaps), volume transforms.

**Key calls from TypeScript:**
- `scene.apply_command(json)` — pan, zoom, set_z, set_multi_channel, set_channel_colormap, add_dataset, etc.
- `scene.chunk_plan_for(dsId)` — returns which chunks are needed at the current camera/viewport
- `scene.ray_hit_local(dsId)` / `scene.ray_hit_local_image(dsId)` — where the camera ray hits the volume (unit space / image space)
- `scene.set_viewport(w, h)` — tells WASM the canvas size for LOD selection
- `scene.all_dataset_settings()` — contrast, gamma, opacity, blend mode, channel_settings, channel_blend_mode per dataset
- `scene.multi_channel()` / `scene.set_c(c)` — multi-channel mode flag and channel setter (used by pipeline to iterate channels)

**If you're changing this:**
- Viewport commands (pan, zoom) are local-only. Document commands (add/remove dataset) go through the server for broadcast.
- Volume mode sets viewport to full device-pixel resolution (not renderScale) to prevent LOD flip-flop during interaction.
- `ray_hit_local()` returns unit-space coords (Y-up). Use `ray_hit_local_image()` for image-space (Y-down). See [Coordinate Conventions](#coordinate-conventions).

**Files:** `lucida-core/src/` (Rust), `applyAndSend.ts` (TS bridge)

---

## 2. Chunk Planning

Determines which chunks are needed, at what LOD, in what order.

**Owns:** Nothing persistent — runs fresh each tick.

**How it works:**
1. `scene.chunk_plan_for(dsId)` returns `MemberChunkPlan[]` — one per visible dataset member
2. Each plan has `needed[]` (chunks at target LOD, sorted nearest-first) and `prefetch[]` (neighbors for smooth panning)
3. Seed coords (coarsest level) are prepended for fallback priority
4. Per-member fetch lists are interleaved round-robin for spatial fairness across plate FOVs

**If you're changing this:**
- The WASM planner sorts `needed` by distance from `sort_center` in voxel space. This order is used by both the fetch queue (nearest fetched first) and the worker (nearest uploaded first).
- `evaluateAndSortPlans()` sorts *members* by 2D distance from the camera. `interleaveFetchLists()` merges member lists round-robin so spatially-closer members get priority at each depth level.
- Seed computation triggers on first render AND on T/C/Z change (not just change). See [Fallback System](#5-fallback--seed-system).

**Files:** `zarr/chunkPlan.ts`, `tickCommon.ts` (`planAndFetchForDatasets` shared skeleton + `PlanFetchActions` callback interface), `volumePath.ts` / `slicePath.ts` (thin wrappers providing mode-specific closures)

---

## 3. Chunk Fetching

Gets compressed chunk data from the server, decompresses, and caches it.

**Owns:** `SharedChunkQueue` — one per dataset, shared across all members. Contains:
- `cache`: `Map<memberId, Map<chunkKey, ArrayBuffer>>` — LRU-evicted at 512 MB (`MAX_CACHE_BYTES`), touched on `get()` only
- `inFlight` / `activeFetches` — tracking in-progress fetches
- `pendingQueue` — priority-ordered fetch queue
- Subscriber list — notified on cache changes via `bumpVersion()`

**How it works:**
1. `ensureFetched(coords[])` accepts a priority-sorted list of chunk coords
2. Filters to uncached chunks, decides abort-and-restart vs. incremental-add
3. Up to `MAX_CONCURRENT=12` fetch workers run in parallel
4. Each worker: pops from queue → calls `remoteFetcher(coord, signal)` → decompresses → stores in cache
5. `bumpVersion()` fires a `setTimeout` to coalesce rapid arrivals, then notifies all subscribers

**If you're changing this:**
- The abort decision uses a 15-second staleness threshold. If the in-flight set has zero overlap with the new request and >15s has elapsed, all fetches are aborted.
- `bumpVersion()` uses `setTimeout` (not microtask) to coalesce. Multiple chunks arriving in the same event loop turn produce one notification.
- The render loop subscribes in `start()` — the callback sets `dirty=true` and calls `scheduleIfNeeded()`.

**Files:** `zarr/chunkStore.ts`, `hooks/useBridge.ts` (remoteFetcher), `zarr/lz4Client.ts` (decompression pool)

---

## 4. Render Loop

Orchestrates the per-frame tick: planning, fetching, sending plans to the worker, fulfilling worker requests, and dispatching render commands.

**Owns:** `RenderLoop` instance with:
- `viewDirty` / `dataDirty` flags — typed dirty flags that determine tick behavior
- `lastDataRenderTime` — debounce timer for data-triggered renders (`DATA_RENDER_INTERVAL_MS`)
- `rafId` — pending `requestAnimationFrame` handle (null when quiesced)
- Subscriptions to each dataset's `SharedChunkQueue`

**How a tick works:**
1. `scheduleIfNeeded()` — only schedules RAF if `(viewDirty || dataDirty) && rafId === null`
2. `tick()` — determines `shouldRender`: viewDirty → immediate; dataDirty → only if debounce elapsed
3. Mode tick ALWAYS runs (drives chunk uploads), but the expensive render pass only executes when `shouldRender` is true
4. Plan phase: evaluates WASM chunk plan (cached per dataset), submits to fetch queue
5. Upload phase: sends atlas config on LOD/T/C change, pushes available chunks directly to worker, streams seed chunks, builds render params if `shouldRender`
6. Minimap: skipped entirely when stationary (render key unchanged); if overview budget exhausted → `dataDirty=true`

**Event-driven re-scheduling (no polling):**
- Chunk arrives from network → subscriber → `dataDirty=true` + `scheduleIfNeeded()`
- User interaction → `markViewDirty()` (camera, contrast, visibility, resize)
- Auto-contrast update → `markDataDirty()` (intensity range from GPU worker)
- When neither flag is set → loop quiesces (0 CPU)

**Multi-channel mode:** When `scene.multi_channel()` is true, the plan phase iterates all visible channels (from `channel_settings[ch].visible`), temporarily setting `scene.set_c(ch)` for each to evaluate per-channel chunk plans. Each (member, channel) pair gets a composite key `${memberId}:ch${channel}` for independent atlas, sentToWorker, and plan cache tracking. The render phase emits one layer per (member, channel) with per-channel colormap, contrast, and gamma. Channels within a dataset use `channel_blend_mode`; datasets use their inter-dataset `blend_mode`.

**If you're changing this:**
- Never return `true` from tick functions to indicate "chunks are still fetching from network." The subscriber handles that. Only return `true` if there's work that can be done NOW but wasn't (minimap budget exhaustion).
- The tick always runs plan+upload when dirty (to keep chunk pipeline flowing), but only renders when `shouldRender` is true. This prevents expensive ray marches during rapid chunk arrivals.
- The VolumeViewer component has a separate RAF loop for clip-distance key polling — this is independent of the render loop.
- In multi-channel mode, fetch lists use raw member IDs (chunk store fetchers are keyed by raw ID). Composite keys are only used for state tracking (atlas, sentToWorker, plan cache).

**Files:** `renderLoop.ts`, `renderLoopTypes.ts`, `tickCommon.ts` (shared plan+fetch + upload helpers, multi-channel iteration), `uploadCommon.ts` (shared upload loop), `volumePath.ts`, `slicePath.ts`, `minimapPath.ts`

---

## 5. Fallback / Seed System

Ensures every pixel always has something to display — no black regions. The coarsest multiscale level is loaded first and used as a fallback while fine chunks stream in.

**Owns:** Fallback textures on the GPU worker (one per member, keyed by `tczKey` / `tcKey` generation string).

**How it works:**
1. On first render or T/C/Z change, seed coords are computed (all chunks at the coarsest level)
2. Seeds are prepended to the fetch list (highest priority — they're tiny and load fast)
3. As each seed chunk arrives in cache, it's sent to the worker via `volumeWriteFallbackChunk` / `sliceWriteFallbackChunk`
4. The worker writes each chunk's region into the fallback texture incrementally (no all-or-nothing gate)
5. On T/C/Z change, the worker compares the incoming `tczKey`/`tcKey` with the stored one — if different, destroys old texture and creates new

**The shader's two-texture model:**
- Indirection lookup → if valid slot: sample atlas (fine data)
- If sentinel `0xFFFFFFFF`: sample fallback texture (coarse data)
- Result: progressive refinement from blurry to sharp, no gaps

**If you're changing this:**
- The `tczKey`/`tcKey` generation string prevents stale fallback data. When T/C/Z changes, the old fallback persists until the first new-generation seed chunk arrives — no gap.
- Seed `sentKeys` tracks which chunks have been sent to the worker this generation. Don't confuse with the atlas's chunk tracking.
- The `usePreUpload` hook sends full-volume fallback data for locally-loaded datasets (bypasses the seed system).

**Files:** seed logic in `volumePath.ts` / `slicePath.ts`, handlers in `volumeHandlers.ts` / `sliceHandlers.ts`, fallback texture maps (`fallbackPerDataset`)

---

## 6. Worker Protocol & Direct Chunk Push

The main thread and GPU worker communicate via `postMessage`. Chunk uploads and renders are independent operations.

**The direct-push flow:**
```
Main → Worker:  AtlasConfig (on LOD/T/C change — recreates atlas)
Main → Worker:  ChunkData (as chunks become available in cache)
Main → Worker:  RenderMultiPass (when shouldRender — uses current atlas)
```

**Why direct-push:** The main thread tracks which chunks have been sent (`sentToWorker` per member, pruned to the current needed set). The worker uploads whatever it receives and manages eviction. No round-trip messaging — chunks flow directly from cache to GPU.

**Message types:**

| Direction | Message | Purpose |
|-----------|---------|---------|
| Main → Worker | `volumeAtlasConfig` / `sliceAtlasConfig` | Recreate atlas on LOD/T/C/chunkShape change |
| Main → Worker | `volumeChunkData` / `sliceChunkData` | Push chunk data with ArrayBuffer transfers |
| Main → Worker | `volumeWriteFallbackChunk` / `sliceWriteFallbackChunk` | Incremental seed/fallback writes |
| Main → Worker | `volumeRenderMultiPass` / `sliceRenderMultiPass` | Dispatch render with layer params |
| Worker → Main | `intensityRange` | Sampled min/max for auto-contrast |

**If you're changing this:**
- ArrayBuffers are transferred (zero-copy), not copied. The sender loses access after `postMessage`.
- `postMessage` to a worker is FIFO. AtlasConfig → ChunkData → RenderMultiPass arrives in order.
- The `sentToWorker` set is pruned to the current needed list on each tick, so chunks that leave the frustum are removed. On data-render ticks (camera stopped), `sentToWorker` is cleared entirely — all cached chunks are re-sent, letting the worker re-evaluate atlas allocation with the current camera position. The worker deduplicates (skips chunks already in atlas).
- Atlas recreation happens both via `atlasConfig` messages and in `handleChunkData` (if the incoming metadata doesn't match the current atlas).

**Files:** `renderer/workerProtocol.ts`, `renderer/renderClient.ts`, `renderer/gpu.worker.ts`

---

## 7. Atlas Management

The GPU worker packs fine-level chunks into a fixed-size texture atlas with an indirection buffer for lookup.

**Owns per dataset:**
- `AtlasState`: GPU texture, indirection buffer + CPU-side copy, slot map, free list
- Volume: 3D texture, 512 MB budget, `chunkDistSq` for 3D eviction
- Slice: 2D texture, 64 MB budget, `chunkDistSq2D` for 2D eviction

**How allocation works:**
1. Worker receives `ChunkData` message with chunk buffers
2. For each chunk not already in atlas:
   - If free slots available: pop from free list
   - If full: compare incoming chunk distance to farthest slot's distance
   - If incoming is closer: evict farthest, use its slot
   - If incoming is farther: skip (don't degrade atlas quality)
3. Write chunk data to atlas texture at slot position
4. Update indirection: `indirectionData[gridIdx] = slotIndex`, set `indirectionDirty = true`
5. Flush indirection buffer to GPU only if `indirectionDirty` (reset after write) — eliminates per-frame GPU writes when stationary

**Atlas recreation:** Destroyed and recreated when level, T, C, or chunk dimensions change. Triggered by `volumeAtlasConfig` / `sliceAtlasConfig` messages, or in `handleChunkData` when the incoming metadata doesn't match the current atlas.

**If you're changing this:**
- The indirection buffer maps chunk grid coordinates to atlas slot indices. Sentinel `0xFFFFFFFF` means "not loaded — use fallback."
- Eviction uses `continue` (skip this chunk) not `break` (stop processing), because the main thread's sort order (voxel space) may not exactly match the worker's distance metric (normalized [0,1] space).
- The atlas is per `datasetId` which is actually per `memberId` for plates. Each FOV gets its own atlas.
- `rayHitPerDataset` stores the camera's ray-volume intersection point in image space (Y-down). This is used for eviction distance. See [Coordinate Conventions](#coordinate-conventions).

**Files:** `renderer/volumeHandlers.ts`, `renderer/sliceHandlers.ts`, `renderer/gpuContext.ts` (texture creation/writing)

---

## 8. Shaders

Two WGSL shaders render the visible data using the atlas + fallback two-texture model.

**Volume shader** (`volume.wgsl`): Ray marches through the volume in local [0,1]³ space.
- `sampleVolume(texCoord)` → looks up indirection → samples atlas or returns sentinel
- If sentinel (`0xFFFFFFFFu`): try fallback texture. If no fallback: skip sample.
- If genuine zero value (`0u`): skip sample (transparent).
- Supports translucent (front-to-back compositing) and MIP (max intensity projection) modes.
- Writes depth at first significant sample for cursor occlusion.

**Slice shader** (`slice.wgsl`): Full-screen triangle with texture lookup.
- Maps screen UV → texture UV via transform matrix
- Indirection lookup → atlas or fallback
- Draws 1.5px member border at UV edges for plate grid visualization

**Colormap LUT:** Both shaders apply a colormap via a 256×1 `rgba8unorm` LUT texture (binding 4) and linear sampler (binding 5). After normalization, `textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb` replaces the old `vec3f(normalized)` grayscale output. LUT textures are cached per colormap name on the worker. Gray LUT produces identical output to the previous grayscale behavior.

**If you're changing this:**
- The volume shader flips Y when sampling: `(1.0 - pos.y)`. This converts from model space (Y-up) to texture storage (Y-down). See [Coordinate Conventions](#coordinate-conventions).
- `sampleVolume` returns `0xFFFFFFFFu` (impossible for real u16 data) for unloaded chunks. This is distinct from `0u` (genuine zero voxel).
- Adaptive step size: `max(stepSize, rayLen / 512.0)`. Capped at 512 steps for translucent, 256 for MIP.
- Colormap data is generated in `colormaps.ts` (15 built-in maps). The worker caches GPU textures in a `Map<string, GPUTexture>`. To add a new colormap, add it to `colormaps.ts` and the `Colormap` enum in Rust.

**Files:** `renderer/volume.wgsl`, `renderer/slice.wgsl`, `renderer/compositor.wgsl`, `colormaps.ts`

---

## 9. Minimap

A small overview volume rendered on a separate OffscreenCanvas showing the full dataset at the coarsest level.

**Owns:** `MinimapState` with overview textures per member, overlay callback.

**Two layers:**
- **GPU minimap**: Coarsest-level chunks uploaded to a separate volume renderer on its own canvas. Has its own upload budget (2 MB/frame).
- **2D overlay**: Drawn on a separate HTML canvas on top. Shows bounding boxes, axis arrows, view rectangle (slice mode), frustum + slice plane (volume mode).

**If you're changing this:**
- The minimap camera tracks the main camera's theta/phi but uses a fixed orthographic-like view at distance 1.8.
- Overview seeding is separate from view seeding. `markMinimapOverviewSeeded()` is called when overview data was bulk-loaded (e.g., from `usePreUpload`).
- `tickMinimapOverview` returns `true` only when budget is exhausted (chunks available but couldn't upload this frame), not when waiting on network fetches.

**Files:** `minimapPath.ts`, `components/minimapOverlay.ts`, `components/minimapMath.ts`, `renderer/minimapHandlers.ts`

---

## 10. Peer Cursors

WebGPU-rendered cursors showing where other connected users are pointing.

**Owns:** `CursorRenderer` on the GPU worker, HTML overlay labels on the main thread.

**How it works:**
- Cursor positions are sent as presence updates over WebSocket (throttled at 50ms)
- The Rust `cursor.rs` module computes GPU-ready geometry from peer presence data
- In 2D: crosshair at voxel coordinates
- In 3D: billboard ray through the volume with a marker at the intersection point
- Depth-tested against the volume's depth texture for occlusion

**If you're changing this:**
- Cross-mode cursors are supported (2D peer shows as a ray in a 3D view, and vice versa)
- Defaulted cursors (peer's mouse off canvas) show a dot + name pill at the peer's view center
- Dimensional indicators (Z arrows, T arrows, channel number) show when the peer is viewing a different slice/time/channel

**Files:** `components/PeerCursors.tsx`, `renderer/cursors.wgsl`, `renderer/cursorRenderer.ts`, `lucida-core/src/cursor.rs`

---

## 11. Plate Datasets

A plate is an OME-Zarr 0.5 container representing a multi-well experiment (e.g. a physical microplate in high-content screening). It renders as a seamless spatial mosaic the user pans across. A plate is a `Dataset` with `kind: DatasetKind::Plate` — every well/FOV becomes a `DatasetMember` that flows through the normal chunk pipeline.

**Owns:** Plate structure (rows, columns, wells, FOVs), FOV positions, `store_prefix` routing.

**How plate loading works:**
1. Server receives `OpenRemoteDataset` for a plate URL
2. `read_dataset_info()` reads the root `zarr.json`, detects `attributes.ome.plate`
3. `read_plate_info_from_root()` parses the plate hierarchy:
   - Rows, columns, wells from the plate metadata
   - For each well: reads `{well_path}/zarr.json` to discover FOVs
   - Extracts optional stage translation coordinates per FOV
   - Picks the **first FOV as representative** for multiscales metadata (shape, chunks, scales, codecs)
4. `compute_fov_positions()` assigns pixel-space `[X, Y]` to every FOV:
   - **Grid mode**: Uniform layout. `WELL_GAP_FRACTION` (20%) between wells, `FIELD_GAP_FRACTION` (8%) between FOVs within a well
   - **Stage mode**: Uses `coordinateTransformations.translation` from OME metadata, normalized to origin. Falls back to grid if absent
5. `PlateInfo::into_dataset_metadata()` builds:
   - `Dataset.kind = DatasetKind::Plate { rows, columns, wells, positioning_mode, has_stage_positions }`
   - `Dataset.members`: one `DatasetMember` per FOV, each with `store_prefix` (e.g. `"A/1/0"`) and computed position
   - `Dataset.volume_shape`: full plate extent `[Z, H, W]` via `plate::plate_extent()`
6. Server wraps the store in a 512 MB LRU cache, broadcasts `AddDataset` to all clients

**Chunk routing via `store_prefix`:**
- Each FOV has a unique `store_prefix` (e.g. `"A/1/0"` = well A, column 1, FOV 0)
- Client includes `store_prefix` in every `ChunkRequest`
- Server prepends it to the chunk path: `"A/1/0" + "/" + "0/c/1/2/3"` → reads `"A/1/0/0/c/1/2/3"` from the store
- Response uses a composite key (`plate1/A/1/0/0/c/1/2/3`) so the client cache distinguishes FOVs

**How plates interact with the rest of the pipeline:**
- **Chunk planning** (§2): `chunk_plan_for()` returns `MemberChunkPlan[]` — one per visible FOV. AABB culling skips off-screen FOVs.
- **Fetching** (§3): Per-member fetch lists are interleaved round-robin for spatial fairness.
- **Atlas** (§7): Each FOV (`memberId`) gets its own atlas — the atlas key is `memberId`, not `datasetId`.
- **Shaders** (§8): Slice shader draws 1.5px borders at UV edges for plate grid visualization.

**UI: PlateSelector** (2D mode only):
- Renders a well grid overlay. Clicking a well pans the camera to its center.
- If `has_stage_positions`, a toggle switches between Grid and Stage positioning modes.

**If you're changing this:**
- All FOVs in a plate share the same multiscales metadata (shape, chunks, codecs) — read from the representative FOV. If FOVs ever have heterogeneous shapes, this assumption breaks.
- Positioning mode is togglable at runtime. The toggle sends a command that recomputes positions and re-broadcasts the dataset.
- `store_prefix` is the routing key that makes plates work end-to-end. Every component that touches chunk identity (cache keys, fetch dedup, atlas keying, `sentToWorker` tracking) must include it.

**Files:** `lucida-store/src/metadata.rs` (plate discovery + `PlateInfo`), `lucida-core/src/plate.rs` (position computation), `lucida-core/src/scene/types.rs` (`DatasetKind::Plate`, `PlateWell`, `PlateFov`, `DatasetMember`), `lucida-server/src/handler.rs` (chunk routing), `lucida-web/src/components/PlateSelector.tsx` (UI), `lucida-web/src/hooks/useBridge.ts` (client-side `store_prefix` in requests)

---

## Coordinate Conventions

Two Y conventions exist. Bugs happen at the boundary between them.

| Convention | Y direction | Used by |
|------------|-------------|---------|
| **Unit space** (Y-up) | Y=0 bottom, Y=1 top | Model matrix, ray marching, `ray_hit_local()` |
| **Image space** (Y-down) | Y=0 top, Y=1 bottom | Chunk grid indices, voxel arrays, `sort_center`, atlas eviction, `ray_hit_local_image()` |

**Where flips happen:**
- `volume.wgsl`: `(1.0 - pos.y)` when converting ray position to texel coordinate
- `camera.rs`: `(1.0 - hit_unit[1]) * shape_y` when computing sort_center and visible region
- `volumePath.ts`: calls `ray_hit_local_image()` which returns image-space coords directly

**Rules:**
- Use `ray_hit_local_image()` (Rust) or `flipY()` (TypeScript) at convention boundaries
- Never use inline `1.0 - y` — use the named helpers for grepability
- When in doubt, check which space the consumer expects. Chunk grid indices and atlas eviction use image space. Shaders and model matrices use unit space.

**Files:** `tickCommon.ts` (`flipY` helper), `lucida-core/src/wasm.rs` (`ray_hit_local_image`)

---

## Data Flow Diagram

For reference, the complete end-to-end flow:

```
┌─────────────────── MAIN THREAD ───────────────────┐
│                                                     │
│  User Input → markViewDirty()                       │
│    │                                                │
│    ▼                                                │
│  WASM Scene ──── chunk_plan_for() ──► Chunk Plan    │
│    │                  (cached)            │          │
│    │                              ┌──────┘          │
│    │                              ▼                  │
│    │                     SharedChunkQueue             │
│    │                      ├─ ensureFetched()         │
│    │                      ├─ fetch workers (×12)     │
│    │                      ├─ decompress (LZ4/Zstd)  │
│    │                      ├─ cache                   │
│    │                      └─ subscriber → dataDirty  │
│    │                                                 │
│    ▼                                                 │
│  Render Loop tick()                                  │
│    ├─ viewDirty? → shouldRender=true (immediate)    │
│    ├─ dataDirty? → shouldRender if debounce elapsed │
│    ├─ planAndFetch() → submit fetches               │
│    ├─ uploadAndRender()                              │
│    │   ├─ send AtlasConfig on LOD/T/C change ──┐   │
│    │   ├─ push ChunkData directly ──────────────┤   │
│    │   ├─ stream seed → fallback chunks ────────┤   │
│    │   └─ if shouldRender: RenderMultiPass ─────┤   │
│    └─ tickMinimap() (skipped if stationary)     │   │
│                                                 │   │
├─────────── postMessage ─────────────────────────┤   │
│                                                 │   │
│  ┌────────── GPU WORKER ────────────────────────┤─┐ │
│  │                                              ▼ │ │
│  │  handleAtlasConfig()                           │ │
│  │    └─ recreate atlas for new LOD/T/C           │ │
│  │                                                │ │
│  │  handleChunkData()                             │ │
│  │    ├─ allocate slot (or evict farthest)        │ │
│  │    ├─ writeTexture to atlas                    │ │
│  │    └─ update indirection (indirectionDirty)    │ │
│  │                                                │ │
│  │  handleRenderMultiPass()                       │ │
│  │    ├─ flush indirection only if dirty          │ │
│  │    ├─ bind atlas + fallback + indirection      │ │
│  │    ├─ render each layer to offscreen           │ │
│  │    ├─ composite layers → canvas                │ │
│  │    └─ render peer cursors                      │ │
│  │              │                                 │ │
│  └──────────────┼─────────────────────────────────┘ │
│                 ▼                                    │
│            Pixels on screen                          │
└──────────────────────────────────────────────────────┘
```
