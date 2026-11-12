import { describe, expect, it } from "vitest";
import {
  AutoContrastFitter,
  CHUNK_SAMPLES,
  chunkSamples,
  fitHistograms,
  fitValues,
  lattice,
  type ChannelFit,
  type FitCache,
  type FitHistograms,
} from "./autoContrast.ts";
import type { HistogramBin } from "./generatedAvailability.ts";
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

describe("fitHistograms", () => {
  /** One bin per value, as the server bins every integer below 128. */
  const exact = (values: number[]): { bins: HistogramBin[] } => {
    const counts = new Map<number, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return { bins: [...counts].sort((a, b) => a[0] - b[0]).map(([v, n]) => [v, v, n] as const) };
  };

  it("takes the percentiles fitValues takes", () => {
    const values = Array.from({ length: 10_000 }, (_, i) => i % 120);
    expect(fitHistograms([exact(values)])).toEqual(fitValues([lattice(Float32Array.from(values))]));
  });

  it("takes a bin's near edge, so a limit is a sample and clips no more than its percentile", () => {
    const bins: HistogramBin[] = [
      [0, 0, 20],
      [1000, 1015, 9_960],
      [4096, 4160, 20],
    ];
    expect(fitHistograms([{ bins }])).toEqual({ limits: { min: 0, max: 4160 }, range: { min: 0, max: 4160 } });
    const wide: HistogramBin[] = [
      [0, 0, 1],
      [1000, 1015, 99_998],
      [4096, 4160, 1],
    ];
    expect(fitHistograms([{ bins: wide }])?.limits).toEqual({ min: 1000, max: 1015 });
  });

  it("gives one answer whatever order the histograms come in", () => {
    const a = exact([1, 2, 2, 3, 90]);
    const b = { bins: [[2, 2, 7], [64, 65, 3]] as HistogramBin[] };
    const c = exact(Array.from({ length: 3000 }, (_, i) => i % 127));
    expect(fitHistograms([c, b, a])).toEqual(fitHistograms([a, b, c]));
  });

  it("widens to the range when the percentiles meet, and has nothing to fit without samples", () => {
    expect(fitHistograms([{ bins: [[0, 0, 9_999], [300, 300, 1]] }])?.limits).toEqual({ min: 0, max: 300 });
    expect(fitHistograms([{ bins: [] }])).toBeNull();
  });
});

describe("fitValues", () => {
  const ramp = (from: number, count: number) => lattice(Float32Array.from({ length: count }, (_, i) => from + i));

  it("takes the 0.1st and 99.9th percentiles and the full range", () => {
    expect(fitValues([ramp(0, 10_000)])).toEqual({ limits: { min: 9, max: 9990 }, range: { min: 0, max: 9999 } });
  });

  it("gives one answer whatever order the chunks come in", () => {
    const parts = [ramp(0, 3000), ramp(5000, 2000), ramp(-700, 1500), lattice(Float32Array.of(90_000))];
    const reversed = [...parts].reverse().map((p) => lattice(p.values.slice().reverse()));
    expect(fitValues(reversed)).toEqual(fitValues(parts));
  });

  it("widens to the range when the percentiles meet", () => {
    const mostlyZero = new Float32Array(10_000);
    mostlyZero[17] = 300;
    expect(fitValues([lattice(mostlyZero)])?.limits).toEqual({ min: 0, max: 300 });
  });

  it("has nothing to fit without values", () => {
    expect(fitValues([lattice(new Float32Array(0))])).toBeNull();
  });

  it("finds the percentiles a sort of the thinned samples finds, for wide and signed fits", () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const kinds: Array<() => number> = [
      () => Math.round(random() * 60_000),
      () => (random() - 0.5) * 1e6,
      () => (random() < 0.5 ? -0 : 0),
      () => (random() < 0.999 ? 100 : random() * 1e9),
      () => random() * 1e-30 - 5e-31,
    ];
    for (const value of kinds) {
      // Wide enough that every chunk is thinned.
      const parts = Array.from({ length: 300 }, () => Float32Array.from({ length: 4096 }, value));
      const total = parts.length * 4096;
      const thin = Math.ceil(total / (1 << 20));
      const sample = parts.flatMap((p) => Array.from(p).filter((_, i) => i % thin === 0)).sort((a, b) => a - b);
      const low = sample[Math.floor(0.001 * (sample.length - 1))];
      const high = sample[Math.ceil(0.999 * (sample.length - 1))];
      let min = Infinity;
      let max = -Infinity;
      for (const p of parts) {
        for (const v of p) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }

      const fit = fitValues(parts.map(lattice));
      expect(fit?.range).toEqual({ min, max });
      expect(fit?.limits).toEqual(high > low ? { min: low, max: high } : { min, max });
    }
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

/** Whether level 1 is a coarse level the server generates, one the source holds, or neither. */
type Coarse = "generated" | "source" | "none";

function manifest(coarse: Coarse): DatasetManifest {
  return {
    dataset_id: "ds",
    images: [
      {
        image_id: "img",
        owner: "ent",
        multiscale: {
          axes: [],
          levels: [level(0, 8), level(1, 4)],
          coarse_level_index: coarse === "none" ? null : 1,
          generated_levels: coarse === "generated" ? [{ level_index: 1, role: "coarse" }] : [],
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
    mode: "slice",
    priority: 0,
    chunkKey: `${lvl}/0/${c}/0/${y}/${x}`,
  };
}

const DETAIL = [request("detail", 0, 0, 0, 0), request("detail", 0, 0, 0, 1), request("detail", 0, 0, 1, 0), request("detail", 0, 0, 1, 1)];
const COARSE = request("coarse", 1, 0, 0, 0);

function plan(requests: ChunkRequest[], coarse: Coarse): RequestPlan {
  return {
    requests,
    activeSet: [
      {
        kind: "tile",
        entityId: "ent",
        imageId: "img",
        detailLevels: [0],
        coarseLevel: coarse === "none" ? null : 1,
      },
    ],
  } as unknown as RequestPlan;
}

/** A CPU cache stand-in: chunks become resident as a test makes them. */
class Cache implements FitCache {
  readonly chunks = new Map<string, { data: ArrayBuffer; dataType: string }>();
  /** Chunk keys the server is still generating. */
  readonly generating = new Set<string>();
  fetching = true;

  awaitsServer(req: ChunkRequest): boolean {
    return this.generating.has(req.chunkKey);
  }

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

/** The server's histograms of the generated level, as they arrive. */
class Histograms implements FitHistograms {
  readonly sent = new Map<string, { bins: HistogramBin[] }>();

  send(c: number, bins: HistogramBin[]): void {
    this.sent.set(`img|1|0|${c}`, { bins });
  }

  histogram(datasetId: string, imageId: string, level: number, t: number, c: number) {
    return datasetId === "ds" ? this.sent.get(`${imageId}|${level}|${t}|${c}`) : undefined;
  }
}

/** Sixteen samples from `base` up. */
const block = (base: number) => Array.from({ length: 16 }, (_, i) => base + i * 3);

function run(
  fitter: AutoContrastFitter,
  requests: ChunkRequest[],
  cache: Cache,
  coarse: Coarse = "generated",
  histograms = new Histograms(),
): Array<[number, ChannelFit]> {
  return fitter
    .update(
      new Map([["ds", plan(requests, coarse)]]),
      new Map([["ds", { manifest: manifest(coarse) }]]),
      cache,
      histograms,
    )
    .map(({ channel, fit }) => [channel, fit]);
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
        for (const [, fit] of run(fitter, requests, cache, "none")) last = fit;
      }
      return last;
    };
    const forward = settle([0, 1, 2, 3]);
    expect(forward?.provisional).toBe(false);
    expect(settle([3, 1, 0, 2])).toEqual(forward);
  });

  it("lets a generated coarse level stand in, then fits from its histogram alone", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    const histograms = new Histograms();
    // The minimap and prefetch lanes are never read, however extreme.
    const minimap = request("minimap", 1, 0, 0, 0);
    const prefetch = { ...request("prefetch", 0, 0, 0, 0), chunkKey: "0/0/0/0/9/9" };
    const requests = [...DETAIL, COARSE, minimap, prefetch];
    cache.hold(prefetch, block(50_000));
    expect(run(fitter, requests, cache, "generated", histograms)).toEqual([]);

    cache.hold(COARSE, block(9000));
    const [[, standIn]] = run(fitter, requests, cache, "generated", histograms);
    expect(standIn).toMatchObject({ provisional: true, range: { min: 9000, max: 9045 } });

    // The view's own chunks, resident while the fetch goes on, change nothing.
    DETAIL.forEach((req, i) => cache.hold(req, block(100 * (i + 1))));
    expect(run(fitter, requests, cache, "generated", histograms)).toEqual([]);

    histograms.send(0, [
      [20, 20, 1],
      [300, 304, 998],
      [600, 609, 1],
    ]);
    const [[, settled]] = run(fitter, requests, cache, "generated", histograms);
    expect(settled).toEqual({ provisional: false, limits: { min: 20, max: 609 }, range: { min: 20, max: 609 } });
    expect(run(fitter, requests, cache, "generated", histograms)).toEqual([]);
  });

  it("keeps a generated level's limits through a pan or zoom, which changes the chunks but not the histogram", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    const histograms = new Histograms();
    histograms.send(0, [[100, 100, 10], [200, 203, 10]]);
    const [[, fit]] = run(fitter, [...DETAIL, COARSE], cache, "generated", histograms);
    expect(fit.provisional).toBe(false);
    // Panned: other chunks of level 0. Zoomed out: level 1 alone.
    const panned = [request("detail", 0, 0, 2, 0), request("detail", 0, 0, 2, 1), COARSE];
    for (const requests of [panned, [request("detail", 1, 0, 0, 0)]]) {
      for (const req of requests) cache.hold(req, block(40_000));
      cache.fetching = false;
      expect(run(fitter, requests, cache, "generated", histograms)).toEqual([]);
    }
  });

  it("reads the source's chunks while no histogram comes, once nothing is left to fetch or generate", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    const histograms = new Histograms();
    DETAIL.forEach((req) => cache.hold(req, block(100)));
    cache.fetching = false;
    // The server is still making the coarse level, and its histogram with it.
    cache.generating.add(COARSE.chunkKey);
    expect(run(fitter, [...DETAIL, COARSE], cache, "generated", histograms)).toEqual([]);

    cache.generating.clear();
    const [[, fallback]] = run(fitter, [...DETAIL, COARSE], cache, "generated", histograms);
    expect(fallback).toMatchObject({ provisional: true, range: { min: 100, max: 145 } });
    // It holds through a pan until the histogram comes.
    const panned = [request("detail", 0, 0, 2, 0), COARSE];
    cache.hold(panned[0], block(7000));
    expect(run(fitter, panned, cache, "generated", histograms)).toEqual([]);
    histograms.send(0, [[50, 50, 4]]);
    const [[, settled]] = run(fitter, panned, cache, "generated", histograms);
    expect(settled).toMatchObject({ provisional: false, range: { min: 50, max: 50 } });
  });

  it("never reads a histogram for a source coarse level", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    const histograms = new Histograms();
    histograms.send(0, [[60_000, 60_000, 4]]);
    cache.hold(COARSE, block(700));
    const [[, fit]] = run(fitter, [...DETAIL, COARSE], cache, "source", histograms);
    expect(fit.range).toEqual({ min: 700, max: 745 });
  });

  it("reads a source coarse level, which is resident before the detail", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    cache.hold(COARSE, block(700));
    const [[, fit]] = run(fitter, [...DETAIL, COARSE], cache, "source");
    expect(fit).toMatchObject({ provisional: false, range: { min: 700, max: 745 } });
  });

  it("fits from what is resident once the view has nothing left to fetch", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    cache.hold(DETAIL[0], block(100));
    cache.hold(DETAIL[1], block(200));
    expect(run(fitter, DETAIL, cache, "none")).toEqual([]);
    cache.fetching = false;
    const [[, fit]] = run(fitter, DETAIL, cache, "none");
    expect(fit).toMatchObject({ provisional: false, range: { min: 100, max: 245 } });
  });

  it("fits each channel from its own chunks", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    const second = DETAIL.map((req) => request("detail", 0, 1, req.y, req.x));
    DETAIL.forEach((req) => cache.hold(req, block(100)));
    second.forEach((req) => cache.hold(req, block(5000)));
    const fits = run(fitter, [...DETAIL, ...second], cache, "none");
    expect(fits.map(([c, fit]) => [c, fit.range])).toEqual([
      [0, { min: 100, max: 145 }],
      [1, { min: 5000, max: 5045 }],
    ]);
  });

  it("hands the current fits out again after a reset", () => {
    const fitter = new AutoContrastFitter();
    const cache = new Cache();
    DETAIL.forEach((req) => cache.hold(req, block(100)));
    const first = run(fitter, DETAIL, cache, "none");
    expect(run(fitter, DETAIL, cache, "none")).toEqual([]);
    fitter.reset();
    expect(run(fitter, DETAIL, cache, "none")).toEqual(first);
  });
});
