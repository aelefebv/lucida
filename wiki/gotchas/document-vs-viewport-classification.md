---
type: Gotcha
title: "Document vs Viewport Command Classification"
description: "Misclassifying a viewport command as a document command, or vice versa, has loud consequences:"
tags: [lucida, gotcha]
source_path: wiki/gotchas/document-vs-viewport-classification.md
created: 2026-04-18
modified: 2026-06-25
---

# Document vs Viewport Command Classification

## The footgun

Misclassifying a viewport command as a document command, or vice versa, has loud consequences:

- **Viewport-as-document**: every mouse-pixel of pan goes to the server, gets a `seq`, gets broadcast to every peer. The server's broadcast queue saturates; every peer renders a flurry of updates. The history ring fills up with garbage. Network usage explodes.
- **Document-as-viewport**: state changes that should be shared (e.g. opening a dataset, switching layout) only happen locally on the originating client. Other clients silently desync — they don't see the dataset, can't follow you into it, and there's no error to point at.

## How to classify

The split is documented in [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md). Quick rule:

- Does the change affect **what's loaded or shared** (datasets, layouts, annotations)? → **DocumentCommand**.
- Does the change affect **how I'm looking at it** (camera, slice index, contrast, channel visibility)? → **ViewportCommand**.

The Rust enums in [lucida-core](../systems/crates/lucida-core.md) `command.rs` enumerate every variant. If you're adding a new command, decide which enum it belongs in *before* writing the apply logic, and use [lucida-web](../systems/crates/lucida-web.md)'s `applyDocumentCommand` vs `applyViewportCommand` accordingly.

## The wire-side check

The web client's send path is the gate. A command going through `applyDocumentCommand`:

- Applies optimistically-locally **first** (`scene.apply_command(json)`, no await), bumps the settings generation, then calls `sendCommand(json)`. The author is excluded from the server's rebroadcast, so the local apply is what they actually see — there is no wait for an `Ack`/`CommandBroadcast`. (The in-source comment at `SliceViewer.tsx` near the annotation send spells this out.)

A command going through `applyViewportCommand`:

- Applies locally only via `scene.apply_command(json)` and is **not** sent to the server.
- The presence side (throttled `presence` messages) is emitted separately by the viewport's own send path, not by `applyViewportCommand` itself.

Crossing the wires at the call site is the bug.

## What to do if you suspect a misclassification

1. Open `lucida-core/src/command.rs` and confirm which enum the variant lives in.
2. Find the call site (SliceViewer / VolumeViewer / annotation overlays). There is no dispatch table — `applyAndSend.ts` is just two helpers (`applyDocumentCommand`, `applyViewportCommand`) that encode the send-or-not decision; classification is chosen ad hoc at each call site by which helper it invokes. Confirm the right one is called.
3. Watch the server's seq counter (debug panel) during the suspected operation. Pan should *not* increment seq; opening a dataset *should*.

## Why it's silent

- Viewport-as-document is loud (broadcast volume) but in normal use, you might not notice until many clients connect.
- Document-as-viewport is silent until a second client tries to see the same state and can't.

The defense is reading the wire payload format on the server (which differentiates `ClientMessage::Command` from `ClientMessage::Presence` at the JSON tag level) — but at the application layer, we rely on the call-site discipline.

## Related

- [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md)
- [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md) — epochs reflect the split
- [Presence and Follow Mode](../systems/subsystems/presence-and-follow-mode.md) — the presence side
