---
created: 2026-04-18
modified: 2026-06-25
---

# lucida-core

The Rust core: a single library that compiles to both a native `rlib` (used by `lucida-server`, `lucida-cli`, `lucida-py`) and a `cdylib` for `wasm32-unknown-unknown` (used by `lucida-web`). It owns the canonical [[scene-state-and-epochs|Scene model]], the command vocabulary, the wire protocol types, and viewport math (camera, view query, ray pick).

The crate has no I/O. It computes; everything else fetches, persists, broadcasts, or renders.

## Why one crate compiled twice

The Scene model is the source of truth for "what is visible, at what scale, with what camera." Any consumer that needs to ask "what chunks are wanted?" or "where does this entity sit on screen?" has to share that model exactly — not an approximation. By compiling to WASM as well as native, the web client, the Python bindings, the CLI, and the server share one implementation.

That tradeoff costs build complexity (see [[0007-wasm-scene-as-source-of-truth]] and [[gotchas/wasm-rebuild-after-rust-changes]]) but eliminates two whole classes of bug: protocol drift between client and server, and view-query disagreement between the renderer and the server's chunk router.

## Interactions

Re-exports symbols from [[lucida-content]] and [[lucida-protocol]] via `pub use`, so downstream crates depend only on `lucida_core` and get the manifest, fetch-source, and asset-catalog types transparently.

- **`lucida-server`** ingests `Scene` for document state and uses `protocol` types for client/server messages.
- **`lucida-cli`** drives `Scene` directly to generate viewport commands and emit presence updates over the same wire protocol.
- **`lucida-py`** wraps `Scene` with `pyo3` for Python automation of viewport state.
- **`lucida-web`** loads the WASM build and treats `Scene` as a state authority — JS is a thin orchestration layer (see the [[lucida-web]] article).

## Module map

Module-level only — see the source for signatures.

- `scene/` — split into `scene/mod.rs` (`Scene`, `DerivedState`, layout resolution) and `scene/types.rs` (the display/document/colormap types: `DocumentState`, `DatasetDisplaySettings`, `Colormap`)
- `command.rs` — `Command`, `DocumentCommand`, `ViewportCommand`; `Scene::apply` is the single mutator
- `protocol.rs` — `ClientMessage`, `ServerMessage`, `ChunkMessage`, `PresenceState`. `ServerMessage::BookmarkChanged { id, action, dataset_urls }` is unsequenced, like the presence variants (PeerJoined, PresenceUpdate, CursorUpdate, FollowChanged) — a session-scoped notification for [[saved-views]], not a sequenced document command.
- `epoch.rs` — `SceneEpochs` (content/layout/view/selection/asset/annotation)
- `cursor.rs` — peer-cursor world geometry + color assignment for GPU rendering
- `minimap.rs` — pure minimap orbit-camera framing math (wasm caller in `wasm.rs`)
- `camera.rs` — `Slice` (2D), `Arcball` (3D orbit), `Fly` (3D first-person)
- `view.rs` / `query.rs` — `ViewState`, `view_query` returning per-entity projected size + ideal LOD
- `ray.rs` — `Ray`, `RayHit` for picking
- `chunk.rs` — chunk plan synthesis
- `transform.rs` — `VolumeTransform` (column-major 4×4 `model`/`inv_model` mapping voxel space → normalized world space, plus `compute_volume_transform`/`compute_member_transform`). Distinct from [[lucida-content]]'s `VoxelTransform`, which wraps the dataset's affine voxel→world calibration.
- `mat4.rs` — `pub(crate)` column-major mat4/vec3 math helpers used by the transform/camera math
- `wasm_log.rs` — the `wasm_log!` macro and `set_debug_categories` wasm-bindgen entry point; JS pushes the enabled category set and the macro skips payload construction when its category is off
- `wasm.rs` — `wasm-bindgen` wrappers; only compiled for `target_arch = "wasm32"`
- `saved_view.rs` — `SavedView` schema (capture record for [[saved-views]]); thin `#[wasm_bindgen]` shims for `dataset_id_for_url`, `normalize_dataset_url`, `is_local_dataset_url` that delegate to [[lucida-content]]'s `url` module per [[decisions/0042-canonical-dataset-url-form]]. The SPA imports the shims; Rust callers use `lucida_content::url::*` directly.
- `auth_principal.rs` — `AuthPrincipal` struct (shared seam type for [[auth]]; consumed by [[saved-views]])

## Invariants

- **`Scene::apply` is the conventional mutation path.** Every command — document or viewport — should flow through it. `Scene` does expose a few other `&mut self` methods (`set_mode_2d`/`set_mode_3d`/`set_mode_fly`, `remove_dataset`, `rebuild_derived`, plus `pub(crate)` `inner_set_viewport`, all in scene/mod.rs), but the rule that command effects route through `apply` is enforced by review, not the type system. Bypassing `apply` skips epoch bumps and derived-state rebuilds (see [[scene-state-and-epochs]]). (`register_dataset` / `ensure_channel` exist, but on `DocumentState` / `ChannelSettings` in scene/types.rs, not on `Scene`.)
- **Document commands and viewport commands are disjoint enums** — `DocumentCommand` is shared/sequenced, `ViewportCommand` is local-only. The `Command` wrapper uses `#[serde(untagged)]` to deserialize either from the same JSON shape — the server uses this to decide what to broadcast (see [[decisions/0001-document-vs-viewport-split]]).
- **Epochs only increase.** A fresh `Scene` starts at zero on every counter; `Scene::apply` is the only writer. Consumers compare epoch values to decide whether to reprocess.
- **`SetActiveLayout` requires special ordering** in `Scene::apply` — document state is applied first, then derived state is rebuilt. All other document commands do their side effects first. The reason is that derived-state computation needs to read the freshly-applied layout selection from `document.active_layout_ids`. The explicit early-return branch lives in `Scene::apply`'s `SetActiveLayout` match arm (command.rs), distinct from the separate `SetActiveLayout` arm inside `DocumentState::apply` (scene/types.rs) that performs the document-level state change.

## Gotchas

- **Rust edition 2024** — binding modes differ from 2021; `&` no longer needed in closures over references in many cases. See [[gotchas/rust-2024-binding-modes]].
- **`Scene` flattens `DocumentState`** via `#[serde(flatten)]` for JSON backward compatibility. Adding fields to one without considering the other can break the wire format. See [[gotchas/scene-document-state-json-compat]].
- **WASM build is separate from native build.** Touching `lucida-core` requires both `cargo test -p lucida-core` and `cd lucida-web && npm run build:wasm`. The dev loop is documented in `README.md`.
