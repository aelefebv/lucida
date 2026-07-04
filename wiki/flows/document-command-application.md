---
type: Flow
title: "Flow: Document Command Application"
description: "The path a DocumentCommand (e.g."
tags: [lucida, flow]
source_path: wiki/flows/document-command-application.md
created: 2026-04-18
modified: 2026-07-04
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

## Loss recovery: seq gaps and snapshot resync

The per-client outbound loop forwards a **bounded** `tokio::sync::broadcast` stream (capacity 256 in `main.rs`/`WorkspaceManager`). A client that reads too slowly overflows its receiver (`RecvError::Lagged(n)`) and silently skips `n` messages — including sequenced `CommandBroadcast`s, which would leave its document divergent. Two symmetric repair paths, both landing on the same fresh-`Snapshot` construction as the join path (`Session::snapshot` under the session lock):

- **Server push** — the outbound loop's `Lagged` arm pushes a fresh `Snapshot` to that client. Lock discipline: `recv()` has already repositioned the receiver past the loss, so every message the client will never see was stamped (and applied) before the snapshot is taken — its `seq` covers them all; no hole can open between the snapshot and the resume position.
- **Client request** — the web `Bridge` tracks the last applied `seq` (advanced by snapshots, in-order `CommandBroadcast`s, and `Ack`s of its own commands, which share the seq space). A sequenced message arriving with `seq > last + 1` is buffered behind a short grace timer (~200ms). **A hole is not proof of loss**: the server applies under the session lock but sends *after* releasing it, so concurrent editors routinely deliver seq out of order with nothing lost — a late arrival fills the hole from the buffer and no request is made. Only a hole that outlives the grace window sends one `ClientMessage::RequestSnapshot` (`{"type":"request_snapshot"}`) — at most one in flight, so a gap storm can't spam, and every transmitted request arms a ~5s retry timer that re-requests while the hole persists, **independent of further inbound traffic** — an idle workspace with a buffered tail still recovers, and a request the server's throttle ate (or the wire lost) is re-issued outside the window. The server answers on the requester's unicast channel with the fresh snapshot (throttled per client to one served request per second; the client's 5s retry sits well above that floor).

After applying a snapshot with seq `S`, the client drops any sequenced message with `seq <= S` (its effect is already in the snapshot — no double-apply), applies buffered messages `> S` in order, and resumes normal tracking. A residual gap above `S` simply requests again. Seq tracking is per-connection: it resets on disconnect and re-seeds from the reconnect's snapshot.

Two adoption details keep "the snapshot is authoritative" honest against its own edge cases:

- **Stale-`dataset_opened` delivery is membership-gated.** The server rebroadcasts an already-applied `DatasetOpened` at the *current* seq (without advancing it) when an open dedups onto an existing binding (`dataset_open.rs` dedup-reuse and lost-race paths) — the rebroadcast carries the re-stamped `opener_client_id` for auto-fit, and its apply is an idempotent full-replace, so the client delivers stale-seq `dataset_opened` bodies instead of dropping them (without advancing tracking). But ONLY for datasets the document still contains: the Bridge mirrors the snapshot's manifest key set (kept live by delivered `dataset_opened`/`remove_dataset` commands), so a *retained* rebroadcast for a dataset whose `remove_dataset` the repairing snapshot already covered is dropped rather than resurrecting a deleted dataset with dead bindings.
- **The author's unacked commands are replayed.** A snapshot built between a client's optimistic local apply and the server applying that command would erase the author's own edit on full-replace (the command's `Ack` is still in flight). The Bridge tracks commands it actually transmitted until their acks arrive (FIFO — the server acks one per command in send order), replays them locally after snapshot adoption, and retires each on its ack. Because acks carry only a seq (no command id), staleness is structural: entries older than ~10s are pruned at every retirement/replay/send sweep — a healthy ack round-trips in well under a second, so an entry that old is a server-side rejection (rejections are log-only, never acked), a cap-shed orphan, or a dying connection, and must neither misalign FIFO retirement nor be replayed onto a much-later snapshot (a stale `remove_dataset` would delete a re-opened dataset). The list is additionally capped and cleared on disconnect; the underlying unacked-rejection divergence remains a pre-existing class (see Gotchas). One deliberate tradeoff: the premise "the snapshot predates the command" can lose a queue race — acks ride the broadcast queue while snapshots ride the per-client unicast queue, so a snapshot whose seq already covers the command can arrive before its ack, and the replay then re-applies the author's value over any newer peer edit the snapshot carried; this is accepted because the divergence is local-only and bounded by the next edit/snapshot, whereas skipping replay would erase the author's own edit in the common case.

The mid-session snapshot reuses the web's normal `onSnapshot` path, which is idempotent for already-registered datasets (fetch pipelines and layer maps are keyed by dataset id and not re-created) and authoritative for membership (a dataset absent from the snapshot's document is removed locally — its `remove_dataset` broadcast may be exactly what was lost). This applies to workspace sessions and the legacy `/ws` path alike; both run the shared `handle_client_inner`.

Locked by: `lucida-server/tests/lagged_resync_e2e.rs` (real WebSockets: a stalled reader converges to the flooding client's document; `request_snapshot` returns a fresh snapshot, throttled per client), `lucida-web/src/bridge.resync.test.ts` (reorder-grace → persistent gap → one request → snapshot → stale-drop/membership gate/pending replay → resume), and the wire goldens on both sides (`session/client_request_snapshot.json`).

## Invariants

- **`seq` is monotonically increasing across the session.** The history ring is bounded at 256; older commands fall off but the seq counter never resets.
- **`Scene::apply` for the same command on different clients converges to the same state**, given the same starting state. Tests in `scene/types.rs` cover this for each command variant.
- **`CommandBroadcast` and `Ack` carry the same `seq`.** A client that wants to know "which commands have been applied through which seq" can use either. The web `Bridge` does exactly that: both advance its last-applied-seq tracking, and a persistent gap on either triggers the snapshot resync above.
- **Delivery order is NOT seq order.** The server applies under the session lock and sends after releasing it, so two concurrent editors' broadcasts can reach a third client out of seq order with zero loss. Consumers must not equate "gap" with "loss" — the Bridge's reorder-grace window exists precisely for this.
- **Broadcast loss is repaired, not tolerated.** A persistent seq gap (server-side `Lagged` overflow, or a command applied-but-not-broadcast such as the `PersistFailed` case in `WorkspaceManager::apply_document_command`) converges via a fresh snapshot — server-pushed on `Lagged`, client-requested via `RequestSnapshot` — instead of persisting until a full reconnect.
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
