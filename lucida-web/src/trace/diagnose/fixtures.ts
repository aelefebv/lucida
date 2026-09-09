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
import { SEND_COLUMN_COUNT, sendTalliesFrom } from "../sendAccounting.ts";
import {
  CLIENT_MESSAGE_TYPES,
  interactionCause,
  PHASES,
  type CountedPhase,
  type InputKind,
  type LaneName,
  type MetadataReadPhase,
  type Phase,
  type RunHeader,
  type SendTallies,
  type ServerPhaseDurations,
  type TraceDocument,
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
  /** The bytes the wire delivered. Zero by default, as for a row whose wire never closed. */
  bytes?: number;
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
    bytes: spec.bytes ?? 0,
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

/**
 * Readings every `stepUs` from `fromUs` to `toUs` inclusive, each shaped by
 * `make` from its index and its time. The tick stream a window of a run
 * holds, for the provisional reading and the surfaces that show it.
 */
export function makeReadingSeries(
  fromUs: number,
  toUs: number,
  stepUs: number,
  make: (index: number, atUs: number) => Partial<TraceReading> = () => ({}),
): TraceReading[] {
  const out: TraceReading[] = [];
  for (let atUs = fromUs, index = 0; atUs <= toUs; atUs += stepUs, index += 1) {
    out.push(makeReading(atUs, make(index, atUs)));
  }
  return out;
}

/** Every client message type at zero: the send tallies of an interval that sent nothing. */
export function emptySendTallies(): SendTallies {
  return sendTalliesFrom(new Uint32Array(SEND_COLUMN_COUNT));
}

export function makeTick(
  atUs: number,
  counted: Partial<Record<CountedPhase, number>> = {},
  sent: Partial<SendTallies> = {},
): TraceTick {
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
    sent: { ...emptySendTallies(), ...sent },
    levels: [],
    levelsDropped: 0,
    targetLevel: null,
    levelPinned: false,
    displayedLevel: null,
    availabilityWoken: false,
  };
}

/**
 * The default run total: what the ticks carry. Only a default, because the
 * recorder counts at send time and a real total can exceed the samples. A
 * fixture that models that passes its own `sent`.
 */
function sumSent(ticks: TraceTick[]): SendTallies {
  const total = emptySendTallies();
  for (const tick of ticks) {
    for (const type of CLIENT_MESSAGE_TYPES) {
      total[type].messages += tick.sent[type].messages;
      total[type].bytes += tick.sent[type].bytes;
    }
  }
  return total;
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
      detailBytes: 0,
      detailBudgetBytes: 0,
      coarseBytes: 0,
      coarseBudgetBytes: 0,
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
  /** The interval's send totals. Defaults to what the ticks carry. */
  sent?: SendTallies;
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
    sent: spec.sent ?? sumSent(ticks),
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
        detailBytes: 0,
        detailBudgetBytes: 0,
        coarseBytes: 0,
        coarseBudgetBytes: 0,
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
  return interactionRunFor("pan");
}

export interface InteractionRunSpec {
  /**
   * Main-thread time of each tick. The default holds the main thread most of
   * every frame and still clears the frame-time ceiling. A value over the
   * ceiling makes the run that ceiling exists for.
   */
  frameTimeUs?: number;
}

/**
 * An interaction run under one of the five inputs, with the cause the recorder
 * gives it. One reading per frame, each frame most of its own interval: the
 * shape a gesture makes on the main thread.
 */
export function interactionRunFor(input: InputKind, spec: InteractionRunSpec = {}): TraceRun {
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
      runId: `interaction-${input}`,
      durationUs: 2_000 * MS,
      cause: interactionCause(input),
    },
    rows,
    readings: Array.from({ length: 100 }, (_, i) =>
      makeReading(i * 20 * MS, {
        queueDepth: 4,
        inFlight: 4,
        frameTimeUs: spec.frameTimeUs ?? 18_000,
      }),
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
 * The field report's run: the view looks loaded, and the socket does not go
 * quiet. A pan settles inside the first 100 ms, nothing re-plans afterwards,
 * and for the rest of ten seconds the client keeps sending: cursor positions,
 * presence, viewer interest. The person stops the run to read it.
 *
 * The regression fixture for send-side accounting. Only two planning passes
 * exist, so the samples carry the chunk requests and one viewer-interest
 * message and nothing of the idle stretch. The run's totals carry all of it,
 * which is why the recorder counts totals at send time rather than summing
 * the samples. The per-type totals here are what the text and the JSON have
 * to agree on. The idle stretch is modelled inside a run rather than as a
 * steady-state interval because a steady-state interval has no reading of
 * its own: the run is the unit the text and the JSON are derived for.
 */
export function sendHeavyIdleRun(): TraceRun {
  const rows = Array.from({ length: 12 }, (_, i) =>
    makeRow(
      {
        startUs: 20 * MS + i * 2 * MS,
        durations: { plan: 200, queue: 2 * MS, wire: 30 * MS, decode: 800, upload: 1_000, present: 2 * MS },
        rid: i,
      },
      i,
    ),
  );
  const ticks = [
    makeTick(20 * MS, {}, { chunkRequest: { messages: 12, bytes: 1_176 } }),
    makeTick(60 * MS, {}, { viewerInterest: { messages: 1, bytes: 120 } }),
  ];
  const sent: SendTallies = {
    ...emptySendTallies(),
    chunkRequest: { messages: 12, bytes: 1_176 },
    viewerInterest: { messages: 10, bytes: 1_200 },
    presence: { messages: 40, bytes: 12_000 },
    cursor: { messages: 400, bytes: 16_000 },
  };
  return makeRun({
    header: {
      runId: "send-heavy-idle",
      durationUs: 10_000 * MS,
      endReason: "explicit",
      cause: { epoch: "view", dirtyKind: "interactive", source: "pan" },
    },
    rows,
    ticks,
    sent,
    readings: Array.from({ length: 4 }, (_, i) =>
      makeReading(i * 25 * MS, { queueDepth: 0, inFlight: 2, frameTimeUs: 3_000 }),
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

// ---------------------------------------------------------------------------
// The steady state
// ---------------------------------------------------------------------------

export interface SteadySpec extends RunSpec {
  /** How long the interval lasted, in milliseconds. */
  spanMs: number;
}

/**
 * The steady-state interval that opened when `run` closed: no cause, a clock
 * of its own that starts at the run's close, and the export as its end. The
 * rows, ticks, readings and sends are the caller's, so each fixture below
 * models one kind of traffic after settle and nothing else, and the quiet
 * one models the heartbeat alone.
 */
export function steadyStateAfter(run: TraceRun, spec: SteadySpec): TraceRun {
  const { spanMs, header, ...rest } = spec;
  return makeRun({
    ...rest,
    header: {
      runId: `steady-after-${run.header.runId}`,
      cause: null,
      endReason: "explicit",
      durationUs: spanMs * MS,
      startedAtEpochMs: run.header.startedAtEpochMs + Math.round(run.header.durationUs / MS),
      ...header,
    },
  });
}

/** A fetch after settle: bytes in hand at `endUs`, then decoded, uploaded and drawn. */
function fetchedRow(
  index: number,
  endUs: number,
  lane: LaneName,
  bytes: number,
  chunkKey?: string,
): TraceRow {
  return makeRow(
    {
      startUs: endUs - 30 * MS,
      durations: { queue: 2 * MS, wire: 28 * MS, decode: MS, upload: MS, present: MS },
      lane,
      bytes,
      chunkKey,
      rid: index,
    },
    index,
  );
}

/**
 * Nothing after settle worth a finding: two prefetch chunks in the first
 * second, presence once a second, one planning pass. The interval every
 * steady-state rule has to stay quiet on.
 */
export function quietSteadyState(run: TraceRun): TraceRun {
  return steadyStateAfter(run, {
    spanMs: 10_000,
    rows: [0, 1].map((i) => fetchedRow(i, 400 * MS + i * 200 * MS, "prefetch", 64 * 1024)),
    ticks: [makeTick(50 * MS)],
    readings: Array.from({ length: 5 }, (_, i) =>
      makeReading(i * 2_000 * MS, { queueDepth: 0, inFlight: 0, frameTimeUs: 2_000 }),
    ),
    sent: { ...emptySendTallies(), presence: { messages: 10, bytes: 3_000 } },
  });
}

/**
 * The field report's reading half: the view settled and the prefetch lane
 * kept fetching, eight chunks a second for twelve seconds, beside two
 * detail chunks that arrived just after settle. Every second is busy, so
 * the received rule fires and names prefetch.
 */
export function prefetchSteadyState(run: TraceRun): TraceRun {
  const rows: TraceRow[] = [];
  for (let second = 0; second < 12; second += 1) {
    for (let i = 0; i < 8; i += 1) {
      const index = second * 8 + i;
      rows.push(fetchedRow(index, second * 1_000 * MS + 100 * MS + i * 100 * MS, "prefetch", 40 * 1024));
    }
  }
  rows.push(fetchedRow(96, 500 * MS, "detail", 40 * 1024));
  rows.push(fetchedRow(97, 600 * MS, "detail", 40 * 1024));
  return steadyStateAfter(run, {
    spanMs: 12_000,
    rows,
    ticks: [makeTick(20 * MS)],
    readings: Array.from({ length: 12 }, (_, i) =>
      makeReading(i * 1_000 * MS, { queueDepth: 8, inFlight: 4, frameTimeUs: 3_000 }),
    ),
  });
}

/**
 * A refetch loop: a dozen chunks of one entity fetched three times each in
 * three passes, two kilobytes a fetch. Small on purpose, so the bytes alone
 * are no finding and the churn is what the ruleset has to see.
 */
export function refetchLoopSteadyState(run: TraceRun): TraceRun {
  const rows: TraceRow[] = [];
  for (let pass = 0; pass < 3; pass += 1) {
    for (let chunk = 0; chunk < 12; chunk += 1) {
      const index = pass * 12 + chunk;
      rows.push({
        ...fetchedRow(index, 500 * MS + pass * 2_500 * MS + chunk * 50 * MS, "detail", 2 * 1024, `1/0/0/0/${chunk}/0`),
        entityId: "member-1",
      });
    }
  }
  return steadyStateAfter(run, {
    spanMs: 8_000,
    rows,
    ticks: [makeTick(20 * MS)],
    readings: Array.from({ length: 8 }, (_, i) =>
      makeReading(i * 1_000 * MS, { queueDepth: 0, inFlight: 2, frameTimeUs: 3_000 }),
    ),
  });
}

/**
 * The generated-coarse availability loop: ten planning passes in six seconds
 * with no input between them, eight of which nothing but an availability
 * update woke.
 */
export function availabilityLoopSteadyState(run: TraceRun): TraceRun {
  return steadyStateAfter(run, {
    spanMs: 6_000,
    ticks: Array.from({ length: 10 }, (_, i) => ({
      ...makeTick(200 * MS + i * 500 * MS),
      availabilityWoken: i >= 2,
    })),
    readings: Array.from({ length: 6 }, (_, i) =>
      makeReading(i * 1_000 * MS, { queueDepth: 0, inFlight: 0, frameTimeUs: 2_000 }),
    ),
  });
}

/**
 * The field report's writing half after settle: cursor positions, presence
 * and viewer interest for ten seconds with one planning pass. The interval's
 * totals carry the sends, as the recorder's do; the one sample carries
 * almost none of them.
 */
export function sendHeavySteadyState(run: TraceRun): TraceRun {
  return steadyStateAfter(run, {
    spanMs: 10_000,
    ticks: [makeTick(20 * MS, {}, { viewerInterest: { messages: 1, bytes: 120 } })],
    readings: Array.from({ length: 4 }, (_, i) =>
      makeReading(i * 2_500 * MS, { queueDepth: 0, inFlight: 0, frameTimeUs: 2_000 }),
    ),
    sent: {
      ...emptySendTallies(),
      viewerInterest: { messages: 10, bytes: 1_200 },
      presence: { messages: 40, bytes: 12_000 },
      cursor: { messages: 400, bytes: 16_000 },
    },
  });
}

/**
 * A run that can never settle: the coarse tier holds 60 MiB of a 64 MiB
 * budget, wants 1,240 chunks and holds 800 of them, and has nothing queued
 * or in flight, so the run times out. The budget-bound rule exists to name
 * this as a coverage loss rather than as the timeout it causes.
 */
export function budgetBoundCoarseRun(): TraceRun {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    ...makeRow(
      {
        startUs: 50 * MS + i * 20 * MS,
        durations: { plan: 300, queue: 2 * MS, wire: 30 * MS, decode: MS, upload: MS, present: 2 * MS },
        rid: i,
        lane: "coarse",
        bytes: 80 * 1024,
      },
      i,
    ),
    residencyTier: "coarse" as const,
  }));
  return makeRun({
    header: {
      runId: "coarse-budget-bound",
      durationUs: 20_000 * MS,
      endReason: "timeout",
      outstandingAtSettle: {
        pending: 0,
        inFlight: 0,
        speculativePending: 0,
        speculativeInFlight: 0,
        desiredDetailChunks: 0,
        residentDetailChunks: 0,
        desiredCoarseChunks: 1_240,
        residentCoarseChunks: 800,
        detailBytes: 0,
        detailBudgetBytes: 512 * 1024 * 1024,
        coarseBytes: 60 * 1024 * 1024,
        coarseBudgetBytes: 64 * 1024 * 1024,
      },
    },
    rows,
    // In-flight varies, so the one limiter is neither pinned nor backlogged.
    readings: Array.from({ length: 20 }, (_, i) =>
      makeReading(i * 1_000 * MS, { queueDepth: 0, inFlight: (i % 3) + 1, frameTimeUs: 3_000 }),
    ),
  });
}

/**
 * A trace document holding labelled runs and the unlabelled intervals between
 * them, as the recorder's export splits them. The retention block and the
 * phase inventories are the shape the recorder writes, so a reader that walks
 * them finds what it expects.
 */
export function makeDocument(runs: TraceRun[], steadyState: TraceRun[] = []): TraceDocument {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    exportedAtEpochMs: 1_700_000_100_000,
    retention: {
      residentCapBytes: 8_000_000,
      perRunCapBytes: 2_000_000,
      residentBytes: 100_000,
      intervalsEvicted: 0,
      derivedFrom: "384-member collection",
      capUnit: "bytes",
    },
    instrumentedPhases: [...PHASES],
    countedPhases: ["cache-admission", "worker-dispatch", "coalesce-attach"],
    runs,
    steadyState,
    rowsOutsideRun: 0,
    serverRowsOutsideRun: 0,
  };
}
