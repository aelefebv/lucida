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
    a!.addLevel(1, 9, 4, 2);
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

  it("hands out no scratch while no run is open", () => {
    const { recorder } = makeRecorder();
    expect(recorder.beginTick("ds")).toBeNull();
    recorder.commitTick();
    expect(recorder.exportDocument().runs).toHaveLength(0);
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
