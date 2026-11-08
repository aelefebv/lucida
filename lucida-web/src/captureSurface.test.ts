// @vitest-environment happy-dom
//
// The `?render=1` predicate. Cheap, but it gates whether a
// headless run writes into a user's workspace, so the exact match matters.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { isCaptureSurface } from "./captureSurface.ts";
import { DEFAULT_PLANNING_CONFIG } from "./pipeline/planning/config.ts";

describe("isCaptureSurface", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is true for render=1", () => {
    expect(isCaptureSurface("?render=1")).toBe(true);
  });

  it("is true alongside other params, in any order", () => {
    expect(isCaptureSurface("?w=abc&render=1")).toBe(true);
    expect(isCaptureSurface("?render=1&w=abc")).toBe(true);
  });

  it("is false when absent", () => {
    expect(isCaptureSurface("")).toBe(false);
    expect(isCaptureSurface("?w=abc")).toBe(false);
  });

  it("is false for any value other than 1 — no truthiness guessing", () => {
    expect(isCaptureSurface("?render=0")).toBe(false);
    expect(isCaptureSurface("?render=true")).toBe(false);
    expect(isCaptureSurface("?render")).toBe(false);
    expect(isCaptureSurface("?render=")).toBe(false);
  });

  it("reads window.location when no search is passed", () => {
    window.history.replaceState(null, "", "/?render=1");
    expect(isCaptureSurface()).toBe(true);
    window.history.replaceState(null, "", "/");
    expect(isCaptureSurface()).toBe(false);
  });
});

describe("user state on the capture surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("reads and writes no storage, so a person's settings and knobs never reach a capture", async () => {
    const personsState: Record<string, string> = {
      "lucida.preferences": JSON.stringify({
        version: 1,
        values: {
          "developer.tools": true,
          "planning.prefetchDepth": 0,
          "planning.depthBiasView": -1,
          "cache.maxConcurrentFetches": 2,
          "annotation.author": "a-person",
          "viewer.restoreLastView": false,
          "debug.categories": ["bridge"],
          "debug.overlays": ["chunkGrid"],
          "mentions.viewed": { "ds-1": ["c-1"] },
        },
      }),
      "lucida.planning.config": JSON.stringify({ schemaVersion: 3, config: { importanceWeight: 99 } }),
      "lucida.restoreLastView": "false",
      "lucida.annotation.author": "an-older-person",
      debug: "*",
      "debug.overlays": "chunkGrid",
      "lucida.mentions.viewed.ds-1": '["c-1"]',
    };
    // A storage holding that state that records every property read off it.
    const backing = new Map(Object.entries(personsState));
    const touched: string[] = [];
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, String(value)),
      removeItem: (key: string) => void backing.delete(key),
      key: (index: number) => [...backing.keys()][index] ?? null,
      clear: () => backing.clear(),
      get length() {
        return backing.size;
      },
    };
    const recording = new Proxy(storage, {
      get(target, property, receiver) {
        touched.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    vi.stubGlobal("localStorage", recording);
    window.history.replaceState(null, "", "/?render=1");

    // A fresh page: every store opens, and runs its migrations, from here.
    vi.resetModules();
    const { configStore } = await import("./pipeline/planning/configStore.ts");
    const { readCacheKnobs } = await import("./pipeline/fetch/cacheKnobs.ts");
    const logging = await import("./debug/logging.ts");
    const lastView = await import("./lastViewPreference.ts");
    const { annotationAuthorId } = await import("./annotationIdentity.ts");
    const { useViewedMentions } = await import("./hooks/useViewedMentions.ts");
    const { getPreference, setPreference, developerToolsPreference } = await import("./theme/preferences.ts");

    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    expect(readCacheKnobs()).toEqual({});
    expect(logging.isDebugEnabled("bridge")).toBe(false);
    expect(logging.isOverlayEnabled("chunkGrid")).toBe(false);
    expect(lastView.getRestoreLastViewEnabled()).toBe(true);
    expect(["a-person", "an-older-person"]).not.toContain(annotationAuthorId());
    const viewed = renderHook(() => useViewedMentions("ds-1"));
    expect(viewed.result.current.viewedCommentIds).toEqual([]);

    // Writes hold for the page and go nowhere.
    setPreference(developerToolsPreference, true);
    configStore.set("depthBiasView", 0.5);
    lastView.setRestoreLastViewEnabled(false);
    logging.setOverlayEnabled("chunkTier", true);
    act(() => viewed.result.current.markViewed("c-2"));
    expect(getPreference(developerToolsPreference)).toBe(true);
    expect(configStore.get()).toEqual({ ...DEFAULT_PLANNING_CONFIG, depthBiasView: 0.5 });
    expect(lastView.getRestoreLastViewEnabled()).toBe(false);

    expect(touched).toEqual([]);
    expect(Object.fromEntries(backing)).toEqual(personsState);

    // The recorder does see storage use, so its silence above means something.
    localStorage.getItem("debug");
    expect(touched).toEqual(["getItem"]);
  }, 30_000);
});
