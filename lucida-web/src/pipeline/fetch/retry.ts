// `FetchError` lets the source own classification; `RetryPolicy`
// makes the retry rule injectable. `classifyFetchError` is the catch-
// block boundary that promotes/wraps non-FetchError throws.

import { debugLog } from "../../debug/logging.ts";

// ---------------------------------------------------------------------------
// FetchError
// ---------------------------------------------------------------------------

/**
 * - `permanent`: same failure on retry — record + surface, no retry.
 * - `transient`: network blip / timeout — eligible for retry.
 * - `abort`: caller cancelled — silent cleanup, no failure entry.
 */
export type FetchErrorKind = "permanent" | "transient" | "abort";

export class FetchError extends Error {
  readonly kind: FetchErrorKind;

  constructor(message: string, opts: { kind: FetchErrorKind; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.kind = opts.kind;
    this.name = "FetchError";
  }
}

/**
 * Map an arbitrary throw into a `FetchError`. Untyped `Error`s are
 * classified by message substring (`404`/`malformed` → permanent;
 * else transient) and logged so they can be migrated to typed throws.
 */
export function classifyFetchError(err: unknown): FetchError {
  if (err instanceof FetchError) {
    return err;
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return new FetchError(err.message || "Aborted", { kind: "abort", cause: err });
  }
  if (err instanceof Error) {
    const isPermanent = err.message.includes("404") || err.message.includes("malformed");
    const kind: FetchErrorKind = isPermanent ? "permanent" : "transient";
    debugLog("cache", "cache.untyped_fetch_error", {
      message: err.message,
      classifiedAs: kind,
    });
    return new FetchError(err.message, { kind, cause: err });
  }
  return new FetchError(String(err), { kind: "transient", cause: err });
}

// ---------------------------------------------------------------------------
// RetryPolicy
// ---------------------------------------------------------------------------

/** `attempt` is the zero-based count of attempts already made. */
export interface RetryPolicy {
  shouldRetry(err: FetchError, attempt: number): boolean;
  delayMs(attempt: number): number;
}

export class OnceTransientRetry implements RetryPolicy {
  private readonly delay: number;

  constructor(delay: number) {
    this.delay = delay;
  }

  shouldRetry(err: FetchError, attempt: number): boolean {
    return err.kind === "transient" && attempt < 1;
  }

  delayMs(_attempt: number): number {
    return this.delay;
  }
}

/** Orchestrator resubmits on the next plan tick if still wanted. */
export class NeverRetry implements RetryPolicy {
  shouldRetry(_err: FetchError, _attempt: number): boolean {
    return false;
  }

  delayMs(_attempt: number): number {
    return 0;
  }
}
