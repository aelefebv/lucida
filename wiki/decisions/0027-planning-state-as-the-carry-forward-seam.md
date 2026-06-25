---
created: 2026-05-15
modified: 2026-06-25
---

# `PlanningState` as the Carry-Forward Seam

## Decision

`PlanningState` is a separate interface holding state that survives across planning ticks. v1 contains a single field (`previousActiveSet: ActiveSetEntry[]`), moved out of `PlanningSnapshot`. The `plan()` signature changes from `plan(snapshot, config?)` to `plan(snapshot, state, config?)`, and `RequestPlan` gains a `nextState: PlanningState` field. Callers store the opaque `nextState` pointer rather than deriving it.

Cited [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]] — the planning function's signature now distinguishes "the world this tick" (snapshot) from "what crossed from last tick" (state) from "the tunables" (config). The planner owns its state machine; callers plumb pointers.

## Why a one-field container today

The win isn't avoiding future churn; it's sharpening the planning contract. `plan(snapshot, state, config)` reads as a three-way decomposition that matches principle 4's framing better than the previous "snapshot-with-an-embedded-state-field" encoding. Future additions (per-well stickiness counters, anticipation hints from gesture history, the planner's own internal state machine) drop in without touching `PlanningSnapshot`'s contract.

## Why planner-returned `nextState` instead of caller-derived

Today `nextState = { previousActiveSet: result.activeSet }` would be a trivial derivation. But the moment a second carry-forward field is added, every caller would have to be updated to derive it. Returning `nextState` opaquely keeps the planner self-contained — the caller's responsibility shrinks to "store the pointer." Adding new state stays inside the planner.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/index.ts` — `PlanningState` interface, `plan()` accepts state and returns `nextState`.
- `lucida-web/src/pipeline/orchestrator.ts` — `previousActiveSet: Map<datasetId, ActiveSetEntry[]>` becomes `planningState: Map<datasetId, PlanningState>`; the post-`plan()` write site stores `result.nextState` instead of `result.activeSet`. (`orchestrator.ts` has since been renamed to `pipeline/tickCoordinator.ts`, which now owns this Map.)

## Related

- [[principles/planning]] — the framework this decision lives within
- [[planning-domain]] — subsystem article; refreshed for the new seam
- [[decisions/0026-discriminated-active-set-and-entity-types]] — sister decision; same PRD, same principle
- PRD #563 — the work item this ADR was created during
