/**
 * With several views, each one's coverage is what admission let in of what
 * it asks for, and it settles once each chunk let in is held and on the GPU.
 */
import { describe, expect, it, vi } from "vitest";

import type { ChunkRequest } from "./planning/types.ts";
import { tallyViewCoverage, type ViewCoverage } from "./planning/viewCoverage.ts";
import { evaluateViewSettles, ViewSettleSignal } from "./viewSettle.ts";

function req(chunkKey: string, lane: ChunkRequest["lane"] = "detail"): ChunkRequest {
  return {
    datasetId: "ds", entityId: "e", imageId: "img", c: 0, level: 0, chunkKey,
    lane, tier: lane === "coarse" ? "coarse" : "detail", priority: 0,
  } as unknown as ChunkRequest;
}

describe("a view's coverage", () => {
  it("counts what each view asks for against what admission let in, a shared chunk for both", () => {
    const coverage = new Map<number, ViewCoverage>();
    const left = [req("a"), req("b")];
    const right = [req("b"), req("c")];
    // Admission let one copy of the shared chunk in, and left `c` out.
    tallyViewCoverage(coverage, new Map([[0, left], [1, right]]), [req("a"), req("b")]);
    tallyViewCoverage(coverage, new Map([[1, [req("d")]]]), [req("d")]);
    expect(coverage.get(0)).toMatchObject({ wanted: 2, short: 0 });
    expect(coverage.get(1)).toMatchObject({ wanted: 3, short: 1 });
    expect(coverage.get(1)!.admitted.map((r) => r.chunkKey)).toEqual(["b", "d"]);
  });
});

describe("a view's settle", () => {
  const coverage = new Map<number, ViewCoverage>([
    [0, { wanted: 1, short: 0, admitted: [req("a")] }],
    [1, { wanted: 2, short: 1, admitted: [req("b")] }],
  ]);

  it("comes once each chunk let in for it is held and on the GPU, with nothing left to draw", () => {
    const onGpu = new Set(["a"]);
    const residency = { holds: () => true, onGpu: (r: ChunkRequest) => onGpu.has(r.chunkKey) };
    expect(evaluateViewSettles(coverage, residency, false)).toEqual([
      { view: 0, settled: true, wanted: 1, short: 0 },
      { view: 1, settled: false, wanted: 2, short: 1 },
    ]);
    onGpu.add("b");
    expect(evaluateViewSettles(coverage, residency, false).every((s) => s.settled)).toBe(true);
    // A frame still to draw holds every view off.
    expect(evaluateViewSettles(coverage, residency, true).some((s) => s.settled)).toBe(false);
  });

  it("tells its readers only when something they show changed", () => {
    const signal = new ViewSettleSignal();
    const listener = vi.fn();
    signal.subscribe(listener);
    const settles = [{ view: 0, settled: false, wanted: 1, short: 0 }];
    signal.publish(settles);
    signal.publish([{ ...settles[0] }]);
    expect(listener).toHaveBeenCalledTimes(1);
    signal.publish([{ ...settles[0], settled: true }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
