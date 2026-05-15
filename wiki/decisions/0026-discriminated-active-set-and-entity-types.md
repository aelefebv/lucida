---
created: 2026-05-15
modified: 2026-05-15
---

# Discriminated Active-Set and Entity Types

## Decision

`ActiveSetEntry` is a discriminated union of three variants — `WellAsProxyEntry | FieldEntry | InvisibleEntry` — discriminated by a top-level `kind` field. The previous `mode` field narrows to `"fields-with-proxy-fallback" | "fields-with-detail"` and lives only inside `FieldEntry`. The previous encoding of invisible entities as `mode: "fields-with-detail"` is replaced by the dedicated `InvisibleEntry` variant.

`EntitySnapshot` is a discriminated union of three variants — `ImageSnapshot | WellSnapshot | FieldSnapshot` — discriminated by `kind`. `parentId: string` (non-null) lives only on `FieldSnapshot`. Conservative form: `levels: LevelGeometry[]` is kept on all three variants.

Both extend [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]] from "carry-forward state is explicit" to "per-variant invariants are compile-time enforced." The previous JSDoc-encoded invariants (e.g., "`well-as-proxy` entries have empty `imageId`," "Field entries always have a `parentId`") are now type-system-enforced.

## Why three variants for active-set, not four

The two field modes (`fields-with-proxy-fallback`, `fields-with-detail`) share enough shape — real LODs, real `imageId`, possible proxy — that splitting them into separate variants buys little. Their distinction stays in `mode` *inside* `FieldEntry`. Splitting invisible from visible-detail (the conflated case in the previous flat shape) eliminates a real footgun where `if (entry.mode === "fields-with-detail")` matched both cases.

## Why conservative form on `EntitySnapshot`

The aggressive form would strip `levels` from `WellSnapshot` (well-as-proxy never iterates well chunks). That requires auditing every site that reads `entity.levels` to confirm wells never need their own geometry — a non-trivial dead-data audit. The conservative form delivers the compile-time `parentId` enforcement without that audit and leaves the aggressive form available for a future refactor if the dead-data question is ever resolved.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/index.ts` — `ActiveSetEntry` union, `EntitySnapshot` union, `make*Entry` constructors return matching discriminated variants.
- All consumer sites (`pipeline/orchestrator.ts`, `pipeline/cpuCache.ts`, `pipeline/planning/debug.ts`, tests) narrow on `kind` before reading variant-specific fields.
- `groupByWell` and `buildPrevModeByWell` simplify after the discrimination — no more `?? null` fallback on `parentId`.

## Related

- [[principles/planning]] — the framework this decision lives within
- [[planning-domain]] — subsystem article; refreshed for the new contract shape
- [[decisions/0027-planning-state-as-the-carry-forward-seam]] — sister decision; same PRD, same principle
- PRD #563 — the work item this ADR was created during
