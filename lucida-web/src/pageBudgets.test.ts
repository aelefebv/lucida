// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GPU_TOTAL_FLOOR_BYTES, fitBudgets, readDeviceFacts } from "./deviceBudget.ts";
import {
  __resetPageBudgetsForTesting,
  gpuBudgetPreference,
  noteAdapter,
  pageDefaultBudgets,
  pageDeviceBudgets,
  subscribePageBudgets,
} from "./pageBudgets.ts";
import {
  __resetPreferencesForTesting,
  getPreference,
  resetPreference,
  setPreference,
} from "./theme/preferences.ts";

const GIB = 1024 * 1024 * 1024;

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetPageBudgetsForTesting();
});

afterEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetPageBudgetsForTesting();
});

describe("the page's budgets", () => {
  it("fit the device, taking an adapter not yet known for a hardware one", () => {
    expect(pageDeviceBudgets()).toEqual(fitBudgets({ ...readDeviceFacts(), fallbackAdapter: null }));
    expect(pageDeviceBudgets()).toEqual(fitBudgets({ ...readDeviceFacts(), fallbackAdapter: false }));
  });

  it("shrink to a phone's when the adapter turns out to be a software one, and say so", () => {
    const listener = vi.fn();
    const stop = subscribePageBudgets(listener);
    const before = pageDeviceBudgets().gpuTotalBytes;
    noteAdapter(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pageDeviceBudgets().gpuTotalBytes).toBeLessThanOrEqual(before);
    expect(pageDeviceBudgets()).toEqual(fitBudgets({ ...readDeviceFacts(), fallbackAdapter: true }));
    noteAdapter(true);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("run under the GPU memory set in Settings, and back to the device's own when it is cleared", () => {
    const listener = vi.fn();
    const stop = subscribePageBudgets(listener);
    setPreference(gpuBudgetPreference, 8 * GIB);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pageDeviceBudgets().gpuTotalBytes).toBe(8 * GIB);
    expect(pageDefaultBudgets()).toEqual(fitBudgets({ ...readDeviceFacts(), fallbackAdapter: null }));
    resetPreference(gpuBudgetPreference);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(pageDeviceBudgets()).toEqual(pageDefaultBudgets());
    stop();
    setPreference(gpuBudgetPreference, 2 * GIB);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keep the GPU memory set in Settings through a reload", () => {
    setPreference(gpuBudgetPreference, 6 * GIB);
    // A reload reopens the store from this browser's storage and reads the
    // device afresh.
    __resetPreferencesForTesting();
    __resetPageBudgetsForTesting();
    expect(getPreference(gpuBudgetPreference)).toBe(6 * GIB);
    expect(pageDeviceBudgets().gpuTotalBytes).toBe(6 * GIB);
  });

  it("read a stored setting below the floor as the floor, and a corrupt one as unset", () => {
    localStorage.setItem("lucida.preferences", JSON.stringify({ version: 1, values: { "memory.gpuBudgetBytes": 1 } }));
    __resetPreferencesForTesting();
    expect(getPreference(gpuBudgetPreference)).toBe(GPU_TOTAL_FLOOR_BYTES);
    localStorage.setItem("lucida.preferences", JSON.stringify({ version: 1, values: { "memory.gpuBudgetBytes": "4" } }));
    __resetPreferencesForTesting();
    expect(getPreference(gpuBudgetPreference)).toBeNull();
  });
});
