/**
 * Eviction policies for the CPU cache. {@link LRUPolicy} serves the
 * overview cache, whose entries are sacrificial; {@link TieredPolicy}
 * serves the main (detail) cache.
 *
 * Policies are pure: they order entries. The store keeps the order between
 * inserts (`evictionQueue.ts`) and owns removal, byte budgets, and the
 * eviction-burst log.
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

/** Negative when `a` is evicted before `b`. */
export type EvictionCompare<T> = (a: T, b: T) => number;

/**
 * The order a store evicts its entries in. Pure: it reads the entries and
 * the policy's own inputs and holds no state across calls beyond its
 * configuration.
 */
export interface EvictionPolicy<T extends EvictableEntry = CacheEntry> {
  /**
   * The order as it stands: valid until an entry's fields or one of the
   * inputs {@link stamp} names changes.
   */
  comparator(): EvictionCompare<T>;
  /** The inputs the order reads besides the entries, compared element by element. */
  stamp(): readonly unknown[];
  /** Entries in eviction order until their bytes reach `bytesNeeded`. Does not mutate `entries`. */
  selectVictims(entries: readonly T[], bytesNeeded: number): T[];
}

function victimsInOrder<T extends EvictableEntry>(
  entries: readonly T[],
  bytesNeeded: number,
  compare: EvictionCompare<T>,
): T[] {
  if (bytesNeeded <= 0) return [];
  const sorted = [...entries].sort(compare);
  const victims: T[] = [];
  let freed = 0;
  for (const entry of sorted) {
    if (freed >= bytesNeeded) break;
    victims.push(entry);
    freed += entry.sizeBytes;
  }
  return victims;
}

const NO_INPUTS: readonly unknown[] = [];

/** Insertion-order LRU: oldest `insertedAt` first. */
export class LRUPolicy<T extends EvictableEntry = CacheEntry> implements EvictionPolicy<T> {
  comparator(): EvictionCompare<T> {
    return (a, b) => a.insertedAt - b.insertedAt;
  }

  stamp(): readonly unknown[] {
    return NO_INPUTS;
  }

  selectVictims(entries: readonly T[], bytesNeeded: number): T[] {
    return victimsInOrder(entries, bytesNeeded, this.comparator());
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

  comparator(): EvictionCompare<CacheEntry> {
    const tick = this.currentTick();
    return (a, b) => {
      const wantedA = a.lastSeenTick === tick ? 1 : 0;
      const wantedB = b.lastSeenTick === tick ? 1 : 0;
      return wantedA - wantedB || (wantedA === 1 ? b.priority - a.priority : 0) || a.insertedAt - b.insertedAt;
    };
  }

  stamp(): readonly unknown[] {
    return [this.currentTick()];
  }

  selectVictims(entries: readonly CacheEntry[], bytesNeeded: number): CacheEntry[] {
    return victimsInOrder(entries, bytesNeeded, this.comparator());
  }
}

/** {@link TieredPolicy}'s classes, in the order it takes them. */
const FINER = 0;
const WANTED = 4;

/**
 * The detail cache's policy. Three classes, taken in turn:
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

  comparator(): EvictionCompare<CacheEntry> {
    const tick = this.currentTick();
    const tiers = getTierOrder(this.modeProvider());
    const targetLevelFor = this.targetLevelFor;
    const classOf = (entry: CacheEntry): number => {
      const target = targetLevelFor(entry.entityId);
      if (target !== undefined && entry.level < target) return FINER;
      if (entry.lastSeenTick !== tick) return 1 + tiers.indexOf(entry.tier);
      return WANTED;
    };
    return (a, b) => {
      const classA = classOf(a);
      const order = classA - classOf(b);
      if (order !== 0) return order;
      if (classA === FINER) return a.level - b.level || byDistanceFromView(a, b);
      if (classA === WANTED) return b.priority - a.priority || a.insertedAt - b.insertedAt;
      return a.tier === "active-detail" ? byDistanceFromView(a, b) : a.insertedAt - b.insertedAt;
    };
  }

  stamp(): readonly unknown[] {
    return [this.currentTick(), this.modeProvider()];
  }

  selectVictims(entries: readonly CacheEntry[], bytesNeeded: number): CacheEntry[] {
    return victimsInOrder(entries, bytesNeeded, this.comparator());
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
