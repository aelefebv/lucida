import { describe, expect, it, vi } from "vitest";

import {
  CACHE_KNOBS_SCHEMA_VERSION,
  CACHE_KNOBS_STORAGE_KEY,
  CACHE_KNOB_FIELDS,
  readCacheKnobs,
} from "./cacheKnobs.ts";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: (key: string) => (key === CACHE_KNOBS_STORAGE_KEY ? value : null) };
}

describe("readCacheKnobs", () => {
  it("reads the four knobs out of the envelope the driver writes", () => {
    const envelope = {
      schemaVersion: CACHE_KNOBS_SCHEMA_VERSION,
      config: {
        mainBudgetBytes: 256 * 1024 * 1024,
        overviewBudgetBytes: 32 * 1024 * 1024,
        maxConcurrentFetches: 4,
        maxBytesInFlight: 8 * 1024 * 1024,
      },
    };
    expect(readCacheKnobs(storageWith(JSON.stringify(envelope)))).toEqual(envelope.config);
  });

  it("reads a partial envelope as only the knobs it names", () => {
    const envelope = { schemaVersion: CACHE_KNOBS_SCHEMA_VERSION, config: { maxConcurrentFetches: 2 } };
    expect(readCacheKnobs(storageWith(JSON.stringify(envelope)))).toEqual({ maxConcurrentFetches: 2 });
  });

  it("drops fields that are not knobs and values that are not positive finite numbers", () => {
    const envelope = {
      schemaVersion: CACHE_KNOBS_SCHEMA_VERSION,
      config: {
        mainBudgetBytes: 0,
        overviewBudgetBytes: -1,
        maxConcurrentFetches: "4",
        maxBytesInFlight: Number.NaN,
        proxyBudgetBytes: 1024,
        onChunkFailureStreak: "alert()",
      },
    };
    expect(readCacheKnobs(storageWith(JSON.stringify(envelope)))).toEqual({});
  });

  it("reads nothing when the key is missing, unparseable, or of another version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readCacheKnobs(storageWith(null))).toEqual({});
    expect(readCacheKnobs(storageWith("{not json"))).toEqual({});
    expect(
      readCacheKnobs(
        storageWith(JSON.stringify({ schemaVersion: CACHE_KNOBS_SCHEMA_VERSION + 1, config: { maxConcurrentFetches: 2 } })),
      ),
    ).toEqual({});
    expect(readCacheKnobs(null)).toEqual({});
    warn.mockRestore();
  });

  it("names the same four fields Dev controls edits", () => {
    expect([...CACHE_KNOB_FIELDS]).toEqual([
      "mainBudgetBytes",
      "overviewBudgetBytes",
      "maxConcurrentFetches",
      "maxBytesInFlight",
    ]);
  });
});
