/**
 * Codec-agnostic decode worker pool.
 *
 * Dispatches decompression + pixel-format normalization to Web Workers.
 * Returns GPU-ready Uint16Array buffers.
 */

import type { WireFormat } from "../../manifestTypes.ts";
import { takeWorkerError } from "../../pageErrors.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { CountedPhaseIndex } from "../../trace/types.ts";
import type { DecodeTiming } from "./decode.worker.ts";

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
   * The pool's own `id` is a slot number with no meaning outside the pool,
   * so this is what joins a decode to its chunk. -1 when no run is open.
   */
  traceRow: number;
  /** When this thread posted the request, on its own clock. */
  postedAtMs: number;
}

type DecodeReply = Partial<DecodeTiming> & { id: number; data?: ArrayBuffer; error?: string };

/**
 * The worker's own time on one decode, on this thread's clock, or null when
 * the reply carries no timing. Held between the post and the reply, so a skew
 * between the two contexts' time origins can never make the work longer than
 * the round trip this thread saw.
 */
export function decodeWorkMs(
  postedAtMs: number,
  heardAtMs: number,
  reply: Partial<DecodeTiming>,
): number | null {
  if (reply.startedAtMs === undefined || reply.doneAtMs === undefined) return null;
  const startMs = Math.max(postedAtMs, reply.startedAtMs - performance.timeOrigin);
  const endMs = Math.min(heardAtMs, reply.doneAtMs - performance.timeOrigin);
  return Math.max(0, endMs - startMs);
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
      w.onmessage = (e: MessageEvent<DecodeReply>) => {
        if (takeWorkerError(e.data)) return;
        const { id, data, error } = e.data;
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          entry.activeCount--;
          // Closes `decode` and opens `upload`, for a failed decode too: the
          // round trip happened, and the caller retires the row.
          traceRecorder.noteDecoded(p.traceRow, decodeWorkMs(p.postedAtMs, performance.now(), e.data));
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
   * Decode wire-format bytes. Returns data in its native format (uint8
   * stays uint8). `codecs` is the codec list of bytes still in the codecs
   * the chunk was stored in, and `decodedBytes` the size its level's
   * metadata gives, which encoded bytes must decode to exactly.
   *
   * `traceRow` correlates the decode with the chunk that asked for it. The
   * row's `decode` phase is the whole round trip, postMessage out to
   * onmessage in, and the worker's own start and end split it into the
   * decode and the wait for a worker or for this thread.
   */
  decode(
    bytes: ArrayBuffer,
    wireFormat: WireFormat,
    traceRow = -1,
    codecs?: Uint8Array,
    decodedBytes?: number,
  ): Promise<ArrayBuffer> {
    if (this.pool.length === 0) {
      return Promise.reject(new Error("DecodePool terminated"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let best = this.pool[0];
      for (let i = 1; i < this.pool.length; i++) {
        if (this.pool[i].activeCount < best.activeCount) best = this.pool[i];
      }
      best.pending.set(id, { resolve, reject, traceRow, postedAtMs: performance.now() });
      best.activeCount++;
      // Dispatch itself is below the platform's clock floor, so it is counted
      // rather than timed.
      traceRecorder.countPhase(CountedPhaseIndex.WorkerDispatch);
      best.worker.postMessage({ id, bytes, wireFormat, codecs, decodedBytes }, [bytes]);
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
