# `PlanningState` as the Carry-Forward Seam

Status: Accepted.

## Context

Planning is a pure function of a snapshot, and state that carries from one tick to the next is an explicit input and output ([intention](../../intention.md)). The previous tick's active set, which the planner needs, used to ride inside `PlanningSnapshot`, mixing the world this tick with what crossed over from the last one.

## Decision

`PlanningState` (`lucida-web/src/pipeline/planning/types.ts`) holds everything that survives across ticks. The signature is `plan(snapshot, state, config)`: the world this tick, what carried over, and the tunables. `RequestPlan` returns `nextState`. The caller stores that value per dataset and passes it back on the next tick without reading or building its contents. `initialPlanningState()` gives the state before the first plan.

New carry-forward state goes in `PlanningState`, never in the snapshot, a module global, or a cache inside the planner. The seam has absorbed growth as intended. Beside `previousActiveSet` it now carries the previous effective zoom and the last zoom direction, which the prefetch lane reads, with no change to callers.

## Rejected alternatives

- Keep the state as a field on `PlanningSnapshot`. It blurs the snapshot's contract, and every new field changes it.
- Callers derive the next state from the result (`{ previousActiveSet: result.activeSet }`). Trivial for one field, but every new field would mean updating every caller. Returning `nextState` keeps state changes inside the planner.
