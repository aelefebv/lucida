---
created: 2026-04-18
modified: 2026-04-18
---

# lucida-py

Python bindings for [[lucida-core]] and [[lucida-store]] via `pyo3` + `maturin`. Two classes are exposed:

- **`PyScene`** — wraps `Scene`. Pan/zoom/set-z/set-t/set-c, set camera mode, import presence from JSON, serialize commands as JSON, ask for a chunk plan.
- **`PyStore`** — wraps `lucida-store::backend::open` and `import_dataset`. Reads a single chunk by path, returns raw bytes.

The crate is **excluded from the workspace** (`exclude = ["lucida-py"]` in the root `Cargo.toml`) because it builds a `cdylib` extension module rather than an `rlib` and uses its own `Cargo.lock`. Build via `maturin develop` from `lucida-py/`.

## Why a Python module

Three concrete uses:

1. **Headless scripting** for analysis pipelines that want to drive a Lucida session from Python.
2. **Test fixtures** — building scenes and chunk plans in pytest is much faster than spinning up a browser.
3. **Reference for command serialization** — `PyScene.pan(...)` returns the JSON of the command it just applied, which makes it the easiest way to learn the wire format.

## Module map

- `src/lib.rs` — `PyScene`, `PyStore`, the `lucida` Python module declaration
- `python/lucida/` — Python-side glue (high-level wrapper around `PyScene`)
- `pyproject.toml` — maturin build config; declares the `lucida` package
- `test.py` — usage examples

## Interactions

- **Imports** [[lucida-core]] and [[lucida-store]] directly. No FFI tricks — pyo3 handles the conversion.
- **Does not connect to [[lucida-server]]**. `PyScene` is a local Scene; if you want shared state, you currently round-trip through your own client code or stand up a [[lucida-cli]] alongside.
- **JSON is the lingua franca**: `apply_command(json)`, `presence_json()`, `chunk_plan()` all use serde JSON to cross the boundary. This avoids defining a parallel pyo3 type for every Rust struct.

## Invariants

- **`runtime` is a per-`PyStore` tokio runtime.** The crate uses `block_on` to bridge async I/O into Python's sync calls. One runtime per store; multiple stores get multiple runtimes. Acceptable because `PyStore` is a long-lived object.
- **`PyScene::import_presence` preserves the local viewport size.** The incoming presence's camera viewport is overwritten with the local one before assignment, because the client's window dimensions are local and shouldn't be clobbered by a remote peer.

## Gotchas

- **Build with `maturin develop`, not `cargo build`.** Cargo will succeed but the resulting `.so`/`.dylib` won't end up in Python's import path. The README's "When you change Python code" section is the source of truth.
- **The crate is not part of `cargo test --workspace`** (it's excluded). To test changes, run `cd lucida-py && cargo test` or `pytest` against the built module.
- **`chunk_plan_for(dataset_id)` requires a loaded document.** Call `load_document(json)` first or you'll get an empty plan.
