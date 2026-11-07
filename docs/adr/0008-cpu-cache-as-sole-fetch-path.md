# CpuCache as Sole Fetch Path

Status: Accepted.

## Context

The web client once fetched chunks through two paths at once: `CpuCache`, and a separate `SharedChunkQueue` for eager prefetch and demoted entities. Both chose what to fetch next from the same network and decode pool, and their interleaving starved one or the other. Each tracked its own residents, so together they overran any memory budget, and eviction in one never informed the other. A chunk could also fail twice for the same key, once in each path.

## Decision

`CpuCache` (`lucida-web/src/pipeline/fetch/cpuCache.ts`) is the only path that fetches chunks. `SharedChunkQueue` is deleted. The tick coordinator hands each dataset's plan to `cpuCache.submit()`, and the uploader feeds the GPU worker from `cpuCache.getDeliverable()`.

The cache absorbs the queue's work through lanes and eviction tiers. Detail and prefetch chunks share a main store whose eviction walks the `prefetch`, `demoted-detail`, and `active-detail` tiers, in an order that depends on whether the user is panning or scrubbing. Minimap and coarse chunks live in a separate overview store with its own LRU ([0023](0023-minimap-lane-with-highest-priority.md)). Each store has one budget, and each key has one failure record.

A new kind of fetch demand becomes a lane or tier inside the cache, never a second fetcher beside it.

## Rejected alternatives

- Keep both paths and coordinate them. Shared scheduling, a shared budget, and shared failure state would rebuild one cache out of two halves.

## Consequences

A bug in the cache has no fallback path, so its tests concentrate on eviction-tier ordering.
