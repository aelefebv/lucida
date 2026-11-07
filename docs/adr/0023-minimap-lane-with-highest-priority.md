# Minimap Lane with Highest Priority

Status: Accepted.

## Context

The minimap shows where the view sits in the whole dataset. It matters most right after a dataset opens, before the user has moved. It used to emit on the overview lane, the lowest priority, so it appeared after detail, proxy, and prefetch chunks, the opposite of its purpose.

## Decision

The minimap has its own planning lane at priority offset 0, ahead of every other lane (detail 500, proxy 1000, prefetch 1500, coarse 2400, in `lucida-web/src/pipeline/planning/config.ts`). Minimap requests emit at the offset directly, with no importance or distance terms, which mean nothing for a whole-dataset view. In the CPU cache, minimap chunks live in the overview store with the coarse lane, apart from the detail store's eviction ([0008](0008-cpu-cache-as-sole-fetch-path.md)). Minimap chunks are fetched first and detail churn does not evict them.

The top slot holds only while the pending seed set is small. Up to `MINIMAP_SEED_FAST_MAX_CHUNKS` (128) pending chunks, counted across every dataset because they all land in one fetch queue, the minimap rides offset 0, and the view waits a few seconds at most. Above that, as on a wide collection with tens of thousands of coarsest-level chunks, the whole set emits behind everything else in the plan, at `max(MINIMAP_SEED_BULK_LANE_OFFSET, highest emitted priority + 1)`. A constant offset alone cannot guarantee this, because importance and distance terms are unbounded and lane offsets are not bands. The minimap then fills as fetch slots free up.

## Rejected alternatives

- Keep the minimap on the overview lane. It loads last, after the user no longer needs to get oriented.
- Top priority with no cap. On a wide collection the seed set holds every fetch slot for tens of minutes while the visible view waits.

## Consequences

When a small dataset opens, the first second or so of fetch capacity goes to the minimap instead of detail, so the main view starts filling slightly later.
