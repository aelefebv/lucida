/**
 * ProxyStore — per-dataset cache of decoded proxy assets (Group/Tile).
 *
 * Wraps `Map<datasetId, Map<innerKey, ProxyCacheEntry>>` plus a bytes
 * counter, a budget, and an {@link EvictionPolicy}. The two-level Map
 * lets dataset removal drop the whole subtree in one shot via
 * {@link cancelDataset}.
 *
 * Eviction is pure LRU across datasets — proxies are sacrificial; the
 * orchestrator re-fetches via {@link getCachedProxy} when the worker
 * reports a slot eviction. Insert + eviction collapse into one call.
 *
 * Public surface of {@link CpuCache} is unchanged; this is an internal
 * collaborator. Nothing outside `pipeline/fetch/` should import it.
 */

import type { ProxyHeaderJs } from "./contentSource.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { EvictableEntry, EvictionPolicy } from "./eviction.ts";

/**
 * Per-entry record for the proxy cache. Owned by ProxyStore — the
 * shape is internal to fetch/. Re-exported via cpuCache.ts only as
 * needed; callers outside fetch/ don't see it.
 */
export interface ProxyCacheEntry {
  header: ProxyHeaderJs;
  data: ArrayBuffer;
  bytes: number;
  datasetId: string;
  entityId: string;
  imageId: string;
  proxyKind: "GroupProxy3D" | "TileProxy3D";
  t: number;
  c: number;
  insertedAt: number;
  epochs: SceneEpochs;
  /** Priority recorded the last time this proxy appeared in a plan. */
  priority: number;
  /** Plan-rebuild generation from the last plan that wanted this proxy. */
  lastSeenTick: number;
}

/**
 * Adapter shape passed to {@link LRUPolicy} for proxy eviction. Maps
 * `ProxyCacheEntry.bytes` → `sizeBytes` for the policy interface while
 * carrying the `datasetId` + inner-map `key` the store needs to remove
 * the victim from its two-level Map.
 */
export interface ProxyEvictable extends EvictableEntry {
  datasetId: string;
  key: string;
  entry: ProxyCacheEntry;
}

/** Constructor options for {@link ProxyStore}. */
export interface ProxyStoreOptions {
  /** Eviction policy (pure LRU across all datasets). */
  policy: EvictionPolicy<ProxyEvictable>;
  /** Byte budget; entries are evicted to stay at or under it. */
  budgetBytes: number;
  /** Telemetry sink invoked once per evicted entry (label is "proxy"). */
  recordEviction: () => void;
}

/** Per-entry dump record (mirrors `getProxyCacheDump`). */
export interface ProxyStoreDumpEntry {
  datasetId: string;
  entityId: string;
  proxyKind: "GroupProxy3D" | "TileProxy3D";
  t: number;
  c: number;
  bytes: number;
  insertedAt: number;
}

/**
 * Compose the inner proxy cache key. Entries are partitioned per-dataset
 * (outer Map) so dataset removal can drop the whole subtree at once.
 * The cache is keyed by (entity, kind, t, c); the dataset id is the
 * outer-map key.
 */
export function proxyInnerKey(req: {
  entityId: string;
  kind: string;
  t: number;
  c: number;
}): string {
  return `${req.entityId}|${req.kind}|${req.t}|${req.c}`;
}

export class ProxyStore {
  /** `Map<datasetId, Map<innerKey, ProxyCacheEntry>>`. */
  private store = new Map<string, Map<string, ProxyCacheEntry>>();
  private bytesCounter = 0;
  readonly budgetBytes: number;
  private readonly policy: EvictionPolicy<ProxyEvictable>;
  private readonly recordEviction: () => void;

  constructor(opts: ProxyStoreOptions) {
    this.policy = opts.policy;
    this.budgetBytes = opts.budgetBytes;
    this.recordEviction = opts.recordEviction;
  }

  /** Current bytes held by the store. */
  get bytes(): number {
    return this.bytesCounter;
  }

  /** Insert a decoded proxy entry, evicting first if needed. */
  insert(datasetId: string, innerKey: string, entry: ProxyCacheEntry): void {
    this.evictIfNeeded(entry.bytes);

    let datasetMap = this.store.get(datasetId);
    if (!datasetMap) {
      datasetMap = new Map();
      this.store.set(datasetId, datasetMap);
    }
    datasetMap.set(innerKey, entry);
    this.bytesCounter += entry.bytes;
  }

  private evictIfNeeded(incomingBytes: number): void {
    if (this.bytesCounter + incomingBytes <= this.budgetBytes) return;
    const needed = this.bytesCounter + incomingBytes - this.budgetBytes;

    // Flatten into an adapter shape that exposes `sizeBytes` to the
    // policy while keeping the back-references needed to remove
    // entries from the two-level Map. The proxy entry's own `bytes`
    // tile is mapped to `sizeBytes` so {@link LRUPolicy} can serve
    // both cache shapes without ProxyCacheEntry having to rename its
    // tile.
    const evictables: ProxyEvictable[] = [];
    for (const [datasetId, inner] of this.store) {
      for (const [k, e] of inner) {
        evictables.push({
          insertedAt: e.insertedAt,
          sizeBytes: e.bytes,
          datasetId,
          key: k,
          entry: e,
        });
      }
    }

    const victims = this.policy.selectVictims(evictables, needed);
    for (const v of victims) {
      const inner = this.store.get(v.datasetId);
      if (inner) {
        inner.delete(v.key);
        if (inner.size === 0) this.store.delete(v.datasetId);
      }
      this.bytesCounter -= v.entry.bytes;
      this.recordEviction();
    }
  }

  /** Remove a single proxy by (datasetId, innerKey); returns true if present. */
  remove(datasetId: string, innerKey: string): boolean {
    const inner = this.store.get(datasetId);
    if (!inner) return false;
    const entry = inner.get(innerKey);
    if (!entry) return false;
    inner.delete(innerKey);
    if (inner.size === 0) this.store.delete(datasetId);
    this.bytesCounter -= entry.bytes;
    return true;
  }

  /** Lookup by (datasetId, innerKey). */
  get(datasetId: string, innerKey: string): ProxyCacheEntry | undefined {
    return this.store.get(datasetId)?.get(innerKey);
  }

  /** Whether the store holds an entry under (datasetId, innerKey). */
  has(datasetId: string, innerKey: string): boolean {
    return this.store.get(datasetId)?.has(innerKey) === true;
  }

  *iterateSeenAt(lastSeenTick: number): Iterable<ProxyCacheEntry> {
    for (const inner of this.store.values()) {
      for (const entry of inner.values()) {
        if (entry.lastSeenTick === lastSeenTick) yield entry;
      }
    }
  }

  /**
   * Drop every entry under the given datasetId. Bytes counter is
   * decremented; no eviction-records are emitted (dataset removal,
   * not a policy decision).
   */
  cancelDataset(datasetId: string): void {
    const inner = this.store.get(datasetId);
    if (!inner) return;
    for (const entry of inner.values()) {
      this.bytesCounter -= entry.bytes;
    }
    this.store.delete(datasetId);
  }

  /** Clear every entry and zero the bytes counter. */
  reset(): void {
    this.store.clear();
    this.bytesCounter = 0;
  }

  /** Per-entry dump for the DebugPanel. */
  dump(): ProxyStoreDumpEntry[] {
    const out: ProxyStoreDumpEntry[] = [];
    for (const [datasetId, inner] of this.store) {
      for (const e of inner.values()) {
        out.push({
          datasetId,
          entityId: e.entityId,
          proxyKind: e.proxyKind,
          t: e.t,
          c: e.c,
          bytes: e.bytes,
          insertedAt: e.insertedAt,
        });
      }
    }
    return out;
  }

  /** Aggregate `{count, bytes}` — used by telemetry's `tierResidency.proxy`. */
  totalResidency(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const inner of this.store.values()) {
      for (const e of inner.values()) {
        count++;
        bytes += e.bytes;
      }
    }
    return { count, bytes };
  }
}
