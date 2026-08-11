/**
 * The borrowed path: a {@link TraceDocument} projected into Chrome Trace Event
 * JSON, so anyone can open a run in Perfetto and lucida never has to build a
 * span wall (#934).
 *
 * **This is the only module that knows about spans.** ADR 0047 keeps the
 * in-memory model a table — thirteen columnar bytes a row against about 189
 * for a span object — and a lifecycle row fans out into its phases here, at
 * serialisation, and nowhere else. A future format change is therefore local
 * to this file.
 *
 * The emit shape is not the obvious one, and the difference was measured
 * against ui.perfetto.dev in #892 rather than assumed:
 *
 *   Async events (`ph: "b"/"e"`, one id per chunk) are the natural encoding
 *   for work that is not a call stack, and Perfetto *ingests* them correctly.
 *   But it renders them as one collapsed "Global Legacy Events" group per
 *   process, hundreds of rows deep with every phase interleaved. The phase is
 *   a slice name, so there is no track to read.
 *
 *   One thread id per phase plus `thread_name` metadata, with complete events
 *   (`ph: "X"`), renders as one named track per phase with the counter tracks
 *   below it — the whole raw-span surface, for free. It is also smaller: 2.7 MB
 *   against 3.9 MB, because a complete event is one object rather than two.
 *
 * "Thread" here is a *display track*, not a real thread — and not a request
 * lane either, which is what `lane` means everywhere else in lucida. That is a
 * lie the format requires and it is worth paying: the alternative is a viewer
 * nobody can read.
 *
 * What borrowing cannot do, and what the native surfaces are therefore for:
 * append (so this is never the live view), load quickly (about 25 s for
 * 2.7 MB), or emit a callout, ever.
 *
 * One known consequence of the track-per-phase shape, seen on every real
 * export: chunks are fetched concurrently, so their spans on one track overlap
 * and cannot nest. Perfetto reports these as
 * `slice_spill_overlapping_complete_event` import notices and moves them to
 * overflow tracks merged back in at display time. Nothing is lost — the track
 * renders as one track with the overlaps stacked — and the alternative
 * encodings that avoid it are the ones this shape was chosen over.
 */

import {
  PHASES,
  type Phase,
  type TraceDocument,
  type TraceRun,
  type TraceRow,
  type TraceServerRow,
  type UnplacedReason,
} from "./types.ts";

/** One Chrome Trace Event. `ph` selects the semantics; see the module note. */
export interface ChromeTraceEvent {
  name: string;
  cat?: string;
  ph: "X" | "C" | "i" | "M";
  /** Microseconds on the document's timeline — run start plus the run's offset. */
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  /** Instant scope: `"g"` global, `"p"` process, `"t"` thread. */
  s?: "g" | "p" | "t";
  args?: Record<string, unknown>;
}

/** The object form of the file, which is what carries the header. */
export interface ChromeTraceFile {
  traceEvents: ChromeTraceEvent[];
  displayTimeUnit: "ms";
  otherData: Record<string, unknown>;
}

export const PID_BROWSER = 1;
export const PID_SERVER = 2;

/**
 * Track ids. Low ids are the non-phase tracks; phase tracks start at
 * {@link PHASE_TID_BASE} in {@link PHASES} order, so a track's position in the
 * viewer is the phase's position in the pipeline.
 */
const COUNTER_TID = 0;
const RUN_TID = 1;
const POINT_TID = 2;
const PHASE_TID_BASE = 10;
const SERVE_TID = 10;

/** The four counter series, in the order they should stack under the tracks. */
const COUNTER_SERIES = [
  { name: "queue depth", reading: "queueDepth" },
  { name: "in flight", reading: "inFlight" },
  { name: "frame time (ms)", reading: "frameTimeUs", scale: 1 / 1000 },
  { name: "resident bytes", reading: "residentBytes" },
] as const;

/**
 * How a reader should discount what they are looking at: measured values that
 * the export assembles rather than records as such. A borrowed viewer has
 * nowhere else to say this, so it says it here and every surface that hands the
 * file over repeats it. Values that are not measurements at all are in
 * {@link SYNTHETIC_VALUE_NOTES}.
 */
export const DERIVED_VALUE_NOTES: readonly string[] = [
  "Phase spans are fanned out at export from the lifecycle row's boundary stamps.",
  "A retired row's open phase is not drawn at all — a span there would invent a stall the run did not have.",
  "Counter series are sampled once per tick, and a tick only happens when the page has work; a flat stretch is an idle page, not a frozen counter. `readingsDropped` in the header says how many readings the ring wrapped over, so a long run's counters cover its tail.",
  "Concurrent chunks put overlapping spans on one phase track. Perfetto reports these as `slice_spill_overlapping_complete_event` and stacks them within the track; nothing is dropped.",
];

/**
 * Positions and durations in this file that were **constructed at export
 * rather than measured**. Two of them, and a timeline cannot show a span
 * without committing to a position, so the honest move is to name them rather
 * than to claim the file contains no invented numbers.
 *
 * Every other value in the file is a measurement; the assembly the export does
 * on top of measured values is in {@link DERIVED_VALUE_NOTES}.
 */
export const SYNTHETIC_VALUE_NOTES: readonly string[] = [
  "A server span's DURATION is the server's own measurement, but its POSITION is not measured: it is centred inside the browser's bracket for the same request, which splits the unattributed remainder evenly between the outbound and inbound legs because nothing measures them apart. Read `gapUs`, not the position.",
  "An `unfinished` span's END is run end, not an observation. The row was still in flight when the run closed, so the phase has no end stamp; the span says where the row got stuck and for at least how long, never exactly how long.",
];

/**
 * Project the document. Runs are laid end to end on one timeline, offset by
 * their wall-clock start, because run-relative microseconds alone would stack
 * every run on top of the first.
 */
export function toChromeTraceEvents(doc: TraceDocument): ChromeTraceEvent[] {
  const events: ChromeTraceEvent[] = [];
  emitMetadata(events, doc);

  const originEpochMs = doc.runs.length > 0 ? doc.runs[0].header.startedAtEpochMs : 0;
  for (const run of doc.runs) {
    const baseUs = Math.round((run.header.startedAtEpochMs - originEpochMs) * 1000);
    emitRun(events, run, baseUs);
  }
  return events;
}

/**
 * The file a reader opens. The header rides in `otherData` — a bare array of
 * events would drop device pixel ratio, GPU and cache warmth, and two runs at
 * different DPR are not comparable.
 */
export function toChromeTraceFile(doc: TraceDocument): ChromeTraceFile {
  return {
    traceEvents: toChromeTraceEvents(doc),
    displayTimeUnit: "ms",
    otherData: chromeTraceOtherData(doc),
  };
}

/** The projection as bytes, which is what every surface actually hands over. */
export function toChromeTraceJson(doc: TraceDocument): string {
  return JSON.stringify(toChromeTraceFile(doc));
}

/**
 * The header block, and the coverage that has to travel with it: a file that
 * silently omits what the rings dropped reads as complete when it is not.
 */
export function chromeTraceOtherData(doc: TraceDocument): Record<string, unknown> {
  return {
    schemaVersion: doc.schemaVersion,
    exportedAtEpochMs: doc.exportedAtEpochMs,
    instrumentedPhases: doc.instrumentedPhases,
    countedPhases: doc.countedPhases,
    rowsOutsideRun: doc.rowsOutsideRun,
    serverRowsOutsideRun: doc.serverRowsOutsideRun,
    derivedValues: DERIVED_VALUE_NOTES,
    syntheticValues: SYNTHETIC_VALUE_NOTES,
    runs: doc.runs.map(run => ({
      ...run.header,
      rows: run.rows.length,
      ticksDropped: run.ticksDropped,
      readingsDropped: run.readingsDropped,
      eventsDropped: run.eventsDropped,
      serverRowsDropped: run.serverRowsDropped,
      unplacedServerRows: countUnplaced(run.serverRows),
      undrawableInFlightRows: countUndrawableInFlight(run.rows),
    })),
  };
}

function emitMetadata(events: ChromeTraceEvent[], doc: TraceDocument): void {
  events.push(processName(PID_BROWSER, "browser"), processName(PID_SERVER, "lucida-server"));
  events.push(threadName(PID_BROWSER, RUN_TID, "run"), threadName(PID_BROWSER, POINT_TID, "events"));
  doc.instrumentedPhases.forEach(phase => {
    const tid = phaseTid(phase);
    events.push(threadName(PID_BROWSER, tid, phase), threadSortIndex(PID_BROWSER, tid));
  });
  events.push(threadName(PID_SERVER, SERVE_TID, "serve"));
}

function emitRun(events: ChromeTraceEvent[], run: TraceRun, baseUs: number): void {
  const { header } = run;
  events.push({
    name: header.runId,
    cat: "run",
    ph: "X",
    ts: baseUs,
    dur: Math.max(1, header.durationUs),
    pid: PID_BROWSER,
    tid: RUN_TID,
    args: { ...header },
  });

  for (const row of run.rows) {
    let lastEndUs: number | null = null;
    let lastPhaseIndex = -1;
    for (let p = 0; p < PHASES.length; p++) {
      const timing = row.phases[PHASES[p]];
      if (!timing) continue;
      lastEndUs = timing.endUs;
      lastPhaseIndex = p;
      events.push(
        chunkSpan(row, PHASES[p], baseUs + timing.startUs, timing.durationUs, false),
      );
    }

    // A row still open when the run closed is the whole point of the
    // diagnostic, and the phase it is stuck in has no end stamp to fan out.
    // Draw it to run end and say so. A retired row's open phase is not drawn:
    // it would invent a stall the run did not have.
    if (row.outcome !== "in-flight") continue;
    const stuck = PHASES[lastPhaseIndex + 1];
    // A row in flight with nothing stamped at all has no position to draw
    // from, and guessing one would put the rows that stalled *earliest* at
    // whatever time the guess picked. Counted in the header instead, because
    // silently omitting them makes the emptiest phase look the healthiest.
    if (lastEndUs === null || stuck === undefined) continue;
    events.push(
      chunkSpan(row, stuck, baseUs + lastEndUs, header.durationUs - lastEndUs, true),
    );
  }

  for (const serverRow of run.serverRows) {
    // An unplaced row has no position on the browser's clock, and inventing
    // one is exactly the confidently-wrong merged timeline ADR 0050 refused.
    // Its reason is counted in the header instead.
    if (!serverRow.placement) continue;
    const { placement } = serverRow;
    events.push({
      name: `serve ${serverRow.family}`,
      cat: `serve,${serverRow.outcome}`,
      ph: "X",
      ts: baseUs + placement.startUs,
      dur: Math.max(1, placement.endUs - placement.startUs),
      pid: PID_SERVER,
      tid: SERVE_TID,
      args: {
        rid: serverRow.rid,
        connectionGeneration: serverRow.connectionGeneration,
        outcome: serverRow.outcome,
        dispatchOffsetUs: serverRow.dispatchOffsetUs,
        durationUs: serverRow.durationUs,
        gapUs: placement.gapUs,
        overshootUs: placement.overshootUs,
      },
    });
  }

  for (const event of run.events) {
    events.push({
      name: `${event.kind}: ${event.reason}`,
      cat: "point",
      ph: "i",
      ts: baseUs + event.atUs,
      pid: PID_BROWSER,
      tid: POINT_TID,
      s: "t",
      args: { kind: event.kind, reason: event.reason, key: event.chunk?.chunkKey ?? null },
    });
  }

  for (const sample of run.readings) {
    for (const series of COUNTER_SERIES) {
      const scale = "scale" in series ? series.scale : 1;
      events.push({
        name: series.name,
        cat: "counters",
        ph: "C",
        ts: baseUs + sample.atUs,
        pid: PID_BROWSER,
        tid: COUNTER_TID,
        args: { value: sample[series.reading] * scale },
      });
    }
  }
}

/**
 * A phase's display track. Derived from the phase inventory rather than
 * hand-numbered, so a phase added to {@link PHASES} lands in the right place
 * without a second list to keep in step.
 */
export function phaseTid(phase: Phase): number {
  return PHASE_TID_BASE + PHASES.indexOf(phase);
}

/**
 * Rows still in flight with no boundary stamped at all, and so with nowhere on
 * the timeline to be drawn. These are the rows that stalled *earliest* — the
 * ones a reader most needs to know about — so the count is in the header
 * rather than left as an absence.
 */
function countUndrawableInFlight(rows: readonly TraceRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.outcome !== "in-flight") continue;
    if (PHASES.some(phase => row.phases[phase] !== undefined)) continue;
    count++;
  }
  return count;
}

function countUnplaced(rows: readonly TraceServerRow[]): Record<UnplacedReason, number> {
  const counts: Record<UnplacedReason, number> = {
    "no-browser-row": 0,
    "answered-without-delivery": 0,
    "bracket-open": 0,
  };
  for (const row of rows) {
    if (row.unplacedReason) counts[row.unplacedReason]++;
  }
  return counts;
}

/**
 * One phase's span for one chunk. Both the measured spans and the unfinished
 * one go through here, so the two cannot drift into describing the same chunk
 * differently — `unfinished` is a flag on one shape, not a second shape.
 */
function chunkSpan(
  row: TraceRow,
  phase: Phase,
  tsUs: number,
  durationUs: number,
  unfinished: boolean,
): ChromeTraceEvent {
  return {
    name: phase,
    cat: `chunk,${row.lane},${row.residencyTier}${unfinished ? ",unfinished" : ""}`,
    ph: "X",
    ts: tsUs,
    // Perfetto drops a zero-duration complete event; a phase that finished
    // inside one clock tick is still a phase that happened.
    dur: Math.max(1, durationUs),
    pid: PID_BROWSER,
    tid: phaseTid(phase),
    args: {
      key: row.chunkKey,
      dataset: row.datasetId,
      entity: row.entityId,
      lane: row.lane,
      tier: row.residencyTier,
      level: row.level,
      rid: row.connectionGeneration === 0 ? null : row.rid,
      ...(unfinished ? { unfinishedAtRunEnd: true } : {}),
    },
  };
}

function processName(pid: number, name: string): ChromeTraceEvent {
  return { name: "process_name", ph: "M", ts: 0, pid, tid: 0, args: { name } };
}

function threadName(pid: number, tid: number, name: string): ChromeTraceEvent {
  return { name: "thread_name", ph: "M", ts: 0, pid, tid, args: { name } };
}

/** Tracks sort by tid, so the viewer shows the pipeline in pipeline order. */
function threadSortIndex(pid: number, tid: number): ChromeTraceEvent {
  return { name: "thread_sort_index", ph: "M", ts: 0, pid, tid, args: { sort_index: tid } };
}
