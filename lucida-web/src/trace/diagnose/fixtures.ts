/**
 * Fixture runs for the derivation module.
 *
 * These are #893's five synthesised runs rebuilt against the real trace types
 * rather than the prototype's private shapes. They exist so every threshold,
 * the attribution back-walk and the coverage block are tested over a document
 * with no browser involved — the derivation is a pure function, so its tests
 * should be too.
 *
 * Two of them are regression fixtures for the prototype's sharpest findings
 * and are named for what they must *not* produce: {@link healthyLocalOpen}
 * must not report a stall, and {@link uninstrumentedPrefixOpen} must not
 * report full coverage.
 *
 * Imported only from tests, so nothing here reaches a bundle.
 */

import { computeCoverage } from "../coverage.ts";
import {
  PHASES,
  type CountedPhase,
  type LaneName,
  type MetadataReadPhase,
  type Phase,
  type RunHeader,
  type ServerPhaseDurations,
  type TraceReading,
  type TraceRow,
  type TraceRun,
  type TraceServerRow,
  type TraceTick,
  TRACE_SCHEMA_VERSION,
} from "../types.ts";

const MS = 1_000;

export interface RowSpec {
  /** Run-relative microseconds of the row's first boundary. */
  startUs: number;
  /** Duration in microseconds per phase, in phase order. A phase omitted was never entered. */
  durations: Partial<Record<Phase, number>>;
  rid?: number;
  lane?: LaneName;
  chunkKey?: string;
  outcome?: TraceRow["outcome"];
}

export function makeRow(spec: RowSpec, index = 0): TraceRow {
  const phases: TraceRow["phases"] = {};
  let cursor = spec.startUs;
  for (const phase of PHASES) {
    const durationUs = spec.durations[phase];
    if (durationUs == null) continue;
    phases[phase] = { startUs: cursor, endUs: cursor + durationUs, durationUs };
    cursor += durationUs;
  }
  return {
    rid: spec.rid ?? index,
    connectionGeneration: 1,
    datasetId: "ds",
    entityId: `member-${index % 8}`,
    imageId: "image-1",
    lane: spec.lane ?? "detail",
    residencyTier: "detail",
    level: 1,
    t: 0,
    c: 0,
    z: 0,
    y: index,
    x: 0,
    chunkKey: spec.chunkKey ?? `1/0/0/0/${index}/0`,
    outcome: spec.outcome ?? "complete",
    phases,
  };
}

export function makeServerRow(overrides: Partial<TraceServerRow> = {}): TraceServerRow {
  return {
    rid: 0,
    connectionGeneration: 1,
    family: "chunk",
    outcome: "delivered",
    phases: {},
    coalescedOnto: null,
    backendBytes: null,
    dispatchOffsetUs: 0,
    durationUs: 0,
    requestId: null,
    metadataPhase: null,
    placement: null,
    unplacedReason: null,
    ...overrides,
  };
}

export function makeMetadataRow(
  requestId: string,
  dispatchOffsetUs: number,
  durationUs: number,
  metadataPhase: MetadataReadPhase = "backend-read",
): TraceServerRow {
  return makeServerRow({
    family: "metadata-read",
    metadataPhase,
    requestId,
    dispatchOffsetUs,
    durationUs,
  });
}

export function makeReading(atUs: number, overrides: Partial<TraceReading> = {}): TraceReading {
  return {
    atUs,
    queueDepth: 0,
    inFlight: 0,
    frameTimeUs: 4_000,
    residentBytes: 1_000_000,
    ...overrides,
  };
}

export function makeTick(atUs: number, counted: Partial<Record<CountedPhase, number>> = {}): TraceTick {
  return {
    atUs,
    datasetId: "ds",
    counters: {
      laneMinimap: 0,
      laneDetail: 0,
      laneCoarse: 0,
      lanePrefetch: 0,
      laneOverview: 0,
      proxyRequests: 0,
      plannedChunks: 0,
      cullingConsidered: 0,
      cullingAfterXyBounds: 0,
      cullingAfterZRange: 0,
      cullingAfterFrustum: 0,
      catalogDegradations: 0,
      activeSetTotal: 0,
      activeSetGroupAsProxy: 0,
      activeSetTilesProxyFallback: 0,
      activeSetTilesDetail: 0,
    },
    counted: {
      "cache-admission": counted["cache-admission"] ?? 0,
      "worker-dispatch": counted["worker-dispatch"] ?? 0,
      "coalesce-attach": counted["coalesce-attach"] ?? 0,
    },
    levels: [],
    levelsDropped: 0,
    targetLevel: null,
    levelPinned: false,
    displayedLevel: null,
  };
}

export function makeHeader(overrides: Partial<RunHeader> = {}): RunHeader {
  return {
    datasetIds: ["ds"],
    composedView: { url: "/w/ws-1?d=set", mode: "slice" },
    devicePixelRatio: 2,
    viewport: { cssWidth: 1440, cssHeight: 900, deviceWidth: 2880, deviceHeight: 1800 },
    cacheWarmth: { detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0 },
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId: "run-1",
    cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_added" },
    endReason: "quiescent",
    truncation: null,
    // One socket, up for the whole interval: the shape a healthy run has.
    // A fixture that needs an outage declares its own connections.
    connections: [
      { generation: 1, openedAtUs: null, closedAtUs: null, gapUs: null, firstRid: null, lastRid: null },
    ],
    build: { version: "0.2.0", mode: "production", dev: false },
    // No timestamp queries, so the default readings carry no GPU pass time.
    // A fixture that adds GPU time must also declare an adapter that offers
    // them.
    gpu: {
      vendor: "apple",
      architecture: "metal-3",
      device: "",
      description: "",
      fallback: false,
      timestampQueries: false,
    },
    startedAtEpochMs: 1_700_000_000_000,
    durationUs: 1_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 60_000,
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
    ...overrides,
  };
}

export interface RunSpec {
  header?: Partial<RunHeader>;
  rows?: TraceRow[];
  ticks?: TraceTick[];
  readings?: TraceReading[];
  serverRows?: TraceServerRow[];
  datasetOpens?: TraceRun["datasetOpens"];
  events?: TraceRun["events"];
  ticksDropped?: number;
  eventsDropped?: number;
  serverRowsDropped?: number;
  serverRowsDiscarded?: number;
}

/** Coverage is computed rather than declared, so a fixture cannot claim coverage its rows do not have. */
export function makeRun(spec: RunSpec = {}): TraceRun {
  const header = makeHeader(spec.header);
  const rows = spec.rows ?? [];
  const ticks = spec.ticks ?? [];
  return {
    header,
    coverage: computeCoverage({
      wallClockUs: header.durationUs,
      rows,
      ticks,
      truncation: header.truncation,
      ticksDropped: spec.ticksDropped ?? 0,
      eventsDropped: spec.eventsDropped ?? 0,
      serverRowsDropped: spec.serverRowsDropped ?? 0,
      serverRowsDiscarded: spec.serverRowsDiscarded ?? 0,
      connections: header.connections,
    }),
    rows,
    ticks,
    ticksDropped: spec.ticksDropped ?? 0,
    readings: spec.readings ?? [],
    readingsDropped: 0,
    events: spec.events ?? [],
    eventsDropped: spec.eventsDropped ?? 0,
    serverRows: spec.serverRows ?? [],
    datasetOpens: spec.datasetOpens ?? [],
    datasetOpensDropped: 0,
    serverRowsDropped: spec.serverRowsDropped ?? 0,
    serverRowsDiscarded: spec.serverRowsDiscarded ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The five runs
// ---------------------------------------------------------------------------

/**
 * #893's headline healthy run: a 368 ms local cold open, everything fast,
 * settled by quiescence.
 *
 * The regression fixture for the share threshold. A relative rule with no
 * absolute floor reports `STALL fetch.wire, 70% of the run` here, because a
 * fast run still spends most of itself somewhere.
 */
export function healthyLocalOpen(): TraceRun {
  const rows: TraceRow[] = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push(
      makeRow(
        {
          startUs: 40 * MS + i * 200,
          durations: {
            plan: 400,
            queue: 2 * MS,
            // One member's chunk answers slowly and the open finishes on it.
            // Its wire is 77% of the chain and still under the absolute floor,
            // which is the whole point of this fixture.
            wire: i === 119 ? 240 * MS : 18 * MS,
            decode: 900,
            upload: 1_200,
            present: 2 * MS,
          },
          rid: i,
        },
        i,
      ),
    );
  }
  return makeRun({
    header: { runId: "local-healthy", durationUs: 330 * MS },
    rows,
    readings: Array.from({ length: 12 }, (_, i) =>
      makeReading(30 * MS + i * 25 * MS, { queueDepth: 3, inFlight: 6, frameTimeUs: 3_500 }),
    ),
    datasetOpens: [{ requestId: "open-1", startUs: 5 * MS, endUs: 38 * MS }],
    serverRows: [makeMetadataRow("open-1", 1 * MS, 4 * MS, "cache-hit")],
  });
}

/**
 * A cold remote open: 4.1 s, of which the metadata reads before the first
 * chunk are the overwhelming majority. #893 measured those reads at 91% of the
 * headline run, and a timeline that draws silence over them is the defect to
 * avoid.
 */
export function coldRemoteOpen(): TraceRun {
  const openEndUs = 3_700 * MS;
  const rows: TraceRow[] = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(
      makeRow(
        {
          startUs: openEndUs + i * 400,
          durations: {
            plan: 600,
            queue: 12 * MS,
            wire: 120 * MS,
            decode: 1_500,
            upload: 2_000,
            present: 3 * MS,
          },
          rid: i,
        },
        i,
      ),
    );
  }
  const serverRows: TraceServerRow[] = [];
  for (let i = 0; i < 340; i += 1) {
    serverRows.push(makeMetadataRow("open-1", 20 * MS + i * 10 * MS, 96 * MS, "backend-read"));
  }
  for (let i = 0; i < 60; i += 1) {
    serverRows.push(
      makeServerRow({
        rid: i,
        phases: {
          arrival: 120,
          "binding-lookup": 300,
          dispatch: 90,
          "cache-lookup": 400,
          "permit-wait": 30 * MS,
          "backend-read": 78 * MS,
          decompress: 900,
          "slice-encode": 1_100,
          handoff: 60,
        } satisfies ServerPhaseDurations,
      }),
    );
  }
  return makeRun({
    header: { runId: "remote-cold", durationUs: 4_120 * MS },
    rows,
    readings: Array.from({ length: 40 }, (_, i) =>
      makeReading(100 * MS + i * 100 * MS, { queueDepth: 20, inFlight: 12 }),
    ),
    datasetOpens: [{ requestId: "open-1", startUs: 8 * MS, endUs: openEndUs }],
    serverRows,
  });
}

/**
 * A warm re-open that never settles: thousands of requests admitted behind a
 * concurrency cap that stays pinned, closed by timeout with no completion
 * event to walk a path back from. The run the backlog rule exists for.
 */
export function saturatedReopen(): TraceRun {
  const rows: TraceRow[] = [];
  for (let i = 0; i < 400; i += 1) {
    const dispatched = i < 260;
    rows.push(
      makeRow(
        {
          // Admissions keep completing right through the run, which is what
          // makes a drain rate measurable at all: a saturated pipeline is busy,
          // not stopped.
          startUs: 50 * MS + i * 27 * MS,
          durations: dispatched
            ? { plan: 300, queue: 4_600 * MS, wire: 40 * MS }
            : { plan: 300 },
          rid: i,
          outcome: dispatched ? "complete" : "in-flight",
        },
        i,
      ),
    );
  }
  return makeRun({
    header: {
      runId: "warm-saturated",
      durationUs: 12_000 * MS,
      endReason: "timeout",
      cause: { epoch: "view", dirtyKind: "residency", source: "camera_moved" },
      outstandingAtSettle: {
        pending: 20_620,
        inFlight: 24,
        speculativePending: 1_200,
        speculativeInFlight: 0,
        desiredDetailChunks: 22_000,
        residentDetailChunks: 1_380,
        desiredCoarseChunks: 0,
        residentCoarseChunks: 0,
      },
    },
    rows,
    readings: Array.from({ length: 60 }, (_, i) =>
      makeReading(200 * MS + i * 195 * MS, {
        queueDepth: 20_620,
        inFlight: 24,
        frameTimeUs: 9_000,
      }),
    ),
  });
}

/**
 * An interaction run: a pan, closed by quiescence, with no dataset open and no
 * row that reaches a frame. There is no completion event to walk back from, so
 * the non-path attribution mode is the only thing that can say anything.
 */
export function interactionRun(): TraceRun {
  const rows: TraceRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push(
      makeRow(
        {
          startUs: 20 * MS + i * 15 * MS,
          durations: { plan: 200, queue: 8 * MS, wire: 25 * MS, decode: 800, upload: 1_000 },
          rid: i,
          outcome: "in-flight",
        },
        i,
      ),
    );
  }
  return makeRun({
    header: {
      runId: "interaction-pan",
      durationUs: 2_000 * MS,
      cause: { epoch: "view", dirtyKind: "interactive", source: "pan" },
    },
    rows,
    // One reading per frame, each frame most of its own interval: the shape a
    // main thread held by a per-tick phase makes.
    readings: Array.from({ length: 100 }, (_, i) =>
      makeReading(i * 20 * MS, { queueDepth: 4, inFlight: 4, frameTimeUs: 18_000 }),
    ),
  });
}

/**
 * A quiet run: no completion event, no backlog, no ceiling crossed and no
 * phase holding the main thread. The honest answer is that there is nothing to
 * attribute, and the derivation has to be willing to say so.
 */
export function quietRun(): TraceRun {
  const rows = Array.from({ length: 5 }, (_, i) =>
    makeRow(
      { startUs: 100 * MS + i * 50 * MS, durations: { plan: 200, queue: 3 * MS, wire: 20 * MS } },
      i,
    ),
  );
  return makeRun({
    header: { runId: "quiet", durationUs: 1_500 * MS },
    rows,
    readings: Array.from({ length: 8 }, (_, i) =>
      makeReading(i * 200 * MS, { queueDepth: 0, inFlight: 2, frameTimeUs: 2_000 }),
    ),
  });
}

/**
 * A 2 s open whose first half is healthy and whose second half stalls: sixty
 * fast rows, then forty whose decode runs eight times over its ceiling. The
 * whole run reads as a decode stall; a window over the first half reads as
 * clear. The fixture for the window scoping: the verdict has to move when the
 * window excludes the stall, and stay put when it does not.
 */
export function lateStallOpen(): TraceRun {
  const rows: TraceRow[] = [];
  const fast = { plan: 400, queue: 2 * MS, wire: 18 * MS, decode: 900, upload: 1_200, present: 2 * MS };
  for (let i = 0; i < 60; i += 1) {
    rows.push(makeRow({ startUs: 40 * MS + i * 10 * MS, durations: fast, rid: i }, i));
  }
  for (let i = 0; i < 40; i += 1) {
    rows.push(
      makeRow(
        {
          startUs: 1_100 * MS + i * 10 * MS,
          durations: { ...fast, decode: 400 * MS },
          rid: 60 + i,
        },
        60 + i,
      ),
    );
  }
  return makeRun({
    header: { runId: "late-stall", durationUs: 2_000 * MS },
    rows,
    // In-flight varies, so the one limiter is neither pinned nor backlogged
    // and the windowed findings are the rows' alone.
    readings: Array.from({ length: 20 }, (_, i) =>
      makeReading(i * 100 * MS, { queueDepth: 0, inFlight: (i % 3) + 1, frameTimeUs: 3_000 }),
    ),
    datasetOpens: [{ requestId: "open-1", startUs: 5 * MS, endUs: 35 * MS }],
    serverRows: [makeMetadataRow("open-1", 1 * MS, 4 * MS, "cache-hit")],
  });
}

/**
 * The coverage regression fixture: a 3 s run whose first 2.6 s are before any
 * instrument existed. #893's critical path started at the first recorded row
 * and reported `100% accounted` for exactly this shape.
 */
export function uninstrumentedPrefixOpen(): TraceRun {
  const prefixUs = 2_600 * MS;
  const rows: TraceRow[] = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push(
      makeRow(
        {
          startUs: prefixUs + i * 500,
          durations: {
            plan: 300,
            queue: 3 * MS,
            wire: 40 * MS,
            decode: 900,
            upload: 1_100,
            present: 2 * MS,
          },
          rid: i,
        },
        i,
      ),
    );
  }
  return makeRun({
    header: { runId: "prefix-heavy", durationUs: 3_000 * MS },
    rows,
    readings: [makeReading(2_700 * MS, { queueDepth: 2, inFlight: 4 })],
  });
}

// ---------------------------------------------------------------------------
// Render timing and the adapter
// ---------------------------------------------------------------------------

/**
 * The healthy open again, on an adapter that offers timestamp queries. Every
 * reading after the first carries the GPU pass time of the frame before it:
 * the read-back is asynchronous, so the first tick has nothing to report yet.
 * One frame is slower than the rest so the percentiles are not all one number.
 */
export function gpuTimedOpen(): TraceRun {
  const base = healthyLocalOpen();
  return makeRun({
    header: {
      runId: "local-gpu-timed",
      durationUs: base.header.durationUs,
      gpu: { ...base.header.gpu!, timestampQueries: true },
    },
    rows: base.rows,
    readings: base.readings.map((reading, i) =>
      i === 0 ? reading : { ...reading, gpuPassUs: i === 7 ? 2_400 : 1_100 + i * 20 },
    ),
    datasetOpens: base.datasetOpens,
    serverRows: base.serverRows,
  });
}

/**
 * The same open on an adapter without timestamp queries. No reading carries a
 * GPU pass time, and the document has to say the render time it does have is
 * main-thread time rather than let it pass for the GPU's.
 */
export function mainThreadOnlyOpen(): TraceRun {
  const base = healthyLocalOpen();
  return makeRun({
    header: { runId: "local-main-thread-only", durationUs: base.header.durationUs },
    rows: base.rows,
    readings: base.readings,
    datasetOpens: base.datasetOpens,
    serverRows: base.serverRows,
  });
}

/**
 * A run on a software fallback adapter: the machine has no usable hardware
 * adapter, frames are slow, and nothing about the shader is to blame. The
 * header is the only place a reader can learn that, so it is the fixture's
 * whole point.
 */
export function fallbackAdapterOpen(): TraceRun {
  const base = healthyLocalOpen();
  return makeRun({
    header: {
      runId: "local-fallback-adapter",
      durationUs: base.header.durationUs,
      gpu: {
        vendor: "generic",
        architecture: "software",
        device: "",
        description: "software rasterizer",
        fallback: true,
        timestampQueries: false,
      },
    },
    rows: base.rows,
    readings: base.readings.map((reading) => ({ ...reading, frameTimeUs: 42_000 })),
    datasetOpens: base.datasetOpens,
    serverRows: base.serverRows,
  });
}
