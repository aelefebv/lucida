## Parent PRD

#672

## What to build

Add generated coarse metadata, per-chunk readiness, explicit statuses, and
source-aware chunk resolution without requiring a real generator yet. Seeded or
fake derived chunks should be enough to verify the server/client contract.

## Acceptance criteria

- [ ] Server binding state represents source levels plus generated derived
      levels and exposes merged client-visible metadata.
- [ ] Generated-level metadata can publish before chunks are ready.
- [ ] Readiness is tracked per chunk; level summaries are telemetry only.
- [ ] Chunk resolution dispatches source levels to source storage and generated
      levels to the derived cache.
- [ ] Generated chunk requests return `pending`, `unavailable`,
      `failed_transient`, `failed_permanent`, or ready bytes as appropriate.
- [ ] Pending does not enter client failure tracking or immediate retry loops;
      readiness deltas trigger normal re-request.
- [ ] Generated metadata/readiness deltas are server-authored runtime
      availability updates, not document commands or saved-view content.
- [ ] Readiness deltas broadcast to all session clients with the dataset open
      and are included/reconstructed for late joiners.
- [ ] Tests cover seeded ready chunks, pending/unavailable/failure statuses,
      deltas, late join, client re-request, and source-only direct paths.

## Blocked by

- Blocked by #681

## User stories addressed

- User story 9
- User story 12
- User story 20
- User story 21
- User story 31
- User story 33

## Wiki context

- systems - [[systems/crates/lucida-store]], [[systems/crates/lucida-server]], [[systems/subsystems/cpu-cache]], [[systems/subsystems/scene-state-and-epochs]], [[flows/dataset-opening]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0005-three-output-import-model]], [[decisions/0006-content-source-vs-fetch-source]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]], [[gotchas/non-canonical-axes]]
