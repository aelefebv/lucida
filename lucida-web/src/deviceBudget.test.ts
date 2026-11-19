import { describe, expect, it } from "vitest";
import {
  DESKTOP_BUDGETS,
  GPU_TOTAL_FLOOR_BYTES,
  deviceClassOf,
  fitBudgets,
  halvedGpuTotal,
  readDeviceFacts,
  readDeviceMemoryGiB,
  type DeviceFacts,
} from "./deviceBudget.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function media(matching: string[]) {
  return (query: string) => ({ matches: matching.includes(query) });
}

const desktop = (memoryGiB: number | null): DeviceFacts => ({ memoryGiB, touchOnly: false, fallbackAdapter: false });
const phone = (memoryGiB: number): DeviceFacts => ({ memoryGiB, touchOnly: true, fallbackAdapter: false });
const software = (memoryGiB: number | null): DeviceFacts => ({ memoryGiB, touchOnly: false, fallbackAdapter: true });

describe("fitBudgets", () => {
  it("gives a desktop with a hardware adapter and 16 GiB or more a 4 GiB GPU total", () => {
    for (const memory of [16, 32]) {
      expect(fitBudgets(desktop(memory))).toEqual({
        gpuTotalBytes: 4 * GIB,
        labelVolumeBytes: 1365 * MIB,
        labelTotalVolumeBytes: 1365 * MIB,
        cpuMainBytes: 4 * GIB,
        cpuOverviewBytes: 64 * MIB,
        cpuBytesInFlight: 32 * MIB,
      });
    }
    expect(fitBudgets(desktop(32))).toEqual(DESKTOP_BUDGETS);
  });

  it("halves a desktop's budgets at 8 GiB, and takes a desktop that reports nothing for one", () => {
    expect(fitBudgets(desktop(8)).gpuTotalBytes).toBe(2 * GIB);
    expect(fitBudgets(desktop(8)).cpuMainBytes).toBe(2 * GIB);
    expect(fitBudgets(desktop(null))).toEqual(fitBudgets(desktop(8)));
  });

  it("keeps a phone, a tablet and a software adapter to what a phone holds", () => {
    expect(fitBudgets(phone(8))).toMatchObject({ gpuTotalBytes: 1 * GIB, cpuMainBytes: 1 * GIB });
    // Safari reports nothing, which a touch-only device reads as 4 GiB.
    expect(fitBudgets(phone(4))).toEqual({
      gpuTotalBytes: 512 * MIB,
      labelVolumeBytes: 170 * MIB,
      labelTotalVolumeBytes: 170 * MIB,
      cpuMainBytes: 512 * MIB,
      cpuOverviewBytes: 32 * MIB,
      cpuBytesInFlight: 16 * MIB,
    });
    expect(fitBudgets(software(32))).toEqual(fitBudgets(phone(8)));
    expect(fitBudgets(software(null))).toEqual(fitBudgets(phone(8)));
  });

  it("stops at a floor on the smallest devices", () => {
    const tiny = fitBudgets(phone(0.25));
    expect(tiny.gpuTotalBytes).toBe(GPU_TOTAL_FLOOR_BYTES);
    expect(tiny.cpuMainBytes).toBe(64 * MIB);
    expect(tiny.cpuOverviewBytes).toBe(16 * MIB);
    expect(tiny.cpuBytesInFlight).toBe(8 * MIB);
    expect(tiny.labelVolumeBytes).toBe(64 * MIB);
  });

  it("sizes the detail store to hold the whole GPU total, within a quarter of the device's memory", () => {
    for (const facts of [desktop(32), desktop(16), desktop(8), desktop(4), phone(8), phone(4), phone(2), software(16)]) {
      const budgets = fitBudgets(facts);
      const label = JSON.stringify(facts);
      expect(budgets.cpuMainBytes, label).toBeGreaterThanOrEqual(budgets.gpuTotalBytes);
      const inMemory = deviceClassOf(facts) === "desktop"
        ? budgets.cpuMainBytes
        : budgets.cpuMainBytes + budgets.gpuTotalBytes;
      expect(inMemory, label).toBeLessThanOrEqual((facts.memoryGiB! * GIB) / 4);
    }
  });

  it("runs under a GPU total a person set, with the detail store following it up to half the device's memory", () => {
    expect(fitBudgets(desktop(32), 8 * GIB)).toMatchObject({ gpuTotalBytes: 8 * GIB, cpuMainBytes: 8 * GIB });
    expect(fitBudgets(desktop(16), 16 * GIB)).toMatchObject({ gpuTotalBytes: 16 * GIB, cpuMainBytes: 8 * GIB });
    // Lower than the device's own, on a desktop and on a phone.
    expect(fitBudgets(desktop(32), 1 * GIB)).toMatchObject({ gpuTotalBytes: 1 * GIB, cpuMainBytes: 1 * GIB });
    expect(fitBudgets(phone(8), 256 * MIB)).toMatchObject({ gpuTotalBytes: 256 * MIB, cpuMainBytes: 256 * MIB });
    expect(fitBudgets(desktop(32), 1).gpuTotalBytes).toBe(GPU_TOTAL_FLOOR_BYTES);
  });

  it("leaves every label atlas room inside the GPU total, and no larger than one texture may be", () => {
    for (const set of [null, 192 * MIB, 1 * GIB, 4 * GIB, 32 * GIB]) {
      for (const facts of [desktop(32), desktop(8), phone(4), phone(0.25)]) {
        const budgets = fitBudgets(facts, set);
        expect(budgets.labelTotalVolumeBytes).toBeLessThan(budgets.gpuTotalBytes);
        expect(budgets.labelVolumeBytes).toBeLessThanOrEqual(2 * GIB);
      }
    }
  });
});

describe("halvedGpuTotal", () => {
  it("halves the total after an out-of-memory failure, down to the floor and no further", () => {
    expect(halvedGpuTotal(32 * GIB)).toBe(16 * GIB);
    expect(halvedGpuTotal(4 * GIB)).toBe(2 * GIB);
    expect(halvedGpuTotal(1536 * MIB)).toBe(768 * MIB);
    expect(halvedGpuTotal(300 * MIB)).toBe(GPU_TOTAL_FLOOR_BYTES);
    expect(halvedGpuTotal(GPU_TOTAL_FLOOR_BYTES)).toBe(GPU_TOTAL_FLOOR_BYTES);
  });

  it("reaches the floor from the largest total within a few failures", () => {
    let total = 32 * GIB;
    let failures = 0;
    while (total > GPU_TOTAL_FLOOR_BYTES) {
      total = halvedGpuTotal(total);
      failures++;
    }
    expect(failures).toBeLessThanOrEqual(8);
  });
});

describe("readDeviceMemoryGiB", () => {
  it("takes the reported figure", () => {
    expect(readDeviceMemoryGiB({ deviceMemory: 4 })).toBe(4);
    expect(readDeviceMemoryGiB({ deviceMemory: 32 })).toBe(32);
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

describe("readDeviceFacts", () => {
  it("tells a touch-only device from one with a fine pointer", () => {
    expect(readDeviceFacts({ deviceMemory: 8, matchMedia: media(["(pointer: coarse)"]) }))
      .toEqual({ memoryGiB: 8, touchOnly: true });
    expect(readDeviceFacts({ deviceMemory: 8, matchMedia: media(["(pointer: coarse)", "(any-pointer: fine)"]) }))
      .toEqual({ memoryGiB: 8, touchOnly: false });
    expect(readDeviceFacts({})).toEqual({ memoryGiB: null, touchOnly: false });
  });
});
