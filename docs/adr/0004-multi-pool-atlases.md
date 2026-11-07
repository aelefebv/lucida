# Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)

Status: Accepted for proxy atlases, which [0043](0043-superseded-server-surfaces-sunset.md) schedules for deletion. Chunk atlas pools are covered by [0061](0061-screen-chosen-target-level-with-resident-coarser-levels.md).

## Context

Proxies are small generated 3D textures, one per group or per tile, that stand in while detail loads. On collections, a single shared proxy atlas failed two ways. With several visible channels each group needs one proxy per channel, and when groups outnumbered slots, channels evicted each other frame to frame and the view flickered. Mixed slot sizes in one atlas also needed a packing allocator.

## Decision

Proxy atlases are split into pools keyed by `(datasetId, kind, slotDims, channel)` (`proxyPoolKey` in `lucida-web/src/renderer/proxyAtlas.ts`). Each pool has fixed-size slots and its own LRU order. Channels do not compete for each other's capacity, group and tile proxies do not compete, and allocation inside a pool is a free-list pop. The descriptor buffer records which pool holds each entity's tile proxy and group proxy.

Slots are packed in a 3D grid across the texture's X, Y, and Z axes. An X-only layout fit just 16 `128×128×1` tile proxies on devices where `maxTextureDimension3D` is 2048.

## Rejected alternatives

- One global pool with smarter eviction. The policy needed per-channel weights, per-kind weights, and distance from the viewport, and kept growing. Separate pools make eviction plain LRU.
- One pool per dataset. It still has channel ping-pong and mixed slot sizes on multichannel collections.

## Consequences

Each pool reserves its capacity even when mostly empty, so peak VRAM grows with channels × slot sizes × kinds × datasets. A typical collection has about three channels and two kinds, which keeps this bounded. Per-pool LRU also means a cold slot in one pool cannot be reclaimed for a hot allocation in another, so an undersized pool churns within itself.
