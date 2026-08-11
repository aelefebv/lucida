/**
 * Codec-agnostic decode worker pool.
 *
 * Dispatches decompression + pixel-format normalization to Web Workers.
 * Returns GPU-ready Uint16Array buffers.
 */

import type { WireFormat } from "../../manifestTypes.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { Boundary, CountedPhaseIndex } from "../../trace/types.ts";

export const MIN_DECODE_WORKERS = 2;
export const DECODE_POOL_HEADROOM = 1;

export function defaultPoolSize(): number {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
  return Math.max(MIN_DECODE_WORKERS, Math.floor(cores / 2) - DECODE_POOL_HEADROOM);
}

interface PendingEntry {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
  /**
   * The caller's lifecycle-row handle for the chunk these bytes belong to.
   *
   * The pool's own `id` is a slot number that means nothing outside the pool,
   * and the chunk key survives only in the caller's promise closure — so
   * without this the one stage in the pipeline with no identity at all stays
   * unjoinable. -1 when the caller holds no row (no run open).
   */
  traceRow: number;
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingEntry>;
  activeCount: number;
}

export class DecodePool {
  private pool: PoolWorker[];
  private nextId = 0;

  constructor(poolSize?: number) {
    const size = poolSize ?? defaultPoolSize();
    this.pool = Array.from({ length: size }, () => {
      const w = new Worker(new URL("./decode.worker.ts", import.meta.url), {
        type: "module",
      });
      const pending = new Map<number, PendingEntry>();
      const entry: PoolWorker = { worker: w, pending, activeCount: 0 };
      w.onmessage = (e: MessageEvent<{ id: number; data?: ArrayBuffer; error?: string }>) => {
        const { id, data, error } = e.data;
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          entry.activeCount--;
          // Closes `decode` and opens `upload` — adjacent phases share the
          // boundary between them. Stamped for a failed decode too: the round
          // trip happened, and the caller retires the row.
          traceRecorder.stamp(p.traceRow, Boundary.UploadStart);
          if (error) {
            p.reject(new Error(error));
          } else {
            p.resolve(data!);
          }
        }
      };
      return entry;
    });
  }

  /**
   * Decode raw wire-format bytes. Returns data in its native format (uint8
   * stays uint8).
   *
   * `traceRow` correlates the decode with the chunk that asked for it. The
   * `decode` phase is the whole round trip — postMessage out to onmessage in,
   * queue wait included — and is named for the round trip so no reader
   * mistakes it for worker CPU time. Nothing in the worker timestamps itself;
   * both ends are read on the main thread off one clock.
   */
  decode(bytes: ArrayBuffer, wireFormat: WireFormat, traceRow = -1): Promise<ArrayBuffer> {
    if (this.pool.length === 0) {
      return Promise.reject(new Error("DecodePool terminated"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let best = this.pool[0];
      for (let i = 1; i < this.pool.length; i++) {
        if (this.pool[i].activeCount < best.activeCount) best = this.pool[i];
      }
      best.pending.set(id, { resolve, reject, traceRow });
      best.activeCount++;
      // Dispatch itself is below the platform's clock floor, so it is counted
      // rather than timed.
      traceRecorder.countPhase(CountedPhaseIndex.WorkerDispatch);
      best.worker.postMessage({ id, bytes, wireFormat }, [bytes]);
    });
  }

  activeCount(): number {
    let n = 0;
    for (const w of this.pool) n += w.activeCount;
    return n;
  }

  get size(): number {
    return this.pool.length;
  }

  /**
   * Kill every worker and settle its outstanding decodes with a rejection so
   * awaiting fetch chains complete instead of hanging on promises whose
   * worker can no longer reply. Idempotent; `decode` calls made after
   * termination reject immediately.
   */
  terminate(): void {
    for (const w of this.pool) {
      w.worker.terminate();
      for (const entry of w.pending.values()) {
        entry.reject(new Error("DecodePool terminated"));
      }
      w.pending.clear();
      w.activeCount = 0;
    }
    this.pool = [];
  }
}
