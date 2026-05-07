---
created: 2026-04-18
modified: 2026-05-07
---

# Now — Lucida Current State

Snapshot of what's active. Refresh via the `/repo-wiki` now pass after significant shifts.

## In flight

- **OME-Zarr expansion** — non-standard input handling (CZI 6D mosaics, `chunk_shape>1` on canonical-indexed `t`/`c`, non-canonical axes). Most recent work targets PRD #451. See [[lucida-store]]; touches [[gotchas/non-canonical-axes]] and [[gotchas/blosc-support]] (both may need refresh — see [[queue]]).
- **`lucida-store` redesign** — PRD #148, server-side chunk serving + storage abstraction.

## Recently shipped (since 2026-04-18)

- **OME-Zarr stack:** Blosc decoder + pinned-axis prefix slice for CZI 6D (`90a3dbc`); `lucida-store::codec` extraction with structured per-level binding seed and strict import validation (`b995ae6`); canonical-indexed `t`/`c` `chunk_shape>1` support (`c4be26c`); non-canonical axis handling (`185c429`); 1c manifest shape facts + anomaly check (`ef01e16`).
- **Instrumentation sweep:** planning ([[planning-domain]]) and CPU cache ([[cpu-cache]]) telemetry; debug overlays for chunkGrid + planning, now in 3D (`6b66140`); render-loop + upload-to-GPU telemetry; cold-state hit rate / cause attribution / churn log. Multiple DebugPanel tab rewrites ("Render", "Planning", "Logging").
- **Atlas-rejection resend storm fix** + `drain_waste` filterRatio redefinition (`8bd1c29`).
- **Y-flip in 3D voxel→world** + smarter active-detail eviction (`d8c11fd`).
- **27 pre-existing TS errors cleared** in `lucida-web` (`593eb8d`).
- **Logging conventions** doc refreshed (`cf074d6`); see [[decisions/0012-logging-conventions]] — still violates article guardrails ([[queue]]).
- **Wiki structural refactor** — numbered ADRs (`0001-…` through `0012-…`), `systems/{crates,subsystems}/` split, `topics/` layer added, glossary stub removed.

## Open questions

See [[queue]]. Key ones: PRDs to fold into `wiki/inputs/`, planning threshold rationale, [[decisions/0010-temporal-runway-not-implemented]] still holding, several gotchas may need refresh after recent OME-Zarr work and TS cleanup.

## Source material

- `CHUNK_PIPELINE.md` at repo root — long-form chunk-lifecycle authoritative trace; [[chunk-pipeline]] points at it.
- Project memory at `~/.claude/projects/-Users-austin-code-lucida/memory/MEMORY.md` carries pointers to recent project-state docs.
