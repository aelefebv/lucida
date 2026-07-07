// @vitest-environment happy-dom
//
// The category/overlay gates are cached in-module: one localStorage read
// at init, write-through on the setters, refresh on cross-tab `storage`
// events. These tests pin that contract — in particular that the per-call
// gate (`isDebugEnabled`, which sits on bridge/cache/render hot paths)
// never touches localStorage — plus the persisted-format semantics
// (`debug` key, comma list, `*` shorthand).

import { describe, it, expect, beforeEach, vi } from "vitest";

type LoggingModule = typeof import("./logging.ts");

/** Import a fresh module instance so init-time reads see the seeded storage. */
async function importLogging(): Promise<LoggingModule> {
  return await import("./logging.ts");
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("debug category gate", () => {
  it("reads the persisted set once at module init", async () => {
    localStorage.setItem("debug", "bridge,orch");
    const logging = await importLogging();
    expect(logging.isDebugEnabled("bridge")).toBe(true);
    expect(logging.isDebugEnabled("orch")).toBe(true);
    expect(logging.isDebugEnabled("render")).toBe(false);
  });

  it("expands the `*` shorthand to every category", async () => {
    localStorage.setItem("debug", "*");
    const logging = await importLogging();
    for (const cat of logging.DEBUG_CATEGORIES) {
      expect(logging.isDebugEnabled(cat)).toBe(true);
    }
  });

  it("isDebugEnabled performs no localStorage reads per call", async () => {
    localStorage.setItem("debug", "cache");
    const logging = await importLogging();
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    for (let i = 0; i < 100; i++) {
      logging.isDebugEnabled("cache");
      logging.isDebugEnabled("bridge");
    }
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it("setDebugEnabled writes through to storage and the cached gate", async () => {
    const logging = await importLogging();
    logging.setDebugEnabled("wasm", true);
    expect(logging.isDebugEnabled("wasm")).toBe(true);
    expect(localStorage.getItem("debug")).toContain("wasm");

    logging.setDebugEnabled("wasm", false);
    expect(logging.isDebugEnabled("wasm")).toBe(false);
    // Empty set removes the key entirely (the documented contract).
    expect(localStorage.getItem("debug")).toBeNull();
  });

  it("setDebugEnabled notifies subscribers with the enabled list", async () => {
    const logging = await importLogging();
    const seen: string[][] = [];
    const off = logging.onDebugCategoriesChanged((cats) => seen.push([...cats]));
    logging.setDebugEnabled("render", true);
    expect(seen).toEqual([["render"]]);
    off();
  });

  it("refreshDebugCategories re-reads storage after an out-of-band write", async () => {
    const logging = await importLogging();
    expect(logging.isDebugEnabled("orch")).toBe(false);
    localStorage.setItem("debug", "orch");
    // Cached gate can't see the raw write...
    expect(logging.isDebugEnabled("orch")).toBe(false);
    // ...until the explicit refresh path runs.
    logging.refreshDebugCategories();
    expect(logging.isDebugEnabled("orch")).toBe(true);
  });

  it("a `storage` event for the debug key refreshes the gate and notifies", async () => {
    const logging = await importLogging();
    const seen: string[][] = [];
    logging.onDebugCategoriesChanged((cats) => seen.push([...cats]));

    localStorage.setItem("debug", "bridge");
    window.dispatchEvent(new StorageEvent("storage", { key: "debug" }));

    expect(logging.isDebugEnabled("bridge")).toBe(true);
    expect(seen).toEqual([["bridge"]]);
  });
});

describe("overlay gate", () => {
  it("reads the persisted overlay set once at module init", async () => {
    localStorage.setItem("debug.overlays", "chunkGrid,groupModes");
    const logging = await importLogging();
    expect(logging.isOverlayEnabled("chunkGrid")).toBe(true);
    expect(logging.isOverlayEnabled("groupModes")).toBe(true);
    expect(logging.isOverlayEnabled("renderRadius")).toBe(false);
  });

  it("setOverlayEnabled writes through and fires the change listeners", async () => {
    const logging = await importLogging();
    let fired = 0;
    logging.onOverlaysChanged(() => fired++);
    logging.setOverlayEnabled("renderRadius", true);
    expect(logging.isOverlayEnabled("renderRadius")).toBe(true);
    expect(localStorage.getItem("debug.overlays")).toContain("renderRadius");
    expect(fired).toBe(1);
  });

  it("a `storage` event for the overlays key refreshes the gate", async () => {
    const logging = await importLogging();
    let fired = 0;
    logging.onOverlaysChanged(() => fired++);

    localStorage.setItem("debug.overlays", "chunkGrid");
    window.dispatchEvent(new StorageEvent("storage", { key: "debug.overlays" }));

    expect(logging.isOverlayEnabled("chunkGrid")).toBe(true);
    expect(fired).toBe(1);
  });
});
