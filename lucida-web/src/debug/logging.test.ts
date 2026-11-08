// @vitest-environment happy-dom
//
// The category and overlay gates are preferences cached in memory: the
// per-call gate (`isDebugEnabled`, which sits on bridge/cache/render hot
// paths) never touches storage, and a change from anywhere refreshes the
// cache. The old `debug` and `debug.overlays` keys still set them on the
// next load, which is how a person turns a category on from the console.

import { describe, it, expect, beforeEach, vi } from "vitest";

type LoggingModule = typeof import("./logging.ts");
type PreferencesModule = typeof import("../theme/preferences.ts");

/** A fresh page: new module instances that open storage as it is now. */
async function load(): Promise<{ logging: LoggingModule; preferences: PreferencesModule }> {
  vi.resetModules();
  const preferences = await import("../theme/preferences.ts");
  const logging = await import("./logging.ts");
  return { logging, preferences };
}

beforeEach(() => {
  localStorage.clear();
});

describe("debug category gate", () => {
  it("moves the old comma list into the preference on load", async () => {
    localStorage.setItem("debug", "bridge,orch,nonsense");
    const { logging, preferences } = await load();
    expect(logging.isDebugEnabled("bridge")).toBe(true);
    expect(logging.isDebugEnabled("orch")).toBe(true);
    expect(logging.isDebugEnabled("render")).toBe(false);
    expect(localStorage.getItem("debug")).toBeNull();
    expect(preferences.getPreference(logging.debugCategoriesPreference)).toEqual(["bridge", "orch"]);
  });

  it("expands the `*` shorthand to every category", async () => {
    localStorage.setItem("debug", "*");
    const { logging } = await load();
    for (const cat of logging.DEBUG_CATEGORIES) {
      expect(logging.isDebugEnabled(cat)).toBe(true);
    }
  });

  it("keeps the categories across loads once moved", async () => {
    localStorage.setItem("debug", "cache");
    await load();
    const { logging } = await load();
    expect(logging.isDebugEnabled("cache")).toBe(true);
  });

  it("isDebugEnabled performs no storage reads per call", async () => {
    localStorage.setItem("debug", "cache");
    const { logging } = await load();
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    for (let i = 0; i < 100; i++) {
      logging.isDebugEnabled("cache");
      logging.isDebugEnabled("bridge");
    }
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it("setDebugCategories updates the gate and notifies subscribers with the enabled list", async () => {
    const { logging } = await load();
    const seen: string[][] = [];
    const off = logging.onDebugCategoriesChanged((cats) => seen.push([...cats]));
    logging.setDebugCategories(["render"]);
    expect(logging.isDebugEnabled("render")).toBe(true);
    expect(seen).toEqual([["render"]]);
    off();
  });

  it("a write from another tab refreshes the gate and notifies", async () => {
    const { logging, preferences } = await load();
    const seen: string[][] = [];
    logging.onDebugCategoriesChanged((cats) => seen.push([...cats]));

    localStorage.setItem(
      preferences.PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, values: { "debug.categories": ["bridge"] } }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: preferences.PREFERENCES_STORAGE_KEY }));

    expect(logging.isDebugEnabled("bridge")).toBe(true);
    expect(seen).toEqual([["bridge"]]);
  });
});

describe("overlay gate", () => {
  it("moves the old overlay list into the preference on load", async () => {
    localStorage.setItem("debug.overlays", "chunkGrid,groupModes");
    const { logging } = await load();
    expect(logging.isOverlayEnabled("chunkGrid")).toBe(true);
    expect(logging.isOverlayEnabled("groupModes")).toBe(true);
    expect(logging.isOverlayEnabled("renderRadius")).toBe(false);
    expect(localStorage.getItem("debug.overlays")).toBeNull();
  });

  it("setOverlayEnabled persists and fires the change listeners", async () => {
    const { logging, preferences } = await load();
    let fired = 0;
    logging.onOverlaysChanged(() => fired++);
    logging.setOverlayEnabled("renderRadius", true);
    expect(logging.isOverlayEnabled("renderRadius")).toBe(true);
    expect(preferences.getPreference(logging.debugOverlaysPreference)).toEqual(["renderRadius"]);
    expect(fired).toBe(1);
    logging.setOverlayEnabled("renderRadius", false);
    expect(logging.isOverlayEnabled("renderRadius")).toBe(false);
  });

  it("a write from another tab refreshes the gate", async () => {
    const { logging, preferences } = await load();
    let fired = 0;
    logging.onOverlaysChanged(() => fired++);

    localStorage.setItem(
      preferences.PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, values: { "debug.overlays": ["chunkGrid"] } }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: preferences.PREFERENCES_STORAGE_KEY }));

    expect(logging.isOverlayEnabled("chunkGrid")).toBe(true);
    expect(fired).toBe(1);
  });
});
