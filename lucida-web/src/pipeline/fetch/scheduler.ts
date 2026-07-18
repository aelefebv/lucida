/**
 * Pending queue + in-flight tracking + concurrency / bytes caps.
 *
 * Generic over the request shape so fetch policy stays independent of
 * concrete chunk request details; the dedup ladder lives in `cpuCache.ts` and feeds
 * this with a pre-deduped list. The scheduler doesn't know about
 * decode, retry, or the cache — the `startFn` callback owns that work
 * and must call back via {@link correctInFlightBytes} +
 * {@link markInFlightDone} to close out the slot.
 */

import type { BurstLogger } from "./telemetry.ts";
import { FairPriorityQueue } from "./fairPriorityQueue.ts";

export interface SchedulableRequest {
  datasetId: string;
  entityId: string;
}

export interface SchedulerConfig {
  maxConcurrentFetches: number;
  maxBytesInFlight: number;
  burstLogger?: BurstLogger;
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

export interface SchedulerQueuePolicy<Req extends SchedulableRequest> {
  /** Local priority inside one fair bucket. Equal items retain enqueue order. */
  compare?: (a: Req, b: Req) => number;
  /** Defaults to one bucket per dataset. */
  bucketOf?: (req: Req) => string;
  /** Suppresses tombstones for metadata-equivalent refreshes. */
  equals?: (a: Req, b: Req) => boolean;
}

export class Scheduler<Req extends SchedulableRequest> {
  private readonly pending: FairPriorityQueue<Req>;
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
    queuePolicy: SchedulerQueuePolicy<Req> = {},
  ) {
    this.config = config;
    this.keyFn = keyFn;
    this.startFn = startFn;
    this.pending = new FairPriorityQueue<Req>({
      keyOf: keyFn,
      compare: queuePolicy.compare,
      bucketOf: queuePolicy.bucketOf,
      equals: queuePolicy.equals,
    });
  }

  get inFlightSize(): number {
    return this.inFlight.size;
  }

  get inFlightBytes(): number {
    return this.inFlightBytesCounter;
  }

  get pendingSize(): number {
    return this.pending.size;
  }

  hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /**
   * Whether the live in-flight entry for `key` is the one `controller`
   * started. False once the key was cancelled and re-enqueued under a fresh
   * controller, so a superseded completion can leave the successor's slot
   * (and its byte accounting) untouched.
   */
  isCurrent(key: string, controller: AbortController): boolean {
    return this.inFlight.get(key)?.controller === controller;
  }

  inFlightEntries(): IterableIterator<[string, InFlightEntry<Req>]> {
    return this.inFlight.entries();
  }

  /** Caller-owned copy in dequeue order; safe to mutate. */
  pendingSnapshot(): readonly Req[] {
    return this.pending.snapshotFair();
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
    const desired = new Set(reqs.map((req) => this.keyFn(req)));
    for (const current of this.pending.snapshotFair()) {
      const key = this.keyFn(current);
      if (desired.has(key)) continue;
      this.pending.delete(key);
      this.enqueuedAt.delete(key);
    }
    for (const req of reqs) {
      const key = this.keyFn(req);
      if (!this.enqueuedAt.has(key)) this.enqueuedAt.set(key, now);
      this.pending.upsert(req);
    }
  }

  /** Replace only one dataset's pending ownership; every other dataset stays. */
  replaceDataset(datasetId: string, reqs: readonly Req[], now: number = performance.now()): void {
    for (const req of reqs) {
      const key = this.keyFn(req);
      if (!this.enqueuedAt.has(key)) this.enqueuedAt.set(key, now);
    }
    const removed = this.pending.replaceDataset(datasetId, reqs);
    for (const key of removed) this.enqueuedAt.delete(key);
  }

  /** Apply an owner-scoped pending delta without rebuilding another queue. */
  applyDatasetDelta(
    datasetId: string,
    upserts: readonly Req[],
    removedKeys: readonly string[],
    now: number = performance.now(),
  ): void {
    for (const req of upserts) {
      const key = this.keyFn(req);
      if (!this.enqueuedAt.has(key)) this.enqueuedAt.set(key, now);
    }
    const removed = this.pending.applyDatasetDelta(datasetId, upserts, removedKeys);
    for (const key of removed) this.enqueuedAt.delete(key);
  }

  /**
   * Drain pending into in-flight up to either cap. If a cap blocks
   * further dequeue while pending remain, the optional burstLogger
   * fires its rate-limited backpressure summary.
   */
  drain(estimateBytes: (req: Req) => number): void {
    while (this.pending.size > 0 && this.hasConcurrencySlot()) {
      const next = this.pending.peek();
      if (!next) break;
      const estimate = this.normalizeEstimate(estimateBytes(next));
      if (!this.canAdmitBytes(estimate)) break;

      const req = this.pending.shift();
      if (!req) break;
      const key = this.keyFn(req);
      this.enqueuedAt.delete(key);
      this.startInFlight(req, key, estimate);
    }

    if (this.pending.size > 0 && this.config.burstLogger) {
      this.config.burstLogger.recordSkipped(
        this.pending.size,
        (skipped) => ({
          pending: this.pending.size,
          inFlight: this.inFlight.size,
          maxConcurrent: this.config.maxConcurrentFetches,
          inFlightBytes: this.inFlightBytesCounter,
          maxBytes: this.config.maxBytesInFlight,
          skippedSinceLastLog: skipped,
        }),
      );
    }
  }

  private hasConcurrencySlot(): boolean {
    return this.inFlight.size < this.config.maxConcurrentFetches;
  }

  private canAdmitBytes(estimate: number): boolean {
    // A single intrinsically-large request must still make progress so its
    // producer can return the protocol's explicit oversized response. Once
    // anything is active, however, admission is prospective: the next request
    // may not push the live reservation over the configured cap.
    return this.inFlight.size === 0 ||
      this.inFlightBytesCounter + estimate <= this.config.maxBytesInFlight;
  }

  private normalizeEstimate(estimate: number): number {
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new Error(`Scheduler byte estimate must be finite and non-negative, got ${estimate}`);
    }
    return estimate;
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
    const pendingCancelled = this.pending.deleteWhere((req) => {
      const key = this.keyFn(req);
      const synthetic: InFlightEntry<Req> = {
        request: req,
        controller: undefined as unknown as AbortController,
        estimatedBytes: 0,
      };
      const drop = predicate(synthetic);
      if (drop) {
        this.enqueuedAt.delete(key);
      }
      return drop;
    });
    cancelled.push(...pendingCancelled);
    return cancelled;
  }

  reset(): void {
    for (const [, entry] of this.inFlight) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.inFlightBytesCounter = 0;
    this.pending.clear();
    this.enqueuedAt.clear();
  }

  /** Shallow copies of in-flight + pending entries for debug overlays. */
  dump(): SchedulerDump<Req> {
    const inFlight: SchedulerDumpEntry<Req>[] = [];
    for (const [key, entry] of this.inFlight) {
      inFlight.push({ key, request: entry.request });
    }
    const pending: SchedulerDumpEntry<Req>[] = this.pending.snapshotFair().map((req) => ({
      key: this.keyFn(req),
      request: req,
    }));
    return { inFlight, pending };
  }
}
