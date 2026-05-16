/**
 * Per-entity cache of decoded chunks. One class backs both the main
 * (Tiered) and overview (LRU) stores — they differ only in eviction
 * policy + the label used when reporting evictions.
 */

import type { CacheEntry, EvictionTier } from "./types.ts";
import type { EvictionPolicy } from "./eviction.ts";
import type { EvictionRecordTier } from "./telemetry.ts";

export interface ChunkStoreTierResidency {
  activeDetail: { count: number; bytes: number };
  demotedDetail: { count: number; bytes: number };
  prefetch: { count: number; bytes: number };
}

export interface SingleBucketResidency {
  count: number;
  bytes: number;
}

export interface ChunkStoreDumpEntry {
  entityId: string;
  level: number;
  tier: EvictionTier;
  bytes: number;
  chunkKey: string;
  insertedAt: number;
}

export interface EvictionBurstInfo {
  removed: number;
  bytesFreed: number;
  bytesNeeded: number;
}

export interface ChunkStoreOptions {
  policy: EvictionPolicy<CacheEntry>;
  budgetBytes: number;
  /** Main store reports `entry.tier`; overview store reports `"overview"`. */
  evictionTier: (entry: CacheEntry) => EvictionRecordTier;
  recordEviction: (tier: EvictionRecordTier) => void;
  /** Eviction-burst log is main-cache only; overview leaves this unset. */
  onEvictionBurst?: (info: EvictionBurstInfo) => void;
}

const EVICTION_BURST_THRESHOLD = 16;

export class ChunkStore {
  private store = new Map<string, Map<string, CacheEntry>>();
  private bytesCounter = 0;
  readonly budgetBytes: number;
  private readonly policy: EvictionPolicy<CacheEntry>;
  private readonly evictionTier: (entry: CacheEntry) => EvictionRecordTier;
  private readonly recordEviction: (tier: EvictionRecordTier) => void;
  private readonly onEvictionBurst?: (info: EvictionBurstInfo) => void;
  /** Exposed so tests can assert against the same constant. */
  static readonly evictionBurstThreshold = EVICTION_BURST_THRESHOLD;

  constructor(opts: ChunkStoreOptions) {
    this.policy = opts.policy;
    this.budgetBytes = opts.budgetBytes;
    this.evictionTier = opts.evictionTier;
    this.recordEviction = opts.recordEviction;
    this.onEvictionBurst = opts.onEvictionBurst;
  }

  get bytes(): number {
    return this.bytesCounter;
  }

  /** Evicts via the policy if over budget; caller assembles the entry. */
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

  /** Drop an entry returned by `policy.selectVictims` without re-keying. */
  removeEntry(entry: CacheEntry): void {
    const entityMap = this.store.get(entry.entityId);
    if (!entityMap) return;
    entityMap.delete(entry.chunkKey);
    if (entityMap.size === 0) this.store.delete(entry.entityId);
    this.bytesCounter -= entry.sizeBytes;
    this.recordEviction(this.evictionTier(entry));
  }

  /**
   * Returns the live reference; mutating `priority` / `lastSeenTick` is
   * how `submit()` refreshes the active-detail tiebreaker.
   */
  get(entityId: string, chunkKey: string): CacheEntry | undefined {
    return this.store.get(entityId)?.get(chunkKey);
  }

  hasEntity(entityId: string): boolean {
    return this.store.has(entityId);
  }

  chunkKeysForEntity(entityId: string): Iterable<string> {
    return this.store.get(entityId)?.keys() ?? [];
  }

  entriesForEntity(entityId: string): Iterable<CacheEntry> {
    return this.store.get(entityId)?.values() ?? [];
  }

  *allEntries(): Iterable<CacheEntry> {
    for (const entityMap of this.store.values()) {
      for (const entry of entityMap.values()) {
        yield entry;
      }
    }
  }

  *entityChunkKeys(): Iterable<[string, IterableIterator<string>]> {
    for (const [entityId, entityMap] of this.store) {
      yield [entityId, entityMap.keys()];
    }
  }

  /** Dataset removal — no eviction records emitted. */
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

  reset(): void {
    this.store.clear();
    this.bytesCounter = 0;
  }

  private collectEntries(): CacheEntry[] {
    const result: CacheEntry[] = [];
    for (const entityMap of this.store.values()) {
      for (const entry of entityMap.values()) {
        result.push(entry);
      }
    }
    return result;
  }

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

  /** Main-store only; overview uses {@link totalResidency}. */
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

  /** No-op for entities not present (e.g., overview-only entities). */
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
