import { describe, expect, it } from "vitest";
import { GPU_LOAD_DECAY_MS, GpuLoad } from "./gpuLoad.ts";

describe("GpuLoad", () => {
  it("reads about the share of the time frames kept the GPU busy", () => {
    const load = new GpuLoad();
    // 4 ms of passes every 16 ms for two seconds: a quarter.
    for (let at = 0; at <= 2000; at += 16) load.notePass(4, at);
    expect(load.share(2000)).toBeCloseTo(0.25, 1);
    // Back to back.
    const busy = new GpuLoad();
    for (let at = 0; at <= 2000; at += 16) busy.notePass(16, at);
    expect(busy.share(2000)).toBeCloseTo(1, 1);
  });

  it("forgets a pass as it ages", () => {
    const load = new GpuLoad();
    load.notePass(100, 0);
    expect(load.share(0)).toBeCloseTo(100 / GPU_LOAD_DECAY_MS, 6);
    expect(load.share(GPU_LOAD_DECAY_MS)).toBeCloseTo((100 / GPU_LOAD_DECAY_MS) * Math.exp(-1), 6);
    expect(load.share(20 * GPU_LOAD_DECAY_MS)).toBeLessThan(1e-6);
  });

  it("weighs the newest passes most", () => {
    // The same busy time, a heavy second long ago or a light one just now.
    const early = new GpuLoad();
    for (let at = 0; at < 1000; at += 16) early.notePass(12, at);
    const late = new GpuLoad();
    for (let at = 1000; at < 2000; at += 16) late.notePass(4, at);
    expect(early.share(2000)).toBeLessThan(late.share(2000));
  });

  it("knows whether it has timed any pass", () => {
    const load = new GpuLoad();
    expect(load.timed).toBe(false);
    expect(load.share(0)).toBe(0);
    load.notePass(1, 0);
    expect(load.timed).toBe(true);
  });
});
