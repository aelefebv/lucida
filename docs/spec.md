# Lucida: N‑Dimensional Image Viewer (Streaming‑First) — Specification

## 0. Executive summary

Lucida is a lightweight, high‑performance N‑dimensional image viewer designed for TB‑scale microscopy datasets and multi‑device collaboration. Unlike desktop‑centric viewers, Lucida is **streaming‑first** and **WebGPU‑rendered**: interactive clients (browser, Jupyter embed, desktop shell) render locally on the GPU and fetch immutable **tiles** (2D) and **bricks** (3D) over HTTP. A headless **Lucida Engine** is authoritative for session state, history, ingest/build jobs, permissions, and audit logging.

Lucida emphasizes:
- Fast interaction on huge data via multiscale + chunked streaming + client‑side rendering.
- A unified command/state model usable from Jupyter (`viewer.add_image…`), CLI (`lucida pan …`), and LLM agents.
- Reproducible “what I saw” artifacts (Context Packages) and sharable Scene files.
- A first‑class loop for targeted prototyping: **capture ROI chunks → compute → publish sparse derived layer chunks**.

---

## 1. Glossary

- **Engine**: Headless Lucida Engine process that owns authoritative state and serves data/control planes.
- **Client**: WebGPU rendering frontend (browser, Jupyter embed, desktop shell).
- **Session**: A running viewer context with state, history, connected clients, and data references.
- **Scene**: Shared scene state (layers, transforms, targets, derived layers). May be live (`@working`) or pinned.
- **View state**: Per‑client camera/indices and per‑client rendering knobs.
- **Source**: An external dataset location (OME‑Zarr) that may update over time.
- **Canonical cache**: Lucida‑managed OME‑Zarr multiscale store derived from a source (interoperable baseline).
- **Stream store**: Lucida streaming representation used by clients (2D tiles + 3D bricks + previews), stored within/alongside canonical cache.
- **Generation**: A specific “snapshot” of a source’s derived stream store. `@working` advances to new generations on source changes.
- **LOD**: Level of detail (multiscale pyramid level). LOD0 = full resolution.
- **Tile**: 2D chunk payload (typically 512×512 at a particular LOD).
- **Brick**: 3D chunk payload (shape varies; tuned to ~1MB uncompressed per brick per channel block).
- **Target**: Shared bookmark/ROI object for repeatable navigation and prototyping cutouts.
- **RegionRecipe**: Deterministic description of data needed for a cutout at a given LOD (including halo).
- **Derived layer**: Sparse layer whose content is published chunk‑aligned in patches (used for prototyping outputs).
- **Lease**: Floor‑control lock for shared scene edits.
- **Control token**: Capability credential for editing shared scene state and publishing derived chunks.
- **View token**: Optional credential for read access when token‑view mode is enabled.
- **Lucida Context Package (LCP)**: A bundle containing rendered images + minimap + metadata sufficient to reproduce the visualization and enable LLM control.
- **Scene file**: A lightweight artifact describing a scene configuration (layers/transforms/targets), typically referencing datasets by URI and generation pins or `@working`.

Normative language: **MUST**, **SHOULD**, **MAY** are used in the RFC‑style sense.

---

## 2. Product goals and non‑goals

### 2.1 Goals

1. **Streaming‑first, WebGPU‑rendered** clients that scale to TB data and multi‑device viewing.
2. **Authoritative engine** with a single source of truth for session state and history.
3. **Unified control surfaces**: Jupyter/Python API, CLI, browser UI, and LLM control all map to the same canonical commands and state.
4. **High‑dimensional support**: canonical axes TCZYX plus leading optional axes (positions/rounds/scenes/…).
5. **Dual representation** for performance:
   - 2D tile pyramid optimized for 2D browsing + minimap
   - 3D brick pyramid optimized for orthoslices and volume rendering
6. **Fast ROI prototyping loop**:
   - generate RegionRecipe from view/Target
   - materialize chunked cutout (full‑res by default)
   - publish chunk‑aligned results back into sparse derived layers
7. **Reproducibility + shareability**:
   - Scene files for configuration sharing
   - Context Packages for “what I saw” share + LLM ingestion
8. **Collaboration**:
   - per‑client view state by default
   - shared scene state with audit log and lease‑based edits
9. **Modularity**:
   - explicit extension points for loaders, ingest transforms, renderers, commands, metadata providers.

### 2.2 Non‑goals (explicitly out of scope for this spec draft)

- Full desktop‑native GUI framework parity with napari (Qt plugin ecosystem).
- In‑place raster editing of labels (painting) as a core feature (labels are view‑only).
- Guaranteed best‑possible performance from arbitrary unchunked/mono‑scale sources without conversion.
- Pixel‑streaming “video broadcast” as a primary mode (tile/bricks streaming is primary; broadcast is optional future).

---

## 3. System architecture

### 3.1 High‑level components

**Lucida Engine**
- Authoritative session state and history
- Source registration and watch
- Derived cache build: canonical OME‑Zarr multiscales + stream store (2D/3D + previews)
- Authentication and permissions (view/control tokens)
- Shared scene edit lease and audit log
- Control plane server (commands/events/state)
- Data plane server (tile/brick/previews payloads) or mapping to static URLs

**Lucida Client**
- WebGPU renderer (2D, 3D orthoslices, MIP/slab, raymarch)
- Local CPU cache (decoded chunks) and GPU cache (textures)
- Input handling (mouse/keyboard/touch) → canonical command emission
- Client‑side LOD selection, request prioritization, and cancellation
- Minimap rendering and overlays
- Context Package capture (images + metadata)

### 3.2 Transport planes

**Control plane**
- Bidirectional channel (WebSocket or WebTransport; exact transport TBD by implementation)
- Carries:
  - command messages (canonical JSON ops)
  - authoritative state diffs/events
  - lease events
  - audit notifications
  - metadata update events
  - capability handshake (device limits, codec support, budgets)

**Data plane**
- HTTP(S) fetch of immutable payloads by chunk key
- Optimized for caching at browser, proxy, CDN layers
- Engine MAY serve endpoints directly (LAN/local)
- Engine MAY mint static URLs (future cloud/CDN) using the same chunk key scheme

---

## 4. Sessions, state, and commands

### 4.1 Session model

A **Session** is a named entity hosted by the engine. Clients attach and receive:
- shared scene state (authoritative)
- their own per‑client view state
- the current shared‑scene lease holder
- permissions and token scopes

Sessions MUST support multiple simultaneous clients.

### 4.2 Shared scene state vs per‑client view state

Lucida MUST separate shared and per‑client state to avoid “fighting the mouse.”

**Shared scene state** (requires control token + lease)
- data sources and dataset references
- layer stack (image/labels/points/derived), ordering, blend modes
- per‑layer world transforms (affine)
- Targets (shared by default)
- derived layers definitions and dependency policies
- minimap overview policy (default layer or pinned overview layer)
- shared defaults (optional, explicitly set)

**Per‑client view state** (allowed for view‑only clients)
- camera pose / target / projection parameters
- per‑client indices (t, z, c selection list, etc.)
- active layer selection
- per‑client rendering knobs (contrast, gamma, opacity, colormap, label outlines, filter UI state)
- per‑client bookmarks or private targets

Clients MAY “promote” their current rendering knobs to shared defaults via an explicit scene edit.

### 4.3 Command model

All control operations MUST be expressible as canonical JSON commands with schemas.

Each command MUST specify:
- `op`: string operation name (namespaced)
- `scope`: `client_view` | `scene_shared` | `admin`
- `requires_lease`: boolean (true for `scene_shared` edits)
- `args`: typed parameters
- `client_seq`: monotonically increasing client sequence for reconciliation
- `client_id`

The engine responds with:
- `ack`: `{client_seq, server_rev, accepted|rejected, reason?}`
- state diff events (authoritative)

CLI and Python APIs are thin frontends that generate these canonical commands.

### 4.4 Gesture transactions and checkpointing

Continuous interactions MUST be modeled as gesture transactions:
- `gesture.begin`
- `gesture.update` (high frequency, transient)
- `gesture.end`

Engine checkpointing policy:
- checkpoints occur at `gesture.end` OR after a settle debounce window (no input for N ms)
- intermediate updates do NOT generate durable history nodes by default

History MUST be a DAG internally (branching allowed). Default UI exposes a linear undo/redo view over checkpoints.

### 4.5 Client prediction and reconciliation

Clients MAY apply predicted view updates locally for responsiveness.
Engine is authoritative:
- clients send commands with `client_seq`
- engine acks and emits authoritative state diffs
- if client diverges, it MUST reconcile by easing camera/transform values back to authoritative values (no snapping unless divergence exceeds thresholds)

---

## 5. Permissions, lease, and audit

### 5.1 Tokens

Lucida supports:
- **View access**:
  - default LAN mode is open‑view (no token required)
  - optional token‑view requires a **view token** (shareable link includes token)
- **Control access**:
  - requires a persistent **control token**, until revoked
  - multiple control tokens supported concurrently

### 5.2 Shared scene edit lease (floor control)

Shared scene edits require holding a **lease**.
- Any control‑token client can request or steal the lease.
- Lease changes are passive notifications to clients.
- Lease events MUST be recorded in audit log.
- Optional idle timeout MAY be used for convenience, but “steal” semantics prevent deadlock.

### 5.3 Publishing derived chunks without lease

Publishing chunk patches to an existing derived layer:
- MUST require a control token
- MUST NOT require holding the shared scene edit lease (default)
- conflict resolution is last‑write‑wins per chunk (see below)
- all writes MUST be audit logged

Creating/deleting/reordering layers and defining derived layer metadata is a shared scene edit (requires lease).

### 5.4 Audit log

Engine MUST maintain an append‑only audit log for:
- shared scene edits (commands + actor + timestamps)
- lease events
- derived layer publish batches (including chunk keys touched)

Control tokens SHOULD be human‑labeled (device/user name) and included in audit entries.

---

## 6. Axes, coordinates, and transforms

### 6.1 Canonical axes

Lucida canonical axis suffix: **TCZYX**.

Optional “extra” axes (positions/rounds/scenes/…) are leading:
- canonical shape order is **E…TCZYX**

Source axes MUST be mapped into this canonical order; original axis names/order MUST be preserved in metadata mapping.

### 6.2 World space and calibration

World space is first‑class:
- every layer has an index→world transform (affine)
- voxel spacing MAY be unknown; then the layer is “uncalibrated” and default spacing is 1.0 in index units
- overlays between calibrated and uncalibrated layers are allowed with warnings

Measurements:
- show physical units only when calibrated
- otherwise show voxel/index units and display an uncalibrated warning badge

Per‑layer affine transforms are core; non‑linear warps are plugin territory.

---

## 7. Data sources, generations, and ingest

### 7.1 Source watching

Lucida uses watcher‑only detection (no manifests).
- Any detected file/directory change triggers a new `@working` generation.
- Granularity is coarse: “any change → generation bump” (acceptable by design).

### 7.2 Stability window (default)

To avoid mid‑write ingest:
- debounce S = **2 seconds** of no filesystem events

### 7.3 Central Lucida cache directory

Derived caches are stored in a central Lucida cache directory by default, with optional overrides per source/project.

### 7.4 Canonical cache and stream store

Lucida MUST build derived representations from sources for interactive viewing. Clients do not render directly from raw sources.

Derived outputs:
1. **Canonical cache**: OME‑Zarr multiscale arrays (interoperable baseline)
2. **Lucida stream store**: 2D tile representation (often identical to canonical if chunked right), plus `/lucida/brick3d/` brick multiscales and previews

### 7.5 Working generations and GC

`@working` advances as sources update.
- Lucida does not retain long working history by default.
- GC policy default: keep latest + one previous for a short TTL (e.g., minutes), then delete old generations unless pinned.
- Pinning/committing produces a durable generation/version that is not GC’d unless explicitly removed.

### 7.6 Trickle‑in updates and generation consistency

Clients may switch to the latest working generation immediately; data refines as tiles/bricks are built.

Invariant: a rendered frame MUST NOT mix tiles/bricks from different generations for the same layer. Refinement MUST occur within a generation only (coarse→fine).

---

## 8. Representations, chunking, LOD, and encoding

### 8.1 Dual representations

Lucida requires:
- **2D tiles** for 2D browsing/minimap
- **3D bricks** for 3D orthoslices and raymarch

3D bricks are built lazily on first use of 3D mode (acceptable), with coarse bricks built first.

### 8.2 LOD policy (multiscale)

Downsampling policy:
- 2D tiles: downsample XY always; Z downsample MAY be adaptive
- 3D bricks: downsample XYZ adaptively (policy C), to support coherent 3D LOD

LOD selection authority:
- Clients choose LOD based on device limits, screen resolution, target FPS
- Engine reports availability/build progress and MAY provide suggestions

### 8.3 2D tile size

Default 2D tile shape: **512×512** (at each LOD).

### 8.4 3D brick sizing

3D bricks should be approximately cubic in world space to accommodate anisotropy.
- brick shapes MAY vary per LOD
- target uncompressed payload size ≈ **1 MB per brick per channel block**
- shapes MUST be clamped by WebGPU device limits

### 8.5 Channel blocking

Image payloads use channel blocking to reduce request count:
- default channel block size: **4**
- per‑layer configurable

Chunk keys include `c0` (block start). Payload includes channels `c0..c0+block_size-1`. Client composites only selected channels.

Labels remain single‑channel (C=1).

### 8.6 Chunk keys

Chunk keys MUST uniquely identify a payload. Fields:
- dataset_id
- generation_id
- layer_id
- representation: `tile2d` | `brick3d` | `preview2d`
- lod
- index_key: packed non‑spatial indices (t + extras + z (tiles only))
- c0: channel block start (tiles/bricks only)
- coords: (ty,tx) or (bz,by,bx)

Chunk keys MUST map to URLs that can be served by engine endpoints or static hosting.

### 8.7 Payload encoding

Quantitative payloads:
- compressed typed arrays with a small header:
  - version
  - dtype enum
  - chunk shape
  - endianness
  - uncompressed byte count
  - codec id
- codec negotiated via capability handshake
  - default preference: **zstd**
  - optional: **lz4**

Preview payloads:
- default: **WebP**
- fallback: **PNG**

---

## 9. Rendering and layer model

### 9.1 Core layer types

Core:
- **Image layer**: scalar intensity, multi‑channel
- **Labels layer**: integer IDs, view‑only
- **Points layer**: points with metadata (for detections, etc.)
- **Derived image/labels layers**: sparse chunk‑published layers

Non‑core layer types are plugin territory.

### 9.2 Blend modes

Core blend modes are a small fixed set:
- alpha over
- additive
- max
- screen

### 9.3 Per‑client rendering knobs

By default (per‑client):
- channel visibility list
- per‑channel contrast limits, gamma
- per‑channel colormap / LUT selection
- layer opacity
- interpolation
- label outline thickness / style
- filter UI toggles

Clients MAY promote settings to shared defaults via explicit scene edits.

### 9.4 3D modes

Core 3D modes:
- orthoslices
- MIP/slab
- volume raymarch

In 3D mode, orthoslices MUST sample from 3D bricks (not 2D tiles).

---

## 10. Labels: outlines, metadata, filtering

### 10.1 Outlines/contours

Labels outline rendering is core.
- implemented client‑side (shader) via neighbor ID comparisons
- thickness adjustable
- works in 2D slices and orthoslices

### 10.2 Sparse millions of IDs → dense remap

For interactive filtering at scale:
- label stream store uses `dense_id` in [0..N‑1]
- mapping `original_id ↔ dense_id` stored in sidecar
- dense IDs anchored on original_id where possible
- no recycling by default; new IDs append; holes allowed
- explicit “compact/reindex” operation MAY create a new mapping epoch

### 10.3 Metadata sidecars

Lucida‑managed sidecars store object metadata keyed by label ID.
Default storage: SQLite (hot‑reloadable), optional Parquet export.

Sidecar revisions are tracked; metadata updates trigger automatic filter recompute and visibility refresh.

### 10.4 Filtering DSL

Filtering uses a structured DSL (JSON AST preferred). Operators:
- comparisons: =, !=, <, <=, >, >=
- boolean: AND, OR, NOT
- IN
- string ops: CONTAINS, STARTS_WITH (optional)
- null checks: IS_NULL, IS_NOT_NULL

Unknown metadata rows policy:
- default: show unknown
- option: hide unknown

### 10.5 Filter results transport

Engine returns a visibility mask as a bitset over dense IDs.
- may be compressed on wire (encoding tag)
- client reconstructs and uploads to GPU for O(1) visibility checks

---

## 11. Targets, RegionRecipes, cutouts, and derived writeback

### 11.1 Targets (shared by default)

Targets are shared scene objects (create/edit requires lease). Jumping to a target is per‑client.

Targets store:
- navigation state (camera pose/target; 2D/3D mode)
- default analysis ROI:
  - by default: viewport bounds at save time in world coords
  - deterministically snapped to chunk grid at requested LOD
- per‑target defaults (shared defaults; override per request):
  - cutout LOD policy (full/match_view/int)
  - halo size (chunks at LOD or world units)
  - publish extent default (halo by default)
  - channel policy default (visible)
  - 2D z mode default (single plane)

### 11.2 RegionRecipe

A RegionRecipe is deterministic metadata describing a cutout:
- base layer reference (dataset + generation + layer)
- representation (`tile2d` or `brick3d`)
- requested LOD (full/match_view/int resolved to concrete lod)
- ROI bounds (world + index)
- chunk grid and chunk key set for ROI
- halo chunk key set
- core vs halo partition
- channel selection policy + resolved channel blocks
- transforms required to align outputs back to scene

Recipes are ephemeral by default but may be saved as named artifacts if needed.

### 11.3 Cutouts

Cutouts are materializations of a RegionRecipe:
- default is chunked interface (Zarr‑like), adapters can densify
- default LOD is full (LOD0), but `match_view` and explicit LOD are supported
- default channels are visible channels only; explicit channel list allowed
- 2D default is single Z plane; slab is requestable
- 3D default centered on camera target (Targets provide repeatable ROIs)

### 11.4 Derived layers and writeback

Derived layers are sparse by default:
- missing chunks are transparent/no contribution
- derived image layers must share the same spatial grid and world transform as their base, but may choose dtype and output channel count

Publishing:
- chunk‑aligned writes only
- publish extent default: halo (publish all materialized chunks)
- optional: core‑only publish
- overwrite existing derived layer vs create new derived layer is caller‑selectable
- publish requires control token but not lease
- last‑write‑wins per chunk; audit log required
- optional per‑layer write ACL

Derived layers remain visible when base updates, with a warning about dependency mismatch. Default dependency policy is pinned‑to‑base‑generation; “follow working” is optional and explicit.

Derived layers computed at LOD>0:
- derived layers never auto‑generate finer‑than‑computed LODs
- rendering may upsample nearest available derived LOD to remain visible, but MUST display “computed at LODk” indicator
- strict mode MAY disable upsampling beyond native detail (optional)

---

## 12. Scene files and Context Packages

### 12.1 Scene files

Scene files capture shared scene configuration:
- sources/datasets referenced (URI + generation pin or `@working`)
- layer stack and transforms
- targets and defaults
- minimap policy
Scenes may be live (`@working`) or pinned.

Export/share SHOULD default to pinned or present a warning when exporting live scenes.

### 12.2 Lucida Context Package (LCP)

Default: thin + guaranteed visual.
LCP MUST include:
- rendered viewport image (exact pixels captured)
- minimap image (with viewport overlay)
- full scene + view metadata required to reproduce visualization
- dataset/layer references including exact generations
- warnings flags (uncalibrated overlays, dependency mismatch, computed‑at‑LODk)
- command schemas or references (for LLM control)

LCP SHOULD open even without dataset access (“frozen view”). If dataset access is available, LCP rehydrates into interactive session at the same view state.

Optional mode: thick‑minimal
- embed only the minimal subset of tiles/bricks required to reproduce that view offline, at the captured LODs, plus margin

Reproducibility: LCP MUST include enough information so a collaborator can reopen and see the same visualization (within rendering determinism limits).

---

## 13. APIs

### 13.1 Python (Jupyter) API principles

Python client is a thin wrapper over canonical commands/state:
- `viewer.add_image(source_or_dataset_ref, …)`
- `viewer.add_labels(…)`
- `viewer.layers[…]` for layer properties (mapped to per‑client or shared edits)
- `viewer.dims.set_point(axis, value)`
- `viewer.camera.pan/zoom/rotate`
- `viewer.targets.add(name=…, from_current_view=True, …)`
- `viewer.cutout(target=…, lod="full", halo=…, channels="visible")`
- `viewer.publish(layer=…, overwrite=True|False, extent="halo"|"core")`
- `viewer.snapshot_context_package(path=…)`

### 13.2 CLI principles

CLI is a frontend to canonical commands:
- `lucida sessions list`
- `lucida attach <session>`
- `lucida open <path|uri>`
- `lucida pan --dx … --dy …`
- `lucida set --z … --t … --channels 0,2,4`
- `lucida overview` (returns human summary and JSON option)
- `lucida snapshot --out <lcp.zip>`
- `lucida target add --name … [--from-view]`
- `lucida cutout --target … --lod full|match_view|N --halo …`
- `lucida publish --layer … --overwrite|--new --extent halo|core`

CLI SHOULD default to JSON output for machine use, with a `--human` option.

---

## 14. Performance, caching, and prefetch

### 14.1 Client‑driven LOD selection

Client chooses LOD based on:
- screen resolution
- target FPS
- device texture limits
- decode/upload throughput
- network latency/bandwidth

Engine reports availability/build progress.

### 14.2 Request scheduling and cancellation

Clients SHOULD:
- prioritize current viewport tiles/bricks first
- prefetch predicted motion direction
- prefetch refinement one LOD finer when zooming in
- cancel stale in‑flight requests when view changes
- apply backpressure to avoid saturating CPU/GPU upload budgets

### 14.3 Caches

Clients maintain:
- CPU cache of decoded chunks (bounded)
- GPU cache of textures (bounded)
Eviction should be LRU‑like with priority for current view + predicted view window.

Engine caches:
- derived payloads and build artifacts
- may include server‑side RAM caches, but primary scaling assumes HTTP caching and immutable addressing.

---

## 15. Plugin and extension model (modularity)

Lucida should be modular with explicit extension points:

Engine‑side plugins MAY provide:
- new source loaders / auth providers / URI schemes
- ingest transforms producing additional derived representations
- server‑side compute endpoints (optional)
- command extensions (must provide schema + reducer)

Client‑side plugins MAY provide:
- additional layer renderers (shader modules + compositing rules)
- UI panels and interaction tools
- visualization effects (optional)

Any plugin affecting state MUST integrate via canonical command schemas to preserve reproducibility and LLM control.

---

## 16. Determinism and reproducibility requirements

- Engine state + commands must be sufficient to reconstruct the scene configuration deterministically.
- Frames must not mix generations for a layer.
- Context packages must record effective LOD/resolution details sufficient to reproduce the same visualization (or explicitly annotate differences).
- Derived layers computed at LOD>0 must be clearly labeled; no silent “fake detail.”

---

## 17. Default parameters (confirmed)

- Source stability window: debounce 2s
- 2D tile size: 512×512
- Channel block size: 4 (per layer configurable)
- 3D brick sizing: world‑space‑ish; auto‑tune to ~1MB uncompressed per brick per channel block
- Preview encoding: WebP, PNG fallback
- Metadata sidecar: SQLite default, Parquet export optional
- Minimap: coarse composite default; pinned overview layer optional; z indicator shown
- Open view on LAN mode by default; optional view token mode
- Shared edits require lease; lease steal allowed; passive notification
- Derived chunk publishing: control token required; no lease required; last‑write‑wins per chunk; audit logged
- ROI cutout: default LOD full; supports match_view and integer; halo publish default

---

## 18. Future considerations (not pinned)

- Pixel‑streaming broadcast mode for “watch without data access”
- Non‑linear registration transforms
- Editable labels (painting) and annotation tools
- Mesh/isosurface extraction for labels in 3D
- Cloud/CDN storage mapping and signed URL policies
- Browser sandboxing and plugin security model

