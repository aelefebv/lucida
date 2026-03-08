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
  private generation = 0;
  private abortController: AbortController | null = null;
  private bumpScheduled = false;
  private pendingQueue: ChunkCoord[] = [];
  private fetcher: ChunkFetcher;

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

  // --- Background fetching with abort/generation pattern ---

  ensureFetched(coords: ChunkCoord[]): void {
    // Filter by cache only — NOT by in-flight
    const uncached: ChunkCoord[] = [];
    for (const coord of coords) {
      const key = coord.key;
      if (!this.cache.has(key)) {
        uncached.push(coord);
      }
    }
    if (uncached.length === 0) return;

    // If all uncached coords are already in-flight, just reorder the pending queue
    // so that future chunk fetches use the new priority order (e.g. after camera pan).
    if (uncached.every(c => this.inFlight.has(c.key))) {
      // Replace pending queue with new order, filtering out already-actively-loading items
      const activelyLoading = new Set<string>();
      for (const key of this.inFlight) {
        if (!this.pendingQueue.some(c => c.key === key)) {
          activelyLoading.add(key);
        }
      }
      this.pendingQueue.length = 0;
      for (const coord of uncached) {
        if (!activelyLoading.has(coord.key)) {
          this.pendingQueue.push(coord);
        }
      }
      return;
    }

    // New work needed — abort previous and start fresh with ALL uncached
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    this.inFlight.clear();
    const signal = this.abortController.signal;
    const gen = ++this.generation;

    for (const coord of uncached) {
      this.inFlight.add(coord.key);
    }

    this.pendingQueue = [...uncached];
    this.fetchWithConcurrency(signal, gen);
  }

  destroy(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.listeners.clear();
    this.inFlight.clear();
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

  private async fetchWithConcurrency(
    signal: AbortSignal,
    gen: number,
  ): Promise<void> {
    const fetchOne = async (): Promise<void> => {
      while (this.pendingQueue.length > 0) {
        if (signal.aborted || gen !== this.generation) return;

        const coord = this.pendingQueue.shift()!;
        const key = coord.key;

        try {
          const data = await this.fetcher(coord, signal);

          if (signal.aborted || gen !== this.generation) return;

          this.cache.set(key, data);
          this.inFlight.delete(key);
          this.bumpVersion();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (signal.aborted || gen !== this.generation) return;

          this.inFlight.delete(key);
          console.error(`Chunk ${key} fetch failed, skipping.`, err);
          this.bumpVersion();
        }
      }
    };

    const workerCount = Math.min(MAX_CONCURRENT, this.pendingQueue.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(fetchOne());
    }
    await Promise.all(workers);
  }
}

/** React hook to subscribe to ChunkStore updates. */
export function useChunkStore(store: ChunkStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}
