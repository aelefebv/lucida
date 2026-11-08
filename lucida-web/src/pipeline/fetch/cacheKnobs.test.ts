// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CACHE_KNOB_FIELDS,
  CACHE_KNOB_PREFERENCES,
  readCacheKnobs,
  subscribeCacheKnobs,
} from "./cacheKnobs.ts";
import {
  PREFERENCE_SEED_GLOBAL,
  PREFERENCES_STORAGE_KEY,
  __resetPreferencesForTesting,
  developerToolsPreference,
  resetPreference,
  setPreference,
} from "../../theme/preferences.ts";

const MIB = 1024 * 1024;

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

afterEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

describe("readCacheKnobs", () => {
  it("reads nothing while developer tools are off, whatever is stored", () => {
    setPreference(CACHE_KNOB_PREFERENCES.maxConcurrentFetches, 2);
    expect(readCacheKnobs()).toEqual({});
  });

  it("reads the knobs that are set while developer tools are on", () => {
    setPreference(developerToolsPreference, true);
    expect(readCacheKnobs()).toEqual({});
    setPreference(CACHE_KNOB_PREFERENCES.mainBudgetBytes, 256 * MIB);
    setPreference(CACHE_KNOB_PREFERENCES.maxConcurrentFetches, 4);
    expect(readCacheKnobs()).toEqual({ mainBudgetBytes: 256 * MIB, maxConcurrentFetches: 4 });
  });

  it("reads a stored value that is not a positive number as unset, and lifts a tiny one to its floor", () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        values: {
          "developer.tools": true,
          "cache.mainBudgetBytes": 0,
          "cache.overviewBudgetBytes": -1,
          "cache.maxConcurrentFetches": "4",
          "cache.maxBytesInFlight": 10,
        },
      }),
    );
    __resetPreferencesForTesting();
    expect(readCacheKnobs()).toEqual({ maxBytesInFlight: MIB });
  });

  it("names the same four fields Dev controls edits", () => {
    expect([...CACHE_KNOB_FIELDS]).toEqual([
      "mainBudgetBytes",
      "overviewBudgetBytes",
      "maxConcurrentFetches",
      "maxBytesInFlight",
    ]);
  });
});

describe("subscribeCacheKnobs", () => {
  it("hands over the knobs each time they change, developer tools included, and not otherwise", () => {
    const listener = vi.fn();
    const off = subscribeCacheKnobs(listener);
    setPreference(CACHE_KNOB_PREFERENCES.maxConcurrentFetches, 2);
    expect(listener).not.toHaveBeenCalled();

    setPreference(developerToolsPreference, true);
    expect(listener).toHaveBeenLastCalledWith({ maxConcurrentFetches: 2 });
    resetPreference(CACHE_KNOB_PREFERENCES.maxConcurrentFetches);
    expect(listener).toHaveBeenLastCalledWith({});
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("the trace driver's seed", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PREFERENCE_SEED_GLOBAL];
    window.history.replaceState({}, "", "/");
  });

  it("reaches the capture surface's cache knobs", () => {
    (globalThis as Record<string, unknown>)[PREFERENCE_SEED_GLOBAL] = {
      "developer.tools": true,
      "cache.maxConcurrentFetches": 2,
      "cache.mainBudgetBytes": 128 * MIB,
    };
    window.history.replaceState({}, "", "/?render=1");
    __resetPreferencesForTesting();
    expect(readCacheKnobs()).toEqual({ maxConcurrentFetches: 2, mainBudgetBytes: 128 * MIB });
  });
});
