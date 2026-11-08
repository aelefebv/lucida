import { describe, expect, it } from "vitest";
import {
  CEILING_BUDGETS,
  GPU_TOTAL_FLOOR_BYTES,
  fitBudgets,
  halvedGpuTotal,
  readDeviceMemoryGiB,
} from "./deviceBudget.ts";

const MIB = 1024 * 1024;

function media(matching: string[]) {
  return (query: string) => ({ matches: matching.includes(query) });
}

describe("fitBudgets", () => {
  it("keeps today's budgets on a desktop that reports 8 GiB or more, or nothing", () => {
    expect(fitBudgets(null)).toEqual(CEILING_BUDGETS);
    expect(fitBudgets(8)).toEqual(CEILING_BUDGETS);
    expect(fitBudgets(32)).toEqual(CEILING_BUDGETS);
  });

  it("halves every budget on a device that reports 4 GiB", () => {
    expect(fitBudgets(4)).toEqual({
      gpuTotalBytes: 768 * MIB,
      labelVolumeBytes: 256 * MIB,
      labelTotalVolumeBytes: 256 * MIB,
      cpuMainBytes: 256 * MIB,
      cpuOverviewBytes: 32 * MIB,
      cpuBytesInFlight: 16 * MIB,
    });
  });

  it("stops at a floor on the smallest devices", () => {
    const tiny = fitBudgets(0.25);
    expect(tiny.gpuTotalBytes).toBe(GPU_TOTAL_FLOOR_BYTES);
    expect(tiny.cpuMainBytes).toBe(64 * MIB);
    expect(tiny.cpuBytesInFlight).toBe(8 * MIB);
    for (const [key, bytes] of Object.entries(tiny)) {
      expect(bytes, key).toBeGreaterThan(0);
      expect(bytes, key).toBeLessThanOrEqual(CEILING_BUDGETS[key as keyof typeof CEILING_BUDGETS]);
    }
  });

  it("leaves every label atlas room inside the GPU total", () => {
    for (const memory of [null, 8, 4, 2, 1, 0.25]) {
      const budgets = fitBudgets(memory);
      expect(budgets.labelTotalVolumeBytes, String(memory)).toBeLessThan(budgets.gpuTotalBytes);
    }
  });
});

describe("halvedGpuTotal", () => {
  it("halves the total after an out-of-memory failure, down to the floor and no further", () => {
    expect(halvedGpuTotal(1536 * MIB)).toBe(768 * MIB);
    expect(halvedGpuTotal(300 * MIB)).toBe(GPU_TOTAL_FLOOR_BYTES);
    expect(halvedGpuTotal(GPU_TOTAL_FLOOR_BYTES)).toBe(GPU_TOTAL_FLOOR_BYTES);
  });
});

describe("readDeviceMemoryGiB", () => {
  it("takes the reported figure", () => {
    expect(readDeviceMemoryGiB({ deviceMemory: 4 })).toBe(4);
    expect(readDeviceMemoryGiB({ deviceMemory: 0.5, matchMedia: media(["(pointer: coarse)"]) })).toBe(0.5);
  });

  it("assumes 4 GiB for a touch-only device that reports nothing", () => {
    expect(readDeviceMemoryGiB({ matchMedia: media(["(pointer: coarse)"]) })).toBe(4);
  });

  it("knows nothing of a device with a fine pointer that reports nothing", () => {
    expect(readDeviceMemoryGiB({ matchMedia: media(["(pointer: fine)", "(any-pointer: fine)"]) })).toBeNull();
    // A tablet with a trackpad attached has a fine pointer too.
    expect(readDeviceMemoryGiB({ matchMedia: media(["(pointer: coarse)", "(any-pointer: fine)"]) })).toBeNull();
    expect(readDeviceMemoryGiB({})).toBeNull();
  });

  it("ignores a reading that isn't a positive number", () => {
    expect(readDeviceMemoryGiB({ deviceMemory: 0 })).toBeNull();
    expect(readDeviceMemoryGiB({ deviceMemory: Number.NaN })).toBeNull();
    expect(readDeviceMemoryGiB({ deviceMemory: "8" })).toBeNull();
  });
});
