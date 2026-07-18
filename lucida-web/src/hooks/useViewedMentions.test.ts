// @vitest-environment happy-dom
//
// Unit tests for the per-browser, per-dataset "viewed mentions" store (issue
// #803). Drives the REAL hook against happy-dom's localStorage to lock the
// contract <MentionsOfMe> + App depend on: viewed ids persist, are scoped by
// dataset, marking is idempotent, and a broken/absent storage degrades to
// "nothing viewed" rather than throwing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useViewedMentions,
  VIEWED_MENTIONS_KEY_PREFIX,
} from "./useViewedMentions.ts";

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useViewedMentions", () => {
  it("starts empty when nothing is persisted", () => {
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    expect(result.current.viewedCommentIds).toEqual([]);
  });

  it("markViewed adds the id and persists it under the dataset key", () => {
    const { result } = renderHook(() => useViewedMentions("ds-1"));

    act(() => result.current.markViewed("c-1"));

    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
    // Persisted as a JSON string[] under the dataset-scoped key.
    const raw = localStorage.getItem(`${VIEWED_MENTIONS_KEY_PREFIX}ds-1`);
    expect(JSON.parse(raw ?? "null")).toEqual(["c-1"]);
  });

  it("seeds from persisted storage on mount (next-visit reuse)", () => {
    localStorage.setItem(
      `${VIEWED_MENTIONS_KEY_PREFIX}ds-1`,
      JSON.stringify(["c-1", "c-2"]),
    );
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    expect(new Set(result.current.viewedCommentIds)).toEqual(
      new Set(["c-1", "c-2"]),
    );
  });

  it("markViewed is idempotent: same id twice keeps a stable array reference", () => {
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    act(() => result.current.markViewed("c-1"));
    const first = result.current.viewedCommentIds;
    act(() => result.current.markViewed("c-1"));
    // No churn: identical state object, single entry.
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

    // Switch datasets: the new dataset has its own (empty) read-state.
    rerender({ id: "ds-2" });
    expect(result.current.viewedCommentIds).toEqual([]);
    act(() => result.current.markViewed("c-9"));
    expect(result.current.viewedCommentIds).toEqual(["c-9"]);

    // Switch back: ds-1's read-state is intact and ds-2's never bled in.
    rerender({ id: "ds-1" });
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
  });

  it("keeps a null dataset in memory without creating a cross-dataset sentinel", () => {
    const { result } = renderHook(() => useViewedMentions(null));
    act(() => result.current.markViewed("c-1"));
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
    expect(localStorage.length).toBe(0);
    // A fresh unresolved scope is empty; the host resolves a real id before
    // persistent mention state is used in production.
    const second = renderHook(() => useViewedMentions(null));
    expect(second.result.current.viewedCommentIds).toEqual([]);
  });

  it("degrades to empty (never throws) when reading malformed storage", () => {
    localStorage.setItem(`${VIEWED_MENTIONS_KEY_PREFIX}ds-1`, "not json {");
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    expect(result.current.viewedCommentIds).toEqual([]);
  });

  it("tolerates non-array / non-string persisted values", () => {
    localStorage.setItem(
      `${VIEWED_MENTIONS_KEY_PREFIX}ds-1`,
      JSON.stringify({ nope: true }),
    );
    const a = renderHook(() => useViewedMentions("ds-1"));
    expect(a.result.current.viewedCommentIds).toEqual([]);

    localStorage.setItem(
      `${VIEWED_MENTIONS_KEY_PREFIX}ds-2`,
      JSON.stringify(["ok", 7, null, "ok2"]),
    );
    const b = renderHook(() => useViewedMentions("ds-2"));
    expect(new Set(b.result.current.viewedCommentIds)).toEqual(
      new Set(["ok", "ok2"]),
    );
  });

  it("never throws when localStorage.setItem throws (quota / private browsing)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceeded");
      });
    const { result } = renderHook(() => useViewedMentions("ds-1"));
    // Marking still updates in-memory state without throwing out of the hook.
    expect(() => act(() => result.current.markViewed("c-1"))).not.toThrow();
    expect(result.current.viewedCommentIds).toEqual(["c-1"]);
    spy.mockRestore();
  });
});
