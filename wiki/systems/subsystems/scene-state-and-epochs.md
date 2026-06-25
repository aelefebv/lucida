---
type: Subsystem
title: "Scene State and Epochs"
description: "How the WASM Scene exposes \"what changed since you last asked.\" Owns one of the central performance levers in the codebase: the tick coordinator's epoch fast-path skips most frames entirely."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/scene-state-and-epochs.md
created: 2026-04-18
modified: 2026-06-25
---

# Scene State and Epochs

How the WASM Scene exposes "what changed since you last asked." Owns one of the central performance levers in the codebase: the tick coordinator's epoch fast-path skips most frames entirely.

## What an epoch is

`SceneEpochs` (in [lucida-core](../crates/lucida-core.md)'s `epoch.rs`) is a struct of six monotonically increasing `u64` counters, one per category of state:

- `content` — entity membership / metadata changed (`DatasetOpened`, `RemoveDataset`, `RenameDataset`)
- `layout` — spatial layout changed (`RegisterLayout`, `SetActiveLayout`)
- `view` — camera moved (`Pan`, `Zoom`, `Rotate`, `Fly`, `SetCenter`, `SetViewport`, mode switch)
- `selection` — selection-like state changed (`SetT`, `SetC`, `SetZ`, `SetMultiChannel`, channel visibility/settings, render mode, contrast, gamma, and the per-dataset display commands `SetDatasetVisible`/`Opacity`/`Order`/`RenderMode`/`DetailLevelOverride`/`BlendMode`)
- `asset` — asset catalog changed (proxy availability published or revoked). Bumped only by `ApplyAssetCatalogDelta`.
- `annotation` — collaborative annotations changed. Bumped by `AddAnnotation` / `RemoveAnnotation` / `MoveAnnotation` and `AddComment` / `RemoveComment` / `EditComment` (a pin's comment thread is part of its annotation state).

Every command that mutates the scene bumps exactly the right epoch(s). `Pan` bumps only `view`. `SetT` bumps only `selection`. `DatasetOpened` bumps both `content` and `layout`. `ApplyAssetCatalogDelta` bumps only `asset`. Generated coarse availability is tracked separately (not via the `asset` epoch). The bumps happen inside `Scene::apply`; nothing else writes them.

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

- **Producer**: `Scene::apply` in [lucida-core](../crates/lucida-core.md). Single mutator, single epoch bumper.
- **Consumers**:
  - [tick coordinator](upload-pipeline.md) reads epochs every tick to short-circuit; passes them in chunk deliveries to [the worker](gpu-residency.md) for staleness checks. Proxy deliveries (the fallback path) carry epochs too.
  - The web client passes `Scene::apply_command` for every incoming `CommandBroadcast` so all clients converge on the same document state and bump the same epochs.
  - [lucida-server](../crates/lucida-server.md) doesn't read epochs directly — it owns its own seq counter for command ordering. Epochs are a renderer concern.

## Invariants

- **Epochs only increase.** Fresh `Scene` starts at zero; `Scene::apply` is the only writer.
- **`Scene::apply` is the conventional mutation path.** Helpers like `Scene::register_dataset`, `remove_dataset`, and `ensure_channel` are also `pub fn (&mut self)` and can be called directly from anywhere in the workspace — but doing so bypasses `apply`'s epoch bumps and derived-state rebuilds, which is invisible until the renderer goes stale. The discipline is enforced by code review, not the type system.
- **Derived state is a function of document state + active layout.** Always reconstructable; never serialized. The CLI takes a snapshot and calls `Scene::rebuild_derived` to recompute it locally.
- **The same command applied twice produces the same Scene** when the command is idempotent. `ApplyAssetCatalogDelta` (the proxy fallback path, still wired) is the explicit case — repeated application of the same delta merges idempotently. `DatasetOpened` is not idempotent (it would bump epochs twice), and the server's reuse path catches the duplicate before re-applying.

## Gotchas

- **`SetActiveLayout` requires special apply ordering.** Document state must be applied first, then derived state rebuilt — because rebuilding derived state needs to read the freshly-applied layout selection from `document.active_layout_ids`. The `SetActiveLayout` arm in `Scene::apply` is the explicit early-return that enforces this.
- **Asset epoch bumps on every `ApplyAssetCatalogDelta`** even when the catalog contents are unchanged. The contents-equality check happens in the merge, but the epoch reflects the message arrival, not the content delta. If you wire a UI to "asset epoch changed → rerender," expect spurious wake-ups on no-op deltas.
- **Backward-compat fields** (e.g. `channel_settings` defaulting to empty in old `DatasetDisplaySettings` JSON) live in serde defaults; tests in `scene/types.rs` lock the wire format. Don't touch the field structure casually.
