---
type: Decision
title: "Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)"
description: "Chunk-only coarse/detail residency."
tags: [lucida, decision]
source_path: wiki/decisions/0004-multi-pool-atlases.md
created: 2026-04-18
modified: 2026-07-06
---

# Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)

Status: Superseded for the chunk-only coarse/detail path by
[Chunk-only coarse/detail residency](0039-chunk-only-coarse-detail-residency.md). Historical proxy-atlas
behavior remains documented here.

## Decision

The GPU's proxy atlas is split into **multiple pools**, keyed by `(datasetId, kind, slotDims, channel)`. Each pool has its own LRU eviction order. PRD #393 introduced this for collection FPS optimization.

Detail atlases (slice and volume) remain one-per-dataset with internal partitioning by entity-LOD; the multi-pool approach applies specifically to proxy atlases (`renderer/proxyAtlas.ts`).

## Why

A single pool with all proxies competing for slots produced two failure modes on collections:

1. **Channel ping-pong.** A multichannel collection with N visible channels would have N proxies per group. With M groups > pool capacity, channels evicted each other across frames — leading to constant churn and visible flicker.
2. **Slot-size fragmentation.** A pool with mixed slot dimensions (e.g. some 32³ proxies, some 64³) needed allocator gymnastics to pack efficiently. With a separate pool per slot size, allocation is trivial — fixed-size slots, 1D layout along X.

By keying on `(channel)`, channels stop fighting for shared capacity; by keying on `(slotDims)`, allocation stays simple; by keying on `(kind)`, group and tile proxies don't compete.

## Tradeoff

- **More VRAM at peak.** N channels × M slot sizes × K kinds × D datasets = potentially many pools. Each pool reserves its capacity even if mostly empty. Acceptable because a typical collection has few channels (3) and few proxy kinds (2), so worst-case is bounded.
- **Per-pool eviction loses cross-pool LRU.** A globally LRU slot in pool A can't be reclaimed for a hot allocation in pool B. In practice, if you've sized pools to fit the workload this is fine; if you've under-sized one, it'll churn within itself.

## Alternatives considered (inferred)

- **One global pool with smart eviction.** The smart-eviction policy needed per-channel weights, per-kind weights, distance-from-viewport, etc. The complexity grew without bound. Splitting the pools made the eviction logic trivially correct.
- **Per-dataset single pool.** Better than fully shared but still suffered the channel ping-pong and slot-size fragmentation issues on collections with multiple channels.

## How this decision shows up in code

- `lucida-web/src/renderer/proxyAtlas.ts::createProxyAtlasPool` — pool implementation. Parameterized capacity, 3-D grid packing (tiled across the X/Y/Z texture axes). Pure LRU within pool. The 1-D X-only layout was abandoned because common tile proxies (e.g. `128×128×1`) fit only 16 slots on devices with `maxTextureDimension3D = 2048`.
- `lucida-web/src/renderer/workerContext.ts` — allocates pools on demand keyed by `(datasetId, kind, slotDims, channel)`.
- The descriptor buffer's per-LOD info encodes which pool each proxy lives in (`tileProxyPoolIndex`, `groupProxyPoolIndex`).

## Related

- GPU Residency — atlas architecture
- Flow: Chunk Lifecycle — where the upload path consults pool capacity
- Planning Domain — what generates the proxy demand
