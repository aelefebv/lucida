# Peer-to-Peer Follow Mode

Status: Accepted.

## Context

People in the same session often want to see what someone else sees: a demo, a pairing session, a room with two conversations going at once. Participants drift in and out, and who leads changes.

## Decision

Any client can follow any other client. There is no presenter role, and no client has special privileges.

The follow graph is always a star: one leader, every follower one hop away. The server refuses a follow whose target is the follower itself or is already following someone. When a leader starts following someone else, the server redirects that leader's followers to the new target and broadcasts `FollowChanged` for each, so the result is again a star. When a leader disconnects, its followers stop following. `Session::set_follow` and `Session::remove_client` in `lucida-server` hold this rule.

On the web client, any local viewport command breaks follow. Moving the view means "I want to drive again."

## Rejected alternatives

- A global presenter role. It works for a one-person demo and gets rigid at three or more participants, where anyone may want to lead.
- True chains, where A follows B who follows C. Latency compounds at each hop, since A sees B's stale copy of C's view, and the server would need cycle detection.
- Locked viewports, where one presenter drives every client's view. It takes away each user's ability to look around their own copy.
