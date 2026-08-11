import { describe, it, expect, vi } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import { noopSinkFactory } from "./sink.ts";
import { createQuiescenceState, evaluateQuiescence, type QuiescenceState } from "./quiescence.ts";
import { Boundary, PHASE_UNSET, RowOutcome, TRACE_SCHEMA_VERSION } from "./types.ts";

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
  it("records nothing into a run until one is open, but counts what it saw", () => {
    const { recorder } = makeRecorder();
    expect(recorder.beginChunkRow(CHUNK, 0)).toBe(-1);

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(0);
    expect(doc.rowsOutsideRun).toBe(1);
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
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stampAdmission(row, 1_020);
    recorder.stamp(row, Boundary.WireStart);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.plan).toEqual({ startUs: 0, endUs: 20_000, durationUs: 20_000 });
    expect(serialised.phases.queue)
      .toEqual({ startUs: 20_000, endUs: 100_000, durationUs: 80_000 });
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

    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stampAdmission(row, 1_010);
    recorder.closeRun("explicit");

    const [serialised] = recorder.exportDocument().runs[0].rows;
    expect(serialised.phases.plan!.startUs).toBe(0);
    expect(serialised.phases.plan!.endUs).toBe(10_000);
  });

  it("leaves plan unset rather than inventing one when no pass is on record", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    advance(30);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stampAdmission(row, 1_030);
    recorder.stamp(row, Boundary.WireStart);
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

    const row = recorder.beginChunkRow(CHUNK, 0);
    // No admission stamp: ADR 0044 keeps them for the admission window only.
    recorder.stampAdmission(row, undefined);
    recorder.stamp(row, Boundary.WireStart);
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

  it("counts server rows that arrive between runs instead of keeping them", () => {
    const { recorder } = makeRecorder();
    recorder.ingestServerBatch(BATCH, 1);
    const doc = recorder.exportDocument();

    expect(doc.serverRowsOutsideRun).toBe(1);
    expect(doc.runs).toHaveLength(0);
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
