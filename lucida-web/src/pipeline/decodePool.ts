/**
 * Codec-agnostic decode worker pool.
 *
 * Dispatches decompression + pixel-format normalization to Web Workers.
 * Returns GPU-ready Uint16Array buffers.
 */

import type { WireFormat } from "../contentTypes.ts";

// ---------------------------------------------------------------------------
// Constants (exported for CpuCacheConfig)
// ---------------------------------------------------------------------------

export const MIN_DECODE_WORKERS = 2;
export const DECODE_POOL_HEADROOM = 1;

export function defaultPoolSize(): number {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
  return Math.max(MIN_DECODE_WORKERS, Math.floor(cores / 2) - DECODE_POOL_HEADROOM);
}

// ---------------------------------------------------------------------------
// Pool worker bookkeeping
// ---------------------------------------------------------------------------

interface PoolWorker {
  worker: Worker;
  pending: Map<number, (data: ArrayBuffer) => void>;
  activeCount: number;
}

// ---------------------------------------------------------------------------
// DecodePool
// ---------------------------------------------------------------------------

export class DecodePool {
  private pool: PoolWorker[];
  private nextId = 0;

  constructor(poolSize?: number) {
    const size = poolSize ?? defaultPoolSize();
    this.pool = Array.from({ length: size }, () => {
      const w = new Worker(new URL("./decode.worker.ts", import.meta.url), {
        type: "module",
      });
      const pending = new Map<number, (data: ArrayBuffer) => void>();
      const entry: PoolWorker = { worker: w, pending, activeCount: 0 };
      w.onmessage = (e: MessageEvent<{ id: number; data: ArrayBuffer }>) => {
        const { id, data } = e.data;
        const resolve = pending.get(id);
        if (resolve) {
          pending.delete(id);
          entry.activeCount--;
          resolve(data);
        }
      };
      return entry;
    });
  }

  /** Decode raw wire-format bytes into a GPU-ready Uint16 buffer. */
  decode(bytes: ArrayBuffer, wireFormat: WireFormat, dataType: string): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      // Pick least-busy worker
      let best = this.pool[0];
      for (let i = 1; i < this.pool.length; i++) {
        if (this.pool[i].activeCount < best.activeCount) best = this.pool[i];
      }
      best.pending.set(id, resolve);
      best.activeCount++;
      best.worker.postMessage({ id, bytes, wireFormat, dataType }, [bytes]);
    });
  }

  /** Number of workers currently busy. */
  activeCount(): number {
    let n = 0;
    for (const w of this.pool) n += w.activeCount;
    return n;
  }

  /** Total number of workers in the pool. */
  get size(): number {
    return this.pool.length;
  }

  /** Terminate all workers. */
  terminate(): void {
    for (const w of this.pool) w.worker.terminate();
    this.pool = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract data_type string from a WireFormat variant. */
export function extractDataType(wf: WireFormat): string {
  if ("Raw" in wf) return wf.Raw.data_type;
  if ("Lz4" in wf) return wf.Lz4.data_type;
  if ("Zstd" in wf) return wf.Zstd.data_type;
  return "uint16";
}
