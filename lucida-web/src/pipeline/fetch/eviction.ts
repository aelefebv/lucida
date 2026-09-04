/**
 * Eviction policies for the CPU cache.
 *
 * Two policies share one {@link EvictionPolicy} interface:
 *  - {@link LRUPolicy} — pure insertion-order LRU. Used by the overview
 *    cache and the proxy cache (entries are sacrificial; oldest goes first).
 *  - {@link TieredPolicy} — used by the main (detail) cache. A chunk finer
 *    than its entity's target level goes first, whatever its tier (ADR
 *    0061). Then it walks tiers in {@link getTierOrder} for the current
 *    interaction mode, and within active-detail it uses the
 *    `(lastSeenTick ↑, priority ↓, insertedAt ↑)` rule, so focal chunks
 *    aren't swept out by their own freshness.
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
 * The detail cache's policy. Two passes:
 *
 *  1. Chunks finer than their entity's target level, whatever their tier
 *     (ADR 0061). Planning requests the target level only, the renderer
 *     never samples a finer level, and a finer level is the most
 *     expensive resident, so zooming out releases these first. Finest
 *     level first, then the view-distance keys below.
 *  2. Everything else, walking {@link getTierOrder} for the mode provided
 *     by `modeProvider`. Within each tier the order is pure LRU
 *     (`insertedAt` ascending), EXCEPT for active-detail, which uses the
 *     `(lastSeenTick ↑, priority ↓, insertedAt ↑)` tiebreaker so:
 *      - chunks absent from the most recent plan are picked first;
 *      - among present-this-tick entries, the highest priority *number*
 *        (= farthest from focal, lowest importance) goes first;
 *      - insertion order is the deterministic final tiebreaker.
 *
 * A chunk at or coarser than the target is not special. A coarser
 * resident chunk stays until the tier walk reaches it.
 *
 * `modeProvider` and `targetLevelFor` are thunks so the policy reads the
 * live detector and the live targets without being re-wired on each
 * change. An entity with no known target has nothing finer.
 */
export class TieredPolicy implements EvictionPolicy {
  private readonly modeProvider: () => InteractionMode;
  private readonly targetLevelFor: (entityId: string) => number | undefined;

  constructor(
    modeProvider: () => InteractionMode,
    targetLevelFor: (entityId: string) => number | undefined,
  ) {
    this.modeProvider = modeProvider;
    this.targetLevelFor = targetLevelFor;
  }

  selectVictims(entries: readonly CacheEntry[], bytesNeeded: number): CacheEntry[] {
    if (bytesNeeded <= 0) return [];
    const victims: CacheEntry[] = [];
    let freed = 0;
    const take = (entry: CacheEntry): void => {
      victims.push(entry);
      freed += entry.sizeBytes;
    };

    const finer: CacheEntry[] = [];
    const rest: CacheEntry[] = [];
    for (const entry of entries) {
      const target = this.targetLevelFor(entry.entityId);
      (target !== undefined && entry.level < target ? finer : rest).push(entry);
    }
    finer.sort((a, b) => a.level - b.level || byDistanceFromView(a, b));
    for (const entry of finer) {
      if (freed >= bytesNeeded) return victims;
      take(entry);
    }

    for (const tier of getTierOrder(this.modeProvider())) {
      if (freed >= bytesNeeded) break;
      const tierEntries = rest.filter(e => e.tier === tier);
      if (tier === "active-detail") {
        tierEntries.sort(byDistanceFromView);
      } else {
        tierEntries.sort((a, b) => a.insertedAt - b.insertedAt);
      }
      for (const entry of tierEntries) {
        if (freed >= bytesNeeded) break;
        take(entry);
      }
    }

    return victims;
  }
}

function byDistanceFromView(a: CacheEntry, b: CacheEntry): number {
  return (
    a.lastSeenTick - b.lastSeenTick
    || b.priority - a.priority
    || a.insertedAt - b.insertedAt
  );
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
