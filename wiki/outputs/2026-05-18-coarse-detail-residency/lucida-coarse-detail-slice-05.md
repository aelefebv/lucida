## Parent PRD

#672

## What to build

Add viewer-interest-driven scheduling, reprioritization, and cancellation to coarse generation. The goal is that current visible work wins, stale scrubbed-away work can be interrupted, and background fill never blocks the user's current T/Z/channel interest.

The completed slice should make coarse generation responsive to pan/zoom, temporal scrubbing, Z scrubbing, and channel toggles while preserving bounded server concurrency and multi-client fairness.

## Acceptance criteria

- [ ] Clients send unsequenced viewer-interest hints with dataset id, current T/Z, visible channels, viewport or desired-soon coarse regions/keys, interaction mode, and an interest generation.
- [ ] The server aggregates active hints into scheduling priority without treating them as document state or readiness.
- [ ] A server-wide coarse generation service owns global concurrency, priority queues, cancellation tokens, viewer-interest registry, readiness state, and generated cache identity.
- [ ] Priority lanes admit current visible coarse work before predicted nearby/scrub work before background fill.
- [ ] Pan/zoom, T scrubbing, Z scrubbing, and channel toggles can reprioritize queued work.
- [ ] Stale running work can be canceled or preempted at generated coarse chunk boundaries, with large chunks checking cancellation internally between tile steps.
- [ ] Completed chunks are kept and partial writes are discarded.
- [ ] Multi-client scheduling uses fairness plus recency: newer interest supersedes older interest per client/dataset, conflicts round-robin within a lane, and idle/disconnected hints expire.
- [ ] Tests cover reprioritization, cancellation during T/Z scrubbing, background-fill disablement, multi-client fairness, and no held-open chunk fetches while generation runs.

## Blocked by

- Blocked by #676

## User stories addressed

- User story 12
- User story 13
- User story 14
- User story 15
- User story 23
- User story 31
- User story 32

## Wiki context

- systems - [[systems/subsystems/planning-domain]], [[queue]], [[systems/subsystems/cpu-cache]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]]
