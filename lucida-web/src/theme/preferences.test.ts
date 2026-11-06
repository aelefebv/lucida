// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  PREFERENCES_STORAGE_KEY,
  PREFERENCES_VERSION,
  __resetPreferencesForTesting,
  booleanPreference,
  createPreferenceStore,
  definePreference,
  numberPreference,
  oneOfPreference,
  setPreference,
  usePreference,
} from "./preferences.ts";

const panelOpen = booleanPreference("test.panelOpen", true);
const width = numberPreference("test.width", 280, { min: 200, max: 480 });
const tab = oneOfPreference("test.tab", ["views", "comments", "info"], "views");

function stored(): unknown {
  return JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "null");
}

function writeStored(values: Record<string, unknown>, version = PREFERENCES_VERSION): void {
  localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ version, values }));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

describe("preference store", () => {
  it("reads defaults when nothing is stored", () => {
    const store = createPreferenceStore(localStorage);
    expect(store.get(panelOpen)).toBe(true);
    expect(store.get(width)).toBe(280);
    expect(store.get(tab)).toBe("views");
  });

  it("persists one versioned entry that a new store reads back", () => {
    const store = createPreferenceStore(localStorage);
    store.set(panelOpen, false);
    store.set(tab, "info");
    expect(stored()).toEqual({
      version: PREFERENCES_VERSION,
      values: { "test.panelOpen": false, "test.tab": "info" },
    });
    const reloaded = createPreferenceStore(localStorage);
    expect(reloaded.get(panelOpen)).toBe(false);
    expect(reloaded.get(tab)).toBe("info");
  });

  it("reads a value its parser rejects as the default", () => {
    writeStored({ "test.panelOpen": "yes", "test.tab": "gone", "test.width": "wide" });
    const store = createPreferenceStore(localStorage);
    expect(store.get(panelOpen)).toBe(true);
    expect(store.get(tab)).toBe("views");
    expect(store.get(width)).toBe(280);
  });

  it("clamps a stored number into its range", () => {
    writeStored({ "test.width": 9000 });
    expect(createPreferenceStore(localStorage).get(width)).toBe(480);
  });

  it("survives unparseable storage", () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, "{not json");
    const store = createPreferenceStore(localStorage);
    expect(store.get(panelOpen)).toBe(true);
    store.set(panelOpen, false);
    expect(createPreferenceStore(localStorage).get(panelOpen)).toBe(false);
  });

  it("keeps keys it does not know, so a module not yet loaded loses nothing", () => {
    writeStored({ "elsewhere.thing": 42 });
    createPreferenceStore(localStorage).set(panelOpen, false);
    expect(stored()).toMatchObject({ values: { "elsewhere.thing": 42, "test.panelOpen": false } });
  });

  it("keeps a newer build's version when writing", () => {
    writeStored({ "test.tab": "comments" }, PREFERENCES_VERSION + 3);
    const store = createPreferenceStore(localStorage);
    expect(store.get(tab)).toBe("comments");
    store.set(panelOpen, false);
    expect(stored()).toMatchObject({ version: PREFERENCES_VERSION + 3 });
  });

  it("reset returns a preference to its default", () => {
    const store = createPreferenceStore(localStorage);
    store.set(tab, "info");
    store.reset(tab);
    expect(store.get(tab)).toBe("views");
    expect(stored()).toEqual({ version: PREFERENCES_VERSION, values: {} });
  });

  it("lets defaults be replaced, with stored values still winning", () => {
    const store = createPreferenceStore(localStorage);
    store.setDefaults({ "test.tab": "comments", "test.width": "bad" });
    expect(store.get(tab)).toBe("comments");
    expect(store.get(width)).toBe(280);
    store.set(tab, "info");
    expect(store.get(tab)).toBe("info");
  });

  it("returns the same object until the value changes", () => {
    const point = definePreference<{ x: number }>("test.point", { x: 0 }, (raw) =>
      typeof raw === "object" && raw !== null && typeof (raw as { x?: unknown }).x === "number"
        ? (raw as { x: number })
        : undefined,
    );
    writeStored({ "test.point": { x: 3 } });
    const store = createPreferenceStore(localStorage);
    const first = store.get(point);
    expect(store.get(point)).toBe(first);
    store.set(point, { x: 4 });
    expect(store.get(point)).toEqual({ x: 4 });
  });

  it("notifies subscribers, including for a write from another tab", () => {
    const store = createPreferenceStore(localStorage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(panelOpen, false);
    expect(listener).toHaveBeenCalledTimes(1);

    writeStored({ "test.panelOpen": true, "test.tab": "comments" });
    window.dispatchEvent(new StorageEvent("storage", { key: PREFERENCES_STORAGE_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get(tab)).toBe("comments");
  });

  it("works without storage, from defaults", () => {
    const store = createPreferenceStore(null);
    store.set(tab, "info");
    expect(store.get(tab)).toBe("info");
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it("ignores stored values on the capture surface", () => {
    writeStored({ "test.tab": "info" });
    window.history.replaceState({}, "", "/?render=1");
    try {
      __resetPreferencesForTesting();
      const { result } = renderHook(() => usePreference(tab));
      expect(result.current[0]).toBe("views");
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });
});

describe("usePreference", () => {
  it("reads, writes, and re-renders", () => {
    __resetPreferencesForTesting();
    const { result } = renderHook(() => usePreference(tab));
    expect(result.current[0]).toBe("views");
    act(() => result.current[1]("comments"));
    expect(result.current[0]).toBe("comments");
    act(() => setPreference(tab, "info"));
    expect(result.current[0]).toBe("info");
    expect(stored()).toMatchObject({ values: { "test.tab": "info" } });
  });
});
