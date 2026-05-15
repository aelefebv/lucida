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
    configStore.set("farThresholdPx", 99);
    expect(configStore.get().farThresholdPx).toBe(99);
    // Other fields untouched.
    expect(configStore.get().detailThresholdPx).toBe(
      DEFAULT_PLANNING_CONFIG.detailThresholdPx,
    );
  });

  it("persists to localStorage under the schema-versioned envelope", () => {
    configStore.set("farThresholdPx", 99);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.config.farThresholdPx).toBe(99);
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.set("farThresholdPx", 99);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the field already has the new value", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.set("farThresholdPx", DEFAULT_PLANNING_CONFIG.farThresholdPx);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("configStore — reset", () => {
  it("reset(field) restores that field to default and notifies", () => {
    configStore.set("farThresholdPx", 99);
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.reset("farThresholdPx");
    expect(configStore.get().farThresholdPx).toBe(
      DEFAULT_PLANNING_CONFIG.farThresholdPx,
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reset() with no arg restores every field to default", () => {
    configStore.set("farThresholdPx", 99);
    configStore.set("hysteresisPx", 12);
    configStore.reset();
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("reset() clears localStorage when state matches defaults", () => {
    configStore.set("farThresholdPx", 99);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    configStore.reset();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reset(field) is a no-op when the field is already at default", () => {
    const listener = vi.fn();
    configStore.subscribe(listener);
    configStore.reset("farThresholdPx");
    expect(listener).not.toHaveBeenCalled();
  });

  it("reset(field) leaves other tweaks intact and keeps localStorage populated", () => {
    configStore.set("farThresholdPx", 99);
    configStore.set("hysteresisPx", 12);
    configStore.reset("farThresholdPx");
    expect(configStore.get().farThresholdPx).toBe(
      DEFAULT_PLANNING_CONFIG.farThresholdPx,
    );
    expect(configStore.get().hysteresisPx).toBe(12);
    // Storage still holds the remaining tweak.
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.config.hysteresisPx).toBe(12);
  });
});

describe("configStore — subscribe", () => {
  it("returns an unsubscribe function that removes the listener", () => {
    const listener = vi.fn();
    const unsub = configStore.subscribe(listener);
    configStore.set("farThresholdPx", 99);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    configStore.set("farThresholdPx", 100);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires every subscriber on every change", () => {
    const a = vi.fn();
    const b = vi.fn();
    configStore.subscribe(a);
    configStore.subscribe(b);
    configStore.set("farThresholdPx", 99);
    configStore.set("hysteresisPx", 12);
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
        schemaVersion: 1,
        config: { farThresholdPx: 42 },
      }),
    );
    // Re-import to force module re-evaluation.
    vi.resetModules();
    const mod = await import("./configStore.ts");
    expect(mod.configStore.get().farThresholdPx).toBe(42);
    // Other fields default.
    expect(mod.configStore.get().detailThresholdPx).toBe(
      DEFAULT_PLANNING_CONFIG.detailThresholdPx,
    );
    mod.configStore.__resetForTesting();
  });

  it("falls back to defaults and logs once on schema-version mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 99,
        config: { farThresholdPx: 42 },
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
        schemaVersion: 1,
        config: { farThresholdPx: 42 },
      }),
    );
    vi.resetModules();
    const mod = await import("./configStore.ts");
    const cfg = mod.configStore.get();
    expect(cfg.farThresholdPx).toBe(42);
    // Every other field present and default.
    for (const k of Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof typeof DEFAULT_PLANNING_CONFIG)[]) {
      if (k === "farThresholdPx") continue;
      expect(cfg[k]).toBe(DEFAULT_PLANNING_CONFIG[k]);
    }
    mod.configStore.__resetForTesting();
  });
});
