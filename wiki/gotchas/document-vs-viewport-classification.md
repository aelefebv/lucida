---
created: 2026-04-18
modified: 2026-05-07
---

# Document vs Viewport Command Classification

## The footgun

Misclassifying a viewport command as a document command, or vice versa, has loud consequences:

- **Viewport-as-document**: every mouse-pixel of pan goes to the server, gets a `seq`, gets broadcast to every peer. The server's broadcast queue saturates; every peer renders a flurry of updates. The history ring fills up with garbage. Network usage explodes.
- **Document-as-viewport**: state changes that should be shared (e.g. opening a dataset, switching layout) only happen locally on the originating client. Other clients silently desync — they don't see the dataset, can't follow you into it, and there's no error to point at.

## How to classify

The split is documented in [[decisions/0001-document-vs-viewport-split]]. Quick rule:

- Does the change affect **what's loaded** (datasets, layouts, asset catalogs)? → **DocumentCommand**.
- Does the change affect **how I'm looking at it** (camera, slice index, contrast, channel visibility)? → **ViewportCommand**.

The Rust enums in [[lucida-core]] `command.rs` enumerate every variant. If you're adding a new command, decide which enum it belongs in *before* writing the apply logic, and use [[lucida-web]]'s `applyDocumentCommand` vs `applyViewportCommand` accordingly.

## The wire-side check

The web client's send path is the gate. A command going through `applyDocumentCommand`:

- Calls `bridge.sendCommand(json)` (round-trips through server).
- Awaits the `Ack`/`CommandBroadcast` before applying locally.

A command going through `applyViewportCommand`:

- Applies locally immediately via `wasmScene.apply_command(json)`.
- Emits a throttled `presence` message.

Crossing the wires at the call site is the bug.

## What to do if you suspect a misclassification

1. Open `lucida-core/src/command.rs` and confirm which enum the variant lives in.
2. Open `lucida-web/src/applyAndSend.ts` and confirm the dispatch table matches.
3. Watch the server's seq counter (debug panel) during the suspected operation. Pan should *not* increment seq; opening a dataset *should*.

## Why it's silent

- Viewport-as-document is loud (broadcast volume) but in normal use, you might not notice until many clients connect.
- Document-as-viewport is silent until a second client tries to see the same state and can't.

The defense is reading the wire payload format on the server (which differentiates `ClientMessage::Command` from `ClientMessage::Presence` at the JSON tag level) — but at the application layer, we rely on the call-site discipline.

## Related

- [[decisions/0001-document-vs-viewport-split]]
- [[scene-state-and-epochs]] — epochs reflect the split
- [[presence-and-follow-mode]] — the presence side
