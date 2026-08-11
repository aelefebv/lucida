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
    gpu: {
      vendor: "apple",
      architecture: "metal-3",
      device: "",
      description: "",
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
