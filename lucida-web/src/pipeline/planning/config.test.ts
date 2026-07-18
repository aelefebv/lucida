import { describe, expect, it } from "vitest";

import {
  COARSE_LANE_OFFSET,
  DEFAULT_PLANNING_CONFIG,
  DETAIL_LANE_OFFSET,
  MINIMAP_LANE_OFFSET,
  MINIMAP_SEED_BULK_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  PREFETCH_LANE_OFFSET,
  mergeConfig,
} from "./index.ts";

describe("PlanningConfig", () => {
  it("keeps the canonical lane order and minimap fairness defaults", () => {
    expect(MINIMAP_LANE_OFFSET).toBeLessThan(DETAIL_LANE_OFFSET);
    expect(DETAIL_LANE_OFFSET).toBeLessThan(PREFETCH_LANE_OFFSET);
    expect(PREFETCH_LANE_OFFSET).toBeLessThan(COARSE_LANE_OFFSET);
    expect(MINIMAP_SEED_FAST_MAX_CHUNKS).toBeGreaterThan(0);
    expect(MINIMAP_SEED_BULK_LANE_OFFSET).toBeGreaterThan(COARSE_LANE_OFFSET);
  });

  it("merges a partial config without mutating defaults or its input", () => {
    const partial = { prefetchDepth: 4 };
    const merged = mergeConfig(partial);
    expect(merged).toEqual({ ...DEFAULT_PLANNING_CONFIG, prefetchDepth: 4 });
    expect(partial).toEqual({ prefetchDepth: 4 });
    expect(merged).not.toBe(DEFAULT_PLANNING_CONFIG);
  });
});
