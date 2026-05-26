---
created: 2026-04-18
modified: 2026-05-26
---

# lucida-core

The Rust core: a single library that compiles to both a native `rlib` (used by `lucida-server`, `lucida-cli`, `lucida-py`) and a `cdylib` for `wasm32-unknown-unknown` (used by `lucida-web`). It owns the canonical [[scene-state-and-epochs|Scene model]], the command vocabulary, the wire protocol types, and viewport math (camera, view query, ray pick).

The crate has no I/O. It computes; everything else fetches, persists, broadcasts, or renders.

## Why one crate compiled twice

The Scene model is the source of truth for "what is visible, at what scale, with what camera." Any consumer that needs to ask "what chunks are wanted?" or "where does this entity sit on screen?" has to share that model exactly — not an approximation. By compiling to WASM as well as native, the web client, the Python bindings, the CLI, and the server share one implementation.

That tradeoff costs build complexity (the web client runs `npm run build:wasm` after Rust changes — see [[gotchas/wasm-rebuild-after-rust-changes]]) but eliminates two whole classes of bug: protocol drift between client and server, and view-query disagreement between the renderer and the server's chunk router.

## Interactions

Re-exports symbols from [[lucida-content]] and [[lucida-protocol]] via `pub use`, so downstream crates depend only on `lucida_core` and get the manifest, fetch-source, and asset-catalog types transparently.

- **`lucida-server`** ingests `Scene` for document state and uses `protocol` types for client/server messages.
- **`lucida-cli`** drives `Scene` directly to generate viewport commands and emit presence updates over the same wire protocol.
- **`lucida-py`** wraps `Scene` with `pyo3` for Python automation of viewport state.
- **`lucida-web`** loads the WASM build and treats `Scene` as a state authority — JS is a thin orchestration layer (see the [[lucida-web]] article).

## Module map

Module-level only — see the source for signatures.

- `scene/` — `Scene`, `DocumentState`, `DerivedState`, `DatasetDisplaySettings`, `Colormap`, layout resolution
- `command.rs` — `Command`, `DocumentCommand`, `ViewportCommand`; `Scene::apply` is the single mutator
- `protocol.rs` — `ClientMessage`, `ServerMessage`, `ChunkMessage`, `PresenceState`. `ServerMessage::BookmarkChanged { id, action, dataset_urls }` is the **first variant without a `seq`** — session-scoped notification for [[saved-views]], not a sequenced document command.
- `epoch.rs` — `SceneEpochs` (content/layout/view/selection/asset)
- `camera.rs` — `Slice` (2D), `Arcball` (3D orbit), `Fly` (3D first-person)
- `view.rs` / `query.rs` — `ViewState`, `view_query` returning per-entity projected size + ideal LOD
- `ray.rs` — `Ray`, `RayHit` for picking
- `chunk.rs` / `transform.rs` — chunk plan synthesis and 4×4 voxel transforms
- `wasm.rs` — `wasm-bindgen` wrappers; only compiled for `target_arch = "wasm32"`
- `saved_view.rs` — `SavedView` schema (capture record for [[saved-views]]); thin `#[wasm_bindgen]` shims for `dataset_id_for_url`, `normalize_dataset_url`, `is_local_dataset_url` that delegate to [[lucida-content]]'s `url` module per [[decisions/0042-canonical-dataset-url-form]]. The SPA imports the shims; Rust callers use `lucida_content::url::*` directly.
- `auth_principal.rs` — `AuthPrincipal` struct (shared seam type for [[auth]]; consumed by [[saved-views]])

## Invariants

- **`Scene::apply` is the conventional mutation path.** Every command — document or viewport — should flow through it. Helpers (`Scene::register_dataset`, `remove_dataset`, `ensure_channel`) are also `pub fn (&mut self)` so the rule is enforced by review, not the type system. Bypassing `apply` skips epoch bumps and derived-state rebuilds (see [[scene-state-and-epochs]]).
- **Document commands and viewport commands are disjoint enums** — `DocumentCommand` is shared/sequenced, `ViewportCommand` is local-only. The `Command` wrapper uses `#[serde(untagged)]` to deserialize either from the same JSON shape — the server uses this to decide what to broadcast (see [[decisions/0001-document-vs-viewport-split]]).
- **Epochs only increase.** A fresh `Scene` starts at zero on every counter; `Scene::apply` is the only writer. Consumers compare epoch values to decide whether to reprocess.
- **`SetActiveLayout` requires special ordering** in `Scene::apply` — document state is applied first, then derived state is rebuilt. All other document commands do their side effects first. The reason is that derived-state computation needs to read the freshly-applied layout selection from `document.active_layout_ids`. See `lucida-core/src/command.rs:121` for the explicit early-return branch.

## Gotchas

- **Rust edition 2024** — binding modes differ from 2021; `&` no longer needed in closures over references in many cases. See [[gotchas/rust-2024-binding-modes]].
- **`Scene` flattens `DocumentState`** via `#[serde(flatten)]` for JSON backward compatibility. Adding fields to one without considering the other can break the wire format. See [[gotchas/scene-document-state-json-compat]].
- **WASM build is separate from native build.** Touching `lucida-core` requires both `cargo test -p lucida-core` and `cd lucida-web && npm run build:wasm`. The dev loop is documented in `README.md`.
