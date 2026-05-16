/**
 * Eviction policies for the CPU cache.
 *
 * Two policies share one {@link EvictionPolicy} interface:
 *  - {@link LRUPolicy} — pure insertion-order LRU. Used by the overview
 *    cache and the proxy cache (entries are sacrificial; oldest goes first).
 *  - {@link TieredPolicy} — tier-walked LRU with an active-detail
 *    tiebreaker. Used by the main (detail) cache. Walks tiers in
 *    {@link getTierOrder} for the current interaction mode; within
 *    active-detail it uses the `(lastSeenTick ↑, priority ↓, insertedAt ↑)`
 *    rule documented in `wiki/systems/subsystems/cpu-cache.md` so focal
 *    chunks aren't swept out by their own freshness.
 *
 * Pure: policies take synthetic entries and return victims. The cache
 * owns the actual removal (it tracks per-cache byte budgets and emits
 * the eviction-burst log from the call site, both of which need state
 * the policy doesn't see).
 */

import type { CacheEntry, EvictionTier } from "./types.ts";
import type { InteractionMode } from "./interactionMode.ts";

/**
 * Minimal shape every eviction-eligible entry must expose: when it was
 * inserted (for LRU ordering) and how many bytes it claims (so the
 * caller can compute "freed enough"). {@link CacheEntry} satisfies this;
 * the proxy cache wraps its entries into the same shape at the call
 * site so {@link LRUPolicy} can serve both.
 */
export interface EvictableEntry {
  insertedAt: number;
  sizeBytes: number;
}

/**
 * Picks victims from a flat list of evictable entries until enough
 * bytes are freed. Pure: must not mutate `entries` or hold state across
 * calls beyond the policy's own configuration.
 *
 * Generic in the entry shape so the same interface fits both the
 * detail/overview caches ({@link CacheEntry}) and the proxy cache
 * (a thin adapter — see `cpuCache.ts:evictProxyIfNeeded`).
 */
export interface EvictionPolicy<T extends EvictableEntry = CacheEntry> {
  selectVictims(entries: readonly T[], bytesNeeded: number): T[];
}

/**
 * Insertion-order LRU. Oldest `insertedAt` goes first; pick until the
 * running freed-bytes sum reaches `bytesNeeded`.
 */
export class LRUPolicy<T extends EvictableEntry = CacheEntry> implements EvictionPolicy<T> {
  selectVictims(entries: readonly T[], bytesNeeded: number): T[] {
    if (bytesNeeded <= 0) return [];
    const sorted = [...entries].sort((a, b) => a.insertedAt - b.insertedAt);
    const victims: T[] = [];
    let freed = 0;
    for (const entry of sorted) {
      if (freed >= bytesNeeded) break;
      victims.push(entry);
      freed += entry.sizeBytes;
    }
    return victims;
  }
}

/**
 * Tiered LRU for the detail cache. Walks {@link getTierOrder} for the
 * mode provided by `modeProvider`, accumulating victims tier-by-tier
 * until enough bytes are freed.
 *
 * Within each tier the order is pure LRU (`insertedAt` ascending),
 * EXCEPT for active-detail, which uses the
 * `(lastSeenTick ↑, priority ↓, insertedAt ↑)` tiebreaker so:
 *  - chunks absent from the most recent plan are picked first;
 *  - among present-this-tick entries, the highest priority *number*
 *    (= farthest from focal, lowest importance) goes first;
 *  - insertion order is the deterministic final tiebreaker.
 *
 * `modeProvider` is a thunk so the policy tracks the live detector
 * without having to be re-wired on each interaction-mode change.
 */
export class TieredPolicy implements EvictionPolicy {
  private readonly modeProvider: () => InteractionMode;

  constructor(modeProvider: () => InteractionMode) {
    this.modeProvider = modeProvider;
  }

  selectVictims(entries: readonly CacheEntry[], bytesNeeded: number): CacheEntry[] {
    if (bytesNeeded <= 0) return [];
    const tierOrder = getTierOrder(this.modeProvider());
    const victims: CacheEntry[] = [];
    let freed = 0;

    for (const tier of tierOrder) {
      if (freed >= bytesNeeded) break;
      const tierEntries = entries.filter(e => e.tier === tier);
      if (tier === "active-detail") {
        tierEntries.sort((a, b) =>
          a.lastSeenTick - b.lastSeenTick      // oldest plan tick first
          || b.priority - a.priority           // then highest priority number (= farthest from focal) first
          || a.insertedAt - b.insertedAt,      // then oldest insertion as deterministic tiebreaker
        );
      } else {
        tierEntries.sort((a, b) => a.insertedAt - b.insertedAt);
      }
      for (const entry of tierEntries) {
        if (freed >= bytesNeeded) break;
        victims.push(entry);
        freed += entry.sizeBytes;
      }
    }

    return victims;
  }
}

/**
 * Tier-walk order for {@link TieredPolicy}. Highest-eviction-priority
 * tier first. Panning and idle both walk prefetch → demoted → active
 * (cheapest losses first). Scrubbing protects prefetch (those are the
 * next-time-step chunks the user is actively skimming) by walking
 * demoted → active → prefetch.
 *
 * Pure; exported for the cache's telemetry surface
 * (`CacheTelemetry.evictionTierOrder`).
 */
export function getTierOrder(mode: InteractionMode): EvictionTier[] {
  switch (mode) {
    case "panning":
      return ["prefetch", "demoted-detail", "active-detail"];
    case "scrubbing":
      return ["demoted-detail", "active-detail", "prefetch"];
    case "idle":
    default:
      return ["prefetch", "demoted-detail", "active-detail"];
  }
}
