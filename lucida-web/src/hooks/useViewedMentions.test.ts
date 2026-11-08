// @vitest-environment happy-dom
//
// Drives the real hook against happy-dom's localStorage: viewed ids persist,
// are scoped by dataset, marking is idempotent, broken storage never throws,
// and the old per-dataset keys move into the preference once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useViewedMentions, viewedMentionsPreference } from "./useViewedMentions.ts";
import { __resetPreferencesForTesting, getPreference } from "../theme/preferences.ts";

const LEGACY_PREFIX = "lucida.mentions.viewed.";

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});
afterEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  vi.restoreAllMocks();
});

describe("useViewedMentions", () => {
  it("starts empty when nothing is persisted", () => {
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    expect(result.current.viewedCommentIds).toEqual([]);
  });

  it("markViewed adds the id and persists it under the dataset", () => {
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    act(() => result.current.markViewed("c-1"));
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
    expect(getPreference(viewedMentionsPreference)).toEqual({ "ds-1": ["c-1"] });

    // A new page load in the same browser reads it back.
    __resetPreferencesForTesting();
    expect(renderHook(() => useViewedMentions("ds-1")).result.current.viewedCommentIds).toEqual(["c-1"]);
  });

  it("markViewed is idempotent: same id twice keeps a stable array reference", () => {
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    act(() => result.current.markViewed("c-1"));
    const first = result.current.viewedCommentIds;
    act(() => result.current.markViewed("c-1"));
    expect(result.current.viewedCommentIds).toBe(first);
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
  });

  it("scopes viewed ids by dataset: one dataset's reads don't bleed into another's", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useViewedMentions(id),
      { initialProps: { id: "ds-1" as string | null } },
    );
    act(() => result.current.markViewed("c-1"));
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);

    rerender({ id: "ds-2" });
    expect(result.current.viewedCommentIds).toEqual([]);
    act(() => result.current.markViewed("c-9"));
    expect(result.current.viewedCommentIds).toEqual(["c-9"]);

    rerender({ id: "ds-1" });
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
  });

  it("a null dataset (no selection) persists under a stable sentinel", () => {
    const { result } = renderHook(() => useViewedMentions(null));
    act(() => result.current.markViewed("c-1"));
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
    const second = renderHook(() => useViewedMentions(null));
    expect(second.result.current.viewedCommentIds).toEqual(["c-1"]);
  });

  it("never throws when localStorage.setItem throws (quota / private browsing)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    expect(() => act(() => result.current.markViewed("c-1"))).not.toThrow();
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
  });
});

describe("the old per-dataset keys", () => {
  it("move into the preference once, keeping only string ids, and are removed", () => {
    localStorage.setItem(`${LEGACY_PREFIX}ds-1`, JSON.stringify(["c-1", "c-2"]));
    localStorage.setItem(`${LEGACY_PREFIX}ds-2`, JSON.stringify(["ok", 7, null, "ok2"]));
    localStorage.setItem(`${LEGACY_PREFIX}__none__`, JSON.stringify(["c-3"]));
    localStorage.setItem(`${LEGACY_PREFIX}ds-3`, "not json {");
    localStorage.setItem(`${LEGACY_PREFIX}ds-4`, JSON.stringify({ nope: true }));
    __resetPreferencesForTesting();

    expect(getPreference(viewedMentionsPreference)).toEqual({
      "ds-1": ["c-1", "c-2"],
      "ds-2": ["ok", "ok2"],
      __none__: ["c-3"],
    });
    expect(renderHook(() => useViewedMentions(null)).result.current.viewedCommentIds).toEqual(["c-3"]);
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.key(i)?.startsWith(LEGACY_PREFIX)).toBe(false);
    }
  });
});
