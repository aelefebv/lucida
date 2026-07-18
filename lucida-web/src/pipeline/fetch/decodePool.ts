/**
 * Codec-agnostic decode worker pool.
 *
 * Dispatches decompression + pixel-format normalization to Web Workers.
 * Returns GPU-ready Uint16Array buffers.
 */

import type { WireFormat } from "../../manifestTypes.ts";
import type { ChunkContract } from "../../chunkContract.ts";

export const MIN_DECODE_WORKERS = 2;
export const DECODE_POOL_HEADROOM = 1;

export function defaultPoolSize(): number {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
  return Math.max(MIN_DECODE_WORKERS, Math.floor(cores / 2) - DECODE_POOL_HEADROOM);
}

interface PendingEntry {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingEntry>;
  activeCount: number;
  restartCount: number;
}

const MAX_WORKER_RESTARTS_WITHOUT_SUCCESS = 1;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class DecodePool {
  private pool: PoolWorker[] = [];
  private nextId = 0;
  private permanentlyTerminated = false;
  private terminalError: Error | null = null;
  private terminalCause: Error | null = null;
  private readonly configuredSize: number;
  private failureListener: ((error: Error, terminal: boolean) => void) | null = null;

  /**
   * Observability hook for automatic recovery or terminal pool failure.
   * Assigning it after construction replays an already-terminal startup
   * failure, closing the synchronous `new Worker()` notification race.
   */
  get onFailure(): ((error: Error, terminal: boolean) => void) | null {
    return this.failureListener;
  }

  set onFailure(listener: ((error: Error, terminal: boolean) => void) | null) {
    if (this.failureListener === listener) return;
    this.failureListener = listener;
    if (
      listener &&
      this.terminalCause &&
      !this.permanentlyTerminated &&
      this.pool.length === 0
    ) {
      listener(this.terminalCause, true);
    }
  }

  constructor(poolSize?: number) {
    const size = poolSize ?? defaultPoolSize();
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(`Invalid decode pool size: ${size}`);
    }
    this.configuredSize = size;
    try {
      this.pool = this.createConfiguredPool();
    } catch (error) {
      // Worker construction is a synchronous browser boundary (CSP, process
      // exhaustion, unsupported module workers). Keep the object usable so a
      // later listener sees the terminal state and retry() can recover.
      this.enterTerminal(asError(error));
    }
  }

  /** All-or-nothing pool startup; terminate partial construction on failure. */
  private createConfiguredPool(): PoolWorker[] {
    const workers: PoolWorker[] = [];
    try {
      for (let i = 0; i < this.configuredSize; i++) {
        workers.push(this.createWorker(0));
      }
      return workers;
    } catch (error) {
      for (const entry of workers) entry.worker.terminate();
      throw error;
    }
  }

  private createWorker(restartCount: number): PoolWorker {
    const worker = new Worker(new URL("./decode.worker.ts", import.meta.url), {
      type: "module",
    });
    const entry: PoolWorker = {
      worker,
      pending: new Map(),
      activeCount: 0,
      restartCount,
    };
    worker.onmessage = (e: MessageEvent<{ id: number; data?: ArrayBuffer; error?: string }>) => {
      const message = e.data;
      if (!message || !Number.isSafeInteger(message.id)) {
        this.failWorker(entry, new Error("Decode worker sent an invalid response"));
        return;
      }
      const pending = entry.pending.get(message.id);
      if (!pending) return; // late response after failure/termination
      entry.pending.delete(message.id);
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      // Any valid reply proves the replacement is healthy; a later crash gets
      // its own one-shot restart instead of inheriting stale failure history.
      entry.restartCount = 0;
      if (message.error) {
        pending.reject(new Error(message.error));
      } else if (message.data instanceof ArrayBuffer) {
        pending.resolve(message.data);
      } else {
        pending.reject(new Error("Decode worker response did not include data"));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      this.failWorker(entry, new Error(event.message || "Decode worker crashed"));
    };
    worker.onmessageerror = () => {
      this.failWorker(entry, new Error("Decode worker message could not be deserialized"));
    };
    return entry;
  }

  /** Reject every job on one failed worker exactly once, then replace or retire it. */
  private failWorker(entry: PoolWorker, error: Error): void {
    const index = this.pool.indexOf(entry);
    if (index < 0) return; // duplicate error/messageerror from an already-retired worker

    entry.worker.terminate();
    for (const pending of entry.pending.values()) pending.reject(error);
    entry.pending.clear();
    entry.activeCount = 0;

    if (
      !this.permanentlyTerminated &&
      entry.restartCount < MAX_WORKER_RESTARTS_WITHOUT_SUCCESS
    ) {
      try {
        this.pool[index] = this.createWorker(entry.restartCount + 1);
        this.failureListener?.(error, false);
      } catch (replacementFailure) {
        // Never leave the terminated entry selectable. A surviving sibling
        // keeps the pool degraded-but-usable; losing the final slot enters the
        // same explicit terminal/retry state as repeated runtime crashes.
        this.pool.splice(index, 1);
        const cause = new Error(
          `Decode worker replacement could not start: ${asError(replacementFailure).message}`,
        );
        if (this.pool.length === 0) this.enterTerminal(cause);
        else this.failureListener?.(cause, false);
      }
      return;
    }

    this.pool.splice(index, 1);
    if (this.pool.length === 0) this.enterTerminal(error);
    else this.failureListener?.(error, false);
  }

  private enterTerminal(error: Error): void {
    if (this.permanentlyTerminated) return;
    this.terminalCause = error;
    this.terminalError = new Error(`DecodePool unavailable: ${error.message}`);
    this.failureListener?.(error, true);
  }

  /** Decode raw wire-format bytes. Returns data in its native format (uint8 stays uint8). */
  decode(
    bytes: ArrayBuffer,
    wireFormat: WireFormat,
    contract: ChunkContract,
  ): Promise<ArrayBuffer> {
    if (this.pool.length === 0) {
      return Promise.reject(
        this.terminalError ?? new Error("DecodePool terminated"),
      );
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let best = this.pool[0];
      for (let i = 1; i < this.pool.length; i++) {
        if (this.pool[i].activeCount < best.activeCount) best = this.pool[i];
      }
      best.pending.set(id, { resolve, reject });
      best.activeCount++;
      try {
        best.worker.postMessage({ id, bytes, wireFormat, contract }, [bytes]);
      } catch (err) {
        best.pending.delete(id);
        best.activeCount = Math.max(0, best.activeCount - 1);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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

  /** Recreate a pool that entered its retryable terminal state. */
  retry(): boolean {
    if (this.permanentlyTerminated || this.pool.length > 0 || !this.terminalError) {
      return false;
    }
    try {
      this.pool = this.createConfiguredPool();
    } catch (error) {
      this.enterTerminal(asError(error));
      return false;
    }
    this.terminalError = null;
    this.terminalCause = null;
    return true;
  }

  /**
   * Kill every worker and settle its outstanding decodes with a rejection so
   * awaiting fetch chains complete instead of hanging on promises whose
   * worker can no longer reply. Idempotent; `decode` calls made after
   * termination reject immediately.
   */
  terminate(): void {
    this.permanentlyTerminated = true;
    this.terminalError = null;
    this.terminalCause = null;
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
