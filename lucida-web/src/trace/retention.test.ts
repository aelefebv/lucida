/**
 * Retention and truncation, asserted on the exported document rather than on
 * the recorder's buffers. The caps are byte counts against the real sink, so
 * these tests reach them by recording enough to reach them — a sink with
 * miniature buffers would test a policy nobody ships.
 */

import { describe, it, expect } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import { CAP_DERIVATION, CAP_UNIT, PER_RUN_CAP_BYTES, RESIDENT_CAP_BYTES } from "./retention.ts";
import {
  LABEL_NONE,
  PHASE_UNSET,
  PointEvent,
  type RunCause,
  type TraceDocument,
} from "./types.ts";

const CAUSE: RunCause = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" };

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

function makeRecorder() {
  let clock = 1_000;
  const recorder = new TraceRecorder({ now: () => clock, epochNow: () => 1_700_000_000_000 });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
      speculativePending: 0,
      speculativeInFlight: 0,
      desiredDetailChunks: 0,
      residentDetailChunks: 0,
      desiredCoarseChunks: 0,
      residentCoarseChunks: 0,
    }),
  });
  return { recorder, advance: (ms: number) => { clock += ms; } };
}

/**
 * Close one-row runs until the resident cap has forced an eviction, and
 * report how many were recorded. Read through the exported document rather
 * than a private counter: the number a reader gets is the number under test.
 */
function runUntilEvicted(recorder: TraceRecorder, limit = 64): number {
  for (let n = 1; n <= limit; n++) {
    recorder.openRun({ ...CAUSE, source: `run-${n}` });
    recorder.beginChunkRow(CHUNK, 0);
    recorder.closeRun("explicit");
    if (recorder.exportDocument().retention.intervalsEvicted > 0) return n;
  }
  throw new Error(`no eviction after ${limit} runs`);
}

/**
 * Append rows until the interval refuses one, and report how many it refused.
 * A refused row is the public face of truncation: the handle comes back -1.
 */
function fillUntilTruncated(recorder: TraceRecorder): number {
  for (let n = 0; n < 200_000; n++) {
    if (recorder.beginChunkRow(CHUNK, 0) < 0) return 1;
  }
  throw new Error("never reached the per-run cap");
}

function sources(doc: TraceDocument): (string | undefined)[] {
  return doc.runs.map(run => run.header.cause?.source);
}

describe("the resident cap", () => {
  it("discards whole completed runs oldest-first", () => {
    const { recorder } = makeRecorder();
    const closedBeforeEviction = runUntilEvicted(recorder);
    expect(closedBeforeEviction).toBeGreaterThan(1);

    const doc = recorder.exportDocument();
    expect(doc.retention.intervalsEvicted).toBeGreaterThan(0);
    expect(doc.retention.residentBytes).toBeLessThanOrEqual(RESIDENT_CAP_BYTES);
    // Whole runs, not parts of them: every survivor still has its row.
    for (const run of doc.runs) expect(run.rows).toHaveLength(1);
    // Oldest-first: the survivors are a suffix of what was recorded.
    expect(sources(doc)).toEqual(
      Array.from({ length: doc.runs.length }, (_, i) =>
        `run-${closedBeforeEviction - doc.runs.length + i + 1}`),
    );
  });

  it("never evicts the run in progress", () => {
    const { recorder } = makeRecorder();
    runUntilEvicted(recorder);

    recorder.openRun({ ...CAUSE, source: "in-progress" });
    for (let n = 0; n < 4_000; n++) recorder.beginChunkRow(CHUNK, 0);

    const doc = recorder.exportDocument();
    const inProgress = doc.runs.at(-1);
    expect(inProgress?.header.cause?.source).toBe("in-progress");
    expect(inProgress?.rows).toHaveLength(4_000);
  });

  it("retains steady state between runs under the same cap", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(CAUSE);
    recorder.closeRun("explicit");
    recorder.beginChunkRow(CHUNK, 0);
    recorder.openRun({ ...CAUSE, source: "second" });
    recorder.closeRun("explicit");

    const doc = recorder.exportDocument();
    expect(doc.steadyState).toHaveLength(1);
    expect(doc.steadyState[0].header.cause).toBeNull();
    expect(doc.steadyState[0].rows).toHaveLength(1);
    expect(doc.retention.residentBytes).toBeLessThanOrEqual(RESIDENT_CAP_BYTES);
  });

  it("records the caps and the workload they were derived at", () => {
    const { recorder } = makeRecorder();
    const doc = recorder.exportDocument();

    expect(doc.retention.residentCapBytes).toBe(RESIDENT_CAP_BYTES);
    expect(doc.retention.perRunCapBytes).toBe(PER_RUN_CAP_BYTES);
    expect(doc.retention.derivedFrom).toBe(CAP_DERIVATION);
    expect(doc.retention.capUnit).toBe(CAP_UNIT);
  });
});

describe("the per-run cap", () => {
  it("stops recording, marks the run truncated, and keeps counting", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(CAUSE);
    advance(3_000);
    const refused = fillUntilTruncated(recorder);

    for (let n = 0; n < 500; n++) recorder.beginChunkRow(CHUNK, 0);
    recorder.recordPointEvent(PointEvent.Eviction, "evicted");
    recorder.beginTick("ds");
    recorder.commitTick();
    recorder.ingestServerBatch(
      {
        dropped: 0,
        rid: [1],
        request_id: [null],
        family: ["chunk"],
        metadata_phase: [null],
        dispatch_offset_us: [0],
        duration_us: [0],
        outcome: ["delivered"],
        arrival_us: [1],
        binding_lookup_us: [PHASE_UNSET],
        dispatch_us: [PHASE_UNSET],
        cache_lookup_us: [PHASE_UNSET],
        permit_wait_us: [PHASE_UNSET],
        backend_read_us: [2],
        coalesced_wait_us: [PHASE_UNSET],
        decompress_us: [PHASE_UNSET],
        slice_encode_us: [PHASE_UNSET],
        handoff_us: [PHASE_UNSET],
        coalesced_onto: [LABEL_NONE],
      },
      1,
    );

    const run = recorder.exportDocument().runs[0];
    expect(run.header.truncation).toMatchObject({
      reason: "per-run-cap",
      capBytes: PER_RUN_CAP_BYTES,
      atUs: 3_000_000,
      rowsUnrecorded: refused + 500,
      ticksUnrecorded: 1,
      eventsUnrecorded: 1,
      serverRowsUnrecorded: 1,
    });
    expect(run.header.truncation?.rowsRecorded).toBe(run.rows.length);
    expect(run.ticks).toHaveLength(0);
    expect(run.events).toHaveLength(0);
    expect(run.serverRows).toHaveLength(0);
  });

  it("keeps every row it is offered up to the cap — there is no sampling rung", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(CAUSE);

    let offered = 0;
    while (recorder.beginChunkRow(CHUNK, 0) >= 0) offered++;

    const run = recorder.exportDocument().runs[0];
    expect(run.rows).toHaveLength(offered);
    // Complete, not thinned: the beginning of the run is the diagnostic
    // payload, so degradation is a declared stop rather than a quiet sample.
    expect(new Set(run.rows.map(row => row.outcome))).toEqual(new Set(["in-flight"]));
  });

  it("rotates the steady-state interval instead of truncating it", () => {
    const { recorder } = makeRecorder();
    // No run is open, so everything here lands in the unlabelled interval.
    // Comfortably past the cap, which the assertions below confirm it crossed
    // — a row handle never comes back -1, because steady state never refuses.
    for (let n = 0; n < 40_000; n++) {
      expect(recorder.beginChunkRow(CHUNK, 0)).toBeGreaterThanOrEqual(0);
    }

    const doc = recorder.exportDocument();
    expect(doc.steadyState.length).toBeGreaterThan(1);
    expect(doc.steadyState.map(interval => interval.header.endReason)).toEqual([
      ...doc.steadyState.slice(0, -1).map(() => "rotated"),
      "explicit",
    ]);
    // Rotation is not degradation: no interval is marked truncated, and the
    // most recent work — the pan before a stall — is the part that survives.
    for (const interval of doc.steadyState) {
      expect(interval.header.truncation).toBeNull();
      expect(interval.rows.length).toBeGreaterThan(0);
    }
  });

  it("truncates the run rather than first evicting the history around it", () => {
    const { recorder } = makeRecorder();
    recorder.openRun({ ...CAUSE, source: "earlier" });
    recorder.beginChunkRow(CHUNK, 0);
    recorder.closeRun("explicit");

    recorder.openRun({ ...CAUSE, source: "runaway" });
    fillUntilTruncated(recorder);

    const doc = recorder.exportDocument();
    expect(doc.retention.intervalsEvicted).toBe(0);
    expect(sources(doc)).toEqual(["earlier", "runaway"]);
  });

  it("carries the truncation into the coverage block as a gap that could hide anything", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(CAUSE);
    advance(2_000);
    fillUntilTruncated(recorder);
    advance(8_000);
    recorder.closeRun("explicit");

    const { coverage } = recorder.exportDocument().runs[0];
    const gap = coverage.gaps.find(candidate => candidate.kind === "truncated");
    expect(gap).toMatchObject({
      startUs: 2_000_000,
      endUs: 10_000_000,
      durationUs: 8_000_000,
      couldHideBottleneck: true,
    });
    // Nothing after the offset was measured, so nothing after it is accounted.
    expect(coverage.accountedUs).toBe(0);
  });
});

describe("the coverage block", () => {
  it("is present on a clean run, with the limits that never go away", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(CAUSE);
    advance(50);
    recorder.closeRun("explicit");

    const { coverage } = recorder.exportDocument().runs[0];
    expect(coverage.wallClockUs).toBe(50_000);
    expect(coverage.limits.length).toBeGreaterThan(0);
    expect(coverage.countedPhases).toEqual({
      "cache-admission": 0,
      "worker-dispatch": 0,
      "coalesce-attach": 0,
    });
  });

  it("is present on the unlabelled steady-state interval too", () => {
    const { recorder, advance } = makeRecorder();
    recorder.beginChunkRow(CHUNK, 0);
    advance(400);
    recorder.closeRun("explicit");

    const { coverage } = recorder.exportDocument().steadyState[0];
    expect(coverage.wallClockUs).toBe(400_000);
    expect(coverage.gaps.map(gap => gap.kind)).toContain("nothing-recorded");
  });
});
