---
type: Queue
title: "Queue — Open Questions"
description: "Open architectural questions, areas to investigate, and decisions to revisit."
tags: [lucida, queue]
source_path: wiki/queue.md
created: 2026-04-18
modified: 2026-07-04
---

# Queue — Open Questions


Open architectural questions, areas to investigate, and decisions to revisit. Add items as they surface; resolve them via interview, decision article, or by closing them out as no-longer-relevant.

## Format

Each item is a short bullet. Add a date when raised. Link to an article or PR when resolved.

## Open

- **2026-04-18** — Many [Decision](decisions/index.md) articles were originally seeded by reading the code. Are there PRDs/RFCs that should be dropped into `wiki/inputs/` so a `/repo-wiki` compile pass can enrich them with authoritative context?
- **2026-04-18** — Threshold constants in [Planning Domain](systems/subsystems/planning-domain.md) (FAR=80px, MEDIUM=150px, hysteresis=5px) are tuned but the rationale isn't documented. Worth an interview pass to capture *why* these values vs neighbors.
- **2026-04-18** — [GPU-Side Temporal Lookahead — Won't Implement](decisions/0010-temporal-runway-not-implemented.md) is recorded as "won't implement" — but does that decision still hold? Worth a re-check after any plate-FPS or scrubbing UX feedback.
- **2026-05-07** — `decisions/0012-logging-conventions.md` is ~127 lines with code blocks longer than 3 lines, violating the article guardrails. Decide whether to compress (most of the "How to apply" section is operational guide content) or split it into a flow/system article plus a short ADR.
- **2026-05-07** — Undo/redo system (future scope, surfaced during saved-views grilling): proposed dedicated undo/redo for milestone events (dataset opened/removed, active layout changed) — *not* via browser back/forward + `pushState`. Saved-views feature deliberately uses `replaceState` only so back-button stays clean; an in-app undo/redo lives separately and would track milestone document/viewport mutations independently of URL state.
- **2026-05-17** — Single source of truth for stateful pipeline phases. PRD #640 moved delivery sent state into [CPU Cache](systems/subsystems/cpu-cache.md); after the shape settles, run a follow-up INTERVIEW pass to decide whether this should become a general principle across planning/fetch/upload/render boundaries.
- **2026-05-26** — Windows CI deferred for [Canonical dataset URL form](decisions/0042-canonical-dataset-url-form.md) (PRD #703). Manual verification by the author at PR time while Windows usage is single-developer. Revisit when ≥2 Windows users hit a regression or when the `wasm-pack` / `pnpm` / `sqlite-bundled` / `blosc-codec` build matrices on Windows runners stop being unknown territory. Flipping on a `windows-latest` row in the existing `cargo test --workspace` job matrix is the planned shape.

## Resolved

- **2026-04-18 → 2026-07-04** — Proxy generator priority ("FIFO today, scheduler later", [Proxy Generator Priority Is Not Honored Yet](gotchas/proxy-priority-not-honored.md)). Resolved: the scheduler will never land — [Sunset dispositions for the three superseded server surfaces](decisions/0043-superseded-server-surfaces-sunset.md) (subject C) deletes the proxy fallback path, `ProxyGenerator` included; no supported configuration reaches the fallback end-to-end (the server flag defaults off and asset requests are rejected per-binding; the client side additionally takes a hidden debug-panel toggle).
- **2026-05-07 / refined 2026-05-08 → 2026-07-04** — Disabled-mode bookmark ownership (odd PATCH/DELETE permission checks when `LUCIDA_AUTH=disabled` runs against a bookmark-bearing DB). Resolved by subsumption: [Sunset dispositions for the three superseded server surfaces](decisions/0043-superseded-server-surfaces-sunset.md) (subject B) retires the bookmarks REST surface — no mutation endpoints, no ownership-check policy needed. Existing `bookmarks` rows stay in SQLite untouched, with a documented graft into `workspace_saved_views` for anyone who wants them back as workspace saved views.
- **2026-05-07 → 2026-06-10** — Three gotchas suspected stale after OME-Zarr and build cleanup were re-checked. [Pre-existing TS Build Errors (resolved)](gotchas/preexisting-ts-build-errors.md) is explicitly historical/resolved; [Blosc support is a deliberately narrow subset](gotchas/blosc-support.md) describes the current intentionally narrow Blosc1 + zstd subset and import-time rejection behavior; [Non-canonical axes are pinned to index 0](gotchas/non-canonical-axes.md) describes current pinned-axis and post-decode byte-slicing behavior. No open refresh item remains.
- **2026-05-07 → 2026-05-08** — `selectedDatasetId` wrinkle at saved-view apply. Resolved (c): auto-select the first visible dataset on apply so dimension/contrast side-panel controls operate on something the recipient can see. Implemented as a post-apply listener on `SavedViewApplier` that reads visibility from the freshly-applied `dataset_settings` (in `dataset_order`), with `useSavedViewSync` forwarding the first-visible id up to App.tsx which calls `setSelectedDatasetId`. Rationale: (a) accept-the-wrinkle is a regression versus today's behaviour where `selectedDatasetId` always points at *something visible*; (b) including it in the capture record bloats the schema for a UI-focus value with no pixel impact; (c) is simple, deterministic, and matches user expectation. See PR for slice 3 (will be filled by reviewer).
- **2026-04-18 → 2026-04-19** — `CLAUDE.md` references to missing `ARCHITECTURE.md` / `DOMAINS.md` / `GLOSSARY.md`. Related wiki references (`CLAUDE.md`, `inputs/README.md`) also corrected.
- **2026-04-19** — `is_document_command()` referenced in 3 wiki articles as if it still gates the wire path. Resolved: function doesn't exist in code; wiki rewritten to describe the actual gate (`applyDocumentCommand`/`applyViewportCommand` call-site discipline + disjoint Rust enums). Affected: [lucida-web](systems/crates/lucida-web.md), [Presence and Follow Mode](systems/subsystems/presence-and-follow-mode.md), [Document vs Viewport Command Split](decisions/0001-document-vs-viewport-split.md).
- **2026-04-19** — "`Scene::apply` is the only mutation path" overstated as a type-system invariant. Resolved: helpers (`register_dataset`, `remove_dataset`, `ensure_channel`) are also `pub fn (&mut self)`; wiki claims qualified to "conventional mutation path, enforced by review." Affected: [Scene State and Epochs](systems/subsystems/scene-state-and-epochs.md), [lucida-core](systems/crates/lucida-core.md).
- **2026-05-07** — Decision articles used slug-style filenames; the updated `/repo-wiki` skill mandates numbered ADRs. Resolved: all 12 decisions renumbered `0001-…` through `0012-…`; cross-references updated wiki-wide; the per-article "derived from code analysis" preamble (which referenced the now-defunct `/repo-wiki-update` slug) was removed and the disclaimer moved to `decisions/index.md`.
