---
type: Principle
title: "Collaboration & Reproducibility"
description: "A view in Lucida is a thing you can hand to someone."
tags: [lucida, principle]
source_path: wiki/principles/collaboration-and-reproducibility.md
created: 2026-06-25
modified: 2026-06-25
---

# Collaboration & Reproducibility

> A product principle. What a *principle* is — and how these are read — is in [Principles](index.md).

## Scope

A view in Lucida is a *thing you can hand to someone*. This doc states the tenet that what one user sees, a peer can see and re-open exactly — that a link is state, that any moment of looking is shareable and recoverable, and that collaboration is a property of the shared document, not a bolt-on. It governs how we treat view state: as a first-class, serializable, shareable value.

## Principles

- **Any view is a link, and the link re-opens that exact view.**
  - today: the SPA continuously encodes the live view into the URL hash as `#view=<gzip+base64 SavedView>` ([URL-as-App-State for Saved Views](../decisions/0013-url-as-app-state-for-saved-views.md)); copying the URL shares the view, and loading it (or back/forward) restores it. No separate "save" step is required for a view to be shareable.

- **"Exactly" means the whole moment of looking — camera, slice, channels, contrast, layout.**
  - today: `SavedView` captures camera (2D/arcball/fly), Z-slab + T + C, global and per-dataset display (contrast, gamma, colormap, visibility, order), and the active layout per dataset — so a re-opened view reproduces the moment, not just the position.

- **A named view is the same value as a link, just stored.**
  - today: long or named views are persisted server-side and addressed by an opaque id (`#b=<id>`), with shared/personal/proposed visibility and an approval flow; on apply they collapse back to `#view=`. The id and the inline hash are two encodings of one `SavedView`.

- **A comment points at what its author was looking at.**
  - today: annotations capture the author's `SavedView`; the deep-link `#a=<id>` restores that captured view, so a pin or comment carries its own viewpoint.

- **A peer can see, and follow, what another peer sees.**
  - today: presence (camera/view/display/cursor) broadcasts to all peers via the relay, and a `Follow`/`FollowChanged` handshake exists. Honest caveat: the web client does not yet auto-apply a followed peer's presence in real time (you apply it explicitly today); the CLI captures/applies via `view capture --from-peer` / `view apply`. Live auto-follow in the web viewer is the aspirational end-state.

- **A shared view must mean the same thing on every machine that opens it.**
  - today: the SavedView wire format is deterministic (per-dataset maps are `IndexMap`, not `HashMap`) so the server's rebroadcast is byte-identical. Local `file://` dataset paths are stripped from shared/stored views ([Local-File Datasets Are Personal-Only in Saved Views](../decisions/0014-local-file-datasets-personal-only-in-saved-views.md)) so a link doesn't leak or break across machines.

## Related

Saved Views · Presence and Follow Mode · Workspaces · Topic: Collaboration
