import { describe, expect, it } from "vitest";
import { planCompaction, remapSlotEntries } from "./poolCompaction.ts";

describe("planCompaction", () => {
  it("keeps the first chunks of the keep order that fit, moving only those past the new capacity", () => {
    // Eight slots shrinking to four; `a` and `d` sit low, `f` and `h` high.
    const slots = new Map([["a", 0], ["b", 1], ["d", 3], ["f", 5], ["h", 7]]);

    const plan = planCompaction(slots, 4, ["f", "a", "h", "d", "b"]);

    expect([...plan.slots]).toEqual([["a", 0], ["d", 3], ["f", 1], ["h", 2]]);
    expect(plan.dropped).toEqual(["b"]);
    expect(plan.moves).toEqual([{ key: "f", from: 5, to: 1 }, { key: "h", from: 7, to: 2 }]);
    expect(plan.freeSlots).toEqual([]);
  });

  it("leaves the slots it does not fill free, lowest first off the stack", () => {
    const plan = planCompaction(new Map([["a", 6]]), 4, ["a"]);
    expect(plan.slots.get("a")).toBe(0);
    expect(plan.freeSlots.pop()).toBe(1);
  });

  it("ignores keys in the keep order that the pool does not hold", () => {
    const plan = planCompaction(new Map([["a", 0], ["b", 1]]), 1, ["zz", "b", "a"]);
    expect([...plan.slots.keys()]).toEqual(["b"]);
    expect(plan.dropped).toEqual(["a"]);
  });
});

describe("remapSlotEntries", () => {
  it("points a moved chunk's entry at its new slot and empties a dropped one's", () => {
    const slots = new Map([["a", 0], ["b", 1], ["f", 5]]);
    const slotGridIdx = new Int32Array([10, 11, -1, -1, -1, 15, -1, -1]);
    const indirection = new Uint32Array(16).fill(0xFFFFFFFF);
    indirection[10] = 0;
    indirection[11] = 1;
    indirection[15] = 5;
    const plan = planCompaction(slots, 2, ["a", "f"]);

    const next = remapSlotEntries(slots, slotGridIdx, indirection, plan, 2);

    expect(Array.from(next)).toEqual([10, 15]);
    expect(indirection[10]).toBe(0);
    expect(indirection[15]).toBe(1);
    expect(indirection[11]).toBe(0xFFFFFFFF);
  });
});
