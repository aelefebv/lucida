---
type: Decision
title: "`planning/index.ts` Split into Per-Concern Files"
description: "lucida-web/src/pipeline/planning/index.ts (1695 lines) is split into 5 sibling files inside pipeline/planning/."
tags: [lucida, decision]
source_path: wiki/decisions/0029-planning-index-split-into-per-concern-files.md
created: 2026-05-15
modified: 2026-07-06
---

# `planning/index.ts` Split into Per-Concern Files

## Decision

`lucida-web/src/pipeline/planning/index.ts` (1695 lines) is split into 5 sibling files inside `pipeline/planning/`. `index.ts` becomes a barrel re-export so the public import path is unchanged.

| File | Approx. lines | Contents |
|---|---:|---|
| `types.ts` | ~460 | Every interface and type alias the planner produces or consumes. |
| `modes.ts` | ~355 | `chooseEntityMode`, `groupMembers`, `buildPrevModeByGroup`, `degradeForCatalog`, `assignModes`. |
| `chunks.ts` | ~390 | `chunkKey`, `chunkOutsideFrustum`, `chunkWorldDims`, `iterateChunks`, `iterateChunksAtLodRange`. |
| `emit.ts` | ~285 | `computePriority` + four `emit*Lane` helpers + `chunkDistanceFromCenter`. |
| `plan.ts` | ~105 | `plan()` itself. |

Cited [Principles — Planning Domain](../principles/planning.md#4-planning-is-pure-carry-forward-state-is-explicit) — splitting the planner core out of its support primitives sharpens the pure-function decomposition. `plan.ts` reads as the small composition it actually is; `types.ts` / `modes.ts` / `chunks.ts` / `emit.ts` are the supporting-cast modules whose purity is enforced by their lack of side effects.

## Why 5 files, not the 6 PRD-1 named

PRD-1's "Out of Scope" section listed six target files: `constants.ts`, `types.ts`, `modes.ts`, `chunks.ts`, `priority.ts`, `plan.ts`. The constants don't need their own file: they already live in `pipeline/planning/config.ts` (`FAR_THRESHOLD_PX`, `DETAIL_THRESHOLD_PX`, `HYSTERESIS_PX`, the lane offsets, the priority weights). What looked like a "constants section" in `index.ts` was just re-exports for back-compat. The real split is 5 files.

## Why `emit.ts`, not `priority.ts`

PRD-1 named the priority-related file `priority.ts`. After reading the actual contents, `computePriority` is one ~12-line helper; the bulk (~270 lines) is the four lane-emission functions (`emitMinimapLane`, `emitDetailLane`, `emitPrefetchLane`, `emitOverviewLane`) that all consume `computePriority`. The file's job is *emission* — priority is one input to it. `emit.ts` reads more honestly.

## Why `index.ts` as a barrel

Every external consumer of planning types and helpers (orchestrator, cpuCache, debug-derivation, tests, …) currently imports from `pipeline/planning/index.ts`. Making `index.ts` a barrel of re-exports preserves that public surface — the split touches only intra-module imports. No file outside `pipeline/planning/` needs to update its imports.

## Why `PROMOTE_THRESHOLD_PX` is dropped at the same time

`PROMOTE_THRESHOLD_PX` was a backwards-compat alias for `FAR_THRESHOLD_PX` introduced during PRD #545's threshold rename. The only remaining consumer is `planning.test.ts`, where it's used in one equivalence-with-`FAR_THRESHOLD_PX` assertion plus one comment. Splitting the file is the natural moment to drop the alias — the alias's whole purpose was to bridge the rename, and it has now bridged.

## Why tests are not split in the same slice

`planning.test.ts` (1900+ lines) could be split into `modes.test.ts` / `chunks.test.ts` / `emit.test.ts` / `plan.test.ts` to mirror the runtime split. Doing so means deciding which test belongs with which module — a separate cognitive load on top of the structural move, and one that risks masking the structural payoff with churn. Tests stay monolithic in this PRD; revisit if the test file becomes unwieldy.

## Note (since)

The 5-file split + barrel is intact, but the directory has grown since this ADR landed. The coarse/detail bridge ([Chunk-only coarse/detail residency](0039-chunk-only-coarse-detail-residency.md)) added `emit.ts::emitCoarseLane` (so `emit.ts` now holds **five** `emit*Lane` helpers, not four) and `modes.ts::assignCoarseDetailModes`. The directory also gained per-concern siblings beyond the original five: `config.ts`, `proxyResidency.ts`, `synthetic.ts`, `debug.ts`, `configStore.ts` (plus their `*.test.ts`). The barrel still re-exports the public surface.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/types.ts` / `modes.ts` / `chunks.ts` / `emit.ts` / `plan.ts` — new files containing the relocated symbols.
- `lucida-web/src/pipeline/planning/index.ts` — barrel re-exports only; no type/function/const definitions of its own.
- `lucida-web/src/pipeline/planning.test.ts` — uses `FAR_THRESHOLD_PX` directly; the `PROMOTE_THRESHOLD_PX` import and equivalence test are removed.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- [Planning Domain](../systems/subsystems/planning-domain.md) — subsystem article; refreshed for the new module layout
- [Coordinate-Frame Naming Discipline at the JS↔WASM Boundary](0030-coordinate-frame-naming-discipline.md) — sister decision; same PRD
- [`validatePlanningInputs` as the Dev-Mode Boundary Check](0031-validate-planning-inputs-dev-mode-boundary-check.md) — sister decision; same PRD
- PRD #578 — the work item this ADR was created during
