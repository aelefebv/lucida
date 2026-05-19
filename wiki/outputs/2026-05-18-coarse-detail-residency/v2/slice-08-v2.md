## Parent PRD

#672

## What to build

Finish user and operator visibility for the new tier model: minimap separation,
coarse/generated status, sparse-detail messaging, and client/server telemetry.

## Acceptance criteria

- [ ] Minimap uses explicit coarse metadata and does not guess from the last
      source level.
- [ ] Minimap and main view may share decoded CPU coarse bytes but keep separate
      GPU residency and upload accounting.
- [ ] Sparse-detail notice/log appears after sustained low detail coverage due
      to budget or huge chunks and points to the explicit lower-detail control.
- [ ] Coarse status is visible in info/debug surfaces: available, pending,
      unavailable, failed.
- [ ] Client telemetry reports desired/resident chunks/bytes by tier,
      detail/coarse coverage, generated status counts, CPU/GPU bytes/evictions,
      per-tier queue depth, stale canceled/dropped counts, and sparse-detail
      notices.
- [ ] Server telemetry reports generated queues/running/completed/failed/
      canceled by lane, latency, dedupe/cache reuse, derived-cache bytes/
      evictions, readiness broadcasts, and fairness/backlog.
- [ ] Tests cover minimap separation, sparse notice conditions, generated status
      display, and telemetry counters.

## Blocked by

- Blocked by #682
- Blocked by #683
- Blocked by #684

## User stories addressed

- User story 4
- User story 5
- User story 18
- User story 19
- User story 26

## Wiki context

- systems - [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/gpu-residency]], [[systems/subsystems/planning-domain]], [[topics/rendering]]
- decisions - [[decisions/0023-minimap-lane-with-highest-priority]], [[decisions/0039-chunk-only-coarse-detail-residency]]
- gotchas - [[gotchas/minimap-render-key]], [[gotchas/upload-budgets-per-frame]]
