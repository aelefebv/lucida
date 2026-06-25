---
type: Flow
title: "Flow: Document Command Application"
description: "The path a DocumentCommand (e.g."
tags: [lucida, flow]
source_path: wiki/flows/document-command-application.md
created: 2026-04-18
modified: 2026-06-25
---

# Flow: Document Command Application

The path a `DocumentCommand` (e.g. `RegisterLayout`, `SetActiveLayout`, `RemoveDataset`) takes from "user clicks a layer-panel button" to "every client's document state is updated and `seq` advances."

## Trace

1. **User action** — e.g. user clicks "switch layout" in `LayoutSwitcher`.
2. **Local construction** — the component constructs a `DocumentCommand::SetActiveLayout { dataset_id, layout_id }` value.
3. **Apply-and-send** — `applyAndSend.ts::applyDocumentCommand(cmd)`:
   - **Apply locally and immediately** — `scene.apply_command(json)` mutates the local Scene and bumps the relevant epoch(s) *before* the command leaves the tab (optimistic apply).
   - Serialize the command and send it via `bridge.ts::sendCommand`.
4. **Wire**: `{type: "command", command: {type: "set_active_layout", ...}}`.
5. **Server** ([lucida-server](../systems/crates/lucida-server.md) `handler.rs`):
   - Match `ClientMessage::Command { command }`.
   - `let seq = session.lock().await.apply(command.clone())`. `Session::apply` mutates `document` and advances `seq`. The command also lands in the 256-entry history ring.
   - Construct two messages:
     - `ServerMessage::CommandBroadcast { seq, command }` — for everyone except sender.
     - `ServerMessage::Ack { seq }` — for the sender only.
   - Send `BroadcastItem::CommandBroadcast { sender, broadcast_json, ack_json }` on the broadcast channel. The outbound loop selects `ack_json` when `sender == id`, else `broadcast_json`.
6. **Receiver clients**:
   - **Sender** sees `Ack { seq }`. Its `onAck` handler in `useBridge.ts` is a **no-op** — the sender already applied the command optimistically in step 3 and is deliberately excluded from the rebroadcast (the outbound loop selects `ack_json` when `sender == id`). The `Ack` exists only as a delivery/seq receipt; it triggers no apply.
   - **Other clients** see `CommandBroadcast { seq, command }`. `useBridge` calls `wasmScene.apply_command(commandJson)` → same mutation, same epoch bumps.
7. **Render loop responds** — the relevant epoch bump triggers either a fast plan re-run or a full cold-state rebuild on the next tick. See [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md).

## Why optimistic apply converges

The sender applies locally and is excluded from the rebroadcast, yet every client still converges. The mechanism is **client-supplied stable IDs**, not server-ordered apply:

- **No sender rewind** — the `seq` the server assigns is a sequence/delivery receipt, not an ordering the sender has to wait for. The sender's local state already reflects the command; the `Ack` only confirms it was sequenced. The sender is never asked to undo and re-apply.
- **Convergence via IDs** — commands that introduce new entities (e.g. annotations) carry a client-supplied id. The sender's optimistic local apply and every peer's `CommandBroadcast` apply produce the *same* entity at the *same* id, so local state and peers' broadcast state converge on identical results (see the comment in `SliceViewer.tsx`'s annotation-create path).

The win is **zero added latency** for document commands: a layout switch or pin drop is visible to the author the instant they act, not after a round-trip. Document commands are also rare (dataset opens, layout switches, annotations) compared to viewport commands (panning every mouse move), so the broadcast volume stays low regardless.

## Special case: `DatasetOpened`

`DatasetOpened` doesn't follow the normal client→server→back path. It's **server-originated**, in response to a separate `OpenRemoteDataset` request from a client. See [Flow: Dataset Opening](dataset-opening.md) for the full trace.

The key difference: the server uses sentinel `sender = u64::MAX` so no client matches and **everyone receives a `CommandBroadcast`** (not an `Ack`). The requesting client never `apply`'d the command itself, so it needs the broadcast path too.

## Special case: `ApplyAssetCatalogDelta`

Server-originated, similar to `DatasetOpened`. Reserved for S5+ when proxy availability changes mid-session. The S3-era server doesn't emit this; the client's handler is a no-op for empty deltas.

## Invariants

- **`seq` is monotonically increasing across the session.** The history ring is bounded at 256; older commands fall off but the seq counter never resets.
- **`Scene::apply` for the same command on different clients converges to the same state**, given the same starting state. Tests in `scene/types.rs` cover this for each command variant.
- **`CommandBroadcast` and `Ack` carry the same `seq`.** A client that wants to know "which commands have been applied through which seq" can use either.
- **The sender applies optimistically and is excluded from the rebroadcast.** `applyDocumentCommand` applies locally then sends; the server delivers `Ack` (a no-op receipt) to the sender and `CommandBroadcast` to everyone else. Stable client-supplied ids make the local apply and peers' apply converge. The footgun is the inverse: applying locally **without** also sending (or sending **without** applying) desyncs that tab from the session.

## Gotchas

- **Misclassifying a viewport command as a document command** floods peers with sequenced shared-state updates and bumps `seq` for every mouse-pixel of pan. See [Document vs Viewport Command Classification](../gotchas/document-vs-viewport-classification.md).
- **A failed connection during apply-and-send** applies locally but loses the in-flight broadcast. The sender's tab is now ahead of the session: peers never see the command and there's no replay-on-reconnect for recent un-broadcast commands. Mitigated by document commands being rare.
- **Optimistic apply hides server-side rejection.** Because the sender applies before the server sees the command, a command the server (or workspace persistence) declines still appears applied in the sender's tab; there is no rollback. Document commands are deliberately kept simple/total so this rarely bites.

## Related

- [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md)
- [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md)
- [lucida-server](../systems/crates/lucida-server.md)
- [lucida-core](../systems/crates/lucida-core.md)
