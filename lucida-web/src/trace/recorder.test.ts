import { describe, it, expect, vi } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import { noopRowSinkFactory } from "./sink.ts";
import { createQuiescenceState, evaluateQuiescence, type QuiescenceState } from "./quiescence.ts";
import { Boundary, RowOutcome, TRACE_SCHEMA_VERSION } from "./types.ts";

const OPEN_CAUSE = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" } as const;

const CHUNK = {
  datasetId: "ds",
  entityId: "member-1",
  imageId: "image-1",
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
    expect(recorder.exportDocument().instrumentedPhases).toEqual(["wire"]);
  });
});

describe("TraceRecorder sink injection", () => {
  it("keeps no rows with a no-op sink while the call sites stay live", () => {
    const { recorder } = makeRecorder({ sinkFactory: noopRowSinkFactory });
    recorder.openRun(OPEN_CAUSE);
    const row = recorder.beginChunkRow(CHUNK, 0);
    recorder.stamp(row, Boundary.WireStart);
    recorder.finishRow(row, RowOutcome.Complete);
    recorder.closeRun("explicit");

    expect(row).toBeGreaterThanOrEqual(0);
    expect(recorder.exportDocument().runs[0].rows).toHaveLength(0);
  });
});
