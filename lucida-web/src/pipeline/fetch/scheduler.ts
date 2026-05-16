/**
 * Scheduler — pending queue + in-flight tracking + concurrency caps.
 *
 * Owns the bookkeeping the cache used to mutate inline:
 *  - `pending` queue (already-deduped requests waiting to start)
 *  - `inFlight` Map (key → entry with controller, estimated bytes, request)
 *  - in-flight bytes counter (rolled forward on start, corrected on
 *    response, rolled back on done/cancel)
 *  - `pendingEnqueuedAt` (per-key first-enqueue timestamps for the
 *    starvation telemetry signal)
 *  - rate-limited backpressure log (delegated to {@link BurstLogger}
 *    from telemetry.ts) — fires when {@link drain} can't issue
 *    everything pending because a cap is hit.
 *
 * Generic over the request shape so the same class backs both the
 * chunk and proxy schedulers — the only differences live in
 * (a) the key function (entity/chunk-key for chunks, dataset/inner-key
 * for proxies), and (b) the start callback (chunk path runs
 * `fetchAndDecode`; proxy path runs `fetchProxy`).
 *
 * The dedup ladder (rejected / cached / in-flight / failed) STAYS in
 * `cpuCache.ts` for now — it touches state owned by stores +
 * rejection + failure-map collaborators that haven't all extracted
 * yet. The scheduler's contract is "enqueue this pre-deduped list and
 * drain to capacity." Future slices may push more of the dedup logic
 * down here once those collaborators land (Slice 9 RejectionTracker,
 * Slice 8 RetryPolicy, etc.).
 *
 * The scheduler does NOT know about decode, retry, or the cache.
 * Once `startFn` runs, the request is considered in-flight; the
 * caller is responsible for invoking {@link markInFlightDone} when
 * the work completes (success or failure). Bytes accounting goes
 * through {@link correctInFlightBytes} after the response size is
 * known and {@link markInFlightDone} when the slot is released.
 *
 * Public surface of {@link CpuCache} is unchanged; this is an
 * internal collaborator. Nothing outside `pipeline/fetch/` should
 * import it.
 */

import type { BurstLogger } from "./telemetry.ts";

/**
 * Minimal shape the scheduler requires from its request type. Both
 * {@link import("../planning/index.ts").ChunkRequest} and
 * {@link import("../planning/index.ts").ProxyRequest} satisfy this.
 *
 * `datasetId` + `entityId` are the keys cancelDataset filters on.
 */
export interface SchedulableRequest {
  datasetId: string;
  entityId: string;
}

/** Constructor config for {@link Scheduler}. */
export interface SchedulerConfig {
  /** Hard cap on simultaneously-in-flight requests for this scheduler. */
  maxConcurrentFetches: number;
  /** Hard cap on summed estimated/actual bytes in flight. */
  maxBytesInFlight: number;
  /**
   * Optional rate-limited debug-log channel for backpressure events.
   * The scheduler emits via `recordSkipped` whenever {@link drain}
   * stops short of the pending queue because of a cap. Cpu cache
   * passes the same {@link BurstLogger} that used to live on the
   * cache itself; tests can pass a no-op or a spy.
   */
  burstLogger?: BurstLogger;
  /**
   * Optional sibling-counts hook. The proxy scheduler shares the
   * concurrency / bytes caps with the chunk scheduler (proxies are a
   * small minority — see the original `startProxyFetches` in
   * `cpuCache.ts`). When provided, the returned counts are added to
   * the scheduler's own totals before the cap check; the chunk
   * scheduler leaves it undefined.
   */
  siblingInFlight?: () => { count: number; bytes: number };
}

/** One tracked in-flight request. */
export interface InFlightEntry<Req extends SchedulableRequest> {
  request: Req;
  controller: AbortController;
  /**
   * Bytes counted toward {@link Scheduler.inFlightBytes} for this
   * request. Starts as the average-decoded-bytes estimate and is
   * corrected to the actual response size via
   * {@link Scheduler.correctInFlightBytes}.
   */
  estimatedBytes: number;
}

/** Per-entry record returned by {@link Scheduler.dump}. */
export interface SchedulerDumpEntry<Req extends SchedulableRequest> {
  key: string;
  request: Req;
}

/**
 * Snapshot of the scheduler's state shape. Returned by
 * {@link Scheduler.dump} for telemetry / debug overlay use.
 */
export interface SchedulerDump<Req extends SchedulableRequest> {
  inFlight: SchedulerDumpEntry<Req>[];
  pending: SchedulerDumpEntry<Req>[];
}

/**
 * Generic scheduler. Two instances live on `CpuCache`: the chunk
 * scheduler (key = `entityId/chunkKey`) and the proxy scheduler
 * (key = `datasetId|innerKey`).
 */
export class Scheduler<Req extends SchedulableRequest> {
  private pending: Req[] = [];
  private inFlight = new Map<string, InFlightEntry<Req>>();
  private inFlightBytesCounter = 0;
  /**
   * First-enqueue timestamps keyed by `keyFn(req)`. Cleared when an
   * entry transitions to in-flight or is dropped via
   * {@link cancelDataset}. The "oldest" age across this map is the
   * starvation signal cpu cache surfaces in its telemetry.
   */
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

  // -------------------------------------------------------------------------
  // Read-only views
  // -------------------------------------------------------------------------

  /** Number of currently in-flight requests. */
  get inFlightSize(): number {
    return this.inFlight.size;
  }

  /** Sum of in-flight bytes (estimated until corrected to actual). */
  get inFlightBytes(): number {
    return this.inFlightBytesCounter;
  }

  /** Number of requests waiting in the pending queue. */
  get pendingSize(): number {
    return this.pending.length;
  }

  /** Whether `key` is currently in-flight. */
  hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Iterate every in-flight `(key, entry)` pair — read-only. */
  inFlightEntries(): IterableIterator<[string, InFlightEntry<Req>]> {
    return this.inFlight.entries();
  }

  /**
   * Snapshot of the pending queue (caller-owned copy; safe to mutate).
   * The order is the order entries will be dequeued.
   */
  pendingSnapshot(): readonly Req[] {
    return [...this.pending];
  }

  /**
   * Age (ms) of the longest-waiting entry in the pending queue
   * relative to `now`. Returns 0 when the queue is empty. Used by
   * cpu cache's `telemetry()` for the `pendingOldestAgeMs` field.
   */
  oldestPendingAgeMs(now: number): number {
    if (this.enqueuedAt.size === 0) return 0;
    let oldest = now;
    for (const t of this.enqueuedAt.values()) {
      if (t < oldest) oldest = t;
    }
    return now - oldest;
  }

  /**
   * Lookup the recorded enqueue timestamp for a key, or undefined
   * if the key isn't pending (already in-flight, never enqueued, or
   * already drained). Used by the per-pending-entry age dump in
   * cpu cache's `getPendingDump`.
   */
  enqueueTimeFor(key: string): number | undefined {
    return this.enqueuedAt.get(key);
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /**
   * Replace the pending queue with `reqs`, preserving the original
   * enqueue timestamp for any key that was already pending (so the
   * starvation signal reflects "how long since the request first
   * appeared," not "how long since the most recent plan tick").
   *
   * The caller is responsible for dedup against the cache + in-flight
   * + failures + rejection ladders before calling — the scheduler
   * does no filtering of its own.
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
   * Drain the pending queue, calling `startFn` on each request until
   * a cap is hit or the queue is empty. Each transitioned request is
   * also charged against {@link inFlightBytes} using the supplied
   * `estimateBytes(req)` callback (cpu cache passes the running
   * `averageDecodedBytes()` from telemetry).
   *
   * If pending requests remain because a cap was hit, the optional
   * `burstLogger` (from config) is poked via `recordSkipped` so the
   * backpressure log can fire its rate-limited summary.
   */
  drain(estimateBytes: (req: Req) => number): void {
    while (this.pending.length > 0 && this.canStartMore()) {
      const req = this.pending.shift()!;
      const key = this.keyFn(req);
      this.enqueuedAt.delete(key);
      const estimate = estimateBytes(req);
      this.startInFlight(req, key, estimate);
    }

    // If pending remain *because* we hit a limit, surface backpressure.
    // Rate-limit to ≤1/sec; aggregate skipped count so a sustained
    // queue still emits a periodic summary.
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

  /**
   * Update the bytes accounting for an already-in-flight key after
   * the actual response size is known. Adjusts
   * {@link inFlightBytes} by `actual - estimated` and updates the
   * entry's `estimatedBytes` so the matching {@link markInFlightDone}
   * deducts the right amount.
   *
   * No-op if the key is no longer in-flight (the request was
   * cancelled between fetch start and response).
   */
  correctInFlightBytes(key: string, actualBytes: number): void {
    const entry = this.inFlight.get(key);
    if (!entry) return;
    this.inFlightBytesCounter += actualBytes - entry.estimatedBytes;
    entry.estimatedBytes = actualBytes;
  }

  /**
   * Release the in-flight slot for `key`: deduct its bytes from the
   * counter and remove it from the map. Idempotent — safe to call
   * after a cancellation has already removed the entry.
   */
  markInFlightDone(key: string): void {
    const entry = this.inFlight.get(key);
    if (!entry) return;
    this.inFlightBytesCounter -= entry.estimatedBytes;
    this.inFlight.delete(key);
  }

  /**
   * Abort and drop a single in-flight request by key. Mirrors
   * {@link markInFlightDone} but also fires the `AbortController`.
   * Used by the rejection feedback path
   * (`CpuCache.markRejected` — Slice 9 will route through this same
   * method).
   */
  cancelOne(key: string): void {
    const entry = this.inFlight.get(key);
    if (!entry) return;
    entry.controller.abort();
    this.inFlightBytesCounter -= entry.estimatedBytes;
    this.inFlight.delete(key);
    this.enqueuedAt.delete(key);
  }

  /**
   * Cancel every in-flight entry whose entry matches `predicate`,
   * then drop every pending entry whose request matches the same
   * predicate. Bytes counter is decremented per aborted entry; the
   * `enqueuedAt` map is cleaned up for both in-flight and pending
   * keys removed.
   *
   * Cpu cache calls this from {@link CpuCache.cancelDataset} with a
   * predicate that filters on `datasetId` (proxy) or
   * `entityIdSet.has(entityId)` (chunk).
   */
  cancelDataset(predicate: (entry: InFlightEntry<Req>) => boolean): void {
    for (const [key, entry] of this.inFlight) {
      if (predicate(entry)) {
        entry.controller.abort();
        this.inFlightBytesCounter -= entry.estimatedBytes;
        this.inFlight.delete(key);
        this.enqueuedAt.delete(key);
      }
    }
    // Predicate is in-flight-shaped; build a synthetic
    // InFlightEntry-shaped value for pending entries so callers can
    // share the predicate.
    this.pending = this.pending.filter((req) => {
      const synthetic: InFlightEntry<Req> = {
        request: req,
        controller: undefined as unknown as AbortController,
        estimatedBytes: 0,
      };
      const drop = predicate(synthetic);
      if (drop) this.enqueuedAt.delete(this.keyFn(req));
      return !drop;
    });
  }

  /**
   * Clear every scheduler-owned piece of state and abort every
   * in-flight controller. Mirrors `CpuCache.reset()`.
   */
  reset(): void {
    for (const [, entry] of this.inFlight) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.inFlightBytesCounter = 0;
    this.pending = [];
    this.enqueuedAt.clear();
  }

  /**
   * Per-entry dump used for debug overlays. Returns shallow copies of
   * the in-flight + pending entries; safe for the caller to mutate.
   */
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
