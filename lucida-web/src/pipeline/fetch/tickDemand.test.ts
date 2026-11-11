import { describe, it, expect } from "vitest";

import { TickDemand } from "./tickDemand.ts";
import type { ChunkRequest } from "../planning/index.ts";

function request(overrides: Partial<ChunkRequest>): ChunkRequest {
  return {
    datasetId: "ds",
    entityId: "entity",
    imageId: "image",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    lane: "detail",
    tier: "detail",
    mode: "slice",
    priority: 0,
    chunkKey: "0/0/0/0/0/0",
    ...overrides,
  };
}

function viewTargets(demand: TickDemand, key: string): [string, ChunkRequest][] {
  const out: [string, ChunkRequest][] = [];
  demand.forEachViewTarget(key, (target, req) => out.push([target, req]));
  return out;
}

describe("TickDemand", () => {
  it("counts a chunk once per kind of demand however many requests ask", () => {
    const demand = new TickDemand();
    demand.note("a", request({ lane: "detail", tier: "detail" }));
    demand.note("a", request({ lane: "detail", tier: "detail", mode: "volume" }));
    demand.note("b", request({ lane: "prefetch", tier: "detail" }));
    demand.note("c", request({ lane: "minimap", tier: "coarse" }));
    demand.note("c", request({ lane: "coarse", tier: "coarse" }));

    expect(demand.detailKeys).toBe(2);
    expect(demand.viewDetailKeys).toBe(1);
    expect(demand.coarseKeys).toBe(1);
  });

  it("tells the view's own demand from prefetch and the minimap", () => {
    const demand = new TickDemand();
    demand.note("view", request({ lane: "detail", tier: "detail" }));
    demand.note("prefetch", request({ lane: "prefetch", tier: "detail" }));
    demand.note("minimap", request({ lane: "minimap", tier: "coarse" }));
    demand.note("coarse", request({ lane: "coarse", tier: "coarse" }));

    expect(demand.viewWantsDetail("view")).toBe(true);
    expect(demand.viewWantsDetail("prefetch")).toBe(false);
    expect(demand.coarseLaneWants("minimap")).toBe(false);
    expect(demand.coarseLaneWants("coarse")).toBe(true);
    expect([...demand.viewShownKeys()].sort()).toEqual(["coarse", "minimap", "view"]);
    expect(demand.wants("prefetch")).toBe(true);
    expect(demand.wants("absent")).toBe(false);
  });

  it("names each place the view wants a chunk delivered once, and none for prefetch", () => {
    const demand = new TickDemand();
    const slice = request({ lane: "detail", mode: "slice", cut: { axis: "z", plane: 3 } });
    const volume = request({ lane: "detail", mode: "volume" });
    demand.note("a", slice);
    demand.note("a", request({ lane: "prefetch" }));
    demand.note("a", volume);
    demand.note("a", request({ lane: "coarse", mode: "slice", cut: { axis: "z", plane: 3 } }));
    demand.note("b", request({ lane: "prefetch" }));

    expect(viewTargets(demand, "a")).toEqual([["slice:z3", slice], ["volume", volume]]);
    expect(viewTargets(demand, "b")).toEqual([]);
  });

  it("forgets everything on clear", () => {
    const demand = new TickDemand();
    demand.note("a", request({}));
    demand.clear();

    expect(demand.wants("a")).toBe(false);
    expect(demand.detailKeys).toBe(0);
    expect(demand.viewDetailKeys).toBe(0);
  });
});
