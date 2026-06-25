---
type: Decision
title: "Peer-to-Peer Follow Mode"
description: "Follow mode in Lucida is peer-to-peer: any client can follow(target) any other client, and the lucida-server resolves transitive chains so that \"A follows B follows C\" reduces to \"both A and B follow C.\" There is no g…"
tags: [lucida, decision]
source_path: wiki/decisions/0002-peer-to-peer-follow-mode.md
created: 2026-04-18
modified: 2026-05-07
---

# Peer-to-Peer Follow Mode

## Decision

Follow mode in Lucida is **peer-to-peer**: any client can `follow(target)` any other client, and the [lucida-server](../systems/crates/lucida-server.md) resolves transitive chains so that "A follows B follows C" reduces to "both A and B follow C." There is no global presenter role; no one client has special privileges.

The web client's local follow state is broken by **any local viewport command** (e.g. a Pan), under the assumption that explicitly moving means "I want to drive again."

## Why

Peer-to-peer follow handles the typical collaboration shape (small cliques following each other, people drifting in and out) that a global-presenter model handles poorly:

- **No "who has the conch" friction.** Anyone can lead by being followed; anyone can opt in or out at any time.
- **Demos work without designation.** A presenter just opens the dataset and announces "I'm peer 7" — others click follow.
- **Multi-leader sub-groups work.** A workshop room can have two conversations going simultaneously, each with its own follow chain.

## Constraint: chains are flattened, not preserved

The server validates that you cannot follow someone who is themselves following someone. This forbids chain-of-follower relationships and keeps the follow graph a star (one leader, many direct followers).

When the leader of a star starts following someone else, the server walks the star and redirects everyone to the new transitive target. The result is still a star, just rooted at a different leader. See `Session::set_follow` in [lucida-server](../systems/crates/lucida-server.md).

The reason for flattening (inferred): if A → B → C is allowed, latency compounds — A's viewport gets B's stale view of C's even-stale view of where C actually is. Flattening guarantees one hop of latency from leader to follower.

## Alternatives considered (inferred)

- **Global presenter role.** Rejected as too rigid for normal collaboration; works for one-presenter demos but breaks down at three or more participants.
- **True chains (A → B → C without flattening).** Rejected for compounded latency and the cycle-detection complexity.
- **Locked viewports (every client gets the same view, controlled by a presenter).** Rejected because it removes the user's ability to pan around their own copy.

## How this decision shows up in code

- `Session::set_follow` in [lucida-server](../systems/crates/lucida-server.md): validates target exists, target isn't following someone else, target isn't self. Computes affected followers transitively. Returns `(client_id, new_target)` pairs for every client that needs a `FollowChanged` broadcast.
- `Session::remove_client` redirects all of the disconnecting client's followers to `following: None` and returns the affected list — same broadcast path as a manual unfollow.
- The web client's `useBridge` hook handles incoming `PresenceUpdate` for the followed client by applying the same viewport changes locally.
- See [Presence and Follow Mode](../systems/subsystems/presence-and-follow-mode.md) for the wire shape and broader presence model.

## Related

- [Presence and Follow Mode](../systems/subsystems/presence-and-follow-mode.md)
- [Flow: Follow Chain Resolution](../flows/follow-chain-resolution.md)
