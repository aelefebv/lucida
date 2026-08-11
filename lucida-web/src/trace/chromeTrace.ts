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
 * lane either, which is what `lane` means everywhere else in lucida. That is a lie the
 * format requires and it is worth paying: the alternative is a viewer nobody
 * can read.
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
 * How a reader should discount what they are looking at. Every value in the
 * file is measured; these are the ones assembled at export rather than
 * recorded as such, and a borrowed viewer has nowhere else to say so. Repeated
 * by every surface that hands the file over.
 */
export const DERIVED_VALUE_NOTES: readonly string[] = [
  "Phase spans are fanned out at export from the lifecycle row's boundary stamps.",
  "A phase a row entered and never left is drawn from its last stamped boundary to run end, and is tagged `unfinished`; a retired row's open phase is not drawn at all.",
  "Server spans are positioned inside the browser's bracket for the same request, centred within it. `gapUs` is the unattributed network and socket-queue remainder — read it, not the position.",
  "Counter series are sampled once per tick, and a tick only happens when the page has work; a flat stretch is an idle page, not a frozen counter.",
  "Concurrent chunks put overlapping spans on one phase track. Perfetto reports these as `slice_spill_overlapping_complete_event` and stacks them within the track; nothing is dropped.",
];

/** No value in this file is injected or synthetic. Stated, not implied. */
export const SYNTHETIC_VALUE_NOTES: readonly string[] = [];

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
      events.push({
        name: PHASES[p],
        cat: `chunk,${row.lane},${row.residencyTier}`,
        ph: "X",
        ts: baseUs + timing.startUs,
        dur: Math.max(1, timing.durationUs),
        pid: PID_BROWSER,
        tid: phaseTid(PHASES[p]),
        args: {
          key: row.chunkKey,
          dataset: row.datasetId,
          entity: row.entityId,
          lane: row.lane,
          tier: row.residencyTier,
          level: row.level,
          rid: row.connectionGeneration === 0 ? null : row.rid,
        },
      });
    }

    // A row still open when the run closed is the whole point of the
    // diagnostic, and the phase it is stuck in has no end stamp to fan out.
    // Draw it to run end and say so. A retired row's open phase is not drawn:
    // it would invent a stall the run did not have.
    if (row.outcome !== "in-flight") continue;
    const stuck = PHASES[lastPhaseIndex + 1];
    if (lastEndUs === null || stuck === undefined) continue;
    events.push({
      name: stuck,
      cat: `chunk,${row.lane},${row.residencyTier},unfinished`,
      ph: "X",
      ts: baseUs + lastEndUs,
      dur: Math.max(1, header.durationUs - lastEndUs),
      pid: PID_BROWSER,
      tid: phaseTid(stuck),
      args: {
        key: row.chunkKey,
        dataset: row.datasetId,
        lane: row.lane,
        tier: row.residencyTier,
        unfinishedAtRunEnd: true,
      },
    });
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
