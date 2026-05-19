## Parent PRD

#672

## What to build

Make the generated coarse derived cache operationally durable: sidecar
manifest/readiness index, restart/reopen reconstruction, disk budget eviction,
and operator controls.

## Acceptance criteria

- [ ] Derived cache stores generated-level manifest/index plus deterministic
      atomic chunk files.
- [ ] Manifest records identity, provenance, geometry, output chunk grid, and
      generation config.
- [ ] Readiness index records ready chunk keys and status/failure metadata.
- [ ] Open/startup loads the index first and can scan/validate chunk files to
      rebuild if the index is missing or stale.
- [ ] Derived cache is authoritative across late join, reopen, and server
      restart; in-memory service state is only acceleration.
- [ ] Operator config controls generation enablement, global/per-dataset
      concurrency, background fill, coarse bounds, chunk byte/shape bounds,
      derived cache root/disk budget, and retry/backoff.
- [ ] Disk-budget eviction touches generated artifacts only, starts with whole
      generated-level identities, avoids active-session chunks unless under hard
      pressure, and atomically withdraws readiness when necessary.
- [ ] Tests cover restart recovery, stale index rebuild, corrupted chunk
      validation, cache budget eviction, readiness withdrawal, and source data
      untouched.

## Blocked by

- Blocked by #685

## User stories addressed

- User story 10
- User story 24
- User story 25
- User story 26
- User story 33

## Wiki context

- systems - [[systems/crates/lucida-server]], [[systems/crates/lucida-store]], [[flows/dataset-opening]]
- decisions - [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/oss-config-defaults]]
