/**
 * Pending queue + in-flight tracking + concurrency / bytes caps.
 *
 * Generic over the request shape so one class backs both the chunk and
 * proxy schedulers; the dedup ladder lives in `cpuCache.ts` and feeds
 * this with a pre-deduped list. The scheduler doesn't know about
 * decode, retry, or the cache — the `startFn` callback owns that work
 * and must call back via {@link correctInFlightBytes} +
 * {@link markInFlightDone} to close out the slot.
 *
 * The pending queue is split in two (ADR 0044): a bounded, timestamped
 * ADMISSION WINDOW at the front, and an untimestamped BACKLOG behind it.
 * Both live in the same `pending` array — the window is simply its first
 * {@link SchedulerConfig.admissionWindow} entries — so ordering, drain,
 * and cancellation are unchanged. Only the per-key bookkeeping is
 * bounded. See the ADR for why: on an oversubscribed remote collection
 * the wanted set is ~21k requests re-submitted ~5x/s, and stamping all
 * of them cost ~9% of the main thread while saying nothing useful.
 */

import type { BurstLogger } from "./telemetry.ts";

export interface SchedulableRequest {
  datasetId: string;
  entityId: string;
}

/**
 * Admission-window floor, applied when a caller's window would otherwise
 * be smaller than this. Keeps the window meaningful for the proxy
 * scheduler and for small/local datasets, where the entire wanted set is
 * routinely under this size and the split should be invisible.
 */
export const MIN_ADMISSION_WINDOW = 64;

/**
 * Default admission window as a multiple of `maxConcurrentFetches`. Deep
 * enough that the drain loop never runs dry between rebuilds (a rebuild
 * refills the window wholesale, and every fetch completion re-drains),
 * shallow enough that the window is a promise the transport can keep
 * within a couple of seconds at remote fetch rates.
 */
export const ADMISSION_WINDOW_CONCURRENCY_MULTIPLE = 4;

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
  /**
   * How many front-of-queue entries carry an enqueue timestamp. Defaults
   * to `max(MIN_ADMISSION_WINDOW, maxConcurrentFetches *
   * ADMISSION_WINDOW_CONCURRENCY_MULTIPLE)`. Entries behind it are
   * retained and drained in order, but untimestamped until promoted.
   */
  admissionWindow?: number;
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
  /**
   * Admission timestamps for the window only — the moment a request
   * entered the front {@link admissionWindow} entries of `pending`, i.e.
   * when the scheduler committed to fetching it soon. Backlog entries
   * behind the window carry no stamp until promoted. The oldest stamp is
   * the pending-starvation signal, and it is now bounded by the window
   * rather than by how long ago a tile first became wanted.
   */
  private enqueuedAt = new Map<string, number>();

  private readonly admissionWindow: number;

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
    // An explicit window is taken literally; only the derived default
    // gets the floor, so a caller can ask for a small window and a
    // small/local dataset never notices the split.
    this.admissionWindow = config.admissionWindow ?? Math.max(
      MIN_ADMISSION_WINDOW,
      config.maxConcurrentFetches * ADMISSION_WINDOW_CONCURRENCY_MULTIPLE,
    );
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

  /** How many pending entries currently carry an admission stamp. */
  get admittedSize(): number {
    return this.enqueuedAt.size;
  }

  /**
   * Replace the pending queue. Only the front {@link admissionWindow}
   * entries are stamped; a key already in the window keeps its original
   * stamp, so the starvation signal reflects first admission rather than
   * the most recent plan tick. Entries behind the window are retained in
   * order and stamped when {@link drain} promotes them.
   *
   * Bounding the stamp map here is the whole point of the split: the
   * caller hands us the complete wanted set on every rebuild, and on a
   * large remote collection that is ~21k entries ~5x/s. Caller dedups;
   * the scheduler does no filtering.
   */
  enqueue(reqs: Req[], now: number = performance.now()): void {
    this.pending = reqs;
    const windowEnd = Math.min(this.admissionWindow, reqs.length);
    const next = new Map<string, number>();
    for (let i = 0; i < windowEnd; i++) {
      const key = this.keyFn(reqs[i]);
      next.set(key, this.enqueuedAt.get(key) ?? now);
    }
    this.enqueuedAt = next;
  }

  /**
   * Drain pending into in-flight up to either cap, promoting backlog
   * entries into the admission window as the window empties — so a
   * scheduler that never receives another `enqueue` still works through
   * its whole backlog (an at-rest collection fill must still complete).
   * If a cap blocks further dequeue while pending remain, the optional
   * burstLogger fires its rate-limited backpressure summary.
   */
  drain(estimateBytes: (req: Req) => number, now: number = performance.now()): void {
    while (this.pending.length > 0 && this.canStartMore()) {
      const req = this.pending.shift()!;
      const key = this.keyFn(req);
      this.enqueuedAt.delete(key);
      const estimate = estimateBytes(req);
      this.startInFlight(req, key, estimate);
      this.promoteIntoWindow(now);
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

  /**
   * Stamp the single entry that a front-of-queue removal just pulled
   * into the admission window. Cheap counterpart to
   * {@link syncWindow} for the hot drain loop: exactly one index can
   * newly qualify per `shift()`.
   */
  private promoteIntoWindow(now: number): void {
    const idx = this.admissionWindow - 1;
    if (idx >= this.pending.length) return;
    const key = this.keyFn(this.pending[idx]);
    if (!this.enqueuedAt.has(key)) this.enqueuedAt.set(key, now);
  }

  /**
   * Re-stamp the whole window. Used after a bulk removal
   * ({@link cancelWhere}), where an arbitrary number of backlog entries
   * can be pulled forward at once.
   */
  private syncWindow(now: number): void {
    const windowEnd = Math.min(this.admissionWindow, this.pending.length);
    for (let i = 0; i < windowEnd; i++) {
      const key = this.keyFn(this.pending[i]);
      if (!this.enqueuedAt.has(key)) this.enqueuedAt.set(key, now);
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
   * Abort IN-FLIGHT entries matching `predicate`, leaving the pending
   * queue untouched. The predicate receives the scheduler key alongside
   * the entry so a caller matching on keys does not have to rebuild them.
   * Returns the keys removed.
   *
   * Use this instead of {@link cancelWhere} when the caller is about to
   * replace the pending queue anyway: `cancelWhere` walks every pending
   * entry, and on an oversubscribed collection that queue is tens of
   * thousands deep (issue #900).
   */
  cancelInFlightWhere(
    predicate: (entry: InFlightEntry<Req>, key: string) => boolean,
  ): string[] {
    const cancelled: string[] = [];
    for (const [key, entry] of this.inFlight) {
      if (!predicate(entry, key)) continue;
      entry.controller.abort();
      this.inFlightBytesCounter -= entry.estimatedBytes;
      this.inFlight.delete(key);
      this.enqueuedAt.delete(key);
      cancelled.push(key);
    }
    return cancelled;
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
    // A bulk removal can pull any number of backlog entries into the
    // window; stamp them so the starvation signal stays complete.
    this.syncWindow(performance.now());
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
