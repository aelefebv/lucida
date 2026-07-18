import { describe, expect, it } from "vitest";
import { DeliveryState } from "../pipeline/fetch/index.ts";
import type {
  CacheStateSnapshot,
  ChunkRequest,
} from "../pipeline/planning/index.ts";
import { makeChunkContract } from "../test/fixtures.ts";
import {
  buildGroupTierCoverage,
  formatTierCoverageLabel,
  formatTierCoverageTitle,
  tierCoverageMode,
  type GroupTierCoverage,
} from "./DebugOverlays.tsx";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import { plannedRankKey } from "./plannedRank.ts";
import { radiusSpecsForOverlay } from "./radiusPreview.ts";

function req(overrides: Partial<ChunkRequest>): ChunkRequest {
  return {
    datasetId: "ds-1",
    entityId: "tile-a",
    imageId: "img-a",
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
    contract: makeChunkContract(),
    ...overrides,
  };
}

function emptyCoverage(): GroupTierCoverage {
  return {
    detail: { wanted: 0, shown: 0, ready: 0, inFlight: 0 },
    coarse: { wanted: 0, shown: 0, ready: 0, inFlight: 0 },
  };
}

describe("DebugOverlays tier coverage helpers", () => {
  it("keeps identical detail and coarse requests distinct in planned ranks", () => {
    const chunkKey = "0/0/0/0/0/0";
    expect(plannedRankKey("ds-1", "img-a", "detail", chunkKey)).not.toBe(
      plannedRankKey("ds-1", "img-a", "coarse", chunkKey),
    );
  });

  it("filters render-radius specs to the active slider preview tier", () => {
    const cfg = {
      ...DEFAULT_PLANNING_CONFIG,
      detailRenderRadiusView: 0.25,
      coarseRenderRadiusView: 0.75,
    };

    expect(radiusSpecsForOverlay(cfg, "detail")).toEqual([
      { tier: "detail", radiusView: 0.25 },
    ]);
    expect(radiusSpecsForOverlay(cfg, "coarse")).toEqual([
      { tier: "coarse", radiusView: 0.75 },
    ]);
    expect(radiusSpecsForOverlay(cfg, null)).toEqual([
      { tier: "coarse", radiusView: 0.75 },
      { tier: "detail", radiusView: 0.25 },
    ]);
  });

  it("aggregates current detail and coarse available coverage per group", () => {
    const deliveryState = new DeliveryState();
    deliveryState.markChunkSent("ds-1", "img-a", 0, "0/0/0/0/0/0", "detail");
    deliveryState.markChunkSent("ds-1", "img-a", 0, "2/0/0/0/0/0", "coarse");

    const cacheSnap: CacheStateSnapshot = {
      cached: new Map([
        ["ds-1", new Map([
          ["img-a", new Map([
            ["detail", new Set(["0/0/0/0/0/0"])],
            ["coarse", new Set(["2/0/0/0/0/0"])],
          ])],
        ])],
      ]),
      inFlight: new Map([
        ["ds-1", new Map([
          ["img-a", new Map([
            ["detail", new Set(["0/0/0/0/0/1"])],
          ])],
        ])],
      ]),
    };

    const coverageByGroup = buildGroupTierCoverage(
      {
        requests: [
          req({ chunkKey: "0/0/0/0/0/0" }),
          req({ chunkKey: "0/0/0/0/0/1", x: 1 }),
          req({
            level: 2,
            lane: "coarse",
            tier: "coarse",
            chunkKey: "2/0/0/0/0/0",
          }),
          req({ lane: "prefetch", chunkKey: "0/1/0/0/0/0", t: 1 }),
          req({ lane: "minimap", tier: "coarse", chunkKey: "4/0/0/0/0/0" }),
        ],
      },
      new Map([["tile-a", "group-a"]]),
      { deliveryState },
      cacheSnap,
    );

    const coverage = coverageByGroup.get("group-a");
    expect(coverage).toEqual({
      detail: { wanted: 2, shown: 1, ready: 1, inFlight: 1 },
      coarse: { wanted: 1, shown: 1, ready: 1, inFlight: 0 },
    });
    expect(formatTierCoverageLabel(coverage!, "FD", 0)).toBe("C1/1 D1/2");
    expect(tierCoverageMode(coverage!, "tiles-with-detail")).toBe("render-coarse");
    expect(formatTierCoverageTitle(coverage!, "FD", 0)).toContain(
      "detail available 1/2, ready 1, in-flight 1",
    );
  });

  it("counts CPU-ready chunks as available during cold-state rebuilds", () => {
    const coverageByGroup = buildGroupTierCoverage(
      {
        requests: [
          req({ chunkKey: "0/0/0/0/0/0" }),
          req({ chunkKey: "0/0/0/0/0/1", x: 1 }),
        ],
      },
      new Map([["tile-a", "group-a"]]),
      { deliveryState: new DeliveryState() },
      {
        cached: new Map([
          ["ds-1", new Map([
            ["img-a", new Map([
              ["detail", new Set(["0/0/0/0/0/0", "0/0/0/0/0/1"])],
            ])],
          ])],
        ]),
        inFlight: new Map(),
      },
    );

    expect(coverageByGroup.get("group-a")?.detail).toEqual({
      wanted: 2,
      shown: 2,
      ready: 2,
      inFlight: 0,
    });
    expect(formatTierCoverageLabel(coverageByGroup.get("group-a")!, "FD", 0)).toBe("D2/2");
  });

  it("counts identical detail and coarse chunk keys as separate tier coverage", () => {
    const chunkKey = "0/0/0/0/0/0";
    const coverageByGroup = buildGroupTierCoverage(
      {
        requests: [
          req({ lane: "detail", tier: "detail", chunkKey }),
          req({ lane: "coarse", tier: "coarse", chunkKey }),
        ],
      },
      new Map([["tile-a", "group-a"]]),
      null,
      {
        cached: new Map([
          ["ds-1", new Map([
            ["img-a", new Map([
              ["detail", new Set([chunkKey])],
              ["coarse", new Set([chunkKey])],
            ])],
          ])],
        ]),
        inFlight: new Map(),
      },
    );

    expect(coverageByGroup.get("group-a")).toEqual({
      detail: { wanted: 1, shown: 1, ready: 1, inFlight: 0 },
      coarse: { wanted: 1, shown: 1, ready: 1, inFlight: 0 },
    });
  });

  it("falls back to the legacy mode label when no chunk-tier requests exist", () => {
    const coverage = emptyCoverage();
    expect(formatTierCoverageLabel(coverage, "FD", 0)).toBe("FD L0");
    expect(tierCoverageMode(coverage, "tiles-with-detail")).toBe("tiles-with-detail");
  });

  it("colors coarse-only available coverage as coarse", () => {
    const coverage = emptyCoverage();
    coverage.coarse.wanted = 4;
    coverage.coarse.shown = 4;
    expect(formatTierCoverageLabel(coverage, "FD", 0)).toBe("C4/4");
    expect(tierCoverageMode(coverage, "tiles-with-detail")).toBe("render-coarse");
  });
});
