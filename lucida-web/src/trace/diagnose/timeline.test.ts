/**
 * The timeline section: what the dock draws, as fields of the diagnostic
 * document.
 *
 * Every case asserts on the section or on its text rendering, never on how
 * the derivation binned a row. The load-bearing cases are the enumeration,
 * which is what lets a test say every chart has a text twin, and the absent
 * charts, which have to say why they are empty rather than draw a zero.
 */

import { describe, expect, it } from "vitest";

import { diagnoseDocument, diagnoseRun } from "./diagnose.ts";
import {
  coldRemoteOpen,
  gpuTimedOpen,
  healthyLocalOpen,
  interactionRun,
  lateStallOpen,
  mainThreadOnlyOpen,
  makeHeader,
  makeReading,
  makeRow,
  makeRun,
  makeTick,
  saturatedReopen,
  sendHeavyIdleRun,
} from "./fixtures.ts";
import { renderDiagnostic, renderLiveTimeline } from "./renderText.ts";
import {
  deriveLiveTimeline,
  TIMELINE_BUCKETS,
  TIMELINE_CHARTS,
  TIMELINE_MARKS,
  type LiveTimelineSample,
} from "./timeline.ts";
import type { TimelineChart, TimelineSeries } from "./types.ts";
import { CLIENT_MESSAGES, LANE_NAMES, PHASES, TRACE_SCHEMA_VERSION, type TraceDocument } from "../types.ts";

const MS = 1_000;

function chart(charts: TimelineChart[], id: string): TimelineChart {
  const found = charts.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no chart ${id}`);
  return found;
}

function series(chart: TimelineChart, id: string): TimelineSeries {
  const found = chart.series.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no series ${id} on ${chart.id}`);
  return found;
}

function recorded(chart: TimelineChart, id: string): Extract<TimelineSeries, { recorded: true }> {
  const found = series(chart, id);
  if (!found.recorded) throw new Error(`${chart.id}/${id} is absent: ${found.statement}`);
  return found;
}

function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** A live sample over an open run: readings, ticks and events, and no rows. */
function liveSample(overrides: Partial<LiveTimelineSample> = {}): LiveTimelineSample {
  return {
    runId: "run-open",
    cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" },
    atUs: 6_000 * MS,
    readings: Array.from({ length: 30 }, (_, i) =>
      makeReading(1_000 * MS + i * 100 * MS, { queueDepth: 40 - i, inFlight: 8, frameTimeUs: 5_000 }),
    ),
    readingsDropped: 0,
    ticks: [makeTick(1_200 * MS, {}, { chunkRequest: { messages: 8, bytes: 800 } })],
    ticksDropped: 0,
    events: [],
    eventsDropped: 0,
    connections: [
      { generation: 1, openedAtUs: null, closedAtUs: null, gapUs: null, firstRid: null, lastRid: null },
    ],
    gpu: makeHeader().gpu,
    intervals: [],
    sentTotalBytes: 800,
    ...overrides,
  };
}

describe("every chart has a text twin", () => {
  it("carries the closed set of charts in the document, in order, once each", () => {
    const document = diagnoseRun(coldRemoteOpen());

    expect(document.timeline.charts.map((entry) => entry.id)).toEqual(
      TIMELINE_CHARTS.map((entry) => entry.id),
    );
    for (const entry of TIMELINE_CHARTS) {
      const found = chart(document.timeline.charts, entry.id);
      expect(found.title).toBe(entry.title);
      expect(found.kind).toBe(entry.kind);
      expect(found.unit).toBe(entry.unit);
      expect(found.statement.length).toBeGreaterThan(10);
      for (const one of found.series) {
        if (one.recorded) expect(one.values).toHaveLength(TIMELINE_BUCKETS);
        else expect(one.statement.length).toBeGreaterThan(10);
      }
    }
  });

  it("prints one line per chart at the timeline depth, naming absent ones as absent", () => {
    const document = diagnoseRun(mainThreadOnlyOpen());
    const { text } = renderDiagnostic(document, { depth: "timeline" });

    expect(text).toContain("TIMELINE");
    for (const entry of TIMELINE_CHARTS) {
      const line = text.split("\n").find((candidate) => candidate.startsWith(`   ${entry.id} `));
      expect(line, `${entry.id} has no line in the timeline depth`).toBeDefined();
      const found = chart(document.timeline.charts, entry.id);
      expect(line).toContain(found.recorded ? "recorded" : "absent");
    }
    expect(text).toMatch(/bytes\.received\s+rate\s+absent\s+bytes received are not recorded/);
    // A series absent inside a recorded chart is named as absent on that chart's line.
    expect(text).toMatch(/frame\s+line\s+recorded\s+main-thread frame max 3\.5.*GPU pass absent \(the adapter offers no timestamp queries/);
  });

  it("prints the same lines for a live timeline, labelled provisional", () => {
    const live = deriveLiveTimeline(liveSample());
    const text = renderLiveTimeline(live);

    expect(text.split("\n")[0]).toContain("PROVISIONAL");
    expect(text).toContain("not a verdict");
    for (const entry of TIMELINE_CHARTS) {
      expect(text.split("\n").some((line) => line.startsWith(`   ${entry.id} `)), entry.id).toBe(true);
    }
    expect(text).toMatch(/occupancy\.browser\s+density\s+absent\s+read from the rows when the run closes/);
  });

  it("round-trips as JSON, so an agent over the seam loses nothing", () => {
    const live = deriveLiveTimeline(liveSample());
    expect(JSON.parse(JSON.stringify(live))).toEqual(live);
    const document = diagnoseRun(healthyLocalOpen());
    expect(JSON.parse(JSON.stringify(document.timeline))).toEqual(document.timeline);
  });
});

describe("absent data draws as absent, never as zero", () => {
  it("has no received-bytes series, and says the build does not record them", () => {
    const found = chart(diagnoseRun(healthyLocalOpen()).timeline.charts, "bytes.received");

    expect(found.recorded).toBe(false);
    expect(found.series).toEqual([]);
    expect(found.statement).toMatch(/not recorded/);
  });

  it("marks the GPU pass series absent with the render timing's reason when no reading carried one", () => {
    const document = diagnoseRun(mainThreadOnlyOpen());
    const frame = chart(document.timeline.charts, "frame");
    const gpu = series(frame, "gpu-pass");

    expect(frame.recorded).toBe(true);
    expect(recorded(frame, "main-thread").max).toBe(3.5);
    expect(gpu.recorded).toBe(false);
    const timing = document.renderTiming.gpuPass;
    if (!gpu.recorded && !timing.recorded) expect(gpu.statement).toBe(timing.statement);
  });

  it("records the GPU pass series when the readings carried one", () => {
    const frame = chart(diagnoseRun(gpuTimedOpen()).timeline.charts, "frame");
    const gpu = recorded(frame, "gpu-pass");

    expect(gpu.max).toBe(2.4);
    expect(gpu.samples).toBe(11);
  });

  it("draws the total resident bytes and says the pools and budgets are not recorded", () => {
    const resident = chart(diagnoseRun(saturatedReopen()).timeline.charts, "resident");

    expect(recorded(resident, "total").max).toBe(1_000_000);
    expect(resident.series.filter((entry) => !entry.recorded).map((entry) => entry.id)).toEqual(["pools"]);
    expect(resident.statement).toMatch(/pool/);
  });

  it("leaves a bucket before the first reading empty rather than at zero, and counts it", () => {
    // The saturated run's first reading lands at 200 ms of 12 s.
    const inFlight = recorded(chart(diagnoseRun(saturatedReopen()).timeline.charts, "in-flight"), "in-flight");

    expect(inFlight.values[0]).toBeNull();
    expect(inFlight.values[1]).toBeNull();
    expect(inFlight.values[2]).toBe(24);
    expect(inFlight.values[inFlight.values.length - 1]).toBe(24);
    expect(inFlight.max).toBe(24);
    expect(inFlight.last).toBe(24);
    expect(inFlight.unsampled).toBe(2);
  });

  it("marks a series absent when no reading carried it, rather than recording a zero peak", () => {
    // Readings exist, but none carries a frame time above the clock floor.
    const run = makeRun({
      header: { durationUs: 1_000 * MS },
      readings: Array.from({ length: 5 }, (_, i) => makeReading(i * 100 * MS, { inFlight: 2, frameTimeUs: 0 })),
    });
    const frame = chart(diagnoseRun(run).timeline.charts, "frame");
    const main = series(frame, "main-thread");

    expect(main.recorded).toBe(false);
    if (!main.recorded) expect(main.statement).toMatch(/no reading in the window carried a frame time/);
    expect(recorded(chart(diagnoseRun(run).timeline.charts, "in-flight"), "in-flight").max).toBe(2);

    // And with no reading at all, the held series are absent too.
    const none = chart(diagnoseRun(makeRun({ header: { durationUs: 1_000 * MS } })).timeline.charts, "in-flight");
    expect(none.recorded).toBe(false);
    expect(none.series.every((entry) => !entry.recorded)).toBe(true);
  });
});

describe("the axis and the buckets", () => {
  it("spans the run in a fixed number of buckets", () => {
    const { axis } = diagnoseRun(coldRemoteOpen()).timeline;

    expect(axis).toMatchObject({ startMs: 0, endMs: 4_120, spanMs: 4_120, buckets: TIMELINE_BUCKETS });
    expect(axis.bucketMs * axis.buckets).toBeCloseTo(4_120, 1);
  });

  it("spans the window when the document reads one", () => {
    const document = diagnoseRun(lateStallOpen(), { window: { startMs: 0, endMs: 1_000 } });
    const { axis, charts } = document.timeline;

    expect(axis).toMatchObject({ startMs: 0, endMs: 1_000, spanMs: 1_000 });
    // The decode stall starts at 1,100 ms, so the window's decode density is
    // the fast rows' alone.
    const decode = recorded(chart(charts, "occupancy.browser"), "decode");
    expect(decode.max).toBeLessThan(0.5);
    const whole = recorded(chart(diagnoseRun(lateStallOpen()).timeline.charts, "occupancy.browser"), "decode");
    expect(whole.max).toBeGreaterThan(5);
  });
});

describe("the row-derived charts", () => {
  it("conserves each phase's total time across the buckets", () => {
    const document = diagnoseRun(healthyLocalOpen());
    const browser = chart(document.timeline.charts, "occupancy.browser");
    const { bucketMs } = document.timeline.axis;

    expect(browser.series.map((entry) => entry.id)).toEqual([...PHASES]);
    for (const phase of document.phases.filter((entry) => entry.side === "browser")) {
      const entry = recorded(browser, phase.id.replace("browser.", ""));
      // Average rows per bucket times the bucket length is row-milliseconds,
      // which is what the rollup's total counts. Rounded to two decimals per
      // bucket, so the tolerance is the rounding's.
      expect(sum(entry.values) * bucketMs).toBeCloseTo(phase.totalMs, -1);
      expect(entry.samples).toBe(phase.n);
    }
    expect(document.timeline.rowsWalked).toBe(true);
  });

  it("places the dataset open and its reads on the metadata side", () => {
    const metadata = chart(diagnoseRun(coldRemoteOpen()).timeline.charts, "occupancy.metadata");

    expect(recorded(metadata, "dataset-open").max).toBe(1);
    expect(recorded(metadata, "backend-read").max).toBeGreaterThan(5);
    // A recorded zero: the run recorded its reads and none was a cache hit.
    expect(recorded(metadata, "cache-hit").max).toBe(0);
    expect(recorded(metadata, "cache-hit").samples).toBe(0);
  });

  it("draws the server as one bracket series and says the phases inside it have no position", () => {
    const rows = coldRemoteOpen();
    for (const [index, row] of rows.serverRows.entries()) {
      if (row.family !== "chunk") continue;
      row.placement = { startUs: 3_800 * MS + index, endUs: 3_900 * MS + index, gapUs: 0, overshootUs: 0 };
    }
    const server = chart(diagnoseRun(rows).timeline.charts, "occupancy.server");

    expect(server.series.map((entry) => entry.id)).toEqual(["bracket"]);
    expect(recorded(server, "bracket").max).toBeGreaterThan(0);
    expect(recorded(server, "bracket").samples).toBe(60);
    expect(server.statement).toMatch(/no position/);
  });

  it("counts a server row placed nowhere rather than drawing it", () => {
    const server = chart(diagnoseRun(coldRemoteOpen()).timeline.charts, "occupancy.server");

    expect(server.recorded).toBe(false);
    expect(server.statement).toContain("60");
  });

  it("splits in-flight rows by lane, from first boundary to last or to run close", () => {
    const run = makeRun({
      header: { durationUs: 1_000 * MS },
      rows: [
        makeRow({ startUs: 0, durations: { plan: 100 * MS, queue: 100 * MS }, lane: "detail" }, 0),
        makeRow(
          { startUs: 500 * MS, durations: { plan: 100 * MS }, lane: "prefetch", outcome: "in-flight" },
          1,
        ),
      ],
    });
    const document = diagnoseRun(run);
    const lanes = chart(document.timeline.charts, "in-flight.lane");
    const { bucketMs } = document.timeline.axis;

    expect(lanes.series.map((entry) => entry.id)).toEqual([...LANE_NAMES]);
    expect(sum(recorded(lanes, "detail").values) * bucketMs).toBeCloseTo(200, 0);
    // Still in flight at close, so it is charged to the end of the run.
    expect(sum(recorded(lanes, "prefetch").values) * bucketMs).toBeCloseTo(500, 0);
    expect(recorded(lanes, "minimap").max).toBe(0);
  });
});

describe("the per-tick charts", () => {
  it("spreads each sample's sent bytes over the interval since the previous sample, as a rate", () => {
    const document = diagnoseRun(sendHeavyIdleRun());
    const sent = chart(document.timeline.charts, "bytes.sent");
    const { bucketMs } = document.timeline.axis;
    const chunkRequests = recorded(sent, "chunkRequest");

    expect(sent.series.map((entry) => entry.id)).toEqual(CLIENT_MESSAGES.map((entry) => entry.type));
    expect(chunkRequests.label).toBe("chunk request");
    // 1,176 bytes over the first 20 ms of a 10 s run: the integral of the
    // rate over the buckets is the bytes, and the peak is the rate over the
    // 83 ms bucket the 20 ms landed in.
    expect(sum(chunkRequests.values) * (bucketMs / 1_000)).toBeCloseTo(1_176, -1);
    expect(chunkRequests.max).toBe(Math.round(1_176 / (bucketMs / 1_000)));
    expect(chunkRequests.values[1]).toBe(0);
    // The run's totals are the honest figure; the samples miss the sends
    // after the last planning pass, and the statement says so.
    expect(sent.statement).toContain("30,376");
  });

  it("marks the buckets before a wrapped ring's memory as unsampled rather than zero", () => {
    // The ring dropped older samples, so nothing is known before the oldest
    // retained one at 600 ms: the buckets before it are unread, and the
    // oldest sample's own sends have no known interval and are not drawn.
    const run = makeRun({
      header: { durationUs: 1_200 * MS },
      ticks: [
        makeTick(600 * MS, {}, { cursor: { messages: 5, bytes: 500 } }),
        makeTick(900 * MS, {}, { cursor: { messages: 2, bytes: 200 } }),
      ],
      ticksDropped: 40,
    });
    const { charts } = diagnoseRun(run).timeline;
    const planned = recorded(chart(charts, "planned.lane"), "detail");
    const sent = recorded(chart(charts, "bytes.sent"), "cursor");
    const plans = recorded(chart(charts, "events"), "plan");

    expect(planned.values[0]).toBeNull();
    expect(planned.values[59]).toBeNull();
    expect(planned.values[60]).toBe(0);
    expect(planned.unsampled).toBe(60);
    expect(sent.values[30]).toBeNull();
    expect(sum(sent.values.slice(60, 90)) * (10 / 1_000)).toBeCloseTo(200, 0);
    expect(plans.values[60]).toBe(1);
    expect(plans.values[10]).toBeNull();
    expect(chart(charts, "planned.lane").statement).toMatch(/dropped 40 older sample/);
  });

  it("counts planned requests by lane per bucket", () => {
    const tick = makeTick(300 * MS);
    tick.counters.laneDetail = 12;
    tick.counters.lanePrefetch = 3;
    const run = makeRun({ header: { durationUs: 1_200 * MS }, ticks: [tick] });
    const planned = chart(diagnoseRun(run).timeline.charts, "planned.lane");

    expect(sum(recorded(planned, "detail").values)).toBe(12);
    expect(sum(recorded(planned, "prefetch").values)).toBe(3);
    expect(recorded(planned, "detail").values[30]).toBe(12);
  });

  it("marks evictions, level changes, reconnects and plans where they happened", () => {
    const run = makeRun({
      header: {
        durationUs: 1_200 * MS,
        connections: [
          { generation: 1, openedAtUs: null, closedAtUs: 400 * MS, gapUs: null, firstRid: null, lastRid: null },
          { generation: 2, openedAtUs: 600 * MS, closedAtUs: null, gapUs: 200 * MS, firstRid: null, lastRid: null },
        ],
      },
      ticks: [makeTick(120 * MS), makeTick(130 * MS)],
      events: [
        {
          atUs: 240 * MS,
          kind: "eviction",
          reason: "evicted",
          chunk: {
            datasetId: "ds", entityId: "m", imageId: "i", residencyTier: "detail",
            level: 1, t: 0, c: 0, z: 0, y: 0, x: 0, chunkKey: "1/0/0/0/0/0",
          },
          levelChange: null,
        },
        {
          atUs: 900 * MS,
          kind: "level-change",
          reason: "screen",
          chunk: null,
          levelChange: { datasetId: "ds", from: { min: 2, max: 2 }, to: { min: 1, max: 1 } },
        },
      ],
    });
    const events = chart(diagnoseRun(run).timeline.charts, "events");

    expect(events.series.map((entry) => entry.id)).toEqual([...TIMELINE_MARKS]);
    expect(recorded(events, "eviction").values[24]).toBe(1);
    expect(recorded(events, "level-change").values[90]).toBe(1);
    expect(recorded(events, "reconnect").values[60]).toBe(1);
    expect(recorded(events, "plan").values[12]).toBe(1);
    expect(recorded(events, "plan").values[13]).toBe(1);
    expect(recorded(events, "retry").samples).toBe(0);
    expect(events.statement).toMatch(/not a health signal/);
  });

  it("holds a reading's value until the next one and takes the worst frame in a bucket", () => {
    const run = makeRun({
      header: { durationUs: 1_200 * MS },
      readings: [
        makeReading(100 * MS, { queueDepth: 5, inFlight: 2, frameTimeUs: 4_000 }),
        makeReading(105 * MS, { queueDepth: 5, inFlight: 4, frameTimeUs: 30_000 }),
        makeReading(700 * MS, { queueDepth: 0, inFlight: 1, frameTimeUs: 2_000 }),
      ],
    });
    const { charts } = diagnoseRun(run).timeline;
    const inFlight = recorded(chart(charts, "in-flight"), "in-flight");
    const frame = recorded(chart(charts, "frame"), "main-thread");

    expect(inFlight.values[10]).toBe(3);
    expect(inFlight.values[40]).toBe(4);
    expect(inFlight.values[70]).toBe(1);
    expect(inFlight.values[119]).toBe(1);
    expect(frame.values[10]).toBe(30);
    expect(frame.values[40]).toBeNull();
    expect(frame.values[70]).toBe(2);
    expect(frame.samples).toBe(3);
  });
});

describe("the intervals on the axis", () => {
  it("places every retained interval on this run's clock and flags the one being read", () => {
    const first = healthyLocalOpen();
    const second = interactionRun();
    second.header.startedAtEpochMs = first.header.startedAtEpochMs + 5_000;
    const steady = makeRun({
      header: {
        runId: "steady-1",
        cause: null,
        endReason: "run-opened",
        startedAtEpochMs: first.header.startedAtEpochMs + 330,
        durationUs: 4_670 * MS,
      },
    });
    const document: TraceDocument = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      exportedAtEpochMs: 0,
      retention: {
        residentCapBytes: 0, perRunCapBytes: 0, residentBytes: 0, intervalsEvicted: 0,
        derivedFrom: "", capUnit: "",
      },
      instrumentedPhases: [],
      countedPhases: [],
      runs: [first, second],
      steadyState: [steady],
      rowsOutsideRun: 0,
      serverRowsOutsideRun: 0,
    };

    const intervals = diagnoseDocument(document, { runId: second.header.runId }).timeline.intervals;

    expect(intervals.map((entry) => [entry.runId, entry.kind, entry.current])).toEqual([
      ["local-healthy", "run", false],
      ["steady-1", "steady-state", false],
      ["interaction-pan", "run", true],
    ]);
    expect(intervals[0]).toMatchObject({ startMs: -5_000, endMs: -4_670 });
    expect(intervals[2]).toMatchObject({ startMs: 0, endMs: 2_000, endReason: "quiescent" });
  });

  it("carries the run alone when no recording is given", () => {
    const intervals = diagnoseRun(healthyLocalOpen()).timeline.intervals;

    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ runId: "local-healthy", current: true, startMs: 0, endMs: 330 });
  });
});

describe("the live timeline over an open run", () => {
  it("draws from the readings, the ticks and the events, and walks no rows", () => {
    const live = deriveLiveTimeline(liveSample());

    expect(live.provisional).toBe(true);
    expect(live.statement.startsWith("provisional")).toBe(true);
    expect(live.timeline.rowsWalked).toBe(false);
    expect(live.window).toMatchObject({ startMs: 0, endMs: 6_000, wholeRun: true });
    const inFlight = recorded(chart(live.timeline.charts, "in-flight"), "in-flight");
    expect(inFlight.max).toBe(8);
    expect(recorded(chart(live.timeline.charts, "in-flight"), "pending").max).toBe(40);
    expect(recorded(chart(live.timeline.charts, "planned.lane"), "detail").samples).toBe(1);
    expect(recorded(chart(live.timeline.charts, "events"), "plan").samples).toBe(1);
    expect(chart(live.timeline.charts, "bytes.sent").statement).toContain("800");
  });

  it("marks the row-derived charts absent and says when they are read", () => {
    const live = deriveLiveTimeline(liveSample());

    for (const id of ["occupancy.browser", "occupancy.server", "occupancy.metadata", "in-flight.lane"]) {
      const found = chart(live.timeline.charts, id);
      expect(found.recorded, id).toBe(false);
      expect(found.series, id).toEqual([]);
      expect(found.statement, id).toMatch(/close/);
    }
  });

  it("reaches back the requested window and clamps it at run start", () => {
    const trailing = deriveLiveTimeline(liveSample(), { windowMs: 2_000 });
    expect(trailing.window).toMatchObject({ startMs: 4_000, endMs: 6_000, spanMs: 2_000, wholeRun: false });
    expect(trailing.timeline.axis).toMatchObject({ startMs: 4_000, endMs: 6_000 });
    // The readings before the window are carried: the one in force at the
    // window's start still holds through its first bucket.
    expect(recorded(chart(trailing.timeline.charts, "in-flight"), "in-flight").values[0]).toBe(8);

    const whole = deriveLiveTimeline(liveSample(), { windowMs: 60_000 });
    expect(whole.window.wholeRun).toBe(true);
  });

  it("carries the open run as the current interval, ending now and with no end reason yet", () => {
    const live = deriveLiveTimeline(
      liveSample({
        intervals: [
          {
            runId: "run-earlier", kind: "run", current: false, cause: null, endReason: "quiescent",
            startMs: -9_000, endMs: -8_000,
          },
        ],
      }),
    );

    expect(live.timeline.intervals.map((entry) => entry.runId)).toEqual(["run-earlier", "run-open"]);
    expect(live.timeline.intervals[1]).toMatchObject({ current: true, startMs: 0, endMs: 6_000, endReason: null });
  });

  it("marks the GPU series absent for the adapter's reason when no reading carried one", () => {
    const gpu = series(chart(deriveLiveTimeline(liveSample()).timeline.charts, "frame"), "gpu-pass");

    expect(gpu.recorded).toBe(false);
    if (!gpu.recorded) expect(gpu.statement).toMatch(/timestamp queries/);
  });

  it("says when the rings dropped records, next to the charts they feed", () => {
    const live = deriveLiveTimeline(liveSample({ readingsDropped: 12, ticksDropped: 3 }));

    expect(chart(live.timeline.charts, "in-flight").statement).toContain("dropped 12");
    expect(chart(live.timeline.charts, "planned.lane").statement).toContain("dropped 3");
  });
});
