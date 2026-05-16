/**
 * Typed fetch errors + retry policy.
 *
 * `FetchError` lets the source (which knows what kind of error it
 * raised) own the classification. `RetryPolicy` extracts the retry
 * rule so it's unit-testable and injectable: the chunk path uses
 * `OnceTransientRetry` (retry once on transient, never on
 * permanent/abort); the proxy path uses `NeverRetry` (no retries).
 *
 * `classifyFetchError` is the boundary in the catch block: pre-typed
 * `FetchError`s pass through; `DOMException AbortError`s are promoted;
 * plain `Error` messages fall back to message-substring rules for
 * untyped throws elsewhere in the stack; non-`Error` values are
 * wrapped as transient.
 */

import { debugLog } from "../../debug/logging.ts";

// ---------------------------------------------------------------------------
// FetchError
// ---------------------------------------------------------------------------

/**
 * Categorisation of a fetch failure.
 *
 * - `permanent`: the request will fail the same way on retry (404,
 *   malformed payload, missing setup state, etc.). Do not retry;
 *   record in the failure map; surface via telemetry.
 * - `transient`: a network blip or timeout; retry once if the policy
 *   allows. After the final attempt fails, record as transient in the
 *   failure map.
 * - `abort`: the caller intentionally cancelled (signal aborted,
 *   dataset removed). Silent cleanup; no failure-map entry.
 */
export type FetchErrorKind = "permanent" | "transient" | "abort";

/**
 * Typed error raised by `ContentSource` implementations and consumed
 * by `CpuCache`'s fetch error path. The `kind` discriminator drives
 * the retry / failure-map / telemetry dispatch.
 *
 * Use the `cause` option to chain the underlying error (e.g. a
 * `DOMException` from an abort signal) — `Error`'s standard `cause`
 * is preserved via `super(message, { cause })`.
 */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;

  constructor(message: string, opts: { kind: FetchErrorKind; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.kind = opts.kind;
    this.name = "FetchError";
  }
}

/**
 * Map an arbitrary throw into a `FetchError`.
 *
 * 1. Already a `FetchError`? Returned as-is.
 * 2. `DOMException` with `name === "AbortError"`? Promoted to
 *    `FetchError(kind: "abort")`.
 * 3. Plain `Error`? Falls back to message-substring rules for any
 *    caller that still throws a plain `Error`: `404` / `malformed` →
 *    `permanent`; anything else → `transient`. A `debugLog` warning
 *    surfaces untyped errors so they can be migrated to typed
 *    `FetchError`s.
 * 4. Non-`Error` value? Wrapped in
 *    `FetchError(kind: "transient", message: String(err))`.
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

/**
 * Strategy interface for deciding whether to retry a failed fetch
 * and how long to wait before the next attempt.
 *
 * `attempt` is the zero-based count of attempts already made (so
 * `attempt === 0` means "the first try just failed, considering a
 * retry"). Implementations decide both the cap and the delay.
 */
export interface RetryPolicy {
  shouldRetry(err: FetchError, attempt: number): boolean;
  delayMs(attempt: number): number;
}

/**
 * Retry-once policy for transient failures. One retry on a transient
 * error, none on permanent or abort. The delay is a fixed value
 * (the cache constructs this with `TRANSIENT_RETRY_DELAY_MS`).
 */
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

/**
 * No-retry policy for the proxy path: the orchestrator resubmits on
 * the next plan tick if it still wants the proxy, so the fetch path
 * doesn't retry internally.
 */
export class NeverRetry implements RetryPolicy {
  shouldRetry(_err: FetchError, _attempt: number): boolean {
    return false;
  }

  delayMs(_attempt: number): number {
    return 0;
  }
}
