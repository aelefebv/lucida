/**
 * A plan that carries the last one's wanted set updates the cache over what
 * its deltas changed. These tests hold it to what a full rebuild of the same
 * plan gives, and its readings to a fresh judgment of every resident chunk.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { CpuCache } from "./cpuCache.ts";
import type { ContentSource, FetchRequest, FetchResult } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { ReadyChunkDelivery } from "./types.ts";
import type { ActiveSetEntry, ChunkRequest, RequestPlan } from "../planning/index.ts";
import { compareChunkRequests, createSyntheticState, emptyPlanStats } from "../planning/index.ts";
import type { RequestDelta } from "../planning/types.ts";
import { createSettleState } from "../settle.ts";
import { deliveryTarget } from "../../renderer/poolKeys.ts";

const PLANE = 16;

function manualSource() {
  const pending = new Map<string, { request: FetchRequest; resolve: (result: FetchResult) => void }>();
  const source = {
    fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
      const key = `${request.imageId}/${request.chunkKey}#${request.planes?.join(":") ?? "whole"}`;
      return new Promise((resolve, reject) => {
        pending.set(key, { request, resolve });
        signal.addEventListener("abort", () => {
          pending.delete(key);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
    handleBinary() {},
    waiting(): string[] {
      return [...pending.keys()].sort();
    },
    land(keys: readonly string[]): void {
      for (const key of keys) {
        const fetch = pending.get(key);
        if (!fetch) continue;
        pending.delete(key);
        const { planes } = fetch.request;
        const result: FetchResult = {
          bytes: new ArrayBuffer(planes ? (planes[1] - planes[0]) * PLANE : 4 * PLANE),
          wireFormat: { Raw: { data_type: "uint8" } },
          dataType: "uint8",
        };
        if (planes) result.planes = planes;
        fetch.resolve(result);
      }
    },
  };
  return source as typeof source & ContentSource;
}

const decode = {
  decode: (bytes: ArrayBuffer) => Promise.resolve(bytes),
  activeCount: () => 0,
  get size() { return 3; },
  terminate: () => {},
} as unknown as DecodePool;

const landed = () => new Promise((resolve) => setTimeout(resolve, 0));

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ENTITIES = ["e0", "e1", "e2"];
const CHUNKS = 5;

function chunkRequest(random: () => number, entity: string, x: number): ChunkRequest {
  const lanes = ["detail", "detail", "detail", "coarse", "minimap", "prefetch"] as const;
  const lane = lanes[Math.floor(random() * lanes.length)];
  const tier = lane === "coarse" || lane === "minimap" ? "coarse" : "detail";
  const level = tier === "coarse" ? 1 : 0;
  const volume = lane !== "prefetch" && random() < 0.3;
  const req: ChunkRequest = {
    datasetId: "ds",
    entityId: entity,
    imageId: `ds:${entity}`,
    level,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x,
    lane,
    tier,
    mode: volume ? "volume" : "slice",
    priority: Math.floor(random() * 1000),
    chunkKey: `${level}/0/0/0/0/${x}`,
  };
  if (!volume) {
    const plane = Math.floor(random() * 4);
    req.cut = { axis: "z", plane };
    if (lane === "detail" && random() < 0.4) {
      req.plane = plane;
      req.planes = [plane, Math.min(4, plane + 2)];
    }
  }
  return req;
}

const ACTIVE: ActiveSetEntry[] = ENTITIES.map((entityId) => ({
  kind: "tile", entityId, imageId: `ds:${entityId}`, detailLevels: [0], coarseLevel: 1,
}));

function planOf(requests: readonly ChunkRequest[], delta?: RequestDelta): RequestPlan {
  return {
    requests,
    ...(delta && { delta }),
    activeSet: ACTIVE,
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    stats: emptyPlanStats(),
    nextState: createSyntheticState({ previousActiveSet: ACTIVE }),
  };
}

const bytesOf = (req: ChunkRequest) => (req.planes ? (req.planes[1] - req.planes[0]) * PLANE : 4 * PLANE);

function key(delivery: ReadyChunkDelivery): string {
  return `${deliveryTarget(delivery.mode, delivery.cut)}|${delivery.residencyTier}|${delivery.imageId}|${delivery.chunkKey}` +
    `|${delivery.priority}|${delivery.lane}|${delivery.planes?.join(":") ?? "whole"}`;
}

function reading(cache: CpuCache) {
  const s = cache.settleInputs(createSettleState());
  return {
    deliveries: Array.from(cache.getDeliverable(), key),
    settle: [
      s.desiredDetailChunks, s.residentDetailChunks, s.desiredCoarseChunks, s.residentCoarseChunks,
      s.pending, s.inFlight, s.shortDetailChunks, s.shortCoarseChunks,
    ],
    queue: cache.getPendingSnapshot().map((req) => `${req.lane}|${req.tier}|${req.entityId}|${req.chunkKey}|${req.planes?.join(":") ?? ""}`),
  };
}

function judgedAfresh(cache: CpuCache): ReturnType<typeof reading> {
  (cache as unknown as { residents: { invalidate(): void } }).residents.invalidate();
  return reading(cache);
}

describe("a plan that carries the last one's wanted set", () => {
  it("leaves the cache as a full rebuild of the same plan leaves it", async () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const random = seeded(seed);
      // Room for every chunk, so neither cache evicts and the two hold the same entries.
      const budgets = { mainBudgetBytes: 1_000 * PLANE, overviewBudgetBytes: 1_000 * PLANE };
      const full = { source: manualSource(), cache: null as unknown as CpuCache };
      const carried = { source: manualSource(), cache: null as unknown as CpuCache };
      full.cache = new CpuCache(full.source, decode, budgets);
      carried.cache = new CpuCache(carried.source, decode, budgets);
      let current: ChunkRequest[] = [];
      let sent: ReadyChunkDelivery[] = [];

      for (let step = 0; step < 200; step++) {
        const roll = random();
        if (roll < 0.25 || step === 0) {
          // A replan: most requests carried as the same objects, a few gone,
          // a few new, as a gesture's selection moves.
          const kept = current.filter(() => random() > 0.15);
          const added: ChunkRequest[] = [];
          const count = step === 0 ? 12 : Math.floor(random() * 4);
          for (let i = 0; i < count; i++) {
            added.push(chunkRequest(random, ENTITIES[Math.floor(random() * ENTITIES.length)], Math.floor(random() * CHUNKS)));
          }
          added.sort(compareChunkRequests);
          const next = [...kept, ...added].sort(compareChunkRequests);
          const keptSet = new Set(kept);
          const delta: RequestDelta = { base: current, added, removed: current.filter((req) => !keptSet.has(req)) };

          full.cache.onPlanRebuildStart();
          full.cache.submit(planOf(next), bytesOf);
          if (step === 0 || !carried.cache.beginCarriedPlan([current])) {
            carried.cache.onPlanRebuildStart();
            carried.cache.submit(planOf(next), bytesOf);
          } else {
            carried.cache.submit(planOf(next, delta), bytesOf);
          }
          current = next;
        } else if (roll < 0.5) {
          const waiting = full.source.waiting();
          expect(carried.source.waiting(), `seed ${seed}, step ${step}`).toEqual(waiting);
          const landing = waiting.filter(() => random() < 0.5);
          full.source.land(landing);
          carried.source.land(landing);
          await landed();
        } else if (roll < 0.7) {
          const ready = Array.from(full.cache.getDeliverable());
          const picked = ready.slice(0, Math.ceil(random() * 3));
          for (const delivery of picked) {
            full.cache.markSent(delivery);
            const twin = Array.from(carried.cache.getDeliverable()).find((d) => key(d) === key(delivery));
            if (twin) carried.cache.markSent(twin);
          }
          sent = [...sent, ...picked];
        } else if (roll < 0.82 && sent.length > 0) {
          const delivery = sent.splice(Math.floor(random() * sent.length), 1)[0];
          const target = deliveryTarget(delivery.mode, delivery.cut);
          for (const { cache } of [full, carried]) {
            if (random() < 0.7) cache.markChunksHeld(delivery.imageId, delivery.c, target, delivery.residencyTier, [delivery.chunkKey]);
          }
        } else if (roll < 0.9) {
          const entity = ENTITIES[Math.floor(random() * ENTITIES.length)];
          const chunk = `${random() < 0.5 ? 0 : 1}/0/0/0/0/${Math.floor(random() * CHUNKS)}`;
          full.cache.markRejected(entity, chunk);
          carried.cache.markRejected(entity, chunk);
        }

        expect(reading(carried.cache), `seed ${seed}, step ${step}`).toEqual(reading(full.cache));
        expect(reading(carried.cache), `seed ${seed}, step ${step}`).toEqual(judgedAfresh(carried.cache));
      }
    }
  });

  it("keeps its readings true to every resident chunk while arrivals evict", async () => {
    for (const seed of [21, 22, 23]) {
      const random = seeded(seed);
      const source = manualSource();
      const cache = new CpuCache(source, decode, { mainBudgetBytes: 6 * 4 * PLANE, overviewBudgetBytes: 3 * 4 * PLANE });
      let current: ChunkRequest[] = [];
      for (let step = 0; step < 250; step++) {
        const roll = random();
        if (roll < 0.3 || step === 0) {
          const kept = current.filter(() => random() > 0.2);
          const added = Array.from({ length: step === 0 ? 10 : Math.floor(random() * 4) }, () =>
            chunkRequest(random, ENTITIES[Math.floor(random() * ENTITIES.length)], Math.floor(random() * CHUNKS)),
          ).sort(compareChunkRequests);
          const next = [...kept, ...added].sort(compareChunkRequests);
          const keptSet = new Set(kept);
          const delta: RequestDelta = { base: current, added, removed: current.filter((req) => !keptSet.has(req)) };
          if (step > 0 && cache.beginCarriedPlan([current])) {
            cache.submit(planOf(next, delta), bytesOf);
          } else {
            cache.onPlanRebuildStart();
            cache.submit(planOf(next), bytesOf);
          }
          current = next;
        } else if (roll < 0.65) {
          source.land(source.waiting().filter(() => random() < 0.5));
          await landed();
        } else if (roll < 0.85) {
          for (const delivery of Array.from(cache.getDeliverable()).slice(0, 2)) cache.markSent(delivery);
        } else {
          cache.markRejected(ENTITIES[Math.floor(random() * ENTITIES.length)], `0/0/0/0/0/${Math.floor(random() * CHUNKS)}`);
        }
        expect(reading(cache), `seed ${seed}, step ${step}`).toEqual(judgedAfresh(cache));
      }
    }
  });

  it("refuses to carry a plan whose bases are not what the last plan submitted", () => {
    const cache = new CpuCache(manualSource(), decode);
    const first: ChunkRequest[] = [];
    cache.onPlanRebuildStart();
    cache.submit(planOf(first), bytesOf);
    expect(cache.beginCarriedPlan([[]])).toBe(false);
    expect(cache.beginCarriedPlan([first, first])).toBe(false);
    expect(cache.beginCarriedPlan([first])).toBe(true);
  });
});
