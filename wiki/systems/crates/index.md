# Crates

One article per Cargo workspace member. Crate boundaries are durable; these articles describe what each crate owns.

- [lucida-core](lucida-core.md) — Rust library compiled to native + WASM; owns the Scene model, command vocabulary, view query, and ray pick
- [lucida-server](lucida-server.md) — Tokio + Axum WebSocket relay; sequences document commands, brokers presence, opens datasets, serves source and generated chunks
- [lucida-store](lucida-store.md) — storage abstraction over `object_store`; OME-Zarr import producing the three-output `ImportResult`
- [lucida-protocol](lucida-protocol.md) — JSON session/chunk types plus the canonical server-to-client binary chunk codec
- [lucida-content](lucida-content.md) — pure data model for `DatasetManifest` (entities, transforms, images, layouts)
- [lucida-cli](lucida-cli.md) — workspace-first product CLI for [lucida-server](lucida-server.md); server/auth/workspace discovery, dataset operations, view/headless viewer commands, collaboration diagnostics, and admin support
- [lucida-proxy (retired)](lucida-proxy.md) — historical proxy-generation crate deleted by ADR-0043
- [lucida-py](lucida-py.md) — pure-Python `LucidaClient` plus optional `pyo3` + `maturin` local bindings (`PyScene`, `PyStore`)
- [lucida-web](lucida-web.md) — React 19 + Vite 8 + WebGPU frontend; thin orchestration over the WASM Scene
