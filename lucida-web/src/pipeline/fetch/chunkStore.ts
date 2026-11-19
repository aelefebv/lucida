/**
 * Per-entity cache of decoded chunks. One class backs both the main
 * (Tiered) and overview (LRU) stores — they differ only in eviction
 * policy + the label used when reporting evictions.
 */

import type { CacheEntry, EvictionTier } from "./types.ts";
import type { EvictionPolicy } from "./eviction.ts";
import { EvictionQueue } from "./evictionQueue.ts";
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
  /**
   * The evicted entry rides along so a caller can name the chunk that left,
   * not just how many did. It is the live entry, already unlinked from the
   * store; treat it as read-only.
   */
  recordEviction: (tier: EvictionRecordTier, entry: CacheEntry) => void;
  /** Eviction-burst log is main-cache only; overview leaves this unset. */
  onEvictionBurst?: (info: EvictionBurstInfo) => void;
  /**
   * Whether `resident` must stay to make room for `incoming`. A store with
   * this set refuses an insert it could only make by evicting a protected
   * entry, rather than evict it.
   */
  protects?: (resident: CacheEntry, incoming: CacheEntry) => boolean;
}

const EVICTION_BURST_THRESHOLD = 16;

function imageChunkKey(imageId: string, c: number, chunkKey: string): string {
  return `${imageId}|${c}|${chunkKey}`;
}

export class ChunkStore {
  private store = new Map<string, Map<string, CacheEntry>>();
  /**
   * The entries of each image chunk, by image, channel and chunk key. The
   * render worker names chunks that way, and more than one entity can hold
   * the same image's chunk.
   */
  private readonly byImageChunk = new Map<string, CacheEntry[]>();
  private bytesCounter = 0;
  private budgetBytesCounter: number;
  private readonly order: EvictionQueue<CacheEntry>;
  private readonly evictionTier: (entry: CacheEntry) => EvictionRecordTier;
  private readonly recordEviction: (tier: EvictionRecordTier, entry: CacheEntry) => void;
  /**
   * Resident chunks per pyramid level, maintained incrementally because the
   * trace samples it every tick. Walking the store would cost O(resident
   * chunks) per tick, tens of thousands on a wide collection.
   */
  private readonly levelCounts: number[] = [];
  private readonly onEvictionBurst?: (info: EvictionBurstInfo) => void;
  private readonly protects?: (resident: CacheEntry, incoming: CacheEntry) => boolean;
  /** Exposed so tests can assert against the same constant. */
  static readonly evictionBurstThreshold = EVICTION_BURST_THRESHOLD;

  constructor(opts: ChunkStoreOptions) {
    this.order = new EvictionQueue(opts.policy, (entry) => this.get(entry.entityId, entry.chunkKey) === entry);
    this.budgetBytesCounter = opts.budgetBytes;
    this.evictionTier = opts.evictionTier;
    this.recordEviction = opts.recordEviction;
    this.onEvictionBurst = opts.onEvictionBurst;
    this.protects = opts.protects;
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

  /**
   * Evicts via the policy if over budget; caller assembles the entry.
   * Returns false, and changes nothing, when the room could only come from
   * entries the store protects against this one.
   *
   * An entry already held for the chunk, such as some of its planes that the
   * whole chunk now supersedes, gives its room to the new one and is not
   * counted as evicted.
   */
  insert(entry: CacheEntry): boolean {
    const replaced = this.get(entry.entityId, entry.chunkKey);
    const growth = entry.sizeBytes - (replaced?.sizeBytes ?? 0);
    if (!this.evictIfNeeded(growth, entry, replaced)) return false;

    let entityMap = this.store.get(entry.entityId);
    if (!entityMap) {
      entityMap = new Map();
      this.store.set(entry.entityId, entityMap);
    }
    entityMap.set(entry.chunkKey, entry);
    this.bytesCounter += growth;
    if (replaced) {
      this.countLevel(replaced.level, -1);
      this.unindex(replaced);
      this.order.remove();
    }
    this.countLevel(entry.level, 1);
    this.index(entry);
    this.order.add(entry);
    return true;
  }

  /**
   * What eviction's order reads changed in place: an entry's lane, tier,
   * priority or plan tick, or what the policy knows of entities. The owner
   * calls this after changing them.
   */
  invalidateOrder(): void {
    this.order.invalidate();
  }

  private index(entry: CacheEntry): void {
    const key = imageChunkKey(entry.imageId, entry.c, entry.chunkKey);
    const entries = this.byImageChunk.get(key);
    if (entries) entries.push(entry);
    else this.byImageChunk.set(key, [entry]);
  }

  private unindex(entry: CacheEntry): void {
    const key = imageChunkKey(entry.imageId, entry.c, entry.chunkKey);
    const entries = this.byImageChunk.get(key);
    if (!entries) return;
    const at = entries.indexOf(entry);
    if (at < 0) return;
    if (entries.length === 1) this.byImageChunk.delete(key);
    else entries.splice(at, 1);
  }

  /** Resident chunks per level, indexed by level. Sparse levels read as zero. */
  levelResidency(): readonly number[] {
    return this.levelCounts;
  }

  private countLevel(level: number, delta: number): void {
    if (!Number.isInteger(level) || level < 0) return;
    while (this.levelCounts.length <= level) this.levelCounts.push(0);
    this.levelCounts[level] = Math.max(0, this.levelCounts[level] + delta);
  }

  private evictIfNeeded(incomingBytes: number, incoming?: CacheEntry, replaced?: CacheEntry): boolean {
    if (this.bytesCounter + incomingBytes <= this.budgetBytesCounter) return true;
    const bytesNeeded = this.bytesCounter + incomingBytes - this.budgetBytesCounter;
    const protects = this.protects;
    const guarded = incoming !== undefined && protects !== undefined;
    const { victims, enough } = this.order.take(
      () => this.allEntries(),
      bytesNeeded,
      (resident) => resident === replaced || (guarded && protects(resident, incoming)),
    );
    if (!enough && guarded) return false;

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
    return true;
  }

  remove(entityId: string, chunkKey: string): boolean {
    const entityMap = this.store.get(entityId);
    if (!entityMap) return false;
    const entry = entityMap.get(chunkKey);
    if (!entry) return false;
    entityMap.delete(chunkKey);
    if (entityMap.size === 0) this.store.delete(entityId);
    this.bytesCounter -= entry.sizeBytes;
    this.countLevel(entry.level, -1);
    this.unindex(entry);
    this.order.remove();
    this.recordEviction(this.evictionTier(entry), entry);
    return true;
  }

  /** Drop an entry the store holds, by reference. */
  removeEntry(entry: CacheEntry): void {
    const entityMap = this.store.get(entry.entityId);
    if (!entityMap) return;
    entityMap.delete(entry.chunkKey);
    if (entityMap.size === 0) this.store.delete(entry.entityId);
    this.bytesCounter -= entry.sizeBytes;
    this.countLevel(entry.level, -1);
    this.unindex(entry);
    this.order.remove();
    this.recordEviction(this.evictionTier(entry), entry);
  }

  /**
   * Returns the live reference; mutating lane / tier / priority /
   * lastSeenTick is how `submit()` refreshes wanted cache entries.
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

  *iterateTier(tier: EvictionTier): Iterable<CacheEntry> {
    for (const entityMap of this.store.values()) {
      for (const entry of entityMap.values()) {
        if (entry.tier === tier) yield entry;
      }
    }
  }

  /** An entry holding the image's chunk, under any entity. */
  findByImageChunk(imageId: string, c: number, chunkKey: string): CacheEntry | undefined {
    return this.byImageChunk.get(imageChunkKey(imageId, c, chunkKey))?.[0];
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
        this.countLevel(entry.level, -1);
        this.unindex(entry);
        this.order.remove();
      }
      this.store.delete(entityId);
    }
  }

  reset(): void {
    this.store.clear();
    this.byImageChunk.clear();
    this.order.invalidate();
    this.bytesCounter = 0;
    this.levelCounts.length = 0;
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
    this.order.invalidate();
  }
}
