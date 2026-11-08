/**
 * The recorder: unconditional, run-scoped, and the only thing that knows
 * when a lifecycle row belongs to a run.
 *
 * Recording is on in every build with no toggle at any scope. An
 * idle viewer emits nothing because the render loop is dirty-driven, so the
 * recording costs nothing at rest, and a switch would only invite every
 * unexplained stall to be blamed on the monitor.
 */

import { buildIdentity } from "./buildInfo.ts";
import { computeCoverage } from "./coverage.ts";
import { readChunk } from "./diagnose/chunkLookup.ts";
import type { ChunkReading } from "./diagnose/chunkStates.ts";
import type { ChunkLookup } from "./diagnose/types.ts";
import {
  deriveProvisional,
  resolveLiveWindow,
  type ProvisionalOptions,
  type ProvisionalReading,
} from "./diagnose/provisional.ts";
import {
  DEFAULT_LIVE_TIMELINE_WINDOW_MS,
  deriveLiveTimeline,
  intervalFrom,
  type LiveTimeline,
  type LiveTimelineOptions,
} from "./diagnose/timeline.ts";
import type { TimelineInterval } from "./diagnose/types.ts";
import { placeServerRows } from "./merge.ts";
import { CAP_DERIVATION, CAP_UNIT, PER_RUN_CAP_BYTES, RESIDENT_CAP_BYTES } from "./retention.ts";
import {
  ServerRowTable,
  type ServerTimingBatch,
  type WireRowFamily,
} from "./serverRowTable.ts";
import type {
  LivePhaseOccupancy,
  LiveProgress,
  RunBoundary,
  WatchCursor,
  WatchSample,
} from "./liveProgress.ts";
import type { QuiescenceState } from "./quiescence.ts";
import { addSend, SEND_COLUMN_COUNT, sendTalliesFrom } from "./sendAccounting.ts";
import { tableSinkFactory, type TraceSink, type TraceSinkFactory } from "./sink.ts";
import { TickScratch } from "./tickRing.ts";
import {
  Boundary,
  chunkKeyOf,
  clampStamp,
  COUNTED_PHASES,
  interactionCause,
  PHASES,
  READING_NAMES,
  ReadingColumn,
  RowOutcome,
  SEND_COLUMNS,
  TRACE_SCHEMA_VERSION,
  type ChunkCoordinates,
  type ChunkEventSource,
  type ChunkRowSource,
  type ClientMessageTypeIndexValue,
  type ConnectionRecord,
  type CountedPhaseIndexValue,
  type DatasetOpenBracket,
  type EndReason,
  type CacheWarmth,
  type GpuIdentity,
  type InputKind,
  type Outstanding,
  type Phase,
  type PointEventIndex,
  type PointEventReason,
  type RowOutcomeValue,
  type RunCause,
  type RunConditions,
  type RunHeader,
  type SendTallies,
  type TraceDocument,
  type TraceRun,
  type TruncationRecord,
  type WireLabel,
} from "./types.ts";

/**
 * Phases whose boundaries are stamped. Declared rather than inferred so a
 * document says what it did not measure even when every phase happens to be
 * missing from a given row.
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
 * staying small against a healthy sub-second local open. It goes
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

/** Observes one committed per-tick aggregate sample. See {@link TraceRecorder.onTick}. */
export type TickListener = (sample: TickScratch) => void;

/**
 * The most recent reading, as the recorder keeps it: one object overwritten
 * per reading rather than a copy per reading, so a surface that samples at
 * its own cadence reads it for nothing and never walks the ring.
 */
export interface LatestReading {
  /**
   * Counts up once per reading, so a reader can tell a fresh reading from
   * the one it already saw. Zero before the first.
   */
  seq: number;
  /** The recorder's clock at the reading. */
  atMs: number;
  queueDepth: number;
  inFlight: number;
  frameTimeUs: number;
  residentBytes: number;
  /**
   * Null when the reading carried none: no frame was read back since the
   * previous reading, or the adapter offers no timestamp queries.
   */
  gpuPassUs: number | null;
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
 * steady state between runs are the same object, differing only by `cause`.
 * Steady state is retained because the pan before a stall is often the thing
 * that explains it.
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
  /**
   * Messages and bytes per client message type, counted at each send. A
   * counter, not a record: it lives outside the sink and the caps, and it
   * keeps counting past a truncation, as `rowsUnrecorded` does.
   */
  sent: Float64Array;
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
  /**
   * The recorder's own clock at the interval's start, so the live timeline
   * can place a closed interval on the open run's clock without going
   * through the header's epoch start.
   */
  startedAtMs: number;
  sink: TraceSink;
  serverRows: ServerRowTable;
  datasetOpens: DatasetOpenBracket[];
  datasetOpensDropped: number;
  serverRowsDiscarded: number;
  sent: SendTallies;
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
  private gpuIdentity: GpuIdentity | null = null;

  private open: OpenInterval | null = null;
  private readonly runBoundaryListeners = new Set<(boundary: RunBoundary) => void>();
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
  /**
   * Sends since the previous tick sample: process-wide and reset per sample,
   * like `countedPhases`.
   */
  private readonly sendSample = new Uint32Array(SEND_COLUMN_COUNT);
  /** One vector, refilled per tick, for the same reason as the scratch above. */
  private readonly readingColumns = new Float64Array(READING_NAMES.length);
  /** The loop's word on what woke the tick in progress; see {@link noteTickWake}. */
  private availabilityWoken = false;
  /**
   * The live view's phase-occupancy vector, refilled per poll rather than
   * allocated per poll. The progress it produces is a fresh object by
   * design: it is a copy handed to a surface, not something the recorder
   * keeps.
   */
  private readonly occupancyScratch = new Uint32Array(PHASES.length);
  private tickInProgress = false;

  /**
   * The last target level range each dataset was sampled at, mutated in place
   * so steady state allocates nothing. Page-scoped rather than interval-scoped
   * on purpose: the zoom that moves the target is often the cause of the run
   * that follows, and that run has to be able to say so.
   */
  private readonly lastTargetByDataset = new Map<string, { min: number; max: number }>();

  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQuiescence: QuiescenceState | null = null;

  private readonly tickListeners = new Set<TickListener>();
  private readonly latest: LatestReading = {
    seq: 0,
    atMs: 0,
    queueDepth: 0,
    inFlight: 0,
    frameTimeUs: 0,
    residentBytes: 0,
    gpuPassUs: null,
  };
  /**
   * Never reset, unlike the per-interval send tallies, so a reader at any
   * cadence takes a rate by differencing.
   */
  private sentBytesTotal = 0;
  private receivedBytesTotal = 0;

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
    this.gpuIdentity = gpu;
  }

  /** The adapter the page resolved, or null before it did or where there is no WebGPU. */
  get gpu(): GpuIdentity | null {
    return this.gpuIdentity;
  }

  /** Bytes the page has sent over the session socket since it loaded. */
  get bytesSent(): number {
    return this.sentBytesTotal;
  }

  /** Bytes the page has received over the session socket since it loaded. */
  get bytesReceived(): number {
    return this.receivedBytesTotal;
  }

  /** The most recent reading. `seq` is zero before the first. */
  get latestReading(): Readonly<LatestReading> {
    return this.latest;
  }

  /**
   * Watch each per-tick aggregate sample as {@link commitTick} publishes it.
   *
   * The listener receives the recorder's reusable scratch, valid for the
   * duration of the call: read it there and copy what you keep. It runs on
   * the planning pass, so it must be a few field reads and no allocation.
   * This is how a surface that draws at the tick cadence sees every
   * dataset's sample without walking the ring: the ring stays the record,
   * and this is a notification.
   */
  onTick(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => {
      this.tickListeners.delete(listener);
    };
  }

  /** Whether a *labelled* run is open. The unlabelled interval is not one. */
  get isRunOpen(): boolean {
    return this.open?.cause != null;
  }

  /**
   * The labelled runs that concluded on their own, by settling or timing
   * out, with the id of the most recent one. What a driver waits for, and
   * readable without exporting because exporting closes the run asked about.
   *
   * An `explicit` close is excluded because somebody asked for it: a page
   * torn down and rebuilt hands back a run that lived under a millisecond.
   * The id matters because the export closes an interval of its own, so the
   * newest run in the document is not the run that was waited for.
   */
  get concludedRuns(): { count: number; lastId: string | null } {
    let count = 0;
    let lastId: string | null = null;
    for (const interval of this.closed) {
      const { cause, endReason, runId } = interval.header;
      if (!cause || (endReason !== "quiescent" && endReason !== "timeout")) continue;
      count += 1;
      lastId = runId;
    }
    return { count, lastId };
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
   * What the run in progress can say about itself, or null when no labelled
   * run is open.
   *
   * Does not conclude the interval it describes. The document, the Chrome
   * projection, and the diagnostic all close the run, because a run without
   * an end reason is not an artifact. This returns counts and occupancy
   * rather than a verdict for the same reason: the attribution back-walk
   * needs an end to walk back from. Walks no row: the tally is kept as the
   * rows are written.
   */
  get liveProgress(): LiveProgress | null {
    const run = this.open;
    if (!run?.cause) return null;
    return this.progressAt(run, run.cause, this.now());
  }

  /**
   * A provisional reading over a trailing window of the run in progress, or
   * null when no labelled run is open.
   *
   * Labelled provisional in every rendering because it changes while it is
   * read. It is never a verdict, the gate never reads it, and asking does not
   * close the run. Walks no row: the tally comes from the row table's
   * counters and the rest from the readings inside the window, so the cost is
   * bounded by the window, never by the run.
   */
  provisionalReading(options: ProvisionalOptions = {}): ProvisionalReading | null {
    const run = this.open;
    if (!run?.cause) return null;
    const nowMs = this.now();
    const atUs = this.offsetUs(run, nowMs);
    const window = resolveLiveWindow(atUs, options.windowMs);
    return deriveProvisional(
      {
        progress: this.progressAt(run, run.cause, nowMs),
        atUs,
        readings: run.sink.serialiseReadingsFrom(window.startUs),
        readingsDropped: run.sink.readingsDropped,
      },
      options,
    );
  }

  /**
   * The steady-state tiers since `since`, or null before the page has an
   * interval to sample.
   *
   * Does not conclude the interval. Each ring is read from its newest slot
   * back to the cursor, so the cost is the samples in that stretch.
   *
   * A cursor's offset means nothing once its interval has handed over. With
   * no cursor the sample is empty and only fixes where the next one starts:
   * a reader that just arrived is owed the present. Across a handover the new
   * interval is read from its start, because that is the opening of the run
   * somebody asked to watch.
   */
  watchSample(since: WatchCursor | null): WatchSample | null {
    const interval = this.open;
    if (!interval) return null;
    const atUs = this.offsetUs(interval, this.now());
    const fromUs =
      since === null
        ? atUs
        : since.intervalId === interval.runId
          ? since.atUs
          : // Before the interval's first stamp, so a sample at offset zero
            // is inside the stretch rather than on its edge.
            -1;
    // Strictly after the cursor: a sample the previous aggregate carried is
    // not news.
    const readings = interval.sink
      .serialiseReadingsFrom(fromUs)
      .filter((reading) => reading.atUs > fromUs);
    return {
      intervalId: interval.runId,
      runId: interval.cause ? interval.runId : null,
      atUs,
      reading: readings.at(-1) ?? null,
      ticks: interval.sink.serialiseTicksFrom(fromUs).filter((tick) => tick.atUs > fromUs),
    };
  }

  /**
   * Be told when a labelled run opens and when it ends.
   *
   * A pull cannot see an end reason: the run is gone by the time a poll
   * notices, and `quiescent`, `timeout`, and `explicit` are the difference
   * between a run that settled and one that never did. The unlabelled
   * steady-state interval's edges go unannounced: it has no cause to name
   * and its end is the next run's opening.
   *
   * A listener runs inside the close, so it must record or forward the
   * boundary and not call back into the recorder.
   */
  onRunBoundary(listener: (boundary: RunBoundary) => void): () => void {
    this.runBoundaryListeners.add(listener);
    return () => this.runBoundaryListeners.delete(listener);
  }

  private announceRunBoundary(boundary: RunBoundary): void {
    for (const listener of this.runBoundaryListeners) listener(boundary);
  }

  /**
   * The timeline of the run in progress over a trailing window, or null
   * when no labelled run is open: the dock's live charts, as fields.
   *
   * Does not conclude the interval. It draws only from tiers it can read
   * from the newest slot back to the window's start, so the cost is bounded
   * by the window, never by the run. Charts read from the rows are absent
   * and say when they are read: at close, or when a verdict is asked for.
   */
  liveTimeline(options: LiveTimelineOptions = {}): LiveTimeline | null {
    const run = this.open;
    if (!run?.cause) return null;
    const atUs = this.offsetUs(run, this.now());
    const window = resolveLiveWindow(atUs, options.windowMs ?? DEFAULT_LIVE_TIMELINE_WINDOW_MS);
    return deriveLiveTimeline(
      {
        runId: run.runId,
        cause: run.cause,
        atUs,
        readings: run.sink.serialiseReadingsFrom(window.startUs),
        readingsDropped: run.sink.readingsDropped,
        ticks: run.sink.serialiseTicksFrom(window.startUs),
        ticksDropped: run.sink.ticksDropped,
        events: run.sink.serialiseEventsFrom(window.startUs),
        eventsDropped: run.sink.eventsDropped,
        connections: run.connections,
        gpu: this.gpu,
        intervals: this.closedIntervalsOn(run),
        sentTotalBytes: sentBytes(run.sent),
      },
      options,
    );
  }

  /**
   * Read off the closed intervals' headers alone; no tier of theirs is
   * copied for this. An empty steady-state interval was never retained, so
   * a quiet stretch between two runs draws as a gap between their bands.
   */
  private closedIntervalsOn(run: OpenInterval): TimelineInterval[] {
    return this.closed.map((interval) =>
      intervalFrom(interval.header, interval.startedAtMs - run.startedAtMs, false),
    );
  }

  /**
   * How long the interval in progress has been recording, labelled or not,
   * or null when none is open. The window the overlay's churn tint states:
   * its fetch counts are over the open interval, which is what the
   * steady-state refetch rule counts over once the interval closes.
   */
  get openIntervalMs(): number | null {
    const run = this.open;
    return run ? this.now() - run.startedAtMs : null;
  }

  /**
   * One chunk's reading from the interval in progress: where its newest row
   * stands, how many rows it has, how many fetched, and the newest row's age.
   * What the overlay's phase color and churn tint paint, cell by cell.
   *
   * Leaves the recording alone and walks no row: the row table keeps an
   * identity index, so the read costs the same at ten rows and at the per-run
   * cap, which `chunkIndexCost.perf.test.ts` gates. Null when no interval is
   * open or the open one holds no row for the chunk.
   */
  readChunk(chunk: ChunkCoordinates): ChunkReading | null {
    const run = this.open;
    if (!run) return null;
    return run.sink.readChunk(chunk, this.offsetUs(run, this.now()));
  }

  /**
   * The chunk lookup over the interval in progress, for the hover inspector:
   * the same section the diagnostic document carries for a closed run, read
   * through the same function, so what the pointer shows and what the text
   * prints cannot disagree. The rows come from the identity index. The rank
   * is one pass over the interval's admission columns, which is why this is
   * a read for a hover and not for a tick. Null when no interval is open.
   */
  lookupChunkLive(chunk: ChunkCoordinates): ChunkLookup | null {
    const run = this.open;
    if (!run) return null;
    const chunkKey = chunkKeyOf(chunk);
    return readChunk({
      selector: `${chunk.entityId}/${chunkKey}`,
      chosen: "under the pointer",
      chunkKey,
      entityId: chunk.entityId,
      matched: run.sink.chunkRows(chunk),
      admissions: run.sink.admissionColumns(),
      events: run.sink.serialiseEvents(),
      closeUs: this.offsetUs(run, this.now()),
    });
  }

  /** The run's progress at one clock reading, so a sample taken with it shares that instant. */
  private progressAt(run: OpenInterval, cause: RunCause, nowMs: number): LiveProgress {
    const tally = run.sink.liveTally(this.occupancyScratch);
    const occupancy: LivePhaseOccupancy[] = [];
    for (let i = 0; i < PHASES.length; i++) {
      occupancy.push({ phase: PHASES[i], rows: this.occupancyScratch[i] });
    }
    return {
      runId: run.runId,
      cause,
      elapsedMs: nowMs - run.startedAtMs,
      planned: tally.complete + tally.retired + tally.inFlight,
      visible: tally.complete,
      inFlight: tally.inFlight,
      retired: tally.retired,
      unrecorded: run.truncation?.rowsUnrecorded ?? 0,
      occupancy,
      unstamped: tally.unstamped,
      quiescent: this.lastQuiescence?.quiescent ?? false,
      quiescenceReason: this.lastQuiescence?.reason ?? "unpublished",
    };
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
   * An input landed, one of the five that open an interaction run. One
   * gesture is one run: with no run open the input opens one under a cause
   * that names it, and while a run is open (a dataset-open run included,
   * which keeps its cause) the input extends that run.
   *
   * The test is "no run open" rather than "quiescent", because after a
   * timeout or explicit close the page may never go quiescent. Extending
   * re-arms the hold, so the run closes on quiescence after the last input;
   * otherwise a slow drag would shatter into a run per pause.
   */
  noteInput(input: InputKind): void {
    if (this.isRunOpen) {
      this.clearHoldTimer();
      return;
    }
    this.openRun(interactionCause(input));
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
   * {@link finishRow}, or -1 when there is no interval to record into: no
   * page has registered an environment, or the interval has truncated. Both
   * cases are counted so the document does not overstate what it kept.
   *
   * A chunk row is born at dispatch, so this one call also stamps `plan` and
   * `queue` and opens `wire`. Splitting it into three calls would triple the
   * per-chunk event count the 250 µs tick ceiling is derived from.
   *
   * `admittedAtMs` is the scheduler's admission stamp, kept for the admission
   * window only. A row admitted straight off the backlog dates its queue from
   * the plan pass that enqueued it, so queue time before the window is a
   * floor, not a total. `plan` is attributed to the last pass that ended at
   * or before admission; with none in the ring the plan slot stays unset,
   * which reads as "not measured" rather than as zero.
   */
  beginChunkRow(src: ChunkRowSource, tier: 0 | 1, admittedAtMs?: number): number {
    const run = this.intervalForRecording();
    if (!run) {
      this.countRefusedRow();
      return -1;
    }
    const index = run.sink.append(src, tier);
    if (index < 0) return -1;

    // One clock read for both boundaries: the moment the request goes out is
    // the moment the queue ends, so reading the clock twice would open a gap
    // between two halves of the same boundary.
    const dispatchedAtMs = this.now();
    const admittedMs = admittedAtMs ?? this.latestPlanEndMs() ?? dispatchedAtMs;
    const planStartMs = this.planStartAtOrBefore(admittedMs);
    if (planStartMs !== null) {
      run.sink.stamp(index, Boundary.PlanStart, this.offsetUs(run, planStartMs));
    }
    run.sink.stamp(index, Boundary.QueueStart, this.offsetUs(run, admittedMs));
    run.sink.stamp(index, Boundary.WireStart, this.offsetUs(run, dispatchedAtMs));

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
      // Not witnessed opening: the interval began mid-connection, or opened
      // before the page reported this socket.
      record = newConnection(label.connectionGeneration, null, null);
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
   * the generation restarts the correlation label counter, so this
   * is the only thing that makes two `rid: 0` rows in one run tell apart.
   */
  noteConnected(generation: number): void {
    // A repeat of the socket the page is already on says nothing new, and
    // must not clear an outage still in progress: the generation bumps on
    // every open, so the reconnect that ends the outage carries a new one.
    if (this.connectionGeneration === generation) return;
    const atMs = this.now();
    const gapMs = this.disconnectedAtMs === null ? null : atMs - this.disconnectedAtMs;
    this.disconnectedAtMs = null;
    this.connectionGeneration = generation;
    const run = this.open;
    if (!run) return;
    run.connections.push(
      newConnection(
        generation,
        this.offsetUs(run, atMs),
        gapMs === null ? null : clampStamp(Math.round(gapMs * 1000)),
      ),
    );
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
    // The record for the socket that just died, by generation rather than by
    // position: the list is only ordered by when this interval first heard of
    // each connection, which is not always the order they opened in.
    const current = this.connectionRecord(run, this.connectionGeneration);
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
      (rid, requestId, family) => this.canPlace(run, connectionGeneration, rid, requestId, family),
    );
  }

  /**
   * Whether this interval holds the bracket a server row would be placed
   * against — the only question that decides whether keeping it buys
   * anything.
   *
   * A metadata read joins on the open it ran under. A chunk joins on the
   * label, which this interval must have minted: labels restart at zero per
   * connection and are minted in order, so the range this interval saw bounds
   * every label it could place.
   */
  private canPlace(
    run: OpenInterval,
    generation: number,
    rid: number,
    requestId: string | null,
    family: WireRowFamily,
  ): boolean {
    if (family === "metadata_read") return requestId !== null && run.datasetOpens.has(requestId);
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

  /**
   * Bytes in hand: closes `wire`, opens `decode`, and records what the wire
   * delivered, in one resolve. The bytes land on the row at the boundary
   * they arrive at rather than through a second call, because this runs
   * once per completed fetch and each call spends a handle resolve.
   */
  noteBytesReceived(handle: number, bytes: number): void {
    const run = this.resolve(handle);
    if (!run) return;
    const index = handle % GENERATION_STRIDE;
    run.sink.stamp(index, Boundary.DecodeStart, this.offsetUs(run, this.now()));
    run.sink.setBytes(index, bytes);
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
    this.tickScratch.availabilityWoken = this.availabilityWoken;
    this.tickInProgress = true;
    return this.tickScratch;
  }

  /**
   * What woke the loop for the tick about to run: true when a
   * generated-availability update was the only thing that dirtied it since
   * the previous tick. The loop says so before each tick, every sample that
   * tick publishes carries the answer, and the next tick's word replaces it.
   * The loop owns the dirty sources, so the classification is its and the
   * recorder keeps one boolean.
   */
  noteTickWake(availabilityOnly: boolean): void {
    this.availabilityWoken = availabilityOnly;
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
    const atUs = run ? this.offsetUs(run, this.now()) : 0;
    this.noteTargetLevel(run, atUs);
    if (run) {
      run.sink.appendTick(atUs, this.tickScratch, this.countedPhases, this.sendSample);
    } else if (this.open?.truncation) {
      this.open.truncation.ticksUnrecorded++;
    }
    // Listeners fire whether the ring recorded the sample or only counted it.
    for (const listener of this.tickListeners) listener(this.tickScratch);
    // Either way the tallies belong to the interval just ended, not the next
    // one: carrying them forward would publish two intervals' counts as one.
    this.countedPhases.fill(0);
    this.sendSample.fill(0);
  }

  /**
   * Derived at commit rather than emitted by the planner, because this is the
   * one place that sees a dataset's consecutive samples. A sample with no
   * target leaves the memory alone, so a dataset that re-enters view at
   * another level is reported then, against the level it was last seen at.
   */
  private noteTargetLevel(run: OpenInterval | null, atUs: number): void {
    const scratch = this.tickScratch;
    if (!scratch.hasTarget) return;
    const min = scratch.targetMin;
    const max = scratch.targetMax;
    const last = this.lastTargetByDataset.get(scratch.datasetId);
    if (!last) {
      this.lastTargetByDataset.set(scratch.datasetId, { min, max });
      return;
    }
    if (last.min === min && last.max === max) return;
    if (run) {
      run.sink.appendLevelChange(
        atUs,
        scratch.levelPinned ? "pin" : "screen",
        scratch.datasetId,
        last.min,
        last.max,
        min,
        max,
      );
    } else if (this.open?.truncation) {
      this.open.truncation.eventsUnrecorded++;
    }
    last.min = min;
    last.max = max;
  }

  /**
   * Record the process-wide readings: queue depth, in-flight, the tick's own
   * main-thread time, resident bytes, and the GPU pass time of the last frame
   * the render worker read back.
   *
   * Pushed by the render loop once per tick rather than pulled at tick-sample
   * commit: the planner's epoch cache means a run can fetch for seconds
   * without re-planning, so readings on that cadence would cluster at run
   * start. `gpuPassUs` is null when nothing arrived since the previous
   * reading, because a zero would read as a fast GPU.
   */
  noteReading(
    queueDepth: number,
    inFlight: number,
    frameTimeUs: number,
    residentBytes: number,
    gpuPassUs: number | null = null,
  ): void {
    // Ahead of the run check: the latest reading is read with no run open.
    const latest = this.latest;
    latest.seq++;
    latest.atMs = this.now();
    latest.queueDepth = queueDepth;
    latest.inFlight = inFlight;
    latest.frameTimeUs = frameTimeUs;
    latest.residentBytes = residentBytes;
    latest.gpuPassUs = gpuPassUs;
    const run = this.open;
    if (!run) return;
    this.readingColumns[ReadingColumn.QueueDepth] = queueDepth;
    this.readingColumns[ReadingColumn.InFlight] = inFlight;
    this.readingColumns[ReadingColumn.FrameTimeUs] = frameTimeUs;
    this.readingColumns[ReadingColumn.ResidentBytes] = residentBytes;
    run.sink.appendReading(this.offsetUs(run, this.now()), this.readingColumns, gpuPassUs);
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
   * Count one message the bridge transmitted over the session socket, under
   * exactly one client message type.
   *
   * Two tallies take it: the sample the next tick publishes, and the
   * interval's running total. The total exists because a sample is published
   * only by a planning pass, and the sends worth explaining go on after the
   * last pass, when the view looks loaded and the socket does not go quiet.
   *
   * Silent with no interval open, like every tier, but not silenced by
   * truncation: this is a counter, not a record, and spends nothing from the
   * cap. An unlabelled interval that only sent is still discarded as empty,
   * so a pointer moving over an idle canvas retains nothing.
   */
  countSend(type: ClientMessageTypeIndexValue, bytes: number): void {
    this.sentBytesTotal += bytes;
    const run = this.open;
    if (!run) return;
    addSend(this.sendSample, type, bytes);
    addSend(run.sent, type, bytes);
  }

  /**
   * Count bytes that arrived over the session socket. A page-scoped total
   * and nothing else: on the receive side the trace's record is the
   * per-chunk row, and what a surface needs from this is a rate, which it
   * reads by differencing the total at its own cadence.
   */
  countReceive(bytes: number): void {
    this.receivedBytesTotal += bytes;
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
    this.lastTargetByDataset.clear();
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
          ? [newConnection(this.connectionGeneration, null, null)]
          : [],
      serverRowsDiscarded: 0,
      sent: new Float64Array(SEND_COLUMN_COUNT),
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
    if (cause) {
      this.timeoutTimer = setTimeout(() => this.closeRun("timeout"), this.timeoutMs);
      this.announceRunBoundary({
        runId: this.open.runId,
        cause,
        endReason: null,
        durationUs: null,
      });
    }
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
    // the counts behind it belong to no interval either. The sends behind it
    // are already in the interval's total.
    this.tickInProgress = false;
    this.countedPhases.fill(0);
    this.sendSample.fill(0);

    this.awaitingResident.length = 0;
    this.awaitingDrawn.length = 0;

    const durationUs = clampStamp(Math.round((this.now() - run.startedAtMs) * 1000));
    // Announced whether or not the interval is kept below: a run that was
    // evicted still happened, and a watcher that heard it open has to hear
    // it end.
    if (run.cause) {
      this.announceRunBoundary({
        runId: run.runId,
        cause: run.cause,
        endReason,
        durationUs,
      });
    }

    // An unlabelled interval that recorded nothing is not an artifact. A
    // labelled run that recorded nothing is — a run that saw no work is
    // exactly the news somebody is looking for.
    if (run.cause === null && run.sink.isEmpty && run.serverRows.length === 0) return;

    const byteLength = intervalBytes(run);
    this.closed.push({
      startedAtMs: run.startedAtMs,
      sink: run.sink,
      serverRows: run.serverRows,
      // An open still in flight keeps its null end rather than being
      // dropped or given the interval's close as an end it never reached.
      datasetOpens: [...run.datasetOpens.values()],
      datasetOpensDropped: run.datasetOpensDropped,
      serverRowsDiscarded: run.serverRowsDiscarded,
      sent: sendTalliesFrom(run.sent),
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
        gpu: this.gpuIdentity,
        startedAtEpochMs: run.startedAtEpochMs,
        durationUs,
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
   * The interval a new record belongs in once the caps have had their say,
   * or null when there is nowhere to put it. Checked before the write, so a
   * rotation hands the caller a live interval rather than one that just
   * closed.
   *
   * The per-run cap acts on the interval in progress; the resident cap
   * discards completed intervals oldest first. There is deliberately no
   * sampling or coarsening: reaching the per-run cap means something
   * pathological is happening, and a loud truncation diagnoses it better
   * than a coarsened trace that still looks complete.
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
      sent: interval.sent,
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

/**
 * A connection as this interval first met it. `openedAtUs` and `gapUs` are
 * null when the interval did not witness the socket open — it began
 * mid-connection, and the outage before it, if any, belongs to an earlier
 * interval.
 */
function newConnection(
  generation: number,
  openedAtUs: number | null,
  gapUs: number | null,
): ConnectionRecord {
  return { generation, openedAtUs, closedAtUs: null, gapUs, firstRid: null, lastRid: null };
}

/** The bytes column of every type in a send-tally vector, summed. */
function sentBytes(sent: Float64Array): number {
  let total = 0;
  for (let column = 1; column < sent.length; column += SEND_COLUMNS) total += sent[column];
  return total;
}

/** Every tier an interval holds. Allocated bytes, because the cap is on memory. */
function intervalBytes(interval: Pick<OpenInterval, "sink" | "serverRows">): number {
  return interval.sink.byteLength + interval.serverRows.byteLength;
}

/**
 * The process-wide recorder. A module singleton because the emit points are
 * deep in the pipeline and threading an instance to each of them would make
 * the presence of recording a per-call-site decision, which is a recording
 * toggle by another name.
 */
export const traceRecorder = new TraceRecorder();
