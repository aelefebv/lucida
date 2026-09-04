// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configStore } from "./configStore.ts";
import { DEFAULT_PLANNING_CONFIG } from "./config.ts";

const STORAGE_KEY = "lucida.planning.config";

beforeEach(() => {
  // Each test starts from a clean store and an empty localStorage so
  // values from prior tests don't leak in. The singleton's
  // `__resetForTesting` rewinds in-memory state and listeners.
  configStore.__resetForTesting();
  localStorage.clear();
});

afterEach(() => {
  configStore.__resetForTesting();
  localStorage.clear();
});

describe("configStore — initial state", () => {
  it("returns DEFAULT_PLANNING_CONFIG when localStorage is empty", () => {
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });
});

describe("configStore — set", () => {
  it("updates the field and reflects via get", () => {
    configStore.set("prefetchDepth", 99);
    expect(configStore.get().prefetchDepth).toBe(99);
    // Other fields untouched.
    expect(configStore.get().importanceWeight).toBe(
      DEFAULT_PLANNING_CONFIG.importanceWeight,
    );
  });

  it("persists to localStorage under the schema-versioned envelope", () => {
    configStore.set("prefetchDepth", 99);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.config.prefetchDepth).toBe(99);
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.set("prefetchDepth", 99);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the field already has the new value", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.set("prefetchDepth", DEFAULT_PLANNING_CONFIG.prefetchDepth);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("configStore — reset", () => {
  it("reset(field) restores that field to default and notifies", () => {
    configStore.set("prefetchDepth", 99);
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.reset("prefetchDepth");
    expect(configStore.get().prefetchDepth).toBe(
      DEFAULT_PLANNING_CONFIG.prefetchDepth,
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reset() with no arg restores every field to default", () => {
    configStore.set("prefetchDepth", 99);
    configStore.set("distanceWeight", 12);
    configStore.reset();
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("reset() clears localStorage when state matches defaults", () => {
    configStore.set("prefetchDepth", 99);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    configStore.reset();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reset(field) is a no-op when the field is already at default", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.reset("prefetchDepth");
    expect(listener).not.toHaveBeenCalled();
  });

  it("reset(field) leaves other tweaks intact and keeps localStorage populated", () => {
    configStore.set("prefetchDepth", 99);
    configStore.set("distanceWeight", 12);
    configStore.reset("prefetchDepth");
    expect(configStore.get().prefetchDepth).toBe(
      DEFAULT_PLANNING_CONFIG.prefetchDepth,
    );
    expect(configStore.get().distanceWeight).toBe(12);
    // Storage still holds the remaining tweak.
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.config.distanceWeight).toBe(12);
  });
});

describe("configStore — subscribe", () => {
  it("returns an unsubscribe function that removes the listener", () => {
    const listener = vi.fn();
    const unsub = configStore.subscribe(listener);
    configStore.set("prefetchDepth", 99);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    configStore.set("prefetchDepth", 100);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires every subscriber on every change", () => {
    const a = vi.fn();
    const b = vi.fn();
    configStore.subscribe(a);
    configStore.subscribe(b);
    configStore.set("prefetchDepth", 99);
    configStore.set("distanceWeight", 12);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe("configStore — localStorage round-trip on module load", () => {
  it("hydrates from a previously-persisted envelope after reset", async () => {
    // Simulate a prior session writing a tweak.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 3,
        config: { prefetchDepth: 42 },
      }),
    );
    // Re-import to force module re-evaluation.
    vi.resetModules();
    const mod = await import("./configStore.ts");
    expect(mod.configStore.get().prefetchDepth).toBe(42);
    // Other fields default.
    expect(mod.configStore.get().importanceWeight).toBe(
      DEFAULT_PLANNING_CONFIG.importanceWeight,
    );
    mod.configStore.__resetForTesting();
  });

  it("falls back to defaults and logs once on schema-version mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 99,
        config: { prefetchDepth: 42 },
      }),
    );
    vi.resetModules();
    const mod = await import("./configStore.ts");
    expect(mod.configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("schema mismatch");
    mod.configStore.__resetForTesting();
    warn.mockRestore();
  });

  it("falls back to defaults on unparseable JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEY, "{not json");
    vi.resetModules();
    const mod = await import("./configStore.ts");
    expect(mod.configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    expect(warn).toHaveBeenCalled();
    mod.configStore.__resetForTesting();
    warn.mockRestore();
  });

  it("returns defaults when no localStorage key is present", async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import("./configStore.ts");
    expect(mod.configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    mod.configStore.__resetForTesting();
  });

  it("merges partial persisted configs with defaults (forward-compatible)", async () => {
    // Simulate an older snapshot that pre-dates a newly-added field.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 3,
        config: { prefetchDepth: 42 },
      }),
    );
    vi.resetModules();
    const mod = await import("./configStore.ts");
    const cfg = mod.configStore.get();
    expect(cfg.prefetchDepth).toBe(42);
    // Every other field present and default.
    for (const k of Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof typeof DEFAULT_PLANNING_CONFIG)[]) {
      if (k === "prefetchDepth") continue;
      expect(cfg[k]).toBe(DEFAULT_PLANNING_CONFIG[k]);
    }
    mod.configStore.__resetForTesting();
  });
});
