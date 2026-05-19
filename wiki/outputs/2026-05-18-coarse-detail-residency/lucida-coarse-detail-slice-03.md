## Parent PRD

#672

## What to build

Add the metadata, protocol, and resolver path for generated coarse levels without requiring the full background generator to exist yet. This slice should allow the server to advertise derived coarse levels, resolve generated-level chunk keys against a derived cache, and tell clients when generated chunks are pending or ready.

The completed slice should be verifiable with seeded/fake derived chunks: dataset-open includes cached generated levels, later metadata/readiness deltas apply to the client scene, and normal chunk requests resolve source levels to source storage and generated levels to the derived cache.

## Acceptance criteria

- [ ] Server binding state can track source levels and generated derived levels separately while exposing merged client-visible metadata.
- [ ] Chunk resolution is source-aware: source levels resolve to source storage, generated levels resolve to the derived cache.
- [ ] Initial dataset-open state includes source metadata plus any already-cached generated-level metadata.
- [ ] Server-authored metadata/readiness deltas can add generated levels and per-chunk readiness after dataset open.
- [ ] Applying generated-level metadata/readiness deltas updates client scene metadata and bumps an asset/availability or planning epoch, not document content.
- [ ] Requests for pending generated chunks return an explicit non-error pending status; real misses return unavailable/error status.
- [ ] Clients clear in-flight fetch state on pending without recording a transient/permanent failure and re-request after readiness.
- [ ] Tests cover source versus derived resolution, pending versus unavailable responses, metadata delta application, and old clients/settings where generated metadata is absent.

## Blocked by

- Blocked by #673

## User stories addressed

- User story 19
- User story 20
- User story 25
- User story 30
- User story 33

## Wiki context

- systems - [[systems/crates/lucida-store]], [[systems/subsystems/scene-state-and-epochs]], [[systems/subsystems/cpu-cache]], [[flows/dataset-opening]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0005-three-output-import-model]], [[decisions/0006-content-source-vs-fetch-source]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]], [[gotchas/non-canonical-axes]]
