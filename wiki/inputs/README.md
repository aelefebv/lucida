---
created: 2026-04-18
modified: 2026-04-18
---

# inputs/ — Read-Only Source Material

This directory holds source material that Lucida wiki skills compile *from*. Drop in any text-format reference document — RFCs, design docs, PR descriptions, meeting notes, exported Linear/GitHub tickets, slide-deck notes, transcripts.

## Conventions

- **Skills never modify files in this directory.** It's read-only as far as the wiki suite is concerned.
- File format is flexible: `.md`, `.txt`, `.pdf`, `.html` all work.
- Filename should hint at the content (e.g., `prd-378-worker-protocol.md`, `rfc-import-pipeline.md`, `meeting-2026-03-12-gpu-eviction.md`).
- When `repo-wiki-compile` folds an input into an article, it cites the source filename in the resulting article — that's the lightweight tracking mechanism.

## Suggested first additions for Lucida

If you're populating this directory, candidate sources include:

- The PRDs referenced in project memory: PRD #378 (Worker Protocol), PRD #383 (GPU Residency), PRD #393 (Shared Atlas Pools), PRD #148 (`lucida-store` redesign)
- Top-level repo docs that should eventually fold into the wiki: `ARCHITECTURE.md`, `DOMAINS.md`, `CHUNK_PIPELINE.md`, `GLOSSARY.md`
- Recent PR descriptions for in-flight refactors (chunk pipeline, planning domain, orchestrator)
- Any meeting notes or design discussions that don't currently live in the repo
