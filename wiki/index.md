---
created: 2026-04-18
modified: 2026-05-07
---

# Lucida Wiki — Index

Welcome to the Lucida repo wiki. Start with [[CLAUDE]] if you're an agent or new contributor — it explains conventions and navigation order.

## Living state

- [[now]] — current snapshot: active refactors, in-flight work, recent shifts
- [[queue]] — open architectural questions, things to investigate

## Categories

- [[systems/index|Systems]] — split into `crates/` (Cargo workspace members: `lucida-core`, `lucida-server`, `lucida-store`, etc.) and `subsystems/` (web-internal modules and cross-cutting concepts: chunk pipeline, planning, CPU cache, GPU residency, worker protocol, scene state and epochs, presence and follow, layouts, multichannel and colormaps)
- [[decisions/index|Decisions]] — numbered ADRs (`0001-…` onward) recording architectural choices
- [[flows/index|Flows]] — end-to-end traces: dataset opening, chunk lifecycle, presence propagation, follow chain resolution, document command application, proxy generation
- [[gotchas/index|Gotchas]] — tribal knowledge, footguns, build-system quirks

## Topics

Curated cross-cuts that aggregate articles by architectural concern. See [[topics/index|Topics]].

- [[topics/rendering]] — the chunk pipeline cluster (~half the wiki)
- [[topics/storage-and-import]] — `lucida-store`, the three-output import model, on-wire envelopes
- [[topics/collaboration]] — document/viewport split, presence, follow chains, server relay
- [[topics/build-and-tooling]] — TS / WASM / Rust build footguns

## Quick paths

- "I'm new — where do I start?" → [[CLAUDE]] then [[now]] then [[systems/index|Systems]]
- "How does X work end-to-end?" → [[flows/index|Flows]]
- "Show me everything about rendering / storage" → [[topics/index|Topics]]
- "Why was X done that way?" → [[decisions/index|Decisions]]
- "I just hit a weird build/runtime issue" → [[gotchas/index|Gotchas]]
- "Where's the deep dive on the chunk pipeline?" → [[chunk-pipeline]] points at the canonical `CHUNK_PIPELINE.md`

## Source material and artifacts

- `inputs/` — read-only source material (design docs, RFCs, PR descriptions). Drop files here for the compile pass to fold in.
- `outputs/` — standalone artifacts: migration plans, refactor proposals, in-flight decision drafts.
