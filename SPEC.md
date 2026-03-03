# Lucida
A fast and lightweight 5D image viewer.

## Parts
- **lucida-core** decides what should be shown.
- **lucida-web** decides how the user interacts with it.
- **The renderer** decides how pixels get drawn.
- **lucida-store** decides where data comes from.
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
- **Scene**: all loaded layers, axis info, transforms, visibility, contrast settings, etc.
- **Camera**: center, zoom, viewport size, rotation if you want it.
- **ViewState**: selected indices for z, t, c, and any other dimensions.
- **Layer**: image layer, labels layer, points layer later if you want.
- **Command**: pan, zoom, set_slice, open_dataset, set_layer_visibility, and so on.
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
1. lucida-web converts that into a command like pan(dx, dy).
1. It sends that command to lucida-core.
1. lucida-core returns updated state plus a new chunk request plan.
1. lucida-web forwards that plan to the data/renderer pipeline.

So lucida-web is mostly responsible for:
- app state wiring
- event handling
- UI rendering
- orchestration between core, store, and renderer

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
- tile/chunk draw scheduling
- view transform application
- possibly partial redraw strategies
- dropped-frame avoidance under heavy input

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
- read OME-Zarr metadata
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

## lucida-py via PyO3/maturin
The "Python analysis/control bridge."

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
viewer.open("gcs://bucket/sample.zarr")
viewer.set_slice("z", 42)
viewer.pan(dx=200, dy=-100)
chunks = viewer.visible_chunks()
arrs = viewer.fetch_visible_arrays()
viewer.add_image(process(arrs), name="filtered")
```
Internally, lucida-py should probably wrap:
- lucida-core directly for state, camera, planning
- lucida-store or another data layer for actual chunk retrieval

What it should not become:
- a second full codebase
- an ad hoc collection of utilities detached from the viewer model

A good mental model is: lucida-py is the “analysis/control bridge.”

### lucida-cli
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

The CLI sends commands to a live viewer session.

Useful for:
- remote control
- reproducible demos
- scripting a browser or desktop viewer
- debugging state transitions

The second model is often more powerful if you define a stable command protocol, such as JSON messages:
```
{ "type": "pan", "dx": 120, "dy": -40 }
```
Then the web app, Python API, and CLI can all use the same command format.

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
1. lucida-py forwards that to lucida-core.
1. lucida-core computes visible chunks.
1. Python requests those chunks, processes them, and adds a derived layer.
1. The renderer displays both source and derived layers.

### For CLI:
1. CLI emits a command in the same protocol.
1. The same state machinery updates.
1. You can inspect or manipulate the viewer reproducibly.

## Main Design Principles
There should be exactly one authoritative implementation of:
- camera behavior
- axis/slice semantics
- multiscale selection
- visible chunk planning
- command semantics

That is lucida-core.

Everything else is an adapter around it:
- lucida-web = human UI adapter
- renderer = GPU adapter
- lucida-store = storage adapter
- lucida-py = Python adapter
- lucida-cli = shell/script adapter
