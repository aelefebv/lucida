import { describe, it, expect } from "vitest";
import { TimeWindow } from "./timeWindow.ts";

interface Entry {
  at: number;
  v: number;
}

const entry = (at: number, v = at): Entry => ({ at, v });

/**
 * How many slots still hold an entry. Reaches into the backing store because
 * "a pruned entry is no longer referenced" is not observable from the public
 * surface, and a buffer that quietly retains everything it pruned is a leak.
 */
const liveSlots = (w: TimeWindow<Entry>): number =>
  (w as unknown as { slots: Array<Entry | undefined> }).slots.filter(Boolean)
    .length;

describe("TimeWindow", () => {
  it("starts empty", () => {
    const w = new TimeWindow<Entry>();
    expect(w.length).toBe(0);
    expect(w.toArray()).toEqual([]);
  });

  it("keeps push order", () => {
    const w = new TimeWindow<Entry>(4);
    w.push(entry(1));
    w.push(entry(2));
    w.push(entry(3));
    expect(w.length).toBe(3);
    expect(w.toArray().map((e) => e.v)).toEqual([1, 2, 3]);
  });

  it("prunes entries stamped strictly before the cutoff", () => {
    const w = new TimeWindow<Entry>(8);
    for (const at of [10, 20, 30, 40]) w.push(entry(at));
    w.pruneBefore(30);
    // 30 is not "before" 30 — the cutoff is inclusive of its own timestamp.
    expect(w.toArray().map((e) => e.v)).toEqual([30, 40]);
    expect(w.length).toBe(2);
  });

  it("prunes nothing when every entry is at or after the cutoff", () => {
    const w = new TimeWindow<Entry>(4);
    w.push(entry(100));
    w.push(entry(200));
    w.pruneBefore(50);
    expect(w.toArray().map((e) => e.v)).toEqual([100, 200]);
  });

  it("empties fully when every entry is before the cutoff", () => {
    const w = new TimeWindow<Entry>(4);
    for (const at of [1, 2, 3]) w.push(entry(at));
    w.pruneBefore(1000);
    expect(w.length).toBe(0);
    expect(w.toArray()).toEqual([]);
  });

  it("reuses freed slots so a steady push/prune cycle does not grow", () => {
    const w = new TimeWindow<Entry>(4);
    // 200 pushes through a window that only ever holds 2 entries.
    for (let t = 0; t < 200; t++) {
      w.push(entry(t));
      w.pruneBefore(t - 1);
      expect(w.length).toBeLessThanOrEqual(2);
    }
    expect(w.toArray().map((e) => e.v)).toEqual([198, 199]);
  });

  it("grows past its initial capacity without losing or reordering entries", () => {
    const w = new TimeWindow<Entry>(2);
    for (let t = 0; t < 100; t++) w.push(entry(t));
    expect(w.length).toBe(100);
    expect(w.toArray().map((e) => e.v)).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
  });

  it("grows correctly when the live entries wrap around the end of storage", () => {
    const w = new TimeWindow<Entry>(4);
    // Advance the head so the live region straddles the storage boundary.
    for (const at of [1, 2, 3]) w.push(entry(at));
    w.pruneBefore(3);
    for (let t = 4; t < 20; t++) w.push(entry(t));
    expect(w.toArray().map((e) => e.v)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 3),
    );
  });

  it("visits every live entry oldest-first via forEach", () => {
    const w = new TimeWindow<Entry>(4);
    for (const at of [1, 2, 3, 4, 5]) w.push(entry(at));
    w.pruneBefore(3);
    const seen: number[] = [];
    w.forEach((e) => seen.push(e.v));
    expect(seen).toEqual([3, 4, 5]);
  });

  it("drops its reference to a pruned entry", () => {
    const w = new TimeWindow<Entry>(4);
    w.push(entry(1));
    w.push(entry(2));
    w.pruneBefore(2);
    expect(w.toArray().map((e) => e.v)).toEqual([2]);
    // The buffer must not go on retaining the pruned entry: one live slot,
    // one live entry. (Capacity 4, so no shrink to muddy the count.)
    expect(w.capacity).toBe(4);
    expect(liveSlots(w)).toBe(1);
  });

  it("gives storage back after a burst subsides", () => {
    const w = new TimeWindow<Entry>(4);
    for (let t = 0; t < 10_000; t++) w.push(entry(t));
    const peak = w.capacity;
    expect(peak).toBeGreaterThanOrEqual(10_000);
    w.pruneBefore(9_999);
    expect(w.toArray().map((e) => e.v)).toEqual([9_999]);
    // Shrinks by halves, so one prune won't get all the way down — but it
    // must be a small fraction of the peak, not still burst-sized.
    for (let t = 10_000; t < 10_100; t++) {
      w.push(entry(t));
      w.pruneBefore(t);
    }
    expect(w.capacity).toBeLessThan(peak / 8);
  });

  it("does not thrash storage at a steady push/prune rate", () => {
    const w = new TimeWindow<Entry>(4);
    // Steady state: 50 entries resident, forever.
    for (let t = 0; t < 500; t++) {
      w.push(entry(t));
      w.pruneBefore(t - 49);
    }
    const settled = w.capacity;
    for (let t = 500; t < 5_000; t++) {
      w.push(entry(t));
      w.pruneBefore(t - 49);
      expect(w.capacity).toBe(settled);
    }
    expect(w.length).toBe(50);
  });
});
