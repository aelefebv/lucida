/**
 * The CPU cache knobs as a page is handed them before it loads.
 *
 * Dev controls writes its four cache knobs onto the live `CpuCache`, and
 * they die on reload (ADR 0052). The trace driver sets every Dev controls
 * knob by name before the page loads (ADR 0051 as amended), and a cache
 * that does not exist yet cannot be written to, so the driver leaves the
 * values here, under one browser-storage key, and the session reads them
 * once when it constructs its cache.
 *
 * Only the driver writes this key. Dev controls never does, so a person's
 * edits stay session-scoped, and the driver's headless profile is thrown
 * away with the browser, so nothing persists from one run to the next.
 *
 * Persistence schema (`localStorage["lucida.cache.config"]`):
 *
 *     { "schemaVersion": 1, "config": { "mainBudgetBytes": 268435456, ... } }
 *
 * Missing, unparseable, or the wrong version reads as nothing set. A field
 * that is not one of the four, or not a positive finite number, is dropped.
 */

import type { CpuCacheConfig } from "./types.ts";

/** Browser-storage key for the envelope. */
export const CACHE_KNOBS_STORAGE_KEY = "lucida.cache.config";

/** Schema version of the envelope. Bump on breaking changes. */
export const CACHE_KNOBS_SCHEMA_VERSION = 1;

/** The four knobs, in the order Dev controls shows them. */
export const CACHE_KNOB_FIELDS = [
  "mainBudgetBytes",
  "overviewBudgetBytes",
  "maxConcurrentFetches",
  "maxBytesInFlight",
] as const satisfies readonly (keyof CpuCacheConfig)[];

export type CacheKnobField = (typeof CACHE_KNOB_FIELDS)[number];

/** The knobs a page was given. Absent means the cache's own default. */
export type CacheKnobs = Partial<Record<CacheKnobField, number>>;

interface Envelope {
  schemaVersion: number;
  config: Partial<Record<string, unknown>>;
}

/**
 * The knobs left in `storage` for this page, or nothing when none were.
 *
 * `storage` defaults to the page's `localStorage` and may be absent, as it
 * is off the main thread and under test, in which case nothing was set.
 */
export function readCacheKnobs(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): CacheKnobs {
  if (!storage) return {};
  let raw: string | null;
  try {
    raw = storage.getItem(CACHE_KNOBS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: Envelope;
  try {
    parsed = JSON.parse(raw) as Envelope;
  } catch {
    console.warn(`[fetch.cacheKnobs] discarded unparseable ${CACHE_KNOBS_STORAGE_KEY}`);
    return {};
  }
  if (!parsed || parsed.schemaVersion !== CACHE_KNOBS_SCHEMA_VERSION) {
    console.warn(
      `[fetch.cacheKnobs] schema mismatch (got ${parsed?.schemaVersion}, want ${CACHE_KNOBS_SCHEMA_VERSION}); ignoring`,
    );
    return {};
  }
  const config = parsed.config;
  if (!config || typeof config !== "object") return {};
  const knobs: CacheKnobs = {};
  for (const field of CACHE_KNOB_FIELDS) {
    const value = config[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      knobs[field] = value;
    }
  }
  return knobs;
}

function defaultStorage(): Pick<Storage, "getItem"> | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
