/**
 * The Chrome Trace Event projection (#934). These cases assert on the
 * *document* — track names, span placement, counter series, what the header
 * declares — because that is the external behaviour a reader opening the file
 * in Perfetto depends on. How the projection walks the table is not.
 */

import { describe, expect, it } from "vitest";

import {
  chromeTraceOtherData,
  PID_BROWSER,
  PID_SERVER,
  phaseTid,
  toChromeTraceEvents,
  toChromeTraceFile,
  toChromeTraceJson,
  type ChromeTraceEvent,
} from "./chromeTrace.ts";
import {
  PHASES,
  type RunHeader,
  type TraceDocument,
  type TraceRow,
  type TraceReading,
  type TraceRun,
  type TraceTick,
} from "./types.ts";

const HEADER: RunHeader = {
  datasetIds: ["ds"],
  composedView: { url: "/w/ws-1?d=set", mode: "slice" },
  devicePixelRatio: 2,
  viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
  cacheWarmth: { detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0 },
  schemaVersion: 1,
  runId: "run-1",
  cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_added" },
  endReason: "quiescent",
  build: { version: "0.2.0", mode: "production", dev: false },
  gpu: null,
  startedAtEpochMs: 1_700_000_000_000,
  durationUs: 5_000_000,
  quiescenceHoldMs: 500,
  timeoutMs: 60_000,
  truncation: null,
  connections: [
    { generation: 1, openedAtUs: null, closedAtUs: null, gapUs: null, firstRid: 0, lastRid: 4 },
  ],
  outstandingAtSettle: {
    pending: 0,
    inFlight: 0,
    speculativePending: 0,
    speculativeInFlight: 0,
    desiredDetailChunks: 0,
    residentDetailChunks: 0,
    desiredCoarseChunks: 0,
    residentCoarseChunks: 0,
  },
};

function row(overrides: Partial<TraceRow> = {}): TraceRow {
  return {
    rid: 3,
    connectionGeneration: 1,
    datasetId: "ds",
    entityId: "member-1",
    imageId: "image-1",
    lane: "detail",
    residencyTier: "detail",
    level: 1,
    t: 0,
    c: 0,
    z: 0,
    y: 2,
    x: 3,
    chunkKey: "1/0/0/0/2/3",
    outcome: "complete",
    phases: {
      plan: { startUs: 0, endUs: 1_000, durationUs: 1_000 },
      queue: { startUs: 1_000, endUs: 4_000, durationUs: 3_000 },
    },
    ...overrides,
  };
}

function reading(atUs: number, values: Partial<Omit<TraceReading, "atUs">> = {}): TraceReading {
  return { atUs, queueDepth: 0, inFlight: 0, frameTimeUs: 0, residentBytes: 0, ...values };
}

function tick(atUs: number, overrides: Partial<TraceTick> = {}): TraceTick {
  return {
    atUs,
    datasetId: "ds",
    counters: {
      laneMinimap: 0, laneDetail: 0, laneCoarse: 0, lanePrefetch: 0, laneOverview: 0,
      proxyRequests: 0, plannedChunks: 0, cullingConsidered: 0, cullingAfterXyBounds: 0,
      cullingAfterZRange: 0, cullingAfterFrustum: 0, catalogDegradations: 0,
      activeSetTotal: 0, activeSetGroupAsProxy: 0, activeSetTilesProxyFallback: 0,
      activeSetTilesDetail: 0,
    },
    counted: { "cache-admission": 0, "worker-dispatch": 0, "coalesce-attach": 0 },
    levels: [],
    levelsDropped: 0,
    targetLevel: null,
    levelPinned: false,
    displayedLevel: null,
    ...overrides,
  };
}

function run(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    header: HEADER,
    coverage: {
      wallClockUs: HEADER.durationUs,
      accountedUs: 0,
      unaccountedUs: HEADER.durationUs,
      gaps: [],
      countedPhases: { "cache-admission": 0, "worker-dispatch": 0, "coalesce-attach": 0 },
      limits: [],
    },
    rows: [],
    ticks: [],
    ticksDropped: 0,
    readings: [],
    readingsDropped: 0,
    events: [],
    eventsDropped: 0,
    serverRows: [],
    datasetOpens: [],
    datasetOpensDropped: 0,
    serverRowsDropped: 0,
    serverRowsDiscarded: 0,
    ...overrides,
  };
}

function doc(...runs: TraceRun[]): TraceDocument {
  return {
    schemaVersion: 1,
    exportedAtEpochMs: 1_700_000_010_000,
    instrumentedPhases: [...PHASES],
    countedPhases: ["cache-admission", "worker-dispatch", "coalesce-attach"],
    retention: {
      residentCapBytes: 8 * 1024 * 1024,
      perRunCapBytes: 2 * 1024 * 1024,
      residentBytes: 0,
      intervalsEvicted: 0,
      derivedFrom: "",
      capUnit: "",
    },
    runs,
    steadyState: [],
    rowsOutsideRun: 4,
    serverRowsOutsideRun: 1,
  };
}

const named = (events: ChromeTraceEvent[], name: string) => events.filter(e => e.name === name);
const metadataFor = (events: ChromeTraceEvent[], pid: number, tid: number) =>
  events.find(e => e.ph === "M" && e.name === "thread_name" && e.pid === pid && e.tid === tid);

describe("the Chrome Trace Event projection", () => {
  it("names one track per instrumented phase, and the server as a second process", () => {
    const events = toChromeTraceEvents(doc(run()));

    for (const phase of PHASES) {
      expect(metadataFor(events, PID_BROWSER, phaseTid(phase))?.args).toEqual({ name: phase });
    }
    expect(events).toContainEqual(
      expect.objectContaining({ ph: "M", name: "process_name", pid: PID_SERVER }),
    );
    expect(metadataFor(events, PID_SERVER, 10)?.args).toEqual({ name: "serve" });
  });

  /**
   * The track, not the slice name, is what makes the file readable — that is
   * the whole reason for the complete-event shape over async events.
   */
  it("fans a row out into one complete event per phase, each on its phase's track", () => {
    const events = toChromeTraceEvents(doc(run({ rows: [row()] })));

    const plan = named(events, "plan").filter(e => e.ph === "X");
    const queue = named(events, "queue").filter(e => e.ph === "X");
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ ph: "X", ts: 0, dur: 1_000, tid: phaseTid("plan") });
    expect(queue[0]).toMatchObject({ ts: 1_000, dur: 3_000, tid: phaseTid("queue") });
    expect(queue[0].args).toMatchObject({ key: "1/0/0/0/2/3", lane: "detail", rid: 3 });
    // No decode / wire / upload spans: those boundaries were never stamped,
    // and a phase absent from a row is "not measured", not "took no time".
    expect(named(events, "wire").filter(e => e.ph === "X")).toHaveLength(0);
  });

  it("draws a socket outage on the run's own track", () => {
    const header = {
      ...HEADER,
      connections: [
        ...HEADER.connections,
        {
          generation: 2,
          openedAtUs: 3_000_000,
          closedAtUs: null,
          gapUs: 2_000_000,
          firstRid: 0,
          lastRid: 9,
        },
      ],
    };
    const events = toChromeTraceEvents(doc(run({ header })));

    const [outage] = named(events, "socket outage → generation 2");
    expect(outage).toMatchObject({ ph: "X", ts: 1_000_000, dur: 2_000_000, tid: 1 });
    // The connection this run started on never dropped, so it draws nothing.
    expect(events.filter(event => event.cat === "run,connection")).toHaveLength(1);
  });

  it("reports no wire request rather than a plausible rid when the row was never labelled", () => {
    const events = toChromeTraceEvents(
      doc(run({ rows: [row({ rid: 0, connectionGeneration: 0 })] })),
    );
    expect(named(events, "plan")[0].args).toMatchObject({ rid: null });
  });

  it("draws a phase a row entered and never left through to run end, tagged unfinished", () => {
    const events = toChromeTraceEvents(doc(run({ rows: [row({ outcome: "in-flight" })] })));

    const wire = named(events, "wire").filter(e => e.ph === "X");
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ ts: 4_000, dur: HEADER.durationUs - 4_000 });
    expect(wire[0].cat).toContain("unfinished");
    expect(wire[0].args).toMatchObject({ unfinishedAtRunEnd: true });
  });

  /**
   * A row in flight with nothing stamped stalled *earliest*. It has no
   * position to be drawn from, so it is counted rather than left as an
   * absence — an omitted row makes the emptiest phase look the healthiest.
   */
  it("counts an in-flight row it cannot place instead of dropping it silently", () => {
    const document = doc(run({ rows: [row({ outcome: "in-flight", phases: {} })] }));

    expect(toChromeTraceEvents(document).filter(e => e.ph === "X" && e.cat?.startsWith("chunk")))
      .toHaveLength(0);
    const [header] = chromeTraceOtherData(document).runs as Record<string, unknown>[];
    expect(header.undrawableInFlightRows).toBe(1);
  });

  it("draws nothing extra for a retired row, which would invent a stall", () => {
    const events = toChromeTraceEvents(doc(run({ rows: [row({ outcome: "retired" })] })));
    expect(named(events, "wire")).toHaveLength(0);
  });

  it("carries queue depth, in-flight, frame time and resident bytes as counter tracks", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          readings: [
            reading(1_000, {
              queueDepth: 1_204,
              inFlight: 12,
              frameTimeUs: 16_700,
              residentBytes: 6_000_000_000,
            }),
          ],
        }),
      ),
    );

    const counters = events.filter(e => e.ph === "C");
    expect(counters.map(e => e.name)).toEqual([
      "queue depth",
      "in flight",
      "frame time (ms)",
      "resident bytes",
    ]);
    expect(counters.every(e => e.ts === 1_000 && e.pid === PID_BROWSER)).toBe(true);
    expect(counters.map(e => e.args?.value)).toEqual([1_204, 12, 16.7, 6_000_000_000]);
  });

  /**
   * A counter track is only a series if it has points across the run. The
   * reading tier is sampled per tick for exactly that reason, and the
   * projection must not collapse it back to the planning cadence.
   */
  it("draws a counter point for every reading, planning pass or not", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          ticks: [tick(1_000)],
          readings: [reading(1_000, { inFlight: 5 }), reading(17_000, { inFlight: 3 })],
        }),
      ),
    );
    const inFlight = events.filter(e => e.ph === "C" && e.name === "in flight");
    expect(inFlight.map(e => [e.ts, e.args?.value])).toEqual([
      [1_000, 5],
      [17_000, 3],
    ]);
  });

  it("places a server span inside the browser's bracket and keeps the gap readable", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          serverRows: [
            {
              rid: 3,
              connectionGeneration: 1,
              family: "chunk",
              outcome: "delivered",
              phases: { arrival: 100, "backend-read": 800 },
              coalescedOnto: null,
              requestId: null,
              metadataPhase: null,
              dispatchOffsetUs: 0,
              durationUs: 0,
              placement: { startUs: 2_000, endUs: 2_900, gapUs: 2_100, overshootUs: 0 },
              unplacedReason: null,
            },
          ],
        }),
      ),
    );

    const serve = events.filter(e => e.pid === PID_SERVER && e.ph === "X");
    expect(serve).toHaveLength(1);
    expect(serve[0]).toMatchObject({ ts: 2_000, dur: 900, tid: 10 });
    expect(serve[0].args).toMatchObject({ rid: 3, gapUs: 2_100 });
  });

  it("counts an unplaced server row in the header instead of inventing a position", () => {
    const document = doc(
      run({
        serverRows: [
          {
            rid: 9,
            connectionGeneration: 1,
            family: "asset",
            outcome: "not-ready",
            phases: { arrival: 10, handoff: 20 },
            coalescedOnto: null,
            requestId: null,
            metadataPhase: null,
            dispatchOffsetUs: 0,
            durationUs: 0,
            placement: null,
            unplacedReason: "answered-without-delivery",
          },
        ],
      }),
    );

    expect(toChromeTraceEvents(document).filter(e => e.pid === PID_SERVER && e.ph === "X"))
      .toHaveLength(0);
    const header = chromeTraceOtherData(document);
    expect((header.runs as Record<string, unknown>[])[0].unplacedServerRows).toEqual({
      "no-browser-row": 0,
      "no-open-bracket": 0,
      "answered-without-delivery": 1,
      "bracket-open": 0,
    });
  });

  it("puts point events on their own track as instants", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          events: [
            { atUs: 2_500, kind: "eviction", reason: "evicted", chunk: null, levelChange: null },
          ],
        }),
      ),
    );

    const instant = events.find(e => e.ph === "i");
    expect(instant).toMatchObject({ name: "eviction: evicted", ts: 2_500, tid: 2 });
    expect(instant?.args).toEqual({
      kind: "eviction", reason: "evicted", dataset: null, key: null, level: null, from: null, to: null,
    });
  });

  it("names the chunk and its level on a point event about one chunk", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          events: [{
            atUs: 10,
            kind: "eviction",
            reason: "evicted",
            chunk: {
              datasetId: "ds-1", entityId: "e-1", imageId: "img-1", residencyTier: "detail",
              level: 3, t: 0, c: 0, z: 0, y: 1, x: 2, chunkKey: "3/0/0/0/1/2",
            },
            levelChange: null,
          }],
        }),
      ),
    );

    const instant = events.find(e => e.ph === "i");
    expect(instant?.args).toMatchObject({
      kind: "eviction", reason: "evicted", dataset: "ds-1", key: "3/0/0/0/1/2", level: 3,
    });
  });

  it("names the dataset and the old and new range on a level-change instant", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          events: [{
            atUs: 3_000,
            kind: "level-change",
            reason: "screen",
            chunk: null,
            levelChange: { datasetId: "ds-1", from: { min: 1, max: 1 }, to: { min: 2, max: 2 } },
          }],
        }),
      ),
    );

    const instant = events.find(e => e.ph === "i");
    expect(instant).toMatchObject({ name: "level-change: screen", ts: 3_000, tid: 2 });
    expect(instant?.args).toMatchObject({
      dataset: "ds-1", from: { min: 1, max: 1 }, to: { min: 2, max: 2 }, key: null,
    });
  });

  /** One pair per dataset, because a workspace's datasets can sit at different levels. */
  it("draws the target and displayed level per dataset as counter tracks off the ticks", () => {
    const events = toChromeTraceEvents(
      doc(
        run({
          ticks: [
            tick(1_000, { targetLevel: { min: 2, max: 2 }, displayedLevel: null }),
            tick(9_000, {
              targetLevel: { min: 1, max: 2 },
              displayedLevel: { min: 2, max: 3 },
            }),
          ],
        }),
      ),
    );

    const target = events.filter(e => e.ph === "C" && e.name === "target level (ds)");
    const displayed = events.filter(e => e.ph === "C" && e.name === "displayed level (ds)");
    expect(target.map(e => [e.ts, e.args])).toEqual([
      [1_000, { finest: 2, coarsest: 2 }],
      [9_000, { finest: 1, coarsest: 2 }],
    ]);
    // -1: a counter has no null.
    expect(displayed.map(e => [e.ts, e.args])).toEqual([
      [1_000, { finest: -1, coarsest: -1 }],
      [9_000, { finest: 2, coarsest: 3 }],
    ]);
    expect(target.every(e => e.pid === PID_BROWSER)).toBe(true);
  });

  /**
   * Run-relative microseconds alone would stack every run on top of the first;
   * the wall-clock start is the only thing that orders them.
   */
  it("lays several runs end to end by their wall-clock start", () => {
    const second: TraceRun = run({
      header: { ...HEADER, runId: "run-2", startedAtEpochMs: HEADER.startedAtEpochMs + 8_000 },
      rows: [row()],
    });
    const events = toChromeTraceEvents(doc(run({ rows: [row()] }), second));

    const runSlices = events.filter(e => e.cat === "run");
    expect(runSlices.map(e => [e.name, e.ts])).toEqual([
      ["run-1", 0],
      ["run-2", 8_000_000],
    ]);
    expect(named(events, "plan").map(e => e.ts)).toEqual([0, 8_000_000]);
  });

  it("carries the header, the coverage and the derivation notes in otherData", () => {
    const file = toChromeTraceFile(doc(run({ ticksDropped: 7 })));

    expect(file.displayTimeUnit).toBe("ms");
    expect(file.otherData.rowsOutsideRun).toBe(4);
    expect(file.otherData.serverRowsOutsideRun).toBe(1);
    // A timeline cannot draw a span without committing to a position, and two
    // of the positions here are constructed rather than measured. Declaring
    // "none" while inventing them is the failure this list exists to prevent.
    const synthetic = file.otherData.syntheticValues as string[];
    expect(synthetic).toHaveLength(2);
    expect(synthetic.join(" ")).toContain("centred inside the browser's bracket");
    expect(synthetic.join(" ")).toContain("run end, not an observation");
    expect((file.otherData.derivedValues as string[]).length).toBeGreaterThan(0);
    const [header] = file.otherData.runs as Record<string, unknown>[];
    expect(header).toMatchObject({ runId: "run-1", devicePixelRatio: 2, ticksDropped: 7 });
  });

  it("serialises to JSON a viewer can load", () => {
    const parsed = JSON.parse(toChromeTraceJson(doc(run({ rows: [row()] }))));
    expect(parsed.traceEvents.length).toBeGreaterThan(0);
    expect(parsed.displayTimeUnit).toBe("ms");
  });

  it("projects an empty document without inventing a run", () => {
    const events = toChromeTraceEvents(doc());
    expect(events.every(e => e.ph === "M")).toBe(true);
  });
});
