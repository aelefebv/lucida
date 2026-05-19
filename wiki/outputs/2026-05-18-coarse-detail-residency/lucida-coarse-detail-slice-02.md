## Parent PRD

#672

## What to build

Ship a source-backed coarse/detail rendering path behind an internal config flag. This slice should prove the end-to-end chunk-only model using datasets whose existing source pyramid already has a valid coarse level. Generated coarse is not required in this slice.

The completed slice should be demoable by opening a server-mediated dataset, selecting a source-backed coarse level, planning both detail and coarse chunk requests, fetching/decoding/uploading them through tier-aware messages, and rendering with fallback order detail -> coarse -> blank.

## Acceptance criteria

- [ ] Planning emits tier-labeled `detail` and `coarse` chunk requests, with detail using `detailLevelOverride ?? 0` and coarse using the image's coarse level.
- [ ] Planning consumes WASM-produced visibility/region data and keeps carry-forward state explicit.
- [ ] Single-image datasets and plates both use chunk-level coarse/detail scheduling; plates do not create field-proxy or well-proxy analogs.
- [ ] CPU cache, upload, and worker-protocol delivery types carry the tier label end to end.
- [ ] Worker cold state records explicit detail and coarse levels and routes each rendered member to independent detail/coarse residency state.
- [ ] Shader/descriptor fallback order is selected detail, then coarse, then blank.
- [ ] Proxy fallback remains available only outside the internal coarse/detail flag for bridge safety.
- [ ] Tests cover source-backed coarse/detail planning, upload message shape, worker wanted-set behavior, and shader/descriptor layout agreement.

## Blocked by

- Blocked by #673

## User stories addressed

- User story 3
- User story 6
- User story 7
- User story 8
- User story 15
- User story 16
- User story 26
- User story 29
- User story 30

## Wiki context

- systems - [[systems/subsystems/planning-domain]], [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/worker-protocol]], [[systems/subsystems/gpu-residency]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0007-wasm-scene-as-source-of-truth]], [[decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]], [[gotchas/wasm-rebuild-after-rust-changes]]
