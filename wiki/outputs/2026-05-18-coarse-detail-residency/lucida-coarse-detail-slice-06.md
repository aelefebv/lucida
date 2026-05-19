## Parent PRD

#672

## What to build

Harden tier residency budgets, minimap use of coarse, elastic transfer capacity, telemetry, and sparse-detail user feedback. This slice turns the coarse/detail path from a working MVP into a bounded, diagnosable viewer experience.

The completed slice should make it clear when high-resolution detail is sparse because chunks are large or budgets are tight, while keeping coarse context protected and minimap behavior independent from the main view.

## Acceptance criteria

- [ ] Coarse and detail have separate CPU cache buckets and separate GPU residency buckets so they cannot evict each other.
- [ ] Tier buckets may contain multiple internal stores/atlases/pools when dimensions, channels, or device limits require it.
- [ ] Memory buckets remain fixed/non-borrowable for this PRD, while fetch/decode/upload capacity can shift elastically to whichever tier has work.
- [ ] Detail LOD is not auto-lowered under pressure; pressure changes spatial coverage/eviction order and surfaces feedback instead.
- [ ] Main renderer and minimap may share coarse CPU chunks but keep separate GPU/upload residency.
- [ ] Minimap uses the explicit coarse level pointer rather than assuming `levels.length - 1`.
- [ ] Telemetry exposes desired versus resident coarse/detail chunks and bytes, budget pressure, generated coarse pending/ready state, and budget-driven sparse detail.
- [ ] A passive sparse-detail notice/log appears after a grace period when high-res coverage is sparse due to huge chunks or budget pressure, and offers the lower-detail control as the direct next action.
- [ ] Tests cover no cross-tier eviction, elastic transfer capacity, minimap coarse selection, telemetry counters, and sparse-detail notice conditions.

## Blocked by

- Blocked by #674
- Blocked by #676
- Blocked by #677

## User stories addressed

- User story 4
- User story 5
- User story 17
- User story 18
- User story 24
- User story 27
- User story 28

## Wiki context

- systems - [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/gpu-residency]], [[systems/subsystems/planning-domain]], [[topics/rendering]]
- decisions - [[decisions/0023-minimap-lane-with-highest-priority]], [[decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]]
