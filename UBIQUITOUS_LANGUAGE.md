# Ubiquitous Language

## Scene state

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Scene** | The complete viewer state for one client: camera, view, document, display, and layer settings | State, viewer, session |
| **DocumentState** | The shared, persisted subset of scene state containing all datasets | Document, shared state, scene data |
| **DisplayState** | Per-client contrast window and gamma settings (not synced as document state) | Rendering settings, window/level |
| **ViewState** | The selected indices for non-displayed dimensions: z slice/slab, timepoint, and channel | Slice state, dimension selector |
| **PresenceState** | A client's full ephemeral state as broadcast to peers: camera, view, display, follow target, cursor, and layer settings | Viewport state, peer state |

## Data model

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Dataset** | A named, ID'd collection of layers with shared spatial metadata (volume transform and shape) | Volume, image, file |
| **Layer** | A single image channel within a dataset, described by its data shape, chunk size, number of levels, and optional per-level info | Channel, array |
| **LevelInfo** | Per-level shape and chunk size metadata for a layer, used when the multiscale pyramid is anisotropic | Resolution info, scale metadata |
| **VolumeTransform** | A pair of 4x4 matrices (model + inverse) that maps the `[0,1]^3` unit cube to world space, accounting for anisotropic voxel spacing | Transform, model matrix, spatial transform |
| **Volume shape** | The voxel dimensions of a dataset, ordered `[Z, Y, X]` | Dimensions, size, extent |
| **Data shape** | The full-resolution voxel dimensions of a layer, ordered `[X, Y, Z]` | Layer shape, array shape |
| **Client metadata** | Opaque JSON attached to a dataset (dtype, codecs, level paths) that the server passes through without interpretation | Dataset config, format info |

## Volume and voxels (lucida-store)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Volume** | A 5D array of u16 voxel intensities in TCZYX memory order, representing a complete microscopy acquisition as read from a TIFF | Image, stack |
| **Voxel** | A single 3D data point in a Volume, carrying a u16 intensity value | Pixel (reserve for 2D contexts) |
| **Voxel Size** | The physical dimensions (in micrometers) of a single Voxel along each axis, determining Anisotropy | Resolution, spacing, pixel size |
| **Channel** | One spectral or fluorescence acquisition dimension (the C axis) of a Volume | Color, band |
| **Timepoint** | One temporal frame (the T axis) of a Volume | Frame, timestep |
| **Plane** | A single 2D XY cross-section of voxel data at a given Z coordinate within a Volume | Slice (ambiguous), image |

## TIFF input (lucida-store)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Page** | A single 2D image within a multi-page TIFF file, containing one Plane's worth of pixel data | Frame, IFD entry, slice |
| **Dimension Order** | The convention describing which dimensions vary fastest across sequential Pages (e.g. XYZCT means Z varies fastest after XY) | Axis order, page order |
| **OME-XML** | Metadata embedded in a TIFF's ImageDescription tag that declares Dimension Order, axis sizes, and Voxel Size | TIFF metadata, image description |
| **Dimension Hints** | User-provided CLI overrides for T/C/Z sizes, Dimension Order, and Voxel Size that take precedence over OME-XML | Overrides, flags |

## Pyramid and downsampling (lucida-store)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Pyramid** | An ordered sequence of Levels representing the same Volume at progressively coarser resolutions | Multiscale (use for the Zarr metadata spec), mipmap |
| **Level Spec** | A metadata-only description of a Level's dimensions, cumulative scale factors, and which axes were downsampled to produce it | Schedule entry |
| **Downsample Schedule** | The complete sequence of Level Specs computed before any pixel work begins, determining the shape of the entire Pyramid | Plan, level plan |
| **Downsample** | Reduce a Level's resolution by 2x along selected axes using Box Average to produce the next coarser Level | Resize, decimate, scale down |
| **Box Average** | The specific averaging method used during Downsample: mean of a 2x2 (XY-only), 1x1x2 (Z-only), or 2x2x2 (XYZ) neighborhood of voxels | Interpolation, filtering |
| **Anisotropy** | The condition where Voxel Size differs across axes (e.g. Z is 5x coarser than XY in confocal microscopy), requiring axis-selective downsampling | Non-uniform spacing |
| **Effective Voxel Size** | The product of physical Voxel Size and the Cumulative Scale at a given Level, used to decide which axes to Downsample next | Scaled voxel size |
| **Uniquely Coarsest** | The condition where one axis has a strictly greater Effective Voxel Size than all others; that axis is skipped during Downsample so finer axes can catch up | Dominant axis |

## Zarr output (lucida-store)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Store** | The output directory tree conforming to Zarr v3 and OME-Zarr v0.5, containing Root Metadata and one array per Level | Archive, output, container |
| **Chunk Size** | The dimensions of a Chunk in `[x, y, z]` order (lucida-core convention), controlling the granularity of streaming | Tile size, block size |
| **Codec** | A compression or encoding step applied to raw Chunk bytes before writing to disk; currently raw little-endian bytes followed by LZ4 with prepended size | Compressor, filter |
| **Root Metadata** | The top-level `zarr.json` file declaring the Store as a Zarr v3 group with OME multiscales attributes (axes, per-Level coordinate transforms) | Group metadata |
| **Array Metadata** | The per-Level `{level}/zarr.json` file declaring shape, Chunk grid, Codecs, and data type for one resolution array | Level metadata |
| **Cumulative Scale** | The `[x, y, z]` factor array on a Level Spec expressing how many times coarser this Level is relative to Level 0 | Scale factor, resolution factor |

## Camera system

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Camera** | A tagged enum that is either a View2D or View3D, providing a unified interface for viewport, zoom, and visible region computation | Viewport, view |
| **View2D** | A pan/zoom camera for 2D slice viewing, defined by center point, zoom level, and viewport size | 2D camera, slice camera |
| **View3D** | An arcball camera for 3D volume rendering, using spherical coordinates (theta, phi, distance) around a target point | 3D camera, orbit camera |
| **VisibleRegion** | The camera-agnostic output of visible region computation: an XY bounding box in voxel space, a Z range, an effective zoom, and optional frustum planes and sort center | Viewport bounds, view bounds |
| **Effective zoom** | Screen pixels per voxel at the focal plane; in 2D this is the zoom value directly, in 3D it is derived from distance, FOV, and voxel density | Scale, magnification, resolution |
| **Frustum planes** | Six clipping planes in full-resolution voxel coordinates, extracted from the view-projection matrix using the Gribb-Hartmann method; used for per-chunk culling in 3D | Clip planes, view planes |
| **Sort center** | The point in voxel space where the camera's center-screen ray intersects the volume surface; used to prioritize chunk loading from the camera's point of interest outward | Focus point, hit point |

## Chunk system

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **ChunkCoord** | A chunk's address in the multiscale grid: level, x, y, z, t, c | Tile coordinate, block index |
| **Chunk key** | The string encoding of a ChunkCoord in the format `level/t/c/z/y/x` | Chunk ID, chunk path |
| **ChunkRequestPlan** | The output of chunk planning: a `needed` list (visible now) and a `prefetch` list (border for upcoming pans) | Chunk list, fetch plan, tile plan |
| **Level** | A resolution tier in the multiscale pyramid; level 0 is full resolution, each subsequent level halves the data (isotropic) or follows LevelInfo (anisotropic) | Resolution level, LOD, mipmap level, scale |
| **Prefetch** | Chunks in the 1-chunk XY border surrounding the visible region, fetched proactively for smooth panning (2D only, no Z expansion) | Preload, buffer zone |
| **Frustum culling** | Per-chunk rejection of chunks whose AABB lies entirely outside any frustum plane, using the p-vertex method | View culling, visibility test |

## Commands and protocol

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Command** | A tagged enum representing a single atomic mutation to scene state | Action, event, message, operation |
| **Document command** | A command that mutates shared DocumentState (AddDataset, RemoveDataset, SetVolumeScale) -- sequenced, persisted, and broadcast to all clients | Shared command, sync command |
| **Viewport command** | A command that mutates local-only state (camera, display, view, layer settings) -- applied locally and emitted as presence | Local command, ephemeral command |
| **ClientMessage** | A tagged message sent from a client to the server: Command, Presence, Cursor, Follow, LayerPresence, or Steer | Client event, upstream message |
| **ServerMessage** | A tagged message sent from the server to clients: Snapshot, CommandBroadcast, Ack, PeerJoined/Left, PresenceUpdate, CursorUpdate, FollowChanged, LayerPresenceUpdate | Server event, downstream message |
| **Snapshot** | The first ServerMessage on connect, containing the full authoritative DocumentState, all peer PresenceStates, and the connecting client's ID | Initial state, sync, handshake |
| **Ack** | A ServerMessage sent only to a command's sender confirming the command was applied and its sequence number | Confirmation, receipt |
| **CommandBroadcast** | A ServerMessage relaying a document command to all clients except the sender, with a sequence number | Relay, rebroadcast |
| **Presence** | An ephemeral, latest-wins update of a client's camera, view, and display state | Viewport update, heartbeat |
| **Follow** | A peer-to-peer mode where one client mirrors another's presence; transitive chains resolved server-side | Sync view, link, mirror |
| **Steer** | A remote-control action that makes another client follow the sender | Remote control, force-follow |
| **ChunkMessage** | A message for chunk data relay: ChunkRequest (viewer to server) or ChunkFetch (server to data source) | Data request, tile message |

## Server architecture

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Session** | The single shared collaborative workspace managed by the server: document state, command history, data source registry, and per-client presence | Room, channel, workspace |
| **Client** | A single WebSocket connection to the server, identified by a unique ClientId (u64) | User, connection, participant |
| **Peer** | Another client from a given client's perspective, used in PeerJoined/PeerLeft messages | Other user, remote client |
| **Data Source** | The client that added a dataset and is responsible for serving its chunk data to other clients on demand | Provider, host, owner, uploader |
| **Sequence Number (seq)** | A monotonically increasing u64 counter on the session, incremented each time a document command is applied | Version, revision, counter |
| **History** | A bounded ring buffer (capacity 256) of recently applied document commands paired with their sequence numbers | Log, undo stack, changelog |
| **Broadcast** | Fan-out delivery of a message to all connected clients via a tokio broadcast channel; the sender may receive a different payload (Ack vs CommandBroadcast) or be excluded (Presence, Cursor) | Multicast, publish, fan-out |
| **Unicast** | Targeted delivery of a message to a single specific client via a per-client mpsc channel; used exclusively for chunk data routing | Direct message, point-to-point |
| **BroadcastItem** | The internal enum carried on the broadcast channel, wrapping all fan-out message types with sender metadata for self-exclusion logic | Broadcast event, channel item |
| **ClientSenders** | The shared map of ClientId to per-client unbounded mpsc senders, used for unicast chunk routing | Unicast map, client channels |
| **ChunkRequest** | A message from a viewing client to the server asking for a specific chunk by dataset ID and chunk key | Fetch request, data request |
| **ChunkFetch** | A message from the server to a data source client instructing it to read a specific chunk and send the binary data to a specified viewing client | Fetch directive, source request |
| **Chunk Data** | A binary WebSocket message containing raw chunk bytes, prefixed with the target client ID (u32 LE) and key; the server reads the target ID and routes via unicast | Payload, blob, binary chunk |
| **Follow Chain** | A transitive dependency (A follows C, C follows B) resolved by the server redirecting A to follow B directly, enforcing a max follow depth of 1 | Daisy chain, transitive follow |

## Display

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Contrast window** | The min/max intensity range mapped to the display's black-to-white range | Window/level, intensity range, brightness/contrast |
| **Gamma** | A nonlinear intensity exponent applied after contrast windowing | Gamma correction, tone curve |
| **BlendMode** | How overlapping layers composite: alpha, additive, or max | Compositing mode, mix mode |
| **RenderMode** | The volume rendering strategy for 3D: translucent (front-to-back compositing) or max-intensity (MIP) | Projection mode, ray-cast mode |
| **DatasetDisplaySettings** | Per-dataset display configuration: visibility, opacity, contrast window, gamma, blend mode, and render mode | LayerDisplaySettings (old name), layer style |
| **Dataset order** | The rendering order of datasets, stored as a list of dataset IDs (`dataset_order`) | Layer order (old name), Z-order, draw order, stack order |

## Spatial math

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Model matrix** | The 4x4 column-major matrix (f32) from VolumeTransform that maps `[0,1]^3` unit space to world space | World matrix, object matrix |
| **Corrected model matrix** | The model matrix adjusted by a global normalization factor so multi-dataset scenes preserve relative physical sizes, with Y-translation for top-alignment | Normalized model, display model |
| **Max physical extent** | The largest physical axis extent of a dataset before normalization; used to compute inter-dataset size correction | Physical size, bounding extent |
| **Unit space** | The `[0,1]^3` coordinate system where the volume is a unit cube at the origin | Normalized space, object space, local space |
| **Voxel space** | The integer coordinate system of the full-resolution data grid, where each unit is one voxel | Image space, pixel space, data coordinates |
| **World space** | The coordinate system after applying the model matrix, where the camera operates | View space, scene space |

## Python SDK (lucida-py)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Viewer** | The Python SDK client: a `PyScene` wrapper that maintains a WebSocket connection to the Server on a background thread, exposing viewport commands, follow/steer, and data read/write as a notebook-friendly API. | Client (ambiguous with server-side Client) |
| **ViewportData** | An assembled numpy array (Z, Y, X) covering the visible Chunks for a single Dataset, bundled with its Origin, Level, level shape, chunk shape, t/c indices, and physical Scale. | Viewport, result, volume |
| **Origin** | The voxel offset (z, y, x) of a ViewportData's top-left-front corner within the full Level shape; computed from the minimum chunk grid coordinates in the Chunk Plan. | Offset, position |
| **Local Mode** | Chunk retrieval by reading Zarr v3 chunk files directly from a Store on the local filesystem; activated by passing a `store_path` to `read_viewport`. | File mode, disk mode |
| **Remote Mode** | Chunk retrieval by sending Chunk Requests through the Server to the Data Source peer; activated by calling `read_viewport` with no `store_path`. | Server mode, proxy mode, network mode |

## Web rendering pipeline (lucida-web)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Atlas** | A large GPU texture that packs multiple chunks into fixed-size slots, indexed by an **Indirection buffer**; one per **Dataset** per render mode (2D slice or 3D volume) | Texture cache, sprite sheet |
| **Indirection buffer** | A GPU storage buffer mapping chunk grid coordinates to **Atlas** slot indices; the sentinel value `0xFFFFFFFF` means "not loaded" and triggers **Fallback** sampling | Lookup table, slot map |
| **Fallback texture** | A coarse-resolution texture (assembled from the lowest **Level** of the **Pyramid**) displayed in place of unloaded **Atlas** chunks | Low-res preview, placeholder |
| **Seed** | The process of fetching all chunks from the coarsest **Level** and assembling them into a **Fallback texture** when T/C/Z changes, providing instant visual feedback while fine chunks load | Preload, initialize, warm |
| **Upload budget** | The maximum bytes of chunk data transferred to the GPU per RAF tick: 4 MB for the main view, 2 MB for the **Minimap** | Frame budget, bandwidth cap |
| **Render scale** | A resolution multiplier (0.25–1.0) applied to the render target during camera interaction to maintain frame rate; restored to 1.0 after 50ms idle | Resolution scale, quality level |
| **Offscreen target** | An `rgba16float` intermediate texture where each visible **Dataset** layer is rendered independently before the **Compositor** blends them | Render target, layer buffer, FBO |
| **Compositor** | The final rendering pass that blends all **Offscreen targets** onto the canvas using per-layer **BlendModes** (alpha, additive, max) | Blender, combiner, merge pass |
| **Minimap** | A small overview volume rendered on a separate OffscreenCanvas showing the full dataset at the coarsest **Level**, with frustum and slice plane overlays | Overview, thumbnail, inset |
| **Auto-contrast** | A mode where the **Contrast window** is automatically set to the sampled intensity range of the currently displayed data | Auto-levels, auto-window |

## Chunk loading (lucida-web)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **ChunkStore** | A reactive cache wrapping a **ChunkFetcher** with `useSyncExternalStore` subscription, max 6 concurrent fetches, and abort/restart logic for view changes | Chunk cache, tile manager, data store |
| **ChunkFetcher** | A pluggable async function that retrieves a single chunk's decompressed data given its **ChunkCoord**; file-based for local datasets, WebSocket-based for remote | Loader, data source (ambiguous with server concept) |
| **File index** | A `Map<string, File>` built from a `webkitdirectory` FileList, mapping Zarr-relative paths to browser File objects for local chunk access | File map, file lookup |
| **Dirty flag** | The boolean on the **Render loop** that gates whether GPU work is done on a given RAF tick; set by **ChunkStore** subscriptions and viewport changes | Needs redraw, invalidated |
| **Render loop** | The pull-based `requestAnimationFrame` tick that checks the **Dirty flag**, evaluates **ChunkRequestPlans**, uploads available chunks within the **Upload budget**, and dispatches render commands to the **GPU worker** | Frame loop, game loop, RAF loop |

## Web worker architecture (lucida-web)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **GPU worker** | The dedicated Web Worker that owns the OffscreenCanvas and performs all WebGPU operations (texture creation, chunk upload, rendering); the main thread never touches WebGPU | Render worker, graphics thread |
| **RenderClient** | The main-thread proxy that communicates with the **GPU worker** via `postMessage` with zero-copy ArrayBuffer transfer | Worker client, render bridge |
| **Worker protocol** | The discriminated-union message types (`MainToWorkerMessage` / `WorkerToMainMessage`) for structured communication between the main thread and the **GPU worker** | Worker API, message format |
| **LZ4 worker pool** | A pool of up to 4 Web Workers for parallel LZ4 block decompression, load-balanced by active task count | Decompression pool, codec workers |
| **Bridge** | The WebSocket client class on the web frontend that manages the connection to `lucida-server`, handles message dispatch, throttles **Presence** (50ms) and **Dataset Presence** (200ms), and supports auto-reconnect | Socket, connection, WS client |

## Relationships

- A **Scene** contains exactly one **Camera**, one **ViewState**, one **DocumentState**, one **DisplayState**, a **Dataset order**, and a map of **DatasetDisplaySettings**
- A **Session** contains exactly one **DocumentState**, one **History**, one data source registry, and a map of **ClientId** to **PresenceState**
- A **DocumentState** contains zero or more **Datasets**
- A **Dataset** contains zero or more **Layers** and optionally one **VolumeTransform** and **Volume shape**
- A **Dataset** has exactly one **Data Source** (the **Client** that added it); if that **Client** disconnects, the data source mapping is removed
- A **Layer** contains zero or more **LevelInfo** entries; when empty, isotropic 2x downsampling is assumed
- A **Camera** produces a **VisibleRegion** given the current **ViewState** and optional **VolumeTransform**
- A **VisibleRegion** is consumed by chunk planning to produce a **ChunkRequestPlan**
- A **ChunkRequestPlan** contains a `needed` list and a `prefetch` list of **ChunkCoords**
- A **Command** is either a **Document command** (broadcast) or a **Viewport command** (local + presence)
- A **PresenceState** bundles one client's **Camera**, **ViewState**, **DisplayState**, follow target, cursor, **Layer order**, and **LayerDisplaySettings**
- A **Client** may **Follow** at most one other **Client**; a **Client** being followed cannot itself be following anyone (max chain depth = 1)
- A **ChunkRequest** from a viewing **Client** produces a **ChunkFetch** to the **Data Source**, which responds with **Chunk Data** routed back via **Unicast**
- A **Snapshot** is sent exactly once per **Client** — on connect, before any **Broadcast** messages
- A **Volume** is read from a TIFF file whose **Pages** are reordered according to the **Dimension Order** into canonical TCZYX layout
- **Dimension Hints** override **OME-XML**; both override defaults (T=1, C=1, Z=num_pages, order=XYZCT)
- A **Downsample Schedule** is computed once from the Volume's dimensions, **Voxel Size**, and a minimum size threshold (256)
- A **Pyramid** contains one or more **Levels**, where Level 0 is the full-resolution **Volume** and each subsequent Level is produced by **Downsampling** the previous one
- Each **Level Spec** records which axes to downsample, informed by **Anisotropy** via the **Uniquely Coarsest** rule
- A **Store** contains **Root Metadata** (one group) and one **Array Metadata** + set of **Chunks** per **Level**
- **Chunk Size** is specified in `[x, y, z]` order in code but written to Zarr metadata in TCZYX order as `[1, 1, z, y, x]`
- A **Store** is the producer-side name for what the viewer loads as a **Dataset**
- A **Viewer** holds exactly one **Scene** and zero or one **Follow** target
- A **Viewer** is a **Client** from the Server's perspective, assigned a **ClientId** on connect
- A **Viewer** may become a **Data Source** by calling `write_viewport`, serving **Chunks** from in-memory storage to other **Peers**
- A **ViewportData** is assembled from the **Chunks** listed in a **ChunkRequestPlan**'s `needed` list, and records its **Origin** within the **Level** shape
- In **Local Mode**, a **Viewer** reads **Chunks** directly from a **Store** on disk; in **Remote Mode**, it sends **ChunkRequests** through the **Server**
- A **ChunkStore** wraps exactly one **ChunkFetcher** and maintains a cache of **Chunk keys** to decompressed ArrayBuffers
- An **Atlas** contains a GPU texture, an **Indirection buffer**, and a slot-tracking map; one **Atlas** exists per **Dataset** per render mode (slice or volume)
- A **Fallback texture** is assembled from all chunks of the coarsest **Level** via **Seeding**; the shader samples it when the **Indirection buffer** returns the sentinel value
- The **GPU worker** lazily creates one `SliceRenderer`, one `VolumeRenderer`, and one **Compositor**; all three share the same `GPUDevice`
- The **RenderClient** sends chunk data to the **GPU worker** via the **Worker protocol** using `Transferable` ArrayBuffers (zero-copy ownership transfer)
- The **Render loop** delegates chunk planning to **WasmScene** (`chunk_plan_for`), fetching to a **ChunkStore**, and rendering to the **RenderClient**; it never touches the GPU directly
- The **Upload budget** limits how many chunk bytes move from **ChunkStore** to **Atlas** per RAF tick, preventing GPU stalls and maintaining interactive frame rates
- The **Bridge** is instantiated once when the WASM module is ready and auto-reconnects on disconnect with a 2-second delay

## Example dialogue

> **Dev:** "When a user opens a file, does that create a **Dataset** or a **Layer**?"
> **Domain expert:** "A **Dataset**. One file produces one **Dataset** with an ID. That **Dataset** contains one or more **Layers** -- think of them as the individual image channels. The **Dataset** also carries spatial metadata: its **Volume shape** and a **VolumeTransform** computed from the voxel spacing."

> **Dev:** "And when the user pans around, how does the system know which chunks to load?"
> **Domain expert:** "The **Camera** computes a **VisibleRegion** -- that's just a voxel-space bounding box plus an **Effective zoom**. In 3D, it also includes **Frustum planes** for culling. Then chunk planning takes that **VisibleRegion**, picks the best **Level** based on **Effective zoom**, and produces a **ChunkRequestPlan** with `needed` chunks sorted center-out from the **Sort center**."

> **Dev:** "What about the per-dataset contrast and opacity controls?"
> **Domain expert:** "Those live in **DatasetDisplaySettings**, keyed by dataset ID. They're **Viewport commands** -- not **Document commands** -- so they stay local and get emitted as **Presence**. The **Dataset order** controls draw sequence. Only **AddDataset**, **RemoveDataset**, and **SetVolumeScale** are **Document commands** that get sequenced and broadcast."

> **Dev:** "If I follow another user, what exactly gets mirrored?"
> **Domain expert:** "**Follow** mirrors their **PresenceState**: **Camera**, **ViewState**, and **DisplayState**. Your local viewport size is preserved though -- `import_presence` keeps your viewport dimensions. There's also **Steer**, which is the reverse: it forces another client to **Follow** you."

> **Dev:** "How does the chunk streaming actually work between two browsers?"
> **Domain expert:** "The **Client** that adds a **Dataset** becomes its **Data Source**. When another **Client** needs a chunk, it sends a **ChunkRequest** with the dataset ID and **Chunk key**. The server looks up the **Data Source** in its registry and sends a **ChunkFetch** to that **Client**. The **Data Source** reads the data and sends it as **Chunk Data** — a binary WebSocket message with the target **ClientId** packed in the first 4 bytes. The server reads that target ID and routes the binary via **Unicast**. The server never touches the chunk bytes themselves."

> **Dev:** "How does a TIFF become something the viewer can stream?"
> **Domain expert:** "That's `lucida-store`. It reads the TIFF's **Pages**, reorders them from the **Dimension Order** into TCZYX to produce a **Volume**, then builds a **Pyramid**. The **Downsample Schedule** is computed from the **Voxel Size** — if there's **Anisotropy**, the **Uniquely Coarsest** axis gets skipped until the finer axes catch up. Each **Level** gets chunked and LZ4-compressed into a **Store**. The viewer then loads that **Store** as a **Dataset**."

> **Dev:** "What if the TIFF has no OME-XML metadata?"
> **Domain expert:** "Then `lucida-store` falls back to treating all **Pages** as Z slices: T=1, C=1, Z=page count. The user can override with **Dimension Hints** via CLI flags. Hints always win over **OME-XML**, and **OME-XML** always wins over defaults."

> **Dev:** "How does `read_viewport` work in the Python **Viewer**?"
> **Domain expert:** "It calls `chunk_plan_for` on the Rust **Scene** to get the **ChunkRequestPlan** for a specific **Dataset**. In **Local Mode** — when you pass a `store_path` — it reads each **Chunk** file directly from the **Store** on disk. In **Remote Mode** — no path — it sends **ChunkRequests** through the **Server** to the **Data Source** and waits for binary responses. Either way, the raw chunks get decompressed, assembled into a contiguous numpy array, and returned as a **ViewportData** with its **Origin** in the **Level**."
> **Dev:** "And `write_viewport` — that makes the **Viewer** a **Data Source**?"
> **Domain expert:** "Exactly. It slices the numpy array into **Chunks**, stores them in memory, and sends an `AddDataset` **Document Command**. Now when any other **Client** requests **Chunks** for that **Dataset**, this **Viewer** serves them directly. It's a full **Peer** in the collaboration, not just a consumer."

> **Dev:** "What happens to the **Session** when the **Data Source** disconnects?"
> **Domain expert:** "The server removes the **Data Source** mapping. The **Dataset** stays in the **DocumentState** — it's not automatically removed — but no one can fetch **Chunks** for it anymore. The server also broadcasts **PeerLeft** and breaks any **Follow Chains**: if anyone was following the disconnected **Client**, their follow target gets set to `None` and a **FollowChanged** is broadcast."

> **Dev:** "How does a chunk get from disk to the screen in the web viewer?"
> **Domain expert:** "The **Render loop** fires on each RAF tick if the **Dirty flag** is set. It asks the **WasmScene** for a **ChunkRequestPlan** per **Dataset**, then passes the `needed` and `prefetch` lists to the **ChunkStore**. The **ChunkStore** fetches from the **File index** (local) or via **Bridge** (remote), decompressing LZ4 chunks through the **LZ4 worker pool**. When data arrives, the **ChunkStore** bumps its version — that sets the **Dirty flag** again. On the next tick, the **Render loop** finds the chunk in cache, converts it to u16, and sends it to the **RenderClient**, which transfers the ArrayBuffer to the **GPU worker**. The worker writes it into the **Atlas** and updates the **Indirection buffer**. All within the **Upload budget** — 4 MB per tick."

> **Dev:** "What happens visually when the user changes the timepoint?"
> **Domain expert:** "The viewer **Seeds** the new timepoint: it fetches all chunks of the coarsest **Level** and assembles them into a **Fallback texture**. That gets uploaded immediately, so the user sees a blurry preview right away. Meanwhile, the **ChunkRequestPlan** now has fine-level `needed` chunks for the new timepoint. Those flow through the **ChunkStore** and get uploaded to the **Atlas** incrementally, capped by the **Upload budget**. The shader samples from the **Atlas** where chunks are loaded and falls back to the **Fallback texture** where they're not. The transition is progressive — blurry to sharp."

> **Dev:** "Why does the 3D view get blocky when I drag?"
> **Domain expert:** "That's the **Render scale**. During interaction it drops to 0.25 — rendering at quarter resolution — so the **GPU worker** can keep up with the ray marching. After 50ms of no input, it snaps back to 1.0 and re-renders at full resolution. The **Render loop** uses the full-res viewport for **Level** selection though, so you don't get LOD flip-flopping during drags."

## Flagged ambiguities

- **"Zoom"** means different things by context. In **View2D**, zoom is a direct scale factor (1.0 = native). In **View3D**, **Effective zoom** is derived from distance, FOV, and voxel density. The chunk planner normalizes both into pixels-per-voxel, but the raw values are not comparable.

- **"Model matrix"** has two flavors. The raw `VolumeTransform.model` maps unit space to world space for a single dataset. The **Corrected model matrix** (in `WasmScene::model_matrix_for`) applies a global normalization factor and Y-translation for multi-dataset alignment. GPU code receives the corrected version; the raw version is only used internally.

- **"clients"** is used for two different maps in the server. `Session.clients` maps ClientId to **PresenceState** (tracking what each client is viewing). `ClientSenders` in `main.rs` maps ClientId to mpsc senders (routing **Unicast** messages). These serve entirely different purposes — consider renaming `ClientSenders` to **UnicastRoutes** or **ChunkRouters** to disambiguate.

- **"Command"** enum contains both **Document commands** and **Viewport commands**, but the server only processes the document subset. The discriminator `is_document_command()` is the only thing preventing viewport commands from being broadcast. If a new command variant is added to the enum and `is_document_command()` isn't updated, it will silently be ignored by the server. Consider splitting into separate enums.

- **"Scene"** is used as a throwaway wrapper in `Session::apply()` — the server constructs a `Scene` just to call `scene.apply(cmd)` and then extracts the mutated `DocumentState` back. The server has no use for `Scene` as a concept; it only cares about **DocumentState**. Consider adding `DocumentState::apply(cmd)` directly to avoid this indirection.

- **"Level"** is used for both the data-bearing struct (`Level` with `Vec<u16>` in `lucida-store`) and the metadata-only schedule entry (`LevelSpec`). In the viewer, **Level** is a resolution tier index. In conversation, "level" can mean any of these. Use **Level** for data-bearing instances, **Level Spec** for schedule/metadata-only entries, and qualify with a number when referring to a tier.

- **"Plane" vs "Page"**: a **Page** is a TIFF container concept (one IFD entry); a **Plane** is a logical 2D cross-section of a Volume at a given Z. A Page contains exactly one Plane's worth of pixels, but the terms should not be interchanged — Pages exist in TIFF-land, Planes exist in Volume-land. Avoid "slice" as it's ambiguous between both.

- **"Chunk Size" axis order**: the codebase passes Chunk Size as `[x, y, z]` (matching lucida-core convention), but Zarr metadata stores chunk shape as `[t, c, z, y, x]`. Always state which convention when discussing Chunk Size to avoid transposition bugs.

- **"Scale"** is overloaded: it can mean the **Cumulative Scale** array `[x, y, z]` on a Level Spec, the `SetVolumeScale` command in lucida-core, the **Voxel Size** itself, or the UI zoom. Use **Cumulative Scale** for per-Level factors, **Voxel Size** for physical spacing, and reserve "scale" for UI/rendering contexts.

- **"Store" vs "Dataset"**: a **Store** is the on-disk Zarr directory tree produced by `lucida-store`. A **Dataset** is a loaded volume in the viewer. They represent the same data artifact from producer and consumer perspectives respectively.

- **"Volume"** is overloaded: in `lucida-store`, **Volume** is the in-memory 5D u16 array read from a TIFF (a struct). In the viewer, "volume" loosely refers to the 3D data being rendered. In the data model, the proper viewer-side term is **Dataset**.

- **"Channel"** is overloaded: in `lucida-store`, a **Channel** is the C dimension of a Volume (e.g. fluorescence wavelength). In `lucida-core`, a **Layer** represents the same concept. The data pipeline calls it a Channel; the viewer calls it a Layer.

- **"Viewer" vs "Client"**: the Python SDK class is called `Viewer`, but from the server's perspective it is a **Client** with a **ClientId**. In conversation, use **Viewer** when discussing the Python API and user-facing behavior, **Client** when discussing server-side routing and protocol. A Viewer IS a Client — the distinction is perspective, not type.

- **"Viewport"** is used loosely to mean several things: the Camera's visible screen region (pixel dimensions), the visible voxel region (**VisibleRegion**), and the assembled data result (**ViewportData**). The Python API compounds this by naming the data read/write methods `read_viewport`/`write_viewport`. Use **viewport** only for the pixel dimensions (width, height), **VisibleRegion** for the computed voxel bounds, and **ViewportData** for the assembled numpy result.

- **"Worker"** is overloaded in lucida-web: it can mean the **GPU worker** (WebGPU rendering), an **LZ4 worker** (decompression), or the internal concurrent fetch tasks in **ChunkStore** (also named `runWorker` in code). Always use the qualified form: **GPU worker**, **LZ4 worker**, or "fetch task" for ChunkStore internals.

- **"Seed"/"seeding"** is used for both **Fallback texture** assembly (uploading the coarsest level to the main view on T/C/Z change) and **Minimap** overview loading (uploading the coarsest level to the minimap). Both involve the same data source (coarsest **Level**) but target different GPU textures. Consider distinguishing as "view seeding" vs "minimap seeding" in conversation.

- **"Tile"** appears in slice rendering code (`SliceTile`, `sliceUploadTilesForLayer`) as a synonym for a 2D chunk. The domain term is **Chunk** regardless of dimensionality — avoid "tile" to prevent confusion with the unrelated concept of screen tiling.

- **"Bridge"** has a naming collision potential: `bridge.ts` is the WebSocket client class, but `useBridge` hook adds React state management on top. In code, `Bridge` (capitalized) is the WebSocket class; the hook wraps it with presence tracking, follow mode, and remote dataset setup. In conversation, **Bridge** refers to the WebSocket connection layer, not the React hook.
