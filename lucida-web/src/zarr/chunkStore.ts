/** Reactive chunk cache + fetcher. Replaces ChunkCache + ChunkManager. */
import { useSyncExternalStore } from "react";

export interface ChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  key: string;
}

/** A function that fetches a single chunk's decompressed data. */
export type ChunkFetcher = (coord: ChunkCoord, signal?: AbortSignal) => Promise<ArrayBuffer>;

const MAX_CONCURRENT = 6;

export class ChunkStore {
  private cache = new Map<string, ArrayBuffer>();
  private version = 0;
  private listeners = new Set<() => void>();
  private inFlight = new Set<string>();
  private inFlightSince = 0;
  private abortController: AbortController | null = null;
  private bumpScheduled = false;
  private pendingQueue: ChunkCoord[] = [];
  private fetcher: ChunkFetcher;
  private activeWorkerCount = 0;
  private activeFetches = new Set<string>();

  constructor(fetcher: ChunkFetcher) {
    this.fetcher = fetcher;
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

  get(key: string): ArrayBuffer | null {
    return this.cache.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  // --- Background fetching with incremental add/abort pattern ---

  ensureFetched(coords: ChunkCoord[]): void {
    const uncached: ChunkCoord[] = [];
    for (const coord of coords) {
      if (!this.cache.has(coord.key)) uncached.push(coord);
    }
    if (uncached.length === 0) return;

    const newChunks = uncached.filter(c => !this.inFlight.has(c.key));
    const isStale = this.inFlightSince > 0
      && performance.now() - this.inFlightSince > 15_000;

    // Path 1: all uncached already in-flight and not stale → reorder only
    if (newChunks.length === 0 && !isStale) {
      this.pendingQueue.length = 0;
      for (const coord of uncached) {
        if (!this.activeFetches.has(coord.key)) {
          this.pendingQueue.push(coord);
        }
      }
      return;
    }

    // Decide: abort everything or add incrementally
    const shouldAbort = isStale
      || (this.inFlight.size > 0 && !uncached.some(c => this.inFlight.has(c.key)));

    if (shouldAbort) {
      // Path 3: complete view change or stale — abort and restart
      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();
      this.activeWorkerCount = 0;
      this.activeFetches.clear();
      this.inFlight.clear();
      this.inFlightSince = performance.now();
      for (const coord of uncached) this.inFlight.add(coord.key);
      this.pendingQueue = [...uncached];
      this.launchWorkers();
      return;
    }

    // Path 2: incremental — add new chunks, keep existing fetches running
    for (const chunk of newChunks) this.inFlight.add(chunk.key);
    this.inFlightSince = performance.now();

    // Rebuild pending queue from new plan, excluding actively-fetching items
    this.pendingQueue.length = 0;
    for (const coord of uncached) {
      if (!this.activeFetches.has(coord.key)) {
        this.pendingQueue.push(coord);
      }
    }

    // Clean up inFlight: remove items no longer in plan and not being actively fetched
    const newPlanKeys = new Set(uncached.map(c => c.key));
    for (const key of this.inFlight) {
      if (!newPlanKeys.has(key) && !this.activeFetches.has(key)) {
        this.inFlight.delete(key);
      }
    }

    this.launchWorkers();
  }

  destroy(): void {
    if (this.abortController) this.abortController.abort();
    this.listeners.clear();
    this.inFlight.clear();
    this.activeFetches.clear();
    this.activeWorkerCount = 0;
  }

  // --- Internal ---

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

  private launchWorkers(): void {
    if (!this.abortController) this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const toStart = Math.min(
      MAX_CONCURRENT - this.activeWorkerCount,
      this.pendingQueue.length,
    );
    for (let i = 0; i < toStart; i++) {
      this.activeWorkerCount++;
      this.runWorker(signal);
    }
  }

  private async runWorker(signal: AbortSignal): Promise<void> {
    try {
      while (this.pendingQueue.length > 0) {
        if (signal.aborted) return;
        const coord = this.pendingQueue.shift()!;
        const key = coord.key;

        if (this.cache.has(key)) {
          this.inFlight.delete(key);
          continue;
        }

        this.activeFetches.add(key);
        try {
          const data = await this.fetcher(coord, signal);
          if (signal.aborted) return;
          this.cache.set(key, data);
          this.inFlight.delete(key);
          this.bumpVersion();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (signal.aborted) return;
          this.inFlight.delete(key);
          console.error(`Chunk ${key} fetch failed, skipping.`, err);
          this.bumpVersion();
        } finally {
          this.activeFetches.delete(key);
        }
      }
    } finally {
      this.activeWorkerCount--;
    }
  }
}

/** React hook to subscribe to ChunkStore updates. */
export function useChunkStore(store: ChunkStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}
