---
created: 2026-05-15
modified: 2026-05-15
---

# `SceneEpochs` Rename and Relocation

## Decision

`PlanningEpochs` (previously in `lucida-web/src/pipeline/planning/index.ts`) is renamed to `SceneEpochs` and moves to a new file `lucida-web/src/pipeline/epochs.ts`. `VisibleRegion` (also previously in `planning/index.ts`) moves unchanged to a new file `lucida-web/src/pipeline/viewport.ts`. No backward-compatibility re-exports — every import site is updated cleanly.

Cited [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]] obliquely: type names and locations should reflect what the type *is*, not where it historically lived. `PlanningEpochs` only had the `Planning` prefix because the file it lived in was `planning.ts`; only one of its six fields (`request`) is planning-specific. The other fields (`content`, `layout`, `view`, `selection`, `asset`) are scene-state change counters that planning consumes but does not own.

## Why `SceneEpochs`, not `Epochs`

`Epochs` alone is too generic in a codebase that may host other epoch-like concepts (auth sessions, document versions, ...). `SceneEpochs` matches the existing wiki vocabulary ([[scene-state-and-epochs]]) and reads correctly: these are epochs that track scene-state changes that downstream subsystems consume.

## Why no compatibility shim

Re-exports add long-term cognitive noise — readers see two import paths for the same symbol and wonder which is canonical. The find-and-replace migration is mechanical (~11 import sites). PRD-1 left some compat re-exports for symbols moved within the planning module; this is a wider relocation across subsystem boundaries and warrants the cleaner cut.

## How this decision shows up in code

- `lucida-web/src/pipeline/epochs.ts` — new file, holds `SceneEpochs`.
- `lucida-web/src/pipeline/viewport.ts` — new file, holds `VisibleRegion`.
- `lucida-web/src/pipeline/planning/index.ts` — both type definitions removed; no re-export.
- All consumers (`renderLoop.ts`, `slicePath.ts`, `volumePath.ts`, `orchestrator.ts`, `planning/snapshot.ts`, `planning/debug.ts`, tests) import from the new homes.

## Related

- [[principles/planning]] — the framework this decision lives within
- [[scene-state-and-epochs]] — subsystem article; vocabulary source for the rename
- [[planning-domain]] — subsystem article; refreshed for the new type homes
- PRD #563 — the work item this ADR was created during
