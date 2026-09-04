/**
 * Regression guard on `CpuCache.submit` at remote-collection scale
 * (issue #900, ADR 0044).
 *
 * #899 measured `cache.request` running at 107,055/s on a 21,371-member
 * remote collection, and asked whether that churn is a real cost. It is:
 * `submit` re-receives the dataset's complete wanted set on every plan
 * rebuild (`plan.requests_per_submit` p50 = 21,400, ~5 rebuilds/s), and
 * at the time of that measurement one call took **20.5-22.2 ms p50** —
 * roughly 105 ms of main thread per second, on a path that is pure
 * bookkeeping and issues no network work of its own.
 *
 * After the single-derivation pass and the in-flight-only omitted-work
 * cancellation, the same call takes **9.1-9.5 ms p50** (~46 ms/s).
 *
 * The bound below is deliberately loose — 40 ms is ~4x the current
 * figure — because absolute timings vary widely across machines and CI
 * runners. It is not a benchmark; it is a tripwire for a return to
 * re-deriving per-request state several times per submit, or to walking
 * the outgoing pending queue on every rebuild. Read the logged p50 for
 * the actual number.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { CpuCache } from "./cpuCache.ts";
import type { ContentSource, FetchRequest, FetchResult } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { ChunkRequest, RequestPlan, ActiveSetEntry } from "../planning/index.ts";
import { emptyPlanStats } from "../planning/index.ts";
import { createSyntheticState } from "../planning/index.ts";

const MEMBERS = 21_400;

function makeSource(): ContentSource {
  return {
    fetch(_r: FetchRequest, _s: AbortSignal): Promise<FetchResult> {
      // Never settles: holds the scheduler slot like a real remote read.
      return new Promise<FetchResult>(() => {});
    },
    fetchProxy(): Promise<never> {
      return new Promise<never>(() => {});
    },
  } as unknown as ContentSource;
}

function makeDecode(): DecodePool {
  return {
    size: 8,
    decode: () => new Promise<ArrayBuffer>(() => {}),
  } as unknown as DecodePool;
}

function makeRequests(n: number): ChunkRequest[] {
  const out: ChunkRequest[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      datasetId: "ds",
      entityId: `member-${i}`,
      imageId: `image-${i}`,
      level: 3,
      t: 0,
      c: 0,
      z: 0,
      y: 0,
      x: 0,
      lane: "coarse",
      tier: "coarse",
      priority: 2400 + i,
      chunkKey: "3/0/0/0/0/0",
    });
  }
  return out;
}

function makePlan(requests: ChunkRequest[]): RequestPlan {
  const activeSet: ActiveSetEntry[] = requests.map((r) => ({
    kind: "tile",
    entityId: r.entityId,
    imageId: r.imageId,
    mode: "tiles-with-detail",
    detailLevels: [3],
    coarseLevel: null,
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
  }));
  return {
    requests,
    activeSet,
    proxyRequests: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    stats: emptyPlanStats(),
    nextState: createSyntheticState({ previousActiveSet: activeSet }),
  };
}

/** ~4x the measured 9.1-9.5 ms p50; a tripwire, not a benchmark. */
const SUBMIT_P50_BUDGET_MS = 40;

describe("submit cost at remote-fixture scale", () => {
  it("stays well under budget with a 21,400-request plan", () => {
    const cache = new CpuCache(makeSource(), makeDecode());
    const requests = makeRequests(MEMBERS);
    const plan = makePlan(requests);

    // Warm up so we measure steady state, not first-call JIT.
    for (let i = 0; i < 5; i++) {
      cache.onPlanRebuildStart();
      cache.submit(plan);
    }

    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      cache.onPlanRebuildStart();
      const t0 = performance.now();
      cache.submit(plan);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(
      `[#900] submit(${MEMBERS} reqs): p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
        `min=${samples[0].toFixed(2)}ms max=${samples[samples.length - 1].toFixed(2)}ms ` +
        `| at 5 rebuilds/s => ${(p50 * 5).toFixed(1)}ms/s of main thread`,
    );

    expect(p50).toBeLessThan(SUBMIT_P50_BUDGET_MS);
  });
});
