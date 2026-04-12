# Lucida Domain Model

How the system is partitioned into domains and subdomains. Use this to decide where new code belongs and what it should (and should not) depend on.

Each domain has a **boundary contract** — the set of inputs it accepts and outputs it produces. Code within a domain may be structured however makes sense, but cross-domain dependencies must go through the boundary.

This model applies to all clients: lucida-web, lucida-cli, and lucida-py. Not every client uses every domain, but the domains that are shared use the same implementation.

---

## Domain Map

```
┌──────────────────────────────────────────────────────────────────┐
│                         APPLICATION                              │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐ │
│  │  Scene State  │  │ Collaboration │  │   Client UI/API       │ │
│  │  (Rust)       │  │               │  │                       │ │
│  │  ┌──────────┐ │  │ ┌───────────┐ │  │  web: React           │ │
│  │  │ Document │ │  │ │ Transport │ │  │  cli: clap            │ │
│  │  │ View     │ │  │ │ Cmd Sync  │ │  │  py:  Python API      │ │
│  │  │ Geometry │ │  │ │ Presence  │ │  │                       │ │
│  │  └──────────┘ │  │ └───────────┘ │  │                       │ │
│  └───────┬───────┘  └───────┬───────┘  └──────────┬──────────┘ │
│          │                  │                      │            │
│  ┌───────▼──────────────────────────────────────────────────┐  │
│  │  Canonical Content Graph  (Rust — shared by all clients)  │  │
│  │  entities, transforms, source layouts, multiscale metadata │  │
│  └───────┬───────────────────────────────────────────────────┘  │
│          │                                                      │
│  ┌───────▼──────────────────────────────────────────────────┐  │
│  │  CLIENT-SPECIFIC LAYERS                                   │  │
│  │                                                           │  │
│  │  Web:  Presentation Overlay + Asset Catalog               │  │
│  │        Pipeline (main): Orchestrator, Planning,           │  │
│  │          CPU Cache, Worker Protocol                        │  │
│  │        Pipeline (worker): GPU Residency, Rendering        │  │
│  │                                                           │  │
│  │  Python: Headless data pipeline                            │  │
│  │          (fetch → decode → numpy)                         │  │
│  │                                                           │  │
│  │  CLI:  No pipeline (inspection + control only)            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Language Boundaries

The language boundary follows **ownership and mutability**, not computational weight.

- **Rust** is for logic that is pure, deterministic, and a function of scene metadata + camera state. It is also for anything shared across clients.
- **TypeScript** is for logic that depends on live browser state: cache contents, in-flight requests, scrubbing state, worker messaging, GPU residency, and WebGPU resources.
- **Python** wraps the shared Rust layer (via PyO3) and adds headless data access.

The simple rule: if a function depends only on camera state, transforms, metadata, and geometry, put it in Rust. If it depends on cache contents, in-flight requests, worker state, concurrency, or browser APIs, put it in TypeScript. If it depends on numpy/analysis workflows, put it in Python wrapping Rust.

```
                  ┌─────────────────────────────────────────────┐
                  │              Rust (native)                   │
                  │                                             │
                  │  lucida-server                              │
                  │  ├─ Session management                      │
                  │  ├─ Import: dataset registration + serving  │
                  │  ├─ Chunk serving via ChunkResolver         │
                  │  ├─ Storage codec decompression              │
                  │  └─ Future: overview generation, sharding   │
                  │                                             │
                  │  lucida-protocol (shared Rust crate)        │
                  │  ├─ ClientFetchDescriptor (Proxied/Direct)  │
                  │  ├─ WireFormat (Raw/Lz4/Zstd)              │
                  │  └─ RegisterDataset command                 │
                  │                                             │
                  │  lucida-content (shared Rust crate)         │
                  │  ├─ Canonical entities (image/well/field)   │
                  │  ├─ Canonical transforms (field→well, etc)  │
                  │  ├─ Source layouts from metadata             │
                  │  ├─ Multiscale metadata + chunk geometry    │
                  │  ├─ Plate layout construction               │
                  │  └─ Layout value types (LayoutSpec)         │
                  │                                             │
                  │  lucida-core (consumes content + protocol)  │
                  │  ├─ Scene state: camera, viewport, view     │
                  │  ├─ Document state (dataset registry)       │
                  │  ├─ Precomputed per-dataset query cache      │
                  │  ├─ Command & protocol types                │
                  │  ├─ Geometric query engine:                 │
                  │  │  ├─ Transform composition                │
                  │  │  ├─ Frustum culling                      │
                  │  │  ├─ Projected-size metrics               │
                  │  │  ├─ Ideal target LOD                     │
                  │  │  ├─ Ray intersection                     │
                  │  │  └─ Distance/importance ranking          │
                  │  └─ Chunk-grid helpers (per-level geometry) │
                  │                                             │
                  │  lucida-store (consumes content + protocol) │
                  │  ├─ OME-Zarr parsing (parse module)         │
                  │  └─ import_dataset → ImportResult            │
                  │                                             │
                  │  lucida-cli (consumes lucida-core)          │
                  │  └─ Command-line viewport control + inspect │
                  └────────────────┬────────────────────────────┘
                                   │
                    ┌──────────────┼──────────────────┐
                    │              │                  │
                    ▼              ▼                  ▼
              ┌──────────┐  ┌──────────┐      ┌──────────┐
              │   WASM   │  │   PyO3   │      │  Native  │
              │(wasm-    │  │(lucida-  │      │(lucida-  │
              │ bindgen) │  │ py)      │      │ cli,     │
              │          │  │          │      │ server)  │
              └────┬─────┘  └────┬─────┘      └──────────┘
                   │             │
                   ▼             ▼
┌──────────────────────┐  ┌──────────────────────┐
│    TypeScript         │  │    Python             │
│    (lucida-web)       │  │    (lucida-py)         │
│                       │  │                       │
│  Presentation Overlay │  │  Headless data access │
│  Asset Catalog        │  │  Chunk fetch/decode   │
│  Full render pipeline │  │  Numpy assembly       │
│  React UI             │  │  Notebook integration │
└───────────────────────┘  └───────────────────────┘
```

### How this maps to domains

| Domain | Language | Clients | Why |
|--------|----------|---------|-----|
| **Canonical Content Graph** | Rust (`lucida-content`) | All | Shared data model. Every client needs entities, transforms, layouts, metadata. |
| **Scene State** | Rust (`lucida-core`) | All | Geometric query engine over the content graph. Dataset registry with precomputed per-dataset caches for hot-path queries. Shared across web (WASM), CLI (native), Python (PyO3). |
| **Collaboration** | Rust types (`lucida-core`) + client transport | All | Collaboration protocol (commands, presence, session messages) in `lucida-core`. Transport in TS (web), Rust (CLI), Python (py). |
| **Client UI/API** | Per client | Per client | React (web), clap (CLI), Python API (py). |
| **Presentation Overlay** | TypeScript | Web only | Custom layouts, condition grids, browser-authored arrangements. |
| **Asset Catalog** | TypeScript | Web only | Overview/proxy product availability, shard/transport capability. |
| **Pipeline.Orchestrator** | TypeScript | Web only | Snapshot assembly, lifecycle, epoch observation, worker state pushes. |
| **Pipeline.Planning** | TypeScript | Web only | Promotion, scheduling, request plan generation. Side-effect-free over snapshot. |
| **Pipeline.CPU Cache** | TypeScript | Web only | Browser cache, fetch scheduling, decode pipeline. |
| **Pipeline.Worker Protocol** | TypeScript | Web only | postMessage contract between main thread and GPU worker. |
| **Pipeline.GPU Residency** | TypeScript | Web only | Atlas, page table, descriptors, wanted set. |
| **Pipeline.Rendering** | TypeScript + WGSL | Web only | Shader dispatch, compositing. |
| **Headless data pipeline** | Python + Rust | Python only | Chunk fetch, decode, numpy assembly. No GPU. |

### Shared contract crates

These are not runtime domains — they define shared types that multiple domains depend on.

| Crate | Depends on | Consumers | Owns |
|-------|-----------|-----------|------|
| `lucida-protocol` | `lucida-content` | `lucida-core`, `lucida-store` | Fetch descriptors, wire format, registration commands |

### The WASM output boundary

Rust/WASM should not emit full chunk plans. It should return compact geometric recommendations that TypeScript expands into actual requests using live pipeline state.

The target output from WASM is something like:

```ts
type ViewQueryResult = {
  visibleEntities: Array<{
    entityId: number;
    kind: "well" | "field" | "image";
    projectedDiagonalPx: number;
    projectedAreaPx2: number;
    centroidWorld: [number, number, number];
    idealTargetLod: number;   // geometric recommendation only
    visible: boolean;
  }>;
};
```

This is small, stable, and cheap to pass across the WASM boundary. TypeScript then decides what to actually do with it:

- **Rust says:** "This well is visible, large on screen, near focus, ideal target LOD is 1."
- **TypeScript says:** "It is promoted to detail, current T is 37, channels 0/2/3 are visible, detail owns LODs 0..2, seed LOD 2 first, CPU cache already has some pages, worker wants these 64 exact pages."

The same `ViewQueryResult` is available to Python (via PyO3) for headless viewport queries without needing to reimplement spatial math.

A second compact geometric output is `VisibleRegion` — the camera's viewport bounds and optional frustum planes in voxel space (~28 floats). Planning uses this for spatial chunk culling. Both 2D and 3D use the same code path: the `VisibleRegion` encodes the camera mode in its data (frustum planes present for 3D, absent for 2D).

```ts
type VisibleRegion = {
  xyBounds: [number, number, number, number]; // viewport AABB in voxel coords
  zRange: [number, number];                   // visible Z range
  effectiveZoom: number;                      // screen px per voxel
  sortCenter: [number, number, number] | null; // center-out loading origin (3D)
  frustumPlanes: [number, number, number, number][] | null; // 6 planes (3D)
};
```

### LOD decision split

LOD is not one decision — it is four, split across languages:

| LOD decision | Language | Depends on |
|-------------|----------|------------|
| **1. Representation selection** (overview / well proxy / field proxy / native detail) | TypeScript | UI mode, layout, budgets, product availability |
| **2. Ideal target detail LOD** (which native level best matches projected resolution) | Rust | Camera, voxel scale, entity bounds — pure geometry |
| **3. Detail-owned fallback range** (e.g., target LOD 0 but detail also owns LODs 1-2 before revealing overview) | TypeScript | Budgets, scheduling policy, active set size |
| **4. Realized resident pages** (which exact pages at which levels are cached and uploaded) | TypeScript + worker | CPU cache state, GPU atlas state, eviction — live mutable state |

### Serialization boundaries

| Boundary | Mechanism | Cost | Frequency |
|----------|-----------|------|-----------|
| **Client → Scene State** | Commands via FFI/binding layer (JSON over wasm-bindgen for web, typed API over PyO3 for Python, direct Rust calls for CLI) | Depends on binding | Per user action |
| **Scene State → consumer** | Geometric query returning compact `ViewQueryResult` + active layout snapshot | Via client binding layer (wasm-bindgen, PyO3, native) | Per planning cycle |
| **Orchestrator → Planning** | `PlanningSnapshot` (assembled from all upstream domains) | In-process TypeScript call | Per planning cycle |
| **Main thread → Worker** | `postMessage` + binary payloads | Structured clone with transfer/copy/shared-memory depending on deployment | Per frame (hot state), per epoch (cold state), per chunk (data) |
| **Worker → Main thread** | `postMessage` | Structured clone | Wanted-set deltas, eviction reports, intensity samples, telemetry |
| **Main thread → Decode workers** | `postMessage` + ArrayBuffer transfer | Zero-copy transfer | Per chunk requiring decode |
| **Client → Server** | WebSocket + JSON/binary | Network serialization | Per command, per presence, per asset request (detail pages, overview assets) |
| **Server → Client (import)** | Registration command with content graph and fetch descriptor | JSON serialization | Per dataset open |
| **Server → Client (data)** | Asset response. Server decompresses storage codec; response encoded with negotiated wire codec. | Binary serialization | Per asset response |

**Fetch modes:** The boundary rows above describe the proxied path, where all data flows through the server. The architecture also allows a direct path where the client fetches from storage without a server relay. In that mode, only data delivery changes — registration still goes through the server. Proxied-first; direct fetch details belong in a protocol spec when that capability is implemented.

### Decompression authority

Decompression responsibility follows the layer that owns the codec:

- **Storage codec** (e.g., LZ4/Zstd in OME-Zarr storage): decompressed by the layer that reads from storage — the server for networked access, or the client directly for local file access (Python with local OME-Zarr).
- **Wire codec** (format negotiated between server and client): decompressed by the receiving client's fetch-decode pipeline.

The CPU Cache's decode pipeline handles wire-format decompression and pixel-format normalization. It does not re-decompress what the server already decompressed from storage.

### What this means in practice

- **Rust changes** to lucida-content or lucida-core require recompilation and affect all clients (WASM, PyO3, native). Touch this for canonical entities, transforms, scene state, protocol types, geometric queries.
- **TypeScript changes** (lucida-web) are hot-reloadable via Vite. All pipeline orchestration, caching, scheduling, and GPU management happens here.
- **Python changes** (lucida-py) require maturin rebuild for Rust bindings, but Python-side changes are immediate.
- **WGSL changes** are loaded as text at runtime. Shader iteration is fast.
- **The FFI boundaries are narrow and stable:** commands in via the binding-appropriate API, compact geometric recommendations out. The pipeline never sends chunk data through WASM — data flows TypeScript → TypeScript (main → worker) directly.
- **Do not move stateful pipeline logic into Rust.** If profiling shows a pure math kernel is hot (projected-size over many entities, batched frustum culling), move just that kernel to Rust without moving orchestration.

---

## 1. Canonical Content Graph

> Full documentation: [docs/canonical-content-graph.md](docs/canonical-content-graph.md)

The shared Rust data model for what datasets contain and how their spatial components relate. Produced by parsing OME-Zarr metadata (lucida-store), consumed by every client.

The content graph says **what the dataset is**. It does not say what to load, how to present it, or what derived products exist.

### Crate: `lucida-content`

Canonical content types live in `lucida-content`, a standalone crate with no lucida dependencies (only `serde`):

- `lucida-store` parses OME-Zarr and produces `lucida-content` types via `import_dataset`
- `lucida-core` consumes `lucida-content` for scene state and geometric queries
- `lucida-server`, `lucida-cli`, and `lucida-py` all consume the same `lucida-content`
- `lucida-web` consumes the WASM build of `lucida-core` (which re-exports content types)

Fetch and registration types live in `lucida-protocol` (depends on `lucida-content`): `ClientFetchDescriptor`, `WireFormat`, `RegisterDataset`. Both `lucida-core` and `lucida-store` depend on `lucida-protocol` — neither depends on the other.

### Subdomains

| Subdomain | Owns |
|-----------|------|
| **Canonical entities** | Images, wells, fields — stable identity for data objects independent of layout, residency, or client |
| **Canonical transforms** | Field-to-well transforms, voxel-to-image transforms from source metadata |
| **Source layouts** | Plate grid layout, stage-position layout — derived deterministically from metadata |
| **Multiscale metadata** | Axes, per-level chunk geometry (chunk shape, grid dimensions, coordinate transforms), level count. Chunk shape is a **per-level property** — levels within the same image may have different chunk dimensions |
| **Layout value types** | `LayoutSpec` — a portable value object describing a spatial arrangement of wells. Can be created by any client and registered with Scene State |

### Boundary contract

**Inputs:** OME-Zarr metadata (from lucida-store parsing).

**Outputs:**
- Canonical entity graph (wells, fields, images with stable IDs)
- Source transforms (field-to-well, voxel-to-image)
- Source layout specs (deterministic from metadata)
- Multiscale geometry (chunk shapes, level scales, axes)

### Rules

- The content graph is deterministic and immutable for a given dataset. It does not change because of view state, layout selection, or client type.
- A well exists regardless of whether a proxy has been generated for it. Proxy availability is not part of the content graph.
- Layout definitions are portable value objects (`LayoutSpec`), not client-specific concepts. Any client can create a `LayoutSpec` and register it with Scene State via `register_layout(spec)` / `set_active_layout(id)`.
- Custom/derived layouts (condition grids, comparison views) are authored by clients but expressed as `LayoutSpec` values that Rust can represent and Scene State can query against.
- Chunk geometry (chunk shape, grid dimensions) is a per-level property, not an image-level invariant. Different resolution levels of the same image may have different chunk dimensions. All consumers of multiscale metadata must handle per-level chunk shapes — there is no global "chunk size" for an image.
- Within a single resolution level, the chunk grid must be regular (uniform chunk dimensions with possible edge truncation at array boundaries). Non-regular chunk grids within a level are not supported by the interactive GPU path and must be normalized during import or rejected with a capability error.

---

## 2. Scene State

The Rust geometric query engine. Owns viewer state and evaluates spatial queries over the Canonical Content Graph in the context of the active layout.

### Subdomains

| Subdomain | Owns | Shared across clients? |
|-----------|------|----------------------|
| **Document** | Dataset registry mapping dataset IDs to content graphs. Registration via commands, precomputed per-dataset caches for hot-path queries. | Yes (synced via server) |
| **View** | Camera, T/C/Z selection, view mode, channel settings, layer visibility | No (local per client) |
| **Layout registration** | Registered `LayoutSpec` instances, active layout selection via `register_layout()` / `set_active_layout()` | Active layout is per-client; specs may be shared |
| **Geometric queries** | Transform composition, frustum culling, projected-size metrics, ideal target LOD, ray intersection, distance/importance ranking — all evaluated against the active layout | Shared implementation (same Rust runs native on server, WASM in browser, PyO3 in Python) |

### Boundary contract

**Inputs:** Commands via the client binding layer (web: JSON over wasm-bindgen, Python: typed PyO3 bindings, CLI: direct Rust calls). `LayoutSpec` registration.

**Outputs:**
- **State queries:** camera matrices, current T/C/Z, dataset settings, channel settings, viewport, active layout ID
- **Active layout snapshot:** materialized, epoch-tagged layout snapshot for the current active layout. The Orchestrator requests this and includes it in the `PlanningSnapshot`.
- **Geometric queries:** compact per-entity recommendations (`ViewQueryResult`) — visibility, projected size, centroid, ideal target LOD, importance ranking. Pure functions of camera + active layout + entity metadata from the content graph.


Shared content types are defined in lucida-content and may be re-exported by lucida-core for ergonomic access. Scene State is not the owner or distributor of canonical content — lucida-content is.

### What Scene State does NOT output

- Full chunk plans (thousands of chunk keys). Clients expand geometric recommendations into requests using their own pipeline state.
- Scheduling decisions (what to fetch first, what lane to use). Client-specific.
- Realized LOD (what levels to actually request). Depends on budgets, cache pressure, and product availability.
- Overview/proxy availability. That is an asset catalog concern, not scene geometry.

### Rules

- Scene State is the **only** source of truth for viewer state and spatial computation.
- Commands are the only way to mutate scene state. No direct field writes from any client.
- Geometric queries are pure and deterministic. They do not depend on cache state, in-flight requests, or GPU residency. They answer: "given this camera and these entities in this layout, what is geometrically important?" — not "what should we do about it."
- Layout registration uses portable `LayoutSpec` values from the content graph. The browser can author derived layouts, but it does so by creating a `LayoutSpec` and registering it — not by having a JS-only notion of layout that Rust cannot represent.

---

## 3. Collaboration

Multiplayer session management over WebSocket.

### Subdomains

| Subdomain | Owns | Boundary |
|-----------|------|----------|
| **Transport** | WebSocket lifecycle, reconnection, message framing | Emits/receives typed protocol messages |
| **Command sync** | Applying remote document commands to local scene, ordering | Consumes transport messages, calls `scene.apply_command()` |
| **Presence** | Cursor positions, follow chains, layer presence, throttling | Reads scene/view state snapshots, publishes via transport |

### Boundary contract

**Inputs:** Local commands to broadcast, scene/view state snapshots for presence.

**Outputs:** Remote commands to apply, peer presence state for UI (cursors, follow indicators).

### Cross-client notes

All three clients use the same collaboration wire protocol. Protocol types (commands, presence, session messages) are defined in `lucida-core` alongside the scene state types they operate on. Fetch and import protocol types live separately in `lucida-protocol`. Transport implementation varies:

- **Web:** TypeScript WebSocket client
- **CLI:** Rust tokio-tungstenite
- **Python:** Python websockets + asyncio (consider thin PyO3 wrapper over Rust session client to reduce protocol drift)

### Rules

- Collaboration does not know about chunks, atlases, or rendering.
- Collaboration reads from scene/view state snapshots, not from UI directly. This keeps it decoupled from any particular client framework.
- Presence is fire-and-forget. Dropped presence updates are acceptable; dropped commands are not.
- Follow mode is peer-to-peer, resolved server-side.

---

## 4. Client UI / API

Each client has its own interaction layer. This is the only domain that is entirely client-specific.

### Web (lucida-web)

React components and hooks. Detailed in the web-specific pipeline sections below.

| Subdomain | Owns | Reads from | Writes to |
|-----------|------|------------|-----------|
| **Viewer shell** | Canvas lifecycle, resize, view mode switching | Pipeline (canvas handle, status) | Pipeline (canvas element) |
| **Settings panels** | Layer panel, channel config, contrast, colormaps, blend modes | Scene state | Scene commands |
| **Navigation** | Dimension sliders, plate selector, camera controls, keyboard input | Scene state, content graph | Scene commands |
| **Debug** | FPS counter, debug overlay, instrumentation display | Pipeline telemetry | Nothing |

### CLI (lucida-cli)

clap-based command interface. Connects to server, sends viewport commands, inspects state.

### Python (lucida-py)

Python API wrapping lucida-core via PyO3. `Viewer` class with synchronous methods, background async event loop for server communication.

### Rules (all clients)

- Client UI/API does not touch chunk data, GPU textures, or atlas internals.
- Client UI/API does not own pipeline orchestration.
- Client UI/API learns about pipeline state through a telemetry/status channel.

---

## 5. Presentation Overlay + Asset Catalog (web only)

Two distinct concerns that are both browser-specific layers on top of the shared content graph. Neither is canonical content.

### Subdomains

| Subdomain | Owns |
|-----------|------|
| **Derived layouts** (presentation) | Condition-based well arrangements, comparison grids, filtered views. Authored in TypeScript, but expressed as `LayoutSpec` values registered with Scene State. Today the browser is the primary author of derived layouts, but `LayoutSpec` is a shared value type and may be created by other clients later. |
| **Asset catalog** (fetch/runtime) | Overview/proxy product availability (what wellProxy3D, fieldProxy3D, or image overviews exist and can be requested). Shard/transport capability metadata. A well exists regardless of whether a proxy has been generated for it — this catalog tracks what derived products are available, not what content exists. This is a fetch/runtime concern, not a presentation concern — it is grouped here because both are web-only overlays, but they serve different consumers (Planning reads the asset catalog; UI reads derived layouts). |

### Boundary contract

**Inputs:** Content graph (canonical entities). Server-provided asset manifests.

**Outputs:**
- Derived `LayoutSpec` values for registration with Scene State
- Asset availability information for Planning (what proxies can be requested, at what resolution, with what T/C coverage)

### Rules

- Presentation Overlay is descriptive, not prescriptive. It says what arrangements and assets are available. It does not decide what to load, fetch, or render.
- Derived layouts must be expressed as `LayoutSpec` values that Rust can represent — not as JS-only objects that bypass Scene State.
- Asset catalog describes capability, not content. It is consumed by Planning to decide what to request, not by the content graph.

---

## 6. Pipeline (web only)

Everything between scene state and pixels. This is the domain being rewritten.

### 6.0 Orchestrator (main thread)

Lifecycle and snapshot glue. Coordinates domains without owning policy, cache data, or GPU residency.

**Owns:**

| Concern | Description |
|---------|-------------|
| **Snapshot assembly** | Collects inputs from Scene State, Content Graph, Asset Catalog, CPU Cache, and Worker Protocol into a `PlanningSnapshot` |
| **Planning cycle triggering** | Observes scene/content/asset/cache/worker epochs; invokes Planning when relevant epochs change |
| **Geometric query dispatch** | Invokes Scene State geometric queries and passes compact `ViewQueryResult` into the planning snapshot |
| **Request plan application** | Feeds `RequestPlan` from Planning to CPU Cache |
| **Delivery routing** | Receives ready chunk/proxy buffers from CPU Cache and delivers to the worker via Worker Protocol |
| **Worker state updates** | Pushes hot state (per frame) and cold state (per epoch) to the worker via Worker Protocol |
| **Pipeline lifecycle** | Start/stop/reset of the pipeline. Canvas and worker lifetime |
| **Telemetry fan-out** | Collects telemetry from Worker Protocol and exposes status to Client UI/debug |

**Boundary contract:**

- **Inputs:** Epoch signals from all upstream domains. Telemetry from Worker Protocol. Ready deliveries from CPU Cache.
- **Outputs:** `PlanningSnapshot` (to Planning). `RequestPlan` (to CPU Cache). Hot/cold state + data deliveries (to Worker Protocol). Status/telemetry (to Client UI).

**Rules:**
- The Orchestrator coordinates domains but does not own policy (Planning), cache data (CPU Cache), or GPU residency (worker).
- Planning stays side-effect-free; CPU Cache stays I/O-oriented; the worker stays residency-oriented. The Orchestrator sequences them.
- If a new concern doesn't fit Planning, CPU Cache, Worker Protocol, GPU Residency, or Rendering, it probably belongs in the Orchestrator.

### 6.1 Planning (main thread)

Decides what to load, at what priority, for which entities. Consumes a `PlanningSnapshot` assembled by the Orchestrator and produces a `RequestPlan`. Does not read from other domains directly.

Planning is a **pure function**: `PlanningSnapshot → RequestPlan`. It does not perform I/O, mutate GPU state, fetch data, or read directly from other domains. All inputs arrive in the `PlanningSnapshot` assembled by the Orchestrator.

**Subdomains:**

| Subdomain | Owns |
|-----------|------|
| **Promotion** | Representation selection (overview / proxy / detail), active set bounds, promotion/demotion hysteresis. Uses WASM projected-size metrics but applies its own thresholds and budgets. Note: `proxy` representation is a forward-compatible placeholder — V1 promotion is two-tier (overview / detail) until Asset Catalog (step 6) provides proxy availability |
| **LOD range** | Per promoted entity: `targetLod` (from WASM ideal), `seedDetailLod` (coarsest detail-owned level), `detailOwnedLodRange`. Determines where detail ends and overview begins |
| **Epoch tags** | Consumes epoch-tagged snapshot inputs and propagates epoch tags into `RequestPlan` outputs. Epoch definitions: `contentEpoch`, `layoutEpoch`, `viewEpoch`, `selectionEpoch`, `assetEpoch` (forward-compatible placeholder, provided by Asset Catalog step 6, 0 until then), `requestEpoch` (forward-compatible placeholder, bumped when Planning produces a new plan, 0 initially) |
| **Request scheduling** | Three-lane prioritization (overview, exact detail, temporal runway). Chunk iteration, seed ordering, runway policy |

**Boundary contract:**

- **Inputs:** `PlanningSnapshot` — assembled by the Orchestrator, containing:
  - Geometric recommendations (`ViewQueryResult`)
  - `VisibleRegion` (viewport bounds and optional frustum planes from WASM, for spatial chunk culling)
  - Content graph snapshot (canonical entities, multiscale metadata)
  - Active layout snapshot (materialized, epoch-tagged)
  - Asset catalog snapshot (product availability)
  - Selection state (T/C/Z, channel settings, render mode, interaction state)
  - CPU cache state (what's already cached)
  - Worker wanted-set snapshot (what the worker reports as missing)
  - Previous active set (previous plan's active set, for promotion hysteresis — necessary because Planning is a pure function with no internal state)
- **Outputs:** `RequestPlan` — prioritized request list (for CPU Cache via Orchestrator), plus active set + layout + epoch tags (for worker cold-state updates via Orchestrator).

**How Planning uses geometric recommendations:**

The `PlanningSnapshot` includes geometric recommendations from WASM (visibility, projected size, ideal target LOD). Planning applies its own policy on top:

- WASM said entity is visible with projected diagonal 200px and ideal LOD 1
- Planning decides: promote to detail, detail owns LODs 0-2, seed LOD 2 first, overview fallback below that, schedule in the exact-detail lane, current T is 37, channels 0/2/3 visible, expand to specific chunk requests using cache state and wanted set from the snapshot

Planning does **not** receive chunk lists. It iterates chunks itself, lazily, bounded to the active detail set, using cache and interaction state from the snapshot to decide what to actually request.

**Rules:**
- Planning is a pure function: `PlanningSnapshot → RequestPlan`. No I/O, no GPU calls, no network fetches, no direct reads from other domains.
- Testable in isolation with a synthetic `PlanningSnapshot` — no WASM, no worker, no browser required.
- The planner decides *what* to load. It does not decide *how* to fetch or *where* to store.
- Planning operates on logical content identities — detail pages (entity, level, T, C, page coordinates) and proxy assets (entity, representation kind, proxy level, T, C) — not on atlas classes or physical slot dimensions. Varying chunk shape across LODs does not change request identity or planning logic — it changes worker residency behavior only.

### 6.2 CPU Cache + Content Source (main thread)

Holds decompressed data between network and GPU. Schedules fetches. Resolves logical asset requests to physical storage.

**Subdomains:**

| Subdomain | Owns |
|-----------|------|
| **Overview cache** | Coarse proxy assets (well proxies, field proxies, native image overviews) |
| **Detail cache** | Decompressed native chunks for active promoted fields |
| **Fetch + decode pipeline** | Network request scheduling, wire-format decompression, pixel-format normalization, concurrency budgeting |
| **Content source** | Resolves logical asset requests to physical storage. The planner requests logical things (overview asset for well A1, T=37, channel 2; detail page for field F17, level 2, T=37, C=0, z/y/x). The source resolves that to a raw OME-Zarr object, a shard byte range, a derived overview asset, or a batched response. This keeps transport layout from contaminating planning. |

**Boundary contract:**

- **Inputs:** `RequestPlan` from Orchestrator (logical asset requests). Network responses from server.
- **Outputs:** Ready deliveries to Orchestrator (decompressed chunk/proxy buffers for GPU upload). Cache status (hit rates, bytes).

**Rules:**
- The CPU cache does not know about GPU textures, atlas pools, or page tables.
- Cache keys are canonical content identity — detail pages keyed by (entity, level, T, C, page coordinates), proxy assets keyed by (entity, representation kind, proxy level, T, C) — not layout-dependent or atlas-class-dependent. Varying chunk shape across LODs does not affect cache key semantics.
- Overview and detail have separate eviction policies and lifetime behavior.
- The fetch scheduler budgets by bytes-in-flight and lane priority, not a single flat count.
- The content source abstraction hides whether bytes came from individual OME-Zarr chunks, a shard, a batched response, or a cached overview product.

### 6.3 Worker Protocol (message boundary)

Defines the serialization contract between main thread and worker. Messages are organized into three categories to prevent telemetry from leaking into the control plane.

**Control messages** (affect what the worker does):

| Direction | Message | Frequency |
|-----------|---------|-----------|
| Main → Worker | Hot render state (camera, viewport, T, channel mask, render mode, interaction state) | Every frame |
| Main → Worker | Cold layout/content state (entity list, transforms, per-LOD chunk dimensions, channel config, metadata). The worker builds descriptor buffers from these logical inputs — proxy handles and page-table bases are worker-owned residency state, not main-thread outputs. | Per epoch change |
| Worker → Main | Wanted-set deltas (missing proxy assets, missing detail pages for current epoch) | On epoch change or whenever the wanted set changes materially |

**Data messages** (deliver content):

| Direction | Message | Frequency |
|-----------|---------|-----------|
| Main → Worker | Proxy asset deliveries (overview data with entity/representation kind/proxy level/T/C/epoch tags) | As ready |
| Main → Worker | Detail page deliveries (chunk data with page identity, actualDims for edge chunks, T/C/epoch tags) | As ready |

**Telemetry messages** (observe, never act on):

| Direction | Message | Frequency |
|-----------|---------|-----------|
| Worker → Main | Frame timing, memory pressure, dropped stale delivery counts | Per frame or periodic |
| Worker → Main | Intensity samples for auto-contrast | Per render pass |
| Worker → Main | Debug counters (atlas occupancy, eviction stats) | Optional / periodic |

**Epoch tagging:**

Every control message, data delivery, and wanted-set delta carries enough epoch metadata to be safely ignored if stale. At minimum:

- `contentEpoch` — entity membership or metadata changed
- `layoutEpoch` — well arrangement or spatial layout changed
- `viewEpoch` — camera moved enough to change admission or shell boundaries
- `selectionEpoch` — current T, visible channels, current Z / slice plane, render mode, clip or sampling mode — any selection-like state that changes residency demand
- `assetEpoch` — asset catalog or fetch capability changed (new proxy published, shard index updated)
- `requestEpoch` — planning cycle that generated this delivery

The worker can drop a stale page delivery without caring what arrived before it. Epochs are the primary correctness mechanism — not FIFO message ordering. FIFO ordering is a transport property that happens to be true for `postMessage`, but correctness must not depend on it.

**Rules:**
- This is a data contract, not a domain with logic. Both sides depend on it; neither side owns the other.
- Prefer numeric handles, flat typed arrays, compact enums. Avoid deep object trees or string IDs in per-frame messages.
- Chunk and proxy deliveries may be transferred, copied, or backed by shared memory depending on deployment constraints. CPU Cache remains the authority for RAM residency. The delivery mechanism is an implementation detail — the domain model does not depend on it.

### 6.4 GPU Residency (worker thread)

Manages where data lives in VRAM. Emits demand for missing assets back to the main thread.

**Subdomains:**

| Subdomain | Owns |
|-----------|------|
| **Atlas pools** | Multiple texture atlases keyed by (representation kind, texel format, slot dimensions). A single promoted entity may span multiple pools across LODs when chunk shape varies by level. Pools are allocated on demand and shared across entities with matching physical parameters. Overview proxy assets are addressed via a direct (pool, slot) handle — they do not go through the page table |
| **Page table** | Maps logical detail page addresses to physical (pool, slot) pairs. Only used for native detail pages, not for overview proxies. Only maps current-T/current-C pages. Contains entries for every detail-owned level per promoted entity. Logical chunk geometry (per-LOD dimensions) lives in per-level descriptors, not in page-table entries |
| **Descriptors** | Per-entity GPU buffers: model matrix, channel mask, and proxy handle (direct pool/slot reference for overview fallback), and for promoted entities also page table base + per-LOD chunk dimensions. A promoted entity carries both paths to support the detail → proxy → nothing fallback chain. Detail descriptors carry the logical chunk geometry the shader needs for page lookup and intra-chunk sampling |
| **Wanted set** | Reports missing proxy assets and detail pages for the current epoch to main thread via Worker Protocol. Subscription/delta-based, not per-frame polling |

**Boundary contract:**

- **Inputs:** Chunk buffers with edge dimensions (via protocol), cold state (layout, transforms, per-LOD chunk geometry, metadata on epoch change).
- **Outputs:**
  - Bound textures + descriptor buffers ready for rendering
  - Wanted-set deltas back to main thread (missing proxies and pages for current epoch)
  - Eviction reports, memory pressure signals

**Rules:**
- GPU Residency does not decide what to load — it manages where delivered data lives and reports what is missing.
- Atlas pools are keyed by physical parameters (representation kind, texel format, slot dimensions), not by entity or LOD level. A promoted entity whose chunk shape varies across LODs will have pages in different pools — this is normal, not exceptional.
- In v1, atlas pool slot dimensions exactly match the logical chunk dimensions of the pages they hold. Padded or bucketed slot sizes (accepting smaller chunks into larger slots) are a future optimization that trades VRAM waste for fewer pools — not supported initially.
- Atlas entries are keyed by canonical content identity, not by layout. Same well in two layouts = one atlas entry, two instance transforms.
- The page table maps logical detail page addresses to physical (pool, slot) pairs. It does not encode chunk geometry — that lives in per-LOD descriptors.
- The page table only maps currently valid pages (current T, current channels). Stale T/C pages are unmapped, not kept as fallback.
- Stale deliveries (wrong epoch) are dropped on arrival, not placed into the atlas.
- Adjacent-T runway pages may remain physically resident in atlas pools but are not mapped into the current page table until `selectionEpoch` changes. This is how temporal runway coexists with the "no stale T/C mapping" rule.

### 6.5 Rendering (worker thread)

Shader dispatch and compositing. Reads from residency, writes pixels.

**Boundary contract:**

- **Inputs:** Bound atlas textures, descriptor buffers, hot render state (camera, viewport, render mode).
- **Outputs:** Pixels on canvas. Intensity samples for auto-contrast.

**Semantic fallback chain for promoted detail entities:**

```
target detail LOD → coarser detail LODs in the detail-owned range → current-T/C overview proxy → nothing
```

This is not just "detail or overview." For a promoted entity with `targetLod = 0` and `detailOwnedLodRange = [0, 1, 2]`:

```
LOD 0 (target) → LOD 1 → LOD 2 (seed detail) → overview proxy → empty
```

Lower native detail LODs belong in the detail system. They provide:

1. Immediate seed display when a field first becomes active
2. Progressive refinement as finer pages stream in
3. Stable panning and zooming within the active detail set
4. Coarse exact-T readiness for neighboring timepoints during scrubbing

The overview proxy is the fallback below the detail-owned range and the global navigation representation outside the promoted set. It is not a replacement for lower native detail LODs.

**Rules:**
- Rendering does not manage residency. It does not allocate atlas slots, update page tables, or evict data.
- The shader has two residency addressing paths: overview proxies are sampled via a direct proxy handle (pool/slot reference), while detail pages are sampled via page-table lookup with LOD-specific logical chunk dimensions from per-LOD descriptors. The atlas pool is just the physical backing store — its slot dimensions are a packing concern, not a sampling concern.
- Never render stale T/C data as if it were current. Stale data may be physically cached but must not be semantically mapped.
- Rendering may use one pass or multiple passes, but the semantic fallback chain is fixed.

---

## 7. Headless Data Pipeline (Python only)

lucida-py needs a subset of the web pipeline for data access without GPU rendering.

### What Python uses from the shared Rust layer

- Content graph (entities, transforms, multiscale metadata) — via PyO3
- Scene state (camera, viewport, view queries) — via PyO3
- Geometric queries (`ViewQueryResult`) — same as web, via PyO3

### What Python implements in its own layer

- Chunk fetch/decode (from server or local OME-Zarr stores)
- Array assembly (chunks → numpy arrays for the current viewport)
- No GPU residency, no atlas, no rendering
- No presentation overlay or asset catalog

### What Python does NOT need initially

- Worker protocol (no GPU worker)
- GPU residency or rendering
- Presentation overlay or asset catalog (initial scope — Python may eventually want programmatic layout authoring or derived overview asset access)
- React UI or browser APIs

### Rules

- Python should not reimplement spatial math, entity normalization, or transform composition. It gets those from lucida-core via PyO3.
- Python's data pipeline is headless: fetch → decode → numpy. It stops where the web pipeline would hand off to the GPU worker.
- The content graph and scene state are the same Rust implementation used by web and CLI — not a Python reimplementation.

---

## Cross-Domain Dependency Rules

These rules prevent the domains from becoming entangled.

### Allowed dependencies

```
Client UI/API ──reads──► Scene State
Client UI/API ──reads──► Content Graph
Client UI/API ──reads──► Pipeline (telemetry only, web)
Client UI/API ──reads──► Presentation Overlay (derived layouts, web)
Client UI/API ──writes─► Scene State (commands)
Collaboration ──reads/writes──► Scene State (commands, view snapshots)
Scene State ──reads──► Content Graph (entities, transforms, source layouts, LayoutSpec values)
Presentation Overlay ──reads──► Content Graph (entities for derived layouts)
Presentation Overlay ──writes─► Scene State (register_layout)
Pipeline.Orchestrator ──reads──► Scene State (geometric queries, active layout snapshot, epochs)
Pipeline.Orchestrator ──reads──► Content Graph (entities, metadata, epochs)
Pipeline.Orchestrator ──reads──► Asset Catalog (product availability, assetEpoch)
Pipeline.Orchestrator ──reads──► Pipeline.CPU Cache (cache state)
Pipeline.Orchestrator ──reads──► Pipeline.Worker Protocol (wanted-set snapshot, telemetry)
Pipeline.Orchestrator ──invokes─► Pipeline.Planning (PlanningSnapshot)
Pipeline.Orchestrator ──writes──► Pipeline.CPU Cache (RequestPlan)
Pipeline.CPU Cache ──writes──► Pipeline.Orchestrator (ready deliveries)
Pipeline.Orchestrator ──writes──► Pipeline.Worker Protocol (hot/cold state, data deliveries)
Pipeline.GPU Residency ──reads──► Pipeline.Worker Protocol (deliveries)
Pipeline.GPU Residency ──writes──► Pipeline.Worker Protocol (wanted set, telemetry)
Pipeline.Rendering ──reads──► Pipeline.GPU Residency (bound resources)
```

### Disallowed dependencies

- **Client UI/API must not** reach into pipeline internals (chunk maps, atlas state, upload tracking, render timing).
- **Pipeline must not** import React or hook into React lifecycle. It exposes a start/stop/update API.
- **Planning must not** perform I/O or read directly from other domains. It is a pure function: `PlanningSnapshot → RequestPlan`.
- **CPU Cache must not** know about GPU textures or atlas layout.
- **CPU Cache must not** read directly from Worker Protocol or GPU Residency. It consumes only Planning output (via Orchestrator).
- **GPU Residency must not** decide what to load — it manages placement and reports what is missing.
- **Rendering must not** manage atlas slots or page table entries.
- **Orchestrator must not** own policy (promotion thresholds, scheduling heuristics), cache data, or GPU residency. It coordinates, not decides.
- **Collaboration must not** know about chunks, atlases, or rendering.
- **Content Graph must not** depend on pipeline state, presentation overlay, or any client-specific concept.
- **Presentation Overlay must not** be treated as canonical content. It is a client-specific layer.

### Ownership and replication rule

**No domain owns mutable authoritative state that belongs to another domain.** Replicated snapshots are allowed if they are immutable or epoch-tagged.

Examples of allowed replication:
- Worker keeps descriptor buffers and layout snapshots (immutable until next epoch)
- Orchestrator assembles and may retain an epoch-tagged `PlanningSnapshot`
- Main thread keeps compact mirrors of immutable metadata that also exists in WASM

The rule is: **one authority, versioned replicas.** If a snapshot's epoch does not match the current epoch, it is stale and must be refreshed or ignored — never treated as authoritative.

### Epoch-based correctness

Epochs are the primary correctness mechanism. Every hot-state message, cold-state message, proxy delivery, and detail-page delivery carries enough epoch metadata to be safely ignored if stale.

First-class epochs:

| Epoch | Changes when |
|-------|-------------|
| `contentEpoch` | Entity membership or metadata changes (dataset added/removed) |
| `layoutEpoch` | Well arrangement or spatial layout changes (source plate → condition grid) |
| `viewEpoch` | Camera moves enough to change admission results or shell boundaries |
| `selectionEpoch` | Current T, visible channels, current Z / slice plane, render mode, clip or sampling mode — any selection-like state that changes residency demand |
| `assetEpoch` | Asset catalog or fetch capability changes (new proxy published, shard index updated) |
| `requestEpoch` | A new planning cycle generates a new request set |

The worker can drop an old page delivery without caring what arrived before it. The planner avoids replanning unless an epoch it depends on has changed. Stale deliveries are discarded at the worker, not processed and then evicted.

---

## Cross-Client Summary

What each client uses from the domain model:

| Domain | Web | CLI | Python |
|--------|-----|-----|--------|
| **Canonical Content Graph** | Via WASM | Native | Via PyO3 |
| **Scene State** | Via WASM | Native | Via PyO3 |
| **Collaboration** | TS WebSocket | Rust WebSocket | Python WebSocket |
| **Client UI/API** | React | clap | Python API |
| **Presentation Overlay** | Yes | No | No |
| **Asset Catalog** | Yes | No | No |
| **Pipeline (full)** | Yes | No | No |
| **Headless data access** | No | Inspect only | Yes (→ numpy) |

The key principle: the content graph says what the dataset is. The scene says which layout and view are active. The overlay says how this client wants to present content. The asset catalog says what derived products can be fetched. The pipeline turns all of that into pixels (web) or arrays (Python).

---

## How to Use This Document

**When adding new code:** Identify which domain and subdomain it belongs to. If it doesn't fit cleanly, that's a design signal — either the code is doing too much, or a subdomain boundary needs refinement.

**When a change touches multiple domains:** The change should cross domain boundaries only through the defined contracts. If you find yourself importing internals from another domain, stop and route through the boundary instead.

**When refactoring:** Use subdomain boundaries as natural extraction points. Each subdomain listed here should be testable with its boundary inputs mocked — if it can't be, the boundary isn't clean yet.

**When deciding Rust vs TypeScript:** Does it depend only on camera, transforms, metadata, and geometry? Rust. Does it depend on cache, requests, worker state, or browser APIs? TypeScript. Does it need to be shared across clients? Rust.

**During the pipeline rewrite, build in this order:**

1. **Canonical Content Graph** — extract `lucida-content` crate with shared entity/transform/layout types. *(done)*
2. **Scene State updates** — `register_layout()` / `set_active_layout()`, `ViewQueryResult` geometric queries, epoch system. *(done)*
3. **Planning** — promotion, epochs, request scheduling over content graph + geometric queries. Testable standalone with mock snapshots.
4. **CPU Cache + Content Source** — fetch, decode, source abstraction.
5. **Worker Protocol** — control/data/telemetry message shapes, epoch tagging.
6. **Presentation Overlay + Asset Catalog** — derived layouts expressed as `LayoutSpec`, asset catalog. Build alongside the Orchestrator since asset catalog feeds into PlanningSnapshot and derived layouts are browser-authored.
7. **Orchestrator** — wires Planning to CPU Cache, Worker Protocol, and upstream domains. Snapshot assembly, lifecycle, telemetry fan-out.
8. **GPU Residency** — atlas, page table, descriptors, wanted-set reporting.
9. **Rendering** — shader dispatch, compositing, semantic fallback chain.
