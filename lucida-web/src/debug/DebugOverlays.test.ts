import { describe, expect, it } from "vitest";
import { DeliveryState } from "../pipeline/fetch/index.ts";
import type {
  CacheStateSnapshot,
  ChunkRequest,
} from "../pipeline/planning/index.ts";
import {
  buildWellTierCoverage,
  formatTierCoverageLabel,
  formatTierCoverageTitle,
  tierCoverageMode,
  type WellTierCoverage,
} from "./DebugOverlays.tsx";

function req(overrides: Partial<ChunkRequest>): ChunkRequest {
  return {
    datasetId: "ds-1",
    entityId: "field-a",
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
    ...overrides,
  };
}

function emptyCoverage(): WellTierCoverage {
  return {
    detail: { wanted: 0, shown: 0, ready: 0, inFlight: 0 },
    coarse: { wanted: 0, shown: 0, ready: 0, inFlight: 0 },
  };
}

describe("DebugOverlays tier coverage helpers", () => {
  it("aggregates current detail and coarse worker-delivered coverage per well", () => {
    const deliveryState = new DeliveryState();
    deliveryState.markChunkSent("img-a", 0, "0/0/0/0/0/0");
    deliveryState.markChunkSent("img-a", 0, "2/0/0/0/0/0");

    const cacheSnap: CacheStateSnapshot = {
      cached: new Map([
        ["field-a", new Set(["0/0/0/0/0/0", "2/0/0/0/0/0"])],
      ]),
      inFlight: new Map([
        ["field-a", new Set(["0/0/0/0/0/1"])],
      ]),
    };

    const coverageByWell = buildWellTierCoverage(
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
      new Map([["field-a", "well-a"]]),
      { deliveryState },
      cacheSnap,
    );

    const coverage = coverageByWell.get("well-a");
    expect(coverage).toEqual({
      detail: { wanted: 2, shown: 1, ready: 1, inFlight: 1 },
      coarse: { wanted: 1, shown: 1, ready: 1, inFlight: 0 },
    });
    expect(formatTierCoverageLabel(coverage!, "FD", 0)).toBe("D1/2 C1/1");
    expect(tierCoverageMode(coverage!, "fields-with-detail")).toBe("render-detail");
    expect(formatTierCoverageTitle(coverage!, "FD", 0)).toContain(
      "detail shown 1/2, ready 1, in-flight 1",
    );
  });

  it("falls back to the legacy mode label when no chunk-tier requests exist", () => {
    const coverage = emptyCoverage();
    expect(formatTierCoverageLabel(coverage, "FD", 0)).toBe("FD L0");
    expect(tierCoverageMode(coverage, "fields-with-detail")).toBe("fields-with-detail");
  });

  it("colors coarse-only delivered coverage as coarse", () => {
    const coverage = emptyCoverage();
    coverage.coarse.wanted = 4;
    coverage.coarse.shown = 4;
    expect(formatTierCoverageLabel(coverage, "FD", 0)).toBe("C4/4");
    expect(tierCoverageMode(coverage, "fields-with-detail")).toBe("render-coarse");
  });
});
