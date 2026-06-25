---
okf_version: "0.1"
---

# Lucida Wiki — Index

Welcome to the Lucida repo wiki. Start with [CLAUDE.md — Lucida Repo Wiki](CLAUDE.md) if you're an agent or new contributor — it explains conventions and navigation order.

## Living state

- [Now — Lucida Current State](now.md) — current snapshot: active refactors, in-flight work, recent shifts
- [Queue — Open Questions](queue.md) — open architectural questions, things to investigate

## Categories

- [Systems](systems/index.md) — split into `crates/` (Cargo workspace members: `lucida-core`, `lucida-server`, `lucida-store`, etc.) and `subsystems/` (web-internal modules and cross-cutting concepts: chunk pipeline, planning, CPU cache, GPU residency, worker protocol, scene state and epochs, presence and follow, layouts, multichannel and colormaps)
- [Principles](principles/index.md) — stable claims about what each subsystem optimizes for; the framework ADRs live within
- [Decisions](decisions/index.md) — numbered ADRs (`0001-…` onward) recording architectural choices
- [Flows](flows/index.md) — end-to-end traces: dataset opening, chunk lifecycle, presence propagation, follow chain resolution, document command application, historical proxy generation
- [Gotchas](gotchas/index.md) — tribal knowledge, footguns, build-system quirks

## Topics

Curated cross-cuts that aggregate articles by architectural concern. See [Topics](topics/index.md).

- [Topic: Rendering](topics/rendering.md) — the chunk pipeline cluster (~half the wiki)
- [Topic: Storage and Import](topics/storage-and-import.md) — `lucida-store`, the three-output import model, on-wire envelopes
- [Topic: Collaboration](topics/collaboration.md) — document/viewport split, presence, follow chains, server relay
- [Topic: Build and Tooling](topics/build-and-tooling.md) — TS / WASM / Rust build footguns

## Quick paths

- "I'm new — where do I start?" → [CLAUDE.md — Lucida Repo Wiki](CLAUDE.md) then [Now — Lucida Current State](now.md) then [Systems](systems/index.md)
- "How does X work end-to-end?" → [Flows](flows/index.md)
- "Show me everything about rendering / storage" → [Topics](topics/index.md)
- "What is this subsystem trying to optimize for?" → [Principles](principles/index.md)
- "Why was X done that way?" → [Decisions](decisions/index.md) (and the principles they cite)
- "I just hit a weird build/runtime issue" → [Gotchas](gotchas/index.md)
- "How does lucida actually deploy?" → [Deployment](systems/subsystems/deployment.md) is the conceptual reference; `extras/deploy/RUNBOOK.md` is the procedural walkthrough

## Source material and artifacts

- `inputs/` — read-only source material (design docs, RFCs, PR descriptions). Drop files here for the compile pass to fold in.
- `outputs/` — standalone artifacts: migration plans, refactor proposals, in-flight decision drafts.
