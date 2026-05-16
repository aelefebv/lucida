/**
 * ChunkStore — per-entity cache of decoded chunks.
 *
 * Wraps `Map<entityId, Map<chunkKey, CacheEntry>>` plus a bytes counter,
 * a budget, an {@link EvictionPolicy}, and (optionally) an
 * eviction-burst log callback. Parameterized so the same class backs
 * both the main (detail) and overview caches — the only differences
 * between them are the eviction policy and the tier-label used when
 * reporting evictions:
 *  - Main store: {@link TieredPolicy}, evictions labelled by
 *    `entry.tier` (active-detail / demoted-detail / prefetch).
 *  - Overview store: {@link LRUPolicy}, evictions labelled "overview".
 *
 * Insert + eviction collapse into one call (`insert(entry)`): the store
 * walks its own entries, asks its policy for victims, and removes them
 * itself. The bytes counter and the eviction-burst-log threshold live
 * here too — both are "cache observes the policy's output", not policy
 * concerns. See `pipeline/fetch/eviction.ts` for the policy seam.
 *
 * Public surface of {@link CpuCache} is unchanged; this is an internal
 * collaborator. Nothing outside `pipeline/fetch/` should import it.
 */

import type { CacheEntry, EvictionTier } from "./types.ts";
import type { EvictionPolicy } from "./eviction.ts";
import type { EvictionRecordTier } from "./telemetry.ts";

/**
 * Per-tier residency totals for a single store. The main store
 * populates all three buckets from `entry.tier`; the overview store
 * sums every entry into a single bucket (see
 * {@link ChunkStore.totalResidency}).
 */
export interface ChunkStoreTierResidency {
  activeDetail: { count: number; bytes: number };
  demotedDetail: { count: number; bytes: number };
  prefetch: { count: number; bytes: number };
}

/** Aggregate residency — used by the overview store and the proxy store. */
export interface SingleBucketResidency {
  count: number;
  bytes: number;
}

/** Per-entry record returned by {@link ChunkStore.dump}. */
export interface ChunkStoreDumpEntry {
  entityId: string;
  level: number;
  tier: EvictionTier;
  bytes: number;
  chunkKey: string;
  insertedAt: number;
}

/**
 * Argument to the optional eviction-burst callback. Fired by
 * {@link ChunkStore.insert} when a single eviction pass removed
 * {@link ChunkStore.evictionBurstThreshold} or more victims.
 */
export interface EvictionBurstInfo {
  removed: number;
  bytesFreed: number;
  bytesNeeded: number;
}

/**
 * Constructor options for {@link ChunkStore}.
 */
export interface ChunkStoreOptions {
  /** Eviction policy applied when budget is exceeded. */
  policy: EvictionPolicy<CacheEntry>;
  /** Byte budget; entries are evicted to stay at or under it. */
  budgetBytes: number;
  /**
   * Tier label used when reporting evictions to telemetry. Main store
   * passes `entry => entry.tier`; overview store passes `() => "overview"`.
   */
  evictionTier: (entry: CacheEntry) => EvictionRecordTier;
  /** Telemetry sink invoked once per evicted entry. */
  recordEviction: (tier: EvictionRecordTier) => void;
  /**
   * Optional callback fired when a single insert evicts ≥
   * {@link ChunkStore.evictionBurstThreshold} entries. Main store wires
   * this to a `debugLog` line; overview store leaves it unset
   * (eviction-burst log is main-cache only — see prior behavior in
   * `cpuCache.ts` before Slice 6).
   */
  onEvictionBurst?: (info: EvictionBurstInfo) => void;
}

/**
 * Threshold for the eviction-burst log. A single insert that evicts
 * this many entries or more fires the optional `onEvictionBurst`
 * callback. Matches the pre-Slice-6 behavior baked into
 * `cpuCache.ts:evictIfNeeded`.
 */
const EVICTION_BURST_THRESHOLD = 16;

export class ChunkStore {
  /** `Map<entityId, Map<chunkKey, CacheEntry>>`. */
  private store = new Map<string, Map<string, CacheEntry>>();
  private bytesCounter = 0;
  readonly budgetBytes: number;
  private readonly policy: EvictionPolicy<CacheEntry>;
  private readonly evictionTier: (entry: CacheEntry) => EvictionRecordTier;
  private readonly recordEviction: (tier: EvictionRecordTier) => void;
  private readonly onEvictionBurst?: (info: EvictionBurstInfo) => void;
  /** Public for tests; exposed so callers can assert against the same
   *  constant the store uses internally. */
  static readonly evictionBurstThreshold = EVICTION_BURST_THRESHOLD;

  constructor(opts: ChunkStoreOptions) {
    this.policy = opts.policy;
    this.budgetBytes = opts.budgetBytes;
    this.evictionTier = opts.evictionTier;
    this.recordEviction = opts.recordEviction;
    this.onEvictionBurst = opts.onEvictionBurst;
  }

  /** Current bytes held by the store; mirrors the pre-Slice-6 field. */
  get bytes(): number {
    return this.bytesCounter;
  }

  /**
   * Insert a decoded entry. Evicts first if the entry would put the
   * store over budget; the policy is consulted with the post-victim
   * total so a single pass collects exactly enough victims. Fires the
   * optional `onEvictionBurst` callback when ≥
   * {@link evictionBurstThreshold} entries are removed in this pass.
   *
   * The caller is responsible for assembling the {@link CacheEntry}
   * (including `insertedAt` — see `cpuCache.lruCounter`).
   */
  insert(entry: CacheEntry): void {
    this.evictIfNeeded(entry.sizeBytes);

    let entityMap = this.store.get(entry.entityId);
    if (!entityMap) {
      entityMap = new Map();
      this.store.set(entry.entityId, entityMap);
    }
    entityMap.set(entry.chunkKey, entry);
    this.bytesCounter += entry.sizeBytes;
  }

  private evictIfNeeded(incomingBytes: number): void {
    if (this.bytesCounter + incomingBytes <= this.budgetBytes) return;
    const bytesNeeded = this.bytesCounter + incomingBytes - this.budgetBytes;
    const entries = this.collectEntries();
    const victims = this.policy.selectVictims(entries, bytesNeeded);

    let freed = 0;
    for (const victim of victims) {
      this.removeEntry(victim);
      freed += victim.sizeBytes;
    }

    if (victims.length >= EVICTION_BURST_THRESHOLD && this.onEvictionBurst) {
      this.onEvictionBurst({
        removed: victims.length,
        bytesFreed: freed,
        bytesNeeded,
      });
    }
  }

  /** Remove a single entry by id+key; returns true if it was present. */
  remove(entityId: string, chunkKey: string): boolean {
    const entityMap = this.store.get(entityId);
    if (!entityMap) return false;
    const entry = entityMap.get(chunkKey);
    if (!entry) return false;
    entityMap.delete(chunkKey);
    if (entityMap.size === 0) this.store.delete(entityId);
    this.bytesCounter -= entry.sizeBytes;
    this.recordEviction(this.evictionTier(entry));
    return true;
  }

  /**
   * Remove an entry by reference. Used during victim iteration —
   * `policy.selectVictims` returns entries directly from this store's
   * Maps so we can drop them without re-keying.
   */
  removeEntry(entry: CacheEntry): void {
    const entityMap = this.store.get(entry.entityId);
    if (!entityMap) return;
    entityMap.delete(entry.chunkKey);
    if (entityMap.size === 0) this.store.delete(entry.entityId);
    this.bytesCounter -= entry.sizeBytes;
    this.recordEviction(this.evictionTier(entry));
  }

  /** Lookup by id+key. Returns the live reference into the store —
   *  mutating fields like `priority` / `lastSeenTick` is allowed and is
   *  how `submit()` refreshes the active-detail tiebreaker. */
  get(entityId: string, chunkKey: string): CacheEntry | undefined {
    return this.store.get(entityId)?.get(chunkKey);
  }

  /** Whether the store holds at least one entry for the given entity. */
  hasEntity(entityId: string): boolean {
    return this.store.has(entityId);
  }

  /** Iterate over the chunk keys cached for one entity (Set view). */
  chunkKeysForEntity(entityId: string): Iterable<string> {
    return this.store.get(entityId)?.keys() ?? [];
  }

  /** Iterate over the entries cached for one entity. */
  entriesForEntity(entityId: string): Iterable<CacheEntry> {
    return this.store.get(entityId)?.values() ?? [];
  }

  /** Iterate over every cached entry. Used by telemetry / dump / snapshot. */
  *allEntries(): Iterable<CacheEntry> {
    for (const entityMap of this.store.values()) {
      for (const entry of entityMap.values()) {
        yield entry;
      }
    }
  }

  /** Iterate over `[entityId, chunkKeys]` pairs — used by snapshot(). */
  *entityChunkKeys(): Iterable<[string, IterableIterator<string>]> {
    for (const [entityId, entityMap] of this.store) {
      yield [entityId, entityMap.keys()];
    }
  }

  /**
   * Drop every entry belonging to one of the given entity ids. Bytes
   * counter is decremented; no eviction-records are emitted (this is a
   * dataset removal, not a policy decision).
   */
  cancelDataset(entityIds: Iterable<string>): void {
    for (const entityId of entityIds) {
      const entityMap = this.store.get(entityId);
      if (!entityMap) continue;
      for (const entry of entityMap.values()) {
        this.bytesCounter -= entry.sizeBytes;
      }
      this.store.delete(entityId);
    }
  }

  /** Clear every entry and zero the bytes counter. */
  reset(): void {
    this.store.clear();
    this.bytesCounter = 0;
  }

  /** Flat list of every cached entry — used by {@link policy.selectVictims}. */
  private collectEntries(): CacheEntry[] {
    const result: CacheEntry[] = [];
    for (const entityMap of this.store.values()) {
      for (const entry of entityMap.values()) {
        result.push(entry);
      }
    }
    return result;
  }

  /** Per-entry dump for the DebugPanel "Dump cache contents" button. */
  dump(): ChunkStoreDumpEntry[] {
    const out: ChunkStoreDumpEntry[] = [];
    for (const entityMap of this.store.values()) {
      for (const e of entityMap.values()) {
        out.push({
          entityId: e.entityId,
          level: e.level,
          tier: e.tier,
          bytes: e.sizeBytes,
          chunkKey: e.chunkKey,
          insertedAt: e.insertedAt,
        });
      }
    }
    return out;
  }

  /**
   * Per-tier residency for the main store. Walks every entry once and
   * bins by `entry.tier`. The overview store uses {@link totalResidency}
   * instead — its entries all carry tier "prefetch" cosmetically (see
   * `cpuCache.laneToTier`) so a per-tier breakdown is meaningless there.
   */
  tierResidency(): ChunkStoreTierResidency {
    const out: ChunkStoreTierResidency = {
      activeDetail: { count: 0, bytes: 0 },
      demotedDetail: { count: 0, bytes: 0 },
      prefetch: { count: 0, bytes: 0 },
    };
    for (const entityMap of this.store.values()) {
      for (const e of entityMap.values()) {
        if (e.tier === "active-detail") {
          out.activeDetail.count++;
          out.activeDetail.bytes += e.sizeBytes;
        } else if (e.tier === "demoted-detail") {
          out.demotedDetail.count++;
          out.demotedDetail.bytes += e.sizeBytes;
        } else {
          out.prefetch.count++;
          out.prefetch.bytes += e.sizeBytes;
        }
      }
    }
    return out;
  }

  /**
   * Aggregate `{count, bytes}` for the whole store. Used by the
   * overview store's telemetry (it has no per-tier distinction).
   */
  totalResidency(): SingleBucketResidency {
    let count = 0;
    let bytes = 0;
    for (const entityMap of this.store.values()) {
      for (const e of entityMap.values()) {
        count++;
        bytes += e.sizeBytes;
      }
    }
    return { count, bytes };
  }

  /**
   * Move every active-detail entry for an entity to demoted-detail.
   * Called by `cpuCache.demoteEntity` when an entity leaves the active
   * set. No-op for entities not present (e.g., overview-only entities).
   */
  demoteEntity(entityId: string): void {
    const entityMap = this.store.get(entityId);
    if (!entityMap) return;
    for (const entry of entityMap.values()) {
      if (entry.tier === "active-detail") {
        entry.tier = "demoted-detail";
      }
    }
  }
}
