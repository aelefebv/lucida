---
created: 2026-05-15
modified: 2026-05-15
---

# `validatePlanningInputs` as the Dev-Mode Boundary Check

## Decision

A new function `validatePlanningInputs(snapshot, state)` is added at `lucida-web/src/pipeline/planning/validate.ts`. It runs nine semantic-invariant checks against the planner's two inputs and throws an `Error` with a descriptive message naming the violated invariant on first failure.

It is called from `plan()` at function entry, gated by `import.meta.env.DEV`:

```ts
if (import.meta.env.DEV) validatePlanningInputs(snapshot, state);
```

Vite dead-code-eliminates the branch in production builds; the validator has zero runtime cost in shipped code.

Cited [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]] — the validator enforces both "explicit input" and "well-formed input" at the boundary the principle establishes. Producer bugs surface as crisp errors at the bug's origin rather than silent downstream wrongness.

## The nine checks

| # | Check |
|---|---|
| 1 | Every `FieldSnapshot.parentId` exists in `entities` AND refers to a `WellSnapshot`. |
| 2 | Every `entityId` is unique across `snapshot.entities`. |
| 3 | Every `imageId` is unique across `snapshot.entities`. |
| 4 | Every level on every entity has `shape.length === 5` and `chunk_shape.length === 5`. |
| 5 | `visibleRegion.xyBoundsVox` is a valid bbox; `zRangeVox` is non-negative. |
| 6 | Every `assetCatalog` proxy reference points to a known `imageId`. |
| 7 | Every `minimapPending` map key is a valid `imageId` from `snapshot.entities`. |
| 8 | `state.previousActiveSet` has no duplicates by `entityId`. |
| 9 | For each `state.previousActiveSet` entry whose `entityId` is present in `snapshot.entities`, the `kind` matches. |

Cost: O(N) in entities + O(L) in total levels for check 4. Cheap enough for dev-mode invocation on every `plan()` call.

## Why dev-mode-only

Dev-mode-only matches the validator's purpose: catch producer bugs at the boundary during development. Production has its own observability (telemetry, error reporting, the existing render-loop pipeline). Running the validator in production would add per-tick overhead for a check that's intended to be a developer-time guarantee, not a runtime guard. `import.meta.env.DEV` is Vite's standard primitive for this; the branch dead-code-eliminates in production builds.

## Why throw, not degrade

Throwing surfaces the bug at the call site. Degrading (catch + console.error + skip) would defeat the purpose: the validator's job is to fail loudly so the developer fixes the producer. Wrapping with try/catch inside `plan()` would hide the very signal the validator exists to deliver.

## Why a single combined function for snapshot and state

`plan()` always has both inputs; one call site is simpler than two. Each individual check is also exported as a named helper, so tests can exercise checks in isolation without invoking the composing function.

## Why disappeared `previousActiveSet` entries are NOT a violation

Entities can come and go across ticks (datasets opened/closed, layouts changed, selection shifts). The planner already handles disappeared entities gracefully — `buildPrevModeByWell` simply doesn't find them, and the well's mode decision proceeds without prior-mode context. Surfacing "an entity in `previousActiveSet` is no longer in `entities`" as a violation would generate false positives on every legitimate state transition.

## Why these specific nine checks (and not others)

The nine checks all correspond to producer-side invariants the type system can't express but the runtime depends on. Checks excluded for clarity:

- TypeScript-enforced shape (required fields, types) — already covered by the compiler.
- `selection.t < level.shape[Axis.T]` per level — too contextual; varies by which level is being requested.
- "Every entity has at least one level" — the empty-levels case is exercised today and the planner handles it gracefully; surfacing as a violation would be a behavioural change.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/validate.ts` — new file with nine check helpers + composing `validatePlanningInputs`.
- `lucida-web/src/pipeline/planning/validate.test.ts` — per-check coverage colocated.
- `lucida-web/src/pipeline/planning/plan.ts` — one-line DEV-gated call at function entry.

## Related

- [[principles/planning]] — the framework this decision lives within
- [[planning-domain]] — subsystem article; gains a "developer-mode validator" mention
- [[decisions/0029-planning-index-split-into-per-concern-files]] — sister decision; same PRD
- [[decisions/0030-coordinate-frame-naming-discipline]] — sister decision; same PRD
- PRD #578 — the work item this ADR was created during
