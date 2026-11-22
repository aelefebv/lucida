import { describe, expect, it } from "vitest";

import { compareChunkRequests } from "./emit.ts";
import { RequestPacing, type PacedRequests } from "./pacing.ts";
import { requestChunkKey } from "./requestKeys.ts";
import type { ChunkRequest, RequestDelta } from "./types.ts";

/** A request for chunk `x` of one entity, in `lane`, ranked by `x` within the lane's band. */
function request(x: number, lane: ChunkRequest["lane"] = "detail"): ChunkRequest {
  const band = lane === "detail" ? 0 : lane === "prefetch" ? 10 : 20;
  return {
    datasetId: "ds",
    entityId: "volume",
    imageId: "image",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x,
    lane,
    tier: lane === "coarse" ? "coarse" : "detail",
    mode: "volume",
    priority: band + x / 1000,
    chunkKey: `0/0/0/0/0/${x}`,
  };
}

/** A plan of `next` carried from `previous`: requests both hold are the same objects. */
function carried(previous: readonly ChunkRequest[], next: readonly ChunkRequest[]): { requests: ChunkRequest[]; delta: RequestDelta } {
  const kept = new Set(next);
  const was = new Set(previous);
  const requests = [...next].sort(compareChunkRequests);
  return {
    requests,
    delta: {
      base: previous,
      added: requests.filter((req) => !was.has(req)),
      removed: previous.filter((req) => !kept.has(req)),
    },
  };
}

/** Whether `paced` is `base` less its removals with its additions, in planner order. */
function expectConsistent(paced: PacedRequests, base: readonly ChunkRequest[]): void {
  expect(paced.delta.base).toBe(base);
  const gone = new Set(paced.delta.removed);
  const expected = [...base.filter((req) => !gone.has(req)), ...paced.delta.added].sort(compareChunkRequests);
  expect(paced.requests).toEqual(expected);
  for (let i = 1; i < paced.requests.length; i++) {
    expect(compareChunkRequests(paced.requests[i - 1], paced.requests[i])).toBeLessThanOrEqual(0);
  }
}

/**
 * Take until nothing is owed, checking each tick, and return what the stages
 * hold after. Every chunk of `kept` stays held throughout.
 */
function drain(
  pacing: RequestPacing,
  held: readonly ChunkRequest[],
  budget: number,
  kept: ReadonlySet<string> = new Set(),
): readonly ChunkRequest[] {
  for (let tick = 0; pacing.owes(); tick++) {
    expect(tick).toBeLessThan(10_000);
    const paced = pacing.take("ds", budget)!;
    expect(paced.delta.added.length + paced.delta.removed.length).toBeGreaterThan(0);
    expectConsistent(paced, held);
    held = paced.requests;
    const now = new Set(held.map(requestChunkKey));
    for (const key of kept) expect(now.has(key)).toBe(true);
  }
  return held;
}

describe("RequestPacing", () => {
  it("hands a plan that fits the budget to the stages as the planner made it", () => {
    const before = [0, 1, 2].map((x) => request(x));
    const plan = carried(before, [before[0], request(3)]);
    const paced = new RequestPacing().offer("ds", plan.requests, plan.delta, 10);
    expect(paced.requests).toBe(plan.requests);
    expect(paced.delta).toBe(plan.delta);
  });

  it("hands a large change over in budgets, ending on the planner's own requests", () => {
    const before = Array.from({ length: 40 }, (_, x) => request(x));
    const plan = carried(before, [...before.slice(20), ...Array.from({ length: 30 }, (_, i) => request(100 + i))]);
    const pacing = new RequestPacing();
    const first = pacing.offer("ds", plan.requests, plan.delta, 8);
    expectConsistent(first, before);
    expect(first.delta.added.length + first.delta.removed.length).toBe(8);
    expect(pacing.owes()).toBe(true);
    expect(drain(pacing, first.requests, 8)).toBe(plan.requests);
  });

  it("takes removals before additions, so the stages make room before they fill it", () => {
    const before = Array.from({ length: 10 }, (_, x) => request(x));
    const plan = carried(before, Array.from({ length: 10 }, (_, i) => request(100 + i)));
    const pacing = new RequestPacing();
    const first = pacing.offer("ds", plan.requests, plan.delta, 6);
    expect(first.delta.removed).toHaveLength(6);
    expect(first.delta.added).toHaveLength(0);
    const second = pacing.take("ds", 6)!;
    expect(second.delta.removed).toHaveLength(4);
    expect(second.delta.added.map((req) => req.x)).toEqual([100, 101]);
    const third = pacing.take("ds", 6)!;
    expect(third.delta.removed).toHaveLength(0);
    expect(third.delta.added.map((req) => req.x)).toEqual([102, 103, 104, 105, 106, 107]);
  });

  it("removes a chunk the plan asks for again in another lane only with its addition", () => {
    const ahead = Array.from({ length: 10 }, (_, x) => request(x, "prefetch"));
    // The lookahead becomes what the view draws: each chunk swaps lanes.
    const plan = carried(ahead, ahead.map((req) => request(req.x, "detail")));
    const pacing = new RequestPacing();
    let held: readonly ChunkRequest[] = ahead;
    let paced = pacing.offer("ds", plan.requests, plan.delta, 4);
    for (;;) {
      expectConsistent(paced, held);
      held = paced.requests;
      const wanted = new Set(held.map(requestChunkKey));
      for (const req of ahead) expect(wanted.has(requestChunkKey(req))).toBe(true);
      if (!pacing.owes()) break;
      paced = pacing.take("ds", 4)!;
    }
    expect(held).toBe(plan.requests);
  });

  it("weighs a plan made while changes are owed against what the stages hold", () => {
    const before = Array.from({ length: 20 }, (_, x) => request(x));
    const first = carried(before, [...before.slice(10), ...Array.from({ length: 10 }, (_, i) => request(100 + i))]);
    const pacing = new RequestPacing();
    const taken = pacing.offer("ds", first.requests, first.delta, 12);
    // A second plan drops some of the first's additions before the stages take them,
    // and asks again for a chunk it removed.
    const second = carried(first.requests, [
      ...first.requests.filter((req) => req.x < 105 || req.x >= 108),
      request(0),
    ]);
    const paced = pacing.offer("ds", second.requests, second.delta, 12);
    expectConsistent(paced, taken.requests);
    const held = drain(pacing, paced.requests, 12);
    expect(held).toBe(second.requests);
    expect(held.map((req) => req.x)).not.toContain(106);
  });

  it("starts over from the plan's own base when it does not follow the one pacing heads for", () => {
    const before = Array.from({ length: 20 }, (_, x) => request(x));
    const first = carried(before, before.slice(10));
    const pacing = new RequestPacing();
    pacing.offer("ds", first.requests, first.delta, 4);
    const elsewhere = [request(50), request(51)];
    const plan = carried(elsewhere, [elsewhere[0]]);
    const paced = pacing.offer("ds", plan.requests, plan.delta, 4);
    expect(paced.requests).toBe(plan.requests);
    expect(pacing.owes()).toBe(false);
  });

  it("owes nothing for a dataset that no longer plans", () => {
    const before = Array.from({ length: 20 }, (_, x) => request(x));
    const plan = carried(before, []);
    const pacing = new RequestPacing();
    pacing.offer("ds", plan.requests, plan.delta, 4);
    expect(pacing.owes()).toBe(true);
    pacing.retain(new Set(["other"]));
    expect(pacing.owes()).toBe(false);
  });

  it("matches the planner's requests after any run of plans and budgets", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const lanes: ChunkRequest["lane"][] = ["detail", "prefetch", "coarse"];
    for (let run = 0; run < 40; run++) {
      const pacing = new RequestPacing();
      let target: readonly ChunkRequest[] = Array.from({ length: 30 }, (_, x) => request(x));
      let held = target;
      for (let step = 0; step < 12; step++) {
        // Keep some of the plan's requests, swap some chunks' lanes, and add new chunks.
        const next: ChunkRequest[] = [];
        for (const req of target) {
          const roll = random();
          if (roll < 0.6) next.push(req);
          else if (roll < 0.75) next.push(request(req.x, lanes[Math.floor(random() * lanes.length)]));
        }
        const fresh = Math.floor(random() * 25);
        for (let i = 0; i < fresh; i++) next.push(request(Math.floor(random() * 200), lanes[Math.floor(random() * lanes.length)]));
        const plan = carried(target, [...new Map(next.map((req) => [`${req.lane}|${req.x}`, req])).values()]);
        const budget = 1 + Math.floor(random() * 12);
        const before = new Set(held.map(requestChunkKey));
        const wantedBoth = new Set(plan.requests.map(requestChunkKey).filter((key) => before.has(key)));
        const paced = pacing.offer("ds", plan.requests, plan.delta, budget);
        expectConsistent(paced, held);
        held = paced.requests;
        // A chunk held before and wanted after is never let go between them.
        const now = new Set(held.map(requestChunkKey));
        for (const key of wantedBoth) expect(now.has(key)).toBe(true);
        target = plan.requests;
        if (random() < 0.3) held = drain(pacing, held, budget, wantedBoth);
      }
      expect(drain(pacing, held, 5)).toBe(target);
    }
  });
});
