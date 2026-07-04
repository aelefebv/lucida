---
type: Subsystem
title: "Scene State and Epochs"
description: "How the WASM Scene exposes \"what changed since you last asked.\" Owns one of the central performance levers in the codebase: the tick coordinator's epoch fast-path skips most frames entirely."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/scene-state-and-epochs.md
created: 2026-04-18
modified: 2026-07-03
---

# Scene State and Epochs

How the WASM Scene exposes "what changed since you last asked." Owns one of the central performance levers in the codebase: the tick coordinator's epoch fast-path skips most frames entirely.

## What an epoch is

`SceneEpochs` (in [lucida-core](../crates/lucida-core.md)'s `epoch.rs`) is a struct of six monotonically increasing `u64` counters, one per category of state:

- `content` — entity membership / metadata changed (`DatasetOpened`, `RemoveDataset`, `RenameDataset`)
- `layout` — spatial layout changed (`RegisterLayout`, `SetActiveLayout`)
- `view` — camera moved (`Pan`, `Zoom`, `Rotate`, `Fly`, `SetCenter`, `SetViewport`, mode switch, clip-distance nudge, fly speed — everything that lives on `Scene::camera`)
- `selection` — selection-like state changed (`SetT`, `SetC`, `SetZ`, `SetMultiChannel`, channel visibility/settings, render mode, contrast, gamma, and the per-dataset display commands `SetDatasetVisible`/`Opacity`/`Order`/`RenderMode`/`DetailLevelOverride`/`BlendMode`)
- `asset` — asset catalog changed (proxy availability published or revoked). Bumped only by `ApplyAssetCatalogDelta`.
- `annotation` — collaborative annotations changed. Bumped by `AddAnnotation` / `RemoveAnnotation` / `MoveAnnotation` and `AddComment` / `RemoveComment` / `EditComment` (a pin's comment thread is part of its annotation state).

Every mutation bumps exactly the right epoch **category**, and viewport commands bump by **change detection**: `Scene::apply` classifies each `ViewportCommand` by the state slice it may touch (camera / view selectors / display / per-dataset display — `ViewportCommand::scope` in command.rs), snapshots only that slice, applies the mutation, and bumps the category's epoch iff the slice actually changed. So `Pan` bumps only `view` (and a zero-delta pan bumps nothing); `SetT` bumps only `selection` (and re-asserting the current `t` bumps nothing). The no-change guard is **load-bearing, not an optimization**: the web re-asserts `set_z`/`set_t`/`set_c`/`set_viewport` on every render tick and the tick coordinator keys its plan cache off the epochs each tick, so unconditional bumps would force a full replan per frame. Document commands bump unconditionally — `DatasetOpened` bumps both `content` and `layout`, `ApplyAssetCatalogDelta` bumps only `asset`. Generated coarse availability is tracked separately (not via the `asset` epoch).

`Scene::apply` is the main epoch writer but not the only one. The bulk-restore and framing methods on `Scene` (all in scene/mod.rs) own their epoch semantics too: `load_document` bumps every document-scoped epoch (`content`/`layout`/`asset`/`annotation` plus `selection`) unconditionally — a document swap invalidates everything document-derived, but never `view` (the local camera is untouched); `import_presence` and `import_dataset_presence` bump `view`/`selection` conditionally on actual change, so an unchanged follow-mode rebroadcast is epoch-silent; `fit_camera_to_dataset` bumps `view` on success only. What holds unconditionally: every epoch writer lives in always-compiled `lucida-core` (command.rs + scene/mod.rs) where `cargo test` reaches it — the wasm/py bindings parse and delegate, never touching `epochs` themselves.

## Why typed epochs over a single dirty flag

A single dirty bit forces every consumer to do the most expensive work. Typed epochs let the tick coordinator say:

> "Selection changed but view didn't — so I need to rebuild the descriptor buffer, but I can skip the full cold-state rebuild and the wanted-set recomputation."

Concretely, the tick coordinator's `planAndFetch` ([Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md)) starts with an epoch read; if every counter is unchanged, it returns the cached result and the tick is essentially free. Hits ~5% of frames in normal viewing.

The split also lets [the worker](gpu-residency.md) decide independently — it gets the planning epochs in every chunk/proxy delivery and drops anything that's stale relative to its current understanding.

## Document state, derived state, presence state

Three layers of "what is the scene right now":

- **`DocumentState`** (`scene/types.rs`) — the shared, persisted, authoritative state. Manifests, registered layouts, active layout selections, asset catalogs. Mutated only by `DocumentCommand`. Serialized over the wire; sent in `ServerMessage::Snapshot`.
- **Derived state** — computed from document state + active layout. Member positions, projected transforms. Rebuilt by `Scene::rebuild_derived` and per-command in `Scene::apply`. Not serialized; reconstructable.
- **Presence state** — per-client viewport, camera, view, display, follow target, cursor. Local + broadcast as ephemeral `PresenceState`; never sequenced.

`Scene` composes `DocumentState` via `#[serde(flatten)]` so the JSON wire format stayed compatible across the document/scene refactor — see [Scene/DocumentState JSON Backward Compatibility](../../gotchas/scene-document-state-json-compat.md).

## Interactions

- **Producers**: `Scene::apply` in [lucida-core](../crates/lucida-core.md) (command.rs) for all commands, plus the `Scene` bulk-restore/framing methods in scene/mod.rs (`load_document`, `import_presence`, `import_dataset_presence`, `fit_camera_to_dataset`) — each owns its own epoch semantics. No writer exists outside these two files; in particular the wasm/py bindings never write epochs.
- **Consumers**:
  - [tick coordinator](upload-pipeline.md) reads epochs every tick to short-circuit; passes them in chunk deliveries to [the worker](gpu-residency.md) for staleness checks. Proxy deliveries (the fallback path) carry epochs too.
  - The web client passes `Scene::apply_command` for every incoming `CommandBroadcast` so all clients converge on the same document state and bump the same epochs.
  - [lucida-server](../crates/lucida-server.md) doesn't read epochs directly — it owns its own seq counter for command ordering. Epochs are a renderer concern.

## Invariants

- **Epochs only increase.** Fresh `Scene` starts at zero; the writers are `Scene::apply` (command.rs) and the `Scene` bulk-restore/framing methods (scene/mod.rs). Bindings never write them.
- **A no-op is epoch-silent.** An epoch is a change detector, not an event stream: a command that leaves its state slice unchanged (same-size `SetViewport`, re-asserted `SetZ`, unchanged presence re-import) must not bump. Don't wire "user did something" logic to an epoch; use the interaction-dirty path in the web client for that.
- **`Scene::apply` is the conventional mutation path for commands.** The scene/mod.rs bulk-restore methods are the sanctioned non-command mutators because they own their own epoch bumps. Raw helpers like `Scene::set_mode_2d`, `remove_dataset`, and `ensure_channel` remain `pub fn (&mut self)` and can be called directly from anywhere in the workspace — but doing so bypasses epoch bumps and derived-state rebuilds, which is invisible until the renderer goes stale. That discipline is enforced by code review, not the type system.
- **Derived state is a function of document state + active layout.** Always reconstructable; never serialized. The CLI takes a snapshot and calls `Scene::rebuild_derived` to recompute it locally.
- **The same command applied twice produces the same Scene** when the command is idempotent. `ApplyAssetCatalogDelta` (the proxy fallback path, still wired) is the explicit case — repeated application of the same delta merges idempotently. `DatasetOpened` is not idempotent (it would bump epochs twice), and the server's reuse path catches the duplicate before re-applying.

## Gotchas

- **`SetActiveLayout` requires special apply ordering.** Document state must be applied first, then derived state rebuilt — because rebuilding derived state needs to read the freshly-applied layout selection from `document.active_layout_ids`. The `SetActiveLayout` arm in `Scene::apply` is the explicit early-return that enforces this.
- **Asset epoch bumps on every `ApplyAssetCatalogDelta`** even when the catalog contents are unchanged. The contents-equality check happens in the merge, but the epoch reflects the message arrival, not the content delta. If you wire a UI to "asset epoch changed → rerender," expect spurious wake-ups on no-op deltas.
- **Non-finite viewport inputs are dropped whole.** A `ViewportCommand` carrying NaN/Inf in any float payload is discarded by `Scene::apply` before touching state (`ViewportCommand::inputs_finite`). The input gate is only half of what keeps change detection sound — finite inputs can still drive unclamped math into non-finite state (e.g. wheel zoom-out underflowing `Slice::zoom` to exactly 0.0, after which `pan` divides by it into a NaN center; or a huge finite pan delta overflowing a position to Inf, after which the next pan's `normalize3(Inf − Inf)` is all-NaN) — so the camera mutators also clamp every write: multiplicative state saturates at floors/ceilings (slice zoom; arcball distance, including both fit paths; fly `dt`/movement-axes/base-speed), additive accumulators saturate per nudge (clip distance, `[0, CLIP_DISTANCE_MAX]` — a huge negative delta recovers to 0), orbit angles wrap by 2π past a huge guard (bit-identical across the whole interactive range; `sin(Inf)` is NaN), positional state (slice center, arcball target, fly position) steps through a component-wise bound that saturates overflow and drops NaN steps — with absolute positional writes (set-center, center-on-voxel, the fit targets) clamped to the same bound — and the vector/quaternion normalize helpers treat non-finite lengths as degenerate (constants in `camera.rs`). Cameras arriving from outside a local mutator — `Scene::import_presence` (follow mode / saved-view restore) and the CLI's presence/saved-view scene builders — go through `Camera::sanitize`, which applies the same ranges so no import can install state the local mutators could never produce. Together these uphold "finite inputs → finite state": a stored NaN would be self-unequal, so `camera != camera_before` would read true on every subsequent command — a permanent per-frame replan storm. JSON can't encode non-finite floats, so only the raw-numeric wasm entry points (fly tick, speed/clip nudges, pan/zoom) needed the input gate. Exception: `SetLabelOpacity` sanitizes a non-finite opacity to the 0.5 default inside its arm (locked by tests; mirrors the web's `normalizeLabelOpacity`).
- **Backward-compat fields** (e.g. `channel_settings` defaulting to empty in old `DatasetDisplaySettings` JSON) live in serde defaults; tests in `scene/types.rs` lock the wire format. Don't touch the field structure casually.
