/**
 * Regression guard on `CpuCache.submit` at remote-collection scale.
 * `submit` receives the dataset's complete wanted set on every plan rebuild
 * (~21k requests, ~5 rebuilds/s), so its per-call cost is main-thread time
 * spent on pure bookkeeping.
 *
 * The budget is a tripwire for re-deriving per-request state several times
 * per submit, or for walking the pending queue on every rebuild, and it is
 * held on any host the way `perfBudget.ts` describes. Read the logged p50.
 */
import { describe, it, vi } from "vitest";
import { describeTiming, expectWithinBudget, timeStep } from "../../test/perfBudget.ts";

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

/** In nominal microseconds, about twice the typical figure. */
const SUBMIT_BUDGET_US = 29_000;

describe("submit cost at remote-fixture scale", () => {
  it("stays well under budget with a 21,400-request plan", () => {
    const cache = new CpuCache(makeSource(), makeDecode());
    const requests = makeRequests(MEMBERS);
    const plan = makePlan(requests);

    const submit = timeStep(() => cache.submit(plan), {
      samples: 40,
      warmup: 5,
      before: () => cache.onPlanRebuildStart(),
    });
    console.log(
      `[#900] submit(${MEMBERS} reqs): ${describeTiming(submit, SUBMIT_BUDGET_US)} ` +
        `| at 5 rebuilds/s => ${((submit.p50Us * 5) / 1_000).toFixed(1)}ms/s of main thread`,
    );

    expectWithinBudget(`submit(${MEMBERS} reqs)`, submit, SUBMIT_BUDGET_US);
  });
});
