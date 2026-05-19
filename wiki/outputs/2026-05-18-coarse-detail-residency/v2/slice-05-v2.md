## Parent PRD

#672

## What to build

Implement generated coarse materialization into Lucida's derived cache. When no
source coarse level fits, the server creates bounded per-image/per-field
generated chunks, publishes them atomically, and reuses them across reopen when
source identity and generation config match.

## Acceptance criteria

- [ ] Source coarse selection uses fit bounds before deciding generation is
      needed.
- [ ] Generated coarse uses nearest finer available source level above target
      resolution, with fallback to finer levels as needed.
- [ ] Output chunk shape is chosen by Lucida config and bounded by decoded bytes,
      scheduling granularity, target dimensions, and anisotropic Z policy.
- [ ] Generation is per canonical source image/field id and channel, not per
      parent well.
- [ ] Cache identity includes source content, image/field, input scope, output
      geometry/chunk shape/dtype, downsample algorithm/version, coarse config,
      generator version, and generated-level identity.
- [ ] Job dedupe key includes source content id, generated level id, image/field
      id, T, C, generated chunk key, and generation config id.
- [ ] Publish order is temp write, validation, flush/close where practical,
      atomic move, resolver-visible readiness, then client broadcast.
- [ ] Dataset open never waits for generation and source data is never mutated,
      including server-local file datasets.
- [ ] Tests cover generation from fake sources, source fit, output geometry,
      atomic publish, dedupe, reopen reuse, local source non-mutation, and
      permanent/transient failure recording.

## Blocked by

- Blocked by #684

## User stories addressed

- User story 9
- User story 10
- User story 11
- User story 24
- User story 25
- User story 31
- User story 32

## Wiki context

- systems - [[systems/crates/lucida-store]], [[systems/crates/lucida-server]], [[flows/dataset-opening]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0014-local-file-datasets-personal-only-in-saved-views]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/non-canonical-axes]], [[gotchas/wire-chunk-key-conventions]]
