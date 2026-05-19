## Parent PRD

#672

## What to build

Replace the bridge renderer limitation with a clean source-backed coarse/detail
path behind the internal flag. A dataset with a valid source coarse level should
plan, fetch, upload, and render selected detail plus configured coarse even when
their chunk shapes differ.

## Acceptance criteria

- [ ] Planning emits exactly selected detail and configured coarse requests, with
      no implicit intermediate source LOD fallback and no coarse guessing.
- [ ] Single-image datasets and plate fields both schedule chunk-level coarse and
      detail; no field-proxy or well-proxy analog exists in the new path.
- [ ] Worker cold state represents explicit `detail` and `coarse` tier sources
      per rendered member.
- [ ] Worker pool routing keys include tier, dataset, channel, and chunk shape;
      arbitrary source coarse chunk shapes work.
- [ ] Shaders use clean detail/coarse chunk-tier bindings, not reused proxy
      binding slots or proxy descriptor names.
- [ ] Shader fallback is strict replacement: selected detail, then configured
      coarse, then blank; no blending and no proxy fallback on the new path.
- [ ] Slice mode maps full-res Z to detail and coarse level Z independently.
- [ ] WGSL/TypeScript descriptor layout locks cover the new tier-source shape.
- [ ] Tests cover mismatched detail/coarse chunk shapes, upload routing by tier,
      worker wanted-set behavior, strict fallback, and no proxy names/messages on
      the new path.

## Blocked by

- Blocked by #681

## User stories addressed

- User story 3
- User story 6
- User story 7
- User story 16
- User story 17
- User story 27
- User story 28
- User story 29

## Wiki context

- systems - [[systems/subsystems/planning-domain]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/worker-protocol]], [[systems/subsystems/gpu-residency]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0007-wasm-scene-as-source-of-truth]], [[decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0041-clean-two-source-chunk-tier-renderer]]
- gotchas - [[gotchas/wire-chunk-key-conventions]], [[gotchas/wasm-rebuild-after-rust-changes]]
