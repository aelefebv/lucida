## Parent PRD

#672

## What to build

Backfill full integration coverage and update wiki documentation so the repo
describes coarse/detail as the current fallback model and proxy fallback as
historical or removed.

## Acceptance criteria

- [ ] End-to-end coverage opens a server-mediated dataset, observes source plus
      generated metadata, receives readiness deltas, requests generated chunks
      through normal chunk serving, and reopens to confirm reuse.
- [ ] Browser/GPU smoke covers mismatched detail/coarse chunk shapes with detail
      where present, coarse where missing, and no blank-canvas regression.
- [ ] Compatibility coverage loads old settings JSON and saved views without
      detail overrides.
- [ ] Coverage verifies explicit detail overrides persist and stale overrides
      clamp to source levels.
- [ ] Coverage verifies pending generated chunks do not enter failure tracking
      and become retrievable after readiness.
- [ ] Wiki pages for planning, CPU cache, upload pipeline, worker protocol, GPU
      residency, minimap, dataset opening, chunk lifecycle, and generated coarse
      describe the final model.
- [ ] Proxy-generation docs are deleted, archived, or clearly marked historical.
- [ ] ADR/index links point to PRD #672, ADR 0039, ADR 0040, and ADR 0041.

## Blocked by

- Blocked by #689

## User stories addressed

- User story 1
- User story 2
- User story 3
- User story 6
- User story 9
- User story 10
- User story 20
- User story 21
- User story 22
- User story 23
- User story 33
- User story 34

## Wiki context

- systems - [[systems/index]], [[systems/subsystems/planning-domain]], [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/worker-protocol]], [[systems/subsystems/gpu-residency]], [[flows/dataset-opening]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]], [[decisions/0041-clean-two-source-chunk-tier-renderer]]
- gotchas - [[gotchas/wasm-rebuild-after-rust-changes]], [[gotchas/wire-chunk-key-conventions]]
