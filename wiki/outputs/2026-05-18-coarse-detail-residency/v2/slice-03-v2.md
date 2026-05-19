## Parent PRD

#672

## What to build

Implement the client-side cache and scheduling policy for the tiered renderer:
protected CPU minimums with elastic surplus, protected GPU residency, fixed
per-tier transfer allocations while both tiers have demand, and cancellation or
dropping of stale work at queued boundaries.

## Acceptance criteria

- [ ] CPU decoded-byte cache has protected coarse/detail minimums and elastic
      surplus borrowing; borrowed bytes evict first when the owner tier needs
      its budget.
- [ ] GPU coarse/detail residency cannot evict across tiers.
- [ ] Fetch/decode/upload gives coarse and detail standard allocations when both
      have requests; idle-tier capacity can be borrowed only when a tier has no
      demand.
- [ ] Tier lanes include visible and predicted work for both coarse and detail,
      plus bounded coarse background and off/tiny detail background.
- [ ] Prediction/reprioritization covers XY pan/zoom, T scrub, Z scrub, and
      channel changes for detail and coarse.
- [ ] Pending fetches, pending decodes, pending deliverables/uploads, and worker
      stale epoch checks drop or requeue stale work safely.
- [ ] Stale completed fetch/decode bytes may cache as demoted low-priority bytes
      but never upload while stale or evict protected current tiers.
- [ ] Tests cover protected minimums, idle borrowing, stale cancellation,
      demoted insertion, and per-tier queue/depth telemetry.

## Blocked by

- Blocked by #682

## User stories addressed

- User story 13
- User story 14
- User story 15
- User story 16
- User story 17
- User story 26
- User story 30

## Wiki context

- systems - [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/planning-domain]], [[systems/subsystems/gpu-residency]]
- decisions - [[decisions/0037-delivery-state-as-cpucache-sidecar]], [[decisions/0039-chunk-only-coarse-detail-residency]]
- gotchas - [[gotchas/upload-budgets-per-frame]], [[gotchas/worker-eviction-async-reporting]]
