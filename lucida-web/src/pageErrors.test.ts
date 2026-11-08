// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reportWorkerErrors,
  setPageErrorSink,
  takeWorkerError,
  watchErrors,
  type ErrorReport,
  type ErrorScope,
  type WorkerErrorMessage,
} from "./pageErrors.ts";

function fakeScope(): ErrorScope & EventTarget & { logged: unknown[][] } {
  const target = new EventTarget() as ErrorScope & EventTarget & { logged: unknown[][] };
  target.logged = [];
  target.console = { error: (...args: unknown[]) => void target.logged.push(args) };
  return target;
}

function rejection(reason: unknown): Event {
  return Object.assign(new Event("unhandledrejection"), { reason });
}

function errorWithStack(message: string, frame: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${frame}\n    at somewhere (http://h/b.js:9:9)`;
  return error;
}

afterEach(() => setPageErrorSink(null));

describe("watchErrors", () => {
  it("hears an uncaught exception with the file it was thrown in", () => {
    const scope = fakeScope();
    const reports: ErrorReport[] = [];
    watchErrors(scope, (report) => reports.push(report));
    scope.dispatchEvent(
      new ErrorEvent("error", { message: "Uncaught TypeError: x", filename: "http://h/assets/gpu.worker-a1.js", lineno: 3, colno: 7 }),
    );
    // A resource that failed to load fires a plain event, which is not an exception.
    scope.dispatchEvent(new Event("error"));
    expect(reports).toEqual([
      { source: "exception", message: "Uncaught TypeError: x", location: "/assets/gpu.worker-a1.js:3:7" },
    ]);
  });

  it("hears a rejection nothing handled, located by its stack's first frame", () => {
    const scope = fakeScope();
    const reports: ErrorReport[] = [];
    watchErrors(scope, (report) => reports.push(report));
    scope.dispatchEvent(rejection(errorWithStack("gone", "load (http://h/assets/index.js:12:34)")));
    scope.dispatchEvent(rejection("a plain reason"));
    expect(reports).toEqual([
      { source: "rejection", message: "Error: gone", location: "/assets/index.js:12:34" },
      { source: "rejection", message: "a plain reason", location: null },
    ]);
  });

  it("hears console.error and still logs it, until it stops listening", () => {
    const scope = fakeScope();
    const reports: ErrorReport[] = [];
    const stop = watchErrors(scope, (report) => reports.push(report));
    scope.console.error("[commands] clash", { id: 2 });
    stop();
    scope.console.error("after");
    scope.dispatchEvent(rejection("after"));
    expect(reports).toEqual([{ source: "console", message: '[commands] clash {"id":2}', location: null }]);
    expect(scope.logged).toEqual([["[commands] clash", { id: 2 }], ["after"]]);
  });

  it("does not report what its own reporter logs", () => {
    const scope = fakeScope();
    const reports: ErrorReport[] = [];
    watchErrors(scope, (report) => {
      reports.push(report);
      scope.console.error("recording failed");
    });
    scope.console.error("first");
    expect(reports.map((report) => report.message)).toEqual(["first"]);
  });

  it("leaves a worker's exceptions to the page, which hears them for it", () => {
    const scope = fakeScope();
    const reports: ErrorReport[] = [];
    watchErrors(scope, (report) => reports.push(report), { exceptions: false });
    scope.dispatchEvent(new ErrorEvent("error", { message: "Uncaught Error: boom" }));
    expect(reports).toEqual([]);
  });
});

describe("a worker's errors", () => {
  it("posts them to the page, named by its script when nothing finer is known", () => {
    const posted: WorkerErrorMessage[] = [];
    const scope = Object.assign(fakeScope(), {
      location: { pathname: "/assets/decode.worker-b2.js" },
      postMessage: (message: WorkerErrorMessage) => void posted.push(message),
    });
    reportWorkerErrors(scope);
    scope.console.error("decode failed");
    expect(posted).toEqual([
      { type: "pageError", source: "console", message: "decode failed", location: "/assets/decode.worker-b2.js" },
    ]);
  });

  it("does nothing outside a worker, where a test imports the worker's module", () => {
    const before = console.error;
    reportWorkerErrors()();
    expect(console.error).toBe(before);
  });

  it("reaches the page's sink, and other messages pass through", () => {
    const sink = vi.fn();
    setPageErrorSink(sink);
    expect(takeWorkerError({ type: "pageError", source: "rejection", message: "Error: lost", location: "/w.js" })).toBe(true);
    expect(takeWorkerError({ id: 3, data: new ArrayBuffer(1) })).toBe(false);
    expect(sink).toHaveBeenCalledExactlyOnceWith({ source: "rejection", message: "Error: lost", location: "/w.js" }, 1);
  });
});
