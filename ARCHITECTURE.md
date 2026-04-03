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
cache on main thread → plan message to worker → worker requests
missing chunks → main fulfills from cache → worker uploads to atlas →
shader samples atlas (or fallback) → pixels
```

---

## 1. Scene State (WASM)

The WASM scene is the single source of truth for viewer state. TypeScript never reimplements camera math, LOD selection, or chunk planning — it calls into WASM.

**Owns:** Camera (slice/arcball/fly), viewport, Z/T/C indices, dataset list, layer settings, volume transforms.

**Key calls from TypeScript:**
- `scene.apply_command(json)` — pan, zoom, set_z, add_dataset, etc.
- `scene.chunk_plan_for(dsId)` — returns which chunks are needed at the current camera/viewport
- `scene.ray_hit_local(dsId)` / `scene.ray_hit_local_image(dsId)` — where the camera ray hits the volume (unit space / image space)
- `scene.set_viewport(w, h)` — tells WASM the canvas size for LOD selection
- `scene.all_dataset_settings()` — contrast, gamma, opacity, blend mode per dataset

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

**Files:** `zarr/chunkPlan.ts`, `tickCommon.ts`, plan phase in `volumePath.ts` / `slicePath.ts`

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
- `dirty` flag — gates whether a tick does work
- `rafId` — pending `requestAnimationFrame` handle (null when quiesced)
- Subscriptions to each dataset's `SharedChunkQueue`
- `handleChunkDataRequest` — fulfills worker requests from cache

**How a tick works:**
1. `scheduleIfNeeded()` — only schedules RAF if `dirty && rafId === null`
2. `tick()` — clears `rafId`, checks dirty, runs mode-specific tick, runs minimap tick
3. Mode tick calls `planAndFetch[Volume|Slice]()` then `uploadAndRender[Volume|Slice]()`
4. Plan phase: evaluates WASM chunk plan, submits to fetch queue, sends plan message to worker
5. Upload phase: streams seed chunks to fallback texture, sends plan to worker, builds render params, dispatches render
6. If minimap budget exhausted → `dirty=true` → another frame

**Event-driven re-scheduling (no polling):**
- Chunk arrives from network → subscriber → `dirty=true` + `scheduleIfNeeded()`
- User interaction → `markDirty()`
- Worker request fulfilled but budget exhausted → `dirty=true` + `scheduleIfNeeded()`
- When none of these fire → loop quiesces (0 CPU)

**If you're changing this:**
- Never return `true` from tick functions to indicate "chunks are still fetching from network." The subscriber handles that. Only return `true` if there's work that can be done NOW but wasn't (budget exhaustion).
- The `handleChunkDataRequest` callback applies `UPLOAD_BUDGET_BYTES` (4 MB) per invocation. If budget is exceeded, it marks dirty for the next frame.
- The VolumeViewer component has a separate RAF loop for clip-distance key polling — this is independent of the render loop.

**Files:** `renderLoop.ts`, `renderLoopTypes.ts`, `volumePath.ts`, `slicePath.ts`, `minimapPath.ts`

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

## 6. Worker Protocol & Request-Based Upload

The main thread and GPU worker communicate via `postMessage`. The worker owns the atlas and drives chunk requests.

**The request-based flow:**
```
Main → Worker:  ChunkPlan (needed list + available keys)
Worker → Main:  ChunkDataRequest (keys the worker is missing)
Main → Worker:  ChunkData (ArrayBuffer transfers, within budget)
```

**Why request-based:** The worker is the sole authority on atlas contents. The main thread doesn't track what the worker has — it sends the plan, and the worker requests what it needs. This eliminates the class of bugs where a main-thread tracking set diverges from the actual atlas.

**Message types:**

| Direction | Message | Purpose |
|-----------|---------|---------|
| Main → Worker | `volumeChunkPlan` / `sliceChunkPlan` | Tell worker what's needed and what's in cache |
| Worker → Main | `chunkDataRequest` | Worker requests specific chunks it's missing |
| Main → Worker | `volumeChunkData` / `sliceChunkData` | Fulfill request with ArrayBuffer transfers |
| Main → Worker | `volumeWriteFallbackChunk` / `sliceWriteFallbackChunk` | Incremental seed/fallback writes |
| Main → Worker | `volumeRenderMultiPass` / `sliceRenderMultiPass` | Dispatch render with layer params |
| Worker → Main | `intensityRange` | Sampled min/max for auto-contrast |

**If you're changing this:**
- ArrayBuffers are transferred (zero-copy), not copied. The sender loses access after `postMessage`.
- The `chunkDataRequest` echoes back all metadata from the plan message (level, dims, hitLocal) so the fulfillment handler doesn't need to store intermediate state.
- `postMessage` to a worker is FIFO. Plan → request → data arrives in order. No races.
- The upload budget (4 MB/frame) is applied when fulfilling requests in `handleChunkDataRequest`, not when sending plans.

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
4. Update indirection: `indirectionData[gridIdx] = slotIndex`
5. Flush indirection buffer to GPU before each render

**Atlas recreation:** Destroyed and recreated when level, T, C, or chunk dimensions change. This happens in `handleChunkPlan` when the incoming metadata doesn't match the current atlas.

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

**If you're changing this:**
- The volume shader flips Y when sampling: `(1.0 - pos.y)`. This converts from model space (Y-up) to texture storage (Y-down). See [Coordinate Conventions](#coordinate-conventions).
- `sampleVolume` returns `0xFFFFFFFFu` (impossible for real u16 data) for unloaded chunks. This is distinct from `0u` (genuine zero voxel).
- Adaptive step size: `max(stepSize, rayLen / 512.0)`. Capped at 512 steps for translucent, 256 for MIP.

**Files:** `renderer/volume.wgsl`, `renderer/slice.wgsl`, `renderer/compositor.wgsl`

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
│  User Input                                         │
│    │                                                │
│    ▼                                                │
│  WASM Scene ──── chunk_plan_for() ──► Chunk Plan    │
│    │                                     │          │
│    │                              ┌──────┘          │
│    │                              ▼                  │
│    │                     SharedChunkQueue             │
│    │                      ├─ ensureFetched()         │
│    │                      ├─ fetch workers (×12)     │
│    │                      ├─ decompress (LZ4/Zstd)  │
│    │                      ├─ cache                   │
│    │                      └─ subscriber → dirty      │
│    │                                                 │
│    ▼                                                 │
│  Render Loop tick()                                  │
│    ├─ planAndFetch() → submit fetches               │
│    ├─ uploadAndRender()                              │
│    │   ├─ stream seed → fallback chunk messages     │
│    │   ├─ send ChunkPlan to worker ─────────────┐   │
│    │   └─ send RenderMultiPass to worker ───┐   │   │
│    └─ tickMinimap()                         │   │   │
│                                             │   │   │
│  handleChunkDataRequest() ◄─────────────┐   │   │   │
│    ├─ look up cache                     │   │   │   │
│    ├─ bufferToUint16                    │   │   │   │
│    └─ send ChunkData to worker ─────┐  │   │   │   │
│                                     │  │   │   │   │
├─────────── postMessage ─────────────┼──┼───┼───┼───┤
│                                     │  │   │   │   │
│  ┌────────── GPU WORKER ────────────┼──┼───┼───┼─┐ │
│  │                                  ▼  │   ▼   ▼ │ │
│  │  handleChunkPlan()               │  │         │ │
│  │    ├─ create/recreate atlas      │  │         │ │
│  │    ├─ diff needed vs atlas       │  │         │ │
│  │    └─ post ChunkDataRequest ─────┘  │         │ │
│  │                                     │         │ │
│  │  handleChunkData() ◄───────────────-┘         │ │
│  │    ├─ allocate slot (or evict farthest)       │ │
│  │    ├─ writeTexture to atlas                   │ │
│  │    └─ update indirection buffer               │ │
│  │                                               │ │
│  │  handleRenderMultiPass() ◄────────────────────┘ │
│  │    ├─ bind atlas + fallback + indirection       │
│  │    ├─ render each layer to offscreen            │
│  │    ├─ composite layers → canvas                 │
│  │    └─ render peer cursors                       │
│  │              │                                  │
│  └──────────────┼──────────────────────────────────┘
│                 ▼
│            Pixels on screen
└─────────────────────────────────────────────────────┘
```
