---
created: 2026-04-18
modified: 2026-04-18
---

# Queue — Open Questions

Open architectural questions, areas to investigate, and decisions to revisit. Add items as they surface; resolve them via interview, decision article, or by closing them out as no-longer-relevant.

## Format

Each item is a short bullet. Add a date when raised. Link to an article or PR when resolved.

## Open

- **2026-04-18** — `CLAUDE.md` references `ARCHITECTURE.md` and `DOMAINS.md`. Neither exists in the repo. Either re-create them, point CLAUDE.md at the wiki ([[index]]), or remove the references.
- **2026-04-18** — Many [[decisions/index|Decision]] articles are marked "derived from code analysis." Are there PRDs/RFCs that should be dropped into `wiki/inputs/` so `/repo-wiki-compile` can enrich them with authoritative context?
- **2026-04-18** — Threshold constants in [[planning-domain]] (FAR=80px, MEDIUM=150px, hysteresis=5px) are tuned but the rationale isn't documented. Worth an interview pass to capture *why* these values vs neighbors.
- **2026-04-18** — Proxy generator priority is "FIFO today, scheduler later" ([[gotchas/proxy-priority-not-honored]]). Is the priority scheduler scheduled, or has the team decided FIFO is fine indefinitely?
- **2026-04-18** — [[decisions/temporal-runway-not-implemented]] is recorded as "won't implement" — but does that decision still hold? Worth a re-check after any plate-FPS or scrubbing UX feedback.

## Resolved

(empty — items move here when answered, with a link to the answering article or commit)
