---
type: Crate
title: "lucida-core"
description: "The Rust core: a single library that compiles to both a native rlib (used by lucida-server, lucida-cli, lucida-py) and a cdylib for wasm32-unknown-unknown (used by lucida-web)."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-core.md
created: 2026-04-18
modified: 2026-07-16
---

# lucida-core

The Rust core: a single library that compiles to both a native `rlib` (used by `lucida-server`, `lucida-cli`, `lucida-py`) and a `cdylib` for `wasm32-unknown-unknown` (used by `lucida-web`). It owns the canonical [Scene model](../subsystems/scene-state-and-epochs.md), the command vocabulary, the wire protocol types, and viewport math (camera, view query, ray pick).

The crate has no I/O. It computes; everything else fetches, persists, broadcasts, or renders.

## Why one crate compiled twice

The Scene model is the source of truth for "what is visible, at what scale, with what camera." Any consumer that needs to ask "what chunks are wanted?" or "where does this entity sit on screen?" has to share that model exactly — not an approximation. By compiling to WASM as well as native, the web client, the Python bindings, the CLI, and the server share one implementation.

That tradeoff costs build complexity (see [WASM Scene as Source of Truth](../../decisions/0007-wasm-scene-as-source-of-truth.md) and [WASM Rebuild After Rust Changes](../../gotchas/wasm-rebuild-after-rust-changes.md)) but eliminates two whole classes of bug: protocol drift between client and server, and view-query disagreement between the renderer and the server's chunk router.

## Interactions

Re-exports the shared dataset/content identifiers from [lucida-content](lucida-content.md) and selected session vocabulary from [lucida-protocol](lucida-protocol.md). Dependency-neutral transport shapes such as `ClientId`, peer identity, open summaries, and chunk/viewer-interest messages live in `lucida-protocol`; core's scene-aware `ClientMessage`/`ServerMessage` compose them with cameras and document commands.

- **`lucida-server`** ingests `Scene` for document state and uses `protocol` types for client/server messages.
- **`lucida-cli`** drives `Scene` directly to generate viewport commands and emit presence updates over the same wire protocol.
- **`lucida-py`** wraps `Scene` with `pyo3` for Python automation of viewport state.
- **`lucida-web`** loads the WASM build and treats `Scene` as a state authority — JS is a thin orchestration layer (see the [lucida-web](lucida-web.md) article).

## Module map

Module-level only — see the source for signatures.

- `scene/` — split into `scene/mod.rs` (`Scene`, `DerivedState`, layout resolution) and `scene/types.rs` (the display/document/colormap types: `DocumentState`, `DatasetDisplaySettings`, `Colormap`). `scene/mod.rs` also owns the multi-dataset placement math — the global size correction and 3D top-alignment (`Scene::placement_correction`) behind `rendering_transform`/`member_world_matrix`, the dataset-level `dataset_model_matrix`/`dataset_inv_model_matrix` (minimap projection), and `volume_diagonal` (fly-speed/framing basis) — so the wasm bindings delegate to it rather than re-deriving placement
- `command.rs` — `Command`, `DocumentCommand`, `ViewportCommand`; `Scene::apply` is the command entry point (viewport arms bump epochs by scoped change detection — see [Scene State and Epochs](../subsystems/scene-state-and-epochs.md))
- `protocol.rs` — scene-aware `ClientMessage`, `ServerMessage`, and `PresenceState`, plus re-exports of dependency-neutral session types from `lucida-protocol`. Shared document commands are sequenced; presence, runtime availability/status, health, and viewer-interest traffic are not.
- `epoch.rs` — `SceneEpochs` (content/layout/view/selection/annotation)
- `cursor.rs` — peer-cursor world geometry + color assignment for GPU rendering
- `minimap.rs` — pure minimap orbit-camera framing math (wasm caller in `wasm.rs`)
- `camera.rs` — `Slice` (2D), `Arcball` (3D orbit), `Fly` (3D first-person)
- `view.rs` / `query.rs` — `ViewState`, `view_query` returning per-entity projected size + ideal LOD
- `ray.rs` — `Ray`, `RayHit` for picking
- `chunk.rs` — chunk plan synthesis
- `transform.rs` — `VolumeTransform` (column-major 4×4 `model`/`inv_model` mapping voxel space → normalized world space, plus `compute_volume_transform`/`compute_member_transform`). Distinct from [lucida-content](lucida-content.md)'s `VoxelTransform`, which wraps the dataset's affine voxel→world calibration.
- `mat4.rs` — `pub(crate)` column-major mat4/vec3 math helpers used by the transform/camera math
- `wasm_log.rs` — the `wasm_log!` macro and `set_debug_categories` wasm-bindgen entry point; JS pushes the enabled category set and the macro skips payload construction when its category is off
- `wasm.rs` — `wasm-bindgen` wrappers; only compiled for `target_arch = "wasm32"`
- `saved_view.rs` — `SavedView` schema (capture record for [Saved Views](../subsystems/saved-views.md)); thin `#[wasm_bindgen]` shims for `dataset_id_for_url`, `normalize_dataset_url`, `is_local_dataset_url` that delegate to [lucida-content](lucida-content.md)'s `url` module per [Canonical dataset URL form](../../decisions/0042-canonical-dataset-url-form.md). The SPA imports the shims; Rust callers use `lucida_content::url::*` directly.
- `auth_principal.rs` — `AuthPrincipal` struct (shared seam type for [Authentication](../subsystems/auth.md); consumed by [Saved Views](../subsystems/saved-views.md))

## Invariants

- **`Scene::apply` is the conventional mutation path for commands.** Every command — document or viewport — should flow through it. Beyond `apply`, `Scene` exposes typed bulk-restore/framing methods that own their own epoch/cursor policy (`hydrate`/`from_hydration`, `load_document`, `import_presence`, `import_dataset_presence`, `fit_camera_to_dataset`, all in scene/mod.rs). Mutable Scene fields are crate-scoped with public read-only accessors. Public `set_mode_*`/`remove_dataset` are tracked conveniences; only command internals can reach explicitly named `*_untracked` helpers. Derived rebuilding is private and deserialization/hydration owns it, so downstream crates cannot create an assign-then-repair scene.
- **Document commands and viewport commands are disjoint enums** — `DocumentCommand` is shared/sequenced, `ViewportCommand` is local-only. The `Command` wrapper uses `#[serde(untagged)]` to deserialize either from the same JSON shape — a client-side convenience so one JSON entry point (the wasm/py bindings' `apply`) accepts both kinds. The server never consults it: `ClientMessage::Command` carries `DocumentCommand` directly, so what to broadcast is fixed by the wire type, not decided at runtime (see [Document vs Viewport Command Split](../../decisions/0001-document-vs-viewport-split.md)).
- **Epochs only increase.** A fresh `Scene` starts at zero on every counter; the writers are `Scene::apply` (command.rs) and the `Scene` bulk-restore/framing methods (scene/mod.rs) — always-compiled code, never the bindings. Viewport bumps are conditional on actual change (the web re-asserts `set_z`/`set_t`/`set_c`/`set_viewport` every render tick, so a no-op must be epoch-silent). Consumers compare epoch values to decide whether to reprocess.
- **`SetActiveLayout` requires special ordering** in `Scene::apply` — document state is applied first, then derived state is rebuilt. All other document commands do their side effects first. The reason is that derived-state computation needs to read the freshly-applied layout selection from `document.active_layout_ids`. The explicit early-return branch lives in `Scene::apply`'s `SetActiveLayout` match arm (command.rs), distinct from the separate `SetActiveLayout` arm inside `DocumentState::apply` (scene/types.rs) that performs the document-level state change.

## Gotchas

- **Rust edition 2024** — binding modes differ from 2021; `&` no longer needed in closures over references in many cases. See [Rust 2024 Edition Binding Modes](../../gotchas/rust-2024-binding-modes.md).
- **`Scene` flattens `DocumentState`** via `#[serde(flatten)]` for JSON backward compatibility. Adding fields to one without considering the other can break the wire format. See [Scene/DocumentState JSON Backward Compatibility](../../gotchas/scene-document-state-json-compat.md).
- **WASM build is separate from native build.** Touching `lucida-core` requires both `cargo test -p lucida-core` and `cd lucida-web && npm run build:wasm`. The dev loop is documented in `README.md`.
