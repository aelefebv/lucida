---
type: Decision
title: "`cpuCache.ts` split into `pipeline/fetch/` modules"
description: "lucida-web/src/pipeline/cpuCache.ts (1627 lines, 35 fields, twelve responsibilities) is split into a new lucida-web/src/pipeline/fetch/ directory of focused modules."
tags: [lucida, decision]
source_path: wiki/decisions/0032-cpucache-split-into-pipeline-fetch.md
created: 2026-05-15
modified: 2026-06-25
---

# `cpuCache.ts` split into `pipeline/fetch/` modules

## Decision

`lucida-web/src/pipeline/cpuCache.ts` (1627 lines, 35 fields, twelve responsibilities) is split into a new `lucida-web/src/pipeline/fetch/` directory of focused modules. `cpuCache.ts` becomes a coordinator that fans out to extracted collaborators. (The original plan called it "thin (~250 lines)"; in practice the landed coordinator is ~1230 lines — the responsibilities fanned out into siblings but the coordinator did not shrink as far as projected.) The four pre-existing fetch/decode files (`cpuCache.ts`, `contentSource.ts`, `decodePool.ts`, `decode.worker.ts`) move into the directory together; new sibling modules extract the responsibilities that today live tangled inside `cpuCache.ts`.

The eleven sibling modules: `types.ts`, `cpuCache.ts` (coordinator), `chunkStore.ts`, `proxyStore.ts` (and possibly `overviewStore.ts` — see Slice 6 design Q), `eviction.ts`, `interactionMode.ts`, `scheduler.ts`, `retry.ts`, `telemetry.ts`, `rejection.ts`, `wireProtocol.ts`, plus the unchanged `contentSource.ts` / `decodePool.ts` / `decode.worker.ts`. `index.ts` is a barrel re-export so external consumers' import paths are unchanged.

## Why this shape

[CpuCache as Sole Fetch Path](0008-cpu-cache-as-sole-fetch-path.md) documented `cpuCache.ts` at "~900 lines and dense" with the mitigation being clear `submit → schedule → decode → drain` phase boundaries. The file has nearly doubled since then; the phase boundaries are no longer crisp inside it. Reading or modifying any one phase requires holding the whole god-object in your head.

The split mirrors [`planning/index.ts` Split into Per-Concern Files](0029-planning-index-split-into-per-concern-files.md) in shape: a single overgrown file becomes a directory of 100–500 LOC modules, with a thin coordinator on top, behaviour-preserving except for explicit named bug fixes. The two refactors are symmetric across the chunk pipeline (planning is upstream of fetch/decode); having matching shape on both halves makes the pipeline read as one consistent system rather than two unrelated styles.

## Why the integration test suite stays monolithic

`cpuCache.test.ts` (1427 LOC, 68 `it()` blocks) is excellent end-to-end coverage and serves as the safety net throughout the eleven slices. Splitting it into per-module test files would mean deciding which test belongs with which module — the same cognitive-load argument [`planning/index.ts` Split into Per-Concern Files](0029-planning-index-split-into-per-concern-files.md) used. Per-module unit tests are added alongside each extracted module; existing integration tests stay put.

The four `adaptive eviction` tests are an exception: they migrate to `interactionMode.test.ts` in Slice 3 because they become *pure* (no cache instance needed) once the detector is extracted. Tests that lift cleanly into a new pure module follow the module out; tests that need integration scaffolding stay in `cpuCache.test.ts`.

## Why bug fixes ride along inside slices

Two latent bugs were surfaced by the eight-pass dechaos analysis:

1. `ProxiedContentSource.imageWireFormats` is never cleared on dataset removal (long-session leak).
2. `fetchAndDecode` classifies "no wire format registered" as transient rather than permanent (one wasted retry on a setup bug).

Each fix is one or two lines once the surrounding structure exists. Pulling them into separate PRs would either land them speculatively (before the structure that makes them obvious) or duplicate the structural work in the bug-fix PR. They land inside the slice that surfaces them: leak fix in Slice 4 (Telemetry + lifecycle), classification fix in Slice 8 (typed `FetchError`).

## Why two parallel `Scheduler` instances, not one

Slice 7 lands two `Scheduler` instances on `CpuCache` (`chunkScheduler`, `proxyScheduler`) rather than unifying them. Chunks have decode + retry + failure-map; proxies have none of those. The shapes are similar enough to suggest unification but the semantics diverge enough that a `Scheduler<Req, Result>` would be a hollow generic.

Unification is captured as deferred Slice 12 — landed only when a third asset kind appears or the duplication actively bites a feature. The deferral matches the spirit of [ContentSource (JS) vs FetchSource (wire)](0006-content-source-vs-fetch-source.md) (two near-identical names for related-but-distinct concepts; the alternative — one shared name — was worse).

## How this decision shows up in code

- `lucida-web/src/pipeline/fetch/` — the new directory.
- `lucida-web/src/pipeline/fetch/cpuCache.ts` — the coordinator after Slices 3–10 land (~1230 LOC as landed, not the ~250 originally projected).
- `lucida-web/src/pipeline/fetch/index.ts` — barrel re-export of the public surface.
- The eleven sibling modules listed above.
- `lucida-web/src/pipeline/fetch/cpuCache.test.ts` — preserved integration suite, plus the migrated `adaptive eviction` tests removed.
- New per-module test files (`scheduler.test.ts`, `eviction.test.ts`, `telemetry.test.ts`, `retry.test.ts`, `wireProtocol.test.ts`, `interactionMode.test.ts`, `contentSource.test.ts`, `decode.worker.test.ts`, `rejection.test.ts`, `chunkStore.test.ts`).

## Related

- [CpuCache as Sole Fetch Path](0008-cpu-cache-as-sole-fetch-path.md) — earlier ADR; documented the file at ~900 lines pre-growth
- [`planning/index.ts` Split into Per-Concern Files](0029-planning-index-split-into-per-concern-files.md) — sister-refactor pattern on the upstream half of the chunk pipeline
- [ContentSource (JS) vs FetchSource (wire)](0006-content-source-vs-fetch-source.md) — context for the `ContentSource` type and the chunk/proxy duplication-vs-unification trade-off
- CPU Cache — subsystem article (refreshed in Phase 5 after the refactor ships)
- Flow: Chunk Lifecycle — overarching pipeline architecture
- PRD #592 — the work item this ADR was created during
