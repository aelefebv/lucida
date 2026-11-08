/**
 * The four CPU cache knobs Dev controls edits, as preferences. Unset is the
 * cache's own value, fitted to the device. Like the planning knobs, they apply
 * only while developer tools are on.
 */

import {
  definePreference,
  developerToolsPreference,
  getPreference,
  subscribePreferences,
  type Preference,
} from "../../theme/preferences.ts";
import type { CpuCacheConfig } from "./types.ts";

/** The four knobs, in the order Dev controls shows them. */
export const CACHE_KNOB_FIELDS = [
  "mainBudgetBytes",
  "overviewBudgetBytes",
  "maxConcurrentFetches",
  "maxBytesInFlight",
] as const satisfies readonly (keyof CpuCacheConfig)[];

export type CacheKnobField = (typeof CACHE_KNOB_FIELDS)[number];

/** The knobs the cache runs under. Absent means the cache's own value. */
export type CacheKnobs = Partial<Record<CacheKnobField, number>>;

const MIB = 1024 * 1024;

/** A positive number of at least `min`, or null for the cache's own value. */
function cacheKnob(key: string, min: number): Preference<number | null> {
  return definePreference<number | null>(key, null, (raw) =>
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.max(min, raw) : undefined,
  );
}

export const CACHE_KNOB_PREFERENCES: Readonly<Record<CacheKnobField, Preference<number | null>>> = {
  mainBudgetBytes: cacheKnob("cache.mainBudgetBytes", MIB),
  overviewBudgetBytes: cacheKnob("cache.overviewBudgetBytes", MIB),
  maxConcurrentFetches: cacheKnob("cache.maxConcurrentFetches", 1),
  maxBytesInFlight: cacheKnob("cache.maxBytesInFlight", MIB),
};

/** The knobs set, while developer tools are on; none otherwise. */
export function readCacheKnobs(): CacheKnobs {
  const knobs: CacheKnobs = {};
  if (!getPreference(developerToolsPreference)) return knobs;
  for (const field of CACHE_KNOB_FIELDS) {
    const value = getPreference(CACHE_KNOB_PREFERENCES[field]);
    if (value !== null) knobs[field] = value;
  }
  return knobs;
}

function sameKnobs(a: CacheKnobs, b: CacheKnobs): boolean {
  return CACHE_KNOB_FIELDS.every((field) => a[field] === b[field]);
}

/** Calls `listener` with {@link readCacheKnobs} each time what it returns changes. */
export function subscribeCacheKnobs(listener: (knobs: CacheKnobs) => void): () => void {
  let seen = readCacheKnobs();
  return subscribePreferences(() => {
    const next = readCacheKnobs();
    if (sameKnobs(seen, next)) return;
    seen = next;
    listener(next);
  });
}
