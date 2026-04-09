# Lucida
A fast, lightweight, collaborative 5D image viewer.

Check the GLOSSARY.md for terminology.

## Parts
- **lucida-core** decides what should be shown.
- **lucida-web** decides how the user interacts with it.
- **The renderer** decides how pixels get drawn.
- **lucida-store** decides where data comes from.
- **lucida-server** keeps all clients in sync.
- **lucida-py** and **lucida-cli** are just other ways to drive the same viewer model.

## lucida-core in Rust
The "viewer brain."

This is the heart of the system. It should contain all the logic that is independent of UI, browser APIs, Python, or storage backends.

Its job is to represent the viewer state and answer questions like:
- What datasets are open, and where are they in world space?
- What dimensions exist? (t, c, z, y, x)
- What is the current camera position and zoom?
- Which slice is selected for non-displayed dimensions?
- Which multiscale level should be used for each volume right now?
- Which volumes intersect the current view frustum?
- Which chunks across all visible volumes should be resident in the shared atlas pool?
- Which neighboring chunks should be prefetched?
- In what order should chunk requests be prioritized given a shared budget?

Concretely, it should define the core data structures:
- **Scene**: the local composite — camera, view, display, and document state. Each client holds a full Scene because chunk planning needs all of it together.
- **DocumentState**: the shared portion of a Scene — datasets, layers, transforms. This is what the server owns and syncs.
- **Camera**: center, zoom, viewport size, rotation if you want it.
- **ViewState**: selected indices for z, t, c, and any other dimensions.
- **DisplayState**: contrast window and gamma. Per-client, not part of the shared document.
- **Layer**: image layer, labels layer, points layer later if you want.
- **Command**: pan, zoom, set_slice, open_dataset, set_layer_visibility, and so on. Commands are classified as document commands (synced) or viewport commands (local-only).
- **ChunkRequestPlan**: a single priority-ordered list of chunks across all visible volumes and LOD levels, plus prefetch candidates. Priority accounts for LOD level (seed first), distance from camera, screen coverage, and temporal proximity. This plan drives both fetching and atlas eviction.

It should also contain deterministic algorithms:
- multiscale level selection (per volume, based on distance/screen coverage)
- frustum culling — which volumes are visible
- visible chunk planning across all visible volumes against a shared atlas budget
- cache key generation
- coordinate transforms between world space, image space, and screen space
- serialization of commands and state snapshots

What it should not do:
- read files directly
- make network calls
- render pixels
- depend on React or browser APIs

That separation matters because you want the exact same logic reused by:
- the browser app
- the CLI
- the Python API
- possibly desktop later

## lucida-web in React/TypeScript
The "control panel."

This is the application shell that the user actually interacts with in the browser.

Its job is to provide:
- panels and controls
- file open UI
- layer list
- dimension sliders
- zoom/pan interaction
- keyboard shortcuts
- status indicators
- error messages
- connection between user actions and lucida-core

It should be relatively thin. It should not contain custom logic for chunk planning or multiscale selection if that logic already exists in lucida-core.

Typical flow:
1. User drags the mouse.
1. lucida-web converts that into a viewport command like pan(dx, dy).
1. It applies the command to the local lucida-core Scene.
1. It emits the new camera/view/display as a presence update (throttled, ephemeral).
1. lucida-core returns updated state plus a new chunk request plan.
1. lucida-web forwards that plan to the data/renderer pipeline.

For document commands (adding a dataset, changing volume scale):
1. The command is applied locally and sent to lucida-server for sequenced broadcast.
1. Other clients receive and apply it.

So lucida-web is mostly responsible for:
- app state wiring
- event handling
- UI rendering
- orchestration between core, store, and renderer
- frame-rate coalescing of chunk uploads and render requests
- chunk lifecycle orchestration: evaluating chunk plans from lucida-core across all visible volumes, submitting fetch requests, and forwarding cached chunks to the renderer's shared atlas pool with upload budgets and spatial priority

What it should not do:
- decode chunk data itself unless absolutely necessary
- decide chunk visibility rules independently
- implement a second copy of the viewer logic

## Worker-based web renderer: OffscreenCanvas + WebGPU
The "GPU paint engine."

This is the rendering engine. Its job is to turn loaded image chunks into pixels on screen efficiently.

Running it in a worker is important because rendering, texture upload, chunk compositing, and some decode work can otherwise block the main browser thread and make the UI feel sluggish.

What it should do:
- receive the current scene/view state
- receive decoded chunk payloads or GPU-ready textures
- upload textures to GPU
- draw only the visible area
- composite channels and volumes within the shader, not between passes
- apply per-channel contrast/colormap/gamma
- handle smooth panning and zooming

Why OffscreenCanvas:
- it lets rendering happen off the main thread
- the main React app stays responsive

Why WebGPU:
- modern GPU API
- better long-term fit than WebGL for compute-heavy or large-image workflows
- easier path to shader-based image operations later

Responsibilities inside the renderer usually include:
- virtual texture cache management
- texture upload and draw execution
- frustum culling to determine which volumes participate in a frame
- view transform application
- possibly partial redraw strategies

### Virtual texturing for volume data

The renderer is built on **virtual texturing** (also known as sparse virtual textures / megatextures). The total volume data across all datasets, channels, and LOD levels is far larger than GPU memory. Only the pages needed for the current view are resident in a physical texture cache on the GPU. A page table maps logical coordinates to physical cache locations, and the shader samples through this indirection transparently.

In our domain, the standard virtual texturing concepts map as follows:

| Virtual texturing | Lucida |
|---|---|
| Virtual texture | All volume data across all datasets, channels, and LOD levels |
| Page / tile | Zarr chunk |
| Physical texture cache | Atlas pool (small set of large 3D GPU textures) |
| Page table | Indirection buffer (GPU storage buffer) |
| Residency analysis | Chunk plan from lucida-core |
| Page streaming | Chunk fetch + upload with per-frame byte budget |
| Eviction policy | Priority-based, driven by the chunk plan |

### Rendering model: 2D slicing vs 3D volume

The renderer has two distinct paths with different trade-offs.

**2D slice rendering** is straightforward texture sampling — each visible chunk is a region of a 2D texture, drawn as a quad. Multi-channel compositing can happen via blending between draw calls or within the shader. The cost is proportional to visible chunks, and there is no ray marching.

**3D volume rendering** is the more demanding path and the one where architectural choices matter most. The core principle:

> **One ray march per pixel, compositing all locally-relevant volumes and channels at each step.**

This means:
- The shader marches a single ray through world space per pixel
- At each step, it determines which volume(s) the ray is currently inside (a cheap AABB test)
- For each volume present at that step, it samples all active channels from the texture cache via the page table, applies per-channel contrast/gamma/colormap, and composites them (additive, max, or alpha blend)
- The result of all volumes and all channels is a single accumulated color per pixel
- One draw call, one render pass, regardless of how many channels or overlapping volumes are visible

This is strictly better than the alternative of one render pass per channel per volume. The texture fetches (the expensive part) are comparable, but redundant ray setup, ray traversal, and pass/compositor overhead are eliminated. For N channels in a single volume, it goes from N full ray marches to one ray march with N samples per step.

### Texture cache

The physical texture cache is a small set of large 3D GPU textures (the atlas pool). Chunks from any volume, any channel, any dataset are packed into slots in this cache.

The page table (indirection buffer) maps logical coordinates to physical cache locations:
```
(volume_id, channel, lod_level, chunk_grid_coord) → (cache_texture_index, slot_position)
```

The shader always binds the same small set of cache textures. It uses the page table to find the right data. This means:
- Binding count is fixed regardless of how many volumes are visible
- Memory is bounded by the cache size, not by dataset count
- LOD naturally manages pressure: zoomed out means coarse LOD, fewer chunks per volume, many volumes fit; zoomed in means fine LOD, more chunks, but fewer volumes visible

#### Cache texture grouping by chunk size

A 3D GPU texture is a regular grid of texels — slots within a single texture must all be the same size. Datasets may have different chunk dimensions (and different texel formats), so the cache groups by **(chunk_size, texel_format)** pair. Each unique pair gets its own cache texture with uniformly-sized slots.

Within a dataset, all chunks at a given LOD level have the same dimensions (edge chunks are padded on upload). Chunk dimensions may vary across LOD levels within the same dataset, and will generally vary across different datasets. New cache textures are created on demand as new chunk configurations appear.

In practice, the number of unique (chunk_size, texel_format) pairs across loaded datasets is very small — typically 2–4. WebGPU allows up to 16 sampled textures per shader stage; after reserving a few for colormaps and other uses, roughly 8–10 are available for cache textures. This is a soft cap on the number of unique chunk configurations that can be rendered in a single draw call. If exceeded, the renderer falls back to an additional draw call for the remaining textures — a simple and cheap fallback for a rare edge case.

Each cache texture maintains its own free list of slot indices. Allocation is a pop from the free list; eviction is a push back. The page table is updated with a single uint32 write per chunk loaded or evicted.

#### Residency and eviction

The texture cache is managed by a priority-ordered chunk plan from lucida-core. The priority model, roughly:

1. **Seed data (coarsest LOD) of nearby/current-timepoint volumes** — the progressive fallback safety net, effectively pinned
2. **Fine LOD of the closest chunks** — what the user is actively looking at
3. **Seed data of farther visible volumes** — so zooming out doesn't flash black
4. **Fine LOD of farther visible chunks** — speculative refinement
5. **Off-screen or distant high-res chunks** — lowest priority, first to evict

Per frame, the main thread compares the current chunk plan against what is resident in the cache. Missing high-priority chunks are fetched and uploaded up to a per-frame byte budget. When the cache is full, the lowest-priority resident chunk is evicted to make room. The page table entry is cleared to sentinel on eviction and written on upload.

#### Dimension transitions (T/C/Z scrubbing)

Not all dimension changes are equal. Z is scrubbed most rapidly (interactive exploration), T somewhat (timelapse playback), C rarely (configuration change). The residency system accounts for this:

- **Z** — For 3D volume rendering, the entire volume is visible regardless of Z position, so Z scrubbing doesn't invalidate cache contents. For 2D slicing, Z changes mean a different slice, but adjacent Z slices should be prefetched aggressively since Z scrubbing is the fastest interaction.
- **T** — Changing timepoint invalidates most of the cache (different time = different chunk data). Adjacent timepoints (T±1, T±2) should be prefetched at seed LOD. During active scrubbing, the system should detect scrubbing direction and prefetch ahead.
- **C** — Channel changes are rare configuration events. No special prefetch needed, but the transition should still be progressive (coarse first, refine).

During any dimension transition, the core rule:

> **Don't evict old data until new data is ready to replace it.**

When T changes from 5 to 6:
1. T=6 seed chunks become highest priority
2. T=5 chunks drop in priority but remain resident — they are still being displayed as fallback
3. As T=6 chunks arrive and enter the page table, T=5 chunks become unreferenced
4. Once a T=5 chunk is no longer referenced by any page table entry, it becomes evictable

For rapid scrubbing (user drags through T=5, 6, 7, 8, 9 quickly), the residency analysis should debounce — if T is changing faster than chunks can arrive, only fetch for the latest requested T, not the queue of intermediate values. Intermediate timepoints that the user has already passed should be dropped from the fetch queue, not uploaded.

### Frustum culling and spatial structure

Not all volumes are rendered every frame. Before rendering, the CPU determines which volumes intersect the current view frustum and passes only those to the shader.

For plate layouts (regular grids of wells and fields), the grid structure itself is the acceleration structure — given a ray position in world space, the shader can compute which well and field it hits arithmetically. No BVH is needed.

Rendering cost scales with the number of **locally overlapping** volumes at each ray step, not with total volume count. For a well-arranged plate, this is almost always 1, occasionally 2 at field boundaries. The plate structure is essentially free from a rendering perspective; the complexity is in data management and residency.

### Progressive LOD

Every chunk position always renders the best available resolution. There is no blank/black state — the view is always populated, and it sharpens progressively as finer data arrives.

The page table has entries for each LOD level, each with its own chunk grid (coarser LOD = fewer chunks = smaller grid). The shader performs a fallback chain:

1. Compute chunk coordinate at the target LOD (finest desired)
2. Look up page table — if resident, sample the cache, done
3. If sentinel (not resident), compute chunk coordinate at the next coarser LOD
4. Repeat until resident data is found

This is typically 3–5 LOD levels deep, and in practice hits on the first or second lookup because seed data (coarsest level) is always loaded first and effectively pinned.

The lifecycle for a newly loaded volume:
1. Seed chunks (coarsest LOD) are fetched first — their slots are written into the page table at the coarsest level
2. The shader immediately renders using coarse data (every lookup falls through to the coarsest level)
3. Finer chunks arrive progressively — their slots are written at finer LOD levels
4. The shader starts hitting at the fine level, stops falling back — the image sharpens

Key invariants:
- Seed chunks are treated as the initial state, not a special case
- The old data persists until the first chunk of a new generation arrives — no gap, no flash of black during transitions
- Eviction is priority-based within the cache budget, but seed data is effectively pinned

What it should not do:
- decide which chunks to fetch
- own the canonical scene model
- handle authentication or storage discovery

## lucida-store in Rust
The "data plumbing."

This is the data access layer, used as a library by lucida-server. It is responsible for getting chunk bytes and metadata from wherever they live.

lucida-server calls into lucida-store for:
- opening storage backends (local FS, GCS, S3, HTTP)
- reading OME-Zarr v3 metadata
- mapping logical chunk keys to on-disk store paths
- caching chunks in memory (LRU)
- ingestion (converting non-Zarr formats to OME-Zarr)

What lucida-store should do well:
- read v0.5 OME-Zarr (zarr v3) metadata
- map logical chunk coordinates to store keys
- map logical chunk keys to on-disk Zarr v3 store paths
- fetch compressed chunk payloads
- possibly decode codecs
- cache recent metadata and chunks
- handle concurrency and backpressure

Why Rust fits here:
- good async story
- predictable performance
- safe concurrency
- integrates cleanly with object storage libraries

This component is especially useful if you want:
- protected/private datasets
- shared enterprise/cloud deployments
- heavy server-side preprocessing
- remote datasets over high-latency networks

What it should not do by default:
- reimplement viewer behavior
- own camera state
- become a mandatory bottleneck for every use case

### Ingestion: non-OME-Zarr file conversion

When a user opens a file that is not already OME-Zarr (e.g. TIFF, CZI, ND2, LIF), lucida-store should detect this and convert it before handing it off to the rest of the system.

The flow:
1. User opens a non-OME-Zarr file.
1. lucida-store inspects the file, recognizes it is not OME-Zarr.
1. It starts an ingestion job that converts the file to OME-Zarr, written to a cache directory.
1. It reports progress back through the normal event channel.
1. On completion, the converted dataset is opened through the standard viewer path.

lucida-core never needs to know the original format. It only ever sees OME-Zarr.

An ingestion job is a long-running task with:
- a job ID
- progress reporting (bytes or chunks written)
- a terminal state: success with the output path, or failure with an error

Destination policy: converted files are written to a cache directory with content-addressed naming. This avoids re-converting the same file twice and keeps the output location predictable.

Format detection should be a simple header/extension sniff at the start of the open path. If the file is already OME-Zarr, it passes through with no conversion step.

What ingestion should not do:
- stream unconverted data through a compatibility shim to avoid the conversion step
- make lucida-core aware of non-Zarr formats
- block the UI — conversion is async with progress reporting
- live in lucida-py or any other adapter — conversion is a storage concern

## lucida-server in Rust (tokio)
The “multi-user relay.”

This is the central coordination server that keeps all clients in sync. It owns the authoritative `DocumentState` (the shared structural data — datasets, layers, transforms) and relays messages between all connected clients.

All clients (browsers, Python, CLI) are WebSocket clients that connect to lucida-server on `ws://localhost:9876`.

### State separation

Not all state is shared equally. The server distinguishes three categories:

| Category | Examples | Synced? | Persisted? |
|----------|---------|---------|------------|
| **Document** | datasets, layers, transforms, visibility | Yes — sequenced, broadcast to all | Yes |
| **Presence** | camera, view (z/t/c), display (contrast/gamma), cursor | Broadcast — ephemeral, latest-wins | No |
| **Local-only** | viewport size, hover state, panel layout | Never leaves client | No |

Document commands (add_dataset, remove_dataset, set_volume_scale) go through the server, get sequenced, and are broadcast to all clients. Viewport commands (pan, zoom, set_z, set_contrast) are applied locally and emitted as presence — fire-and-forget, not sequenced, no history.

This means two users looking at the same dataset have independent viewports by default. One user panning does not move the other. Adding a dataset in one client does appear in both.

### Follow mode

Any client can opt in to following another client's viewport. When following, incoming presence updates from the followed client are applied to the follower's local Scene — camera, view, display, and view mode all sync. Any local viewport interaction breaks follow.

Follow is peer-to-peer. There is no global presenter mode. If you want a presentation, you tell others to follow you. The server resolves transitive chains: if A follows C and C starts following B, A is redirected to follow B directly. A client that is following someone cannot itself be followed.

### How it works:
1. On connect, the server sends a snapshot containing the current DocumentState, all peer presence states, and the client's assigned ID.
1. Document commands are applied optimistically by the sender, sent to the server, sequenced, and broadcast. The sender gets an ack; others get the command.
1. Presence updates are sent by clients after any viewport change (throttled). The server stores the latest per-client and broadcasts to others.
1. On disconnect, the server broadcasts peer_left and stops any followers of the disconnected client.

Key design decisions:
- Star topology, not peer-to-peer. Every client connects to the server; no client talks directly to another.
- Each WebSocket connection spawns a tokio task. A `broadcast` channel handles fan-out, tagged with sender ID so each client's outbound loop skips its own messages.
- The server accepts both the new `ClientMessage` envelope and raw `Command` JSON for backward compatibility.

What it should do:
- own the authoritative DocumentState
- sequence and broadcast document commands
- store and relay ephemeral client presence
- manage peer join/leave and follow relationships
- handle connect/disconnect gracefully
- serve chunks to clients using lucida-store as its data layer
- relay chunk requests between peer-hosted data sources

What it should not do:
- render anything
- implement viewer logic beyond applying document commands (that is lucida-core's job)
- require authentication for local use

## lucida-py via PyO3/maturin
The “Python analysis/control bridge.”

This is the Python-facing interface to the same viewer logic.

Its purpose is not just scripting. It is what makes Lucida useful for analysis workflows.

It should let Python code do things like:
- open a dataset
- inspect axes, shapes, metadata
- move the camera
- change slices
- ask which chunks are in view
- request decoded chunk data for the current view
- submit derived results back as a new layer

Examples of what this enables:
- apply a filter to visible chunks only
- run a segmentation model on the current field of view
- overlay detections
- build notebook workflows
- integrate with NumPy, PyTorch, JAX, CuPy, Dask

The important design point is that lucida-py should expose the same semantics as the browser viewer, not invent a separate Python-only viewer model.

For example:
```python
viewer.open(“gcs://bucket/sample.zarr”)
viewer.set_slice(“z”, 42)
viewer.pan(dx=200, dy=-100)
chunks = viewer.visible_chunks()
arrs = viewer.fetch_visible_arrays()
viewer.add_image(process(arrs), name=”filtered”)
```
Internally, lucida-py wraps:
- lucida-core directly for state, camera, planning (via a local `PyScene`)
- lucida-server for multi-user sync (as a WebSocket client)
- lucida-store or another data layer for actual chunk retrieval

When `viewer.start()` is called, the Python `Viewer` connects to lucida-server as a WebSocket client. Document mutations (open, add layer) apply optimistically to the local Scene and send the command to the server. Viewport mutations (pan, zoom, set_slice) apply locally and emit presence. Incoming document commands from other clients are applied to the local Scene in a background receive loop. Read-only accessors read from the local Scene directly.

What it should not become:
- a second full codebase
- an ad hoc collection of utilities detached from the viewer model

A good mental model is: lucida-py is the “analysis/control bridge.”

## lucida-cli
The "automation handle."

This is the command-line client that talks in the same command language as everything else.

Its role is not to be a separate viewer. Its role is to give you automation, scripting, testing, and remote control.

It should support commands like:
- lucida open dataset.zarr
- lucida pan --dx 100 --dy -50
- lucida zoom --factor 2
- lucida slice --axis z --index 20
- lucida state
- lucida visible-chunks
- lucida export-view

The CLI connects to lucida-server as a WebSocket client and sends commands to the shared session. Any connected browser or Python client sees the effect immediately.

Useful for:
- remote control
- reproducible demos
- scripting a browser or desktop viewer
- debugging state transitions

All clients use the same protocol — JSON messages over WebSocket. Document commands are wrapped in a `ClientMessage` envelope:
```
{ "type": "command", "command": { "type": "add_dataset", ... } }
```
Viewport state is sent as presence:
```
{ "type": "presence", "camera": {...}, "view": {...}, "display": {...} }
```
Raw command JSON is still accepted for backward compatibility.

What it should not do:
- implement independent navigation logic
- become the place where core algorithms drift from the rest of the system

## Typical Workflows
### A typical interaction would look like this:
1. User opens a dataset in lucida-web.
1. lucida-web sends open_dataset(...) to lucida-core.
1. lucida-core parses the dataset description and computes initial view state.
1. lucida-core produces a chunk request plan.
1. Chunks are fetched either:
    - directly from storage in the browser, or
    - via lucida-store
1. Decoded chunks are sent to the worker renderer.
1. The renderer uploads them to GPU and draws them.
1. User pans or changes z.
1. The cycle repeats.

### For Python:
1. Python calls viewer.pan(...).
1. lucida-py applies the command to its local Scene and emits presence.
1. If viewer.open_dataset(...) is called, that is a document command — it is sent to lucida-server for broadcast.
1. Python reads from its local Scene for chunk planning, processing, etc.

### For CLI:
1. CLI sends a document command to lucida-server.
1. lucida-server applies it and rebroadcasts to all other clients.
1. All connected viewers update their document state.

### Multi-user:
1. User A adds a dataset → document command goes through the server → User B sees the dataset appear.
1. User A pans → local only, emitted as presence → User B's viewport does not move.
1. User B clicks "Follow" on User A → User B now sees what User A sees. User B pans → follow breaks, they are independent again.

## Main Design Principles
There should be exactly one authoritative implementation of:
- camera behavior
- axis/slice semantics
- multiscale selection
- visible chunk planning
- command semantics

That is lucida-core.

Everything else is an adapter around it:
- lucida-web = human UI adapter (via WASM, connects to lucida-server)
- renderer = GPU adapter (via lucida-web via post)
- lucida-store = storage adapter (via optional server)
- lucida-server = multi-user relay (owns authoritative DocumentState, relays presence, syncs all clients via WebSocket)
- lucida-py = Python adapter (via PyO3, connects to lucida-server)
- lucida-cli = shell/script adapter (via native Rust, connects to lucida-server)
