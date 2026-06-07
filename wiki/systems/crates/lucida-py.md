---
created: 2026-04-18
modified: 2026-06-07
---

# lucida-py

Python package for Lucida scripting. It has two surfaces:

1. **Server client (`lucida.client`)** — pure-Python workspace client for [[lucida-server]].
2. **Local analysis bindings** — `pyo3` + `maturin` bindings for [[lucida-core]] and [[lucida-store]].

The local binding classes are:

- **`PyScene`** — wraps `Scene`. Pan/zoom/set-z/set-t/set-c, set camera mode, import presence from JSON, serialize commands as JSON, ask for a chunk plan.
- **`PyStore`** — wraps `lucida-store::backend::open` and `import_dataset`. Reads a single chunk by path, returns raw bytes.

The server-client entrypoint is:

- **`LucidaClient`** — resolves server and token config, exposes `status()`, `whoami()`, `workspaces`, and per-workspace `datasets`, `view`, `layer`, `channel`, and `debug` resources.

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
- `python/lucida/zarr_reader.py` — local OME-Zarr helper types used by local analysis scripts
- `tests/test_client.py` — pytest coverage for token sourcing, workspace/dataset calls, WebSocket command messages, and package-root import behavior
- `pyproject.toml` — maturin build config; declares the `lucida` package

## Interactions

- **`LucidaClient` connects to [[lucida-server]]** over HTTP for status/auth/workspace APIs and WebSocket for workspace session state and commands.
- **Token sourcing mirrors [[lucida-cli]] where practical.** Explicit constructor token wins, then `LUCIDA_TOKEN`, then macOS Keychain under the `lucida-cli` service, then the CLI-compatible config token.
- **Server config mirrors [[lucida-cli]] where practical.** `LUCIDA_CONFIG_PATH` wins, then `$XDG_CONFIG_HOME/lucida/config.json`, then `~/.config/lucida/config.json`; `LucidaClient(...).workspaces.use(...)` persists the default workspace id under the normalized server URL.
- **Local bindings import** [[lucida-core]] and [[lucida-store]] directly. No FFI tricks — pyo3 handles the conversion.
- **JSON is the lingua franca**: `apply_command(json)`, `presence_json()`, `chunk_plan()` all use serde JSON to cross the boundary. This avoids defining a parallel pyo3 type for every Rust struct.
- **Workspace commands use the same protocol messages as browser/CLI sessions.** Dataset open sends `open_remote_dataset`; view commands send `presence`; layer/channel commands send `dataset_presence`.

## Invariants

- **The server client is pure Python.** It uses stdlib `urllib` for HTTP and the existing `websockets` package for workspace sessions; no `pyo3` bridge is required for server operations.
- **Package-root imports must not require the Rust extension.** `from lucida import LucidaClient` should work in an editable/source checkout even before `maturin develop`; missing local-analysis dependencies leave `PyScene`, `PyStore`, or `ViewportData` as `None`.
- **There is no compatibility `Viewer` wrapper.** Server-facing Python automation goes through `LucidaClient`; `PyScene`/`PyStore` remain local-analysis bindings only.
- **Synchronous workspace methods are wrappers around async WebSocket operations.** Use the `async_*` variants inside a running event loop.
- **`runtime` is a per-`PyStore` tokio runtime.** The crate uses `block_on` to bridge async I/O into Python's sync calls. One runtime per store; multiple stores get multiple runtimes. Acceptable because `PyStore` is a long-lived object.
- **`PyScene::import_presence` preserves the local viewport size.** The incoming presence's camera viewport is overwritten with the local one before assignment, because the client's window dimensions are local and shouldn't be clobbered by a remote peer.

## Gotchas

- **Build with `maturin develop`, not `cargo build`.** Cargo will succeed but the resulting `.so`/`.dylib` won't end up in Python's import path.
- **The crate is not part of `cargo test --workspace`** (it's excluded). To test changes, run `cd lucida-py && cargo test` or `pytest` against the built module.
- **`chunk_plan_for(dataset_id)` requires a loaded document.** Call `load_document(json)` first or you'll get an empty plan.
- **Live server-client smoke tests need a running `lucida-server`.** A quick check is `uv run python -c 'from lucida import LucidaClient; c=LucidaClient("http://127.0.0.1:9988"); print(c.workspaces.list()[0]["id"])'`.
