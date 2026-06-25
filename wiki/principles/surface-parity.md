---
type: Principle
title: "Surface Parity"
description: "Lucida is reachable from a web viewer, a lucida CLI, Python, and (by design) an LLM agent."
tags: [lucida, principle]
source_path: wiki/principles/surface-parity.md
created: 2026-06-25
modified: 2026-06-25
---

# Surface Parity

> A product principle. What a *principle* is — and how these are read — is in [Principles](index.md).

## Scope

Lucida is reachable from a web viewer, a `lucida` CLI, Python, and (by design) an LLM agent. This doc states the tenet that none of those is a second-class citizen: every surface joins the same workspace, sees the same datasets and the same chunks, and observes the same live state. It governs how we add capabilities — a feature added to one surface should be reachable from the others, not siloed in the SPA.

## Principles

- **Every surface is a first-class client of the same workspace, not a viewer bolted onto a server.**
  - today: web, CLI, and Python all connect to the same session protocol over `/ws/workspaces/{id}` (and anonymous `/ws`), speaking the same `ClientMessage`/`ServerMessage` envelope from `lucida-core::protocol`. The route, the message types, and the session handler are shared, not per-surface.

- **A Python developer can access the same chunks a user sees in the webview.**
  - today: chunk addressing and visibility math live once in `lucida-core` (compiled to WASM for the web, linked natively by the server, CLI, and Python), so a chunk key means the same thing on every surface; the server serves identical binary chunk frames to whoever asks.

- **What one surface can change, every surface can observe — live.**
  - today: edits broadcast to all connected clients as `CommandBroadcast`; presence, cursor, and per-dataset display flow through the same relay, so a web client, a CLI session, and a Python script can sit in one workspace and see each other's changes.

- **The view math has one home; no surface re-derives it.**
  - today: projected size, frustum, LOD, and importance are computed in `lucida-core` and read via snapshot — the web client does not reimplement them in JS. This is the planner's [Principles — Planning Domain](planning.md) §5, seen at the product level: one implementation is *why* the surfaces agree.

- **Identity and permissions mean the same thing on every surface.**
  - today: workspace auth and the server-authored peer identity apply uniformly; a CLI peer and a web peer are the same kind of participant in the snapshot's peer list.

- **A capability added to one surface should be reachable from the others.**
  - aspirational: partially true. The CLI is rich (peer list, follow capture/apply, slice, montage); Python today exposes scene state and store access (`PyScene`, `PyStore`) but not the full presence/follow or render surface. Treat Python feature gaps as debt against this principle, not as the intended design.

## Related

[Workspaces](../systems/subsystems/workspaces.md) · [lucida-cli](../systems/crates/lucida-cli.md) · [lucida-py](../systems/crates/lucida-py.md) · [lucida-web](../systems/crates/lucida-web.md) · [Agent-First Access](agent-first-access.md)
