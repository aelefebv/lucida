/**
 * Pending queue + in-flight tracking + concurrency / bytes caps.
 *
 * Generic over the request shape so one class backs both the chunk and
 * proxy schedulers; the dedup ladder lives in `cpuCache.ts` and feeds
 * this with a pre-deduped list. The scheduler doesn't know about
 * decode, retry, or the cache — the `startFn` callback owns that work
 * and must call back via {@link correctInFlightBytes} +
 * {@link markInFlightDone} to close out the slot.
 */

import type { BurstLogger } from "./telemetry.ts";

export interface SchedulableRequest {
  datasetId: string;
  entityId: string;
}

export interface SchedulerConfig {
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
  burstLogger?: BurstLogger;
  /**
   * Counts toward this scheduler's caps from a sibling scheduler. The
   * proxy scheduler reports the chunk scheduler's totals so combined
   * load can't exceed the shared cap.
   */
  siblingInFlight?: () => { count: number; bytes: number };
}

export interface InFlightEntry<Req extends SchedulableRequest> {
  request: Req;
  controller: AbortController;
  /** Starts as an estimate; corrected to actual via {@link Scheduler.correctInFlightBytes}. */
  estimatedBytes: number;
}

export interface SchedulerDumpEntry<Req extends SchedulableRequest> {
  key: string;
  request: Req;
}

export interface SchedulerDump<Req extends SchedulableRequest> {
  inFlight: SchedulerDumpEntry<Req>[];
  pending: SchedulerDumpEntry<Req>[];
}

export class Scheduler<Req extends SchedulableRequest> {
  private pending: Req[] = [];
  private inFlight = new Map<string, InFlightEntry<Req>>();
  private inFlightBytesCounter = 0;
  /** First-enqueue timestamps; oldest age is the pending-starvation signal. */
  private enqueuedAt = new Map<string, number>();

  private readonly config: SchedulerConfig;
  private readonly keyFn: (req: Req) => string;
  private readonly startFn: (
    req: Req,
    controller: AbortController,
    estimatedBytes: number,
    key: string,
  ) => void;

  constructor(
    config: SchedulerConfig,
    keyFn: (req: Req) => string,
    startFn: (
      req: Req,
      controller: AbortController,
      estimatedBytes: number,
      key: string,
    ) => void,
  ) {
    this.config = config;
    this.keyFn = keyFn;
    this.startFn = startFn;
  }

  get inFlightSize(): number {
    return this.inFlight.size;
  }

  get inFlightBytes(): number {
    return this.inFlightBytesCounter;
  }

  get pendingSize(): number {
    return this.pending.length;
  }

  hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  inFlightEntries(): IterableIterator<[string, InFlightEntry<Req>]> {
    return this.inFlight.entries();
  }

  /** Caller-owned copy in dequeue order; safe to mutate. */
  pendingSnapshot(): readonly Req[] {
    return [...this.pending];
  }

  /** Age (ms) of the longest-waiting pending entry; 0 when empty. */
  oldestPendingAgeMs(now: number): number {
    if (this.enqueuedAt.size === 0) return 0;
    let oldest = now;
    for (const t of this.enqueuedAt.values()) {
      if (t < oldest) oldest = t;
    }
    return now - oldest;
  }

  enqueueTimeFor(key: string): number | undefined {
    return this.enqueuedAt.get(key);
  }

  /**
   * Replace the pending queue, preserving the original enqueue
   * timestamp for any already-pending key (starvation signal reflects
   * first appearance, not most recent plan tick). Caller dedups; the
   * scheduler does no filtering.
   */
  enqueue(reqs: Req[], now: number = performance.now()): void {
    this.pending = reqs;
    const next = new Map<string, number>();
    for (const req of reqs) {
      const key = this.keyFn(req);
      next.set(key, this.enqueuedAt.get(key) ?? now);
    }
    this.enqueuedAt = next;
  }

  /**
   * Drain pending into in-flight up to either cap. If a cap blocks
   * further dequeue while pending remain, the optional burstLogger
   * fires its rate-limited backpressure summary.
   */
  drain(estimateBytes: (req: Req) => number): void {
    while (this.pending.length > 0 && this.canStartMore()) {
      const req = this.pending.shift()!;
      const key = this.keyFn(req);
      this.enqueuedAt.delete(key);
      const estimate = estimateBytes(req);
      this.startInFlight(req, key, estimate);
    }

    if (this.pending.length > 0 && !this.canStartMore() && this.config.burstLogger) {
      const sibling = this.config.siblingInFlight?.();
      const totalCount = this.inFlight.size + (sibling?.count ?? 0);
      const totalBytes = this.inFlightBytesCounter + (sibling?.bytes ?? 0);
      this.config.burstLogger.recordSkipped(
        this.pending.length,
        (skipped) => ({
          pending: this.pending.length,
          inFlight: totalCount,
          maxConcurrent: this.config.maxConcurrentFetches,
          inFlightBytes: totalBytes,
          maxBytes: this.config.maxBytesInFlight,
          skippedSinceLastLog: skipped,
        }),
      );
    }
  }

  private canStartMore(): boolean {
    const sibling = this.config.siblingInFlight?.();
    const totalCount = this.inFlight.size + (sibling?.count ?? 0);
    const totalBytes = this.inFlightBytesCounter + (sibling?.bytes ?? 0);
    return (
      totalCount < this.config.maxConcurrentFetches &&
      totalBytes < this.config.maxBytesInFlight
    );
  }

  private startInFlight(req: Req, key: string, estimate: number): void {
    const controller = new AbortController();
    const entry: InFlightEntry<Req> = {
      request: req,
      controller,
      estimatedBytes: estimate,
    };
    this.inFlightBytesCounter += estimate;
    this.inFlight.set(key, entry);
    this.startFn(req, controller, estimate, key);
  }

  /** No-op if the key was cancelled between fetch start and response. */
  correctInFlightBytes(key: string, actualBytes: number): void {
    const entry = this.inFlight.get(key);
    if (!entry) return;
    this.inFlightBytesCounter += actualBytes - entry.estimatedBytes;
    entry.estimatedBytes = actualBytes;
  }

  /** Idempotent — safe to call after cancellation. */
  markInFlightDone(key: string): void {
    const entry = this.inFlight.get(key);
    if (!entry) return;
    this.inFlightBytesCounter -= entry.estimatedBytes;
    this.inFlight.delete(key);
  }

  /**
   * Release the slot for `key` only when the live entry is still the one
   * `controller` started. A settle arriving after its key was cancelled
   * and re-enqueued under a fresh controller (the same tile scrubbed away
   * and straight back within a rebuild) must not free the successor's
   * slot. Returns whether this controller's slot was found and released.
   */
  markInFlightDoneIfCurrent(key: string, controller: AbortController): boolean {
    const entry = this.inFlight.get(key);
    if (!entry || entry.controller !== controller) return false;
    this.inFlightBytesCounter -= entry.estimatedBytes;
    this.inFlight.delete(key);
    return true;
  }

  /** Abort and drop a single in-flight request by key. */
  cancelOne(key: string): void {
    const entry = this.inFlight.get(key);
    if (!entry) return;
    entry.controller.abort();
    this.inFlightBytesCounter -= entry.estimatedBytes;
    this.inFlight.delete(key);
    this.enqueuedAt.delete(key);
  }

  /** Cancel in-flight + drop pending entries matching `predicate`. */
  cancelDataset(predicate: (entry: InFlightEntry<Req>) => boolean): void {
    this.cancelWhere(predicate);
  }

  /**
   * Cancel in-flight + drop pending entries matching `predicate`.
   * Returns every scheduler key that was removed so callers can clear
   * sidecar metadata keyed outside the scheduler.
   */
  cancelWhere(predicate: (entry: InFlightEntry<Req>) => boolean): string[] {
    const cancelled: string[] = [];
    for (const [key, entry] of this.inFlight) {
      if (predicate(entry)) {
        entry.controller.abort();
        this.inFlightBytesCounter -= entry.estimatedBytes;
        this.inFlight.delete(key);
        this.enqueuedAt.delete(key);
        cancelled.push(key);
      }
    }
    // Build a synthetic InFlightEntry so callers can share one predicate
    // across both in-flight and pending entries.
    this.pending = this.pending.filter((req) => {
      const key = this.keyFn(req);
      const synthetic: InFlightEntry<Req> = {
        request: req,
        controller: undefined as unknown as AbortController,
        estimatedBytes: 0,
      };
      const drop = predicate(synthetic);
      if (drop) {
        this.enqueuedAt.delete(key);
        cancelled.push(key);
      }
      return !drop;
    });
    return cancelled;
  }

  reset(): void {
    for (const [, entry] of this.inFlight) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.inFlightBytesCounter = 0;
    this.pending = [];
    this.enqueuedAt.clear();
  }

  /** Shallow copies of in-flight + pending entries for debug overlays. */
  dump(): SchedulerDump<Req> {
    const inFlight: SchedulerDumpEntry<Req>[] = [];
    for (const [key, entry] of this.inFlight) {
      inFlight.push({ key, request: entry.request });
    }
    const pending: SchedulerDumpEntry<Req>[] = this.pending.map((req) => ({
      key: this.keyFn(req),
      request: req,
    }));
    return { inFlight, pending };
  }
}
