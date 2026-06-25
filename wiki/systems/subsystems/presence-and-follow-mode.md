---
created: 2026-04-18
modified: 2026-06-25
---

# Presence and Follow Mode

Presence is the per-client ephemeral state — viewport, cursor, follow target, dataset display settings — broadcast through [[lucida-server]] but never sequenced or persisted. Follow mode is **peer-to-peer**: any client can follow any other client; the server resolves transitive chains so that when A follows B and B follows C, A ends up effectively following C.

## Why peer-to-peer instead of a global presenter

The intuitive model — one "presenter" client whose viewport drives everyone else — collapses as soon as more than two people are involved. Real collaboration has small cliques following each other, with people drifting in and out of the group.

Peer-to-peer follow lets every client independently choose whom to follow (or no one). The server-side validation prevents loops and chains-of-followers, but otherwise stays out of the way. See [[decisions/0002-peer-to-peer-follow-mode]].

## Five wire messages

In `lucida-core/src/protocol.rs`:

- `ClientMessage::Presence { camera, view, display }` — viewport state. Throttled at ~50 ms in [[lucida-web|`bridge.ts`]].
- `ClientMessage::Cursor { position: Option<[f64; 2]> }` — cursor in canvas coords; `None` when leaving.
- `ClientMessage::Follow { target: Option<ClientId> }` — start/stop following.
- `ClientMessage::Steer { client }` — make another client follow you. The server treats it as a `set_follow(client, Some(self))`.
- `ClientMessage::DatasetPresence { dataset_order, dataset_settings }` — per-dataset visibility, contrast, gamma, colormap. Throttled at ~200 ms.

Server fans out each as the corresponding `ServerMessage::*Update` to peers (filtering out the originator).

## Transitive chain resolution

Lives in `Session::set_follow` in [[lucida-server]]. Two rules:

1. **Loops are forbidden.** A client cannot follow itself. The target must not already be following someone (so chains don't form indirectly through "A follows B who follows C").
2. **When A follows C and C starts following B, A is redirected to B.** The server walks current followers of the changed client and patches their `following` to the new transitive target.

The server returns the list of `(client_id, new_target)` pairs affected — every one becomes a `FollowChanged` broadcast.

When a client disconnects, anyone following them is reset to `following: None` and a `FollowChanged` goes out for each.

## Interactions

- **Producer**: every connected client (web, CLI). The web client emits via `applyViewportCommand` and the throttled bridge channels.
- **Server**: stores `PresenceState` in `Session::clients`. Validates follow targets. Filters self-presence on the outbound side. Recomputes transitive chains on `set_follow`.
- **Consumer**: peers receive `PresenceUpdate`/`CursorUpdate`/`FollowChanged`/`DatasetPresenceUpdate` and apply locally. The web client's `useBridge` hook handles each.
- **Local follow path**: when a client is following peer X, every `PresenceUpdate { client_id: X, ... }` triggers a local viewport update (acting as if the user moved). Following can be **broken** by any local viewport command, which sends a `Follow { target: None }` and clears the local follow state.
- **Discrete-snapshot counterpart**: [[saved-views]] is conceptually "one-shot follow against a frozen snapshot." `PresenceState` is what the saved-view capture record mirrors on the per-client surface (camera, view, display, dataset_order, dataset_settings); the difference is durability — saved views are inline-encoded URL hashes or server-stored bookmarks, presence is ephemeral. Opening a saved-view link breaks an active follow via the same viewport-command rule above.

## Invariants

- **Presence updates are ephemeral.** Never sequenced; never persisted. Lost packets are fine because the next presence message overwrites.
- **The server filters self-presence on the outbound side.** A client never receives back its own `PresenceUpdate`/`CursorUpdate`/`DatasetPresenceUpdate`. The check is `sender == id` in the broadcast handler. **Exception: `FollowChanged`** carries no sender and is *not* self-filtered — the originator of a follow does receive their own `FollowChanged` (it confirms the transitive target the server resolved).
- **Follow validation is monotonic.** `set_follow` either validates and applies (returning a non-empty change list) or rejects (returning empty). It does not partially apply.
- **Cursor is null when the cursor leaves the canvas.** `null` is a real value, not "no update." Peers should explicitly hide remote cursors on `null`.

## Gotchas

- **What's broadcast and persisted is decided at the JS call site** — `applyDocumentCommand` (sends + awaits Ack) vs `applyViewportCommand` (local + presence emit). There's no runtime predicate; the Rust enums (`DocumentCommand` vs `ViewportCommand`) gate it at compile time. Misclassifying a viewport command as a document command floods peers with sequenced shared-state updates. See [[gotchas/document-vs-viewport-classification]].
- **Throttle defaults are tuned, not arbitrary.** Presence at ~50 ms keeps mouse-driven panning smooth. Dataset presence at ~200 ms accommodates UI sliders without flooding. Halving them hits the server's broadcast queue hard with many clients.
- **Steer can only target a non-following client.** If the target is already following someone (even themselves indirectly), steer is rejected silently. The product CLI no longer exposes the old steering flag; CLI follow uses the direct peer-follow path instead.
- **Local follow state is broken by any viewport command** the user issues — the assumption being that explicitly moving is a clear "I want to drive again" signal. If a client wants to merge follow with manual nudges, that's not currently expressible.
