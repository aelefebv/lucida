---
created: 2026-04-18
modified: 2026-05-17
---

# Queue — Open Questions


Open architectural questions, areas to investigate, and decisions to revisit. Add items as they surface; resolve them via interview, decision article, or by closing them out as no-longer-relevant.

## Format

Each item is a short bullet. Add a date when raised. Link to an article or PR when resolved.

## Open

- **2026-04-18** — Many [[decisions/index|Decision]] articles were originally seeded by reading the code. Are there PRDs/RFCs that should be dropped into `wiki/inputs/` so a `/repo-wiki` compile pass can enrich them with authoritative context?
- **2026-04-18** — Threshold constants in [[planning-domain]] (FAR=80px, MEDIUM=150px, hysteresis=5px) are tuned but the rationale isn't documented. Worth an interview pass to capture *why* these values vs neighbors.
- **2026-04-18** — Proxy generator priority is "FIFO today, scheduler later" ([[gotchas/proxy-priority-not-honored]]). Is the priority scheduler scheduled, or has the team decided FIFO is fine indefinitely?
- **2026-04-18** — [[decisions/0010-temporal-runway-not-implemented]] is recorded as "won't implement" — but does that decision still hold? Worth a re-check after any plate-FPS or scrubbing UX feedback.
- **2026-05-07** — `decisions/0012-logging-conventions.md` is ~127 lines with code blocks longer than 3 lines, violating the article guardrails. Decide whether to compress (most of the "How to apply" section is operational guide content) or split it into a flow/system article plus a short ADR.
- **2026-05-07** — Three gotchas may be stale after recent commits and need a verify-and-update pass: [[gotchas/preexisting-ts-build-errors]] (27 errors cleared in `593eb8d` — likely fully stale), [[gotchas/blosc-support]] (decoder extended in `90a3dbc` for CZI 6D — may understate current support), [[gotchas/non-canonical-axes]] (`185c429` added explicit handling — may understate current behavior).
- **2026-05-07 / refined 2026-05-08** — Disabled-mode bookmark ownership. Originally framed as "auth cutover for `dev@local` bookmarks created pre-auth"; resolved-by-sequence (auth landed before bookmarks did, so production never sees `dev@local` rows). Refined open question: when `LUCIDA_AUTH=disabled` runs against a SQLite DB that already has bookmarks (e.g., a local dev clone of a prod backup), the disabled-extractor synthesizes a principal whose email may not match any real user — so PATCH/DELETE permission checks behave oddly. Decide policy if/when production ever runs disabled mode against a bookmark-bearing DB.
- **2026-05-07** — Undo/redo system (future scope, surfaced during saved-views grilling): proposed dedicated undo/redo for milestone events (dataset opened/removed, active layout changed) — *not* via browser back/forward + `pushState`. Saved-views feature deliberately uses `replaceState` only so back-button stays clean; an in-app undo/redo lives separately and would track milestone document/viewport mutations independently of URL state.
- **2026-05-17** — Single source of truth for stateful pipeline phases. PRD #640 moved delivery sent state into [[cpu-cache]]; after the shape settles, run a follow-up INTERVIEW pass to decide whether this should become a general principle across planning/fetch/upload/render boundaries.

## Resolved

- **2026-05-07 → 2026-05-08** — `selectedDatasetId` wrinkle at saved-view apply. Resolved (c): auto-select the first visible dataset on apply so dimension/contrast side-panel controls operate on something the recipient can see. Implemented as a post-apply listener on `SavedViewApplier` that reads visibility from the freshly-applied `dataset_settings` (in `dataset_order`), with `useSavedViewSync` forwarding the first-visible id up to App.tsx which calls `setSelectedDatasetId`. Rationale: (a) accept-the-wrinkle is a regression versus today's behaviour where `selectedDatasetId` always points at *something visible*; (b) including it in the capture record bloats the schema for a UI-focus value with no pixel impact; (c) is simple, deterministic, and matches user expectation. See PR for slice 3 (will be filled by reviewer).
- **2026-04-18 → 2026-04-19** — `CLAUDE.md` references to missing `ARCHITECTURE.md` / `DOMAINS.md` / `GLOSSARY.md`. Related wiki references (`CLAUDE.md`, `inputs/README.md`) also corrected.
- **2026-04-19** — `is_document_command()` referenced in 3 wiki articles as if it still gates the wire path. Resolved: function doesn't exist in code; wiki rewritten to describe the actual gate (`applyDocumentCommand`/`applyViewportCommand` call-site discipline + disjoint Rust enums). Affected: [[lucida-web]], [[presence-and-follow-mode]], [[decisions/0001-document-vs-viewport-split]].
- **2026-04-19** — "`Scene::apply` is the only mutation path" overstated as a type-system invariant. Resolved: helpers (`register_dataset`, `remove_dataset`, `ensure_channel`) are also `pub fn (&mut self)`; wiki claims qualified to "conventional mutation path, enforced by review." Affected: [[scene-state-and-epochs]], [[lucida-core]].
- **2026-05-07** — Decision articles used slug-style filenames; the updated `/repo-wiki` skill mandates numbered ADRs. Resolved: all 12 decisions renumbered `0001-…` through `0012-…`; cross-references updated wiki-wide; the per-article "derived from code analysis" preamble (which referenced the now-defunct `/repo-wiki-update` slug) was removed and the disclaimer moved to `decisions/index.md`.
