import { describe, expect, it } from "vitest";
import { CEILING_BUDGETS, fitBudgets, readDeviceMemoryGiB } from "./deviceBudget.ts";

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
      volumeAtlasBytes: 256 * MIB,
      sliceAtlasBytes: 32 * MIB,
      labelVolumeBytes: 256 * MIB,
      labelTotalVolumeBytes: 256 * MIB,
      cpuMainBytes: 256 * MIB,
      cpuOverviewBytes: 32 * MIB,
      cpuBytesInFlight: 16 * MIB,
    });
  });

  it("stops at a floor on the smallest devices", () => {
    const tiny = fitBudgets(0.25);
    expect(tiny.volumeAtlasBytes).toBe(64 * MIB);
    expect(tiny.cpuMainBytes).toBe(64 * MIB);
    expect(tiny.cpuBytesInFlight).toBe(8 * MIB);
    for (const [key, bytes] of Object.entries(tiny)) {
      expect(bytes, key).toBeGreaterThan(0);
      expect(bytes, key).toBeLessThanOrEqual(CEILING_BUDGETS[key as keyof typeof CEILING_BUDGETS]);
    }
  });

  it("holds the GPU atlases to the adapter's largest buffer", () => {
    const budgets = fitBudgets(8, { maxBufferSize: 256 * MIB });
    expect(budgets.volumeAtlasBytes).toBe(256 * MIB);
    expect(budgets.sliceAtlasBytes).toBe(64 * MIB);
    // The CPU side and the label caps, which the page fits alone, stay put.
    expect(budgets.cpuMainBytes).toBe(CEILING_BUDGETS.cpuMainBytes);
    expect(budgets.labelVolumeBytes).toBe(CEILING_BUDGETS.labelVolumeBytes);
  });

  it("leaves a desktop adapter's atlases at the ceiling", () => {
    expect(fitBudgets(null, { maxBufferSize: 2 * 1024 * MIB })).toEqual(CEILING_BUDGETS);
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
