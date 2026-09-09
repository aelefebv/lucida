import { describe, expect, it } from "vitest";

import { ReadingRing } from "./readingRing.ts";
import { ReadingColumn } from "./types.ts";

function reading(queueDepth: number, residentBytes: number): Float64Array {
  const values = new Float64Array(4);
  values[ReadingColumn.QueueDepth] = queueDepth;
  values[ReadingColumn.ResidentBytes] = residentBytes;
  return values;
}

describe("ReadingRing", () => {
  it("serialises a reading by name, at full double precision", () => {
    const ring = new ReadingRing(4);
    const values = new Float64Array(4);
    values[ReadingColumn.QueueDepth] = 1_204;
    values[ReadingColumn.InFlight] = 12;
    values[ReadingColumn.FrameTimeUs] = 16_712.5;
    values[ReadingColumn.ResidentBytes] = 6_000_000_000;

    ring.append(9_500, values, null);

    expect(ring.serialise()).toEqual([
      {
        atUs: 9_500,
        queueDepth: 1_204,
        inFlight: 12,
        frameTimeUs: 16_712.5,
        residentBytes: 6_000_000_000,
      },
    ]);
  });

  it("copies the reading rather than holding the caller's buffer", () => {
    const ring = new ReadingRing(4);
    const values = reading(5, 100);
    ring.append(0, values, null);
    values[ReadingColumn.QueueDepth] = 999;

    expect(ring.serialise()[0].queueDepth).toBe(5);
  });

  it("drops oldest, oldest-first, and says how many it dropped", () => {
    const ring = new ReadingRing(2);
    for (let i = 0; i < 5; i++) ring.append(i * 1_000, reading(i, 0), null);

    expect(ring.dropped).toBe(3);
    expect(ring.serialise().map(sample => sample.queueDepth)).toEqual([3, 4]);
  });

  it("carries a GPU pass time only on the readings that have one", () => {
    const ring = new ReadingRing(4);
    ring.append(1_000, reading(1, 0), 1_250.5);
    ring.append(2_000, reading(2, 0), null);

    const [timed, untimed] = ring.serialise();
    expect(timed.gpuPassUs).toBe(1_250.5);
    expect("gpuPassUs" in untimed).toBe(false);
  });

  it("reads a trailing window newest-back, led by the reading just before it", () => {
    const ring = new ReadingRing(8);
    for (let i = 0; i < 6; i++) ring.append(i * 1_000, reading(i, 0), null);

    // The reading at 2,000 covers the window's first stretch, so it leads.
    const window = ring.serialiseFrom(2_500);
    expect(window.map(sample => sample.atUs)).toEqual([2_000, 3_000, 4_000, 5_000]);

    // A window that starts exactly on a reading still carries the one before
    // it: up to that instant, the earlier reading is the one in force.
    expect(ring.serialiseFrom(3_000).map(sample => sample.atUs)).toEqual([2_000, 3_000, 4_000, 5_000]);
  });

  it("carries nothing before a window that predates the oldest retained reading", () => {
    const ring = new ReadingRing(2);
    for (let i = 0; i < 5; i++) ring.append(i * 1_000, reading(i, 0), null);

    // The ring holds only 3,000 and 4,000, so it cannot say what was true at
    // 1,500. It returns what it holds, and `dropped` is how a reader learns
    // that the window's start went unread.
    expect(ring.serialiseFrom(1_500).map(sample => sample.atUs)).toEqual([3_000, 4_000]);
    expect(ring.dropped).toBe(3);
    expect(new ReadingRing(2).serialiseFrom(0)).toEqual([]);
  });

  it("forgets a GPU pass time when its slot is reused", () => {
    const ring = new ReadingRing(2);
    ring.append(0, reading(0, 0), 900);
    ring.append(1_000, reading(1, 0), 900);
    ring.append(2_000, reading(2, 0), null);

    const samples = ring.serialise();
    expect(samples.map(sample => sample.queueDepth)).toEqual([1, 2]);
    expect(samples[0].gpuPassUs).toBe(900);
    expect("gpuPassUs" in samples[1]).toBe(false);
  });
});
