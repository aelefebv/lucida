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
| **Data shape** | The full-resolution voxel dimensions of a layer, ordered `[Z, Y, X]` | Layer shape, array shape |
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
| **Pyramid** | An ordered sequence of LevelData instances representing the same Volume at progressively coarser resolutions | Multiscale (use for the Zarr metadata spec), mipmap |
| **LevelData** | A data-bearing struct in `lucida-store` holding the `Vec<u16>` voxel data, width, height, depth, channels, and timepoints for one resolution tier of the Pyramid | Level (old name, ambiguous with tier index) |
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
| **Chunk Size** | The dimensions of a Chunk in `[Z, Y, X]` order (lucida-core convention), controlling the granularity of streaming | Tile size, block size |
| **Codec** | A compression or encoding step applied to raw Chunk bytes before writing to disk; currently raw little-endian bytes followed by LZ4 with prepended size | Compressor, filter |
| **Root Metadata** | The top-level `zarr.json` file declaring the Store as a Zarr v3 group with OME multiscales attributes (axes, per-Level coordinate transforms) | Group metadata |
| **Array Metadata** | The per-Level `{level}/zarr.json` file declaring shape, Chunk grid, Codecs, and data type for one resolution array | Level metadata |
| **Cumulative Scale** | The `[x, y, z]` factor array on a Level Spec expressing how many times coarser this Level is relative to Level 0 | Scale factor, resolution factor |

## Camera system

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Camera** | A tagged enum (`Slice`, `Arcball`, or `Fly`) providing a unified interface for viewport, zoom, visible region, and view-projection matrix computation | Viewport, view |
| **Camera mode** | The string identifier returned by `camera_mode()`: `"slice"`, `"arcball"`, or `"fly"` | View mode (ambiguous with 2D/3D view mode) |
| **Slice** (camera) | A pan/zoom camera for 2D slice viewing, defined by center point, zoom level, and viewport size (serde tag `"slice"`) | View2D (old name), 2D camera |
| **Arcball** (camera) | An orbit camera for 3D volume rendering, using spherical coordinates (theta, phi, distance) around a target point (serde tag `"arcball"`) | View3D (old name), 3D camera, orbit camera |
| **Fly** (camera) | A 6 degrees-of-freedom camera for free 3D navigation, using position and quaternion orientation with frame-rate-independent movement (serde tag `"fly"`) | Fly camera, FPS camera, spaceship camera |
| **Quaternion orientation** | The `[f64; 4]` (x, y, z, w) unit quaternion storing the **Fly** camera's rotation, avoiding gimbal lock; input arrives as euler deltas (yaw, pitch, roll) converted to axis-angle quaternion rotations | Euler angles, rotation matrix |
| **fly_tick** | The per-frame **ViewportCommand** that updates a **Fly** camera: takes `dt`, translation axes (forward/right/up as -1/0/1), and rotation floats (yaw/pitch/roll in radians); all movement math is computed in Rust | Fly update, camera tick |
| **Base speed** | Movement speed derived from the volume's bounding box diagonal (~0.3 diagonals/sec), set when entering **Fly** mode to ensure navigation feels natural regardless of dataset size | Default speed, volume speed |
| **Speed multiplier** | A user-adjustable factor on the **Fly** camera (modified via scroll wheel, ~1.2x per tick) that scales the **Base speed**; persists during a fly mode session | Fly speed, zoom speed |
| **Clip distance** | The distance from the camera within which volume samples are made transparent, stored on both **Arcball** and **Fly** camera structs; defaults to 0.0 for **Arcball** and ~0.5-1% of volume diagonal for **Fly** | Near clip, clipping plane, cut distance |
| **Clip mode** | The shape of the clip region: **Plane** (flat plane perpendicular to the view direction, producing clean cross-sections) or **Sphere** (radial cutaway around the camera position) | Clip type, clip shape |
| **Mouselook** | Mouse drag input in **Fly** mode that applies yaw and pitch via **fly_tick**, providing fine-grained view direction control | Mouse rotation, FPS look |
| **Mode conversion** | The state transformation when switching between camera types: **Arcball** → **Fly** derives position and quaternion from the current view; **Fly** → **Arcball** derives a target point along the view ray and spherical coordinates from the current position | Camera switch, mode switch |
| **VisibleRegion** | The camera-agnostic output of visible region computation: an XY bounding box in voxel space, a Z range, an effective zoom, and optional frustum planes and sort center | Viewport bounds, view bounds |
| **Effective zoom** | Screen pixels per voxel at the focal plane; in 2D this is the zoom value directly, in 3D it is derived from distance, FOV, and voxel density | Scale, magnification, resolution |
| **Frustum planes** | Six clipping planes in full-resolution voxel coordinates, extracted from the view-projection matrix using the Gribb-Hartmann method; used for per-chunk culling in 3D | Clip planes, view planes |
| **Sort center** | The point in voxel space where the camera's center-screen ray intersects the volume surface; used to prioritize chunk loading from the camera's point of interest outward | Focus point, hit point |

## Keybinding system (lucida-web)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Key state tracker** | Layer 1 of the keybinding system: the `useKeyState` hook that listens to `keydown`/`keyup` on the viewer container, maintains a `Set<string>` of pressed keys, clears on blur, suppresses when text inputs are focused, and calls `preventDefault` on bound keys | Key listener, input handler |
| **Keybinding registry** | Layer 2 of the keybinding system: a plain config object mapping action names (e.g. `"fly.forward"`) to key values (e.g. `"w"`), easily changeable without code logic changes | Key map, shortcut config, hotkey registry |
| **Keybinding consumer** | Layer 3 of the keybinding system: a hook or RAF loop that reads the **Key state tracker** and **Keybinding registry** to drive behavior (e.g. `useFlyCameraInput` for fly camera, clip distance adjustment loop) | Key handler, input consumer |
| **Fly camera hint** | A transient overlay shown on every **Fly** mode activation displaying the control scheme ("WASD move · QE up/down · IKJLOU look · Scroll speed"), dismissed on first keypress or after 5 seconds | Controls overlay, keybinding help |

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
| **Command** | A wrapper enum (`Command::Document` / `Command::Viewport`) used for serde-compatible deserialization of both command types | Action, event, message, operation |
| **DocumentCommand** | A command enum (3 variants) that mutates shared DocumentState (AddDataset, RemoveDataset, SetVolumeScale) -- sequenced, persisted, and broadcast to all clients. `ClientMessage::Command` and `ServerMessage::CommandBroadcast` carry this type. | Shared command, sync command, Command (ambiguous) |
| **ViewportCommand** | A command enum (~23 variants) that mutates local-only state (camera, display, view, dataset display settings) -- applied locally and emitted as presence | Local command, ephemeral command, Command (ambiguous) |
| **ClientMessage** | A tagged message sent from a client to the server: Command, Presence, Cursor, Follow, DatasetPresence, or Steer | Client event, upstream message |
| **ServerMessage** | A tagged message sent from the server to clients: Snapshot, CommandBroadcast, Ack, PeerJoined/Left, PresenceUpdate, CursorUpdate, FollowChanged, DatasetPresenceUpdate | Server event, downstream message |
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
| **UnicastRoutes** | The shared map of ClientId to per-client unbounded mpsc senders, used for unicast chunk routing | ClientSenders (old name), unicast map, client channels |
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

## Peer cursors (lucida-web)

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Peer cursor** | A WebGPU-rendered cursor showing where a **Peer** is pointing, identified by color (deterministic from **ClientId**) and a numeric ID label. In 2D mode: a crosshair at voxel coordinates. In 3D mode: a billboard ray through or near the volume with a crosshair marker at the intersection point | Remote cursor, user pointer |
| **Cursor position** | In 2D: voxel-space `[x, y]` coordinates. In 3D: normalized screen coordinates `[0-1]`. Transmitted as `Option<[f64; 2]>` (null = cursor off canvas) | Screen position (ambiguous) |
| **Cursor ray** | A billboard quad strip rendered in 3D mode showing a **Peer**'s line of sight through the volume. For 2D→3D peers: a vertical ray at the peer's voxel position. For 3D→3D peers: the unprojected ray from the peer's camera through their cursor. Extends 50% past the volume on each end for visibility. Portions behind the volume surface render at 30% opacity via depth texture sampling | Cursor line, sight line |
| **Cursor marker** | A crosshair rendered at the ray's intersection point with the volume surface (entry point for 3D→3D, peer's Z slice for 2D→3D), providing a focal anchor for where the peer is pointing | Hit point, intersection indicator |
| **Cursor geometry engine** | The Rust module (`cursor.rs`) that computes GPU-ready cursor geometry (crosshairs and rays) and screen-space label positions from peer presence data. Handles all cross-mode combinations (slice↔arcball↔fly). Fly and Arcball peers are treated equivalently as "3D" for cursor rendering. Computation is receiver-side using the peer's camera from **PresenceState** | Cursor computer |
| **Dimensional indicator** | A visual badge (◄/► for T, channel number for C) shown next to a **Peer cursor** label when the peer's **ViewState** differs from the local view, accompanied by 50% opacity dimming. Z indicators are suppressed in 3D mode since Z is a visible spatial axis | Slice indicator, Z arrow |
| **Cursor label** | The HTML overlay div showing the peer's **ClientId** and **Dimensional indicator**, positioned using screen coordinates from the **Cursor geometry engine**. Rendered separately from the GPU geometry to support text rendering | Cursor badge, peer badge |
| **Volume depth texture** | A `depth24plus` GPU texture written by the volume ray march at the first significant opacity sample. Used by the cursor shader to determine whether cursor fragments are in front of or behind the volume surface for opacity dimming | Depth buffer, Z-buffer |

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
- A **Camera** is exactly one of **Slice**, **Arcball**, or **Fly**; all three produce a **VisibleRegion** and view-projection matrix through the unified Camera enum interface
- A **Fly** camera carries a **Quaternion orientation**, **Base speed**, **Speed multiplier**, **Clip distance**, and **Clip mode**
- An **Arcball** camera carries a **Clip distance** and **Clip mode**
- **Mode conversion** between **Arcball** and **Fly** preserves approximate eye position and view direction; **Fly** → **Arcball** resets **Clip distance** to 0.0
- A **Camera** produces a **VisibleRegion** given the current **ViewState** and optional **VolumeTransform**
- A **VisibleRegion** is consumed by chunk planning to produce a **ChunkRequestPlan**
- A **ChunkRequestPlan** contains a `needed` list and a `prefetch` list of **ChunkCoords**
- A **Command** is either a **Document command** (broadcast) or a **Viewport command** (local + presence)
- A **PresenceState** bundles one client's **Camera**, **ViewState**, **DisplayState**, follow target, cursor, **Dataset order**, and **DatasetDisplaySettings**
- A **Client** may **Follow** at most one other **Client**; a **Client** being followed cannot itself be following anyone (max chain depth = 1)
- A **ChunkRequest** from a viewing **Client** produces a **ChunkFetch** to the **Data Source**, which responds with **Chunk Data** routed back via **Unicast**
- A **Snapshot** is sent exactly once per **Client** — on connect, before any **Broadcast** messages
- A **Volume** is read from a TIFF file whose **Pages** are reordered according to the **Dimension Order** into canonical TCZYX layout
- **Dimension Hints** override **OME-XML**; both override defaults (T=1, C=1, Z=num_pages, order=XYZCT)
- A **Downsample Schedule** is computed once from the Volume's dimensions, **Voxel Size**, and a minimum size threshold (256)
- A **Pyramid** contains one or more **Levels**, where Level 0 is the full-resolution **Volume** and each subsequent Level is produced by **Downsampling** the previous one
- Each **Level Spec** records which axes to downsample, informed by **Anisotropy** via the **Uniquely Coarsest** rule
- A **Store** contains **Root Metadata** (one group) and one **Array Metadata** + set of **Chunks** per **Level**
- **Chunk Size** is specified in `[Z, Y, X]` order in code but written to Zarr metadata in TCZYX order as `[1, 1, z, y, x]`
- A **Store** is the producer-side name for what the viewer loads as a **Dataset**
- A **Viewer** holds exactly one **Scene** and zero or one **Follow** target
- A **Viewer** is a **Client** from the Server's perspective, assigned a **ClientId** on connect
- A **Viewer** may become a **Data Source** by calling `write_viewport`, serving **Chunks** from in-memory storage to other **Peers**
- A **ViewportData** is assembled from the **Chunks** listed in a **ChunkRequestPlan**'s `needed` list, and records its **Origin** within the **Level** shape
- In **Local Mode**, a **Viewer** reads **Chunks** directly from a **Store** on disk; in **Remote Mode**, it sends **ChunkRequests** through the **Server**
- A **ChunkStore** wraps exactly one **ChunkFetcher** and maintains a cache of **Chunk keys** to decompressed ArrayBuffers
- An **Atlas** contains a GPU texture, an **Indirection buffer**, and a slot-tracking map; one **Atlas** exists per **Dataset** per render mode (slice or volume)
- A **Fallback texture** is assembled from all chunks of the coarsest **Level** via **Seeding**; the shader samples it when the **Indirection buffer** returns the sentinel value
- The **GPU worker** lazily creates one `SliceRenderer`, one `VolumeRenderer`, one **Compositor**, and one `CursorRenderer`; all share the same `GPUDevice`
- The **RenderClient** sends chunk data to the **GPU worker** via the **Worker protocol** using `Transferable` ArrayBuffers (zero-copy ownership transfer)
- The **Render loop** delegates chunk planning to **WasmScene** (`chunk_plan_for`), fetching to a **ChunkStore**, and rendering to the **RenderClient**; it never touches the GPU directly
- The **Upload budget** limits how many chunk bytes move from **ChunkStore** to **Atlas** per RAF tick, preventing GPU stalls and maintaining interactive frame rates
- The **Bridge** is instantiated once when the WASM module is ready and auto-reconnects on disconnect with a 2-second delay
- A **Peer cursor** is computed by the **Cursor geometry engine** from peer **PresenceState** (camera, cursor, view) and rendered as WebGPU geometry (crosshair or ray) after the **Compositor** pass
- A **Cursor position** is throttled at 50ms (same as **Presence**); null positions bypass the throttle and send immediately
- Cross-mode cursors are supported: a 2D peer's cursor appears as a **Cursor ray** in a 3D view (and vice versa as a crosshair at the Z-plane intersection)
- The **Cursor geometry engine** performs receiver-side computation: it uses the peer's camera from **PresenceState** to unproject 3D cursors, with no protocol changes
- A **Dimensional indicator** compares the peer's **ViewState** (T/C) against the local **ViewState** and renders directional arrows plus opacity dimming; Z indicators are suppressed in 3D mode
- A **Cursor label** uses a RAF loop for positioning because the **Camera** is mutated imperatively during drag, not through React state; 3D label positions are projected through the local **Camera**'s view-projection matrix
- The **Volume depth texture** is written during volume rendering and read by the cursor shader to dim ray fragments behind the volume surface to 30% opacity
- The **Key state tracker** is mounted once on the viewer container; multiple **Keybinding consumers** read from the same key state
- The **Keybinding registry** maps action names to keys; consumers look up actions through `isActionPressed()` without touching DOM events
- A **Fly camera hint** is shown on every **Fly** mode activation and dismissed by the first keypress or a 5-second timeout
- **Clip distance** is serialized with presence via the camera structs, so **Follow** mode reproduces the leader's clip settings

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

> **Dev:** "How does the **Peer cursor** know where to render when I'm zoomed in and the peer is zoomed out?"
> **Domain expert:** "In 2D, the **Cursor position** is always in voxel coordinates. The **Cursor geometry engine** converts to GPU-ready crosshair geometry, and the shader transforms through the local **Camera**'s zoom and center. So it always points at the same anatomical location regardless of zoom. In 3D, the cursor is a **Cursor ray** — the engine unprojects the peer's screen cursor through their **Arcball** or **Fly** camera and clips the ray to the volume."

> **Dev:** "What if the peer is in 2D and I'm in 3D?"
> **Domain expert:** "The **Cursor geometry engine** handles all cross-mode combinations — **Slice**, **Arcball**, and **Fly** are all supported. A **Slice** peer's cursor becomes a vertical **Cursor ray** through the volume at their voxel (x, y), with a **Cursor marker** at their Z slice. **Fly** and **Arcball** peers are treated equivalently as 3D for cursor rendering."

> **Dev:** "What if the peer is looking at a different Z slice?"
> **Domain expert:** "In 2D mode, the **Dimensional indicator** shows ▲/▼ for Z differences, ◄/► for T, and channel numbers for C, with 50% opacity dimming. In 3D mode, Z indicators are suppressed — Z is a spatial axis you can see directly, so the **Cursor marker** on the ray already shows their Z position. T and C indicators still apply in both modes."

> **Dev:** "How does the **Fly** camera differ from the **Arcball** camera?"
> **Domain expert:** "The **Arcball** orbits a fixed target using spherical coordinates — great for inspecting from outside. The **Fly** camera has 6 degrees of freedom: position plus a **Quaternion orientation** for gimbal-lock-free rotation. You move with WASD/QE, look with IKJLOU or **Mouselook**, and adjust speed with the scroll wheel. The **Base speed** is set from the volume diagonal when you enter **Fly** mode, and the **Speed multiplier** lets you fine-tune from there."

> **Dev:** "What happens when I switch between **Arcball** and **Fly**?"
> **Domain expert:** "**Mode conversion** preserves your viewpoint. **Arcball** → **Fly** derives the position from `eye_position()` and the **Quaternion orientation** from the view direction. **Fly** → **Arcball** picks a target along the view ray — the volume center if it's in front, otherwise a point at default distance — and computes spherical coords from there. The **Clip distance** resets to 0.0 on switch to **Arcball**."

> **Dev:** "What is the **Clip distance** for?"
> **Domain expert:** "When you're flying inside a volume, samples right against the camera create visual clutter. The **Clip distance** makes everything between the camera and a configurable distance transparent. In **Plane** **Clip mode**, it's a flat plane perpendicular to the view direction — you get clean cross-sections. In **Sphere** mode, it's a radial cutaway. Both **Arcball** and **Fly** carry clip settings, and they serialize with **Presence** so followers see your clipping too."

> **Dev:** "How does the **Keybinding system** work?"
> **Domain expert:** "Three layers. The **Key state tracker** — `useKeyState` — listens to keydown/keyup on the canvas, tracks a `Set` of pressed keys, and handles edge cases like clearing on blur and ignoring text inputs. The **Keybinding registry** is a plain config object mapping action names to keys. **Keybinding consumers** read from both — `useFlyCameraInput` polls the key state each RAF frame and feeds it into **fly_tick**, the clip distance loop reads bracket keys. No event bus, just a shared `Set`."

## Overloaded terms

These terms have multiple meanings depending on context. The glossary tables above define each precisely — this section provides quick disambiguation guidance.

- **"Zoom"**: In **Slice**, a direct scale factor. In **Arcball**, **Effective zoom** is derived from distance, FOV, and voxel density. In **Fly**, it is derived from FOV and voxel density at the volume surface. The chunk planner normalizes all into pixels-per-voxel.

- **"Plane" vs "Page"**: A **Page** is a TIFF container concept (one IFD entry); a **Plane** is a logical 2D cross-section of a Volume at a given Z. Avoid "slice" — it's ambiguous between both.

- **"Chunk Size" axis order**: Code passes `[Z, Y, X]` (lucida-core convention); Zarr metadata stores `[t, c, z, y, x]`. Always state which convention.

- **"Scale"**: Use **Cumulative Scale** for per-Level `[x, y, z]` factors, **Voxel Size** for physical spacing, and "scale" for UI/rendering contexts only.

- **"Store" vs "Dataset"**: A **Store** is the on-disk Zarr directory tree (producer). A **Dataset** is the same artifact loaded in the viewer (consumer).

- **"Volume"**: In `lucida-store`, the in-memory 5D u16 array struct. In the viewer, the proper term is **Dataset**.

- **"Channel"**: In `lucida-store`, the C dimension (fluorescence wavelength). In `lucida-core`, a **Layer** represents the same concept.

- **"Viewer" vs "Client"**: **Viewer** for the Python SDK API, **Client** for server-side protocol. Same entity, different perspective.

- **"Viewport"**: Use **viewport** for pixel dimensions, **VisibleRegion** for computed voxel bounds, **ViewportData** for the assembled numpy result.

- **"Seed"/"seeding"**: Both view seeding and minimap seeding fetch the coarsest level into a texture. Distinguish as "view seeding" vs "minimap seeding" in conversation.

- **"Bridge"**: `Bridge` is the WebSocket client class. `useBridge` is the React hook that adds state management on top.

- **"Worker"**: Always qualify — **GPU worker**, **LZ4 worker**, or **fetch task** (for ChunkStore internals).

- **"Cursor"**: In PresenceState, the raw `Option<[f64; 2]>` coordinate data (voxel coords in 2D, normalized screen coords in 3D). In the UI, the rendered **Peer cursor** (crosshair or ray + label). Use **Cursor position** for the data, **Peer cursor** for the visual, **Cursor ray** for 3D ray geometry.

- **"Clip"**: **Clip distance** is the volume-rendering near clip that makes samples transparent. **Frustum planes** (sometimes called "clip planes") are the chunk-culling planes from the view-projection matrix. These are unrelated — **Clip distance** affects ray marching tStart, **Frustum planes** affect chunk loading.

- **"Speed"**: **Base speed** is the volume-diagonal-derived constant set on entering **Fly** mode. **Speed multiplier** is the user-adjustable factor from scroll wheel. Actual movement = **Base speed** × **Speed multiplier** × dt. Don't use "speed" alone — always qualify which.

- **"Mode"**: **Camera mode** is the specific camera variant (slice/arcball/fly). View mode is the 2D/3D rendering mode. Both **Arcball** and **Fly** are 3D view modes — distinguish with "**Camera mode** is fly" vs "view mode is 3D".
