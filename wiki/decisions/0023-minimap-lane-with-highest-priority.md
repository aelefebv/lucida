---
type: Decision
title: "Minimap Lane with Highest Priority"
description: "The minimap is its own dedicated planning lane (MINIMAP) with priority offset 0 — the highest priority in the system."
tags: [lucida, decision]
source_path: wiki/decisions/0023-minimap-lane-with-highest-priority.md
created: 2026-05-14
modified: 2026-07-08
---

# Minimap Lane with Highest Priority

## Decision

The minimap is its own dedicated planning lane (`MINIMAP`) with priority offset `0` — the highest priority in the system. All other lane offsets are renumbered upward to make room: `DETAIL=500`, `PROXY=1000`, `PREFETCH=1500`, `OVERVIEW=2500`. Minimap chunks emit with `priority = MINIMAP_LANE_OFFSET` directly, bypassing the importance-and-distance terms (those have no meaning for per-dataset chunks).

The CPU cache routes `lane: "minimap"` to the existing overview eviction tier (most-protected). Combined effect: minimap chunks are fetched first and evicted last.

## Why

The minimap exists to give the user immediate spatial context — "where am I in the whole sample?" — which is most valuable on dataset open, before they've started navigating. The previous implementation emitted minimap requests at priority `2000` (the OVERVIEW lane), which is the *lowest* priority in the system. On dataset open, the minimap appeared *after* detail, proxy, and prefetch chunks — the opposite of its purpose.

Promoting minimap to the highest priority honors [Principles — Planning Domain](../principles/planning.md#1-visual-smoothness-over-fetch-optimality) (the user's first impression of a dataset is shaped by what loads first; spatial context is part of smoothness) and [Principles — Planning Domain](../principles/planning.md#6-anticipate-the-users-likely-next-gesture) (the most likely first action after opening a dataset is "look around" — minimap supports that immediately).

The starvation risk on initial load is bounded: minimap chunks are small (~16 chunks for a typical collection at the coarsest LOD). The window where minimap competes with detail is one to two seconds, after which the cache holds the minimap and detail fetches resume unimpeded.

## Tradeoffs

- **Behavioural change.** On dataset open, the user sees a minimap appear within ~1 second instead of after everything else loads. This is intentional and aligned with the minimap's purpose, but it is a visible difference from the previous shipping behaviour. Called out in PRD #545.
- **Detail starvation window.** During the initial ~1 second, fetch capacity is consumed by minimap chunks rather than detail. The detail viewport may feel slower to populate on the very first dataset open. Acceptable because the window is short and bounded.
- **One more lane in the system.** The lane count grows from four to five. The Pass 6 anti-recommendation against speculative lane proliferation does not apply here — this is a specific named lane for a specific real producer, not generic extension.

> Note (since): a sixth lane has been added — `COARSE_LANE_OFFSET = 2400` for the coarse/detail path — so the "four → five lanes" framing above is now six in the live code (`pipeline/planning/config.ts`).

> Note (since): the top placement is conditional on the seed set actually being small — the bounded-starvation premise in "Why" (~16 chunks, one-to-two seconds). A wide collection's whole-collection seed set is tens of thousands of coarsest chunks; at top priority that holds every fetch slot for tens of minutes while the visible band waits. Above `MINIMAP_SEED_FAST_MAX_CHUNKS` pending chunks (counted over the whole pending map — the fetch queue the demand lands in is shared), the planner emits the whole set strictly behind every other request in the plan: `max(MINIMAP_SEED_BULK_LANE_OFFSET = 2600, highest emitted priority + 1)`. A constant offset alone is not enough — lane offsets are not bands, because the priority formula's importance/distance terms are unbounded and a wide view's coarse/detail priorities run far past any constant. The minimap then fills opportunistically as slots free up. Small seed sets (this decision's actual case) keep the top lane unchanged.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/config.ts` — defines `MINIMAP_LANE_OFFSET = 0` alongside the renumbered other offsets (re-exported through the `planning` barrel).
- `lucida-web/src/pipeline/planning/emit.ts::emitMinimapLane` — enumerates minimap chunks from `snapshot.minimapPending`, emits with `priority = MINIMAP_LANE_OFFSET` directly.
- `lucida-web/src/pipeline/planning/snapshot.ts` — `minimapPending` is part of the planning snapshot input; the snapshot builder sources it from the tick coordinator.
- `lucida-web/src/pipeline/fetch/cpuCache.ts` — recognizes `lane: "minimap"` and routes those chunks to the overview eviction tier (the "ADR 0023" comment marks the spot).
- The tick coordinator's previous inline minimap injection is deleted.

## Related

- [Principles — Planning Domain](../principles/planning.md) — the framework this decision lives within
- Flow: Chunk Lifecycle — end-to-end trace; priority table updated to match
- Planning Domain — subsystem article; refreshed for the new lane
- CPU Cache — eviction tier mapping note
- PRD #545 — the work item this ADR was created during
