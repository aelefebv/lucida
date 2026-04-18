---
created: 2026-04-18
modified: 2026-04-18
---

# Flow: Document Command Application

The path a `DocumentCommand` (e.g. `RegisterLayout`, `SetActiveLayout`, `RemoveDataset`) takes from "user clicks a layer-panel button" to "every client's document state is updated and `seq` advances."

## Trace

1. **User action** — e.g. user clicks "switch layout" in `LayoutSwitcher`.
2. **Local construction** — the component constructs a `DocumentCommand::SetActiveLayout { dataset_id, layout_id }` value.
3. **Apply-and-send** — `applyAndSend.ts::applyDocumentCommand(cmd)`:
   - Serialize: `JSON.stringify({type: "command", command: cmd})`.
   - Send via `bridge.ts::sendCommand`.
   - **Do not apply locally yet** — wait for the server's broadcast (so all clients converge on the same `seq` ordering).
4. **Wire**: `{type: "command", command: {type: "set_active_layout", ...}}`.
5. **Server** ([[lucida-server]] `handler.rs`):
   - Match `ClientMessage::Command { command }`.
   - `let seq = session.lock().await.apply(command.clone())`. `Session::apply` mutates `document` and advances `seq`. The command also lands in the 256-entry history ring.
   - Construct two messages:
     - `ServerMessage::CommandBroadcast { seq, command }` — for everyone except sender.
     - `ServerMessage::Ack { seq }` — for the sender only.
   - Send `BroadcastItem::CommandBroadcast { sender, broadcast_json, ack_json }` on the broadcast channel. The outbound loop selects `ack_json` when `sender == id`, else `broadcast_json`.
6. **Receiver clients** (everyone, including sender):
   - **Sender** sees `Ack { seq }` and applies the command locally now (it has the `seq` it was assigned). `wasmScene.apply_command(json)` → Scene mutates and bumps the relevant epoch(s).
   - **Other clients** see `CommandBroadcast { seq, command }`. `useBridge` calls `wasmScene.apply_command(commandJson)` → same mutation, same epoch bumps.
7. **Render loop responds** — the relevant epoch bump triggers either a fast plan re-run or a full cold-state rebuild on the next tick. See [[scene-state-and-epochs]].

## Why round-trip on the sender

The sender doesn't apply locally before sending because:

- **Sequence ordering** — the `seq` is assigned by the server. If the sender applied locally first, two concurrent senders would both get `seq=N` provisionally, then one would have to "rewind" when its `Ack` came back with `seq=N+1`. By waiting for the `Ack`, the sender skips the rewind problem entirely.
- **Validation** — the server is the only place that authoritatively knows the current state. A command that depends on a recently-applied command from another client could fail; waiting for the `Ack` ensures the sender sees the same world the server saw.

The cost is one round-trip of latency for document commands. Acceptable because document commands are rare (dataset opens, layout switches) compared to viewport commands (panning every mouse move).

## Special case: `DatasetOpened`

`DatasetOpened` doesn't follow the normal client→server→back path. It's **server-originated**, in response to a separate `OpenRemoteDataset` request from a client. See [[flows/dataset-opening]] for the full trace.

The key difference: the server uses sentinel `sender = u64::MAX` so no client matches and **everyone receives a `CommandBroadcast`** (not an `Ack`). The requesting client never `apply`'d the command itself, so it needs the broadcast path too.

## Special case: `ApplyAssetCatalogDelta`

Server-originated, similar to `DatasetOpened`. Reserved for S5+ when proxy availability changes mid-session. The S3-era server doesn't emit this; the client's handler is a no-op for empty deltas.

## Invariants

- **`seq` is monotonically increasing across the session.** The history ring is bounded at 256; older commands fall off but the seq counter never resets.
- **`Scene::apply` for the same command on different clients converges to the same state**, given the same starting state. Tests in `scene/types.rs` cover this for each command variant.
- **`CommandBroadcast` and `Ack` carry the same `seq`.** A client that wants to know "which commands have been applied through which seq" can use either.
- **Sender does not apply locally before sending.** If you bypass `applyAndSend.ts` and call `wasmScene.apply_command` directly for a document command, you'll desync from the server.

## Gotchas

- **Misclassifying a viewport command as a document command** floods peers with sequenced shared-state updates and bumps `seq` for every mouse-pixel of pan. See [[gotchas/document-vs-viewport-classification]].
- **A failed connection during apply-and-send** loses the in-flight command. The current behavior is to drop the command silently — there's no replay-on-reconnect for recent unacked commands. Mitigated by document commands being rare.
- **Latency is one full round-trip.** For users on poor connections, layout switches feel sluggish. The viewport-immediate render is unaffected, but the layout itself doesn't change until the `Ack` arrives.

## Related

- [[scene-state-and-epochs]]
- [[decisions/document-vs-viewport-split]]
- [[lucida-server]]
- [[lucida-core]]
