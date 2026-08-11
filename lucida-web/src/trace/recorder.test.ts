import { describe, it, expect, vi } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import { noopSinkFactory } from "./sink.ts";
import { createQuiescenceState, evaluateQuiescence, type QuiescenceState } from "./quiescence.ts";
import {
  Boundary,
  LABEL_NONE,
  PHASE_UNSET,
  RowOutcome,
  TRACE_SCHEMA_VERSION,
} from "./types.ts";

const OPEN_CAUSE = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" } as const;

const CHUNK = {
  datasetId: "ds",
  entityId: "member-1",
  imageId: "image-1",
  lane: "detail" as const,
  level: 1,
  t: 0,
  c: 0,
  z: 0,
  y: 2,
  x: 3,
};

function inputs(overrides: Partial<QuiescenceState> = {}): QuiescenceState {
  return Object.assign(createQuiescenceState(), overrides);
}

function makeRecorder(overrides: Partial<ConstructorParameters<typeof TraceRecorder>[0]> = {}) {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 5_000,
    ...overrides,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 4, detailBytes: 40, coarseChunks: 1, coarseBytes: 10, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1?render=1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
      speculativePending: 7,
      speculativeInFlight: 1,
      desiredDetailChunks: 12,
      residentDetailChunks: 12,
      desiredCoarseChunks: 3,
      residentCoarseChunks: 3,
    }),
  });
  return { recorder, advance: (ms: number) => { clock += ms; } };
}

describe("TraceRecorder run lifecycle", () => {
  it("keeps work seen before the first run as an unlabelled steady-state interval", () => {
    const { recorder } = makeRecorder();
    expect(recorder.beginChunkRow(CHUNK, 0)).toBeGreaterThanOrEqual(0);

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(0);
    expect(doc.steadyState).toHaveLength(1);
    expect(doc.steadyState[0].header.cause).toBeNull();
    expect(doc.steadyState[0].rows).toHaveLength(1);
    expect(doc.rowsOutsideRun).toBe(0);
  });

  it("counts, without keeping, what it saw with no page to say what conditions applied", () => {
    const { recorder } = makeRecorder();
    recorder.setEnvironment(null);
    expect(recorder.beginChunkRow(CHUNK, 0)).toBe(-1);

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(0);
    expect(doc.steadyState).toHaveLength(0);
    expect(doc.rowsOutsideRun).toBe(1);
  });

  it("hands the steady state before a run over as its own interval", () => {
    const { recorder, advance } = makeRecorder();
    recorder.beginChunkRow(CHUNK, 0);
    advance(200);
    recorder.openRun(OPEN_CAUSE);
    recorder.beginChunkRow(CHUNK, 0);
    recorder.closeRun("explicit");

    const doc = recorder.exportDocument();
    expect(doc.steadyState.map(interval => interval.header.endReason)).toEqual(["run-opened"]);
    expect(doc.runs).toHaveLength(1);
    expect(doc.runs[0].rows).toHaveLength(1);
  });

  it("discards an unlabelled interval that recorded nothing", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.closeRun("explicit");

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(1);
    expect(doc.steadyState).toEqual([]);
  });

  it("does not open a run before the page can say what conditions it ran under", () => {
    const { recorder } = makeRecorder();
    recorder.setEnvironment(null);
    recorder.openRun(OPEN_CAUSE);

    expect(recorder.isRunOpen).toBe(false);
    expect(recorder.exportDocument().runs).toHaveLength(0);
  });

  it("opens on a dataset-open cause and keeps one run open across repeats", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.openRun({ ...OPEN_CAUSE, source: "dataset_added_again" });
    recorder.closeRun("explicit");

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(1);
    expect(doc.runs[0].header.cause).toEqual(OPEN_CAUSE);
  });

  it("closes on quiescence only after the hold window elapses", () => {
    vi.useFakeTimers();
    try {
      const { recorder } = makeRecorder();
      recorder.openRun(OPEN_CAUSE);
      recorder.noteQuiescence(evaluateQuiescence(inputs(), 1_000));

      vi.advanceTimersByTime(499);
      expect(recorder.exportDocument().runs[0].header.endReason).not.toBe("quiescent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes with `quiescent` when the hold window completes", () => {
    vi.useFakeTimers();
    try {
      const { recorder } = makeRecorder();
      recorder.openRun(OPEN_CAUSE);
      recorder.noteQuiescence(evaluateQuiescence(inputs(), 1_000));
      vi.advanceTimersByTime(500);

      const [run] = recorder.exportDocument().runs;
      expect(run.header.endReason).toBe("quiescent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the hold window when the page stops being quiescent", () => {
    vi.useFakeTimers();
    try {
      const { recorder } = makeRecorder();
      recorder.openRun(OPEN_CAUSE);
      recorder.noteQuiescence(evaluateQuiescence(inputs(), 1_000));
      vi.advanceTimersByTime(400);
      recorder.noteQuiescence(evaluateQuiescence(inputs({ inFlight: 3 }), 1_400));
      vi.advanceTimersByTime(400);

      expect(recorder.exportDocument().runs[0].header.endReason).toBe("explicit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a run that never settles, with `timeout` as its end reason", () => {
    vi.useFakeTimers();
    try {
      const { recorder } = makeRecorder();
      recorder.openRun(OPEN_CAUSE);
      vi.advanceTimersByTime(5_000);

      const [run] = recorder.exportDocument().runs;
      expect(run.header.endReason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an export as an explicit close, so end reason is never absent", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    const [run] = recorder.exportDocument().runs;
    expect(run.header.endReason).toBe("explicit");
  });
});

describe("TraceRecorder run header", () => {
  it("carries the conditions that make two runs comparable", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    advance(250);
    recorder.setGpu({ vendor: "v", architecture: "a", device: "d", description: "desc" });
    recorder.closeRun("explicit");

    const { header } = recorder.exportDocument().runs[0];
    expect(header.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
    expect(header.datasetIds).toEqual(["ds"]);
    expect(header.composedView).toEqual({ url: "/w/ws-1?render=1", mode: "slice" });
    expect(header.devicePixelRatio).toBe(2);
    expect(header.viewport.deviceWidth).toBe(1600);
    expect(header.cacheWarmth.detailChunks).toBe(4);
    expect(header.build.version).toBeTypeOf("string");
    expect(header.gpu).toEqual({ vendor: "v", architecture: "a", device: "d", description: "desc" });
    expect(header.quiescenceHoldMs).toBe(500);
    expect(header.durationUs).toBe(250_000);
  });

  it("reports what was still outstanding at settle rather than hiding it", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.closeRun("explicit");

    const { outstandingAtSettle } = recorder.exportDocument().runs[0].header;
    expect(outstandingAtSettle.speculativePending).toBe(7);
    expect(outstandingAtSettle.speculativeInFlight).toBe(1);
  });
});

describe("TraceRecorder rows", () => {
  it("stamps microsecond offsets from run start", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    advance(10);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(row, Boundary.WireStart);
    advance(40);
    recorder.stamp(row, Boundary.DecodeStart);
    recorder.finishRow(row, RowOutcome.Complete);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.wire).toEqual({ startUs: 10_000, endUs: 50_000, durationUs: 40_000 });
    expect(serialised.outcome).toBe("complete");
    expect(serialised.chunkKey).toBe("1/0/0/0/2/3");
  });

  it("ignores stamps for a row whose run has already closed", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.closeRun("explicit");
    recorder.openRun({ ...OPEN_CAUSE, source: "second" });
    const fresh = recorder.beginChunkRow(CHUNK, 1);
    recorder.stamp(row, Boundary.WireStart);
    recorder.stamp(fresh, Boundary.WireStart);
    recorder.closeRun("explicit");

    const doc = recorder.exportDocument();
    expect(doc.runs[0].rows[0].phases.wire).toBeUndefined();
    expect(doc.runs[1].rows[0].residencyTier).toBe("coarse");
  });

  it("declares which phases it actually measured", () => {
    const { recorder } = makeRecorder();
    expect(recorder.exportDocument().instrumentedPhases)
      .toEqual(["plan", "queue", "wire", "decode", "upload", "present"]);
  });
});

describe("TraceRecorder plan and queue", () => {
  it("dates plan from the pass that enqueued the request and queue from its admission", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    // A plan pass: wanted-set computation, then the enqueue that ends it.
    recorder.markPlanStart();          // t = 1_000
    advance(20);
    recorder.notePlanEnqueue(1_020);   // admitted here
    advance(80);                       // queued for 80 ms
    const row = recorder.beginChunkRow(CHUNK, 0, 1_020);
    expect(row).toBeGreaterThanOrEqual(0);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.plan).toEqual({ startUs: 0, endUs: 20_000, durationUs: 20_000 });
    expect(serialised.phases.queue)
      .toEqual({ startUs: 20_000, endUs: 100_000, durationUs: 80_000 });
  });

  it("births a row at dispatch with the two phases behind it already stamped", () => {
    // The whole of #949: a row is born at dispatch, so the one call that
    // makes it also closes `plan`, brackets `queue` and opens `wire`. Three
    // recorder calls per chunk was three times the event count ADR 0049's
    // tick ceiling was derived from, and two of them were handle round-trips
    // — a `resolve`, a generation divide and a modulo — buying nothing.
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.markPlanStart();          // t = 1_000
    advance(20);
    recorder.notePlanEnqueue(1_020);
    advance(80);

    const row = recorder.beginChunkRow(CHUNK, 0, 1_020);
    advance(35);
    recorder.stamp(row, Boundary.DecodeStart);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.plan).toEqual({ startUs: 0, endUs: 20_000, durationUs: 20_000 });
    expect(serialised.phases.queue)
      .toEqual({ startUs: 20_000, endUs: 100_000, durationUs: 80_000 });
    // Wire opens at the call, not at some later stamp: the boundary queue
    // ends on and the one wire starts on are the same clock read.
    expect(serialised.phases.wire)
      .toEqual({ startUs: 100_000, endUs: 135_000, durationUs: 35_000 });
  });

  it("attributes a row to the pass it was admitted in, not the newest one", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    recorder.markPlanStart();          // t = 1_000
    advance(10);
    recorder.notePlanEnqueue(1_010);   // the pass that admitted our row
    advance(90);
    recorder.markPlanStart();          // a later replan, t = 1_100
    advance(5);
    recorder.notePlanEnqueue(1_105);
    advance(20);

    const row = recorder.beginChunkRow(CHUNK, 0, 1_010);
    expect(row).toBeGreaterThanOrEqual(0);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.plan!.startUs).toBe(0);
    expect(serialised.phases.plan!.endUs).toBe(10_000);
  });

  it("leaves plan unset rather than inventing one when no pass is on record", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    advance(30);
    const row = recorder.beginChunkRow(CHUNK, 0, 1_030);
    expect(row).toBeGreaterThanOrEqual(0);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.plan).toBeUndefined();
    expect(serialised.phases.queue).toEqual({ startUs: 30_000, endUs: 30_000, durationUs: 0 });
  });

  it("falls back to the last enqueue for a row admitted straight off the backlog", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.markPlanStart();
    advance(10);
    recorder.notePlanEnqueue(1_010);
    advance(200);

    // No admission stamp: ADR 0044 keeps them for the admission window only.
    const row = recorder.beginChunkRow(CHUNK, 0, undefined);
    expect(row).toBeGreaterThanOrEqual(0);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.queue)
      .toEqual({ startUs: 10_000, endUs: 210_000, durationUs: 200_000 });
  });
});

describe("TraceRecorder upload and present", () => {
  it("closes upload at the frame that follows the handoff and present at the next one", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(row, Boundary.UploadStart);   // decode ended at t = 0

    advance(12);
    recorder.noteHandedToRenderer(row);
    advance(4);
    recorder.noteFrameDispatched();              // resident at t = 16 ms
    advance(17);
    recorder.noteFrameDispatched();              // drawn by t = 33 ms
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.upload)
      .toEqual({ startUs: 0, endUs: 16_000, durationUs: 16_000 });
    expect(serialised.phases.present)
      .toEqual({ startUs: 16_000, endUs: 33_000, durationUs: 17_000 });
    expect(serialised.outcome).toBe("complete");
  });

  it("leaves a chunk that never reached a frame in flight rather than complete", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(row, Boundary.UploadStart);
    advance(5);
    recorder.noteHandedToRenderer(row);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.upload).toBeUndefined();
    expect(serialised.phases.present).toBeUndefined();
    expect(serialised.outcome).toBe("in-flight");
  });
});

describe("TraceRecorder server rows", () => {
  const BATCH = {
    dropped: 2,
    rid: [5],
    request_id: [null],
    metadata_phase: [null],
    dispatch_offset_us: [0],
    duration_us: [0],
    family: ["chunk" as const],
    outcome: ["delivered" as const],
    arrival_us: [100],
    binding_lookup_us: [PHASE_UNSET],
    dispatch_us: [PHASE_UNSET],
    cache_lookup_us: [PHASE_UNSET],
    permit_wait_us: [2_000],
    backend_read_us: [900],
    coalesced_wait_us: [PHASE_UNSET],
    decompress_us: [PHASE_UNSET],
    slice_encode_us: [PHASE_UNSET],
    handoff_us: [PHASE_UNSET],
    coalesced_onto: [LABEL_NONE],
  };

  it("places a server row inside the bracket the browser measured", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.labelRow(row, { rid: 5, connectionGeneration: 2 });
    recorder.stamp(row, Boundary.WireStart);
    advance(8);
    recorder.stamp(row, Boundary.DecodeStart);
    recorder.finishRow(row, RowOutcome.Complete);
    recorder.ingestServerBatch(BATCH, 2);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.rows[0].rid).toBe(5);
    expect(run.rows[0].connectionGeneration).toBe(2);
    expect(run.serverRows).toHaveLength(1);
    // 8 ms bracket, 3 ms of server: the rest is network and socket queue and
    // is named rather than folded into either side.
    expect(run.serverRows[0].placement?.gapUs).toBe(5_000);
    expect(run.serverRowsDropped).toBe(2);
  });

  it("keeps server rows that arrive between runs in the steady-state interval", () => {
    const { recorder } = makeRecorder();
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.labelRow(row, { rid: 5, connectionGeneration: 1 });
    recorder.ingestServerBatch(BATCH, 1);
    const doc = recorder.exportDocument();

    expect(doc.serverRowsOutsideRun).toBe(0);
    expect(doc.runs).toHaveLength(0);
    expect(doc.steadyState[0].serverRows).toHaveLength(1);
  });

  it("counts server rows that arrive with no interval to put them in", () => {
    const { recorder } = makeRecorder();
    recorder.setEnvironment(null);
    recorder.ingestServerBatch(BATCH, 1);
    const doc = recorder.exportDocument();

    expect(doc.serverRowsOutsideRun).toBe(1);
    expect(doc.steadyState).toHaveLength(0);
  });

  it("refuses a server row for a label this interval never minted", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.labelRow(row, { rid: 5, connectionGeneration: 2 });
    // Same rid, the connection before this one: a different request entirely.
    recorder.ingestServerBatch(BATCH, 1);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.serverRows).toHaveLength(0);
    expect(run.serverRowsDiscarded).toBe(1);
    expect(run.coverage.gaps.map(gap => gap.kind)).toContain("server-rows-discarded");
  });

  it("refuses a metadata row for an open this interval never bracketed", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.ingestServerBatch(
      { ...BATCH, family: ["metadata_read" as const], request_id: ["req-nobody-sent"] },
      1,
    );
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.serverRows).toHaveLength(0);
    expect(run.serverRowsDiscarded).toBe(1);
  });

  it("refuses an asset row, which this build gives no browser bracket at all", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    // Assets draw from the same label counter as chunks, so an asset's rid
    // lands inside the range this run's chunks minted — and nothing here can
    // place it even so. The family decides, not the arithmetic.
    recorder.labelRow(row, { rid: 5, connectionGeneration: 2 });
    recorder.ingestServerBatch({ ...BATCH, family: ["asset" as const] }, 2);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.serverRows).toHaveLength(0);
    expect(run.serverRowsDiscarded).toBe(1);
  });

  it("counts server rows that arrive after the run truncated into the unrecorded total", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.labelRow(row, { rid: 5, connectionGeneration: 2 });
    // Rows until the per-run cap bites, then one more batch.
    for (let i = 0; i < 40_000; i++) recorder.beginChunkRow(CHUNK, 0);
    recorder.ingestServerBatch(BATCH, 2);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.header.truncation).not.toBeNull();
    expect(run.header.truncation?.serverRowsUnrecorded).toBe(1);
    expect(run.serverRows).toHaveLength(0);
    // The truncation owns the count; it is not also charged as a refusal.
    expect(run.serverRowsDiscarded).toBe(0);
  });

  it("gives every coalesced row the same label, so the join is a group-by", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const label = { rid: 5, connectionGeneration: 2 };
    const first = recorder.beginChunkRow(CHUNK, 0);
    const second = recorder.beginChunkRow(CHUNK, 1);
    for (const row of [first, second]) {
      recorder.labelRow(row, label);
      recorder.stamp(row, Boundary.WireStart);
    }
    advance(8);
    for (const row of [first, second]) recorder.stamp(row, Boundary.DecodeStart);
    recorder.ingestServerBatch(BATCH, 2);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.rows.map(r => r.rid)).toEqual([5, 5]);
    expect(run.serverRows).toHaveLength(1);
    expect(run.serverRows[0].placement).not.toBeNull();
  });
});

describe("TraceRecorder connections", () => {
  it("records the connection the interval was recorded over", () => {
    const { recorder } = makeRecorder();
    recorder.noteConnected(3);
    recorder.openRun(OPEN_CAUSE);
    recorder.closeRun("explicit");

    const [record] = recorder.exportDocument().runs[0].header.connections;
    expect(record.generation).toBe(3);
    // It was already up when the run opened, and still up when it closed.
    expect(record.openedAtUs).toBeNull();
    expect(record.closedAtUs).toBeNull();
    expect(record.gapUs).toBeNull();
  });

  it("records every connection a run spanned, and how long the socket was gone", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteConnected(3);
    recorder.openRun(OPEN_CAUSE);
    advance(200);
    recorder.noteDisconnected();
    advance(2_000);
    recorder.noteConnected(4);
    advance(50);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.header.connections.map(record => record.generation)).toEqual([3, 4]);
    expect(run.header.connections[0].closedAtUs).toBe(200_000);
    expect(run.header.connections[1].openedAtUs).toBe(2_200_000);
    expect(run.header.connections[1].gapUs).toBe(2_000_000);

    const gap = run.coverage.gaps.find(candidate => candidate.kind === "connection-gap");
    expect(gap?.startUs).toBe(200_000);
    expect(gap?.endUs).toBe(2_200_000);
  });

  it("declares an outage that outlives the interval it started in", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteConnected(1);
    recorder.noteDisconnected();
    advance(3_000);
    // The run opens while the page is still without a socket.
    recorder.openRun(OPEN_CAUSE);
    advance(1_000);
    recorder.noteConnected(2);
    recorder.closeRun("explicit");

    const run = recorder.exportDocument().runs[0];
    expect(run.header.connections).toHaveLength(1);
    // The outage is four seconds long; only the last second is this run's.
    expect(run.header.connections[0].gapUs).toBe(4_000_000);
    const gap = run.coverage.gaps.find(candidate => candidate.kind === "connection-gap");
    expect(gap?.startUs).toBe(0);
    expect(gap?.durationUs).toBe(1_000_000);
  });

  it("declares a reconnect that happened between two runs, not only inside one", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteConnected(1);
    // Steady state is an interval like any other, and the pan before a stall
    // is often the thing that explains it.
    recorder.beginChunkRow(CHUNK, 0);
    advance(100);
    recorder.noteDisconnected();
    advance(1_500);
    recorder.noteConnected(2);

    const [steady] = recorder.exportDocument().steadyState;
    expect(steady.header.connections.map(record => record.generation)).toEqual([1, 2]);
    expect(steady.header.connections[1].gapUs).toBe(1_500_000);
    expect(steady.coverage.gaps.map(gap => gap.kind)).toContain("connection-gap");
  });

  it("ignores a repeat of the socket it is already on rather than eating the outage", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteConnected(1);
    recorder.openRun(OPEN_CAUSE);
    recorder.noteDisconnected();
    advance(2_000);
    // A duplicate report of the dead socket must not read as a reconnect.
    recorder.noteConnected(1);
    advance(500);
    recorder.noteConnected(2);
    recorder.closeRun("explicit");

    const { connections } = recorder.exportDocument().runs[0].header;
    expect(connections.map(record => record.generation)).toEqual([1, 2]);
    expect(connections[1].gapUs).toBe(2_500_000);
  });

  it("names the labels each connection carried, so a repeated rid is readable", () => {
    const { recorder } = makeRecorder();
    recorder.noteConnected(1);
    recorder.openRun(OPEN_CAUSE);
    const first = recorder.beginChunkRow(CHUNK, 0);
    recorder.labelRow(first, { rid: 0, connectionGeneration: 1 });
    recorder.noteDisconnected();
    recorder.noteConnected(2);
    const second = recorder.beginChunkRow(CHUNK, 0);
    recorder.labelRow(second, { rid: 0, connectionGeneration: 2 });
    recorder.closeRun("explicit");

    const { connections } = recorder.exportDocument().runs[0].header;
    expect(connections.map(record => [record.generation, record.firstRid, record.lastRid])).toEqual([
      [1, 0, 0],
      [2, 0, 0],
    ]);
  });
});

describe("TraceRecorder sink injection", () => {
  it("keeps no rows with a no-op sink while the call sites stay live", () => {
    const { recorder } = makeRecorder({ sinkFactory: noopSinkFactory });
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(row, Boundary.WireStart);
    recorder.finishRow(row, RowOutcome.Complete);
    recorder.closeRun("explicit");

    expect(row).toBeGreaterThanOrEqual(0);
    expect(recorder.exportDocument().runs[0].rows).toHaveLength(0);
  });
});

describe("TraceRecorder dataset opens", () => {
  function metadataBatch(offsetUs: number, durationUs: number, requestId = "req-1") {
    return {
      dropped: 0,
      rid: [0],
      request_id: [requestId],
      family: ["metadata_read" as const],
      metadata_phase: ["backend_read" as const],
      dispatch_offset_us: [offsetUs],
      duration_us: [durationUs],
      outcome: ["delivered" as const],
      // A metadata read has no slot in the chunk phase enum.
      arrival_us: [PHASE_UNSET],
      binding_lookup_us: [PHASE_UNSET],
      dispatch_us: [PHASE_UNSET],
      cache_lookup_us: [PHASE_UNSET],
      permit_wait_us: [PHASE_UNSET],
      backend_read_us: [PHASE_UNSET],
      coalesced_wait_us: [PHASE_UNSET],
      decompress_us: [PHASE_UNSET],
      slice_encode_us: [PHASE_UNSET],
      handoff_us: [PHASE_UNSET],
      coalesced_onto: [LABEL_NONE],
    };
  }

  it("opens a run at the open request, so a cold open's reads land inside one", () => {
    const { recorder, advance } = makeRecorder();
    // No run is open, and the first chunk does not exist yet — the reads
    // about to arrive have nowhere else to go.
    expect(recorder.isRunOpen).toBe(false);
    recorder.noteOpenSent("req-1");
    expect(recorder.isRunOpen).toBe(true);

    advance(2_000);
    recorder.ingestServerBatch(metadataBatch(150_000, 63_000), 1);
    recorder.noteOpenSettled("req-1");

    const run = recorder.exportDocument().runs[0];
    expect(run.datasetOpens).toEqual([{ requestId: "req-1", startUs: 0, endUs: 2_000_000 }]);
    expect(run.serverRows[0].placement).toEqual({
      startUs: 150_000,
      endUs: 213_000,
      gapUs: 0,
      overshootUs: 0,
    });
  });

  it("keeps a failed open's rows, which is the case that needs them", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteOpenSent("req-1");
    advance(800);
    // The reads arrived on the timing ticker while the open was running;
    // the open then failed and settled with no dataset.
    recorder.ingestServerBatch(metadataBatch(10_000, 500_000), 1);
    recorder.noteOpenSettled("req-1");

    const run = recorder.exportDocument().runs[0];
    expect(run.serverRows).toHaveLength(1);
    expect(run.serverRows[0].unplacedReason).toBeNull();
    expect(run.datasetOpens[0].endUs).toBe(800_000);
  });

  it("carries an open that never settled with a null end", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteOpenSent("req-1");
    advance(400);
    recorder.ingestServerBatch(metadataBatch(1_000, 2_000), 1);

    const run = recorder.exportDocument().runs[0];
    expect(run.datasetOpens[0].endUs).toBeNull();
    // Placement needs only the start, so the reads are still readable.
    expect(run.serverRows[0].placement?.startUs).toBe(1_000);
  });

  it("counts the opens it declined to bracket rather than dropping them silently", () => {
    const { recorder } = makeRecorder();
    for (let i = 0; i < 70; i++) recorder.noteOpenSent(`req-${i}`);

    const run = recorder.exportDocument().runs[0];
    expect(run.datasetOpens).toHaveLength(64);
    expect(run.datasetOpensDropped).toBe(6);
  });

  it("holds the run open while an open is unsettled, or a cold open discards its own rows", () => {
    vi.useFakeTimers();
    try {
      const { recorder, advance } = makeRecorder();
      recorder.noteOpenSent("req-1");
      // Before the first chunk exists the pipeline is trivially quiescent:
      // nothing dirty, nothing wanted, nothing in flight. The server is
      // several seconds into reading metadata.
      recorder.noteQuiescence(evaluateQuiescence(inputs(), 1_000));
      advance(4_000);
      vi.advanceTimersByTime(4_000);
      expect(recorder.isRunOpen).toBe(true);

      recorder.ingestServerBatch(metadataBatch(3_000_000, 900_000), 1);
      recorder.noteOpenSettled("req-1");
      // Settling re-reads the page's last published state, so the hold
      // starts here rather than at the next tick, which may never come.
      vi.advanceTimersByTime(500);
      expect(recorder.isRunOpen).toBe(false);

      const [run] = recorder.exportDocument().runs;
      expect(run.header.endReason).toBe("quiescent");
      // The rows the open produced are inside the run, which is the point.
      expect(run.serverRows).toHaveLength(1);
      expect(run.serverRows[0].placement?.startUs).toBe(3_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still times out a run whose open never settles", () => {
    vi.useFakeTimers();
    try {
      const { recorder } = makeRecorder();
      recorder.noteOpenSent("req-1");
      recorder.noteQuiescence(evaluateQuiescence(inputs(), 1_000));
      // An unsettled open holds off quiescence, not the timeout: a run that
      // never finishes is the most diagnostic one there is, and it has to
      // be emitted rather than held open forever.
      vi.advanceTimersByTime(4_999);
      expect(recorder.isRunOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(recorder.isRunOpen).toBe(false);

      const [run] = recorder.exportDocument().runs;
      expect(run.header.endReason).toBe("timeout");
      expect(run.datasetOpens[0].endUs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a second settle, so a straggler cannot move an end that happened", () => {
    const { recorder, advance } = makeRecorder();
    recorder.noteOpenSent("req-1");
    advance(100);
    recorder.noteOpenSettled("req-1");
    advance(900);
    recorder.noteOpenSettled("req-1");

    expect(recorder.exportDocument().runs[0].datasetOpens[0].endUs).toBe(100_000);
  });
});

describe("what a run in progress can say about itself (#937)", () => {
  it("says nothing while no labelled run is open", () => {
    const { recorder } = makeRecorder();
    // Steady state is not a run: it has no cause to report and nothing to
    // make progress against.
    expect(recorder.liveProgress).toBeNull();
    recorder.beginChunkRow(CHUNK, 0);
    expect(recorder.liveProgress).toBeNull();
  });

  it("partitions the rows it has made into visible, in flight and retired", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    const drawn = recorder.beginChunkRow(CHUNK, 0);
    recorder.noteHandedToRenderer(drawn);
    recorder.noteFrameDispatched();
    recorder.noteFrameDispatched();
    const abandoned = recorder.beginChunkRow(CHUNK, 0);
    recorder.finishRow(abandoned, RowOutcome.Retired);
    const going = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(going, Boundary.WireStart);
    advance(250);

    const progress = recorder.liveProgress!;
    expect(progress.planned).toBe(3);
    expect(progress.visible).toBe(1);
    expect(progress.retired).toBe(1);
    expect(progress.inFlight).toBe(1);
    expect(progress.elapsedMs).toBe(250);
    expect(progress.cause.source).toBe("dataset_added");
  });

  it("names the run, so the surface reads that run and not the export's own interval", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    const runId = recorder.liveProgress!.runId;

    recorder.closeRun("explicit");
    const document = recorder.exportDocument();

    expect(document.runs.map(run => run.header.runId)).toContain(runId);
    expect(document.runs[0].header.endReason).toBe("explicit");
  });

  it("places the in-flight rows in the phase each is sitting in", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.beginChunkRow(CHUNK, 0);
    const decoding = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(decoding, Boundary.DecodeStart);
    const uploading = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(uploading, Boundary.DecodeStart);
    recorder.stamp(uploading, Boundary.UploadStart);

    const progress = recorder.liveProgress!;
    const rowsIn = (phase: string) =>
      progress.occupancy.find(slot => slot.phase === phase)!.rows;
    expect(rowsIn("wire")).toBe(1);
    expect(rowsIn("decode")).toBe(1);
    expect(rowsIn("upload")).toBe(1);

    // Every in-flight row the recorder made is in a phase: a chunk row is
    // born at dispatch with `queue` stamped and `wire` open (#949), so the
    // unstamped residual — which the table below the recorder can still hold
    // — is empty for rows that came through this path.
    expect(progress.unstamped).toBe(0);
    const inBar = progress.occupancy.reduce((total, slot) => total + slot.rows, 0);
    expect(inBar).toBe(progress.inFlight);
  });

  it("does not close the run it describes", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.beginChunkRow(CHUNK, 0);

    expect(recorder.liveProgress).not.toBeNull();
    expect(recorder.liveProgress).not.toBeNull();

    expect(recorder.isRunOpen).toBe(true);
    expect(recorder.concludedRuns.count).toBe(0);
  });

  it("carries the page's own predicate, so a stalled run reads as stalled", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.noteQuiescence(evaluateQuiescence(inputs({ inFlight: 3 }), 1_000));

    expect(recorder.liveProgress!.quiescent).toBe(false);
    expect(recorder.liveProgress!.quiescenceReason).toBe("chunks_in_flight");
  });
});
