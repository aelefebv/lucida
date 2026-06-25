---
type: Decision
title: "Coordinate-Frame Naming Discipline at the JS↔WASM Boundary"
description: "Two related naming conventions are adopted on the JS side of the planning subsystem:"
tags: [lucida, decision]
source_path: wiki/decisions/0030-coordinate-frame-naming-discipline.md
created: 2026-05-15
modified: 2026-06-25
---

# Coordinate-Frame Naming Discipline at the JS↔WASM Boundary

## Decision

Two related naming conventions are adopted on the JS side of the planning subsystem:

1. **Trailing frame-of-reference suffixes** on coordinate fields of the planning contract: `Vox` for voxel-space, `World` for world-space (post-LOD, post-spacing), `Px` for screen-space pixels.
2. **Named axis constants** for the TCZYX 5D layout, exported as `const Axis = { T: 0, C: 1, Z: 2, Y: 3, X: 4 } as const` from a new top-level `lucida-web/src/axes.ts`.

Both are applied JS-side only. Rust source naming (`pub centroid_world: [f64; 3]` in `lucida-core/src/query.rs`, `xy_bounds`, `sort_center`, etc.) stays untouched. The Rust→JS snake_case→camelCase translation in `pipeline/planning/snapshot.ts` is the seam where suffix application happens.

Cited [Principles — Planning Domain](../principles/planning.md#5-wasm-owns-truth-planning-consumes-a-snapshot) — the JS-side suffix discipline and axis constants clarify the JS↔WASM boundary without altering WASM's ownership of math. Principle 5 is about ownership of values, not naming.

## Concrete suffix renames

| Current | Frame | Renamed to |
|---|---|---|
| `BaseEntitySnapshot.position` | voxel | `layoutPositionVox` |
| `VisibleRegion.xyBounds` | voxel | `xyBoundsVox` |
| `VisibleRegion.zRange` | voxel | `zRangeVox` |
| `VisibleRegion.sortCenter` | voxel | `sortCenterVox` |

Already correct: `centroidWorld`, `projectedDiagonalPx`, `projectedAreaPx2`. Left as-is: `effectiveZoom: number` (a derived ratio, not a coordinate; `effectiveZoomPxPerVox` would be overkill for a scalar with a one-line doc).

## Why `layoutPositionVox`, not `positionVox`

The field is genuinely "the entity's placement position within the layout, in voxel coords," not its intrinsic spatial center (that's `centroidWorld`). The longer name surfaces a real distinction the codebase currently glosses over: `BaseEntitySnapshot` carries both a layout-grid coordinate (`layoutPositionVox`) and an intrinsic spatial center (`centroidWorld`), in *different* frames. Today only an inline comment hints at this; after the rename it's encoded in the field names.

## Why suffix discipline at the snapshot boundary, not on the Rust side

The Rust source is the canonical implementation of the projection / centroid / bounds math. Renaming Rust fields would touch `lucida-core`, the wire format (via serde), `lucida-store`, the CLI, the Python bindings — different review surface. The JS-side suffix discipline gives readers crisp frame information at the contract surface they actually consume, without the cost of a wire-format change.

## Why function-local variables are not renamed

Local vars (e.g., `centerX` / `centerY` / `centerZ` in `chunkDistanceFromCenter`) are visible within ~30 lines and the frame is obvious from the assignment expression. Renaming them adds noise without payoff. The discipline applies to the contract surface (interface fields), not to every spatial scalar in the codebase.

## How this decision shows up in code

- `lucida-web/src/axes.ts` — new top-level file with `Axis` namespace const.
- `lucida-web/src/pipeline/planning/types.ts` — `BaseEntitySnapshot.layoutPositionVox` (renamed); inline comment distinguishing it from `centroidWorld`.
- `lucida-web/src/pipeline/viewport.ts` — `xyBoundsVox`, `zRangeVox`, `sortCenterVox` (renamed).
- `lucida-web/src/pipeline/planning/snapshot.ts` — translation site applies suffixes during snake_case → camelCase conversion.
- `lucida-web/src/pipeline/tickCoordinator.ts` (formerly `orchestrator.ts`), `lucida-web/src/layoutBuilders.ts`, `pipeline/planning/chunks.ts`, `pipeline/planning/emit.ts`, and the top-level `lucida-web/src/minimapPath.ts` — magic axis indices replaced with `Axis.X` / `Axis.Y` / etc.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- [Planning Domain](../systems/subsystems/planning-domain.md) — subsystem article; refreshed for the new naming
- [`planning/index.ts` Split into Per-Concern Files](0029-planning-index-split-into-per-concern-files.md) — sister decision; same PRD
- [`validatePlanningInputs` as the Dev-Mode Boundary Check](0031-validate-planning-inputs-dev-mode-boundary-check.md) — sister decision; same PRD
- PRD #578 — the work item this ADR was created during
