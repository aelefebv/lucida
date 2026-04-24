---
created: 2026-04-18
modified: 2026-04-18
---

# Lucida Wiki — Index

Welcome to the Lucida repo wiki. Start with [[AGENT]] if you're an agent or new contributor — it explains conventions and navigation order.

## Living state

- [[now]] — current snapshot: active refactors, in-flight work, recent shifts
- [[queue]] — open architectural questions, things to investigate
- [[glossary]] — flat term lookup; links into fuller articles when terms have their own page

## Categories

- [[systems/index|Systems]] (18 articles) — crates (`lucida-core`, `lucida-server`, `lucida-store`, `lucida-protocol`, `lucida-content`, `lucida-cli`, `lucida-proxy`, `lucida-py`, `lucida-web`) and web subsystems (chunk pipeline, planning, CPU cache, GPU residency, worker protocol, scene state and epochs, presence and follow, layouts, multichannel and colormaps)
- [[decisions/index|Decisions]] (12 articles) — ADR-style records of architectural choices, all derived from code analysis (rationale inferred — see each article for the disclaimer)
- [[flows/index|Flows]] (6 articles) — end-to-end traces: dataset opening, chunk lifecycle, presence propagation, follow chain resolution, document command application, proxy generation
- [[gotchas/index|Gotchas]] (15 articles) — tribal knowledge, footguns, build-system quirks

## Quick paths

- "I'm new — where do I start?" → [[AGENT]] then [[now]] then [[systems/index|Systems]]
- "How does X work end-to-end?" → [[flows/index|Flows]]
- "Why was X done that way?" → [[decisions/index|Decisions]]
- "I just hit a weird build/runtime issue" → [[gotchas/index|Gotchas]]
- "Where's the deep dive on the chunk pipeline?" → [[chunk-pipeline]] points at the canonical `CHUNK_PIPELINE.md`

## Source material and artifacts

- `inputs/` — read-only source material (design docs, RFCs, PR descriptions). Drop files here for `repo-wiki-compile` to fold in.
- `outputs/` — standalone artifacts: migration plans, refactor proposals, in-flight decision drafts.
