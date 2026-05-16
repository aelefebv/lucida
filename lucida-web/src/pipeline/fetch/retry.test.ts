/**
 * Unit tests for typed FetchError + RetryPolicy variants.
 *
 * `classifyFetchError` is the boundary that maps arbitrary throws into
 * typed FetchErrors so the catch block in `CpuCache.fetchAndDecode`
 * can dispatch off `kind` instead of string-matching `message`.
 * Backwards compat: plain `Error` still falls back to the legacy
 * substring rules so untyped throws elsewhere in the stack don't
 * regress; a `debugLog` warning surfaces them for migration.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});
import { debugLog } from "../../debug/logging.ts";

import {
  FetchError,
  classifyFetchError,
  OnceTransientRetry,
  NeverRetry,
} from "./retry.ts";

// ---------------------------------------------------------------------------
// FetchError
// ---------------------------------------------------------------------------

describe("FetchError", () => {
  it("carries the kind, message, and name", () => {
    const err = new FetchError("nope", { kind: "permanent" });
    expect(err.kind).toBe("permanent");
    expect(err.message).toBe("nope");
    expect(err.name).toBe("FetchError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FetchError);
  });

  it("supports all three kinds", () => {
    expect(new FetchError("a", { kind: "permanent" }).kind).toBe("permanent");
    expect(new FetchError("b", { kind: "transient" }).kind).toBe("transient");
    expect(new FetchError("c", { kind: "abort" }).kind).toBe("abort");
  });

  it("chains a cause when provided", () => {
    const underlying = new Error("inner");
    const wrapped = new FetchError("outer", { kind: "permanent", cause: underlying });
    expect(wrapped.cause).toBe(underlying);
  });

  it("omits cause when not provided", () => {
    const err = new FetchError("solo", { kind: "transient" });
    expect(err.cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// classifyFetchError
// ---------------------------------------------------------------------------

describe("classifyFetchError", () => {
  it("returns a FetchError as-is", () => {
    const original = new FetchError("typed", { kind: "permanent" });
    expect(classifyFetchError(original)).toBe(original);
  });

  it("preserves the kind of a re-classified FetchError", () => {
    const transient = new FetchError("blip", { kind: "transient" });
    expect(classifyFetchError(transient).kind).toBe("transient");

    const abort = new FetchError("cancelled", { kind: "abort" });
    expect(classifyFetchError(abort).kind).toBe("abort");
  });

  it("promotes a DOMException AbortError to kind: abort", () => {
    const dom = new DOMException("Aborted", "AbortError");
    const fe = classifyFetchError(dom);
    expect(fe).toBeInstanceOf(FetchError);
    expect(fe.kind).toBe("abort");
    expect(fe.cause).toBe(dom);
  });

  it("classifies a plain Error containing '404' as permanent", () => {
    const fe = classifyFetchError(new Error("404 not found"));
    expect(fe.kind).toBe("permanent");
    expect(fe.message).toBe("404 not found");
  });

  it("classifies a plain Error containing 'malformed' as permanent", () => {
    const fe = classifyFetchError(new Error("malformed response payload"));
    expect(fe.kind).toBe("permanent");
  });

  it("classifies any other plain Error as transient", () => {
    const fe = classifyFetchError(new Error("Network unavailable"));
    expect(fe.kind).toBe("transient");
  });

  it("logs a warning when a plain Error is classified (untyped error)", () => {
    vi.mocked(debugLog).mockClear();
    classifyFetchError(new Error("some untyped failure"));
    const calls = vi.mocked(debugLog).mock.calls.filter(
      (c) => c[1] === "cache.untyped_fetch_error",
    );
    expect(calls.length).toBe(1);
    expect(calls[0][2]).toMatchObject({
      message: "some untyped failure",
      classifiedAs: "transient",
    });
  });

  it("does not log a warning for an already-typed FetchError", () => {
    vi.mocked(debugLog).mockClear();
    classifyFetchError(new FetchError("typed", { kind: "permanent" }));
    const calls = vi.mocked(debugLog).mock.calls.filter(
      (c) => c[1] === "cache.untyped_fetch_error",
    );
    expect(calls.length).toBe(0);
  });

  it("wraps a non-Error value as transient", () => {
    const fe = classifyFetchError("string error");
    expect(fe).toBeInstanceOf(FetchError);
    expect(fe.kind).toBe("transient");
    expect(fe.message).toBe("string error");
  });

  it("wraps null as transient", () => {
    const fe = classifyFetchError(null);
    expect(fe.kind).toBe("transient");
    expect(fe.message).toBe("null");
  });

  it("wraps an arbitrary object as transient", () => {
    const fe = classifyFetchError({ foo: "bar" });
    expect(fe.kind).toBe("transient");
    expect(fe.message).toBe("[object Object]");
  });
});

// ---------------------------------------------------------------------------
// OnceTransientRetry
// ---------------------------------------------------------------------------

describe("OnceTransientRetry", () => {
  it("shouldRetry returns true on transient + attempt < 1", () => {
    const policy = new OnceTransientRetry(500);
    const transient = new FetchError("blip", { kind: "transient" });
    expect(policy.shouldRetry(transient, 0)).toBe(true);
  });

  it("shouldRetry returns false on transient + attempt >= 1", () => {
    const policy = new OnceTransientRetry(500);
    const transient = new FetchError("blip", { kind: "transient" });
    expect(policy.shouldRetry(transient, 1)).toBe(false);
    expect(policy.shouldRetry(transient, 2)).toBe(false);
  });

  it("shouldRetry returns false on permanent", () => {
    const policy = new OnceTransientRetry(500);
    const permanent = new FetchError("404", { kind: "permanent" });
    expect(policy.shouldRetry(permanent, 0)).toBe(false);
  });

  it("shouldRetry returns false on abort", () => {
    const policy = new OnceTransientRetry(500);
    const abort = new FetchError("cancelled", { kind: "abort" });
    expect(policy.shouldRetry(abort, 0)).toBe(false);
  });

  it("delayMs returns the configured constant", () => {
    expect(new OnceTransientRetry(500).delayMs(0)).toBe(500);
    expect(new OnceTransientRetry(1000).delayMs(0)).toBe(1000);
    expect(new OnceTransientRetry(0).delayMs(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NeverRetry
// ---------------------------------------------------------------------------

describe("NeverRetry", () => {
  it("shouldRetry always returns false", () => {
    const policy = new NeverRetry();
    expect(policy.shouldRetry(new FetchError("blip", { kind: "transient" }), 0)).toBe(false);
    expect(policy.shouldRetry(new FetchError("404", { kind: "permanent" }), 0)).toBe(false);
    expect(policy.shouldRetry(new FetchError("cancelled", { kind: "abort" }), 0)).toBe(false);
  });

  it("delayMs always returns 0", () => {
    const policy = new NeverRetry();
    expect(policy.delayMs(0)).toBe(0);
    expect(policy.delayMs(5)).toBe(0);
  });
});
