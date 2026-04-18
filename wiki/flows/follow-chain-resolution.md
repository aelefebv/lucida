---
created: 2026-04-18
modified: 2026-04-18
---

# Flow: Follow Chain Resolution

What happens when a follow command would create or modify a chain of followers. The server flattens chains into stars (one leader, many direct followers) and propagates the redirect via per-affected-client `FollowChanged` broadcasts.

## Setup

Three clients: `1`, `2`, `3`. `2` is following `1`.

```
1 ← 2
3 (independent)
```

## Case A: 3 tries to follow 2 (chain forbidden)

1. Client 3 sends `{type: "follow", target: 2}`.
2. Server [[lucida-server]] `Session::set_follow(3, Some(2))`:
   - Validation: target `2` exists, but `2` is following `1`. **Reject** — return empty change list.
3. No broadcast. Client 3 sees no `follow_changed` echo and infers (from local state, or after a timeout) that the request was rejected.

The web client's UI can pre-check the rule before emitting (the `following` field of each peer is in local state) so the user doesn't see a delayed silent failure.

## Case B: 1 starts following 3 (transitive flatten)

Now starting from:
```
1 ← 2
3 (independent)
```

1. Client 1 sends `{type: "follow", target: 3}`.
2. Server `set_follow(1, Some(3))`:
   - Validation passes (`3` exists, `3` is not following anyone).
   - Apply: `clients[1].following = Some(3)`. Append `(1, Some(3))` to changes.
   - **Transitive walk**: scan all clients to find anyone who was following `1`. Found: `2`. Redirect: `clients[2].following = Some(3)`. Append `(2, Some(3))` to changes.
   - Return `[(1, Some(3)), (2, Some(3))]`.
3. Server broadcasts two `FollowChanged` messages:
   - `{client_id: 1, target: 3}`
   - `{client_id: 2, target: 3}`
4. All clients receive both, update their local view of who's following whom.

Final state:
```
3 ← 1
3 ← 2
```

Both 1 and 2 are now direct followers of 3. The chain through 1 is gone.

## Case C: 1 disconnects (followers reset)

Starting from `1 ← 2` and `1 ← 4`.

1. Client 1's WebSocket closes.
2. `handler.rs` on disconnect: `Session::remove_client(1)`:
   - Remove `clients[1]`.
   - Walk remaining clients; for each whose `following == Some(1)`, set `following = None`.
   - Return `[2, 4]` (the affected followers).
3. `handler.rs` broadcasts:
   - `peer_left { client_id: 1 }`
   - `follow_changed { client_id: 2, target: None }`
   - `follow_changed { client_id: 4, target: None }`

Final state: 2 and 4 are independent.

## Case D: Self-follow

A client sends `{type: "follow", target: <self_id>}`.

`set_follow` first check: `target == Some(client_id)` → return empty changes. No broadcast, no error. Defensive: the web UI shouldn't allow this, but if it slips through (CLI, scripted Python), the server is the backstop.

## Steer (`Steer { client }`)

Steer is a follow-from-the-other-side: the sender asks the server to make `client` follow the sender. The server treats it as `set_follow(client, Some(sender_id))` and broadcasts the resulting changes the same way as a regular follow. Same validation rules apply — the steer'd client must not already be following someone.

## Invariants

- **The follow graph is always a forest of stars** after `set_follow` returns successfully. No chains, no cycles.
- **The transitive walk only happens on the success path.** If the new follow target is already following someone (rejected at step 2's validation), there's no walk.
- **Disconnect-driven follow clears are server-driven**, not client-derived. A follower whose target disconnects gets `follow_changed { target: None }` from the server. Don't rely on the follower noticing the `peer_left` and clearing locally.
- **Affected-followers broadcasts always include the originator's own change.** The originator gets back `follow_changed` for itself confirming the new state.

## Related

- [[presence-and-follow-mode]]
- [[decisions/peer-to-peer-follow-mode]]
- [[lucida-server]]
