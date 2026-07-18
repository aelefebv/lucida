import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLANNING_CONFIG,
  MINIMAP_LANE_OFFSET,
  MINIMAP_SEED_BULK_LANE_OFFSET,
  PREFETCH_LANE_OFFSET,
  applyWorkspaceMinimapPriority,
  createSyntheticState,
  emitPlanRequests,
  emptyPlanStats,
  mergeConfig,
  plan,
} from "./index.ts";
import {
  minimapCoord,
  syntheticPlanningSnapshot,
} from "./testFixtures.ts";

describe("plan", () => {
  it("emits explicit detail and coarse tiers and increments only request epoch", () => {
    const input = syntheticPlanningSnapshot({
      epochs: { content: 2, layout: 3, view: 4, selection: 5, request: 6 },
    });
    const result = plan(input, createSyntheticState(), mergeConfig({ prefetchDepth: 0 }));

    expect(new Set(result.requests.map((request) => request.lane))).toEqual(
      new Set(["detail", "coarse"]),
    );
    expect(result.requests.filter((request) => request.lane === "detail")).toHaveLength(4);
    expect(result.requests.filter((request) => request.lane === "coarse")).toHaveLength(1);
    expect(result.requests.every((request) => request.datasetId === "ds-1")).toBe(true);
    expect(result.epochs).toEqual({ content: 2, layout: 3, view: 4, selection: 5, request: 7 });
    expect(result.nextState.previousActiveSet).toEqual(result.activeSet);
  });

  it("sorts all requests by ascending priority", () => {
    const result = plan(syntheticPlanningSnapshot(), createSyntheticState());
    expect(result.requests.map((request) => request.priority)).toEqual(
      [...result.requests.map((request) => request.priority)].sort((a, b) => a - b),
    );
  });

  it("prefetches future timepoints up to the configured depth and source bound", () => {
    const result = plan(
      syntheticPlanningSnapshot(),
      createSyntheticState(),
      mergeConfig({ prefetchDepth: 5 }),
    );
    const prefetch = result.requests.filter((request) => request.lane === "prefetch");

    expect(new Set(prefetch.map((request) => request.t))).toEqual(new Set([1, 2]));
    expect(Math.min(...prefetch.map((request) => request.priority)))
      .toBeGreaterThan(PREFETCH_LANE_OFFSET);
  });

  it("re-emits requests for a changed selection without rebuilding the active set", () => {
    const initial = plan(syntheticPlanningSnapshot(), createSyntheticState());
    const base = syntheticPlanningSnapshot();
    const moved = syntheticPlanningSnapshot({ selection: { ...base.selection, t: 1 } });
    const emitted = emitPlanRequests(
      initial.activeSet,
      moved,
      emptyPlanStats(),
      DEFAULT_PLANNING_CONFIG,
    );

    expect(emitted.requests.some((request) => request.lane === "detail" && request.t === 1)).toBe(true);
    expect(initial.activeSet).toEqual(initial.nextState.previousActiveSet);
  });

  it("puts a small minimap seed set on the fast lane", () => {
    const pending = new Map([["image-0", [minimapCoord(0)]]]);
    const result = plan(
      syntheticPlanningSnapshot({ minimapPending: pending }),
      createSyntheticState(),
    );
    const seed = result.requests.find((request) => request.lane === "minimap");

    expect(seed?.priority).toBe(MINIMAP_LANE_OFFSET);
    expect(seed?.tier).toBe("coarse");
  });

  it("demotes a large minimap seed set behind every view-serving request", () => {
    const pending = new Map([["image-0", [minimapCoord(0), minimapCoord(1)]]]);
    const result = plan(
      syntheticPlanningSnapshot({ minimapPending: pending }),
      createSyntheticState(),
      mergeConfig({ minimapSeedFastMaxChunks: 1 }),
    );
    const seedPriorities = result.requests
      .filter((request) => request.lane === "minimap")
      .map((request) => request.priority);
    const viewPriorities = result.requests
      .filter((request) => request.lane !== "minimap")
      .map((request) => request.priority);

    expect(Math.min(...seedPriorities)).toBeGreaterThan(Math.max(...viewPriorities));
    expect(Math.min(...seedPriorities)).toBeGreaterThanOrEqual(MINIMAP_SEED_BULK_LANE_OFFSET);
  });

  it("demotes bulk minimap seeds behind view work from every dataset", () => {
    const pending = new Map([["image-0", [minimapCoord(0), minimapCoord(1)]]]);
    const config = mergeConfig({ minimapSeedFastMaxChunks: 1 });
    const a = plan(
      syntheticPlanningSnapshot({ datasetId: "ds-a", minimapPending: pending }),
      createSyntheticState(),
      config,
    );
    const b = plan(
      syntheticPlanningSnapshot({ datasetId: "ds-b", minimapPending: pending }),
      createSyntheticState(),
      config,
    );
    const bView = b.requests.find((request) => request.lane !== "minimap")!;
    const priorSeedFloor = Math.max(
      ...a.requests.filter((request) => request.lane === "minimap")
        .map((request) => request.priority),
    );
    bView.priority = priorSeedFloor + 100;

    applyWorkspaceMinimapPriority([a.requests, b.requests], pending, config);

    const seeds = [...a.requests, ...b.requests]
      .filter((request) => request.lane === "minimap");
    expect(Math.min(...seeds.map((request) => request.priority)))
      .toBeGreaterThan(bView.priority);
    expect(a.requests.map((request) => request.priority)).toEqual(
      [...a.requests.map((request) => request.priority)].sort((x, y) => x - y),
    );
  });

  it("reports culling work as a monotonic funnel", () => {
    const { culling } = plan(syntheticPlanningSnapshot(), createSyntheticState()).stats;
    expect(culling.considered).toBeGreaterThanOrEqual(culling.afterXyBounds);
    expect(culling.afterXyBounds).toBeGreaterThanOrEqual(culling.afterZRange);
    expect(culling.afterZRange).toBeGreaterThanOrEqual(culling.afterFrustum);
  });
});
