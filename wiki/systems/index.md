---
created: 2026-04-18
modified: 2026-06-25
---

# Systems

Major modules and subsystems within Lucida. Articles are split into two sub-folders by what they describe:

- **`crates/`** — one article per Cargo workspace member. Crate boundaries are durable; these articles describe what each crate owns.
- **`subsystems/`** — web-internal modules and cross-cutting concepts (chunk pipeline, GPU residency, etc.). These live inside `lucida-web/src/` (or span `lucida-web` + `lucida-server` like the chunk pipeline) and are runtime-architecture concepts, not crates.

`[[wiki-link]]` resolution is by basename, so `[[lucida-core]]` and `[[chunk-lifecycle]]` work unqualified.

## Crates (`crates/`)

- [[lucida-core]] — Rust library compiled to native + WASM; owns the Scene model, command vocabulary, view query, and ray pick
- [[lucida-server]] — Tokio + Axum WebSocket relay; sequences document commands, brokers presence, opens datasets, serves source and generated chunks
- [[lucida-store]] — storage abstraction over `object_store`; OME-Zarr import producing the three-output `ImportResult`
- [[lucida-protocol]] — wire types: `DatasetOpened`, `FetchSource`, `AssetCatalog`, `AssetMessage`
- [[lucida-content]] — pure data model for `DatasetManifest` (entities, transforms, images, layouts)
- [[lucida-cli]] — workspace-first product CLI for [[lucida-server]]; server/auth/workspace discovery, dataset operations, view/headless viewer commands, collaboration diagnostics, and admin support
- [[lucida-proxy]] — historical/legacy pure-compute proxy generation algorithm; no I/O, no async
- [[lucida-py]] — pure-Python `LucidaClient` plus optional `pyo3` + `maturin` local bindings (`PyScene`, `PyStore`)
- [[lucida-web]] — React 19 + Vite 7 + WebGPU frontend; thin orchestration over the WASM Scene

## Subsystems (`subsystems/`)

- [[auth]] — backend-mediated Google OAuth + httpOnly session cookies; `PrincipalExtractor` trait is the OSS provider extension point
- [[chunk-lifecycle]] — overview of the end-to-end path from dataset URL to pixels
- [[planning-domain]] — wanted-set computation, detail/coarse tier selection, lane-based priority formula
- [[cpu-cache]] — sole chunk fetch path; tiered LRU eviction; decode pool dispatch; drain to GPU
- [[generated-coarse]] — server-managed derived coarse pyramid levels served through the normal chunk path
- [[minimap]] — separate low-resolution spatial context path with its own lane and resources
- [[upload-pipeline]] — `pipeline/upload/` Uploader; cold/hot state emission, drain/resend/dispatch, delivery tracking, worker feedback
- [[gpu-residency]] — tiered chunk atlases (slice/volume), indirection, descriptor buffer, semantic fallback chain
- [[worker-protocol]] — typed `postMessage` contract for cold/hot/delta state between main thread and GPU worker
- [[scene-state-and-epochs]] — typed epoch counters drive the tick coordinator's frame fast-path
- [[presence-and-follow-mode]] — peer-to-peer presence, transitive follow chains, throttling
- [[layout-system]] — registered layouts, `SetActiveLayout`, derived placement rebuilds
- [[multichannel-and-colormaps]] — per-channel state, 15 LUTs, composite key naming
- [[saved-views]] — `#view=…` URL-as-app-state + server-stored `#b=<id>` bookmarks; spans `lucida-core` (schema), `lucida-web` (encoder/applier/sidebar), `lucida-server` (SQLite store + REST + broadcast)
- [[workspaces]] — server-stored container of opened datasets, saved views, and members; the unit of collaboration and of the live session (`/ws/workspaces/:id`); `wds-` membership vs `ds-` source identity
- [[deployment]] — single-image container shape, env-var contract, persistence model, OAuth + data-backend identity per cloud, Ingress / WebSocket tuning, release flow. Conceptual companion to `extras/deploy/RUNBOOK.md`.
