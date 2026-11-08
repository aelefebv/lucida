/**
 * The errors the page and its workers raise, heard where each is best seen:
 * uncaught exceptions, promise rejections nothing handled, and
 * `console.error`. The page hands them to one sink, which the trace records.
 *
 * An uncaught exception in a dedicated worker also fires the page's own
 * `error` event, with the worker's script as its file. So a worker reports
 * only what never leaves it, its rejections and its console errors, and the
 * page hears its exceptions for it.
 */

import type { PageErrorSource } from "./trace/types.ts";

export interface ErrorReport {
  source: PageErrorSource;
  message: string;
  /** `file:line:column`, or the worker's script when that is all there is. */
  location: string | null;
}

/** What a worker posts to report an error. */
export interface WorkerErrorMessage extends ErrorReport {
  type: "pageError";
}

/** The parts of a window or a worker's global scope that errors are heard on. */
export interface ErrorScope {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  console: Pick<Console, "error">;
}

let sink: ((report: ErrorReport, count: number) => void) | null = null;

/** Where the page's errors go, or null to drop them. The app sets it once, at startup. */
export function setPageErrorSink(next: ((report: ErrorReport, count: number) => void) | null): void {
  sink = next;
}

/** Hand one error, or `count` folded repeats of it, to the sink. */
export function reportPageError(report: ErrorReport, count = 1): void {
  sink?.(report, count);
}

/**
 * Hear `scope`'s errors and hand each to `report`. `exceptions` is false in a
 * worker, whose uncaught exceptions reach the page. Returns the function that
 * stops listening and puts `console.error` back.
 */
export function watchErrors(
  scope: ErrorScope,
  report: (report: ErrorReport) => void,
  { exceptions = true }: { exceptions?: boolean } = {},
): () => void {
  // A sink that logs would otherwise report its own report, forever.
  let reporting = false;
  const hand = (next: ErrorReport) => {
    if (reporting) return;
    reporting = true;
    try {
      report(next);
    } catch {
      // An error recording an error is not worth a second one.
    } finally {
      reporting = false;
    }
  };

  const onError = (event: Event) => {
    // A resource that failed to load fires a plain `Event`, not an `ErrorEvent`.
    if (!(event instanceof ErrorEvent)) return;
    hand({
      source: "exception",
      message: event.message || describe(event.error),
      location: event.filename ? `${shortUrl(event.filename)}:${event.lineno}:${event.colno}` : stackLocation(event.error),
    });
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    hand({ source: "rejection", message: describe(reason), location: stackLocation(reason) });
  };
  const original = scope.console.error;
  const consoleError = function (this: unknown, ...args: unknown[]) {
    hand({
      source: "console",
      message: args.map(describe).join(" "),
      location: stackLocation(args.find((arg) => arg instanceof Error)),
    });
    return original.apply(this, args);
  };

  if (exceptions) scope.addEventListener("error", onError);
  scope.addEventListener("unhandledrejection", onRejection);
  scope.console.error = consoleError;
  return () => {
    if (exceptions) scope.removeEventListener("error", onError);
    scope.removeEventListener("unhandledrejection", onRejection);
    if (scope.console.error === consoleError) scope.console.error = original;
  };
}

/** The scope a worker runs in, as far as reporting its errors needs. */
export interface WorkerScope extends ErrorScope {
  location: { pathname: string };
  postMessage(message: WorkerErrorMessage): void;
}

/**
 * Report this worker's errors to the page that started it. Call first thing
 * in the worker. Does nothing outside a worker, as when a test imports the
 * worker's module and `self` is a window.
 */
export function reportWorkerErrors(scope: WorkerScope | null = currentWorkerScope()): () => void {
  if (!scope) return () => {};
  const script = scope.location.pathname;
  return watchErrors(
    scope,
    (report) => scope.postMessage({ type: "pageError", ...report, location: report.location ?? script }),
    { exceptions: false },
  );
}

function currentWorkerScope(): WorkerScope | null {
  const workerGlobal = (globalThis as { WorkerGlobalScope?: abstract new () => unknown }).WorkerGlobalScope;
  return workerGlobal && globalThis instanceof workerGlobal ? (globalThis as unknown as WorkerScope) : null;
}

export function isWorkerErrorMessage(data: unknown): data is WorkerErrorMessage {
  const message = data as Partial<WorkerErrorMessage> | null;
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === "pageError" &&
    typeof message.source === "string" &&
    typeof message.message === "string"
  );
}

/**
 * Hand a worker's error report to the page's sink. True when `data` was one,
 * so a worker's own message handler can stop there.
 */
export function takeWorkerError(data: unknown): boolean {
  if (!isWorkerErrorMessage(data)) return false;
  reportPageError({ source: data.source, message: data.message, location: data.location ?? null });
  return true;
}

/** Hand the errors `worker` reports to the page's sink, beside its other message listeners. */
export function hearWorkerErrors(worker: Pick<Worker, "addEventListener">): void {
  worker.addEventListener("message", (event: MessageEvent) => {
    takeWorkerError(event.data);
  });
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The URL's path, since every script a page loads shares its origin. */
function shortUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The first frame of an error's stack, as `file:line:column`, or null. */
function stackLocation(value: unknown): string | null {
  if (!(value instanceof Error) || typeof value.stack !== "string") return null;
  for (const line of value.stack.split("\n")) {
    // Chromium writes `at fn (file:1:2)`; Firefox and Safari write `fn@file:1:2`.
    const frame = /^\s*(?:at (?:.*\()?|[^@]*@)(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (frame) return `${shortUrl(frame[1])}:${frame[2]}:${frame[3]}`;
  }
  return null;
}
