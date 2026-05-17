---
created: 2026-05-14
modified: 2026-05-14
---

# Minimap Lane with Highest Priority

## Decision

The minimap is its own dedicated planning lane (`MINIMAP`) with priority offset `0` — the highest priority in the system. All other lane offsets are renumbered upward to make room: `DETAIL=500`, `PROXY=1000`, `PREFETCH=1500`, `OVERVIEW=2500`. Minimap chunks emit with `priority = MINIMAP_LANE_OFFSET` directly, bypassing the importance-and-distance terms (those have no meaning for per-dataset chunks).

The CPU cache routes `lane: "minimap"` to the existing overview eviction tier (most-protected). Combined effect: minimap chunks are fetched first and evicted last.

## Why

The minimap exists to give the user immediate spatial context — "where am I in the whole sample?" — which is most valuable on dataset open, before they've started navigating. The previous implementation emitted minimap requests at priority `2000` (the OVERVIEW lane), which is the *lowest* priority in the system. On dataset open, the minimap appeared *after* detail, proxy, and prefetch chunks — the opposite of its purpose.

Promoting minimap to the highest priority honors [[principles/planning#1-visual-smoothness-over-fetch-optimality]] (the user's first impression of a dataset is shaped by what loads first; spatial context is part of smoothness) and [[principles/planning#6-anticipate-the-users-likely-next-gesture]] (the most likely first action after opening a dataset is "look around" — minimap supports that immediately).

The starvation risk on initial load is bounded: minimap chunks are small (~16 chunks for a typical plate at the coarsest LOD). The window where minimap competes with detail is one to two seconds, after which the cache holds the minimap and detail fetches resume unimpeded.

## Tradeoffs

- **Behavioural change.** On dataset open, the user sees a minimap appear within ~1 second instead of after everything else loads. This is intentional and aligned with the minimap's purpose, but it is a visible difference from the previous shipping behaviour. Called out in PRD #545.
- **Detail starvation window.** During the initial ~1 second, fetch capacity is consumed by minimap chunks rather than detail. The detail viewport may feel slower to populate on the very first dataset open. Acceptable because the window is short and bounded.
- **One more lane in the system.** The lane count grows from four to five. The Pass 6 anti-recommendation against speculative lane proliferation does not apply here — this is a specific named lane for a specific real producer, not generic extension.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/index.ts` — exports `MINIMAP_LANE_OFFSET = 0` alongside the renumbered other offsets.
- `lucida-web/src/pipeline/planning/index.ts::emitMinimapLane` — enumerates minimap chunks from `snapshot.minimapPending`, emits with `priority = MINIMAP_LANE_OFFSET` directly.
- `lucida-web/src/pipeline/planning/snapshot.ts` — `minimapPending` is part of the planning snapshot input; the snapshot builder sources it from the orchestrator.
- `lucida-web/src/pipeline/cpuCache.ts` — recognizes `lane: "minimap"` and routes those chunks to the overview eviction tier.
- The orchestrator's previous inline minimap injection is deleted.

## Related

- [[principles/planning]] — the framework this decision lives within
- [[chunk-pipeline]] — end-to-end trace; priority table updated to match
- [[planning-domain]] — subsystem article; refreshed for the new lane
- [[cpu-cache]] — eviction tier mapping note
- PRD #545 — the work item this ADR was created during
