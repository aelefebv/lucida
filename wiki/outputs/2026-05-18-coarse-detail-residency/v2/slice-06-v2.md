## Parent PRD

#672

## What to build

Add viewer-interest-driven scheduling to generated coarse. The server-wide
generation service should prioritize current visible chunks, reprioritize for
T/Z/channel/viewport changes, dedupe across clients, and cancel stale work at
safe boundaries.

## Acceptance criteria

- [ ] Clients send unsequenced advisory viewer-interest hints with client,
      dataset, generation, T/Z, channels, mode, viewport or desired keys,
      interaction mode, predicted keys, timestamp, and TTL.
- [ ] Hints are not document commands and do not affect saved views.
- [ ] Per-client latest interest replaces older interest; interest expires on
      TTL or disconnect.
- [ ] Multiple clients merge by lane; duplicate chunks take highest lane and
      caps/weighted admission prevent one client from dominating.
- [ ] Server-wide generation scheduling is fair across datasets/clients and
      strict-priority within a dataset: visible, predicted, background.
- [ ] Background fill is bounded, operator-tunable, and runs only when active
      visible/predicted work is absent or via configured trickle.
- [ ] Queued stale jobs are removed promptly; running jobs check cancellation at
      generated chunk or tile-step boundaries.
- [ ] Tests cover multi-client merge, dedupe, fairness, T/Z/channel
      reprioritization, background yielding, and cancellation.

## Blocked by

- Blocked by #685

## User stories addressed

- User story 13
- User story 14
- User story 15
- User story 16
- User story 21
- User story 24
- User story 31

## Wiki context

- systems - [[systems/crates/lucida-server]], [[systems/subsystems/planning-domain]], [[systems/subsystems/cpu-cache]]
- decisions - [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]]
