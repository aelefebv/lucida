/**
 * The timeline: what the dock draws, derived as fields of the diagnostic
 * document.
 *
 * A continuous time axis divided into a fixed number of buckets, and one
 * chart per entry of {@link TIMELINE_CHARTS}, each a reading of one of the
 * run's tiers binned over the axis. The dock draws these series and computes
 * nothing of its own, so the picture a person reads and the text an agent
 * reads come from one object and cannot disagree.
 *
 * Two entry points, one derivation. {@link deriveTimeline} reads a closed
 * run, walks its rows once, and bins the row-derived charts beside the
 * per-tick ones. {@link deriveLiveTimeline} reads the open run's per-tick
 * tiers alone: the readings, the tick samples, the point events and the
 * connection records. It marks the row-derived charts absent, with the
 * moment they are read. That is the rule ADR 0049 as amended puts on every
 * live surface: draw from the per-tick aggregate at the tick cadence, and
 * walk rows only when the run closes or somebody asks for a verdict.
 *
 * Absent is a value here, never a zero. A chart whose data this build does
 * not record, a series no reading carried, and a bucket before the first
 * sample all say so in the document, so a quiet chart is qualified by what
 * was recorded rather than read as a quiet pipeline.
 *
 * Pure, like the rest of the derivation: everything it needs is in the run
 * or the sample it is handed.
 */

import {
  CLIENT_MESSAGES,
  LANE_NAMES,
  METADATA_READ_PHASES,
  PHASES,
  POINT_EVENT_KINDS,
  type ConnectionRecord,
  type DatasetOpenBracket,
  type GpuIdentity,
  type RunCause,
  type RunHeader,
  type SendTallies,
  type TraceDocument,
  type TracePointEvent,
  type TraceReading,
  type TraceRow,
  type TraceRun,
  type TraceServerRow,
  type TraceTick,
} from "../types.ts";
import { metadataReadsWithin, usToMs, type MetadataReadInWindow } from "./phaseRollup.ts";
import { describeLiveWindow, resolveLiveWindow, type ProvisionalWindow } from "./provisional.ts";
import { gpuPassOf } from "./renderTiming.ts";
import { firstBoundaryUs, lastBoundaryUs } from "./rowState.ts";
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  type GpuPassTiming,
  type TimelineChart,
  type TimelineChartId,
  type TimelineChartKind,
  type TimelineInterval,
  type TimelineSection,
  type TimelineSeries,
} from "./types.ts";
import type { RunWindow } from "./window.ts";

/**
 * How many buckets the axis is divided into. Fixed, so the section's size is
 * bounded by the chart count rather than by the run's length or its rows, and
 * a bucket is wide enough at a thousand pixels to draw as a bar rather than
 * as a line of single pixels.
 */
export const TIMELINE_BUCKETS = 120;

/**
 * How far back the live timeline looks when nobody says. Longer than the
 * provisional reading's window because a timeline is read for shape rather
 * than for a statement, and bounded in practice by the rings: the reading
 * ring holds about seventeen seconds of continuous ticks.
 */
export const DEFAULT_LIVE_TIMELINE_WINDOW_MS = 30_000;

/** One entry of the closed set: the chart's identity and how it is read. */
export interface TimelineChartSpec {
  id: TimelineChartId;
  title: string;
  kind: TimelineChartKind;
  unit: string;
}

/**
 * The closed set of charts, in the order the dock draws them. A test
 * enumerates this list against the document and against the text rendering,
 * which is what makes "every chart has a text twin" an assertion.
 */
export const TIMELINE_CHARTS: readonly TimelineChartSpec[] = [
  { id: "occupancy.browser", title: "Phase occupancy, browser", kind: "density", unit: "rows" },
  { id: "occupancy.server", title: "Phase occupancy, server", kind: "density", unit: "rows" },
  { id: "occupancy.metadata", title: "Phase occupancy, dataset open", kind: "density", unit: "rows" },
  { id: "in-flight", title: "In flight and pending", kind: "line", unit: "chunks" },
  { id: "in-flight.lane", title: "In flight by lane", kind: "density", unit: "rows" },
  { id: "planned.lane", title: "Planned by lane", kind: "count", unit: "chunks per bucket" },
  { id: "bytes.sent", title: "Bytes sent", kind: "rate", unit: "B/s" },
  { id: "bytes.received", title: "Bytes received", kind: "rate", unit: "B/s" },
  { id: "resident", title: "Resident bytes", kind: "line", unit: "bytes" },
  { id: "events", title: "Events", kind: "marks", unit: "events per bucket" },
  { id: "frame", title: "Frame time", kind: "line", unit: "ms" },
];

/**
 * The kinds of mark the events chart draws, in the order its series appear:
 * every point event kind, then the reconnects the connection records carry,
 * then one mark per planning pass. The plan marks are the replans: a pass
 * that planned nothing new leaves no trace on the planned-by-lane chart, and
 * a page that keeps re-planning after the view settled is the case the
 * steady-state ruleset counts.
 */
export const TIMELINE_MARKS = [...POINT_EVENT_KINDS, "reconnect", "plan"] as const;
export type TimelineMark = (typeof TIMELINE_MARKS)[number];

/** What the row-derived charts say while the run is open. */
export const ROWS_AT_CLOSE =
  "read from the rows when the run closes or when a verdict is asked for; while the run is open the provisional reading carries this instant's occupancy";

const RECEIVED_NOT_RECORDED =
  "bytes received are not recorded per tick by this build: the send side is, and the server's rows carry the bytes each backend read returned";

const POOLS_NOT_RECORDED =
  "resident bytes per pool and each pool's budget are not recorded per tick by this build; the total is the CPU cache's resident bytes";

const NOT_A_HEALTH_SIGNAL =
  "a zero here is not a health signal, since these paths may not have been exercised";

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** The recording an interval list is read from: the document's runs and steady-state intervals. */
export type TimelineRecording = Pick<TraceDocument, "runs" | "steadyState">;

/**
 * The timeline of a closed run over a window of its clock. Walks the rows
 * once, which is what a closed run permits, and reads the per-tick tiers
 * beside them. `recording` places the other retained intervals on this run's
 * clock; without it the axis carries this run alone.
 */
export function deriveTimeline(
  run: TraceRun,
  window: RunWindow,
  recording?: TimelineRecording,
): TimelineSection {
  return derive({
    startUs: window.startUs,
    endUs: window.endUs,
    closeUs: Math.max(0, run.header.durationUs),
    rows: {
      rows: run.rows,
      serverRows: run.serverRows,
      datasetOpens: run.datasetOpens,
      metadataReads: metadataReadsWithin(run, window),
    },
    readings: run.readings,
    readingsDropped: run.readingsDropped,
    ticks: run.ticks,
    ticksDropped: run.ticksDropped,
    events: run.events,
    eventsDropped: run.eventsDropped,
    connections: run.header.connections,
    gpuPass: gpuPassOf(run.readings, run.header.gpu),
    intervals: intervalsOf(run, recording),
    sentTotalBytes: totalBytes(run.sent),
  });
}

/**
 * What the recorder hands the live derivation: the open run's per-tick tiers
 * from the window's start on, each led by the record in force at that
 * instant where the ring still holds one, and never a row.
 */
export interface LiveTimelineSample {
  runId: string;
  cause: RunCause;
  /** Microseconds from run start at the moment the sample was taken. */
  atUs: number;
  readings: TraceReading[];
  readingsDropped: number;
  ticks: TraceTick[];
  ticksDropped: number;
  events: TracePointEvent[];
  eventsDropped: number;
  connections: ConnectionRecord[];
  gpu: GpuIdentity | null;
  /** The closed intervals the recording still holds, already on this run's clock. */
  intervals: TimelineInterval[];
  /** Bytes the run has sent so far, counted at each send. */
  sentTotalBytes: number;
}

export interface LiveTimelineOptions {
  /** How far back to draw, in milliseconds. {@link DEFAULT_LIVE_TIMELINE_WINDOW_MS} when absent. */
  windowMs?: number;
}

/**
 * The timeline of a run in progress. Labelled provisional like every live
 * surface, because it changes while it is read: it draws from the per-tick
 * tiers alone and walks no row.
 */
export interface LiveTimeline {
  /** Always true. The label every rendering carries. */
  provisional: true;
  schemaVersion: number;
  runId: string;
  cause: RunCause;
  /** The run's clock at the sample, in milliseconds. */
  elapsedMs: number;
  window: ProvisionalWindow;
  timeline: TimelineSection;
  /** One sentence, opening with the word provisional. */
  statement: string;
}

export function deriveLiveTimeline(
  sample: LiveTimelineSample,
  options: LiveTimelineOptions = {},
): LiveTimeline {
  const window = resolveLiveWindow(sample.atUs, options.windowMs ?? DEFAULT_LIVE_TIMELINE_WINDOW_MS);
  const described = describeLiveWindow(window);
  const current: TimelineInterval = {
    runId: sample.runId,
    kind: "run",
    current: true,
    cause: sample.cause,
    endReason: null,
    startMs: 0,
    endMs: usToMsExact(window.endUs),
  };
  const timeline = derive({
    startUs: window.startUs,
    endUs: window.endUs,
    closeUs: window.endUs,
    rows: null,
    readings: sample.readings,
    readingsDropped: sample.readingsDropped,
    ticks: sample.ticks,
    ticksDropped: sample.ticksDropped,
    events: sample.events,
    eventsDropped: sample.eventsDropped,
    connections: sample.connections,
    gpuPass: gpuPassOf(sample.readings, sample.gpu),
    intervals: [...sample.intervals, current].sort((a, b) => a.startMs - b.startMs),
    sentTotalBytes: sample.sentTotalBytes,
  });
  const span = described.wholeRun
    ? `the ${described.spanMs} ms of the run so far`
    : `the last ${described.spanMs} ms`;
  return {
    provisional: true,
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    runId: sample.runId,
    cause: sample.cause,
    elapsedMs: usToMsExact(window.endUs),
    window: described,
    timeline,
    statement:
      `provisional — ${span} of run ${sample.runId}, drawn from ${sample.readings.length} reading(s), ` +
      `${sample.ticks.length} sample(s) and ${sample.events.length} event(s), and from no row; ` +
      "the row-derived charts are read when the run closes",
  };
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

interface RowTiers {
  rows: TraceRow[];
  serverRows: TraceServerRow[];
  datasetOpens: DatasetOpenBracket[];
  metadataReads: MetadataReadInWindow[];
}

interface DeriveInput {
  startUs: number;
  endUs: number;
  /** Where a row still in flight is charged to: run close, or the sample's instant. */
  closeUs: number;
  rows: RowTiers | null;
  readings: TraceReading[];
  readingsDropped: number;
  ticks: TraceTick[];
  ticksDropped: number;
  events: TracePointEvent[];
  eventsDropped: number;
  connections: ConnectionRecord[];
  gpuPass: GpuPassTiming;
  intervals: TimelineInterval[];
  sentTotalBytes: number;
}

/** The axis in the trace's own units, so binning never rounds a boundary. */
interface Axis {
  startUs: number;
  endUs: number;
  buckets: number;
  bucketUs: number;
}

function derive(input: DeriveInput): TimelineSection {
  const axis: Axis = {
    startUs: input.startUs,
    endUs: input.endUs,
    buckets: TIMELINE_BUCKETS,
    bucketUs: Math.max(1, input.endUs - input.startUs) / TIMELINE_BUCKETS,
  };
  const charts = TIMELINE_CHARTS.map((spec) => chartOf(spec, input, axis));
  const absent = charts.filter((chart) => !chart.recorded).length;
  const rows = input.rows;
  return {
    axis: {
      startMs: usToMsExact(axis.startUs),
      endMs: usToMsExact(axis.endUs),
      spanMs: usToMsExact(axis.endUs - axis.startUs),
      buckets: axis.buckets,
      // Rounded for the document alone; the binning used the exact width.
      bucketMs: round(usToMsExact(axis.bucketUs), 3),
    },
    intervals: input.intervals,
    charts,
    rowsWalked: rows !== null,
    statement:
      `${charts.length} charts over ${usToMsExact(axis.startUs)}..${usToMsExact(axis.endUs)} ms of the run's clock ` +
      `in ${axis.buckets} buckets of ${round(usToMsExact(axis.bucketUs), 3)} ms; ` +
      (rows
        ? `the rows were walked once: ${rows.rows.length} lifecycle row(s) and ${rows.serverRows.length} server row(s)`
        : "the run is open, so the rows were not walked and the charts read from them are absent") +
      (absent > 0 ? `; ${absent} chart(s) absent, each saying why` : ""),
  };
}

function chartOf(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  switch (spec.id) {
    case "occupancy.browser":
      return browserOccupancy(spec, input, axis);
    case "occupancy.server":
      return serverOccupancy(spec, input, axis);
    case "occupancy.metadata":
      return metadataOccupancy(spec, input, axis);
    case "in-flight":
      return inFlight(spec, input, axis);
    case "in-flight.lane":
      return inFlightByLane(spec, input, axis);
    case "planned.lane":
      return plannedByLane(spec, input, axis);
    case "bytes.sent":
      return bytesSent(spec, input, axis);
    case "bytes.received":
      return buildChart(spec, [], RECEIVED_NOT_RECORDED);
    case "resident":
      return resident(spec, input, axis);
    case "events":
      return events(spec, input, axis);
    case "frame":
      return frame(spec, input, axis);
  }
}

function buildChart(spec: TimelineChartSpec, series: TimelineSeries[], statement: string): TimelineChart {
  return {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    unit: spec.unit,
    recorded: series.some((entry) => entry.recorded),
    series,
    statement,
  };
}

function absent(id: string, label: string, statement: string): TimelineSeries {
  return { id, label, recorded: false, statement };
}

// ---------------------------------------------------------------------------
// The row-derived charts
// ---------------------------------------------------------------------------

function browserOccupancy(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const rows = input.rows;
  if (!rows) return buildChart(spec, [], ROWS_AT_CLOSE);
  const series = PHASES.map((phase) => {
    const spans: Span[] = [];
    for (const row of rows.rows) {
      const timing = row.phases[phase];
      if (timing) spans.push({ startUs: timing.startUs, endUs: timing.endUs });
    }
    return densitySeries(phase, phase, spans, axis);
  });
  return buildChart(
    spec,
    series,
    `rows in each browser phase per bucket, averaged over the bucket, from ${rows.rows.length} lifecycle row(s)`,
  );
}

/**
 * The server draws as one series: rows inside their browser brackets. Where
 * inside the bracket the server's phases sat is unknowable from this side
 * (ADR 0050), so the phases are not drawn at positions they never had; the
 * phase table beneath the timeline carries their durations.
 */
function serverOccupancy(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const rows = input.rows;
  if (!rows) return buildChart(spec, [], ROWS_AT_CLOSE);
  const spans: Span[] = [];
  let unplaced = 0;
  let total = 0;
  for (const row of rows.serverRows) {
    if (row.family === "metadata-read") continue;
    total += 1;
    if (row.placement) spans.push({ startUs: row.placement.startUs, endUs: row.placement.endUs });
    else unplaced += 1;
  }
  if (total === 0) return buildChart(spec, [], "no server rows in this run");
  if (spans.length === 0) {
    return buildChart(
      spec,
      [],
      `none of the ${total} server row(s) could be placed on this run's clock, so nothing is drawn; their durations are in the phase table`,
    );
  }
  return buildChart(
    spec,
    [densitySeries("bracket", "in a browser bracket", spans, axis)],
    `server rows inside their browser brackets per bucket, from ${spans.length} placed row(s); ` +
      "the phases inside a bracket have no position of their own, so the bracket is the one series" +
      (unplaced > 0 ? `; ${unplaced} row(s) had no position and are not drawn` : ""),
  );
}

function metadataOccupancy(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const rows = input.rows;
  if (!rows) return buildChart(spec, [], ROWS_AT_CLOSE);
  const opens: Span[] = rows.datasetOpens.map((open) => ({
    startUs: open.startUs,
    endUs: open.endUs ?? input.closeUs,
  }));
  const byPhase = new Map<string, Span[]>(METADATA_READ_PHASES.map((phase) => [phase, []]));
  let unplaced = 0;
  for (const read of rows.metadataReads) {
    if (!read.placed) {
      unplaced += 1;
      continue;
    }
    if (!read.span || !read.row.metadataPhase) continue;
    byPhase.get(read.row.metadataPhase)?.push({ startUs: read.span.startUs, endUs: read.span.endUs });
  }
  const series = [
    densitySeries("dataset-open", "dataset open", opens, axis),
    ...METADATA_READ_PHASES.map((phase) => densitySeries(phase, phase, byPhase.get(phase) ?? [], axis)),
  ];
  return buildChart(
    spec,
    series,
    `the dataset-open bracket and the metadata reads inside it per bucket, from ${opens.length} open(s) and ` +
      `${rows.metadataReads.length} read(s)` +
      (unplaced > 0 ? `; ${unplaced} read(s) belong to an open this run never bracketed and are not drawn` : ""),
  );
}

function inFlightByLane(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const rows = input.rows;
  if (!rows) return buildChart(spec, [], ROWS_AT_CLOSE);
  const byLane = new Map<string, Span[]>(LANE_NAMES.map((lane) => [lane, []]));
  for (const row of rows.rows) {
    const first = firstBoundaryUs(row);
    if (first === null) continue;
    const end = row.outcome === "in-flight" ? input.closeUs : (lastBoundaryUs(row) ?? input.closeUs);
    byLane.get(row.lane)?.push({ startUs: first, endUs: end });
  }
  return buildChart(
    spec,
    LANE_NAMES.map((lane) => densitySeries(lane, lane, byLane.get(lane) ?? [], axis)),
    `rows alive per lane per bucket, from each row's first boundary to its last or to run close, from ${rows.rows.length} lifecycle row(s)`,
  );
}

// ---------------------------------------------------------------------------
// The per-tick charts
// ---------------------------------------------------------------------------

const NO_READING = "no reading in the window carried a value";
const NO_FRAME_TIME = "no reading in the window carried a frame time above the clock floor";
const NO_GPU_PASS = "no reading in the window carried a GPU pass time";

function inFlight(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const readings = input.readings;
  return buildChart(
    spec,
    [
      heldSeries("in-flight", "in flight", readings, (reading) => reading.inFlight, axis, 2),
      heldSeries("pending", "pending", readings, (reading) => reading.queueDepth, axis, 2),
    ],
    `in-flight and pending counts from the readings, each held until the next reading and averaged over the bucket, ` +
      `from ${readings.length} reading(s)` +
      dropped(input.readingsDropped, "reading"),
  );
}

function resident(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const readings = input.readings;
  return buildChart(
    spec,
    [
      heldSeries("total", "resident bytes", readings, (reading) => reading.residentBytes, axis, 0),
      absent("pools", "per pool, against budget", POOLS_NOT_RECORDED),
    ],
    `the CPU cache's resident bytes from the readings, held between readings, from ${readings.length} reading(s); ` +
      POOLS_NOT_RECORDED +
      dropped(input.readingsDropped, "reading"),
  );
}

function frame(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const readings = input.readings;
  const main = peakSeries(
    "main-thread",
    "main-thread frame",
    readings.filter((reading) => reading.frameTimeUs > 0),
    (reading) => usToMs(reading.frameTimeUs),
    axis,
    NO_FRAME_TIME,
  );
  const gpu = input.gpuPass.recorded
    ? peakSeries(
        "gpu-pass",
        "GPU pass",
        readings.filter((reading) => reading.gpuPassUs != null),
        (reading) => usToMs(reading.gpuPassUs ?? 0),
        axis,
        NO_GPU_PASS,
      )
    : absent("gpu-pass", "GPU pass", input.gpuPass.statement);
  return buildChart(
    spec,
    [main, gpu],
    `the worst main-thread frame time among the readings in each bucket, from ${readings.length} reading(s); ` +
      (input.gpuPass.recorded
        ? "the GPU pass time read back per frame is drawn beside it on the device's own clock"
        : `GPU pass time is absent: ${input.gpuPass.statement}`) +
      dropped(input.readingsDropped, "reading"),
  );
}

function plannedByLane(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const ticks = input.ticks;
  const counters = {
    minimap: "laneMinimap",
    detail: "laneDetail",
    coarse: "laneCoarse",
    prefetch: "lanePrefetch",
    overview: "laneOverview",
  } as const;
  const unreadBeforeUs = unreadBefore(ticks, input.ticksDropped);
  return buildChart(
    spec,
    LANE_NAMES.map((lane) =>
      countSeries(lane, lane, ticks, (tick) => tick.counters[counters[lane]], axis, unreadBeforeUs),
    ),
    `chunks planned per lane, summed over the planning passes in each bucket, from ${ticks.length} tick sample(s)` +
      dropped(input.ticksDropped, "sample"),
  );
}

/**
 * A sample's sends cover the interval since the previous sample, so each is
 * spread over that interval as a rate. The first interval starts at run
 * start, unless the ring has dropped older samples: then the oldest retained
 * sample has no known interval, so its bytes are not drawn and the buckets
 * before it are unread.
 */
function bytesSent(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const ticks = input.ticks;
  const unreadBeforeUs = unreadBefore(ticks, input.ticksDropped);
  const series = CLIENT_MESSAGES.map(({ type, label }) => {
    const spans: RateSpan[] = [];
    let previousUs: number | null = input.ticksDropped > 0 ? null : 0;
    for (const tick of ticks) {
      if (previousUs !== null) {
        spans.push({ startUs: previousUs, endUs: tick.atUs, amount: tick.sent[type].bytes });
      }
      previousUs = tick.atUs;
    }
    return rateSeries(type, label, spans, axis, unreadBeforeUs);
  });
  return buildChart(
    spec,
    series,
    `bytes sent per second by client message type, each sample's bytes spread over the interval since the previous sample, ` +
      `from ${ticks.length} tick sample(s); the run's total is ${input.sentTotalBytes.toLocaleString()} bytes, ` +
      "which the samples may not reach, since a send after the last planning pass rides no sample" +
      dropped(input.ticksDropped, "sample"),
  );
}

function events(spec: TimelineChartSpec, input: DeriveInput, axis: Axis): TimelineChart {
  const series: TimelineSeries[] = [];
  const unreadEventsBeforeUs = unreadBefore(input.events, input.eventsDropped);
  for (const kind of POINT_EVENT_KINDS) {
    series.push(
      countSeries(
        kind,
        kind,
        input.events.filter((event) => event.kind === kind),
        () => 1,
        axis,
        unreadEventsBeforeUs,
      ),
    );
  }
  // A connection already up when the interval began has no opening to mark.
  // The records live on the run header rather than a ring, so none is unread.
  const reconnects = input.connections.filter(
    (connection): connection is ConnectionRecord & { openedAtUs: number } => connection.openedAtUs !== null,
  );
  series.push(
    countSeries(
      "reconnect",
      "reconnect",
      reconnects.map((connection) => ({ atUs: connection.openedAtUs })),
      () => 1,
      axis,
      null,
    ),
  );
  series.push(
    countSeries("plan", "planning pass", input.ticks, () => 1, axis, unreadBefore(input.ticks, input.ticksDropped)),
  );
  return buildChart(
    spec,
    series,
    "evictions, rejections, retries, failures and level changes where they happened, reconnects from the connection records, " +
      "and one mark per planning pass, so a pass that planned nothing new is still visible, " +
      `from ${input.events.length} event(s), ${input.connections.length} connection(s) and ` +
      `${input.ticks.length} sample(s); ${NOT_A_HEALTH_SIGNAL}` +
      dropped(input.eventsDropped, "event") +
      dropped(input.ticksDropped, "sample"),
  );
}

function dropped(count: number, unit: string): string {
  return count > 0
    ? `; the ring dropped ${count.toLocaleString()} older ${unit}(s), so the buckets before the oldest retained one are unread`
    : "";
}

/**
 * Where a ring's memory begins, or null while it has dropped nothing. A
 * bucket before it is unread rather than empty.
 */
function unreadBefore(records: { atUs: number }[], droppedCount: number): number | null {
  if (droppedCount <= 0 || records.length === 0) return null;
  return records[0].atUs;
}

// ---------------------------------------------------------------------------
// Binning
// ---------------------------------------------------------------------------

interface Span {
  startUs: number;
  endUs: number;
}

interface RateSpan extends Span {
  amount: number;
}

/** Add `weight` times the share of each bucket the span covers to that bucket. */
function spread(acc: Float64Array, axis: Axis, span: Span, weight: number): void {
  const startUs = Math.max(span.startUs, axis.startUs);
  const endUs = Math.min(span.endUs, axis.endUs);
  if (endUs <= startUs) return;
  const first = clampBucket(axis, Math.floor((startUs - axis.startUs) / axis.bucketUs));
  const last = clampBucket(axis, Math.floor((endUs - axis.startUs) / axis.bucketUs));
  for (let bucket = first; bucket <= last; bucket += 1) {
    const bucketStartUs = axis.startUs + bucket * axis.bucketUs;
    const overlap = Math.min(endUs, bucketStartUs + axis.bucketUs) - Math.max(startUs, bucketStartUs);
    if (overlap > 0) acc[bucket] += (weight * overlap) / axis.bucketUs;
  }
}

function clampBucket(axis: Axis, bucket: number): number {
  return Math.min(axis.buckets - 1, Math.max(0, bucket));
}

/** The bucket an instant falls in, or -1 when it is outside the axis. */
function bucketOf(axis: Axis, atUs: number): number {
  if (atUs < axis.startUs || atUs > axis.endUs) return -1;
  return clampBucket(axis, Math.floor((atUs - axis.startUs) / axis.bucketUs));
}

function densitySeries(id: string, label: string, spans: Span[], axis: Axis): TimelineSeries {
  const acc = new Float64Array(axis.buckets);
  for (const span of spans) spread(acc, axis, span, 1);
  return recordedSeries(id, label, Array.from(acc, (value) => round(value, 2)), spans.length);
}

/**
 * A bucket before the first reading has no value rather than a zero: nothing
 * was measured there. With no reading at all the series is absent.
 */
function heldSeries(
  id: string,
  label: string,
  readings: TraceReading[],
  valueOf: (reading: TraceReading) => number,
  axis: Axis,
  decimals: number,
): TimelineSeries {
  if (readings.length === 0) return absent(id, label, NO_READING);
  const weighted = new Float64Array(axis.buckets);
  const covered = new Float64Array(axis.buckets);
  for (let i = 0; i < readings.length; i += 1) {
    const span = {
      startUs: readings[i].atUs,
      endUs: i + 1 < readings.length ? readings[i + 1].atUs : axis.endUs,
    };
    spread(weighted, axis, span, valueOf(readings[i]));
    spread(covered, axis, span, 1);
  }
  const values: (number | null)[] = [];
  for (let bucket = 0; bucket < axis.buckets; bucket += 1) {
    values.push(covered[bucket] > 1e-9 ? round(weighted[bucket] / covered[bucket], decimals) : null);
  }
  return recordedSeries(id, label, values, readings.length);
}

/** Not held between readings: a bucket no reading landed in has no value. */
function peakSeries(
  id: string,
  label: string,
  readings: TraceReading[],
  valueOf: (reading: TraceReading) => number,
  axis: Axis,
  noneStatement: string,
): TimelineSeries {
  const values: (number | null)[] = new Array<number | null>(axis.buckets).fill(null);
  let samples = 0;
  for (const reading of readings) {
    const bucket = bucketOf(axis, reading.atUs);
    if (bucket < 0) continue;
    samples += 1;
    const value = valueOf(reading);
    const held = values[bucket];
    values[bucket] = held === null ? value : Math.max(held, value);
  }
  if (samples === 0) return absent(id, label, noneStatement);
  return recordedSeries(id, label, values, samples);
}

/**
 * A bucket with no record is a recorded zero, since none happened, except
 * before `unreadBeforeUs`, where the bucket is unread.
 */
function countSeries<T extends { atUs: number }>(
  id: string,
  label: string,
  records: T[],
  amountOf: (record: T) => number,
  axis: Axis,
  unreadBeforeUs: number | null,
): TimelineSeries {
  const values: (number | null)[] = new Array<number | null>(axis.buckets).fill(0);
  markUnread(values, axis, unreadBeforeUs);
  let samples = 0;
  for (const record of records) {
    const bucket = bucketOf(axis, record.atUs);
    if (bucket < 0) continue;
    samples += 1;
    values[bucket] = (values[bucket] ?? 0) + amountOf(record);
  }
  return recordedSeries(id, label, values, samples);
}

function rateSeries(
  id: string,
  label: string,
  spans: RateSpan[],
  axis: Axis,
  unreadBeforeUs: number | null,
): TimelineSeries {
  const perUs = new Float64Array(axis.buckets);
  let samples = 0;
  for (const span of spans) {
    if (span.endUs <= span.startUs || span.endUs < axis.startUs || span.startUs > axis.endUs) continue;
    samples += 1;
    // Weighted by amount per microsecond, so the integral over the buckets
    // is the amount itself.
    spread(perUs, axis, span, span.amount / (span.endUs - span.startUs));
  }
  const values: (number | null)[] = Array.from(perUs, (value) => Math.round(value * 1_000_000));
  markUnread(values, axis, unreadBeforeUs);
  return recordedSeries(id, label, values, samples);
}

function markUnread(values: (number | null)[], axis: Axis, unreadBeforeUs: number | null): void {
  if (unreadBeforeUs === null) return;
  for (let bucket = 0; bucket < axis.buckets; bucket += 1) {
    if (axis.startUs + (bucket + 1) * axis.bucketUs <= unreadBeforeUs) values[bucket] = null;
  }
}

function recordedSeries(id: string, label: string, values: (number | null)[], samples: number): TimelineSeries {
  let min = Infinity;
  let max = -Infinity;
  let last: number | null = null;
  let unsampled = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value === null) {
      unsampled += 1;
      continue;
    }
    if (last === null) last = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    id,
    label,
    recorded: true,
    values,
    min: last === null ? 0 : min,
    max: last === null ? 0 : max,
    last,
    samples,
    unsampled,
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Whole and fractional milliseconds, so an axis edge is where the caller put it. */
function usToMsExact(us: number): number {
  return us / 1_000;
}

// ---------------------------------------------------------------------------
// The intervals on the axis
// ---------------------------------------------------------------------------

/**
 * One retained interval placed on another run's clock, from its header and
 * the start the caller worked out. Shared with the recorder, which places
 * the closed intervals on the open run's clock the same way.
 */
export function intervalFrom(header: RunHeader, startMs: number, current: boolean): TimelineInterval {
  return {
    runId: header.runId,
    kind: header.cause === null ? "steady-state" : "run",
    current,
    cause: header.cause,
    endReason: header.endReason,
    startMs,
    endMs: startMs + usToMsExact(Math.max(0, header.durationUs)),
  };
}

/** Placed by epoch start, the one clock a document's intervals share. */
function intervalsOf(run: TraceRun, recording?: TimelineRecording): TimelineInterval[] {
  const origin = run.header.startedAtEpochMs;
  const place = (interval: TraceRun): TimelineInterval =>
    intervalFrom(
      interval.header,
      interval.header.startedAtEpochMs - origin,
      interval.header.runId === run.header.runId,
    );
  if (!recording) return [place(run)];
  const intervals = [...recording.runs, ...recording.steadyState].map(place);
  if (!intervals.some((interval) => interval.current)) intervals.push(place(run));
  return intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function totalBytes(sent: SendTallies): number {
  let total = 0;
  for (const { type } of CLIENT_MESSAGES) total += sent[type].bytes;
  return total;
}
