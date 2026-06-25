---
type: Decision
title: "CpuCache as Sole Fetch Path"
description: "After S5 (PRD #378 / project memory entry project_cpu_cache_s1s2.md), CpuCache (lucida-web/src/pipeline/fetch/cpuCache.ts) is the only path through which chunks are fetched."
tags: [lucida, decision]
source_path: wiki/decisions/0008-cpu-cache-as-sole-fetch-path.md
created: 2026-04-18
modified: 2026-06-25
---

# CpuCache as Sole Fetch Path

## Decision

After S5 (PRD #378 / project memory entry `project_cpu_cache_s1s2.md`), `CpuCache` (`lucida-web/src/pipeline/fetch/cpuCache.ts`) is the **only** path through which chunks are fetched. The previous parallel path, `SharedChunkQueue`, was deleted entirely.

## Why

The two fetch paths fought each other:

- **Schedule conflicts.** Both wanted to decide what to fetch next; both consumed the same network bandwidth and decode pool. The interleaving was non-deterministic and produced fairness bugs (the queue starving the cache or vice versa).
- **Two LRU disciplines, one memory budget.** Each path tracked its own residents; their combined memory pressure exceeded any sane budget, and eviction in one didn't inform the other.
- **Two failure-handling regimes.** A failed fetch in the queue was independent of a failed fetch in the cache, so a chunk could fail twice for the same key.

Merging into one path resolved all three. The cache's **tiered LRU** (`prefetch → demoted-detail → active-detail → proxy → overview`) absorbs everything the queue used to do (eager prefetching = prefetch lane; demoted entities = demoted-detail).

## Tradeoffs

- **One bug ruins everything.** A bug in `cpuCache.ts` no longer has a fallback path. Tests in `cpuCache.test.ts` were prioritized for this reason — they cover the eviction tier ordering specifically.
- **Code surface concentrated.** The fetch path is dense, and future changes risk touching unrelated concerns. Mitigated two ways: the [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md)'s clear phase boundaries (`submit → schedule → decode → drain`), and the split of the path across `lucida-web/src/pipeline/fetch/` ([ADR 0032](0032-cpucache-split-into-pipeline-fetch.md)) so the once-monolithic cache no longer lives in a single file.

## How this decision shows up in code

- `lucida-web/src/pipeline/fetch/cpuCache.ts` — sole fetch path (the `fetch/` dir holds the rest of the split-out modules).
- `lucida-web/src/pipeline/tickCoordinator.ts::planAndFetch` — calls `cpuCache.onPlanRebuildStart()` once per cold-state rebuild and `cpuCache.submit(plan)` once per dataset.
- `lucida-web/src/pipeline/upload/uploader.ts::deliverToWorker` — feeds the GPU worker by walking `cpuCache.getDeliverable()`; this is the delivery-state extension captured in [Delivery state as a CpuCache sidecar](0037-delivery-state-as-cpucache-sidecar.md).
- No remaining references to `SharedChunkQueue` (deleted in S5).

## Related

- [CPU Cache](../systems/subsystems/cpu-cache.md)
- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md)
- [Planning Domain](../systems/subsystems/planning-domain.md) — produces the `RequestPlan` consumed by `submit`
