# Lucida Implementation Plan - Ticketized Backlog

Version: 0.1 draft  
Date: 2026-02-28  
Status: First-pass implementation plan derived from `lucida_spec.md`, `lucida_protocol_and_schemas.md`, and `lucida_sequences.md`

## 1. Purpose

This document converts the Lucida product spec into an implementation-oriented backlog.

It is intended to be used for:
- engineering planning
- milestone definition
- dependency tracking
- acceptance planning
- team staffing and workstream decomposition

This is not a calendar schedule. It is a structured build plan with ticket-sized work items, dependencies, and exit criteria.

## 2. Planning assumptions

### 2.1 Product assumptions already fixed

The following are treated as settled and should not be reopened during implementation unless a hard technical contradiction appears:
- headless authoritative engine
- WebGPU-rendered clients
- streaming-first architecture
- OME-Zarr canonical cache plus Lucida 3D brick representation
- dual representations: 2D tiles and 3D bricks
- shared scene state vs per-client view state
- lease-based shared scene editing
- control-token publishing of derived chunks without lease
- world-space-first coordinates with support for unknown calibration
- shared Targets, RegionRecipes, chunked cutouts, sparse derived layers
- label metadata sidecars, dense ID remap, and filter-bitset rendering

### 2.2 Planning assumptions for implementation

- Sizes use rough engineering effort bands, not exact estimates.
- Multiple workstreams can proceed in parallel after contracts are stable.
- The first integrated milestone should be a usable 2D browser flow before 3D and ROI prototyping are attempted.
- The protocol/schema docs are the source of truth for interfaces; implementation should conform to them, not drift around them.

### 2.3 Size rubric

- **S**: 2-4 engineering days
- **M**: about 1 engineering week
- **L**: about 2 engineering weeks
- **XL**: 3+ engineering weeks or multi-part implementation

### 2.4 Delivery lanes

- **ARCH**: architecture / spec / technical lead
- **ENG**: engine/backend
- **DATA**: ingest/storage/build systems
- **WEB**: browser/WebGPU client
- **TOOLS**: Python/CLI/Jupyter
- **QA**: test, perf, acceptance, observability

## 3. Milestone map

### M0 - Contract freeze and repo foundation
Exit when:
- schema and sequence docs are accepted as implementation contracts
- repository structure, CI, formatting, and ADR process exist
- ticket dependency graph is stable enough to parallelize work

### M1 - First integrated 2D session
Exit when:
- a source can be opened
- a client can attach and receive snapshot/events
- 2D preview and refinement render correctly
- pan/zoom/z/t/channel interaction works
- generation consistency invariant holds in 2D

### M2 - Scene artifacts and shared navigation
Exit when:
- scene files export/import correctly
- context packages capture and reopen correctly
- shared Targets can be created and jumped to
- warnings are surfaced in UI and artifacts

### M3 - Labels and metadata intelligence
Exit when:
- labels render with outlines
- SQLite sidecars load and hot-reload
- filter DSL drives GPU visibility masks
- million-scale sparse IDs are handled via dense remap

### M4 - 3D interactive viewing
Exit when:
- lazy brick build works
- orthoslices, slab/MIP, and basic raymarch render from bricks
- 3D camera target semantics are stable
- entry into 3D mode is progressive and predictable

### M5 - ROI prototyping loop
Exit when:
- RegionRecipe generation is stable
- chunked cutouts materialize at chosen LODs
- sparse derived layer publish works
- overwrite/new derived layer flows work
- stale-base warnings and LOD provenance are visible

### M6 - Collaboration, auth, and hardening
Exit when:
- open-view LAN mode and token modes work
- lease stealing and audit log work
- derived-layer ACLs work
- perf, observability, and source-churn tests pass

## 4. Workstream overview

| Workstream | Goal | Milestones |
|---|---|---|
| WS0 | Program/contracts/foundation | M0 |
| WS1 | Engine session/control plane | M0-M1 |
| WS2 | Source registry, ingest, and cache build | M0-M1-M4 |
| WS3 | Data plane and storage layout | M0-M1-M4 |
| WS4 | Browser client and 2D viewer | M1 |
| WS5 | Tools surfaces (Python/CLI/Jupyter) | M1-M2-M5 |
| WS6 | Scene files, context packages, and shared targets | M2 |
| WS7 | Labels and metadata | M3 |
| WS8 | 3D rendering and brick UX | M4 |
| WS9 | RegionRecipe, cutouts, and sparse derived layers | M5 |
| WS10 | Permissions, collaboration, audit | M6 |
| WS11 | QA, perf, observability, release hardening | M0-M6 |

## 5. Ticket backlog

---

## WS0 - Program, contracts, and foundation

### LUC-000 - Freeze schema and sequence review points
- **Lane:** ARCH
- **Size:** M
- **Depends on:** existing spec docs
- **Goal:** Resolve the remaining contract-level review points in the protocol/schema draft and mark schema fields as stable or provisional.
- **Deliverables:** reviewed protocol doc; reviewed sequence doc; list of frozen contracts; list of explicitly deferred fields.
- **Acceptance:** no unresolved schema blockers remain for engine/client ticket work to begin.

### LUC-001 - Create architecture decision record set
- **Lane:** ARCH
- **Size:** S
- **Depends on:** LUC-000
- **Goal:** Capture the major irrevocable design choices in ADR form.
- **Deliverables:** ADRs for engine authority, shared/per-client state split, dual representations, channel blocking, dense label remap, and lease semantics.
- **Acceptance:** ADRs merged and referenced from implementation docs.

### LUC-002 - Repository bootstrap and CI baseline
- **Lane:** ARCH
- **Size:** M
- **Depends on:** none
- **Goal:** Establish mono-repo or multi-repo structure, linting, formatting, testing, package boundaries, and CI.
- **Deliverables:** repo layout; CI for unit tests and type checks; docs site or docs folder.
- **Acceptance:** a trivial engine/client build passes in CI.

### LUC-003 - Create acceptance matrix from spec and sequences
- **Lane:** QA
- **Size:** M
- **Depends on:** LUC-000
- **Goal:** Turn spec invariants and workflow expectations into a traceable acceptance matrix.
- **Deliverables:** matrix mapping features to acceptance tests and milestone gates.
- **Acceptance:** each milestone has explicit exit criteria linked to tests.

### LUC-004 - Ticket taxonomy and dependency graph
- **Lane:** ARCH
- **Size:** S
- **Depends on:** this document
- **Goal:** Convert this markdown backlog into tracker-ready tickets with dependencies and milestone labels.
- **Deliverables:** issue tracker import or manually created epics/stories.
- **Acceptance:** backlog exists in tracker with dependency links.

---

## WS1 - Engine session and control plane

### LUC-100 - Session service skeleton
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-000, LUC-002
- **Goal:** Implement session lifecycle, attach/detach, snapshot generation, and authoritative state container.
- **Deliverables:** session manager; in-memory state model; attach API.
- **Acceptance:** clients can create/attach to sessions and receive a full snapshot.

### LUC-101 - ID and revision allocator
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-100
- **Goal:** Implement stable opaque ID generation and all required revision counters.
- **Deliverables:** ID allocator; session_rev/scene_rev/view_rev/layer_rev/metadata_rev/write_rev/generation_seq handling.
- **Acceptance:** every emitted authoritative event carries the required revisions and IDs.

### LUC-102 - Command envelope validation and routing
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-100, LUC-101
- **Goal:** Validate canonical command envelopes, enforce scope rules, and dispatch to reducers/services.
- **Deliverables:** command parser; schema validation; reducer router.
- **Acceptance:** malformed or unauthorized commands are rejected with typed errors; valid commands route correctly.

### LUC-103 - Typed event emission and snapshot replacement model
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-102
- **Goal:** Implement typed event emission aligned to the schema doc, including full-subtree replacement rules.
- **Deliverables:** event bus; message serializer; snapshot/event ordering guarantees.
- **Acceptance:** clients can hydrate from snapshot and then apply typed events without ambiguity.

### LUC-104 - Lease service and passive lease events
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-102
- **Goal:** Implement request/steal lease semantics with passive notifications.
- **Deliverables:** lease state machine; steal operation; event types; admin hooks if needed.
- **Acceptance:** only one lease holder exists at a time; any control client can steal; events are audit logged.

### LUC-105 - Error model implementation
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-102
- **Goal:** Implement typed errors for validation, permission, lease, stale revision, source unavailable, generation not ready, metadata mismatch, and publish errors.
- **Deliverables:** error envelope model and shared library.
- **Acceptance:** client can display and act on typed errors without string parsing.

### LUC-106 - Heartbeat, reconnect, and session recovery
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-100, LUC-103
- **Goal:** Allow clients to reconnect cleanly using snapshot plus subsequent events.
- **Deliverables:** heartbeat; idle disconnect handling; reconnect path.
- **Acceptance:** a reconnecting client recovers state without manual session reset.

### LUC-107 - Warning aggregation service
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-100
- **Goal:** Compute and expose warnings such as uncalibrated overlays, stale derived layers, incomplete label indexes, computed-at-LOD, and generation build incomplete.
- **Deliverables:** warning taxonomy implementation; warning aggregators in snapshot and events.
- **Acceptance:** warnings appear consistently in state, scene/context exports, and UI.

---

## WS2 - Source registry, watch, ingest, and cache build

### LUC-200 - Source registry and format inspection
- **Lane:** DATA
- **Size:** L
- **Depends on:** LUC-100
- **Goal:** Register source records, inspect file/directory sources, detect format, infer axes, and capture calibration/channel metadata.
- **Deliverables:** source registry; inspector plugins for TIFF/BigTIFF/Zarr/OME-Zarr.
- **Acceptance:** opening a source creates a SourceRecord and DatasetBinding with detected metadata.

### LUC-201 - Watcher abstraction and stability window
- **Lane:** DATA
- **Size:** L
- **Depends on:** LUC-200
- **Goal:** Implement watcher-only change detection plus the agreed stability window logic.
- **Deliverables:** file watcher abstraction; directory watcher abstraction; debounce and quick stat verification.
- **Acceptance:** changes produce new working generations only after the source is stable enough to ingest.

### LUC-202 - Generation state machine
- **Lane:** DATA
- **Size:** M
- **Depends on:** LUC-200, LUC-201
- **Goal:** Model generation lifecycle from detected -> started -> partial availability -> ready -> pinned/garbage-collected.
- **Deliverables:** generation state objects; progress model; event emission.
- **Acceptance:** clients receive coherent generation events and can reason about availability.

### LUC-203 - Canonical OME-Zarr cache builder
- **Lane:** DATA
- **Size:** XL
- **Depends on:** LUC-200, LUC-202
- **Goal:** Build canonical multiscale OME-Zarr from source data in the central Lucida cache.
- **Deliverables:** conversion pipeline; multiscale writer; metadata mapping into canonical axis order.
- **Acceptance:** non-OME-Zarr sources produce a canonical multiscale cache readable by Lucida.

### LUC-204 - 2D tile/previews builder
- **Lane:** DATA
- **Size:** XL
- **Depends on:** LUC-203
- **Goal:** Produce first-paint previews and browser-efficient 2D multiscale chunks, ideally reusing canonical arrays where possible.
- **Deliverables:** preview generation; 2D tile metadata; WebP/PNG preview outputs.
- **Acceptance:** coarsest preview arrives early; quantitative 2D tiles refine progressively.

### LUC-205 - Lazy 3D brick builder
- **Lane:** DATA
- **Size:** XL
- **Depends on:** LUC-203
- **Goal:** Build `/lucida/brick3d/` lazily on demand, coarse-to-fine, with world-space-ish brick shapes.
- **Deliverables:** brick pyramid builder; brick metadata; progress events; partial availability states.
- **Acceptance:** entering 3D mode triggers lazy build and coarse bricks become renderable before full build completes.

### LUC-206 - Central cache layout, pinning, and garbage collection
- **Lane:** DATA
- **Size:** L
- **Depends on:** LUC-202, LUC-203
- **Goal:** Manage working generations, pinned generations, and cleanup of obsolete working artifacts.
- **Deliverables:** cache directory layout; generation retention logic; pin and GC routines.
- **Acceptance:** latest working generation and short TTL previous generation are retained; pinned generations survive GC.

### LUC-207 - Channel-blocked chunking and codec packaging
- **Lane:** DATA
- **Size:** L
- **Depends on:** LUC-204, LUC-205
- **Goal:** Implement channel block size defaults, per-layer overrides, and chunk payload packing with headers.
- **Deliverables:** block-chunk writer; payload headers; codec integration for zstd/lz4.
- **Acceptance:** image chunks are written as channel-block payloads; labels remain single-channel.

---

## WS3 - Data plane and storage layout

### LUC-300 - Chunk key canonical formatter/parser
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-000
- **Goal:** Implement canonical chunk key objects and string/path representations.
- **Deliverables:** parser/formatter library shared by engine, client, CLI, and tests.
- **Acceptance:** the same chunk key round-trips through object, string, and URL path forms.

### LUC-301 - HTTP data-plane endpoints for tiles, bricks, and previews
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-300, LUC-204, LUC-205
- **Goal:** Serve immutable payloads for tiles/bricks/previews from engine-hosted endpoints.
- **Deliverables:** HTTP endpoints; headers; generation-aware routing.
- **Acceptance:** client can fetch previews, tiles, and bricks for a generation through HTTP.

### LUC-302 - HTTP cache semantics and immutable payload headers
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-301
- **Goal:** Add immutable caching semantics, ETags, and content metadata so browser/proxies can cache correctly.
- **Deliverables:** cache-control rules; ETags; content-type/content-encoding conventions.
- **Acceptance:** repeated fetches for immutable payloads are cacheable and generation-safe.

### LUC-303 - Static object URL abstraction
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-300
- **Goal:** Ensure the key scheme can later map to static file/object hosting without changing client logic.
- **Deliverables:** URL resolver interface; engine-served implementation; placeholder static resolver.
- **Acceptance:** data-plane fetching is abstracted behind resolvers; no client code depends on local-only endpoint shapes.

### LUC-304 - Metadata sidecar and filter result endpoints
- **Lane:** ENG
- **Size:** M
- **Depends on:** WS7 sidecar schema tickets
- **Goal:** Serve metadata query responses and bitset/filter outputs on a predictable endpoint surface.
- **Deliverables:** sidecar query endpoint; filter result retrieval endpoint; compression tagging.
- **Acceptance:** labels metadata and filter masks can be fetched independently from control-plane state.

### LUC-305 - Storage layout documentation and validation tool
- **Lane:** DATA
- **Size:** M
- **Depends on:** LUC-203, LUC-205, LUC-300
- **Goal:** Validate that on-disk OME-Zarr plus `/lucida/` layout conforms to the storage spec.
- **Deliverables:** layout validator CLI/test tool.
- **Acceptance:** derived cache output can be validated mechanically in CI.

---

## WS4 - Browser client and 2D viewer

### LUC-400 - Client state store and event reconciliation
- **Lane:** WEB
- **Size:** L
- **Depends on:** LUC-103
- **Goal:** Implement local client state model with authoritative snapshot hydration and event application.
- **Deliverables:** client store; reducers; warning state; reconnect behavior.
- **Acceptance:** client reproduces session state from snapshot and subsequent events.

### LUC-401 - Attach/auth/capability handshake UI and plumbing
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-100, LUC-103, LUC-106
- **Goal:** Perform attach handshake, present view/control capabilities, and surface permission state.
- **Deliverables:** connection bootstrap; token handling; permission display.
- **Acceptance:** browser can attach as open-view, token-view, or control client.

### LUC-402 - Request scheduler, cancellation, and local caches
- **Lane:** WEB
- **Size:** XL
- **Depends on:** LUC-301
- **Goal:** Implement client-side request prioritization, cancellation, CPU decoded cache, and GPU texture cache.
- **Deliverables:** scheduler; cache policies; generation-aware invalidation.
- **Acceptance:** panning/zooming cancels stale fetches and avoids uncontrolled cache growth.

### LUC-403 - 2D compositing renderer
- **Lane:** WEB
- **Size:** XL
- **Depends on:** LUC-402
- **Goal:** Render 2D images with channel-block fetches, per-channel compositing, and progressive preview-to-quantitative replacement.
- **Deliverables:** tile renderer; per-layer blend modes; contrast/gamma/colormap support.
- **Acceptance:** multi-channel 2D scenes render correctly and refine without mixed-generation artifacts.

### LUC-404 - 2D interaction model
- **Lane:** WEB
- **Size:** L
- **Depends on:** LUC-400, LUC-403
- **Goal:** Implement pan, zoom, z-scrub, t-scrub, channel selection, and gesture transactions.
- **Deliverables:** interaction handlers; gesture command emitter; client prediction logic.
- **Acceptance:** interaction feels smooth and authoritative reconciliation is not visually disruptive.

### LUC-405 - Minimap and viewport overlays
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-403
- **Goal:** Render minimap, viewport rectangle, and z-indicator with support for pinned overview source.
- **Deliverables:** minimap UI component; overview-layer selector.
- **Acceptance:** minimap tracks the active view and shows current context accurately.

### LUC-406 - Warning surfaces and generation/provenance badges
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-107, LUC-403
- **Goal:** Surface warnings such as uncalibrated overlays, computed-at-LOD, stale derived layers, and build-incomplete.
- **Deliverables:** warning badges, layer badges, session notices.
- **Acceptance:** warnings from engine are visible and understandable in the client.

---

## WS5 - Python, CLI, and Jupyter surfaces

### LUC-500 - Python client bindings over canonical commands
- **Lane:** TOOLS
- **Size:** L
- **Depends on:** LUC-102, LUC-103
- **Goal:** Provide Python wrappers for engine commands and events without introducing a second state model.
- **Deliverables:** Python client package; session attach; `viewer.add_image`, `set_point`, camera methods.
- **Acceptance:** notebook code can drive the same canonical command set as browser/CLI.

### LUC-501 - Jupyter widget shell
- **Lane:** TOOLS
- **Size:** XL
- **Depends on:** LUC-500, LUC-401, LUC-403
- **Goal:** Embed the Lucida web client in notebooks with full interactive control.
- **Deliverables:** ipywidget or equivalent embedding wrapper.
- **Acceptance:** notebook users can open a viewer and interact with a session inline.

### LUC-502 - CLI core command surface
- **Lane:** TOOLS
- **Size:** L
- **Depends on:** LUC-500 or direct protocol client
- **Goal:** Implement `open`, `attach`, `pan`, `set`, `overview`, and snapshot commands.
- **Deliverables:** CLI package with JSON-first outputs and human-readable mode.
- **Acceptance:** session control from shell works without hidden client-only features.

### LUC-503 - CLI target/cutout/publish commands
- **Lane:** TOOLS
- **Size:** M
- **Depends on:** WS9 core services
- **Goal:** Expose shared Targets, cutouts, and derived layer publish flows via CLI.
- **Deliverables:** `target add/jump`, `cutout`, `publish` commands.
- **Acceptance:** the prototyping loop can be driven from command line tools.

### LUC-504 - Scene and context package CLI/Python surfaces
- **Lane:** TOOLS
- **Size:** M
- **Depends on:** WS6 artifacts
- **Goal:** Support scene export/import and context package capture/open via both CLI and Python.
- **Deliverables:** `scene export/import`, `snapshot_context_package`, `open_context_package`.
- **Acceptance:** artifacts can be created and reopened from tooling surfaces.

---

## WS6 - Scene files, context packages, and targets

### LUC-600 - Shared scene model and layer-order service
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-100, LUC-102
- **Goal:** Implement authoritative shared scene objects: sources, datasets, layers, order, overview settings.
- **Deliverables:** scene reducers; layer stack service.
- **Acceptance:** shared scene can be serialized, diffed by subtree replacement, and restored.

### LUC-601 - Target model and shared target service
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-600
- **Goal:** Implement shared Targets with navigation state and analysis ROI defaults.
- **Deliverables:** target schema implementation; create/update/delete/jump operations.
- **Acceptance:** targets can be created once and used by all clients as shared navigation/ROI objects.

### LUC-602 - Scene file export/import
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-600, LUC-601
- **Goal:** Serialize and restore scene files, with live vs pinned references handled correctly.
- **Deliverables:** scene serializer/deserializer; warnings on exporting live scenes.
- **Acceptance:** reopening a scene reconstructs the shared scene model predictably.

### LUC-603 - Context package capture (thin + guaranteed visual)
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-600, client screenshot capture path
- **Goal:** Capture viewport image, minimap, state metadata, warnings, and generation refs into an LCP.
- **Deliverables:** package writer; manifest schema; validation.
- **Acceptance:** package opens as a frozen scene without dataset access and rehydrates when data is available.

### LUC-604 - Context package thick-minimal option
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-603, data-plane key resolution
- **Goal:** Optionally bundle only the minimal tiles/bricks required to reproduce the captured view offline.
- **Deliverables:** thick-minimal packaging mode.
- **Acceptance:** offline reopen of the captured view works without source access.

### LUC-605 - Shared vs per-client render defaults promotion
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-600
- **Goal:** Let users promote per-client render settings to shared scene defaults via explicit commands.
- **Deliverables:** command handling and scene updates for promoted defaults.
- **Acceptance:** collaborators can keep independent settings unless one explicitly promotes shared defaults.

---

## WS7 - Labels and metadata

### LUC-700 - Labels layer rendering and outlines
- **Lane:** WEB
- **Size:** L
- **Depends on:** LUC-403
- **Goal:** Render label rasters with shader-based outlines in 2D and orthoslices.
- **Deliverables:** label render pipeline; outline thickness support.
- **Acceptance:** label boundaries are clear and performant on large rasters.

### LUC-701 - Dense ID remap builder and mapping persistence
- **Lane:** DATA
- **Size:** XL
- **Depends on:** metadata sidecar source of truth
- **Goal:** Build dense ID mappings from original sparse IDs, preserve stability where possible, append new IDs, and persist mapping epochs.
- **Deliverables:** remap generator; persistence layer; optional compaction pathway.
- **Acceptance:** million-scale sparse label IDs map to dense render IDs without full-raster scan on every load.

### LUC-702 - SQLite metadata sidecar schema and loader
- **Lane:** DATA
- **Size:** L
- **Depends on:** LUC-700, LUC-701
- **Goal:** Define and implement Lucida-managed SQLite sidecars for label metadata and ID mappings.
- **Deliverables:** sidecar schema; loader; revision tracking; optional Parquet export utility.
- **Acceptance:** sidecars can be loaded, queried, and hot-reloaded independently of raster changes.

### LUC-703 - Filter DSL parser, validator, and evaluator
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-702
- **Goal:** Implement the structured filter AST with validation and server-side evaluation against sidecars.
- **Deliverables:** parser/validator/evaluator; null and unknown-policy support.
- **Acceptance:** filter queries return correct matching IDs and stats.

### LUC-704 - Visibility bitset generation, compression, and client upload
- **Lane:** ENG/WEB
- **Size:** L
- **Depends on:** LUC-703, LUC-700
- **Goal:** Generate visibility bitsets over dense IDs, optionally compress them on wire, and upload them to GPU.
- **Deliverables:** bitset transport path; client unpacker; GPU binding.
- **Acceptance:** metadata filtering updates label visibility interactively without rerendering rasters server-side.

### LUC-705 - Metadata hot-reload and active-filter recompute
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-702, LUC-703, LUC-704
- **Goal:** Detect sidecar changes, update metadata revisions, and recompute active filters automatically.
- **Deliverables:** metadata revision events; filter recompute service.
- **Acceptance:** a changed metadata table updates the current label visibility without manual refresh.

### LUC-706 - Label inspection and metadata-driven coloring
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-702, LUC-700
- **Goal:** Support click/hover inspection and optional color-by-class behavior.
- **Deliverables:** inspection UI; class coloring path; unknown policy display.
- **Acceptance:** users can inspect objects and optionally color/filter by metadata-derived attributes.

### LUC-707 - Incomplete index and metadata mismatch warnings
- **Lane:** ENG
- **Size:** S
- **Depends on:** LUC-702
- **Goal:** Detect and surface conditions where raster IDs and sidecar IDs do not fully agree.
- **Deliverables:** warning generation and propagation.
- **Acceptance:** incomplete index state is visible in UI and artifacts.

---

## WS8 - 3D rendering and brick UX

### LUC-800 - 3D brick request planner and cache integration
- **Lane:** WEB
- **Size:** L
- **Depends on:** LUC-402, LUC-205
- **Goal:** Determine which bricks are needed for current 3D view and schedule them efficiently.
- **Deliverables:** brick planner; generation-aware cache integration.
- **Acceptance:** 3D camera changes fetch the right bricks with cancellation and prioritization.

### LUC-801 - Orthoslice renderer from bricks
- **Lane:** WEB
- **Size:** L
- **Depends on:** LUC-800
- **Goal:** Render XY/XZ/YZ orthoslices sampled from brick textures.
- **Deliverables:** orthoslice render pipeline; shared camera target semantics.
- **Acceptance:** orthoslices render correctly and stay aligned across orientations.

### LUC-802 - Slab/MIP renderer
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-800
- **Goal:** Render slab and maximum-intensity projections from bricks.
- **Deliverables:** slab/MIP shader path and controls.
- **Acceptance:** users can switch projection modes and adjust slab behavior.

### LUC-803 - Volume raymarch renderer
- **Lane:** WEB
- **Size:** XL
- **Depends on:** LUC-800
- **Goal:** Implement a basic but performant raymarcher for volumetric rendering from bricks.
- **Deliverables:** raymarch shader path; quality controls; compositing.
- **Acceptance:** coarse 3D render appears quickly and refines as more bricks arrive.

### LUC-804 - World-space-ish brick shaping autotuner
- **Lane:** DATA/WEB
- **Size:** M
- **Depends on:** LUC-205, LUC-800
- **Goal:** Tune brick shapes by LOD and calibration to approximate world-space cubes within size budgets.
- **Deliverables:** autotuning heuristics; metadata surfaced to client.
- **Acceptance:** anisotropic datasets render with sensible brick aspect choices.

### LUC-805 - 3D entry flow and progressive UX
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-205, LUC-801, LUC-803
- **Goal:** Make 3D mode entry predictable, with lazy brick build progress and usable coarse output before full availability.
- **Deliverables:** 3D mode UI state; build progress notices; fallbacks.
- **Acceptance:** entering 3D mode on a new source yields a visible coarse render rather than a blank wait state.

---

## WS9 - Targets, RegionRecipes, cutouts, and sparse derived layers

### LUC-900 - RegionRecipe generator
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-601, LUC-300
- **Goal:** Generate deterministic RegionRecipes from current view or Target, including LOD, core ROI, halo ROI, channel blocks, and chunk manifests.
- **Deliverables:** recipe generator service; validation logic.
- **Acceptance:** the same target and parameters always resolve to the same recipe for a given generation.

### LUC-901 - Cutout materialization service
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-900, LUC-301
- **Goal:** Materialize chunked cutouts from RegionRecipes at full, match_view, or explicit LOD.
- **Deliverables:** cutout request API; chunk refs/manifests; adapters for dense arrays.
- **Acceptance:** compute clients can obtain chunked cutouts without bespoke source handling.

### LUC-902 - Chunked cutout adapters and developer ergonomics
- **Lane:** TOOLS
- **Size:** M
- **Depends on:** LUC-901
- **Goal:** Provide helper adapters to iterate chunk-wise or densify when needed for prototyping code.
- **Deliverables:** Python adapters; examples; documentation.
- **Acceptance:** a user can turn a cutout into a usable analysis object with minimal boilerplate.

### LUC-903 - Derived layer model and dependency policy
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-600
- **Goal:** Implement sparse derived layers with dependency metadata, pinned-to-base-generation by default, and stale-base warning support.
- **Deliverables:** derived layer schema and state; dependency validation.
- **Acceptance:** derived layers survive in scene state and warn when base generation changes.

### LUC-904 - Publish batch ingest and write revisioning
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-903, LUC-301
- **Goal:** Accept chunk-aligned publish batches, assign write revisions, and apply last-write-wins semantics.
- **Deliverables:** publish batch API; write_rev handling; conflict logging.
- **Acceptance:** chunk publishes update derived layers predictably and are audit logged.

### LUC-905 - Halo/core publish semantics and LOD provenance
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-904
- **Goal:** Implement default halo publish, optional core-only publish, and explicit computed-at-LOD provenance on derived layers.
- **Deliverables:** publish extent handling; provenance metadata; warning generation.
- **Acceptance:** published layers correctly represent halo/core choices and surface LOD provenance in UI/artifacts.

### LUC-906 - Derived layer LOD propagation and transparency semantics
- **Lane:** ENG/WEB
- **Size:** L
- **Depends on:** LUC-904, LUC-403
- **Goal:** Generate coarser LODs from published data where appropriate, keep missing chunks transparent, and upsample nearest available LOD on render with a badge.
- **Deliverables:** derived layer LOD rules; client rendering behavior.
- **Acceptance:** sparse derived layers remain visually honest while still usable at multiple zoom levels.

### LUC-907 - Overwrite vs new-layer publish flow
- **Lane:** ENG/TOOLS
- **Size:** M
- **Depends on:** LUC-904
- **Goal:** Support both overwriting an existing derived layer and creating a new derived layer on publish.
- **Deliverables:** publish options; state transitions; audit trail differences.
- **Acceptance:** users can choose iterative overwrite or branch to a new derived layer intentionally.

---

## WS10 - Permissions, collaboration, and audit

### LUC-1000 - Token service and share-link model
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-100, LUC-104
- **Goal:** Implement persistent control tokens, optional view tokens, and shareable link generation.
- **Deliverables:** token store; mint/revoke APIs; share-link generation.
- **Acceptance:** sessions can run in open-view or token-view modes; control tokens gate scene edits and publish.

### LUC-1001 - LAN exposure mode and access policy controls
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-1000
- **Goal:** Support localhost-only mode, LAN mode with open-view default, and LAN mode with required view token.
- **Deliverables:** binding configuration; exposure policy state; admin controls.
- **Acceptance:** sessions can be exposed safely according to policy without changing app code.

### LUC-1002 - Derived layer write ACLs
- **Lane:** ENG
- **Size:** M
- **Depends on:** LUC-903, LUC-1000
- **Goal:** Allow derived layers to restrict which control-token holders may publish to them.
- **Deliverables:** ACL schema; enforcement; audit details.
- **Acceptance:** unauthorized chunk publishes are rejected deterministically.

### LUC-1003 - Audit log storage and query surface
- **Lane:** ENG
- **Size:** L
- **Depends on:** LUC-104, LUC-904
- **Goal:** Persist and expose an append-only audit log for scene edits, lease changes, and publish batches.
- **Deliverables:** audit store; query API; event export.
- **Acceptance:** who-changed-what can be answered for all shared operations.

### LUC-1004 - Client roster and collaboration indicators
- **Lane:** WEB
- **Size:** M
- **Depends on:** LUC-103, LUC-104
- **Goal:** Show connected clients, current lease holder, and passive lease-change notifications.
- **Deliverables:** roster UI; lease holder badge; passive notices.
- **Acceptance:** collaboration state is visible without interruptive dialogs.

---

## WS11 - QA, performance, observability, and release hardening

### LUC-1100 - Synthetic dataset corpus and fixture generator
- **Lane:** QA/DATA
- **Size:** L
- **Depends on:** LUC-002
- **Goal:** Generate deterministic test datasets covering 2D, 3D, anisotropy, multi-channel, labels, sparse IDs, and active source churn.
- **Deliverables:** fixture generator; stored test corpus metadata.
- **Acceptance:** core tests can run against repeatable datasets in CI and perf harnesses.

### LUC-1101 - End-to-end acceptance harness
- **Lane:** QA
- **Size:** XL
- **Depends on:** LUC-003, M1-capable stack
- **Goal:** Automate the critical sequences from the workflow document across engine and client.
- **Deliverables:** E2E harness; milestone test suites.
- **Acceptance:** milestone exits are mechanically testable.

### LUC-1102 - Generation-consistency and source-churn tests
- **Lane:** QA
- **Size:** L
- **Depends on:** LUC-201, LUC-202, LUC-402
- **Goal:** Stress source updates and ensure no mixed-generation rendering or stale request leakage.
- **Deliverables:** churn simulations; assertions on generation correctness.
- **Acceptance:** repeated source changes do not produce mixed-generation frames.

### LUC-1103 - Label-scale performance tests
- **Lane:** QA
- **Size:** L
- **Depends on:** WS7 complete enough to run
- **Goal:** Validate filtering and rendering performance for millions of sparse IDs.
- **Deliverables:** perf cases; thresholds; dashboards.
- **Acceptance:** interactive filtering remains acceptable within agreed budgets.

### LUC-1104 - 3D rendering performance harness
- **Lane:** QA/WEB
- **Size:** L
- **Depends on:** WS8 initial completion
- **Goal:** Measure brick throughput, FPS, cache churn, and 3D entry/refinement behavior.
- **Deliverables:** 3D perf suite; quality profiles.
- **Acceptance:** 3D mode meets baseline usability targets and does not regress silently.

### LUC-1105 - Observability and operational telemetry
- **Lane:** QA/ENG
- **Size:** M
- **Depends on:** core services in place
- **Goal:** Emit structured metrics and logs for session count, build progress, request rates, cache hit rates, errors, and publish activity.
- **Deliverables:** metrics schema; logs; dashboards.
- **Acceptance:** operators can diagnose generation stalls, cache pressure, and permission issues.

### LUC-1106 - Developer docs, runbooks, and examples
- **Lane:** QA/TOOLS
- **Size:** M
- **Depends on:** M5 near completion
- **Goal:** Provide examples for opening datasets, using Targets, cutouts, publish flows, sidecar metadata, and artifact export.
- **Deliverables:** docs; cookbook notebooks; CLI examples.
- **Acceptance:** a new developer can exercise all core flows from documented examples.

## 6. Critical path

The highest-risk / longest dependency chain is:

1. LUC-000 Freeze schema review points
2. LUC-100 Session service skeleton
3. LUC-102 Command validation and routing
4. LUC-103 Typed event emission
5. LUC-200 Source registry and inspection
6. LUC-201 Watcher and stability window
7. LUC-203 Canonical cache builder
8. LUC-204 2D tile/previews builder
9. LUC-301 Data-plane endpoints
10. LUC-400 Client state store
11. LUC-402 Request scheduler and caches
12. LUC-403 2D compositing renderer

That chain yields the first integrated 2D milestone. After M1, the next critical chain is:

13. LUC-601 Target model
14. LUC-900 RegionRecipe generator
15. LUC-901 Cutout materialization
16. LUC-903 Derived layer model
17. LUC-904 Publish batch ingest
18. LUC-906 Derived layer LOD/transparency behavior

For labels and 3D, the critical chains are relatively independent and can be parallelized after M1.

## 7. Recommended implementation order

### Phase A - Foundation and contracts
Start with:
- LUC-000 to LUC-004
- LUC-100 to LUC-105
- LUC-200, LUC-202, LUC-300

Goal: frozen contracts plus minimal authoritative engine skeleton.

### Phase B - First 2D usable viewer
Then build:
- LUC-201, LUC-203, LUC-204, LUC-207
- LUC-301, LUC-302
- LUC-400 to LUC-406
- LUC-500 and LUC-502

Goal: open source, first paint, refine, navigate, and inspect warnings.

### Phase C - Shared artifacts and shared navigation
Then:
- LUC-600 to LUC-605
- LUC-501, LUC-504

Goal: scenes, context packages, and Targets become stable.

### Phase D - Labels and metadata
Then:
- LUC-700 to LUC-707
- LUC-304

Goal: label intelligence and filter-driven visibility.

### Phase E - 3D
Then:
- LUC-205
- LUC-800 to LUC-805

Goal: orthoslices, slab/MIP, and raymarch.

### Phase F - ROI prototyping loop
Then:
- LUC-900 to LUC-907
- LUC-503

Goal: cutout -> compute -> sparse derived publish loop.

### Phase G - Collaboration hardening and release quality
Then:
- LUC-1000 to LUC-1004
- LUC-1100 to LUC-1106

Goal: robust shared use, tests, telemetry, and operational readiness.

## 8. Risks and review checkpoints

### R1 - OME-Zarr canonical reuse vs duplication
Review after LUC-203/LUC-204 whether the canonical cache can fully serve as 2D tile representation or whether extra duplication is needed for browser efficiency.

### R2 - WebGPU texture/upload constraints
Review after LUC-402/LUC-403 and again after LUC-803 whether texture formats and upload patterns force adjustments to chunk sizes or channel block behavior.

### R3 - Dense ID scaling
Review after LUC-701/LUC-704 whether bitset sizes, compression, and client GPU upload paths remain efficient at the upper bound of expected object counts.

### R4 - Source churn on mutable directories
Review after LUC-201/LUC-1102 whether debounce-only directory stabilization is sufficient on target filesystems.

### R5 - Derived layer user semantics
Review after LUC-905/LUC-906 whether default halo publishing and nearest-available LOD upsampling produce the user behavior you want in practice.

## 9. Definition of done for Lucida core

Lucida core should be considered implementation-complete for this spec when all of the following are true:
- the engine is authoritative and clients only predict view state
- 2D viewing, 3D viewing, label filtering, and ROI prototyping all work end-to-end against the canonical protocol
- source updates create new working generations without mixed-generation rendering
- scene files and context packages are reproducible and reopen correctly
- collaboration permissions, lease semantics, and audit logging are operational
- the acceptance harness passes for all milestone exits
- performance and observability tooling are in place well enough to catch regressions before release

## 10. Suggested next docs after this plan

1. `lucida_storage_layout.md`  
   Formalize OME-Zarr + `/lucida/` layout, metadata fields, generation metadata, sidecar placement, and validator rules.

2. `lucida_http_and_transport.md`  
   Formalize control-plane transport choices, message framing, endpoint paths, auth headers, and object/static URL compatibility.

3. `lucida_acceptance.md`  
   Convert milestone exits and sequence invariants into explicit pass/fail tests and performance budgets.
