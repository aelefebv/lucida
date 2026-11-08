/**
 * Eviction policies for the CPU cache. {@link LRUPolicy} serves the
 * overview cache, whose entries are sacrificial; {@link TieredPolicy}
 * serves the main (detail) cache.
 *
 * Policies are pure: they take entries and return victims. The cache owns
 * removal, byte budgets, and the eviction-burst log.
 */

import type { CacheEntry, EvictionTier } from "./types.ts";
import type { InteractionMode } from "./interactionMode.ts";

/**
 * Minimal shape every eviction-eligible entry must expose: when it was
 * inserted (for LRU ordering) and how many bytes it claims (so the
 * caller can compute "freed enough"). {@link CacheEntry} satisfies this.
 */
export interface EvictableEntry {
  insertedAt: number;
  sizeBytes: number;
}

/**
 * Picks victims from a flat list of evictable entries until enough
 * bytes are freed. Pure: must not mutate `entries` or hold state across
 * calls beyond the policy's own configuration.
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
 * The coarse store's policy. What the latest plan did not ask for goes
 * first, oldest first; then what it did, least urgent first, so the view's
 * most important coarse chunks are the last to go. Insertion order alone
 * evicts a priority-ordered fill from its most urgent end.
 */
export class WantedLastPolicy implements EvictionPolicy {
  private readonly currentTick: () => number;

  constructor(currentTick: () => number) {
    this.currentTick = currentTick;
  }

  selectVictims(entries: readonly CacheEntry[], bytesNeeded: number): CacheEntry[] {
    if (bytesNeeded <= 0) return [];
    const tick = this.currentTick();
    const wanted = (entry: CacheEntry): number => (entry.lastSeenTick === tick ? 1 : 0);
    const sorted = [...entries].sort(
      (a, b) =>
        wanted(a) - wanted(b) ||
        (wanted(a) === 1 ? b.priority - a.priority : 0) ||
        a.insertedAt - b.insertedAt,
    );
    const victims: CacheEntry[] = [];
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
 * The detail cache's policy. Three passes:
 *
 *  1. Chunks finer than their entity's target level, whatever their tier.
 *     Planning requests only the target level, the renderer
 *     never samples finer, and finer levels cost the most, so zooming out
 *     releases these first. Finest level first.
 *  2. What the latest plan does not want, walking {@link getTierOrder} for
 *     the current mode. Each tier is LRU, except active-detail, which sorts
 *     by `(lastSeenTick ↑, priority ↓, insertedAt ↑)`: the oldest plans'
 *     chunks first, then those farthest from focal.
 *  3. What it wants, least urgent first. The priority puts every lane
 *     wholly ahead of the next, so its prefetch goes before any of its view.
 *
 * Admission fits the view's chunks within the budget, so the view's chunks
 * going last means the view never loses one while anything else is held.
 *
 * `modeProvider`, `targetLevelFor` and `currentTick` are thunks so the
 * policy reads live values without re-wiring. An entity with no known target
 * has nothing finer. A chunk is wanted when its `lastSeenTick` is the
 * current tick.
 */
export class TieredPolicy implements EvictionPolicy {
  private readonly modeProvider: () => InteractionMode;
  private readonly targetLevelFor: (entityId: string) => number | undefined;
  private readonly currentTick: () => number;

  constructor(
    modeProvider: () => InteractionMode,
    targetLevelFor: (entityId: string) => number | undefined,
    currentTick: () => number,
  ) {
    this.modeProvider = modeProvider;
    this.targetLevelFor = targetLevelFor;
    this.currentTick = currentTick;
  }

  selectVictims(entries: readonly CacheEntry[], bytesNeeded: number): CacheEntry[] {
    if (bytesNeeded <= 0) return [];
    const victims: CacheEntry[] = [];
    let freed = 0;
    const take = (entry: CacheEntry): void => {
      victims.push(entry);
      freed += entry.sizeBytes;
    };

    const tick = this.currentTick();
    const finer: CacheEntry[] = [];
    const unwanted: CacheEntry[] = [];
    const wanted: CacheEntry[] = [];
    for (const entry of entries) {
      const target = this.targetLevelFor(entry.entityId);
      if (target !== undefined && entry.level < target) finer.push(entry);
      else if (entry.lastSeenTick !== tick) unwanted.push(entry);
      else wanted.push(entry);
    }
    finer.sort((a, b) => a.level - b.level || byDistanceFromView(a, b));
    for (const entry of finer) {
      if (freed >= bytesNeeded) return victims;
      take(entry);
    }

    for (const tier of getTierOrder(this.modeProvider())) {
      if (freed >= bytesNeeded) return victims;
      const tierEntries = unwanted.filter(e => e.tier === tier);
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

    wanted.sort((a, b) => b.priority - a.priority || a.insertedAt - b.insertedAt);
    for (const entry of wanted) {
      if (freed >= bytesNeeded) break;
      take(entry);
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
 * Tier-walk order for what {@link TieredPolicy} evicts among the chunks the
 * latest plan does not want. Highest-eviction-priority tier first. Panning
 * and idle both walk prefetch → demoted → active (cheapest losses first).
 * Scrubbing protects prefetch (those are the next-time-step chunks the user
 * is actively skimming) by walking demoted → active → prefetch.
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
