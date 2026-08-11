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
import { computeCoverage } from "./coverage.ts";
import { placeServerRows } from "./merge.ts";
import { CAP_DERIVATION, CAP_UNIT, PER_RUN_CAP_BYTES, RESIDENT_CAP_BYTES } from "./retention.ts";
import { ServerRowTable, type ServerTimingBatch } from "./serverRowTable.ts";
import type { QuiescenceState } from "./quiescence.ts";
import { tableSinkFactory, type TraceSink, type TraceSinkFactory } from "./sink.ts";
import { TickScratch } from "./tickRing.ts";
import {
  Boundary,
  clampStamp,
  COUNTED_PHASES,
  READING_NAMES,
  ReadingColumn,
  RowOutcome,
  TRACE_SCHEMA_VERSION,
  type ChunkEventSource,
  type ChunkRowSource,
  type ConnectionRecord,
  type CountedPhaseIndexValue,
  type DatasetOpenBracket,
  type EndReason,
  type CacheWarmth,
  type GpuIdentity,
  type Outstanding,
  type Phase,
  type PointEventIndex,
  type PointEventReason,
  type RowOutcomeValue,
  type RunCause,
  type RunConditions,
  type RunHeader,
  type TraceDocument,
  type TraceRun,
  type TruncationRecord,
  type WireLabel,
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
 * How many dataset opens one run brackets.
 *
 * A page opens a handful — a workspace reload opens its members, a person
 * opens one at a time — so this is a backstop against a page that loops,
 * not a budget anyone spends. Opens past it are counted rather than
 * bracketed, because their metadata rows then arrive unplaceable and a
 * silent cap would read as a server that stopped reporting.
 */
export const MAX_TRACKED_OPENS = 64;

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
  sinkFactory?: TraceSinkFactory;
  /** Monotonic milliseconds. Injectable so a test can drive run durations. */
  now?: () => number;
  /** Wall-clock epoch milliseconds, so an archived run has a date. */
  epochNow?: () => number;
  quiescenceHoldMs?: number;
  timeoutMs?: number;
}

/**
 * One interval of the continuous recording. A labelled run and the unlabelled
 * steady state between runs are the same object, differing only by `cause`
 * (ADR 0047) — which is why steady state is retained rather than thrown away:
 * the pan before a stall is often the thing that explains it.
 */
interface OpenInterval {
  runId: string;
  /** Null for the unlabelled steady-state interval. */
  cause: RunCause | null;
  /**
   * Held for the interval's lifetime. An interval cannot open without an
   * environment, so nothing downstream has to cope with its absence.
   */
  environment: TraceEnvironment;
  cacheWarmth: CacheWarmth;
  startedAtMs: number;
  startedAtEpochMs: number;
  sink: TraceSink;
  serverRows: ServerRowTable;
  /** Keyed by `request_id`, which is what the server's metadata rows join on. */
  datasetOpens: Map<string, DatasetOpenBracket>;
  datasetOpensDropped: number;
  /**
   * The sockets this interval spanned, oldest first, and the label range
   * minted on each. The range is what makes joinability decidable at ingest:
   * labels are minted monotonically from zero per connection, so a server row
   * naming a label outside the range this interval saw is a row this interval
   * can never place.
   */
  connections: ConnectionRecord[];
  /** Server rows refused because nothing in this interval could place them. */
  serverRowsDiscarded: number;
  generation: number;
  /**
   * Set once the interval crosses the per-run cap, and mutated from there on:
   * a truncated interval stops storing records but keeps counting them, which
   * is what turns "truncated at 18,000 rows" into "18,000 of an eventual
   * 63,412".
   */
  truncation: TruncationRecord | null;
}

interface ClosedInterval {
  header: RunHeader;
  sink: TraceSink;
  serverRows: ServerRowTable;
  datasetOpens: DatasetOpenBracket[];
  datasetOpensDropped: number;
  serverRowsDiscarded: number;
  /** Frozen at close, so the resident total is a running sum rather than a walk. */
  byteLength: number;
}

/** Row indices are packed with the run generation so a stale handle is inert. */
const GENERATION_STRIDE = 0x1000000;

export class TraceRecorder {
  private readonly sinkFactory: TraceSinkFactory;
  private readonly now: () => number;
  private readonly epochNow: () => number;
  private readonly quiescenceHoldMs: number;
  private readonly timeoutMs: number;

  private environment: TraceEnvironment | null = null;
  private gpu: GpuIdentity | null = null;

  private open: OpenInterval | null = null;
  private closed: ClosedInterval[] = [];
  /** Running sum over {@link closed}, so the resident cap is a comparison, not a walk. */
  private closedBytes = 0;
  private intervalsEvicted = 0;
  private generation = 0;
  private runSeq = 0;
  private rowsOutsideRun = 0;
  private serverRowsOutsideRun = 0;

  /**
   * The socket the page is on, and when it lost the previous one. Held across
   * intervals because a run can open in the middle of a connection — or in
   * the middle of an outage — and an interval that only knew about sockets it
   * personally watched connect could not say which connection its rows came
   * from.
   */
  private connectionGeneration = 0;
  private disconnectedAtMs: number | null = null;

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

  /**
   * One scratch sample and one counter vector for the whole process, refilled
   * per tick. A fresh object per tick would allocate on the pipeline's
   * hottest path, and an allocating recorder produces GC pauses that appear
   * as stalls in its own trace.
   */
  private readonly tickScratch = new TickScratch();
  private readonly countedPhases = new Uint32Array(COUNTED_PHASES.length);
  /** One vector, refilled per tick, for the same reason as the scratch above. */
  private readonly readingColumns = new Float64Array(READING_NAMES.length);
  private tickInProgress = false;

  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQuiescence: QuiescenceState | null = null;

  constructor(options: TraceRecorderOptions = {}) {
    this.sinkFactory = options.sinkFactory ?? tableSinkFactory;
    this.now = options.now ?? (() => performance.now());
    this.epochNow = options.epochNow ?? (() => Date.now());
    this.quiescenceHoldMs = options.quiescenceHoldMs ?? DEFAULT_QUIESCENCE_HOLD_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  /**
   * Register — or withdraw — the page that can say what conditions a run ran
   * under. Registering starts the unlabelled steady-state interval, because
   * recording is continuous and the interval before the first run is as
   * retainable as the ones between later runs.
   */
  setEnvironment(environment: TraceEnvironment | null): void {
    if (environment === this.environment) return;
    this.finishInterval("explicit");
    this.environment = environment;
    this.beginInterval(null);
  }

  setGpu(gpu: GpuIdentity | null): void {
    this.gpu = gpu;
  }

  /** Whether a *labelled* run is open. The unlabelled interval is not one. */
  get isRunOpen(): boolean {
    return this.open?.cause != null;
  }

  /**
   * How long `quiescent` must hold before a run closes itself. Readable from
   * outside because a driver that exports the moment the boolean first goes
   * true pre-empts that close, and every run it takes lands as `explicit`
   * when it settled.
   */
  get holdMs(): number {
    return this.quiescenceHoldMs;
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
    if (this.open?.cause) return;
    if (!this.environment) return;
    // Hand the steady state that led up to this run over as its own interval,
    // rather than folding it into the run and dating the run from before its
    // cause.
    this.finishInterval("run-opened");
    this.beginInterval(cause);
  }

  /**
   * Close the interval in progress and start the next steady-state one.
   * Recording is continuous: there is no state in which the recorder is
   * merely counting what it saw, only one in which no page has told it what
   * conditions it would be recording under.
   */
  closeRun(endReason: EndReason): void {
    if (!this.open) return;
    this.finishInterval(endReason);
    this.beginInterval(null);
  }

  /**
   * Take the page's published quiescence. A run closes only once the boolean
   * has held for the hold window, so a momentary lull between two bursts of
   * arrivals does not end the run early.
   */
  noteQuiescence(state: QuiescenceState): void {
    this.lastQuiescence = state;
    // Settling ends a labelled run. The unlabelled interval has nothing to
    // settle into — it is what a settled page records.
    if (!this.isRunOpen) {
      this.clearHoldTimer();
      return;
    }
    // An unsettled dataset open holds the run open, whatever the page's
    // predicate says. Before the first chunk exists the pipeline is
    // trivially quiescent — nothing dirty, nothing wanted — so a cold open
    // would otherwise close its own run 500 ms in and discard the metadata
    // reads it is still waiting on, which is the whole of a cold open.
    if (!state.quiescent || this.hasUnsettledOpen()) {
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
   * {@link finishRow}, or -1 when there is no interval to record into —
   * either no page has registered an environment, or the interval has
   * truncated. Both cases are counted so the document does not overstate what
   * it kept.
   */
  beginChunkRow(src: ChunkRowSource, tier: 0 | 1): number {
    const run = this.intervalForRecording();
    if (!run) {
      this.countRefusedRow();
      return -1;
    }
    const index = run.sink.append(src, tier);
    if (index < 0) return -1;
    return run.generation * GENERATION_STRIDE + index;
  }

  /** A row nobody kept is counted either way, so coverage is never overstated. */
  private countRefusedRow(): void {
    const truncation = this.open?.truncation;
    if (truncation) truncation.rowsUnrecorded++;
    else this.rowsOutsideRun++;
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
   *
   * A row exists only for a chunk this page fetched. A chunk re-delivered
   * from the CPU cache — evicted from the GPU and sent again within the same
   * page — carries no row and so contributes no second `upload`. Its first
   * delivery is recorded; the re-delivery is not.
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
   * Record which wire request a row's chunk rode on. Called for the sender
   * and for every caller that coalesced onto it, which is what makes the
   * join to the server's table a plain equi-join.
   */
  labelRow(handle: number, label: WireLabel): void {
    const run = this.resolve(handle);
    if (!run) return;
    run.sink.setLabel(handle % GENERATION_STRIDE, label);
    this.trackLabel(run, label);
  }

  /**
   * Widen the connection's label range. Labels are minted monotonically from
   * zero per connection, so first and last bound every label this interval
   * sent over that socket — which is the whole of what a server row has to be
   * inside to be joinable here.
   */
  private trackLabel(run: OpenInterval, label: WireLabel): void {
    if (label.connectionGeneration === 0) return;
    let record = this.connectionRecord(run, label.connectionGeneration);
    if (!record) {
      record = {
        generation: label.connectionGeneration,
        // Not witnessed: the interval began mid-connection, or opened before
        // the page reported this socket.
        openedAtUs: null,
        closedAtUs: null,
        gapUs: null,
        firstRid: null,
        lastRid: null,
      };
      run.connections.push(record);
    }
    record.firstRid = record.firstRid === null ? label.rid : Math.min(record.firstRid, label.rid);
    record.lastRid = record.lastRid === null ? label.rid : Math.max(record.lastRid, label.rid);
  }

  /**
   * A dataset-open request went out. Opens the run if none is open: this
   * *is* the start of the cold open the monitor exists to explain, and a
   * run that began when the first chunk arrived would leave the reads that
   * decided the dataset's shape outside every run there was.
   *
   * The bracket is what the server's metadata-read rows nest inside, so an
   * open that is never noted here files rows nobody can place.
   */
  noteOpenSent(requestId: string): void {
    this.openRun({ epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" });
    const run = this.open;
    if (!run) return;
    if (run.datasetOpens.has(requestId)) return;
    if (run.datasetOpens.size >= MAX_TRACKED_OPENS) {
      run.datasetOpensDropped++;
      return;
    }
    run.datasetOpens.set(requestId, {
      requestId,
      startUs: this.offsetUs(run, this.now()),
      endUs: null,
    });
  }

  /**
   * The open settled, either way. A failed open closes its bracket exactly
   * as a successful one does — its reads are the ones most worth reading,
   * and dropping them here would lose them in the case that needs them.
   */
  noteOpenSettled(requestId: string): void {
    const run = this.open;
    if (!run) return;
    const open = run.datasetOpens.get(requestId);
    // A second terminal frame for one open — a failure after a warning, a
    // stray progress frame — must not move an end that already happened.
    if (!open || open.endUs !== null) return;
    open.endUs = this.offsetUs(run, this.now());
    // The open was the only thing holding the run; re-read the page's last
    // published state so a run that has been quiescent all along can now
    // start its hold rather than waiting for the next tick that may never
    // come.
    if (this.lastQuiescence) this.noteQuiescence(this.lastQuiescence);
  }

  /** Whether any open this run brackets is still in flight. */
  private hasUnsettledOpen(): boolean {
    const run = this.open;
    if (!run) return false;
    for (const open of run.datasetOpens.values()) {
      if (open.endUs === null) return true;
    }
    return false;
  }

  /**
   * The page is on a socket. Called on every `onopen`, including the first:
   * the generation restarts the correlation label counter (ADR 0048), so this
   * is the only thing that makes two `rid: 0` rows in one run tell apart.
   */
  noteConnected(generation: number): void {
    const atMs = this.now();
    const gapMs = this.disconnectedAtMs === null ? null : atMs - this.disconnectedAtMs;
    this.disconnectedAtMs = null;
    if (this.connectionGeneration === generation) return;
    this.connectionGeneration = generation;
    const run = this.open;
    if (!run) return;
    run.connections.push({
      generation,
      openedAtUs: this.offsetUs(run, atMs),
      closedAtUs: null,
      gapUs: gapMs === null ? null : clampStamp(Math.round(gapMs * 1000)),
      firstRid: null,
      lastRid: null,
    });
  }

  /**
   * The socket dropped. The browser declares this because it is the side
   * holding the facts: the server cannot tell a reconnecting client from a
   * new one, and the rows it had buffered for the dead connection are
   * discarded rather than replayed.
   */
  noteDisconnected(): void {
    const atMs = this.now();
    if (this.disconnectedAtMs === null) this.disconnectedAtMs = atMs;
    const run = this.open;
    if (!run) return;
    const current = run.connections[run.connections.length - 1];
    if (current && current.closedAtUs === null) current.closedAtUs = this.offsetUs(run, atMs);
  }

  /**
   * Take a flush window of the server's rows. They belong to the run that is
   * open when they arrive; rows that arrive between runs are counted and
   * dropped, because an unjoinable server row is not a diagnostic and
   * keeping it would spend budget on nothing.
   */
  ingestServerBatch(batch: ServerTimingBatch, connectionGeneration: number): void {
    const run = this.intervalForRecording();
    // Dropped but still counted, on whichever side: silently not counting one
    // side of the join would overstate coverage asymmetrically.
    if (!run) {
      const truncation = this.open?.truncation;
      if (truncation) truncation.serverRowsUnrecorded += batch.rid.length;
      else this.serverRowsOutsideRun += batch.rid.length;
      return;
    }
    // A row this interval could never place is refused at the door rather
    // than stored as an orphan: storing it would spend the very budget
    // truncation exists to protect, and would then be reported as coverage
    // this run does not have.
    run.serverRowsDiscarded += run.serverRows.ingest(
      batch,
      connectionGeneration,
      (rid, requestId, family) =>
        family === "metadata_read"
          ? requestId !== null && run.datasetOpens.has(requestId)
          : this.mintedLabel(run, connectionGeneration, rid),
    );
  }

  /** Whether this interval minted `rid` on `generation` — see {@link OpenInterval.connections}. */
  private mintedLabel(run: OpenInterval, generation: number, rid: number): boolean {
    const record = this.connectionRecord(run, generation);
    if (!record || record.firstRid === null || record.lastRid === null) return false;
    return rid >= record.firstRid && rid <= record.lastRid;
  }

  /**
   * This interval's record for one connection, opened on first sight. An
   * interval can begin mid-connection, in which case the first thing it hears
   * about the socket it is already on is a label minted over it.
   */
  private connectionRecord(run: OpenInterval, generation: number): ConnectionRecord | null {
    if (generation === 0) return null;
    for (let i = run.connections.length - 1; i >= 0; i--) {
      if (run.connections[i].generation === generation) return run.connections[i];
    }
    return null;
  }

  /** Stamp a phase boundary as a microsecond offset from run start. */
  stamp(handle: number, boundary: number): void {
    const run = this.resolve(handle);
    if (!run) return;
    run.sink.stamp(handle % GENERATION_STRIDE, boundary, this.offsetUs(run, this.now()));
  }

  finishRow(handle: number, outcome: RowOutcomeValue): void {
    const run = this.resolve(handle);
    if (!run) return;
    run.sink.setOutcome(handle % GENERATION_STRIDE, outcome);
  }

  /**
   * Start a per-tick aggregate sample for one dataset, returning the scratch
   * to fill in place, or null when no run is open. Every caller must reach
   * {@link commitTick} — a sample abandoned half-filled would be published on
   * the next tick with a mixture of two ticks' counts.
   *
   * One sample per dataset planned, not one per tick: lane counts and the
   * per-level breakdown both vary per dataset, and summing them across a
   * multi-dataset workspace would produce a total that describes nothing.
   */
  beginTick(datasetId: string): TickScratch | null {
    if (!this.open) return null;
    this.tickScratch.reset(datasetId);
    this.tickInProgress = true;
    return this.tickScratch;
  }

  /**
   * Publish the sample {@link beginTick} handed out. The counted-not-timed
   * phase tallies ride along and reset here, so each sample carries the
   * counts since the previous published sample rather than since run start.
   */
  commitTick(): void {
    if (!this.tickInProgress) return;
    this.tickInProgress = false;
    const run = this.intervalForRecording();
    if (run) {
      run.sink.appendTick(this.offsetUs(run, this.now()), this.tickScratch, this.countedPhases);
    } else if (this.open?.truncation) {
      this.open.truncation.ticksUnrecorded++;
    }
    // Either way the tallies belong to the interval just ended, not the next
    // one: carrying them forward would publish two intervals' counts as one.
    this.countedPhases.fill(0);
  }

  /**
   * Record the process-wide readings: queue depth, in-flight, the tick's own
   * main-thread time, and resident bytes (#934).
   *
   * Pushed by the render loop once per tick, next to the published
   * quiescence, rather than pulled when a tick sample is committed. A tick
   * sample is per planning pass, and the planner's epoch cache means a run
   * can fetch for seconds without re-planning once — readings on that cadence
   * are a cluster of readings at run start and silence after.
   */
  noteReading(
    queueDepth: number,
    inFlight: number,
    frameTimeUs: number,
    residentBytes: number,
  ): void {
    const run = this.open;
    if (!run) return;
    this.readingColumns[ReadingColumn.QueueDepth] = queueDepth;
    this.readingColumns[ReadingColumn.InFlight] = inFlight;
    this.readingColumns[ReadingColumn.FrameTimeUs] = frameTimeUs;
    this.readingColumns[ReadingColumn.ResidentBytes] = residentBytes;
    run.sink.appendReading(this.offsetUs(run, this.now()), this.readingColumns);
  }

  /**
   * Count one occurrence of a phase too short to time. Silent outside a run,
   * like every other tier: a count with no interval to belong to cannot be
   * read as a rate.
   */
  countPhase(phase: CountedPhaseIndexValue, times = 1): void {
    if (!this.open) return;
    this.countedPhases[phase] += times;
  }

  /**
   * Record one point event. `chunk` is whatever the emit site already holds —
   * a planned request or a resident cache entry — or null when the event is
   * not about a single chunk.
   */
  recordPointEvent(
    kind: PointEventIndex,
    reason: PointEventReason,
    chunk: ChunkEventSource | null = null,
    tier: 0 | 1 = 0,
  ): void {
    const run = this.intervalForRecording();
    if (!run) {
      if (this.open?.truncation) this.open.truncation.eventsUnrecorded++;
      return;
    }
    run.sink.appendEvent(this.offsetUs(run, this.now()), kind, reason, chunk, tier);
  }

  /**
   * The trace seam's payload. Exporting closes the run in progress: end
   * reason is required on every run, and asking for the document is an
   * explicit close rather than a peek at a run that has not concluded.
   */
  exportDocument(): TraceDocument {
    this.closeRun("explicit");
    const intervals = this.closed.map(interval => this.serialiseInterval(interval));
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      exportedAtEpochMs: this.epochNow(),
      retention: {
        residentCapBytes: RESIDENT_CAP_BYTES,
        perRunCapBytes: PER_RUN_CAP_BYTES,
        residentBytes: this.closedBytes + (this.open ? intervalBytes(this.open) : 0),
        intervalsEvicted: this.intervalsEvicted,
        derivedFrom: CAP_DERIVATION,
        capUnit: CAP_UNIT,
      },
      instrumentedPhases: [...INSTRUMENTED_PHASES],
      countedPhases: [...COUNTED_PHASES],
      runs: intervals.filter(interval => interval.header.cause !== null),
      steadyState: intervals.filter(interval => interval.header.cause === null),
      rowsOutsideRun: this.rowsOutsideRun,
      serverRowsOutsideRun: this.serverRowsOutsideRun,
    };
  }

  /**
   * Drop the whole recording, including the interval in progress, and start a
   * fresh steady-state one. Nothing in the product calls this — retention is
   * whole-interval eviction under the resident cap — but a test needs one run
   * isolated from the next.
   */
  reset(): void {
    this.finishInterval("explicit");
    this.closed = [];
    this.closedBytes = 0;
    this.intervalsEvicted = 0;
    this.rowsOutsideRun = 0;
    this.serverRowsOutsideRun = 0;
    this.lastQuiescence = null;
    this.planSpanCount = 0;
    this.openPlanStartMs = null;
    this.beginInterval(null);
  }

  private beginInterval(cause: RunCause | null): void {
    const environment = this.environment;
    if (!environment) return;
    const startedAtEpochMs = this.epochNow();
    this.generation++;
    this.open = {
      runId: `${cause ? "run" : "steady"}-${startedAtEpochMs}-${++this.runSeq}`,
      cause,
      environment,
      cacheWarmth: environment.captureWarmth(),
      startedAtMs: this.now(),
      startedAtEpochMs,
      sink: this.sinkFactory(),
      serverRows: new ServerRowTable(),
      datasetOpens: new Map(),
      datasetOpensDropped: 0,
      // The socket the page is on right now, if it is on one. An interval
      // that opens during an outage starts with no connection and gets its
      // first when the page reconnects — which is also where the outage that
      // preceded it gets declared.
      connections:
        this.connectionGeneration !== 0 && this.disconnectedAtMs === null
          ? [
              {
                generation: this.connectionGeneration,
                openedAtUs: null,
                closedAtUs: null,
                gapUs: null,
                firstRid: null,
                lastRid: null,
              },
            ]
          : [],
      serverRowsDiscarded: 0,
      generation: this.generation,
      truncation: null,
    };
    // A fresh interval preallocates its buffers, so opening one spends from
    // the resident budget before it has recorded anything. Evict here as well
    // as on append, or the total sits above the cap for as long as the page
    // is idle — which is exactly when nobody is appending.
    this.evictToResidentCap(intervalBytes(this.open));
    // Only a labelled run can fail to settle. Steady state is what a settled
    // page records, so there is nothing for a timeout to declare about it.
    if (cause) this.timeoutTimer = setTimeout(() => this.closeRun("timeout"), this.timeoutMs);
  }

  private finishInterval(endReason: EndReason): void {
    const run = this.open;
    if (!run) return;
    this.clearHoldTimer();
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.open = null;
    // A tick half-filled when the interval closed belongs to no interval, and
    // the counts behind it belong to no interval either.
    this.tickInProgress = false;
    this.countedPhases.fill(0);

    this.awaitingResident.length = 0;
    this.awaitingDrawn.length = 0;

    // An unlabelled interval that recorded nothing is not an artifact. A
    // labelled run that recorded nothing is — a run that saw no work is
    // exactly the news somebody is looking for.
    if (run.cause === null && run.sink.isEmpty && run.serverRows.length === 0) return;

    const byteLength = intervalBytes(run);
    this.closed.push({
      sink: run.sink,
      serverRows: run.serverRows,
      // An open still in flight keeps its null end rather than being
      // dropped or given the interval's close as an end it never reached.
      datasetOpens: [...run.datasetOpens.values()],
      datasetOpensDropped: run.datasetOpensDropped,
      serverRowsDiscarded: run.serverRowsDiscarded,
      byteLength,
      header: {
        ...run.environment.captureConditions(),
        cacheWarmth: run.cacheWarmth,
        schemaVersion: TRACE_SCHEMA_VERSION,
        runId: run.runId,
        cause: run.cause,
        endReason,
        truncation: run.truncation,
        build: buildIdentity(),
        gpu: this.gpu,
        startedAtEpochMs: run.startedAtEpochMs,
        durationUs: clampStamp(Math.round((this.now() - run.startedAtMs) * 1000)),
        quiescenceHoldMs: this.quiescenceHoldMs,
        timeoutMs: this.timeoutMs,
        outstandingAtSettle: run.environment.captureOutstanding(),
        connections: run.connections,
      },
    });
    this.closedBytes += byteLength;
    this.evictToResidentCap(0);
  }

  /**
   * The interval a new record belongs in, once the caps have had their say —
   * or null when there is nowhere to put it.
   *
   * Checked before the write rather than after it, so a rotation hands the
   * caller a live interval instead of a handle into one that just closed.
   *
   * The two rungs, in the order they bite. The per-run cap acts on the
   * interval in progress; the resident cap discards completed intervals
   * oldest-first. There is deliberately no third rung: no sampling, no
   * coarsening, no downsample to aggregates. Reaching the per-run cap means
   * something pathological is happening, and a loud truncation diagnoses
   * pathology better than a quietly coarsened trace that still looks
   * complete (ADR 0049).
   */
  private intervalForRecording(): OpenInterval | null {
    const run = this.open;
    if (!run || run.truncation) return null;

    const openBytes = intervalBytes(run);
    if (openBytes <= PER_RUN_CAP_BYTES) {
      this.evictToResidentCap(openBytes);
      return run;
    }

    // A run truncates because the beginning of a run is its diagnostic
    // payload. Steady state has no privileged start — it is the same kind of
    // stream the tick and event rings drop the oldest of — so truncating it
    // would delete the most recent pan, which is the one thing it is retained
    // for. It hands over to a fresh interval instead, and the old one ages
    // out under the resident cap like any other completed interval.
    if (run.cause === null) {
      this.finishInterval("rotated");
      this.beginInterval(null);
      return this.open;
    }

    run.truncation = {
      reason: "per-run-cap",
      atUs: this.offsetUs(run, this.now()),
      capBytes: PER_RUN_CAP_BYTES,
      rowsRecorded: run.sink.length,
      rowsUnrecorded: 0,
      ticksUnrecorded: 0,
      eventsUnrecorded: 0,
      serverRowsUnrecorded: 0,
    };
    this.evictToResidentCap(openBytes);
    return null;
  }

  /**
   * Whole completed intervals, oldest first, never the one in progress. A
   * half-evicted interval is not a diagnostic artifact, and the interval
   * being recorded right now is the one somebody is about to ask about.
   */
  private evictToResidentCap(openBytes: number): void {
    while (this.closed.length > 0 && this.closedBytes + openBytes > RESIDENT_CAP_BYTES) {
      const evicted = this.closed.shift();
      if (!evicted) return;
      this.closedBytes -= evicted.byteLength;
      this.intervalsEvicted++;
    }
  }

  private serialiseInterval(interval: ClosedInterval): TraceRun {
    const rows = interval.sink.serialise();
    const ticks = interval.sink.serialiseTicks();
    const ticksDropped = interval.sink.ticksDropped;
    const eventsDropped = interval.sink.eventsDropped;
    const serverRowsDropped = interval.serverRows.droppedCount;
    return {
      header: interval.header,
      coverage: computeCoverage({
        wallClockUs: interval.header.durationUs,
        rows,
        ticks,
        truncation: interval.header.truncation,
        ticksDropped,
        eventsDropped,
        serverRowsDropped,
        serverRowsDiscarded: interval.serverRowsDiscarded,
        connections: interval.header.connections,
      }),
      rows,
      ticks,
      ticksDropped,
      readings: interval.sink.serialiseReadings(),
      readingsDropped: interval.sink.readingsDropped,
      events: interval.sink.serialiseEvents(),
      eventsDropped,
      // Placement happens here, at export, because it needs both tables
      // — and because the in-memory model stays a table.
      serverRows: placeServerRows(rows, interval.serverRows.serialise(), interval.datasetOpens),
      datasetOpens: interval.datasetOpens,
      datasetOpensDropped: interval.datasetOpensDropped,
      serverRowsDropped,
      serverRowsDiscarded: interval.serverRowsDiscarded,
    };
  }

  private offsetUs(run: OpenInterval, atMs: number): number {
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

  private resolve(handle: number): OpenInterval | null {
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

/** Every tier an interval holds. Allocated bytes, because the cap is on memory. */
function intervalBytes(interval: Pick<OpenInterval, "sink" | "serverRows">): number {
  return interval.sink.byteLength + interval.serverRows.byteLength;
}

/**
 * The process-wide recorder. A module singleton because the emit points are
 * deep in the pipeline and threading an instance to each of them would make
 * the presence of recording a per-call-site decision — which is the toggle
 * ADR 0049 rejected, in another costume.
 */
export const traceRecorder = new TraceRecorder();
