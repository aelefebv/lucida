---
type: Decision
title: "Discriminated Active-Set and Entity Types"
description: "ActiveSetEntry is a discriminated union of three variants — GroupAsProxyEntry | TileEntry | InvisibleEntry — discriminated by a top-level kind field."
tags: [lucida, decision]
source_path: wiki/decisions/0026-discriminated-active-set-and-entity-types.md
created: 2026-05-15
modified: 2026-07-06
---

# Discriminated Active-Set and Entity Types

## Decision

`ActiveSetEntry` is a discriminated union of three variants — `GroupAsProxyEntry | TileEntry | InvisibleEntry` — discriminated by a top-level `kind` field. The previous `mode` field narrows to `"tiles-with-proxy-fallback" | "tiles-with-detail"` and lives only inside `TileEntry`. The previous encoding of invisible entities as `mode: "tiles-with-detail"` is replaced by the dedicated `InvisibleEntry` variant.

`EntitySnapshot` is a discriminated union of three variants — `ImageSnapshot | GroupSnapshot | TileSnapshot` — discriminated by `kind`. `parentId: string` (non-null) lives only on `TileSnapshot`. Conservative form: `levels: LevelGeometry[]` is kept on all three variants.

Both extend [Principles — Planning Domain](../principles/planning.md#4-planning-is-pure-carry-forward-state-is-explicit) from "carry-forward state is explicit" to "per-variant invariants are compile-time enforced." The previous JSDoc-encoded invariants (e.g., "`group-as-proxy` entries have empty `imageId`," "Tile entries always have a `parentId`") are now type-system-enforced.

## Why three variants for active-set, not four

The two tile modes (`tiles-with-proxy-fallback`, `tiles-with-detail`) share enough shape — real LODs, real `imageId`, possible proxy — that splitting them into separate variants buys little. Their distinction stays in `mode` *inside* `TileEntry`. Splitting invisible from visible-detail (the conflated case in the previous flat shape) eliminates a real footgun where `if (entry.mode === "tiles-with-detail")` matched both cases.

## Why conservative form on `EntitySnapshot`

The aggressive form would strip `levels` from `GroupSnapshot` (group-as-proxy never iterates group chunks). That requires auditing every site that reads `entity.levels` to confirm groups never need their own geometry — a non-trivial dead-data audit. The conservative form delivers the compile-time `parentId` enforcement without that audit and leaves the aggressive form available for a future refactor if the dead-data question is ever resolved.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/types.ts` — `ActiveSetEntry` union and `EntitySnapshot` union (both re-exported through the `planning` barrel); the `make*Entry` constructors live in `planning/modes.ts` and return matching discriminated variants.
- All consumer sites (`pipeline/tickCoordinator.ts`, `pipeline/planning/debug.ts`, tests) narrow on `kind` before reading variant-specific fields.
- `groupMembers` and `buildPrevModeByGroup` simplify after the discrimination — no more `?? null` fallback on `parentId`.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- Planning Domain — subsystem article; refreshed for the new contract shape
- [`PlanningState` as the Carry-Forward Seam](0027-planning-state-as-the-carry-forward-seam.md) — sister decision; same PRD, same principle
- PRD #563 — the work item this ADR was created during
