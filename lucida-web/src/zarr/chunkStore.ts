/** Shared chunk fetch queue with cross-member spatial priority. */

export interface ChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  key: string;
}

/** A ChunkCoord qualified with its owning member. */
export interface QualifiedChunkCoord extends ChunkCoord {
  memberId: string;
}

/** A function that fetches a single chunk's decompressed data. */
export type ChunkFetcher = (coord: ChunkCoord, signal?: AbortSignal) => Promise<ArrayBuffer>;

const DEFAULT_MAX_CONCURRENT = 12;
const MAX_CACHE_BYTES = 512 * 1024 * 1024; // 512 MB

/**
 * A shared fetch queue for an entire dataset. All members share global
 * concurrency (default 12, scalable for multi-channel) and a single abort/priority mechanism.
 * Cache lookups remain per-member so the render loop can query
 * "does member X have chunk Y".
 */
export class SharedChunkQueue {
  /** memberId → chunkKey → ArrayBuffer */
  private cache = new Map<string, Map<string, ArrayBuffer>>();
  private version = 0;
  private listeners = new Set<() => void>();
  private inFlight = new Set<string>();
  private inFlightSince = 0;
  private abortController: AbortController | null = null;
  private bumpScheduled = false;
  private pendingQueue: QualifiedChunkCoord[] = [];
  private fetchers = new Map<string, ChunkFetcher>();
  private activeWorkerCount = 0;
  private activeFetches = new Set<string>();
  private workerGeneration = 0;
  private maxConcurrent = DEFAULT_MAX_CONCURRENT;

  /** LRU eviction state */
  private totalBytes = 0;
  private entryInfo = new Map<string, { memberId: string; chunkKey: string; size: number }>();
  private lruOrder = new Set<string>();

  /** Composite cache key incorporating memberId. */
  private compositeKey(memberId: string, chunkKey: string): string {
    return `${memberId}/${chunkKey}`;
  }

  /** Adjust max concurrent fetches (e.g. scale by active channel count). */
  setConcurrency(n: number): void {
    const prev = this.maxConcurrent;
    this.maxConcurrent = n;
    if (n > prev && this.pendingQueue.length > 0) {
      this.launchFetchTasks();
    }
  }

  /** Register a member's fetcher function. */
  registerMember(memberId: string, fetcher: ChunkFetcher): void {
    this.fetchers.set(memberId, fetcher);
    if (!this.cache.has(memberId)) {
      this.cache.set(memberId, new Map());
    }
  }

  /** Remove a member and its cached data. */
  removeMember(memberId: string): void {
    this.fetchers.delete(memberId);
    const memberCache = this.cache.get(memberId);
    if (memberCache) {
      for (const chunkKey of memberCache.keys()) {
        const ck = this.compositeKey(memberId, chunkKey);
        const info = this.entryInfo.get(ck);
        if (info) {
          this.totalBytes -= info.size;
          this.entryInfo.delete(ck);
        }
        this.lruOrder.delete(ck);
      }
    }
    this.cache.delete(memberId);
    // Clean up in-flight entries for this member
    const prefix = memberId + "/";
    for (const key of this.inFlight) {
      if (key.startsWith(prefix)) this.inFlight.delete(key);
    }
    for (const key of this.activeFetches) {
      if (key.startsWith(prefix)) this.activeFetches.delete(key);
    }
    this.pendingQueue = this.pendingQueue.filter(c => c.memberId !== memberId);
  }

  // --- React subscription via useSyncExternalStore ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => {
    return this.version;
  };

  // --- Synchronous pull — viewers call this at paint time ---

  get(memberId: string, key: string): ArrayBuffer | null {
    const buf = this.cache.get(memberId)?.get(key) ?? null;
    if (buf) {
      const ck = this.compositeKey(memberId, key);
      this.lruOrder.delete(ck);
      this.lruOrder.add(ck);
    }
    return buf;
  }

  has(memberId: string, key: string): boolean {
    return this.cache.get(memberId)?.has(key) ?? false;
  }

  /** Iterate registered member IDs. */
  memberIds(): IterableIterator<string> {
    return this.fetchers.keys();
  }

  /** Check if a member is registered. */
  hasMember(memberId: string): boolean {
    return this.fetchers.has(memberId);
  }

  // --- Background fetching with incremental add/abort pattern ---

  /** Accept a unified, pre-prioritized fetch list covering all members. */
  ensureFetched(coords: QualifiedChunkCoord[]): void {
    const uncached: QualifiedChunkCoord[] = [];
    for (const coord of coords) {
      if (!this.has(coord.memberId, coord.key)) uncached.push(coord);
    }
    if (uncached.length === 0) return;

    const newChunks = uncached.filter(c => !this.inFlight.has(this.compositeKey(c.memberId, c.key)));
    const isStale = this.inFlightSince > 0
      && performance.now() - this.inFlightSince > 15_000;

    // Path 1: all uncached already in-flight and not stale → reorder only
    if (newChunks.length === 0 && !isStale) {
      this.pendingQueue.length = 0;
      for (const coord of uncached) {
        if (!this.activeFetches.has(this.compositeKey(coord.memberId, coord.key))) {
          this.pendingQueue.push(coord);
        }
      }
      // If workers exited but pending items remain, restart them
      if (this.pendingQueue.length > 0 && this.activeWorkerCount === 0) {
        this.launchFetchTasks();
      }
      // Only reset stale timer if workers are actively making progress
      if (this.activeWorkerCount > 0) {
        this.inFlightSince = performance.now();
      }
      return;
    }

    // Decide: abort everything or add incrementally
    const shouldAbort = isStale
      || (this.inFlight.size > 0 && !uncached.some(c => this.inFlight.has(this.compositeKey(c.memberId, c.key))));

    if (shouldAbort) {
      // Path 3: complete view change or stale — abort and restart
      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();
      this.workerGeneration++;
      this.activeWorkerCount = 0;
      this.activeFetches.clear();
      this.inFlight.clear();
      this.inFlightSince = performance.now();
      for (const coord of uncached) this.inFlight.add(this.compositeKey(coord.memberId, coord.key));
      this.pendingQueue = [...uncached];
      this.launchFetchTasks();
      return;
    }

    // Path 2: incremental — add new chunks, keep existing fetches running
    for (const chunk of newChunks) this.inFlight.add(this.compositeKey(chunk.memberId, chunk.key));
    this.inFlightSince = performance.now();

    // Rebuild pending queue from new plan, excluding actively-fetching items
    this.pendingQueue.length = 0;
    for (const coord of uncached) {
      if (!this.activeFetches.has(this.compositeKey(coord.memberId, coord.key))) {
        this.pendingQueue.push(coord);
      }
    }

    // Clean up inFlight: remove items no longer in plan and not being actively fetched
    const newPlanKeys = new Set(uncached.map(c => this.compositeKey(c.memberId, c.key)));
    for (const key of this.inFlight) {
      if (!newPlanKeys.has(key) && !this.activeFetches.has(key)) {
        this.inFlight.delete(key);
      }
    }

    this.launchFetchTasks();
  }

  destroy(): void {
    if (this.abortController) this.abortController.abort();
    this.listeners.clear();
    this.inFlight.clear();
    this.activeFetches.clear();
    this.activeWorkerCount = 0;
    this.totalBytes = 0;
    this.entryInfo.clear();
    this.lruOrder.clear();
  }

  // --- Internal ---

  private evictIfNeeded(): void {
    while (this.totalBytes > MAX_CACHE_BYTES && this.lruOrder.size > 0) {
      const oldest = this.lruOrder.values().next().value;
      if (!oldest) break;
      this.lruOrder.delete(oldest);
      const info = this.entryInfo.get(oldest);
      if (info) {
        this.entryInfo.delete(oldest);
        this.totalBytes -= info.size;
        this.cache.get(info.memberId)?.delete(info.chunkKey);
      }
    }
  }

  private bumpVersion(): void {
    if (this.bumpScheduled) return;
    this.bumpScheduled = true;
    setTimeout(() => {
      this.bumpScheduled = false;
      this.version++;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  private launchFetchTasks(): void {
    if (!this.abortController) this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const gen = this.workerGeneration;
    const toStart = Math.min(
      this.maxConcurrent - this.activeWorkerCount,
      this.pendingQueue.length,
    );
    for (let i = 0; i < toStart; i++) {
      this.activeWorkerCount++;
      this.runFetchTask(signal, gen);
    }
  }

  private async runFetchTask(signal: AbortSignal, gen: number): Promise<void> {
    try {
      while (this.pendingQueue.length > 0) {
        if (signal.aborted) return;
        const coord = this.pendingQueue.shift()!;
        const compositeKey = this.compositeKey(coord.memberId, coord.key);

        if (this.has(coord.memberId, coord.key)) {
          this.inFlight.delete(compositeKey);
          continue;
        }

        const fetcher = this.fetchers.get(coord.memberId);
        if (!fetcher) {
          this.inFlight.delete(compositeKey);
          continue;
        }

        this.activeFetches.add(compositeKey);
        try {
          const data = await fetcher(coord, signal);
          if (signal.aborted) return;
          let memberCache = this.cache.get(coord.memberId);
          if (!memberCache) {
            memberCache = new Map();
            this.cache.set(coord.memberId, memberCache);
          }
          memberCache.set(coord.key, data);
          const ck = this.compositeKey(coord.memberId, coord.key);
          this.entryInfo.set(ck, { memberId: coord.memberId, chunkKey: coord.key, size: data.byteLength });
          this.lruOrder.add(ck);
          this.totalBytes += data.byteLength;
          this.evictIfNeeded();
          this.inFlight.delete(compositeKey);
          this.bumpVersion();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (signal.aborted) return;
          this.inFlight.delete(compositeKey);
          console.error(`Chunk ${compositeKey} fetch failed, skipping.`, err);
          this.bumpVersion();
        } finally {
          this.activeFetches.delete(compositeKey);
        }
      }
    } finally {
      if (gen === this.workerGeneration) {
        this.activeWorkerCount--;
      }
    }
  }
}
