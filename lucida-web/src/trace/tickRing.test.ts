import { describe, expect, it } from "vitest";

import { TickRing, TickScratch } from "./tickRing.ts";
import { CountedPhaseIndex, TICK_LEVEL_SLOTS, TickCounter } from "./types.ts";

function scratchFor(datasetId: string, detailLane: number): TickScratch {
  const scratch = new TickScratch();
  scratch.reset(datasetId);
  scratch.counters[TickCounter.LaneDetail] = detailLane;
  return scratch;
}

describe("TickScratch", () => {
  it("resets every column so a reused scratch cannot leak the previous tick", () => {
    const scratch = scratchFor("ds", 7);
    scratch.addPlanned(2);
    scratch.setResidency(2, 2, 3);
    scratch.reset("other");

    expect(scratch.datasetId).toBe("other");
    expect(scratch.counters[TickCounter.LaneDetail]).toBe(0);
    expect(scratch.levels[2 * 3]).toBe(0);
    expect(scratch.levelsDropped).toBe(0);
  });

  it("counts levels past the fixed span instead of folding them into a slot", () => {
    const scratch = scratchFor("ds", 0);
    scratch.addPlanned(TICK_LEVEL_SLOTS);
    scratch.setResidency(TICK_LEVEL_SLOTS + 3, 5, 5);

    expect(scratch.levelsDropped).toBe(2);
    expect(scratch.levels.every(v => v === 0)).toBe(true);
  });

  it("starts each tick with no target and no displayed level", () => {
    const scratch = scratchFor("ds", 0);
    scratch.setTargetLevel(1, 2, true);
    scratch.setDisplayedLevel({ min: 2, max: 3 });
    scratch.reset("other");

    const ring = new TickRing(1);
    ring.append(0, scratch, new Uint32Array(3));
    expect(scratch.hasTarget).toBe(false);
    expect(ring.serialise()[0]).toMatchObject({
      targetLevel: null,
      levelPinned: false,
      displayedLevel: null,
    });
  });
});

describe("TickRing", () => {
  it("serialises the counters, the counted phases and only non-empty levels", () => {
    const ring = new TickRing(4);
    const scratch = scratchFor("ds-a", 12);
    scratch.counters[TickCounter.CullingConsidered] = 90;
    for (let i = 0; i < 4; i++) scratch.addPlanned(0);
    scratch.setResidency(0, 2, 1);
    const counted = new Uint32Array(3);
    counted[CountedPhaseIndex.CacheAdmission] = 6;

    ring.append(1_500, scratch, counted);
    const [tick] = ring.serialise();

    expect(tick.atUs).toBe(1_500);
    expect(tick.datasetId).toBe("ds-a");
    expect(tick.counters.laneDetail).toBe(12);
    expect(tick.counters.cullingConsidered).toBe(90);
    expect(tick.counted["cache-admission"]).toBe(6);
    expect(tick.counted["worker-dispatch"]).toBe(0);
    expect(tick.levels).toEqual([{ level: 0, planned: 4, cached: 2, inFlight: 1 }]);
    expect(tick.levelsDropped).toBe(0);
  });

  it("carries the target and displayed level ranges beside the per-level counts", () => {
    const ring = new TickRing(4);
    const scratch = scratchFor("ds-a", 0);
    scratch.setTargetLevel(1, 2, false);
    scratch.setDisplayedLevel({ min: 2, max: 3 });

    ring.append(10, scratch, new Uint32Array(3));
    const [tick] = ring.serialise();

    expect(tick.targetLevel).toEqual({ min: 1, max: 2 });
    expect(tick.levelPinned).toBe(false);
    expect(tick.displayedLevel).toEqual({ min: 2, max: 3 });
  });

  it("reads a pinned target as pinned", () => {
    const ring = new TickRing(4);
    const scratch = scratchFor("ds-a", 0);
    scratch.setTargetLevel(0, 0, true);

    ring.append(10, scratch, new Uint32Array(3));

    expect(ring.serialise()[0]).toMatchObject({
      targetLevel: { min: 0, max: 0 },
      levelPinned: true,
    });
  });

  it("serialises an absent target or displayed level as null rather than level 0", () => {
    const ring = new TickRing(4);
    ring.append(10, scratchFor("ds-a", 0), new Uint32Array(3));

    const [tick] = ring.serialise();
    expect(tick.targetLevel).toBeNull();
    expect(tick.displayedLevel).toBeNull();
    expect(tick.levelPinned).toBe(false);
  });

  it("treats an explicit null displayed level as absent", () => {
    const ring = new TickRing(4);
    const scratch = scratchFor("ds-a", 0);
    scratch.setDisplayedLevel({ min: 1, max: 1 });
    scratch.setDisplayedLevel(null);

    ring.append(10, scratch, new Uint32Array(3));

    expect(ring.serialise()[0].displayedLevel).toBeNull();
  });

  it("drops oldest and reports how many it dropped", () => {
    const ring = new TickRing(2);
    const counted = new Uint32Array(3);
    for (let i = 0; i < 5; i++) ring.append(i, scratchFor(`ds-${i}`, i), counted);

    expect(ring.dropped).toBe(3);
    expect(ring.serialise().map(t => t.datasetId)).toEqual(["ds-3", "ds-4"]);
  });

  it("serialises oldest-first before it has wrapped", () => {
    const ring = new TickRing(4);
    const counted = new Uint32Array(3);
    for (let i = 0; i < 3; i++) ring.append(i * 10, scratchFor(`ds-${i}`, i), counted);

    expect(ring.dropped).toBe(0);
    expect(ring.serialise().map(t => t.atUs)).toEqual([0, 10, 20]);
  });
});
