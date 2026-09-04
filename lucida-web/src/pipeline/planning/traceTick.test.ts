import { beforeEach, describe, expect, it } from "vitest";

import { recordPlanningTick } from "./traceTick.ts";
import { emptyPlanStats } from "./index.ts";
import type { ActiveSetEntry, ChunkRequest, RequestPlan } from "./types.ts";
import { TraceRecorder } from "../../trace/recorder.ts";
import type { TraceTick } from "../../trace/types.ts";

const CAUSE = { epoch: "content", dirtyKind: "interactive", source: "test" } as const;

function makeRequest(overrides?: Partial<ChunkRequest>): ChunkRequest {
  return {
    datasetId: "ds-1",
    entityId: "entity-1",
    imageId: "image-1",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    lane: "detail",
    tier: "detail",
    priority: 0,
    chunkKey: "0/0/0/0/0/0",
    ...overrides,
  };
}

function tileEntry(entityId: string, mode: "tiles-with-detail" | "tiles-with-proxy-fallback"): ActiveSetEntry {
  return {
    kind: "tile",
    entityId,
    imageId: "image-1",
    mode,
    detailLevels: [0],
    coarseLevel: null,
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
  };
}

function makePlan(overrides: Partial<RequestPlan> = {}): RequestPlan {
  const activeSet = overrides.activeSet ?? [];
  return {
    requests: [],
    activeSet,
    proxyRequests: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    stats: emptyPlanStats(),
    nextState: { previousActiveSet: activeSet },
    ...overrides,
  };
}

function makeRecorder(): TraceRecorder {
  const recorder = new TraceRecorder({ now: () => 0, epochNow: () => 0 });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds-1"],
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
  return recorder;
}

const NO_RESIDENCY = { cached: [], inFlight: [] };

describe("recordPlanningTick", () => {
  let recorder: TraceRecorder;

  beforeEach(() => {
    recorder = makeRecorder();
    recorder.openRun(CAUSE);
  });

  function firstTick(): TraceTick {
    const [run] = recorder.exportDocument().runs;
    return run.ticks[0];
  }

  it("carries the lane counts the panel carries", () => {
    const plan = makePlan({
      requests: [
        makeRequest({ lane: "minimap" }),
        makeRequest({ lane: "detail" }),
        makeRequest({ lane: "detail" }),
        makeRequest({ lane: "coarse" }),
        makeRequest({ lane: "prefetch" }),
        makeRequest({ lane: "overview" }),
      ],
    });

    recordPlanningTick("ds-1", plan, NO_RESIDENCY, recorder);

    const tick = firstTick();
    expect(tick.counters.laneMinimap).toBe(1);
    expect(tick.counters.laneDetail).toBe(2);
    expect(tick.counters.laneCoarse).toBe(1);
    expect(tick.counters.lanePrefetch).toBe(1);
    expect(tick.counters.laneOverview).toBe(1);
    expect(tick.counters.plannedChunks).toBe(6);
  });

  it("carries the culling funnel", () => {
    const stats = emptyPlanStats();
    stats.culling.considered = 400;
    stats.culling.afterXyBounds = 200;
    stats.culling.afterZRange = 80;
    stats.culling.afterFrustum = 30;

    recordPlanningTick("ds-1", makePlan({ stats }), NO_RESIDENCY, recorder);

    const tick = firstTick();
    expect(tick.counters.cullingConsidered).toBe(400);
    expect(tick.counters.cullingAfterXyBounds).toBe(200);
    expect(tick.counters.cullingAfterZRange).toBe(80);
    expect(tick.counters.cullingAfterFrustum).toBe(30);
  });

  it("tallies the active set by mode over the whole set", () => {
    const plan = makePlan({
      activeSet: [
        tileEntry("a", "tiles-with-detail"),
        tileEntry("b", "tiles-with-proxy-fallback"),
        { kind: "group-as-proxy", entityId: "g", proxyKind: "group" } as unknown as ActiveSetEntry,
        { kind: "invisible", entityId: "i", coarsestLod: 3 } as unknown as ActiveSetEntry,
      ],
    });

    recordPlanningTick("ds-1", plan, NO_RESIDENCY, recorder);

    const tick = firstTick();
    expect(tick.counters.activeSetTotal).toBe(4);
    expect(tick.counters.activeSetTilesDetail).toBe(1);
    expect(tick.counters.activeSetTilesProxyFallback).toBe(1);
    expect(tick.counters.activeSetGroupAsProxy).toBe(1);
  });

  it("carries planned against cached and in-flight, per level", () => {
    const plan = makePlan({
      requests: [
        makeRequest({ level: 0 }),
        makeRequest({ level: 0 }),
        makeRequest({ level: 2 }),
      ],
    });

    recordPlanningTick("ds-1", plan, { cached: [5, 0, 1], inFlight: [0, 0, 3] }, recorder);

    expect(firstTick().levels).toEqual([
      { level: 0, planned: 2, cached: 5, inFlight: 0 },
      { level: 2, planned: 1, cached: 1, inFlight: 3 },
    ]);
  });

  it("records nothing while no run is open", () => {
    const idle = makeRecorder();
    recordPlanningTick("ds-1", makePlan(), NO_RESIDENCY, idle);
    expect(idle.exportDocument().runs).toHaveLength(0);
  });
});
