# Lucida
A fast and lightweight 5D image viewer.

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
- What dataset is open?
- What dimensions exist? (t, c, z, y, x)
- What is the current camera position and zoom?
- Which slice is selected for non-displayed dimensions?
- Which multiscale level should be used right now?
- Which chunks intersect the current field of view?
- Which neighboring chunks should be prefetched?
- In what order should chunk requests be prioritized?

Concretely, it should define the core data structures:
- **Scene**: the local composite — camera, view, display, and document state. Each client holds a full Scene because chunk planning needs all of it together.
- **DocumentState**: the shared portion of a Scene — datasets, layers, transforms. This is what the server owns and syncs.
- **Camera**: center, zoom, viewport size, rotation if you want it.
- **ViewState**: selected indices for z, t, c, and any other dimensions.
- **DisplayState**: contrast window and gamma. Per-client, not part of the shared document.
- **Layer**: image layer, labels layer, points layer later if you want.
- **Command**: pan, zoom, set_slice, open_dataset, set_layer_visibility, and so on. Commands are classified as document commands (synced) or viewport commands (local-only).
- **ChunkRequestPlan**: the list of chunks needed now, plus prefetch candidates.

It should also contain deterministic algorithms:
- multiscale level selection
- visible chunk planning
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
- composite layers
- apply contrast/colormap/gamma
- handle smooth panning and zooming
- possibly do some shader-based resampling or blending

Why OffscreenCanvas:
- it lets rendering happen off the main thread
- the main React app stays responsive

Why WebGPU:
- modern GPU API
- better long-term fit than WebGL for compute-heavy or large-image workflows
- easier path to shader-based image operations later

Responsibilities inside the renderer usually include:
- texture atlas or texture lifetime management
- texture upload and draw execution
- view transform application
- possibly partial redraw strategies
- GPU-level tile/chunk compositing

What it should not do:
- decide which chunks to fetch
- own the canonical scene model
- handle authentication or storage discovery

## lucida-store in Rust
The "data plumbing."

This is the data access layer. It is responsible for getting chunk bytes and metadata from wherever they live.

Depending on deployment, it can act in two ways:

### Mode 1: optional backend service

A Rust service sits between the client and the storage system. It can:
- open local files on the server
- read from GCS, HTTP, local FS
- authenticate users
- sign URLs
- cache hot chunks
- decode or transform data server-side
- expose a simple chunk API to clients

### Mode 2: library only

If the browser can access the store directly, then Lucida may skip the server for normal reads. In that case lucida-store may still exist for:
- ingest
- batch transforms
- auth/signing setup
- precomputation
- desktop packaging

What lucida-store should do well:
- read v0.5 OME-Zarr (zarr v3) metadata
- map logical chunk coordinates to store keys
- fetch compressed chunk payloads
- possibly decode codecs
- optionally perform server-side transforms
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

What it should not do:
- serve data or chunks (that is lucida-store's job)
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
