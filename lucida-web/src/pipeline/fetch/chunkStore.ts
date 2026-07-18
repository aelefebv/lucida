/**
 * Per-image cache of decoded chunks. One class backs both the main
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
  datasetId: string;
  entityId: string;
  imageId: string;
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
  /** datasetId → imageId → chunkKey → decoded entry. */
  private store = new Map<string, Map<string, Map<string, CacheEntry>>>();
  private bytesCounter = 0;
  private budgetBytesCounter: number;
  private readonly policy: EvictionPolicy<CacheEntry>;
  private readonly evictionTier: (entry: CacheEntry) => EvictionRecordTier;
  private readonly recordEviction: (tier: EvictionRecordTier) => void;
  private readonly onEvictionBurst?: (info: EvictionBurstInfo) => void;
  /** Exposed so tests can assert against the same constant. */
  static readonly evictionBurstThreshold = EVICTION_BURST_THRESHOLD;

  constructor(opts: ChunkStoreOptions) {
    this.policy = opts.policy;
    this.budgetBytesCounter = opts.budgetBytes;
    this.evictionTier = opts.evictionTier;
    this.recordEviction = opts.recordEviction;
    this.onEvictionBurst = opts.onEvictionBurst;
  }

  get bytes(): number {
    return this.bytesCounter;
  }

  get budgetBytes(): number {
    return this.budgetBytesCounter;
  }

  setBudgetBytes(budgetBytes: number): void {
    this.budgetBytesCounter = Math.max(0, budgetBytes);
    this.evictIfNeeded(0);
  }

  /** Evicts via the policy if over budget; caller assembles the entry. */
  insert(entry: CacheEntry): void {
    // Replacing an exact identity is not a second allocation. Remove the old
    // accounting first (without reporting an eviction), then admit the fresh
    // bytes normally. This also makes a late duplicate completion harmless.
    const existing = this.get(entry.datasetId, entry.imageId, entry.chunkKey);
    if (existing) {
      this.deleteStoredEntry(existing);
    }
    this.evictIfNeeded(entry.sizeBytes);

    let datasetMap = this.store.get(entry.datasetId);
    if (!datasetMap) {
      datasetMap = new Map();
      this.store.set(entry.datasetId, datasetMap);
    }
    let imageMap = datasetMap.get(entry.imageId);
    if (!imageMap) {
      imageMap = new Map();
      datasetMap.set(entry.imageId, imageMap);
    }
    imageMap.set(entry.chunkKey, entry);
    this.bytesCounter += entry.sizeBytes;
  }

  private evictIfNeeded(incomingBytes: number): void {
    if (this.bytesCounter + incomingBytes <= this.budgetBytesCounter) return;
    const bytesNeeded = this.bytesCounter + incomingBytes - this.budgetBytesCounter;
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

  remove(datasetId: string, imageId: string, chunkKey: string): boolean {
    const datasetMap = this.store.get(datasetId);
    const imageMap = datasetMap?.get(imageId);
    if (!imageMap) return false;
    const entry = imageMap.get(chunkKey);
    if (!entry) return false;
    imageMap.delete(chunkKey);
    if (imageMap.size === 0) datasetMap!.delete(imageId);
    if (datasetMap!.size === 0) this.store.delete(datasetId);
    this.bytesCounter -= entry.sizeBytes;
    this.recordEviction(this.evictionTier(entry));
    return true;
  }

  /** Drop an entry returned by `policy.selectVictims` without re-keying. */
  removeEntry(entry: CacheEntry): void {
    if (!this.deleteStoredEntry(entry)) return;
    this.recordEviction(this.evictionTier(entry));
  }

  private deleteStoredEntry(entry: CacheEntry): boolean {
    const datasetMap = this.store.get(entry.datasetId);
    const imageMap = datasetMap?.get(entry.imageId);
    if (imageMap?.get(entry.chunkKey) !== entry) return false;
    imageMap.delete(entry.chunkKey);
    if (imageMap.size === 0) datasetMap!.delete(entry.imageId);
    if (datasetMap!.size === 0) this.store.delete(entry.datasetId);
    this.bytesCounter -= entry.sizeBytes;
    return true;
  }

  /**
   * Returns the live reference; mutating lane / tier / priority /
   * lastSeenTick is how `submit()` refreshes wanted cache entries.
   */
  get(datasetId: string, imageId: string, chunkKey: string): CacheEntry | undefined {
    return this.store.get(datasetId)?.get(imageId)?.get(chunkKey);
  }

  hasEntity(datasetId: string, entityId: string): boolean {
    const datasetMap = this.store.get(datasetId);
    if (!datasetMap) return false;
    for (const imageMap of datasetMap.values()) {
      for (const entry of imageMap.values()) {
        if (entry.entityId === entityId) return true;
      }
    }
    return false;
  }

  *chunkKeysForEntity(datasetId: string, entityId: string): Iterable<string> {
    const datasetMap = this.store.get(datasetId);
    if (!datasetMap) return;
    for (const imageMap of datasetMap.values()) {
      for (const entry of imageMap.values()) {
        if (entry.entityId === entityId) yield entry.chunkKey;
      }
    }
  }

  *entriesForEntity(datasetId: string, entityId: string): Iterable<CacheEntry> {
    const datasetMap = this.store.get(datasetId);
    if (!datasetMap) return;
    for (const imageMap of datasetMap.values()) {
      for (const entry of imageMap.values()) {
        if (entry.entityId === entityId) yield entry;
      }
    }
  }

  *allEntries(): Iterable<CacheEntry> {
    for (const datasetMap of this.store.values()) {
      for (const entityMap of datasetMap.values()) {
        for (const entry of entityMap.values()) yield entry;
      }
    }
  }

  *iterateTier(tier: EvictionTier): Iterable<CacheEntry> {
    for (const datasetMap of this.store.values()) {
      for (const entityMap of datasetMap.values()) {
        for (const entry of entityMap.values()) {
          if (entry.tier === tier) yield entry;
        }
      }
    }
  }

  findByImageChunk(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
  ): CacheEntry | undefined {
    const imageMap = this.store.get(datasetId)?.get(imageId);
    if (!imageMap) return undefined;
    for (const entry of imageMap.values()) {
      if (entry.c === c && entry.chunkKey === chunkKey) return entry;
    }
    return undefined;
  }

  *imageChunkKeys(): Iterable<[string, string, IterableIterator<string>]> {
    for (const [datasetId, datasetMap] of this.store) {
      for (const [imageId, imageMap] of datasetMap) {
        yield [datasetId, imageId, imageMap.keys()];
      }
    }
  }

  /** Dataset removal — no eviction records emitted. */
  cancelDataset(datasetId: string): void {
    const datasetMap = this.store.get(datasetId);
    if (!datasetMap) return;
    for (const entityMap of datasetMap.values()) {
      for (const entry of entityMap.values()) this.bytesCounter -= entry.sizeBytes;
    }
    this.store.delete(datasetId);
  }

  /** Refreshed-manifest invalidation — remove only changed image contracts. */
  cancelImages(datasetId: string, imageIds: ReadonlySet<string>): void {
    const datasetMap = this.store.get(datasetId);
    if (!datasetMap) return;
    for (const imageId of imageIds) {
      const imageMap = datasetMap.get(imageId);
      if (!imageMap) continue;
      for (const entry of imageMap.values()) {
        this.bytesCounter -= entry.sizeBytes;
      }
      datasetMap.delete(imageId);
    }
    if (datasetMap.size === 0) this.store.delete(datasetId);
  }

  reset(): void {
    this.store.clear();
    this.bytesCounter = 0;
  }

  private collectEntries(): CacheEntry[] {
    const result: CacheEntry[] = [];
    for (const datasetMap of this.store.values()) {
      for (const entityMap of datasetMap.values()) {
        for (const entry of entityMap.values()) result.push(entry);
      }
    }
    return result;
  }

  dump(): ChunkStoreDumpEntry[] {
    const out: ChunkStoreDumpEntry[] = [];
    for (const datasetMap of this.store.values()) {
      for (const entityMap of datasetMap.values()) {
        for (const e of entityMap.values()) {
        out.push({
          datasetId: e.datasetId,
          entityId: e.entityId,
          imageId: e.imageId,
          level: e.level,
          tier: e.tier,
          bytes: e.sizeBytes,
          chunkKey: e.chunkKey,
          insertedAt: e.insertedAt,
        });
        }
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
    for (const datasetMap of this.store.values()) {
      for (const entityMap of datasetMap.values()) {
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
    }
    return out;
  }

  totalResidency(): SingleBucketResidency {
    let count = 0;
    let bytes = 0;
    for (const datasetMap of this.store.values()) {
      for (const entityMap of datasetMap.values()) {
        for (const e of entityMap.values()) {
          count++;
          bytes += e.sizeBytes;
        }
      }
    }
    return { count, bytes };
  }

  /** No-op for entities not present (e.g., overview-only entities). */
  demoteEntity(datasetId: string, entityId: string): void {
    const datasetMap = this.store.get(datasetId);
    if (!datasetMap) return;
    for (const imageMap of datasetMap.values()) {
      for (const entry of imageMap.values()) {
        if (entry.entityId === entityId && entry.tier === "active-detail") {
          entry.tier = "demoted-detail";
        }
      }
    }
  }
}
