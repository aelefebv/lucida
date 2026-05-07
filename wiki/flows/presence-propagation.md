---
created: 2026-04-18
modified: 2026-05-07
---

# Flow: Presence Propagation

From "user A pans" to "user B's viewport reflects A's new position" (when B is following A) or "user B sees A's cursor move on screen" (always). The flow is short and low-latency by design — presence is ephemeral, fire-and-forget.

## Trace: ordinary presence (cursor / viewport)

1. **User A interacts** — pan, zoom, mouse-move, slice scrub.
2. **Local apply** — `applyAndSend.ts::applyViewportCommand` calls `wasmScene.apply_command(json)`. Scene's `apply_viewport(cmd)` mutates the local viewport state and bumps the `view` or `selection` epoch.
3. **Render-loop dirty** — the command sets `interactiveDirty` so the local render reflects immediately.
4. **Throttled emit** — `applyViewportCommand` queues a `presence` message. `bridge.ts` throttles at ~50 ms; the latest queued payload wins (older queued payloads are dropped).
5. **Wire** — `{type: "presence", camera, view, display}` JSON to the WebSocket.
6. **Server** ([[lucida-server]] `handler.rs`) — `Session::update_presence` mutates `clients[id]` in place. Constructs `ServerMessage::PresenceUpdate { client_id, camera, view, display }` and broadcasts via `BroadcastItem::PresenceUpdate { sender, json }`.
7. **Self-filter** — the broadcast loop checks `sender == id` and skips sending back to the originator.
8. **All other clients** receive `presence_update`. `bridge.ts::onPresenceUpdate` routes to `useBridge`'s handler which:
   - Updates the per-peer presence state in the local store.
   - If the receiving client is **following** `client_id`, mirrors the camera/view/display locally via `applyViewportCommand` (without re-emitting — see invariants below).
   - Otherwise, just stores it (e.g. for the [[lucida-web|peer cursor overlay]] to read).

## Trace: cursor (`cursor` message)

Same shape as presence. `ClientMessage::Cursor { position: Option<[f64;2]> }` → `ServerMessage::CursorUpdate`. `position: None` means "cursor left the canvas" — peers should hide the remote cursor on `null`.

Throttle is shared with presence (~50 ms in `bridge.ts`).

## Trace: dataset presence (`dataset_presence` message)

`ClientMessage::DatasetPresence { dataset_order, dataset_settings }` carries per-dataset display state (visibility, contrast, gamma, colormap). Throttled at ~200 ms — slower than viewport because UI sliders don't need 50 ms updates and the payloads are larger.

The server-side path is identical: `Session::update_dataset_presence` → `ServerMessage::DatasetPresenceUpdate` broadcast (sender filtered).

## Invariants

- **Presence is never sequenced or persisted.** Lost packets are fine — the next presence update overwrites. New clients on connect get current `peers` in `Snapshot` rather than replaying lost messages.
- **Self-filter is server-side.** The originator never receives back its own presence/cursor/dataset-presence updates. The check is `sender == id` in the outbound broadcast loop.
- **Throttling is sender-side.** The server broadcasts everything it receives; rate-limiting happens on each client's `bridge.ts` to avoid hammering its own send path.
- **Following clients apply incoming presence locally without re-emitting.** Otherwise A→B following would echo back through B's emit and create a feedback loop. The follow-mode local apply is silent.

## Latency

- Local render after user input: **immediate** (`interactiveDirty` is throttle-exempt — see [[decisions/0009-pull-based-raf-with-typed-dirty]]).
- Wire latency to the next-hop server: 1–10 ms typical.
- Server fan-out: O(n) per peer; for typical n<10, sub-millisecond.
- Receiver render: next RAF — ≤16 ms.

End-to-end (panner finger → follower screen): ~30–50 ms typical, dominated by network + RAF.

## Related

- [[presence-and-follow-mode]]
- [[flows/follow-chain-resolution]]
- [[decisions/0001-document-vs-viewport-split]]
