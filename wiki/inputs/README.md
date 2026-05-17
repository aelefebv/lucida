---
created: 2026-04-18
modified: 2026-05-07
---

# inputs/ — Read-Only Source Material

This directory holds source material that the `/repo-wiki` compile pass reads *from*. Drop in any text-format reference document — RFCs, design docs, PR descriptions, meeting notes, exported Linear/GitHub tickets, slide-deck notes, transcripts.

## Conventions

- **The wiki skill never modifies files in this directory.** It's read-only as far as the suite is concerned.
- File format is flexible: `.md`, `.txt`, `.pdf`, `.html` all work.
- Filename should hint at the content (e.g., `prd-378-worker-protocol.md`, `rfc-import-pipeline.md`, `meeting-2026-03-12-gpu-eviction.md`).
- When the compile pass folds an input into an article, it cites the source filename in the resulting article via a `<!-- compiled from inputs/{filename} -->` comment — that's the lightweight tracking mechanism.

## Suggested first additions for Lucida

If you're populating this directory, candidate sources include:

- The PRDs referenced in project memory: PRD #378 (Worker Protocol), PRD #383 (GPU Residency), PRD #393 (Shared Atlas Pools), PRD #148 (`lucida-store` redesign)
- Recent PR descriptions for in-flight refactors (chunk pipeline, planning domain, orchestrator)
- Any meeting notes or design discussions that don't currently live in the repo
