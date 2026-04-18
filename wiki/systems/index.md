---
created: 2026-04-18
modified: 2026-04-18
---

# Systems

Major modules and subsystems within Lucida. One article per system, capturing purpose, boundaries, dependencies, and surprising behaviors.

## Crates

- [[lucida-core]] — Rust library compiled to native + WASM; owns the Scene model, command vocabulary, view query, and ray pick
- [[lucida-server]] — Tokio + Axum WebSocket relay; sequences document commands, brokers presence, opens datasets, serves chunks and proxies
- [[lucida-store]] — storage abstraction over `object_store`; OME-Zarr import producing the three-output `ImportResult`
- [[lucida-protocol]] — wire types: `DatasetOpened`, `FetchSource`, `AssetCatalog`, `AssetMessage`
- [[lucida-content]] — pure data model for `DatasetManifest` (entities, transforms, images, layouts)
- [[lucida-cli]] — terminal WebSocket client for [[lucida-server]]; viewport commands, snapshots, steer
- [[lucida-proxy]] — pure-compute proxy generation algorithm; no I/O, no async
- [[lucida-py]] — Python bindings via `pyo3` + `maturin`; `PyScene` and `PyStore`
- [[lucida-web]] — React 19 + Vite 7 + WebGPU frontend; thin orchestration over the WASM Scene

## Web subsystems

- [[chunk-pipeline]] — overview of the end-to-end path from dataset URL to pixels; pointer to the deep trace in `CHUNK_PIPELINE.md`
- [[planning-domain]] — wanted-set computation, LOD promotion with hysteresis, lane-based priority formula
- [[cpu-cache]] — sole chunk fetch path; tiered LRU eviction; decode pool dispatch; drain to GPU
- [[gpu-residency]] — atlases (slice, volume, multi-pool proxy), indirection, descriptor buffer, semantic fallback chain
- [[worker-protocol]] — typed `postMessage` contract for cold/hot/delta state between main thread and GPU worker
- [[scene-state-and-epochs]] — typed epoch counters drive the orchestrator's frame fast-path
- [[presence-and-follow-mode]] — peer-to-peer presence, transitive follow chains, throttling
- [[layout-system]] — registered layouts, `SetActiveLayout`, derived placement rebuilds
- [[multichannel-and-colormaps]] — per-channel state, 15 LUTs, composite key naming
