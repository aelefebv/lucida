/**
 * Tiers two and three on the recorder: per-tick aggregates and point events.
 * The rings themselves are covered by `tickRing.test.ts` / `eventRing.test.ts`;
 * this is about what belongs to a run and what a document says about it.
 */

import { describe, expect, it } from "vitest";

import { TraceRecorder } from "./recorder.ts";
import {
  CountedPhaseIndex,
  PointEvent,
  TickCounter,
  type RunConditions,
} from "./types.ts";

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

const CONDITIONS: RunConditions = {
  datasetIds: ["ds"],
  composedView: { url: "/w/ws-1", mode: "slice" },
  devicePixelRatio: 2,
  viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
};

function makeRecorder() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 5_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => CONDITIONS,
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

describe("per-tick aggregates", () => {
  it("records a sample per dataset, stamped from run start", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    advance(10);
    const a = recorder.beginTick("ds-a");
    a!.counters[TickCounter.LaneDetail] = 9;
    for (let i = 0; i < 9; i++) a!.addPlanned(1);
    a!.setResidency(1, 4, 2);
    recorder.commitTick();

    const b = recorder.beginTick("ds-b");
    b!.counters[TickCounter.ActiveSetTotal] = 3;
    recorder.commitTick();

    const [run] = recorder.exportDocument().runs;
    expect(run.ticks).toHaveLength(2);
    expect(run.ticks[0].atUs).toBe(10_000);
    expect(run.ticks[0].datasetId).toBe("ds-a");
    expect(run.ticks[0].counters.laneDetail).toBe(9);
    expect(run.ticks[0].levels).toEqual([{ level: 1, planned: 9, cached: 4, inFlight: 2 }]);
    expect(run.ticks[1].datasetId).toBe("ds-b");
    expect(run.ticks[1].counters.laneDetail).toBe(0);
    expect(run.ticksDropped).toBe(0);
  });

  /**
   * The reading tier rides the tick, not the planning pass — a run can fetch for
   * seconds without re-planning once, and a series that samples only when the
   * planner runs is a cluster of readings at run start and silence after.
   */
  it("keeps a reading per tick, independent of the planning cadence", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    advance(16);
    recorder.noteReading(1_204, 12, 16_700, 5_000_000_000);
    advance(16);
    recorder.noteReading(1_180, 12, 16_100, 5_100_000_000);
    // One planning pass across two ticks: the readings must not be tied to it.
    recorder.beginTick("ds-a");
    recorder.commitTick();

    const [run] = recorder.exportDocument().runs;
    expect(run.ticks).toHaveLength(1);
    expect(run.readings).toEqual([
      { atUs: 16_000, queueDepth: 1_204, inFlight: 12, frameTimeUs: 16_700, residentBytes: 5_000_000_000 },
      { atUs: 32_000, queueDepth: 1_180, inFlight: 12, frameTimeUs: 16_100, residentBytes: 5_100_000_000 },
    ]);
    expect(run.readingsDropped).toBe(0);
  });

  /**
   * Recording is continuous, so a reading taken between runs is retained in
   * the unlabelled interval rather than discarded (#927).
   */
  it("keeps a reading in the unlabelled interval while no run is open", () => {
    const { recorder } = makeRecorder();
    recorder.noteReading(5, 5, 5, 5);

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(0);
    expect(doc.steadyState[0].readings).toHaveLength(1);
  });

  it("samples into the unlabelled interval while no run is open", () => {
    const { recorder } = makeRecorder();
    expect(recorder.beginTick("ds")).not.toBeNull();
    recorder.commitTick();

    const doc = recorder.exportDocument();
    expect(doc.runs).toHaveLength(0);
    expect(doc.steadyState[0].ticks).toHaveLength(1);
  });

  it("hands out no scratch with no page to say what conditions applied", () => {
    const { recorder } = makeRecorder();
    recorder.setEnvironment(null);
    expect(recorder.beginTick("ds")).toBeNull();
    recorder.commitTick();
    expect(recorder.exportDocument().steadyState).toHaveLength(0);
  });

  it("carries the counted-not-timed phases and resets them each sample", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    recorder.countPhase(CountedPhaseIndex.CacheAdmission, 3);
    recorder.countPhase(CountedPhaseIndex.CoalesceAttach);
    recorder.beginTick("ds");
    recorder.commitTick();

    recorder.countPhase(CountedPhaseIndex.WorkerDispatch, 2);
    recorder.beginTick("ds");
    recorder.commitTick();

    const [run] = recorder.exportDocument().runs;
    expect(run.ticks[0].counted).toEqual({
      "cache-admission": 3, "worker-dispatch": 0, "coalesce-attach": 1,
    });
    expect(run.ticks[1].counted).toEqual({
      "cache-admission": 0, "worker-dispatch": 2, "coalesce-attach": 0,
    });
  });

  it("does not carry counts across a run boundary", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    recorder.countPhase(CountedPhaseIndex.CacheAdmission, 5);
    recorder.closeRun("explicit");

    recorder.openRun(OPEN_CAUSE);
    recorder.beginTick("ds");
    recorder.commitTick();

    const runs = recorder.exportDocument().runs;
    expect(runs[1].ticks[0].counted["cache-admission"]).toBe(0);
  });

  it("declares the counted phases alongside the timed ones", () => {
    const { recorder } = makeRecorder();
    expect(recorder.exportDocument().countedPhases).toEqual([
      "cache-admission", "worker-dispatch", "coalesce-attach",
    ]);
  });
});

describe("point events", () => {
  it("records the four kinds under one shape, with borrowed reason codes", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    advance(1);
    recorder.recordPointEvent(PointEvent.Eviction, "evicted", CHUNK, 0);
    recorder.recordPointEvent(PointEvent.Rejection, "atlas-policy", CHUNK, 1);
    recorder.recordPointEvent(PointEvent.Retry, "transient", CHUNK, 0);
    recorder.recordPointEvent(PointEvent.Failure, "permanent", CHUNK, 0);

    const [run] = recorder.exportDocument().runs;
    expect(run.events.map(e => [e.kind, e.reason])).toEqual([
      ["eviction", "evicted"],
      ["rejection", "atlas-policy"],
      ["retry", "transient"],
      ["failure", "permanent"],
    ]);
    expect(run.events[0].atUs).toBe(1_000);
    expect(run.events[0].chunk?.chunkKey).toBe("1/0/0/0/2/3");
    expect(run.events[1].chunk?.residencyTier).toBe("coarse");
    expect(run.eventsDropped).toBe(0);
  });

  it("keeps events out of a document when no run is open", () => {
    const { recorder } = makeRecorder();
    recorder.recordPointEvent(PointEvent.Failure, "permanent", CHUNK, 0);
    expect(recorder.exportDocument().runs).toHaveLength(0);
  });
});

describe("level-change events", () => {
  function tickWithTarget(
    recorder: TraceRecorder,
    datasetId: string,
    min: number,
    max: number,
    pinned = false,
  ): void {
    const scratch = recorder.beginTick(datasetId);
    scratch!.setTargetLevel(min, max, pinned);
    recorder.commitTick();
  }

  it("records the old and new range when a dataset's target moves between samples", () => {
    const { recorder, advance } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    tickWithTarget(recorder, "ds", 1, 1);
    advance(20);
    tickWithTarget(recorder, "ds", 1, 1);
    advance(20);
    tickWithTarget(recorder, "ds", 2, 2);

    const [run] = recorder.exportDocument().runs;
    expect(run.events).toEqual([
      {
        atUs: 40_000,
        kind: "level-change",
        reason: "screen",
        chunk: null,
        levelChange: { datasetId: "ds", from: { min: 1, max: 1 }, to: { min: 2, max: 2 } },
      },
    ]);
  });

  it("names the pin as the reason when the new target is pinned", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    tickWithTarget(recorder, "ds", 2, 2);
    tickWithTarget(recorder, "ds", 0, 0, true);
    tickWithTarget(recorder, "ds", 0, 0, true);
    tickWithTarget(recorder, "ds", 2, 2);

    const [run] = recorder.exportDocument().runs;
    expect(run.events.map(e => [e.reason, e.levelChange?.to.min])).toEqual([
      ["pin", 0],
      ["screen", 2],
    ]);
  });

  it("tracks each dataset on its own", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    tickWithTarget(recorder, "ds-a", 1, 1);
    tickWithTarget(recorder, "ds-b", 3, 3);
    tickWithTarget(recorder, "ds-a", 1, 1);
    tickWithTarget(recorder, "ds-b", 2, 2);

    const [run] = recorder.exportDocument().runs;
    expect(run.events.map(e => e.levelChange?.datasetId)).toEqual(["ds-b"]);
  });

  it("records nothing for the first target seen or for a sample with no target", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);

    tickWithTarget(recorder, "ds", 1, 1);
    recorder.beginTick("ds");
    recorder.commitTick();
    tickWithTarget(recorder, "ds", 1, 1);

    expect(recorder.exportDocument().runs[0].events).toHaveLength(0);
  });

  it("compares across a run boundary and files the change in the run that saw it", () => {
    const { recorder } = makeRecorder();
    recorder.openRun(OPEN_CAUSE);
    tickWithTarget(recorder, "ds", 0, 0);
    recorder.closeRun("explicit");

    recorder.openRun(OPEN_CAUSE);
    tickWithTarget(recorder, "ds", 1, 1);

    const runs = recorder.exportDocument().runs;
    expect(runs[0].events).toHaveLength(0);
    expect(runs[1].events[0].levelChange).toEqual({
      datasetId: "ds", from: { min: 0, max: 0 }, to: { min: 1, max: 1 },
    });
  });
});
