/**
 * The recorder: unconditional, run-scoped, and the only thing that knows
 * when a lifecycle row belongs to a run.
 *
 * Recording is on in every build with no toggle at any scope (ADR 0049). An
 * idle viewer emits literally nothing — the render loop is dirty-driven — so
 * a continuous recording costs nothing at rest, and a switch that buys back
 * an unmeasurable quantity would only invite every unexplained stall to be
 * blamed on the monitor.
 *
 * A run is a labelled interval within that recording (ADR 0047), opened by a
 * cause and closed by quiescence, timeout, or explicitly. An interaction run
 * and a dataset-open run are the same object, differing only by cause.
 */

import { buildIdentity } from "./buildInfo.ts";
import type { QuiescenceState } from "./quiescence.ts";
import { tableRowSinkFactory, type RowSink, type RowSinkFactory } from "./sink.ts";
import {
  Boundary,
  clampStamp,
  emptyCountedEvents,
  RowOutcome,
  TRACE_SCHEMA_VERSION,
  type ChunkRowSource,
  type CountedEvents,
  type EndReason,
  type CacheWarmth,
  type GpuIdentity,
  type Outstanding,
  type Phase,
  type RowOutcomeValue,
  type RunCause,
  type RunConditions,
  type RunHeader,
  type TraceDocument,
  type TraceRun,
} from "./types.ts";

/**
 * Phases whose boundaries are stamped today. The whole enum, as of #925.
 * Declared rather than inferred so a document says what it did not measure
 * even when every phase happens to be missing from a given row.
 */
export const INSTRUMENTED_PHASES: readonly Phase[] = [
  "plan",
  "queue",
  "wire",
  "decode",
  "upload",
  "present",
];

/**
 * How many recent plan passes the recorder can attribute a queue entry to.
 *
 * A fixed ring rather than a map: a request is admitted either during the
 * enqueue that ends a plan pass or shortly after, when the drain promotes it
 * out of the backlog, so the pass it belongs to is always one of the last
 * few. Sixteen covers roughly three seconds of replanning at the observed
 * cadence, and costs 256 bytes that never move.
 */
const PLAN_SPAN_RING = 16;

/**
 * How long `quiescent` must hold before a run closes on its own. Clears the
 * residency render interval and the minimap scan cadence with margin while
 * staying small against a healthy sub-second local open (ADR 0051). It goes
 * in the header because it is baked into every duration a run reports.
 */
export const DEFAULT_QUIESCENCE_HOLD_MS = 500;

/**
 * How long a run may stay open before closing as `timeout`. Three paths can
 * keep a page live indefinitely, and a monitor that emits nothing on the
 * interesting case is the wrong tool — the most diagnostic run is the one
 * that never finished.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/**
 * What the page can tell the recorder about the conditions a run ran under.
 * Supplied by the render loop, which is the one place that holds the canvas,
 * the mode, the dataset set and the CPU cache at once.
 */
export interface TraceEnvironment {
  /** Read at run open: warmth is what was already resident. */
  captureWarmth(): CacheWarmth;
  /** Read at run close, once the page the run describes actually exists. */
  captureConditions(): RunConditions;
  captureOutstanding(): Outstanding;
}

export interface TraceRecorderOptions {
  sinkFactory?: RowSinkFactory;
  /** Monotonic milliseconds. Injectable so a test can drive run durations. */
  now?: () => number;
  /** Wall-clock epoch milliseconds, so an archived run has a date. */
  epochNow?: () => number;
  quiescenceHoldMs?: number;
  timeoutMs?: number;
}

interface OpenRun {
  runId: string;
  cause: RunCause;
  /**
   * Held for the run's lifetime. A run cannot open without an environment,
   * so nothing downstream has to cope with its absence.
   */
  environment: TraceEnvironment;
  cacheWarmth: CacheWarmth;
  startedAtMs: number;
  startedAtEpochMs: number;
  sink: RowSink;
  generation: number;
  counted: CountedEvents;
}

interface ClosedRun {
  header: RunHeader;
  sink: RowSink;
  counted: CountedEvents;
}

/** Row indices are packed with the run generation so a stale handle is inert. */
const GENERATION_STRIDE = 0x1000000;

export class TraceRecorder {
  private readonly sinkFactory: RowSinkFactory;
  private readonly now: () => number;
  private readonly epochNow: () => number;
  private readonly quiescenceHoldMs: number;
  private readonly timeoutMs: number;

  private environment: TraceEnvironment | null = null;
  private gpu: GpuIdentity | null = null;

  private open: OpenRun | null = null;
  private closed: ClosedRun[] = [];
  private generation = 0;
  private runSeq = 0;
  private rowsOutsideRun = 0;

  /**
   * Recent plan passes as (start, end) wall pairs. Preallocated and
   * overwritten in place — the recorder allocates nothing in steady state,
   * because its own GC pauses would show up as stalls in its own trace.
   */
  private readonly planStartsMs = new Float64Array(PLAN_SPAN_RING);
  private readonly planEndsMs = new Float64Array(PLAN_SPAN_RING);
  private planSpanCount = 0;
  private openPlanStartMs: number | null = null;

  /**
   * Rows handed to the renderer but not yet covered by a frame, and rows
   * covered by the frame before this one. Two arrays swapped rather than
   * reallocated. The GPU worker is FIFO, so a chunk posted before a render
   * message has been written to its texture by the time that render runs —
   * which is what makes residency observable from the main thread without
   * the worker timestamping anything.
   */
  private awaitingResident: number[] = [];
  private awaitingDrawn: number[] = [];

  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQuiescence: QuiescenceState | null = null;

  constructor(options: TraceRecorderOptions = {}) {
    this.sinkFactory = options.sinkFactory ?? tableRowSinkFactory;
    this.now = options.now ?? (() => performance.now());
    this.epochNow = options.epochNow ?? (() => Date.now());
    this.quiescenceHoldMs = options.quiescenceHoldMs ?? DEFAULT_QUIESCENCE_HOLD_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  setEnvironment(environment: TraceEnvironment | null): void {
    this.environment = environment;
  }

  setGpu(gpu: GpuIdentity | null): void {
    this.gpu = gpu;
  }

  get isRunOpen(): boolean {
    return this.open !== null;
  }

  /** The last state the page published, or null before the first publication. */
  get quiescence(): QuiescenceState | null {
    return this.lastQuiescence;
  }

  /**
   * Open a run. A no-op while one is already open — opening a dataset that
   * pulls in several members is one run, not one per member — and a no-op
   * before the page has registered an environment, because a run whose
   * conditions cannot be recorded is not a comparable artifact.
   */
  openRun(cause: RunCause): void {
    if (this.open) return;
    const environment = this.environment;
    if (!environment) return;
    const startedAtMs = this.now();
    const startedAtEpochMs = this.epochNow();
    this.generation++;
    this.open = {
      runId: `run-${startedAtEpochMs}-${++this.runSeq}`,
      cause,
      environment,
      cacheWarmth: environment.captureWarmth(),
      startedAtMs,
      startedAtEpochMs,
      sink: this.sinkFactory(),
      generation: this.generation,
      counted: emptyCountedEvents(),
    };
    this.timeoutTimer = setTimeout(() => this.closeRun("timeout"), this.timeoutMs);
  }

  closeRun(endReason: EndReason): void {
    const run = this.open;
    if (!run) return;
    this.clearHoldTimer();
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.open = null;

    this.awaitingResident.length = 0;
    this.awaitingDrawn.length = 0;

    this.closed.push({
      sink: run.sink,
      counted: run.counted,
      header: {
        ...run.environment.captureConditions(),
        cacheWarmth: run.cacheWarmth,
        schemaVersion: TRACE_SCHEMA_VERSION,
        runId: run.runId,
        cause: run.cause,
        endReason,
        build: buildIdentity(),
        gpu: this.gpu,
        startedAtEpochMs: run.startedAtEpochMs,
        durationUs: clampStamp(Math.round((this.now() - run.startedAtMs) * 1000)),
        quiescenceHoldMs: this.quiescenceHoldMs,
        timeoutMs: this.timeoutMs,
        outstandingAtSettle: run.environment.captureOutstanding(),
      },
    });
  }

  /**
   * Take the page's published quiescence. A run closes only once the boolean
   * has held for the hold window, so a momentary lull between two bursts of
   * arrivals does not end the run early.
   */
  noteQuiescence(state: QuiescenceState): void {
    this.lastQuiescence = state;
    if (!this.open) return;
    if (!state.quiescent) {
      this.clearHoldTimer();
      return;
    }
    if (this.holdTimer !== null) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.closeRun("quiescent");
    }, this.quiescenceHoldMs);
  }

  /**
   * Start a lifecycle row. Returns a handle for {@link stamp} and
   * {@link finishRow}, or -1 when no run is open — rows outside a run are
   * counted so the document does not overstate what it kept.
   */
  beginChunkRow(src: ChunkRowSource, tier: 0 | 1): number {
    const run = this.open;
    if (!run) {
      this.rowsOutsideRun++;
      return -1;
    }
    const index = run.sink.append(src, tier);
    if (index < 0) return -1;
    return run.generation * GENERATION_STRIDE + index;
  }

  /**
   * Open the `plan` phase: the tick's wanted-set computation, including the
   * synchronous wasm calls inside it. Not a separate timing source — the same
   * clock and the same recorder as every other phase, so plan time is
   * comparable with the phases downstream of it rather than living in its own
   * units on its own track.
   *
   * Recording is continuous, so this is called on every tick whether a run is
   * open or not; a span nobody claims simply ages out of the ring.
   */
  markPlanStart(): void {
    this.openPlanStartMs = this.now();
  }

  /**
   * Close the plan pass at the moment its requests were handed to the
   * scheduler. The caller passes the timestamp it enqueued with rather than
   * letting the recorder read the clock again, so a row's plan end and its
   * queue start are the same number and the phases meet exactly.
   */
  notePlanEnqueue(enqueuedAtMs: number): void {
    const startMs = this.openPlanStartMs;
    if (startMs === null) return;
    this.openPlanStartMs = null;
    const slot = this.planSpanCount % PLAN_SPAN_RING;
    this.planStartsMs[slot] = startMs;
    this.planEndsMs[slot] = enqueuedAtMs;
    this.planSpanCount++;
  }

  /**
   * Stamp the boundary the `plan` and `queue` phases share: the moment the
   * scheduler admitted this request.
   *
   * `admittedAtMs` is the scheduler's own admission stamp when it has one
   * (ADR 0044 keeps them for the admission window only). Behind the window
   * the scheduler deliberately keeps no per-key bookkeeping — on a large
   * remote collection the backlog is tens of thousands of entries replanned
   * several times a second — so a row admitted straight off the backlog dates
   * its queue from the plan pass that enqueued it. Queue time before the
   * window is therefore a floor, not a total.
   *
   * `plan` is attributed to the last pass that ended at or before admission.
   * With no such pass in the ring the plan slot stays unset, which reads as
   * "not measured" rather than as a phase that took no time.
   */
  stampAdmission(handle: number, admittedAtMs: number | undefined): void {
    const run = this.resolve(handle);
    if (!run) return;
    const index = handle % GENERATION_STRIDE;
    const admittedMs = admittedAtMs ?? this.latestPlanEndMs() ?? this.now();

    const planStartMs = this.planStartAtOrBefore(admittedMs);
    if (planStartMs !== null) {
      run.sink.stamp(index, Boundary.PlanStart, this.offsetUs(run, planStartMs));
    }
    run.sink.stamp(index, Boundary.QueueStart, this.offsetUs(run, admittedMs));
  }

  /**
   * The chunk has been handed to the render worker. It becomes resident when
   * the worker gets to it, which the main thread learns by ordering rather
   * than by asking: the next render message cannot be processed before the
   * upload ahead of it.
   */
  noteHandedToRenderer(handle: number): void {
    if (handle < 0 || !this.resolve(handle)) return;
    this.awaitingResident.push(handle);
  }

  /**
   * A frame was dispatched to the render worker. Everything handed over since
   * the previous frame is resident as of now, and everything resident as of
   * the previous frame has been drawn.
   */
  noteFrameDispatched(): void {
    const drawn = this.awaitingDrawn;
    for (let i = 0; i < drawn.length; i++) {
      this.stamp(drawn[i], Boundary.PresentEnd);
      this.finishRow(drawn[i], RowOutcome.Complete);
    }
    drawn.length = 0;

    const resident = this.awaitingResident;
    for (let i = 0; i < resident.length; i++) {
      this.stamp(resident[i], Boundary.PresentStart);
    }
    // Swap rather than reallocate: the drained list becomes the next
    // frame's pending list.
    this.awaitingResident = drawn;
    this.awaitingDrawn = resident;
  }

  /**
   * Stages below the platform's 100 µs clock floor. Counted, never timed —
   * timing them would show quantisation noise wearing the costume of data.
   */
  countCacheAdmission(): void {
    if (this.open) this.open.counted.cacheAdmission++;
  }

  countWorkerDispatch(): void {
    if (this.open) this.open.counted.workerDispatch++;
  }

  countCoalesceAttach(): void {
    if (this.open) this.open.counted.coalesceAttach++;
  }

  /** Stamp a phase boundary as a microsecond offset from run start. */
  stamp(handle: number, boundary: number): void {
    const run = this.resolve(handle);
    if (!run) return;
    run.sink.stamp(
      handle % GENERATION_STRIDE,
      boundary,
      clampStamp(Math.round((this.now() - run.startedAtMs) * 1000)),
    );
  }

  finishRow(handle: number, outcome: RowOutcomeValue): void {
    const run = this.resolve(handle);
    if (!run) return;
    run.sink.setOutcome(handle % GENERATION_STRIDE, outcome);
  }

  /**
   * The trace seam's payload. Exporting closes the run in progress: end
   * reason is required on every run, and asking for the document is an
   * explicit close rather than a peek at a run that has not concluded.
   */
  exportDocument(): TraceDocument {
    this.closeRun("explicit");
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      exportedAtEpochMs: this.epochNow(),
      instrumentedPhases: [...INSTRUMENTED_PHASES],
      runs: this.closed.map<TraceRun>(run => ({
        header: run.header,
        rows: run.sink.serialise(),
        counted: run.counted,
      })),
      rowsOutsideRun: this.rowsOutsideRun,
    };
  }

  /**
   * Drop the whole recording, including the run in progress. The resident
   * cap and whole-run eviction that will call this in the product are #927;
   * until then it is how a test isolates one run from the next.
   */
  reset(): void {
    this.closeRun("explicit");
    this.closed = [];
    this.rowsOutsideRun = 0;
    this.lastQuiescence = null;
    this.planSpanCount = 0;
    this.openPlanStartMs = null;
  }

  private offsetUs(run: OpenRun, atMs: number): number {
    return clampStamp(Math.round((atMs - run.startedAtMs) * 1000));
  }

  private latestPlanEndMs(): number | null {
    if (this.planSpanCount === 0) return null;
    return this.planEndsMs[(this.planSpanCount - 1) % PLAN_SPAN_RING];
  }

  /** The start of the newest plan pass that had already enqueued by `atMs`. */
  private planStartAtOrBefore(atMs: number): number | null {
    const spans = Math.min(this.planSpanCount, PLAN_SPAN_RING);
    let bestEnd = -Infinity;
    let bestStart: number | null = null;
    for (let i = 0; i < spans; i++) {
      const end = this.planEndsMs[i];
      if (end > atMs || end <= bestEnd) continue;
      bestEnd = end;
      bestStart = this.planStartsMs[i];
    }
    return bestStart;
  }

  private resolve(handle: number): OpenRun | null {
    if (handle < 0) return null;
    const run = this.open;
    if (!run) return null;
    return Math.floor(handle / GENERATION_STRIDE) === run.generation ? run : null;
  }

  private clearHoldTimer(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}

/**
 * The process-wide recorder. A module singleton because the emit points are
 * deep in the pipeline and threading an instance to each of them would make
 * the presence of recording a per-call-site decision — which is the toggle
 * ADR 0049 rejected, in another costume.
 */
export const traceRecorder = new TraceRecorder();
