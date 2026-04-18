---
created: 2026-04-18
modified: 2026-04-18
---

# Scene State and Epochs

How the WASM Scene exposes "what changed since you last asked." Owns one of the central performance levers in the codebase: the orchestrator's epoch fast-path skips most frames entirely.

## What an epoch is

`SceneEpochs` (in [[lucida-core]]'s `epoch.rs`) is a struct of monotonically increasing `u64` counters, one per category of state:

- `content` — entity membership / metadata changed (`DatasetOpened`, `RemoveDataset`)
- `layout` — spatial layout changed (`RegisterLayout`, `SetActiveLayout`)
- `view` — camera moved (`Pan`, `Zoom`, `Rotate`, `Fly`, `SetCenter`, `SetViewport`, mode switch)
- `selection` — selection-like state changed (`SetT`, `SetC`, `SetZ`, `SetMultiChannel`, channel visibility/settings, render mode, contrast, gamma)
- `asset` — asset catalog changed (proxy availability published or revoked)

Every command that mutates the scene bumps exactly the right epoch(s). `Pan` bumps only `view`. `SetT` bumps only `selection`. `DatasetOpened` bumps both `content` and `layout`. `ApplyAssetCatalogDelta` bumps only `asset`. The bumps happen inside `Scene::apply`; nothing else writes them.

## Why typed epochs over a single dirty flag

A single dirty bit forces every consumer to do the most expensive work. Typed epochs let the orchestrator say:

> "Selection changed but view didn't — so I need to rebuild the descriptor buffer, but I can skip the full cold-state rebuild and the wanted-set recomputation."

Concretely, the orchestrator's `planAndFetch` ([[chunk-pipeline]]) starts with an epoch read; if every counter is unchanged, it returns the cached result and the tick is essentially free. Hits ~5% of frames in normal viewing.

The split also lets [[gpu-residency|the worker]] decide independently — it gets the planning epochs in every chunk/proxy delivery and drops anything that's stale relative to its current understanding.

## Document state, derived state, presence state

Three layers of "what is the scene right now":

- **`DocumentState`** (`scene/types.rs`) — the shared, persisted, authoritative state. Manifests, registered layouts, active layout selections, asset catalogs. Mutated only by `DocumentCommand`. Serialized over the wire; sent in `ServerMessage::Snapshot`.
- **Derived state** — computed from document state + active layout. Member positions, projected transforms. Rebuilt by `Scene::rebuild_derived` and per-command in `Scene::apply`. Not serialized; reconstructable.
- **Presence state** — per-client viewport, camera, view, display, follow target, cursor. Local + broadcast as ephemeral `PresenceState`; never sequenced.

`Scene` composes `DocumentState` via `#[serde(flatten)]` so the JSON wire format stayed compatible across the document/scene refactor — see [[gotchas/scene-document-state-json-compat]].

## Interactions

- **Producer**: `Scene::apply` in [[lucida-core]]. Single mutator, single epoch bumper.
- **Consumers**:
  - [[chunk-pipeline|orchestrator]] reads epochs every tick to short-circuit; passes them in chunk/proxy deliveries to [[gpu-residency|the worker]] for staleness checks.
  - The web client passes `Scene::apply_command` for every incoming `CommandBroadcast` so all clients converge on the same document state and bump the same epochs.
  - [[lucida-server]] doesn't read epochs directly — it owns its own seq counter for command ordering. Epochs are a renderer concern.

## Invariants

- **Epochs only increase.** Fresh `Scene` starts at zero; `Scene::apply` is the only writer.
- **`Scene::apply` is the only mutation path.** Bypassing it (e.g. by mutating fields directly via field-public access) skips epoch bumps and derived-state rebuilds — invisible until the renderer goes stale.
- **Derived state is a function of document state + active layout.** Always reconstructable; never serialized. The CLI takes a snapshot and calls `Scene::rebuild_derived` to recompute it locally.
- **The same command applied twice produces the same Scene** when the command is idempotent. `ApplyAssetCatalogDelta` is the explicit case — repeated application of the same delta merges idempotently. `DatasetOpened` is not idempotent (it would bump epochs twice), and the server's reuse path catches the duplicate before re-applying.

## Gotchas

- **`SetActiveLayout` requires special apply ordering.** Document state must be applied first, then derived state rebuilt — because rebuilding derived state needs to read the freshly-applied layout selection from `document.active_layout_ids`. See `command.rs:121` for the explicit early-return.
- **Asset epoch bumps on every `ApplyAssetCatalogDelta`** even when the catalog contents are unchanged. The contents-equality check happens in the merge, but the epoch reflects the message arrival, not the content delta. If you wire a UI to "asset epoch changed → rerender," expect spurious wake-ups on no-op deltas.
- **Backward-compat fields** (e.g. `channel_settings` defaulting to empty in old `DatasetDisplaySettings` JSON) live in serde defaults; tests in `scene/types.rs` lock the wire format. Don't touch the field structure casually.
