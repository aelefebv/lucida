/** Reactive chunk cache + fetcher. Replaces ChunkCache + ChunkManager. */
import { useSyncExternalStore } from "react";
import type { DatasetInfo } from "./metadata.ts";
import { loadChunk } from "./chunkLoader.ts";

export interface ChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  key: string;
}

const MAX_CONCURRENT = 6;

export class ChunkStore {
  private cache = new Map<string, ArrayBuffer>();
  private version = 0;
  private listeners = new Set<() => void>();
  private inFlight = new Set<string>();
  private generation = 0;
  private abortController: AbortController | null = null;
  private bumpScheduled = false;

  private fileIndex: Map<string, File>;
  private datasetInfo: DatasetInfo;

  constructor(fileIndex: Map<string, File>, datasetInfo: DatasetInfo) {
    this.fileIndex = fileIndex;
    this.datasetInfo = datasetInfo;
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

    // If all uncached coords are already in-flight, no work needed
    if (uncached.every(c => this.inFlight.has(c.key))) return;

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

    this.fetchWithConcurrency(uncached, signal, gen);
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
    queueMicrotask(() => {
      this.bumpScheduled = false;
      this.version++;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  private async fetchWithConcurrency(
    coords: ChunkCoord[],
    signal: AbortSignal,
    gen: number,
  ): Promise<void> {
    const queue = [...coords];

    const fetchOne = async (): Promise<void> => {
      while (queue.length > 0) {
        if (signal.aborted || gen !== this.generation) return;

        const coord = queue.shift()!;
        const key = coord.key;
        const levelMeta = this.datasetInfo.levels[coord.level];
        if (!levelMeta) continue;

        try {
          const data = await loadChunk(
            this.fileIndex,
            levelMeta.path,
            coord.t,
            coord.c,
            coord.z,
            coord.y,
            coord.x,
            levelMeta.codecs,
            signal,
          );

          if (signal.aborted || gen !== this.generation) return;

          this.cache.set(key, data);
          this.inFlight.delete(key);
          this.bumpVersion();
        } catch (err) {
          this.inFlight.delete(key);
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.warn(`Failed to load chunk ${key}:`, err);
        }
      }
    };

    const workerCount = Math.min(MAX_CONCURRENT, coords.length);
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
