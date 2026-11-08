import { describe, expect, it } from "vitest";
import {
  AutoContrastFitter,
  CHUNK_SAMPLES,
  chunkSamples,
  fitValues,
  type ChannelFit,
  type FitCache,
} from "./autoContrast.ts";
import type { DatasetManifest, LevelGeometry } from "../manifestTypes.ts";
import type { ChunkRequest, RequestPlan } from "./planning/types.ts";
import type { LaneOutstanding } from "./fetch/types.ts";

describe("chunkSamples", () => {
  it("reads only the part of an edge chunk inside the level", () => {
    // A 4 × 4 chunk with 2 × 3 of it inside the level; the rest is padding.
    const values = new Uint16Array(16);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) values[y * 4 + x] = 10 + y * 4 + x;
    expect(Array.from(chunkSamples(values, [1, 4, 4], [1, 2, 3]))).toEqual([10, 11, 12, 14, 15, 16]);
  });

  it("skips values with no place on the contrast axis", () => {
    const values = new Float32Array([1, Number.NaN, Infinity, -Infinity, -2]);
    expect(Array.from(chunkSamples(values, [1, 1, 5], [1, 1, 5]))).toEqual([1, -2]);
  });

  it("reads a lattice across every axis of a large chunk", () => {
    const values = new Float32Array(64 * 64 * 64);
    for (let i = 0; i < values.length; i++) values[i] = i;
    const read = chunkSamples(values, [64, 64, 64], [64, 64, 64]);
    expect(read.length).toBeLessThanOrEqual(CHUNK_SAMPLES);
    const columns = new Set(Array.from(read, (v) => v % 64));
    const planes = new Set(Array.from(read, (v) => Math.floor(v / 4096)));
    expect(columns.size).toBeGreaterThan(1);
    expect(planes.size).toBeGreaterThan(1);
  });
});

describe("fitValues", () => {
  const ramp = (from: number, count: number) => Float32Array.from({ length: count }, (_, i) => from + i);

  it("takes the 0.1st and 99.9th percentiles and the full range", () => {
    expect(fitValues([ramp(0, 10_000)])).toEqual({ limits: { min: 9, max: 9990 }, range: { min: 0, max: 9999 } });
  });

  it("gives one answer whatever order the chunks come in", () => {
    const parts = [ramp(0, 3000), ramp(5000, 2000), ramp(-700, 1500), Float32Array.of(90_000)];
    const reversed = [...parts].reverse().map((p) => p.slice().reverse());
    expect(fitValues(reversed)).toEqual(fitValues(parts));
  });

  it("widens to the range when the percentiles meet", () => {
    const mostlyZero = new Float32Array(10_000);
    mostlyZero[17] = 300;
    expect(fitValues([mostlyZero])?.limits).toEqual({ min: 0, max: 300 });
  });

  it("has nothing to fit without values", () => {
    expect(fitValues([new Float32Array(0)])).toBeNull();
  });
});

// One image with a source level 0 (a 2 × 2 grid of 4 × 4 chunks) and a
// generated coarse level 1 (one chunk), both in channels 0 and 1.
function level(index: number, size: number): LevelGeometry {
  return {
    level_index: index,
    shape: [1, 2, 1, size, size],
    chunk_shape: [1, 1, 1, 4, 4],
    grid_shape: [1, 2, 1, Math.ceil(size / 4), Math.ceil(size / 4)],
    scale: [1, 1, 1, 2 ** index, 2 ** index],
  };
}

function manifest(generatedCoarse: boolean): DatasetManifest {
  return {
    dataset_id: "ds",
    images: [
      {
        image_id: "img",
        owner: "ent",
        multiscale: {
          axes: [],
          levels: [level(0, 8), level(1, 4)],
          coarse_level_index: 1,
          generated_levels: generatedCoarse ? [{ level_index: 1, role: "coarse" }] : [],
          data_type: "uint16",
        },
      },
    ],
  } as unknown as DatasetManifest;
}

function request(lane: ChunkRequest["lane"], lvl: number, c: number, y: number, x: number): ChunkRequest {
  return {
    datasetId: "ds",
    entityId: "ent",
    imageId: "img",
    level: lvl,
    t: 0,
    c,
    z: 0,
    y,
    x,
    lane,
    tier: lane === "coarse" || lane === "minimap" ? "coarse" : "detail",
    priority: 0,
    chunkKey: `${lvl}/0/${c}/0/${y}/${x}`,
  };
}

const DETAIL = [request("detail", 0, 0, 0, 0), request("detail", 0, 0, 0, 1), request("detail", 0, 0, 1, 0), request("detail", 0, 0, 1, 1)];
const COARSE = request("coarse", 1, 0, 0, 0);

function plan(requests: ChunkRequest[]): RequestPlan {
  return {
    requests,
    activeSet: [
      {
        kind: "tile",
        entityId: "ent",
        imageId: "img",
        mode: "tiles-with-detail",
        detailLevels: [0],
        coarseLevel: 1,
        proxyAvailable: false,
        groupProxyAvailable: false,
      },
    ],
  } as unknown as RequestPlan;
}

/** A CPU cache stand-in: chunks become resident as a test makes them. */
class Cache implements FitCache {
  readonly chunks = new Map<string, { data: ArrayBuffer; dataType: string }>();
  fetching = true;

  hold(req: ChunkRequest, values: number[]): void {
    this.chunks.set(`${req.entityId}/${req.chunkKey}`, { data: Uint16Array.from(values).buffer, dataType: "uint16" });
  }

  cachedSamples(entityId: string, chunkKey: string) {
    return this.chunks.get(`${entityId}/${chunkKey}`);
  }

  laneOutstanding(out: LaneOutstanding): LaneOutstanding {
    out.pending.detail = this.fetching ? 1 : 0;
    return out;
  }
}

/** Sixteen samples from `base` up. */
const block = (base: number) => Array.from({ length: 16 }, (_, i) => base + i * 3);

function run(fitter: AutoContrastFitter, requests: ChunkRequest[], cache: Cache, generated = true): Array<[number, ChannelFit]> {
  const fits: Array<[number, ChannelFit]> = [];
  fitter.update(new Map([["ds", plan(requests)]]), new Map([["ds", { manifest: manifest(generated) }]]), cache, (_, c, fit) => {
    fits.push([c, fit]);
  });
  return fits;
}

describe("AutoContrastFitter", () => {
  it("fits the same limits whatever order the chunks become resident in", () => {
    const settle = (order: number[]) => {
      const fitter = new AutoContrastFitter();
      const cache = new Cache();
      const requests = [...DETAIL, COARSE];
      let last: ChannelFit | null = null;
      for (const i of order) {
        cache.hold(DETAIL[i], block(100 * (i + 1)));
        for (const [, fit] of run(fitter, requests, cache)) last = fit;
      }
      return last;
    };
    const forward = settle([0, 1, 2, 3]);
    expect(forward?.provisional).toBe(false);
    expect(settle([3, 1, 0, 2])).toEqual(forward);
  });

  it("lets a generated coarse level stand in, then fits from the source level alone", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    // The minimap and prefetch lanes are never read, however extreme.
    const minimap = request("minimap", 1, 0, 0, 0);
    const prefetch = { ...request("prefetch", 0, 0, 0, 0), chunkKey: "0/0/0/0/9/9" };
    const requests = [...DETAIL, COARSE, minimap, prefetch];
    cache.hold(prefetch, block(50_000));
    expect(run(fitter, requests, cache)).toEqual([]);

    cache.hold(COARSE, block(9000));
    const [[, standIn]] = run(fitter, requests, cache);
    expect(standIn).toMatchObject({ provisional: true, range: { min: 9000, max: 9045 } });

    // Part of the fit's chunks, with more on the way: the stand-in holds.
    cache.hold(DETAIL[0], block(100));
    cache.hold(DETAIL[1], block(200));
    expect(run(fitter, requests, cache)).toEqual([]);

    cache.hold(DETAIL[2], block(300));
    cache.hold(DETAIL[3], block(400));
    const [[, settled]] = run(fitter, requests, cache);
    expect(settled).toMatchObject({ provisional: false, range: { min: 100, max: 445 } });
    expect(run(fitter, requests, cache)).toEqual([]);
  });

  it("reads a source coarse level, which is resident before the detail", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    cache.hold(COARSE, block(700));
    const [[, fit]] = run(fitter, [...DETAIL, COARSE], cache, false);
    expect(fit).toMatchObject({ provisional: false, range: { min: 700, max: 745 } });
  });

  it("fits from what is resident once the view has nothing left to fetch", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    cache.hold(DETAIL[0], block(100));
    cache.hold(DETAIL[1], block(200));
    expect(run(fitter, DETAIL, cache)).toEqual([]);
    cache.fetching = false;
    const [[, fit]] = run(fitter, DETAIL, cache);
    expect(fit).toMatchObject({ provisional: false, range: { min: 100, max: 245 } });
  });

  it("fits each channel from its own chunks", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    const second = DETAIL.map((req) => request("detail", 0, 1, req.y, req.x));
    DETAIL.forEach((req) => cache.hold(req, block(100)));
    second.forEach((req) => cache.hold(req, block(5000)));
    const fits = run(fitter, [...DETAIL, ...second], cache);
    expect(fits.map(([c, fit]) => [c, fit.range])).toEqual([
      [0, { min: 100, max: 145 }],
      [1, { min: 5000, max: 5045 }],
    ]);
  });

  it("hands the current fits out again after a reset", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    DETAIL.forEach((req) => cache.hold(req, block(100)));
    const first = run(fitter, DETAIL, cache);
    expect(run(fitter, DETAIL, cache)).toEqual([]);
    fitter.reset();
    expect(run(fitter, DETAIL, cache)).toEqual(first);
  });
});
