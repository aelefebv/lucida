## Parent PRD

#672

## What to build

Backfill end-to-end coverage, migration checks, and wiki current-state updates for the completed coarse/detail residency system. This slice should verify the integrated behavior after the implementation slices have landed and make the repo documentation match the new runtime model.

The completed slice should give maintainers confidence that old saved views still load, server-mediated datasets exercise generated coarse normally, proxy fallback is no longer the documented/default path, and future contributors can find the right architecture notes.

## Acceptance criteria

- [ ] End-to-end coverage opens a server-mediated dataset, observes source plus cached generated levels in dataset-open state, receives generated readiness deltas, requests generated chunks through the normal chunk path, and reopens to confirm reuse.
- [ ] Compatibility coverage loads old settings JSON and old saved views without detail overrides.
- [ ] Coverage verifies explicit detail overrides persist through saved views and stale overrides clamp safely.
- [ ] Coverage verifies pending generated chunks do not enter chunk failure tracking and become retrievable after readiness.
- [ ] Coverage verifies the default path does not emit proxy catalogs, proxy requests, proxy uploads, or proxy planning modes.
- [ ] Wiki pages for planning, CPU cache, upload pipeline, worker protocol, GPU residency, minimap, dataset opening, and chunk lifecycle describe coarse/detail as the current model.
- [ ] Proxy-generation docs are retired, archived, or clearly marked as historical.
- [ ] The PRD and ADR links are present from the relevant wiki pages and decision index.

## Blocked by

- Blocked by #679

## User stories addressed

- User story 1
- User story 2
- User story 3
- User story 6
- User story 9
- User story 10
- User story 19
- User story 20
- User story 21
- User story 22
- User story 25
- User story 34

## Wiki context

- systems - [[systems/index]], [[systems/subsystems/planning-domain]], [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/worker-protocol]], [[systems/subsystems/gpu-residency]], [[flows/dataset-opening]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wasm-rebuild-after-rust-changes]], [[gotchas/wire-chunk-key-conventions]]
