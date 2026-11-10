// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configStore, depthBiasPreference, PLANNING_KNOB_PREFERENCES } from "./configStore.ts";
import { DEFAULT_PLANNING_CONFIG } from "./config.ts";
import {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  plan,
} from "./index.ts";
import type { LevelGeometry } from "../../manifestTypes.ts";
import { loadWasm } from "../../viewProperties.ts";
import {
  PREFERENCE_SEED_GLOBAL,
  PREFERENCES_STORAGE_KEY,
  __resetPreferencesForTesting,
  developerToolsPreference,
  getPreference,
  setPreference,
} from "../../theme/preferences.ts";

beforeAll(loadWasm);

const LEGACY_KEY = "lucida.planning.config";

function storedValues(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{"values":{}}').values;
}

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

afterEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

describe("configStore — developer tools gate", () => {
  it("reads the defaults when nothing is stored", () => {
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("applies a stored knob only while developer tools are on", () => {
    configStore.set("prefetchDepth", 0);
    expect(configStore.get().prefetchDepth).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);

    setPreference(developerToolsPreference, true);
    expect(configStore.get().prefetchDepth).toBe(0);

    setPreference(developerToolsPreference, false);
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("applies focal depth whether or not developer tools are on", () => {
    configStore.set("depthBiasView", -0.5);
    expect(configStore.get().depthBiasView).toBe(-0.5);
  });

  it("tells subscribers when turning developer tools on changes the config, and only then", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    setPreference(developerToolsPreference, true);
    expect(listener).not.toHaveBeenCalled();

    configStore.set("importanceWeight", 120);
    expect(listener).toHaveBeenCalledTimes(1);
    setPreference(developerToolsPreference, false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("configStore — set and reset", () => {
  beforeEach(() => setPreference(developerToolsPreference, true));

  it("stores one field as its preference and leaves the others at their defaults", () => {
    configStore.set("prefetchDepth", 4);
    expect(configStore.get()).toEqual({ ...DEFAULT_PLANNING_CONFIG, prefetchDepth: 4 });
    expect(storedValues()["planning.prefetchDepth"]).toBe(4);
  });

  it("returns the same reference until a field changes", () => {
    const first = configStore.get();
    expect(configStore.get()).toBe(first);
    configStore.set("distanceWeight", 12);
    expect(configStore.get()).not.toBe(first);
  });

  it("stores nothing for a field set back to its default", () => {
    configStore.set("prefetchDepth", 4);
    configStore.set("prefetchDepth", DEFAULT_PLANNING_CONFIG.prefetchDepth);
    expect(storedValues()).not.toHaveProperty("planning.prefetchDepth");
  });

  it("resets one field, or every field", () => {
    configStore.set("prefetchDepth", 4);
    configStore.set("distanceWeight", 12);
    configStore.set("depthBiasView", 0.5);
    configStore.reset("prefetchDepth");
    expect(configStore.get().prefetchDepth).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);
    expect(configStore.get().distanceWeight).toBe(12);
    configStore.reset();
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("clamps a stored knob into the range Dev controls offers", () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, values: { "developer.tools": true, "planning.prefetchDepth": 99 } }),
    );
    __resetPreferencesForTesting();
    expect(configStore.get().prefetchDepth).toBe(5);
  });

  it("unsubscribes", () => {
    const listener = vi.fn();
    const off = configStore.subscribe(listener);
    configStore.set("prefetchDepth", 4);
    off();
    configStore.set("prefetchDepth", 3);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("configStore — the old storage key", () => {
  function writeLegacy(config: Record<string, unknown>, schemaVersion = 3): void {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ schemaVersion, config }));
  }

  it("moves each knob into its preference once and removes the old key", () => {
    writeLegacy({ ...DEFAULT_PLANNING_CONFIG, prefetchDepth: 4, depthBiasView: -0.25 });
    __resetPreferencesForTesting();

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(getPreference(PLANNING_KNOB_PREFERENCES.prefetchDepth)).toBe(4);
    expect(getPreference(depthBiasPreference)).toBe(-0.25);
    // The old envelope held every field; only the moved ones become preferences.
    expect(Object.keys(storedValues()).sort()).toEqual(["planning.depthBiasView", "planning.prefetchDepth"]);
    // A migrated knob still waits for developer tools.
    expect(configStore.get().prefetchDepth).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);
  });

  it("drops an envelope of another version, and still removes it", () => {
    writeLegacy({ prefetchDepth: 4 }, 99);
    __resetPreferencesForTesting();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(getPreference(PLANNING_KNOB_PREFERENCES.prefetchDepth)).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);
  });
});

describe("configStore — the seed the trace driver hands the capture surface", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PREFERENCE_SEED_GLOBAL];
    window.history.replaceState({}, "", "/");
  });

  /**
   * The seed is what `lucida trace --prefetch-depth 0` sets before the page
   * loads, and the driver's own test holds its script to that shape.
   * Together they are the browser-free half of "prefetch depth zero from
   * the driver leaves the prefetch lane empty".
   */
  it("starts from the seed, and the plan has no prefetch lane", () => {
    (globalThis as Record<string, unknown>)[PREFERENCE_SEED_GLOBAL] = {
      "developer.tools": true,
      "planning.prefetchDepth": 0,
    };
    window.history.replaceState({}, "", "/?render=1");
    __resetPreferencesForTesting();
    const config = configStore.get();
    expect(config.prefetchDepth).toBe(0);

    // A timeseries with ten timepoints at one level, so the default depth
    // has something to look ahead to and depth zero visibly does not.
    const level0: LevelGeometry = {
      level_index: 0,
      shape: [10, 1, 1, 256, 256],
      chunk_shape: [1, 1, 1, 256, 256],
      grid_shape: [10, 1, 1, 1, 1],
      scale: [1, 1, 1, 1, 1],
    };
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      selection: {
        t: 0,
        z: 0,
        cut: { axis: "z", index: 0 },
        visibleChannels: [0],
        renderMode: "slice",
        interactionState: "idle",
      },
    });
    const driven = plan(snapshot, createSyntheticState(), config);
    expect(driven.requests.some((request) => request.lane === "prefetch")).toBe(false);
    const defaults = plan(snapshot, createSyntheticState(), DEFAULT_PLANNING_CONFIG);
    expect(defaults.requests.some((request) => request.lane === "prefetch")).toBe(true);
  });

  it("ignores the seed off the capture surface", () => {
    (globalThis as Record<string, unknown>)[PREFERENCE_SEED_GLOBAL] = {
      "developer.tools": true,
      "planning.prefetchDepth": 0,
    };
    __resetPreferencesForTesting();
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });
});
