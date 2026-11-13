// @vitest-environment happy-dom

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm from "lucida-core";
import {
  __resetPreferencesForTesting,
  getPreference,
  PREFERENCES_STORAGE_KEY,
  PREFERENCES_VERSION,
} from "../theme/preferences.ts";
import {
  __resetRecentSourcesForTesting,
  forgetRecentSource,
  noteSourceOpenFailed,
  RECENT_SOURCES_LIMIT,
  recentSourcesPreference,
  rememberRecentSource,
  sourceName,
  withRecentSource,
} from "./recentSources.ts";

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetRecentSourcesForTesting();
});

const recent = () => getPreference(recentSourcesPreference);

describe("withRecentSource", () => {
  it("puts the newest first, moves a repeat to the front, and caps the list", () => {
    let list: readonly string[] = [];
    for (let i = 0; i < RECENT_SOURCES_LIMIT + 2; i++) list = withRecentSource(list, `/d/${i}.zarr`);
    expect(list).toHaveLength(RECENT_SOURCES_LIMIT);
    expect(list[0]).toBe(`/d/${RECENT_SOURCES_LIMIT + 1}.zarr`);
    list = withRecentSource(list, `/d/${RECENT_SOURCES_LIMIT}.zarr`);
    expect(list[0]).toBe(`/d/${RECENT_SOURCES_LIMIT}.zarr`);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("recent sources", () => {
  it("persist per browser", () => {
    rememberRecentSource("/data/a.zarr");
    __resetPreferencesForTesting();
    expect(recent()).toEqual(["/data/a.zarr"]);
  });

  it("read a malformed stored value as empty", () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: PREFERENCES_VERSION, values: { "addData.recent": [1, 2] } }),
    );
    __resetPreferencesForTesting();
    expect(recent()).toEqual([]);
  });

  it("drop a source whose first open failed, matching any spelling of it", () => {
    rememberRecentSource("c:/data/typo.zarr");
    noteSourceOpenFailed("C:\\data\\typo.zarr");
    expect(recent()).toEqual([]);
  });

  it("keep a source an earlier visit recorded when a later open fails", () => {
    rememberRecentSource("gs://bucket/a.zarr");
    __resetRecentSourcesForTesting();
    rememberRecentSource("gs://bucket/a.zarr");
    noteSourceOpenFailed("gs://bucket/a.zarr");
    expect(recent()).toEqual(["gs://bucket/a.zarr"]);
  });

  it("ignore failures of opens that never went through Add data", () => {
    rememberRecentSource("/data/a.zarr");
    noteSourceOpenFailed("/data/other.zarr");
    expect(recent()).toEqual(["/data/a.zarr"]);
  });

  it("can be removed one at a time", () => {
    rememberRecentSource("/data/a.zarr");
    rememberRecentSource("/data/b.zarr");
    forgetRecentSource("/data/a.zarr");
    expect(recent()).toEqual(["/data/b.zarr"]);
  });
});

describe("sourceName", () => {
  it.each([
    ["/data/volume.ome.zarr", "volume.ome.zarr"],
    ["gs://bucket/set/volume.zarr/", "volume.zarr"],
    ["c:/volume.zarr", "volume.zarr"],
    ["/", "/"],
  ])("names %s as %s", (url, name) => {
    expect(sourceName(url)).toBe(name);
  });
});
