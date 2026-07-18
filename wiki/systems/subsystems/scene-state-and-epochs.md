---
type: Subsystem
title: "Scene State and Epochs"
description: "How the WASM Scene exposes \"what changed since you last asked.\" Owns one of the central performance levers in the codebase: the tick coordinator's epoch fast-path skips most frames entirely."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/scene-state-and-epochs.md
created: 2026-04-18
modified: 2026-07-16
---

# Scene State and Epochs

How the WASM Scene exposes "what changed since you last asked." Owns one of the central performance levers in the codebase: the tick coordinator's epoch fast-path skips most frames entirely.

## What an epoch is

`SceneEpochs` (in [lucida-core](../crates/lucida-core.md)'s `epoch.rs`) is a struct of five monotonically increasing `u64` counters, one per category of state:

- `content` — entity membership / metadata changed (`DatasetOpened`, `RemoveDataset`, `RenameDataset`)
- `layout` — spatial layout changed (`RegisterLayout`, `SetActiveLayout`)
- `view` — camera moved (`Pan`, `Zoom`, `Rotate`, `Fly`, `SetCenter`, `SetViewport`, mode switch, clip-distance nudge, fly speed — everything that lives on `Scene::camera`)
- `selection` — selection-like state changed (`SetT`, `SetC`, `SetZ`, `SetMultiChannel`, channel visibility/settings, render mode, contrast, gamma, and the per-dataset display commands `SetDatasetVisible`/`Opacity`/`Order`/`RenderMode`/`DetailLevelOverride`/`BlendMode`)
- `annotation` — collaborative annotations changed. Bumped by `AddAnnotation` / `RemoveAnnotation` / `MoveAnnotation` and `AddComment` / `RemoveComment` / `EditComment` (a pin's comment thread is part of its annotation state).

Every mutation bumps exactly the right epoch **category**, and viewport commands bump by **change detection**: `Scene::apply` classifies each `ViewportCommand` by the state slice it may touch, snapshots only that slice, applies the mutation, and bumps the category iff the slice actually changed. So `Pan` bumps only `view`; a zero-delta pan bumps nothing. `DatasetOpened` bumps `content` and `layout`; a replayed removal of an already-absent id is silent. Generated-coarse availability is runtime delivery metadata and is not a document epoch.

`Scene::apply` is the main epoch writer but not the only one. The bulk-restore and framing methods on `Scene` own their epoch semantics too: `load_document` bumps `content`/`layout`/`annotation` plus `selection` but never `view`; `hydrate` bumps only changed domains; unchanged presence imports are silent; `fit_camera_to_dataset` bumps `view` only on success. Every writer lives in always-compiled `lucida-core`; bindings parse and delegate rather than assigning counters.

## Why typed epochs over a single dirty flag

A single dirty bit forces every consumer to do the most expensive work. Typed epochs let the tick coordinator say:

> "Selection changed but view didn't — so I need to rebuild the descriptor buffer, but I can skip the full cold-state rebuild and the wanted-set recomputation."

Concretely, the tick coordinator's `planAndFetch` ([Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md)) starts with an epoch read; if every counter is unchanged, it returns the cached result and the tick is essentially free. Hits ~5% of frames in normal viewing.

The split also lets [the worker](gpu-residency.md) decide independently — it gets planning epochs in chunk delivery and drops anything stale relative to its current understanding.

## Document state, derived state, presence state

Three layers of "what is the scene right now":

- **`DocumentState`** (`scene/types.rs`) — the shared, persisted, authoritative state: manifests, registered layouts, active layout selections, and annotations. Mutated only by `DocumentCommand`; serialized in `ServerMessage::Snapshot`.
- **Derived state** — computed from document state + active layout. Member positions, projected transforms. Rebuilt internally by document commands and the hydration/deserialization boundary. Not serialized; reconstructable and never exposed through a public mutation hook.
- **Presence state** — per-client viewport, camera, view, display, follow target, cursor. Local + broadcast as ephemeral `PresenceState`; never sequenced.

`Scene` composes `DocumentState` via `#[serde(flatten)]` so the JSON wire format stayed compatible across the document/scene refactor — see [Scene/DocumentState JSON Backward Compatibility](../../gotchas/scene-document-state-json-compat.md).

## Interactions

- **Producers**: `Scene::apply` in [lucida-core](../crates/lucida-core.md) (command.rs) for all commands, plus the `Scene` bulk-restore/framing methods in scene/mod.rs (`hydrate`, `load_document`, `import_presence`, `import_dataset_presence`, `fit_camera_to_dataset`) — each owns its own epoch semantics. No writer exists outside these two files; in particular the wasm/py bindings never write epochs.
- **Consumers**:
  - [tick coordinator](upload-pipeline.md) reads epochs every tick to short-circuit and passes them in chunk deliveries to [the worker](gpu-residency.md) for staleness checks.
  - The web client passes `Scene::apply_command` for every incoming `CommandBroadcast` so all clients converge on the same document state and bump the same epochs.
  - [lucida-server](../crates/lucida-server.md) doesn't read epochs directly — it owns its own seq counter for command ordering. Epochs are a renderer concern.

## Invariants

- **Epochs only increase within a scene lineage.** `Scene::default()` starts at
  zero. Epochs are intentionally serialized in a full `Scene` JSON snapshot,
  so deserializing that snapshot restores the source scene's counters rather
  than manufacturing a new zero-based lineage. Loading the shared
  `DocumentState` into an existing scene preserves that local lineage and
  advances the affected counters. The writers are `Scene::apply`
  (`command.rs`) and the bulk-restore/framing methods (`scene/mod.rs`);
  bindings parse and delegate rather than assigning counters.
- **A no-op is epoch-silent.** An epoch is a change detector, not an event stream: a command that leaves its state slice unchanged (same-size `SetViewport`, re-asserted `SetZ`, unchanged presence re-import) must not bump. Don't wire "user did something" logic to an epoch; use the interaction-dirty path in the web client for that.
- **Mutation coherence is enforced by the type system.** `Scene`'s mutable fields are crate-scoped and external callers get read-only accessors. Public `set_mode_*` and `remove_dataset` route through tracked commands; the epoch-free mode helpers are explicitly named `*_untracked` and crate-only for `Scene::apply_viewport`. Cross-surface reconstruction uses `SceneHydration` + `Scene::hydrate`/`from_hydration`, never field assignment followed by manual repair.
- **Derived state is a function of document state + active layout.** It is never serialized. Scene deserialization, document load, and typed hydration rebuild it automatically and clear unsafe view-query cursors; legacy JSON that omitted dataset order/settings is canonicalized to complete defaults at the same boundary.
- **The same idempotent command applied twice produces the same state.** `DatasetOpened` is not idempotent (it bumps epochs), so the server's reuse path catches duplicates before applying them again.

## Gotchas

- **`SetActiveLayout` requires special apply ordering.** Document state must be applied first, then derived state rebuilt — because rebuilding derived state needs to read the freshly-applied layout selection from `document.active_layout_ids`. The `SetActiveLayout` arm in `Scene::apply` is the explicit early-return that enforces this.
- **Non-finite viewport inputs are dropped whole.** A `ViewportCommand` carrying NaN/Inf in any float payload is discarded by `Scene::apply` before touching state (`ViewportCommand::inputs_finite`). The input gate is only half of what keeps change detection sound — finite inputs can still drive unclamped math into non-finite state (e.g. wheel zoom-out underflowing `Slice::zoom` to exactly 0.0, after which `pan` divides by it into a NaN center; or a huge finite pan delta overflowing a position to Inf, after which the next pan's `normalize3(Inf − Inf)` is all-NaN) — so the camera mutators also clamp every write: multiplicative state saturates at floors/ceilings (slice zoom; arcball distance, including both fit paths; fly `dt`/movement-axes/base-speed), additive accumulators saturate per nudge (clip distance, `[0, CLIP_DISTANCE_MAX]` — a huge negative delta recovers to 0), orbit angles wrap by 2π past a huge guard (bit-identical across the whole interactive range; `sin(Inf)` is NaN), positional state (slice center, arcball target, fly position) steps through a component-wise bound that saturates overflow and drops NaN steps — with absolute positional writes (set-center, center-on-voxel, the fit targets) clamped to the same bound — and the vector/quaternion normalize helpers treat non-finite lengths as degenerate (constants in `camera.rs`). Cameras arriving from outside a local mutator — `Scene::import_presence` (follow mode / saved-view restore) and the CLI's presence/saved-view scene builders — go through `Camera::sanitize`, which applies the same ranges so no import can install state the local mutators could never produce. Together these uphold "finite inputs → finite state": a stored NaN would be self-unequal, so `camera != camera_before` would read true on every subsequent command — a permanent per-frame replan storm. JSON can't encode non-finite floats, so only the raw-numeric wasm entry points (fly tick, speed/clip nudges, pan/zoom) needed the input gate. Exception: `SetLabelOpacity` sanitizes a non-finite opacity to the 0.5 default inside its arm (locked by tests; mirrors the web's `normalizeLabelOpacity`).
- **Backward-compat fields** (e.g. `channel_settings` defaulting to empty in old `DatasetDisplaySettings` JSON) live in serde defaults; tests in `scene/types.rs` lock the wire format. Don't touch the field structure casually.
