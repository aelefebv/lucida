---
type: Crate
title: "lucida-py"
description: "Python package for Lucida scripting."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-py.md
created: 2026-04-18
modified: 2026-07-16
---

# lucida-py

Python package for Lucida scripting. It has two surfaces:

1. **Server client (`lucida.client`)** — pure-Python workspace client for [lucida-server](lucida-server.md).
2. **Local analysis bindings** — `pyo3` + `maturin` bindings for [lucida-core](lucida-core.md) and [lucida-store](lucida-store.md).

The local binding classes (the only `#[pyclass]` types) are:

- **`PyScene`** — wraps `Scene`. Pan/zoom/set-z/set-t/set-c, set camera mode, import presence from JSON, serialize commands as JSON, ask for a chunk plan. `load_document`/`import_presence` share the `Scene` bulk-restore methods with the wasm binding (settings seeding/pruning + conditional epoch bumps in scene/mod.rs), rather than writing `Scene` fields directly.
- **`PyStore`** — wraps `lucida-store::backend::open` and `import_dataset`. Reads one explicitly bounded chunk by path and returns Python `bytes`; dataset identity is derived stably from the source URL.

`ViewportData` is **not** a binding class — it is a pure-Python `@dataclass` in `python/lucida/volume.py`. `assemble_chunks` only assembles already-decoded chunks returned by the canonical Rust store path, validates dtype/shape/crop inputs, and enforces an allocation budget before allocating. Python intentionally does not maintain a second partial OME-Zarr codec/path/axis decoder.

The server-client entrypoint is:

- **`LucidaClient`** — resolves server and token config, exposes `status()`, `whoami()`, `workspaces`, and per-workspace `datasets`, `view`, `layer`, `channel`, `debug`, and `saved_views` resources.

The crate is **excluded from the workspace** (`exclude = ["lucida-py"]` in the root `Cargo.toml`) because it builds a `cdylib` extension module rather than an `rlib` and uses its own `Cargo.lock`. Build via `maturin develop` from `lucida-py/`.

## Why a Python module

Three concrete uses:

1. **Headless scripting** for analysis pipelines that want to drive a Lucida session from Python.
2. **Test fixtures** — building scenes and chunk plans in pytest is much faster than spinning up a browser.
3. **Reference for command serialization** — `PyScene.pan(...)` returns the JSON of the command it just applied, which makes it the easiest way to learn the wire format.

## Module Map

- `src/lib.rs` — `PyScene`, `PyStore`, the `lucida` Python module declaration
- `python/lucida/client.py` — pure-Python server client
- `python/lucida/__init__.py` — package-root exports; `LucidaClient` is available without building the Rust extension
- `python/lucida/volume.py` — bounded NumPy assembly for canonical Rust-returned chunks
- `tests/test_client.py`, `tests/test_wire_fixtures.py`, `tests/test_public_api.py`, `tests/test_volume.py` — client behavior, Rust-authored wire compatibility, sync/async public-surface parity, and bounded volume assembly
- `pyproject.toml` — maturin build config; declares the `lucida` package

## Interactions

- **`LucidaClient` connects to [lucida-server](lucida-server.md)** over HTTP for status/auth/workspace APIs and WebSocket for workspace session state and commands.
- **Token sourcing mirrors [lucida-cli](lucida-cli.md) where practical.** Explicit constructor token wins, then `LUCIDA_TOKEN`, then macOS Keychain under the `lucida-cli` service, then the CLI-compatible config token.
- **Server config mirrors [lucida-cli](lucida-cli.md) where practical.** `LUCIDA_CONFIG_PATH` wins, then `$XDG_CONFIG_HOME/lucida/config.json`, then `~/.config/lucida/config.json`; `LucidaClient(...).workspaces.use(...)` persists the default workspace id under the normalized server URL.
- **Local bindings import** [lucida-core](lucida-core.md) and [lucida-store](lucida-store.md) directly. No FFI tricks — pyo3 handles the conversion.
- **JSON is the lingua franca**: `apply_command(json)`, `presence_json()`, `chunk_plan()` all use serde JSON to cross the boundary. This avoids defining a parallel pyo3 type for every Rust struct.
- **Workspace session operations use the same protocol messages as browser/CLI sessions.** Dataset open sends `open_remote_dataset`; dataset-open progress uses `dataset_open_progress`; dataset diagnostics use `dataset_health`; dataset binding retry sends `dataset_retry`. View/layer/channel automation persists to revisioned private viewer profiles with compare-and-swap and reapply-on-conflict rather than pretending one-shot presence is durable.

## Invariants

- **The server client is pure Python.** It uses stdlib `urllib` for HTTP and the existing `websockets` package for workspace sessions; no `pyo3` bridge is required for server operations.
- **Package-root imports must not require the Rust extension.** `from lucida import LucidaClient` works before `maturin develop`. Only the specifically missing optional module/dependency is downgraded to `None`; a real import or initialization defect is re-raised with its original diagnostic.
- **There is no compatibility `Viewer` wrapper.** Server-facing Python automation goes through `LucidaClient`; `PyScene`/`PyStore` remain local-analysis bindings only.
- **Every supported public operation has a named sync/async pair.** Use `async_*` methods inside a running event loop. Native async WebSocket operations share one monotonic deadline; HTTP-backed async methods run the sync transport in a worker via `asyncio.to_thread` so they do not block the event loop.
- **All `PyStore` instances share one lazily initialized two-worker Tokio runtime.** Blocking native I/O detaches from the GIL. Opening many stores therefore does not create one runtime/thread pool per object.
- **The package dependency layers are intentional.** The base install has no third-party Python runtime dependency and supports HTTP APIs. The `client` extra adds `websockets` for workspace sessions, the `analysis` extra adds NumPy, and the `native` extra documents that the compiled extension itself needs no additional Python runtime package. Maturin is build-system/development tooling, not a runtime dependency. Codec/dtype support comes from `lucida-store`, not a divergent Python decoder.
- **Transport inputs are bounded and typed.** HTTP bodies, WebSocket messages, native chunk reads, and assembled arrays have explicit caps. Malformed known wire messages fail as `LucidaError(kind="protocol")`; unknown string-tagged notification variants are skipped for forward compatibility; terminal archive messages fail immediately.
- **Manual contrast is a durable viewer-profile choice.** `channel.contrast` and the layer-level contrast convenience API update the currently selected channel and disable `auto_contrast` for that dataset, so a later browser hydration cannot silently replace the requested range. Layer gamma follows the same selected-channel rule.
- **`PyScene::import_presence` preserves the local viewport size.** The incoming presence's camera viewport is overwritten with the local one before assignment, because the client's window dimensions are local and shouldn't be clobbered by a remote peer.

## Gotchas

- **Build with `maturin develop`, not `cargo build`.** Cargo will succeed but the resulting `.so`/`.dylib` won't end up in Python's import path.
- **Choose the install surface deliberately.** `pip install lucida` supports HTTP-only client use, `pip install 'lucida[client]'` adds WebSocket workspace sessions, and `pip install 'lucida[analysis]'` adds NumPy assembly helpers (extras may be combined). Building a wheel/native binding uses PEP 517/Maturin and does not make Maturin an installed runtime dependency.
- **The crate is not part of `cargo test --workspace`** (it's excluded). To test changes, run `cd lucida-py && cargo test` or `pytest` against the built module.
- **`chunk_plan_for(dataset_id)` requires a loaded document.** Call `load_document(json)` first or you'll get an empty plan.
- **Live server-client smoke tests need a running `lucida-server`.** A quick check is `uv run python -c 'from lucida import LucidaClient; c=LucidaClient("http://127.0.0.1:9988"); print(c.workspaces.list()[0]["id"])'`.
- **Use the smoke scripts for server-client regressions.** `uv run --project lucida-py python scripts/smoke_python_client.py` covers the common single-dataset workflow, dataset health, and structured missing/malformed open failures. `scripts/smoke_dataset_reliability.py` broadens that to the local collection, volume, LIF, and CZI fixtures when they are present.
- **Use the project environment for WebSocket operations in a source checkout.** Direct system `python3` can import HTTP-only parts if its path is pointed at `lucida-py/python`, but dataset open/view/layer/channel methods need `websockets`; run from `lucida-py` with `uv run python ...` or install dependencies with `uv sync`.
