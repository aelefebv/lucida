/**
 * Whether the view has settled, and how.
 *
 * Settling is something the page publishes, never something inferred from
 * outside. A reader can only watch the frame counter stop, and that is wrong
 * in the case that matters: a stalled pipeline and a finished one both stop
 * drawing.
 *
 * Every view settles in bounded time. It settles covering everything it
 * wants, or covering what its budgets hold when they cannot hold the rest,
 * and when it stops making progress for any other reason it ends as stalled,
 * with a reason. Workspace previews, captures and the trace all wait on this
 * one signal.
 */

import type { Outstanding } from "../trace/types.ts";

/**
 * What the CPU cache measures. The demand counts and the queue sizes are the
 * trace's {@link Outstanding}; the rest says why a wanted chunk that is not
 * resident is missing, counted only while nothing is queued or in flight.
 */
export interface CacheSettleInputs extends Outstanding {
  /**
   * True when the pending queue was too deep to classify by lane. The scan
   * is bounded so the predicate cannot cost more than the tick it runs in;
   * an unclassified queue reads as not settled rather than as a guess.
   */
  pendingUnclassified: boolean;
  /** Wanted chunks absent because their tier is full, by tier. */
  shortDetailChunks: number;
  shortCoarseChunks: number;
  /** Wanted chunks the server answered pending and has not made yet. */
  serverPendingChunks: number;
  /** Wanted chunks waiting out a backoff after a transient failure. */
  retryingChunks: number;
  /** Wanted chunks the source refused for good. */
  failedChunks: number;
  /** Wanted chunks absent for none of the reasons above, with room for them. */
  unrequestedChunks: number;
  /**
   * Chunks posted to the render worker that it has not yet answered as held
   * or refused. Until it does, what the canvas shows is still changing.
   */
  uploadsUnanswered: number;
}

/** The cache's half plus the render loop's own three flags. */
export interface SettleInputs extends CacheSettleInputs {
  interactiveDirty: boolean;
  residencyDirty: boolean;
  frameInFlight: boolean;
}

export interface SettleState extends SettleInputs {
  /**
   * The predicate holds: nothing left to draw, nothing queued or in flight,
   * and every wanted chunk resident, or as many as the budgets hold.
   */
  quiescent: boolean;
  /**
   * `"quiescent"`, `"coverage_limited"` when the budgets hold less than the
   * view wants, or the first unmet clause.
   */
  reason: string;
  /** The share of the wanted set that is resident, from 0 to 1. */
  coverage: number;
  /** `performance.now()` at publication. */
  at: number;
}

/**
 * A zeroed state, for a caller that will reuse one instance across ticks.
 * The publish path runs every tick, and the monitor must not allocate in
 * steady state: its own GC pauses would appear as stalls in its own trace.
 */
export function createSettleState(): SettleState {
  return {
    interactiveDirty: false,
    residencyDirty: false,
    frameInFlight: false,
    desiredDetailChunks: 0,
    residentDetailChunks: 0,
    desiredCoarseChunks: 0,
    residentCoarseChunks: 0,
    detailBytes: 0,
    detailBudgetBytes: 0,
    coarseBytes: 0,
    coarseBudgetBytes: 0,
    pending: 0,
    inFlight: 0,
    speculativePending: 0,
    speculativeInFlight: 0,
    pendingUnclassified: false,
    shortDetailChunks: 0,
    shortCoarseChunks: 0,
    serverPendingChunks: 0,
    retryingChunks: 0,
    failedChunks: 0,
    unrequestedChunks: 0,
    uploadsUnanswered: 0,
    quiescent: false,
    reason: "unpublished",
    coverage: 0,
    at: 0,
  };
}

/**
 * Decide the predicate over `state`'s already-filled inputs, in place. The
 * caller fills the input fields, this fills `reason`, `quiescent`,
 * `coverage` and `at`.
 */
export function evaluateSettle(state: SettleState, at: number): SettleState {
  const reason = settleReason(state);
  const desired = state.desiredDetailChunks + state.desiredCoarseChunks;
  const resident =
    Math.min(state.residentDetailChunks, state.desiredDetailChunks) +
    Math.min(state.residentCoarseChunks, state.desiredCoarseChunks);
  state.at = at;
  state.reason = reason;
  state.quiescent = reason === "quiescent" || reason === "coverage_limited";
  state.coverage = desired > 0 ? resident / desired : 1;
  return state;
}

function settleReason(i: SettleInputs): string {
  if (i.interactiveDirty) return "interactive_dirty";
  if (i.residencyDirty) return "residency_dirty";
  if (i.frameInFlight) return "frame_in_flight";
  if (i.pendingUnclassified) return "pending_unclassified";
  if (i.inFlight > 0) return "chunks_in_flight";
  if (i.pending > 0) return "chunks_pending";
  if (i.uploadsUnanswered > 0) return "uploads_unanswered";
  const missing =
    Math.max(0, i.desiredDetailChunks - i.residentDetailChunks) +
    Math.max(0, i.desiredCoarseChunks - i.residentCoarseChunks);
  if (missing === 0) return "quiescent";
  // Every missing chunk is one its tier has no room for: the view covers
  // what the budgets hold, and asking again would only evict another.
  if (i.shortDetailChunks + i.shortCoarseChunks >= missing) return "coverage_limited";
  if (i.residentDetailChunks < i.desiredDetailChunks) return "detail_not_resident";
  return "coarse_not_resident";
}

/**
 * Why a view that is waiting with nothing queued or in flight is waiting,
 * named for what it waits on.
 */
export function stallReasonOf(state: SettleState): string {
  if (state.uploadsUnanswered > 0) return "worker_unanswered";
  if (state.serverPendingChunks > 0) return "server_pending";
  if (state.retryingChunks > 0) return "source_retrying";
  if (state.failedChunks > 0) return "chunk_failed";
  if (state.unrequestedChunks > 0) return "not_requested";
  return state.reason;
}

/**
 * Whether the page is waiting on something outside it: the server, the
 * source, or the render worker's answer, with nothing dirty, drawing,
 * queued or in flight.
 */
function atRest(state: SettleState): boolean {
  return (
    state.reason === "detail_not_resident" ||
    state.reason === "coarse_not_resident" ||
    state.reason === "uploads_unanswered"
  );
}

/**
 * `settling` while the view works toward its wanted set, `settled` once the
 * predicate has held for the hold window, and `stalled` once it has stopped
 * making progress without settling.
 */
export type SettleOutcome = "settling" | "settled" | "stalled";

/**
 * How long the predicate must hold before the view counts as settled. Clears
 * the residency render interval and the minimap scan cadence with margin,
 * so a lull between two bursts of arrivals does not count.
 */
export const SETTLE_HOLD_MS = 500;

/**
 * How long a view may wait with nothing queued or in flight, and no wanted
 * chunk arriving, before it counts as stalled. Longer than the first backoffs
 * and the server's first answers, so a view that is about to make progress
 * does so inside the window.
 */
export const STALL_MS = 10_000;

export interface SettleSignalOptions {
  holdMs?: number;
  stallMs?: number;
}

type OutcomeListener = (outcome: SettleOutcome) => void;

/**
 * The page's settle signal. The render loop publishes the predicate every
 * tick; this holds it, decides the outcome, and tells listeners when the
 * outcome changes.
 */
export class SettleSignal {
  readonly holdMs: number;
  readonly stallMs: number;
  private last: SettleState | null = null;
  private current: SettleOutcome = "settling";
  private reasonForStall: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the view last made progress while waiting, or null while it is not waiting. */
  private waitingSince: number | null = null;
  /** The demand and residency counts progress is judged against. */
  private waitingCounts = "";
  private readonly listeners = new Set<OutcomeListener>();

  constructor(options: SettleSignalOptions = {}) {
    this.holdMs = options.holdMs ?? SETTLE_HOLD_MS;
    this.stallMs = options.stallMs ?? STALL_MS;
  }

  /** The last state the page published, or null before the first publication. */
  get state(): SettleState | null {
    return this.last;
  }

  get outcome(): SettleOutcome {
    return this.current;
  }

  /** Why the view stalled, or null unless it has. */
  get stallReason(): string | null {
    return this.reasonForStall;
  }

  /** Be told each time the outcome changes. */
  subscribe(listener: OutcomeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Take one tick's evaluated state. The caller may reuse the object. */
  publish(state: SettleState): void {
    this.last = state;
    if (state.quiescent) {
      this.stopWaiting();
      if (this.current === "stalled") this.become("settling");
      if (this.current !== "settled" && this.holdTimer === null) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this.become("settled");
        }, this.holdMs);
      }
      return;
    }
    this.clearHold();
    const counts = progressCounts(state);
    if (counts !== this.waitingCounts) {
      // Progress, or the start of a wait: the stall clock starts over.
      this.waitingCounts = counts;
      this.waitingSince = null;
      this.clearStallTimer();
      if (this.current === "stalled") this.become("settling");
    }
    if (this.current === "settled") this.become("settling");
    if (!atRest(state)) {
      // Work is queued, in flight or drawing, which is the run timeout's
      // business. A retry that comes back empty leaves the counts alone, so
      // it does not restart the clock.
      this.clearStallTimer();
      return;
    }
    if (this.current === "stalled") return;
    this.waitingSince ??= state.at;
    if (this.stallTimer === null) {
      const due = Math.max(0, this.waitingSince + this.stallMs - state.at);
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        if (this.last) this.reasonForStall = stallReasonOf(this.last);
        this.become("stalled");
      }, due);
    }
  }

  /**
   * Something changed that the next tick will publish. A settled view stops
   * counting as settled now, so a reader acting on "settled" between the
   * change and that tick does not act on a view that moved.
   */
  disturb(): void {
    this.clearHold();
    if (this.current === "settled") this.become("settling");
  }

  /**
   * The view itself changed: an input or a dataset open. Whatever it had
   * settled or stalled on was the view before, so the stall clock starts
   * over too.
   */
  restart(): void {
    this.disturb();
    this.stopWaiting();
    if (this.current === "stalled") this.become("settling");
  }

  /** Forget everything, for a test that needs one view isolated from the next. */
  reset(): void {
    this.clearHold();
    this.stopWaiting();
    this.last = null;
    this.current = "settling";
    this.reasonForStall = null;
  }

  private become(outcome: SettleOutcome): void {
    if (outcome !== "stalled") this.reasonForStall = null;
    if (outcome === this.current) return;
    this.current = outcome;
    for (const listener of this.listeners) listener(outcome);
  }

  private stopWaiting(): void {
    this.clearStallTimer();
    this.waitingSince = null;
    this.waitingCounts = "";
  }

  private clearHold(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private clearStallTimer(): void {
    if (this.stallTimer === null) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }
}

/** What has to change for a waiting view to count as progressing. */
function progressCounts(state: SettleState): string {
  return `${state.desiredDetailChunks}/${state.residentDetailChunks}/${state.desiredCoarseChunks}/${state.residentCoarseChunks}`;
}

/** The page's one settle signal, which the render loop publishes into. */
export const settleSignal = new SettleSignal();
