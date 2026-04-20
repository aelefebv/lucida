---
created: 2026-04-18
modified: 2026-04-19
---

# Queue — Open Questions

Open architectural questions, areas to investigate, and decisions to revisit. Add items as they surface; resolve them via interview, decision article, or by closing them out as no-longer-relevant.

## Format

Each item is a short bullet. Add a date when raised. Link to an article or PR when resolved.

## Open

- **2026-04-18** — Many [[decisions/index|Decision]] articles are marked "derived from code analysis." Are there PRDs/RFCs that should be dropped into `wiki/inputs/` so `/repo-wiki-compile` can enrich them with authoritative context?
- **2026-04-18** — Threshold constants in [[planning-domain]] (FAR=80px, MEDIUM=150px, hysteresis=5px) are tuned but the rationale isn't documented. Worth an interview pass to capture *why* these values vs neighbors.
- **2026-04-18** — Proxy generator priority is "FIFO today, scheduler later" ([[gotchas/proxy-priority-not-honored]]). Is the priority scheduler scheduled, or has the team decided FIFO is fine indefinitely?
- **2026-04-18** — [[decisions/temporal-runway-not-implemented]] is recorded as "won't implement" — but does that decision still hold? Worth a re-check after any plate-FPS or scrubbing UX feedback.

## Resolved

- **2026-04-18 → 2026-04-19** — `CLAUDE.md` references to missing `ARCHITECTURE.md` / `DOMAINS.md` / `GLOSSARY.md`. Resolved: `CLAUDE.md` rewritten to point at the wiki and `CHUNK_PIPELINE.md`. Related wiki references (`AGENT.md`, `inputs/README.md`) also corrected.
- **2026-04-19** — `is_document_command()` referenced in 3 wiki articles as if it still gates the wire path. Resolved: function doesn't exist in code; wiki rewritten to describe the actual gate (`applyDocumentCommand`/`applyViewportCommand` call-site discipline + disjoint Rust enums). Affected: [[lucida-web]], [[presence-and-follow-mode]], [[decisions/document-vs-viewport-split]].
- **2026-04-19** — "`Scene::apply` is the only mutation path" overstated as a type-system invariant. Resolved: helpers (`register_dataset`, `remove_dataset`, `ensure_channel`) are also `pub fn (&mut self)`; wiki claims qualified to "conventional mutation path, enforced by review." Affected: [[scene-state-and-epochs]], [[lucida-core]].
