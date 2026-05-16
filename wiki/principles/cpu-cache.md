---
created: 2026-05-16
modified: 2026-05-16
---

# Principles — CPU Cache

The CPU cache sits between the network and the GPU, holding decoded chunk bytes long enough for the renderer to use them and reuse them. These principles describe what the cache optimizes for, and why. They are stable claims about *direction*; specific design choices are recorded as ADRs that cite these principles as their justification.

Principles are blind to decisions. They are read by — never read from — the rest of the wiki.

## 1. Decoded bytes survive GPU eviction

The cache holds decoded bytes between the network and the GPU so that, when the GPU evicts an atlas slot under memory pressure, recovery is a memcpy rather than a fresh network fetch + decode.

**Why.** The network is orders of magnitude slower than CPU-side memory access; decode adds non-trivial CPU time on top. The GPU's residency horizon is independent of and smaller than the CPU's. Without an intermediate cache, every GPU eviction would translate directly into a round-trip the user perceives as a stall.

## 2. Tier-aware eviction protects bytes by how expensive they'd be to lose

Eviction is not pure LRU. Bytes are organized into tiers, and the tiers carry a priority ordering for which goes first under memory pressure. The most-expensive-to-replace bytes — the coarsest representations that cover a whole dataset, the fallback resources that gate per-frame responsiveness on plates — sit in the most-protected tiers.

**Why.** Pure LRU evicts whatever was touched longest ago, which is usually the most-expensive-to-replace bytes by construction (they're loaded first on dataset open and then stay; new detail fetches keep refreshing themselves). Loss is asymmetric: refetching a single detail tile is bounded work; refetching a multi-megabyte overview or every well's proxy is qualitatively larger. Tier-aware eviction makes the loss schedule match the loss cost.

## 3. Movement across tiers is cheap; refetch is expensive

When the user navigates away from an entity, its chunks don't drop — they move to a less-protected tier. They only evict if memory pressure exhausts the cheaper tiers first.

**Why.** Navigating away and back is a common interaction pattern (panning across plates, returning to a previously-viewed timepoint). The bytes haven't changed; only attention has. Dropping bytes on navigation and refetching on return burns network + decode time for no informational gain and produces a visible stall exactly when the user expects responsiveness ("I just looked at this").

## 4. Within the active set, evict least-recently-wanted and lowest-importance first

The active-detail tier is *not* sorted by insertion time. Focal-point chunks fetch first and are therefore oldest by insertion; an insertion-time LRU would evict them first under pressure. Instead, the active set evicts chunks that the most recent plan didn't ask for, breaking ties by importance and then by insertion.

**Why.** The user's attention is at the focal point. A center-outward eviction wave — exactly what insertion-LRU produces here — collapses the rendering precisely where the user is looking, while preserving bytes the user isn't currently looking at. The directional commitment is that what the user is most attending to stays longest; insertion-LRU inverts that.

## 5. Failure is windowed, not permanent

A failed fetch is skipped for a brief window of content epochs and then re-attempted. The cache holds no permanent fail-list.

**Why.** Most fetch failures are transient: network blips, server hiccups, brief resource unavailability. A permanent blacklist converts a recoverable condition into a persistent hole the user can never get back; a per-tick retry would storm the network and decode pool. A bounded skip window resolves both: the system gets out of the way during the failure and tries again once the window passes.

## 6. One fetch path, one budget, one failure regime

The cache is the sole path through which chunks are fetched. There is no parallel queue, no out-of-band fetch surface, no second residency discipline competing for the same network bandwidth and decode pool.

**Why.** Two paths competing for the same scarce resources, each maintaining its own residency under a shared memory budget, produce non-deterministic interleaving and fairness bugs that are hard to attribute to either path. The cost of "one bug ruins everything" is accepted in exchange for the cost being attributable — bugs land in one place and have one regression test.

## How these interact

Several of these principles trade against each other:

- **Principles 2 (tier-aware protection) and 3 (movement, not deletion) together prefer holding bytes over freeing them**, within the limit memory imposes. The combined effect is that recently-relevant bytes stay through navigation and through GPU pressure unless the cache is genuinely full.

- **Principle 4 (active-detail tiebreaker) refines Principle 2** for the one tier where the user's gaze matters most. Lower tiers (prefetch, demoted-detail, overview) use insertion-LRU because attention isn't a meaningful axis for them.

- **Principle 5 (windowed failure) and Principle 1 (survive GPU eviction) are independent** — failure handling and successful-byte retention solve different problems. They coexist by both being "don't pay network cost twice when you don't have to."

- **Principle 6 (one path) is a constraint on Principles 1–5**: each principle has exactly one implementation surface to update when it's revised. Adding a parallel fetch path would require duplicating every other principle's enforcement and is the move the principle exists to prohibit.

When a proposed change cannot honor all principles simultaneously, surface it as an ADR that names the principle being relaxed, the alternatives considered, and the reason for the trade-off.
