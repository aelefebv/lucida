---
created: 2026-04-18
modified: 2026-04-18
---

# CpuCache as Sole Fetch Path

> **Note**: This decision article is derived from code analysis. The rationale is inferred. If you have authoritative context, run `/repo-wiki-update` to enrich it.

## Decision

After S5 (PRD #378 / project memory entry `project_cpu_cache_s1s2.md`), `CpuCache` (`lucida-web/src/pipeline/cpuCache.ts`) is the **only** path through which chunks are fetched. The previous parallel path, `SharedChunkQueue`, was deleted entirely.

## Why

The two fetch paths fought each other:

- **Schedule conflicts.** Both wanted to decide what to fetch next; both consumed the same network bandwidth and decode pool. The interleaving was non-deterministic and produced fairness bugs (the queue starving the cache or vice versa).
- **Two LRU disciplines, one memory budget.** Each path tracked its own residents; their combined memory pressure exceeded any sane budget, and eviction in one didn't inform the other.
- **Two failure-handling regimes.** A failed fetch in the queue was independent of a failed fetch in the cache, so a chunk could fail twice for the same key.

Merging into one path resolved all three. The cache's **tiered LRU** (`runway → demoted-detail → active-detail → proxy → overview`) absorbs everything the queue used to do (eager prefetching = runway; demoted entities = demoted-detail).

## Tradeoffs

- **One bug ruins everything.** A bug in `cpuCache.ts` no longer has a fallback path. Tests in `cpuCache.test.ts` were prioritized for this reason — they cover the eviction tier ordering specifically.
- **Code surface concentrated.** `cpuCache.ts` is large (~900 lines) and dense. Future changes risk touching unrelated concerns. Mitigated by the [[chunk-pipeline]]'s clear phase boundaries (`submit → schedule → decode → drain`).

## How this decision shows up in code

- `lucida-web/src/pipeline/cpuCache.ts` — sole fetch path.
- `lucida-web/src/pipeline/orchestrator.ts::planAndFetch` — calls `cpuCache.submit(plan)` once per dataset per tick; calls `cpuCache.drain(uploadBudget)` once per tick to feed the GPU worker.
- No remaining references to `SharedChunkQueue` (deleted in S5).
- The eviction tier discipline is documented in `CHUNK_PIPELINE.md` section 4c and in [[cpu-cache#eviction-tiers]].

## Related

- [[cpu-cache]]
- [[chunk-pipeline]]
- [[planning-domain]] — produces the `RequestPlan` consumed by `submit`
