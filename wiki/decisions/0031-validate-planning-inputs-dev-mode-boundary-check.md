---
type: Decision
title: "`validatePlanningInputs` as the Dev-Mode Boundary Check"
description: "A new function validatePlanningInputs(snapshot, state) is added at lucida-web/src/pipeline/planning/validate.ts."
tags: [lucida, decision]
source_path: wiki/decisions/0031-validate-planning-inputs-dev-mode-boundary-check.md
created: 2026-05-15
modified: 2026-07-06
---

# `validatePlanningInputs` as the Dev-Mode Boundary Check

> **Post-ship updates (2026-05-15):**
> - **PR #587** withdrew check 6 (asset-catalog reference resolution) after a real-app trace surfaced a false positive. The catalog is flattened across all datasets the catalog has ever seen; the snapshot is for one dataset's current tick — they legitimately diverge. See "Checks 6 and 7 — withdrawn" below.
> - **PR #588** loosened check 9's `TileEntry` mapping to accept `kind: "Tile"` OR `kind: "Image"`. The planner's `groupMembers` synthesizes `__image__${entityId}` groups for `Image` entities (singletons, non-collection datasets), routing them through the same tile-mode code path; the active-set entry it produces is therefore a `TileEntry` even though the entity is an `ImageSnapshot`. Strict `TileEntry ⇒ Tile-only` was a misreading of the planner's actual semantics.
> - **PR #589** withdrew check 7 (minimapPending keys) as part of a proactive audit triggered by the pattern of two false positives in two production runs. Same root issue as check 6: producer scope (all dataset images) doesn't match snapshot scope (currently visible entities). The audit confirmed the remaining seven checks (1, 2, 3, 4, 5, 8, 9) are sound — each maps to an invariant the producer actually maintains.
> - The validator now runs **seven** checks; the original nine count (and the structure of the table below) is preserved for stable cross-references.

## Decision

A new function `validatePlanningInputs(snapshot, state)` is added at `lucida-web/src/pipeline/planning/validate.ts`. It runs nine semantic-invariant checks against the planner's two inputs and throws an `Error` with a descriptive message naming the violated invariant on first failure.

It is called from `plan()` at function entry, gated by `import.meta.env.DEV`:

```ts
if (import.meta.env.DEV) validatePlanningInputs(snapshot, state);
```

Vite dead-code-eliminates the branch in production builds; the validator has zero runtime cost in shipped code.

Cited [Principles — Planning Domain](../principles/planning.md#4-planning-is-pure-carry-forward-state-is-explicit) — the validator enforces both "explicit input" and "well-formed input" at the boundary the principle establishes. Producer bugs surface as crisp errors at the bug's origin rather than silent downstream wrongness.

## The nine checks

| # | Check |
|---|---|
| 1 | Every `TileSnapshot.parentId` exists in `entities` AND refers to a `GroupSnapshot`. |
| 2 | Every `entityId` is unique across `snapshot.entities`. |
| 3 | Every `imageId` is unique across `snapshot.entities`. |
| 4 | Every level on every entity has `shape.length === 5` and `chunk_shape.length === 5`. |
| 5 | `visibleRegion.xyBoundsVox` is a valid bbox; `zRangeVox` is non-negative. |
| ~~6~~ | ~~Every `assetCatalog` proxy reference points to a known `entityId`.~~ Withdrawn post-ship — see below. |
| ~~7~~ | ~~Every `minimapPending` map key is a valid `imageId` from `snapshot.entities`.~~ Withdrawn post-ship — see below. |
| 8 | `state.previousActiveSet` has no duplicates by `entityId`. |
| 9 | For each `state.previousActiveSet` entry whose `entityId` is present in `snapshot.entities`, the `kind` matches (`group-as-proxy` ⇒ `Group`; `tile` ⇒ `Tile` or `Image`; `invisible` ⇒ permissive). The `tile` ⇒ `Image` allowance reflects that singletons go through the tile code path via `groupMembers`. |

Cost: O(N) in entities + O(L) in total levels for check 4. Cheap enough for dev-mode invocation on every `plan()` call.

## Why dev-mode-only

Dev-mode-only matches the validator's purpose: catch producer bugs at the boundary during development. Production has its own observability (telemetry, error reporting, the existing render-loop pipeline). Running the validator in production would add per-tick overhead for a check that's intended to be a developer-time guarantee, not a runtime guard. `import.meta.env.DEV` is Vite's standard primitive for this; the branch dead-code-eliminates in production builds.

## Why throw, not degrade

Throwing surfaces the bug at the call site. Degrading (catch + console.error + skip) would defeat the purpose: the validator's job is to fail loudly so the developer fixes the producer. Wrapping with try/catch inside `plan()` would hide the very signal the validator exists to deliver.

## Why a single combined function for snapshot and state

`plan()` always has both inputs; one call site is simpler than two. Each individual check is also exported as a named helper, so tests can exercise checks in isolation without invoking the composing function.

## Why disappeared `previousActiveSet` entries are NOT a violation

Entities can come and go across ticks (datasets opened/closed, layouts changed, selection shifts). The planner already handles disappeared entities gracefully — `buildPrevModeByGroup` simply doesn't find them, and the group's mode decision proceeds without prior-mode context. Surfacing "an entity in `previousActiveSet` is no longer in `entities`" as a violation would generate false positives on every legitimate state transition.

## Why these specific nine checks (and not others)

The nine checks all correspond to producer-side invariants the type system can't express but the runtime depends on. Checks excluded for clarity:

- TypeScript-enforced shape (required fields, types) — already covered by the compiler.
- `selection.t < level.shape[Axis.T]` per level — too contextual; varies by which level is being requested.
- "Every entity has at least one level" — the empty-levels case is exercised today and the planner handles it gracefully; surfacing as a violation would be a behavioural change.

## Checks 6 and 7 — withdrawn

Both checks were withdrawn post-ship for the same root reason: **producer scope didn't match snapshot scope**.

### Check 6 — assetCatalog refs

The original "every `assetCatalog.byEntity` key must be a known `entityId` from `snapshot.entities`" check was withdrawn after PRD #578 / Slice 3 shipped, when a real-app trace produced `Error: validatePlanningInputs: assetCatalog references unknown entityId ds-b5a7a1d65f96a456:group:D/3` (thrown from `checkAssetCatalogRefs` via `plan()`).

Investigation traced the cause to a fundamental misreading of `AssetCatalogSnapshot`. The catalog is built by `pipeline/assetCatalog.ts::snapshot()`, which walks `byDataset` (every dataset the catalog has ever seen) and flattens entries into a single cross-dataset `byEntity` map. The planning snapshot, in contrast, carries `entities` for ONE dataset's current tick. The two will routinely diverge — the catalog can hold entries for entities not currently visible in this tick's snapshot, for entities of other datasets, or for entities of datasets that have since been closed.

Worse, production lookups go in the *opposite direction*: `degradeForCatalog` consults the catalog via per-id `assetCatalog.byEntity.get(entityId)` for entities already in the snapshot. Dangling catalog entries are never iterated and can never harm a tier choice.

The check was wrong both about which direction matters and about whether the two collections are coupled. It was withdrawn entirely, leaving a `// Check 6 withdrawn` comment in `validate.ts` so the surviving check numbers stay stable in cross-references.

### Check 7 — minimapPending keys

After check 6 + check 9 fixes had landed, a proactive audit traced each remaining check against its actual producer. Check 7 ("every `minimapPending` map key is a valid `imageId` from `snapshot.entities`") was withdrawn because `minimapPath.ts::tickMinimapOverview` populates `state.pendingFetch` by iterating ALL `dataset_images()` (every image in the dataset whose minimap chunks haven't been fully uploaded yet), keyed by `image_id`. `snapshot.entities` is the result of `view_query()` — only currently visible entities. The two routinely diverge — minimap pending coords for off-screen images are legitimate, and the planner gracefully no-ops on them (`emitMinimapLane` only walks images present in the active set).

The check would have fired on essentially every non-trivial dataset; it was withdrawn proactively before another production crash.

### The wider lesson

A runtime invariant that fires on first execution against real producer output is the right way to discover that the invariant was over-specified. The dev-mode posture made the discoveries fast and safe. After two false positives in two prod runs, an audit found a third over-specified check before it fired in production. The remaining seven checks (1, 2, 3, 4, 5, 8, 9) survived the audit — each maps to an invariant the producer actually maintains.

**Pattern**: when validating cross-component invariants at a boundary, check whether the producer's scope matches the snapshot's scope. If not, the invariant likely doesn't hold in production state.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/validate.ts` — seven check helpers + composing `validatePlanningInputs`. (Withdrawn checks 6 and 7 live only as comment blocks; no `checkAssetCatalogRefs` / `checkMinimapKeys` exports.)
- `lucida-web/src/pipeline/planning/validate.test.ts` — per-check coverage colocated.
- `lucida-web/src/pipeline/planning/plan.ts` — one-line DEV-gated call at function entry.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- Planning Domain — subsystem article; gains a "developer-mode validator" mention
- [`planning/index.ts` Split into Per-Concern Files](0029-planning-index-split-into-per-concern-files.md) — sister decision; same PRD
- [Coordinate-Frame Naming Discipline at the JS↔WASM Boundary](0030-coordinate-frame-naming-discipline.md) — sister decision; same PRD
- PRD #578 — the work item this ADR was created during
