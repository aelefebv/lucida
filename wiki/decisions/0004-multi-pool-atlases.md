---
created: 2026-04-18
modified: 2026-05-18
---

# Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)

Status: Superseded for the chunk-only coarse/detail path by
[[decisions/0039-chunk-only-coarse-detail-residency]]. Historical proxy-atlas
behavior remains documented here.

## Decision

The GPU's proxy atlas is split into **multiple pools**, keyed by `(datasetId, kind, slotDims, channel)`. Each pool has its own LRU eviction order. PRD #393 introduced this for plate FPS optimization.

Detail atlases (slice and volume) remain one-per-dataset with internal partitioning by entity-LOD; the multi-pool approach applies specifically to proxy atlases (`renderer/proxyAtlas.ts`).

## Why

A single pool with all proxies competing for slots produced two failure modes on plates:

1. **Channel ping-pong.** A multichannel plate with N visible channels would have N proxies per well. With M wells > pool capacity, channels evicted each other across frames — leading to constant churn and visible flicker.
2. **Slot-size fragmentation.** A pool with mixed slot dimensions (e.g. some 32³ proxies, some 64³) needed allocator gymnastics to pack efficiently. With a separate pool per slot size, allocation is trivial — fixed-size slots, 1D layout along X.

By keying on `(channel)`, channels stop fighting for shared capacity; by keying on `(slotDims)`, allocation stays simple; by keying on `(kind)`, well and field proxies don't compete.

## Tradeoff

- **More VRAM at peak.** N channels × M slot sizes × K kinds × D datasets = potentially many pools. Each pool reserves its capacity even if mostly empty. Acceptable because a typical plate has few channels (3) and few proxy kinds (2), so worst-case is bounded.
- **Per-pool eviction loses cross-pool LRU.** A globally LRU slot in pool A can't be reclaimed for a hot allocation in pool B. In practice, if you've sized pools to fit the workload this is fine; if you've under-sized one, it'll churn within itself.

## Alternatives considered (inferred)

- **One global pool with smart eviction.** The smart-eviction policy needed per-channel weights, per-kind weights, distance-from-viewport, etc. The complexity grew without bound. Splitting the pools made the eviction logic trivially correct.
- **Per-dataset single pool.** Better than fully shared but still suffered the channel ping-pong and slot-size fragmentation issues on plates with multiple channels.

## How this decision shows up in code

- `lucida-web/src/renderer/proxyAtlas.ts` — pool implementation. 64 slots per pool, 1D X-layout. Pure LRU within pool.
- `lucida-web/src/renderer/workerContext.ts` — allocates pools on demand keyed by `(datasetId, kind, slotDims, channel)`.
- The descriptor buffer's per-LOD info encodes which pool each proxy lives in (`fieldProxyPoolIndex`, `wellProxyPoolIndex`).

## Related

- [[gpu-residency]] — atlas architecture
- [[chunk-lifecycle]] — where the upload path consults pool capacity
- [[planning-domain]] — what generates the proxy demand
