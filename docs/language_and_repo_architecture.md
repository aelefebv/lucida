# Lucida Language and Repo Architecture

Version: 0.1 draft  
Date: 2026-02-28  
Status: Recommended implementation architecture derived from the Lucida spec set

## 1. Purpose

This document turns the Lucida product and protocol specifications into a concrete implementation architecture.

It answers:
- which programming languages should own which parts of the system
- how the repository should be structured
- where the hard boundaries between components should be
- how shared schemas should flow across languages
- how builds, tests, releases, and plugins should work
- how to keep the architecture consistent with Lucida's long-term goals: streaming-first, WebGPU-first, authoritative engine, and Python-native scientific workflows

This is not a code-level design for every module. It is the language, packaging, and ownership blueprint that the implementation plan should sit on top of.

---

## 2. Executive recommendation

Lucida should be built primarily in:
- **Rust** for the engine and system core
- **TypeScript** for the browser client and browser-facing UI logic
- **Python** for the notebook-facing SDK, scientific workflow integration, and prototype pipeline ergonomics
- **WGSL** for GPU shaders

If a desktop shell is later packaged, the recommended wrapper is:
- **Tauri** (Rust + web frontend)

This stack best matches the product shape:
- a long-running, concurrency-heavy, IO-heavy, authoritative service
- a browser-first interactive client with WebGPU rendering
- a Python-native cutout/prototyping/publish loop for scientific users

---

## 3. Why this stack fits Lucida

### 3.1 Why Rust should own the engine

Lucida's engine is not a simple API server. It is simultaneously:
- an authoritative state machine
- a session server
- a source watcher
- an ingest and generation orchestrator
- a tile/brick registry and payload server
- a lease/auth/audit service
- a long-lived cache manager

That workload strongly favors a systems language with:
- strong concurrency support
- predictable binary and memory behavior
- very good filesystem and networking support
- strong safety properties for long-running services
- good packaging as a single local or remote daemon

Rust is the strongest fit because it provides:
- memory safety without a GC pause model
- good async/networking ecosystem
- good binary serialization and storage tooling
- reliable performance for cache/build orchestration
- good packaging for CLI + daemon + optional desktop shell support

Rust also keeps the engine credible as the product grows from local single-user use to multi-client collaboration and remote deployment.

### 3.2 Why TypeScript should own the client

The browser is a core product surface, not a convenience layer. Lucida's client must:
- run in browsers
- drive WebGPU
- manage client-side caches and fetch scheduling
- embed into Jupyter
- optionally become the desktop shell UI later

That naturally makes TypeScript the correct client language.

TypeScript provides:
- first-class browser tooling
- straightforward integration with WebGPU and WGSL shader pipelines
- strong package tooling for modular UI and rendering subsystems
- easy reuse across browser, embedded Jupyter widget frontends, and desktop-shell webviews

The key design principle is: **there should be one primary frontend implementation**. The browser client should not be a secondary UI behind a separate desktop-native GUI.

### 3.3 Why Python must be first-class but should not be the engine

Python is essential for Lucida because the intended users will want to:
- work in notebooks
- request cutouts into NumPy/Zarr/xarray/Dask/PyTorch workflows
- run prototype or production analysis pipelines on ROIs
- publish results back as sparse derived layers

Python should therefore be a first-class control and workflow language.

However, it should not be the authoritative engine because:
- multi-client concurrency and long-lived service robustness become harder
- memory ownership and binary payload lifecycle become messy
- service hardening, auth, and streaming concerns become more fragile over time

The right split is:
- **Rust owns authority and lifecycle**
- **Python owns user workflows and scientific interop**

### 3.4 Why not pure Python, pure Node, or C++ as the default choice

#### Pure Python engine
Not recommended.

Pros:
- strong imaging ecosystem
- fast prototype velocity

Cons:
- weaker long-term daemon/service ergonomics
- more complexity around concurrency, streaming, and memory ownership
- more difficult path to a hardened multi-client product

#### Pure Node/TypeScript engine
Not recommended.

Pros:
- one main language across frontend and backend
- good web tooling

Cons:
- less natural fit for binary-heavy ingest, storage, and long-running cache/build orchestration
- weaker systems-level control for the engine compared with Rust

#### C++ engine
Possible, but not preferred.

Pros:
- high performance
- mature rendering/compute ecosystem

Cons:
- higher complexity and lower implementation velocity for the product team
- more safety and maintainability burden than Rust
- fewer ergonomics advantages for this architecture specifically

---

## 4. Language ownership boundaries

### 4.1 Rust ownership

Rust should own the following packages and responsibilities:

- session management
- authoritative state model and reducers
- command validation and routing
- event emission
- permissions, tokens, lease service, audit log
- source registry and source watching
- generation management and GC
- canonical cache and stream-store build orchestration
- tile/brick payload serving or URL minting
- chunk key parsing and validation
- metadata sidecar lifecycle and query service
- CLI
- plugin host for engine-side plugins
- optional desktop shell bootstrap

Rust should also own any shared, non-UI utilities that must be highly reliable or performance-sensitive, such as:
- payload header parsing
- chunk locator logic
- generation-consistency rules
- storage layout readers/writers
- derived-layer publish commit path

### 4.2 TypeScript ownership

TypeScript should own:
- browser UI shell
- session attach/reconnect behavior from the client side
- WebGPU renderer orchestration
- shader binding setup and render graph logic
- client-side chunk scheduling and cancellation
- CPU/GPU caches in the client
- minimap and overlays
- label visibility mask application
- client-side warning presentation
- Jupyter widget frontend
- shared viewer interaction model across browser and desktop shell

TypeScript should also own the SDK-like frontend packages used by multiple UI shells, such as:
- protocol client bindings
- chunk fetch and decode pipeline
- view-state store
- reusable rendering packages

### 4.3 Python ownership

Python should own:
- notebook-facing viewer control API
- cutout request helpers
- cutout materialization adapters
- publish helpers for sparse derived layers
- user workflow ergonomics and convenience wrappers
- scientific type adapters for NumPy, Dask, Zarr, xarray, PyTorch, CuPy, etc.
- optional helper processes for niche format ingestion or metadata extraction when the Rust engine needs ecosystem help

Python should not own:
- authoritative state
- auth and lease enforcement
- generation lifecycle
- storage layout truth
- shared-scene mutation rules

### 4.4 WGSL ownership

WGSL is a first-class artifact type, not an implementation detail.

WGSL should be versioned and tested like source code. It should own:
- 2D image compositing shaders
- label outline shaders
- minimap shaders
- orthoslice sampling shaders
- MIP/slab shaders
- raymarch shaders
- optional coverage overlays for sparse derived layers

Shader modules should live in a dedicated shared location and be consumed by the TypeScript renderer.

---

## 5. Repo strategy

## 5.1 Recommendation: monorepo

Lucida should use a **monorepo**.

Reasons:
- shared evolution of schemas, transport contracts, and artifacts across engine/client/Python
- easier coordinated refactors during early architecture stabilization
- simpler CI for cross-language compatibility checks
- easier visibility of milestone progression across teams
- better fit for the spec-heavy phase where contracts are still becoming executable

A multi-repo setup would create unnecessary friction at this stage because nearly every meaningful change crosses boundaries.

### 5.2 Recommended top-level structure

```text
lucida/
  README.md
  docs/
    spec/
    adr/
    architecture/
  schemas/
    jsonschema/
    examples/
    codegen/
  engine/
    Cargo.toml
    crates/
      lucida-core-model/
      lucida-session/
      lucida-control/
      lucida-events/
      lucida-auth/
      lucida-audit/
      lucida-storage/
      lucida-ingest/
      lucida-watch/
      lucida-metadata/
      lucida-data-plane/
      lucida-cli/
      lucida-plugin-api/
      lucida-plugin-host/
      lucida-desktop-shell/        # optional later
  client-web/
    package.json
    packages/
      protocol-client/
      state-store/
      data-client/
      decode/
      renderer-core/
      renderer-2d/
      renderer-3d/
      minimap/
      ui-components/
      app/
      jupyter-widget/
  python-sdk/
    pyproject.toml
    packages/
      lucida/
      lucida_cutout/
      lucida_publish/
      lucida_notebook/
      lucida_adapters/
      lucida_workers/              # optional bridge processes
  shaders/
    wgsl/
    tests/
  fixtures/
    datasets/
    scenes/
    context-packages/
  tools/
    scripts/
    dev/
    release/
  tests/
    integration/
    e2e/
    perf/
```

---

## 6. Shared contract strategy

### 6.1 Schemas are the source of truth

The `schemas/` directory should be a first-class source-of-truth package.

It should contain:
- JSON Schemas for commands, events, state objects, RegionRecipe, publish batches, scene files, and context packages
- example fixtures for each schema
- versioning metadata
- code generation helpers for TypeScript and Python

Rust may or may not directly generate types from the same schemas, but Rust must conform to them and should run compatibility validation in CI.

### 6.2 Contract flow across languages

Recommended flow:
- Schemas are authored in JSON Schema or a closely related machine-readable form.
- TypeScript types are generated from schemas where practical.
- Python pydantic/dataclass models are generated or maintained against the same schemas.
- Rust validates wire payloads against equivalent native model definitions, with schema compatibility tests.

Important rule:
- **No language package should invent its own wire shape.**
- Wire contracts must be defined centrally and tested against examples.

### 6.3 Contract versioning

Schema changes should be treated as explicit contract changes with:
- semantic versioning for schema package
- changelog entries
- migration notes when backward compatibility is broken
- fixture updates in the same PR

---

## 7. Package ownership and boundaries

### 7.1 Engine package breakdown

Recommended Rust crates:

#### `lucida-core-model`
Owns:
- canonical IDs
- revisions
- enums and core state structs
- warning taxonomy
- stable internal representations shared by engine crates

Should not own:
- transport code
- storage code
- plugin loading

#### `lucida-session`
Owns:
- session lifecycle
- client attachment state
- per-session authoritative state container

#### `lucida-control`
Owns:
- command validation
- routing
- reducer invocation
- permission class dispatch

#### `lucida-events`
Owns:
- event envelope generation
- snapshot emission
- state diff or subtree replacement logic

#### `lucida-auth`
Owns:
- view/control tokens
- token revocation
- LAN mode exposure rules
- lease permissions

#### `lucida-audit`
Owns:
- audit log append path
- event serialization for audit
- actor labeling and timestamps

#### `lucida-storage`
Owns:
- canonical OME-Zarr-compatible layout writers/readers
- Lucida `/lucida/` namespace layout
- chunk key to object-path mapping
- generation stores and pinning metadata

#### `lucida-ingest`
Owns:
- source-to-cache ingest orchestration
- preview generation
- multiscale build scheduling
- 3D brick build scheduling
- downsample and coverage generation jobs

#### `lucida-watch`
Owns:
- filesystem/object watch integration
- debounce/stability window logic
- generation bump triggering

#### `lucida-metadata`
Owns:
- SQLite sidecar lifecycle
- dense-ID mapping tables
- label metadata query service
- filter result computation and bitset generation

#### `lucida-data-plane`
Owns:
- HTTP fetch serving
- payload headers
- immutable object exposure
- upload staging for derived publish

#### `lucida-cli`
Owns:
- user/admin command-line interface
- session attach
- snapshot, overview, auth utilities

#### `lucida-plugin-api` and `lucida-plugin-host`
Own:
- plugin interfaces and capabilities
- engine-side plugin loading model
- process boundaries for out-of-process plugins

### 7.2 Client package breakdown

Recommended TypeScript packages:

#### `protocol-client`
Owns:
- control-plane connection
- attach/auth handshake
- message serialization/deserialization
- reconnect logic

#### `state-store`
Owns:
- client-side state projection
- authoritative snapshot and event application
- local prediction state for view interactions

#### `data-client`
Owns:
- chunk key to URL resolution
- payload fetch orchestration
- cancellation, retries, priority queues

#### `decode`
Owns:
- payload header parsing
- zstd/lz4 decompression integration
- typed-array preparation for uploads

#### `renderer-core`
Owns:
- device setup
- texture/resource managers
- shared shader program bindings
- render pass scheduling

#### `renderer-2d`
Owns:
- 2D slice rendering
- per-channel compositing
- minimap feed usage where relevant

#### `renderer-3d`
Owns:
- orthoslices from bricks
- slab/MIP
- raymarch setup and quality controls

#### `minimap`
Owns:
- overview view rendering
- viewport rectangle and z indicator overlays

#### `ui-components`
Owns:
- layer panels
- channel panels
- warning badges
- target controls
- publish/cutout dialogs

#### `app`
Owns:
- assembled browser app shell
- route/layout composition

#### `jupyter-widget`
Owns:
- notebook embedding wrapper for the same client implementation

### 7.3 Python package breakdown

#### `lucida`
Owns:
- high-level Python client API
- session attach
- viewer object model

#### `lucida_cutout`
Owns:
- RegionRecipe request helpers
- cutout materialization wrappers
- chunked-to-dense adapters

#### `lucida_publish`
Owns:
- derived publish helpers
- overwrite/new behavior wrappers
- staging convenience tools

#### `lucida_notebook`
Owns:
- notebook-specific embedding and convenience APIs

#### `lucida_adapters`
Owns:
- NumPy, Dask, xarray, PyTorch, Zarr adapter layers

#### `lucida_workers` (optional bridge)
Owns:
- out-of-process helper workers for niche formats or ecosystem edge cases
- must never become authoritative system core

---

## 8. Engine-client boundary

### 8.1 Principle

The browser client is not a thin remote-control UI over server-rendered frames. It is a real renderer.

The engine-client boundary is therefore:
- **engine owns truth, lifecycle, build orchestration, auth, and immutable payload addressing**
- **client owns render-time LOD choice, local prediction, local caches, shader execution, and presentation**

### 8.2 Data path

1. Engine publishes authoritative state and generation availability.
2. Client decides what tiles/bricks to request.
3. Client fetches immutable payloads over HTTP.
4. Client decodes and uploads to WebGPU.
5. Client renders locally.

This boundary should not be violated by adding server-side rendering into the normal path.

### 8.3 Jupyter boundary

The Jupyter experience should use:
- Python for notebook API and workflow control
- the same TypeScript/WebGPU frontend embedded as a widget or iframe-based integration

The Python notebook package should not attempt to create a separate rendering implementation.

---

## 9. Python bridge model

### 9.1 Recommended principle

Python talks to the engine over the same protocol model as other clients.

Default path:
- Python API sends commands to engine
- Python requests RegionRecipe/cutouts
- engine returns references and metadata
- Python materializes arrays using those references
- Python publishes results back using derived publish APIs

### 9.2 Optional local fast path

For local deployments where the Python process runs on the same machine as the Lucida cache, the Python SDK MAY use a local fast path for cutout access, such as direct file/object reads from the cache.

Important constraint:
- this must remain an optimization, not a separate semantic path
- semantics must match the reference protocol path

### 9.3 Optional Python worker subprocesses

Use this only as a pragmatic bridge when the Rust ecosystem is missing critical format functionality.

Allowed use cases:
- niche metadata extraction
- awkward microscopy format handling
- compatibility bridges during early implementation

Disallowed use cases:
- owning session state
- enforcing permissions
- acting as the canonical ingest orchestration authority

The long-term architecture should remain Rust-first for engine authority.

---

## 10. Desktop shell recommendation

If Lucida later ships a desktop application wrapper, the preferred architecture is:
- Rust engine as a local daemon or embedded process
- TypeScript browser client running in a desktop webview
- Tauri as the packaging layer

Reasons:
- preserves one primary frontend implementation
- reuses Rust engine code directly
- aligns with the browser-first product strategy
- avoids creating a second native GUI stack

This is a packaging decision, not a reason to fork the client architecture.

---

## 11. Plugin language strategy

### 11.1 Core principle

Plugins should follow process and language boundaries that preserve engine safety and reproducibility.

There should be two plugin classes:
- **engine-side plugins**
- **client-side plugins**

### 11.2 Engine-side plugins

Recommended first-class language: **Rust**.

Why:
- engine-side plugins may participate in ingest, loaders, or command reducers
- these are close to critical product invariants
- in-process plugins should be strongly typed and memory-safe

Secondary supported mode: **out-of-process Python plugins** for specific extension points.

Python plugins are appropriate for:
- custom loader helpers
- research-oriented derived computations
- metadata enrichment jobs

Python plugins should not get arbitrary in-process access to engine memory or state.
They should communicate through explicit plugin APIs, RPC, or job protocols.

### 11.3 Client-side plugins

Recommended language: **TypeScript**, with WGSL where rendering is involved.

Client plugins may provide:
- additional layer UIs
- new interaction tools
- additional shader-backed renderers
- optional panels

Any client plugin that affects authoritative state must do so through canonical commands only.

### 11.4 Plugin packaging recommendation

Each plugin should have:
- manifest file
- declared capabilities
- declared API/schema compatibility version
- explicit permissions
- test fixtures

Do not allow unconstrained arbitrary code execution inside the engine process as the default plugin model.

---

## 12. Build and release strategy

### 12.1 Build systems

Recommended tools:
- Rust: Cargo workspace
- TypeScript: pnpm or npm workspaces (pnpm preferred for monorepo efficiency)
- Python: pyproject-based builds (uv preferred, hatchling/pdm/poetry acceptable; keep it simple)
- Schemas: dedicated codegen scripts under `schemas/codegen/`

### 12.2 CI layers

CI should have separate lanes plus cross-stack compatibility checks.

Required CI categories:
- Rust unit + integration tests
- TypeScript unit + browser tests
- Python unit tests
- schema validation and codegen consistency tests
- end-to-end integration tests across engine + client + Python
- performance smoke tests
- fixture-based artifact regression tests

### 12.3 Release artifacts

At minimum, releases should produce:
- engine binary package
- CLI binary package
- browser client build artifact
- Python wheel(s)
- schema package version
- optional desktop shell package later

Schema versions should be tied to release notes and compatibility guarantees.

### 12.4 Versioning recommendation

Use coordinated product versions, but permit internal package versions where needed.

Recommended approach:
- one top-level Lucida product version
- schema package version tracked explicitly
- internal package versions may vary during development, but release bundles should clearly state compatible versions

---

## 13. Testing strategy by boundary

### 13.1 Rust tests

Rust should own:
- state reducer correctness
- auth and lease enforcement tests
- generation consistency tests
- storage layout tests
- source watch/debounce tests
- metadata and dense-ID mapping tests
- chunk publish conflict tests

### 13.2 TypeScript tests

TypeScript should own:
- client event application tests
- request scheduler tests
- cache eviction tests
- label bitset rendering tests
- minimap interaction tests
- 2D and 3D rendering behavior tests

### 13.3 Python tests

Python should own:
- notebook API behavior
- cutout adapter correctness
- dense and chunked array materialization tests
- publish helper ergonomics and contract conformance

### 13.4 Cross-language tests

Cross-language tests are critical and should not be optional.

Examples:
- engine emits command ack/event; TS and Python both deserialize correctly
- RegionRecipe produced by engine is consumable by Python adapter and browser
- derived publish batch generated in Python is accepted by engine and visible in browser
- Context Package captured in browser reopens through engine and Python SDK consistently

---

## 14. Repo governance and ownership

### 14.1 ADR process

Any decision that changes one of Lucida's core invariants should require an ADR.

Examples:
- changing engine authority model
- changing shared/per-client state boundary
- changing storage truth away from OME-Zarr + `/lucida/`
- changing channel blocking semantics
- changing dense-ID requirements for labels

### 14.2 Code ownership

Recommended ownership split:
- engine team owns `engine/`
- web team owns `client-web/`
- scientific tools team owns `python-sdk/`
- platform/architecture lead owns `schemas/`, `docs/adr/`, and cross-stack compatibility rules
- shaders may be jointly owned by web + rendering lead

### 14.3 Review expectations

Changes touching:
- `schemas/`
- wire contracts
- generation semantics
- storage layout
- plugin API
should require cross-team review from at least engine + client, and Python where relevant.

---

## 15. Major risks and mitigations

### 15.1 Risk: Python ecosystem gaps pull too much logic out of Rust

Mitigation:
- allow Python worker bridges only as explicit, isolated adapters
- keep authority, lifecycle, and storage truth in Rust
- treat any Python bridge used in core ingest as temporary until proven otherwise

### 15.2 Risk: client and engine contract drift

Mitigation:
- make schemas central and versioned
- require fixture-based compatibility tests in CI
- require cross-stack review for contract changes

### 15.3 Risk: browser request overhead or decode cost dominates

Mitigation:
- keep channel blocking in the storage contract
- treat request scheduling and decode pipeline as first-class frontend subsystems
- test with realistic fixture sizes early

### 15.4 Risk: plugin model weakens safety

Mitigation:
- keep engine plugins narrow and capability-scoped
- prefer Rust in-process plugins
- run Python plugins out-of-process with explicit RPC/job boundaries

### 15.5 Risk: too many repos or separate frontends appear over time

Mitigation:
- use monorepo
- keep browser frontend as the single primary renderer
- use Tauri if a desktop shell is needed rather than building a second UI stack

---

## 16. Architecture decisions this document recommends locking now

1. Primary implementation stack is **Rust + TypeScript + Python + WGSL**.
2. Repository strategy is **monorepo**.
3. Engine authority remains in **Rust**.
4. Browser/Jupyter/desktop shells share one **TypeScript/WebGPU frontend**.
5. Python is first-class for workflows, but not authoritative runtime core.
6. Shared contracts live under a central **schemas/** package and are versioned.
7. Engine-side plugins are Rust-first; Python plugins are out-of-process where needed.
8. Desktop packaging, if added, should prefer **Tauri** over a second native GUI stack.
