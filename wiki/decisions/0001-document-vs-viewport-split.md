---
type: Decision
title: "Document vs Viewport Command Split"
description: "Lucida splits state mutations into two disjoint enums in lucida-core's command.rs:"
tags: [lucida, decision]
source_path: wiki/decisions/0001-document-vs-viewport-split.md
created: 2026-04-18
modified: 2026-05-07
---

# Document vs Viewport Command Split

## Decision

Lucida splits state mutations into two disjoint enums in [lucida-core](../systems/crates/lucida-core.md)'s `command.rs`:

- **`DocumentCommand`** — shared, sequenced, persisted, broadcast to all clients. Examples: `DatasetOpened`, `RemoveDataset`, `RegisterLayout`, `SetActiveLayout`, `ApplyAssetCatalogDelta`.
- **`ViewportCommand`** — local-only, applied immediately, emitted as ephemeral presence. Examples: `Pan`, `ZoomBy`, `SetT`, `SetGamma`, `SetChannelColormap`, `SetMultiChannel`.

A `Command` wrapper enum (`#[serde(untagged)]`) deserializes from either shape, used at the JSON boundary in [lucida-py](../systems/crates/lucida-py.md) and [lucida-cli](../systems/crates/lucida-cli.md).

## Why

Three concrete consequences shape the design:

1. **Conflict-free collaboration.** Two clients panning at the same time mustn't fight; viewport state is per-client. Two clients opening the same dataset must agree on the result; document state is shared.
2. **Snapshot semantics.** A new client connecting needs to know "what datasets are loaded, with what layouts, with what asset catalogs" — that's `DocumentState`, sent in `ServerMessage::Snapshot`. It does **not** need the previous viewer's pan position.
3. **Different durability requirements.** Document commands are sequenced (`seq` increments, ack to sender) and held in a 256-entry history ring. Presence updates are fire-and-forget; the latest wins.

## Alternatives considered (inferred)

- **One unified `Command` enum with a per-variant flag** for shared-vs-local. Rejected (probably) because the type system can't enforce the distinction — every server-side handler would need a runtime guard. The current split makes "is this shared?" a compile-time question.
- **Server-side classification via a runtime predicate** (an earlier design had an `is_document_command()` check). Removed: `ClientMessage::Command` carries `DocumentCommand` directly, not the unified enum, so the wire shape is unambiguous and no runtime guard is needed.

## How this decision shows up in code

- The web client's `applyAndSend.ts` exposes `applyDocumentCommand(cmd)` (sends to server) and `applyViewportCommand(cmd)` (applies locally + emits presence). Misclassifying is a footgun — see [Document vs Viewport Command Classification](../gotchas/document-vs-viewport-classification.md).
- [lucida-server](../systems/crates/lucida-server.md)'s `Session::apply` only accepts `DocumentCommand` and increments `seq`. There's no "apply viewport command" path on the server because viewport state isn't shared.
- [Epoch bumps](../systems/subsystems/scene-state-and-epochs.md) are split: `DatasetOpened` bumps `content` and `layout`; `Pan` bumps `view`; `SetT` bumps `selection`. The orchestrator uses these to skip cold-state rebuilds when only viewport changed.

## Related

- [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md) — how the split surfaces in the epoch model
- [Presence and Follow Mode](../systems/subsystems/presence-and-follow-mode.md) — what presence updates carry
- [Document vs Viewport Command Classification](../gotchas/document-vs-viewport-classification.md) — what goes wrong when you misclassify
