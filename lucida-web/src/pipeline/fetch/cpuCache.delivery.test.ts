/**
 * The cache keeps what it has to deliver between walks and updates it as
 * chunks arrive, are sent, come back and leave. These tests hold it to what
 * judging every resident chunk afresh gives, across a long run of the events
 * that change it, and hold a walk to costing what changed.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { CpuCache } from "./cpuCache.ts";
import { ChunkStore } from "./chunkStore.ts";
import { DeliveryState } from "./deliveryState.ts";
import type { ContentSource, FetchRequest, FetchResult } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { ReadyChunkDelivery } from "./types.ts";
import type { ActiveSetEntry, ChunkRequest, RequestPlan } from "../planning/index.ts";
import { createSyntheticState, emptyPlanStats } from "../planning/index.ts";
import { deliveryTarget } from "../../renderer/poolKeys.ts";

/** Four planes of 16 one-byte samples. */
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
    /** Land the fetches `pick` chooses among those waiting. */
    land(pick: (keys: string[]) => string[]): void {
      for (const key of pick([...pending.keys()])) {
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

/** A small deterministic generator, so a failing run can be replayed. */
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
const CHUNKS = 4;

function chunkRequest(random: () => number, entity: string, x: number): ChunkRequest {
  const lanes = ["detail", "detail", "coarse", "minimap", "prefetch"] as const;
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

function planOf(requests: ChunkRequest[]): RequestPlan {
  const activeSet: ActiveSetEntry[] = ENTITIES.map((entityId) => ({
    kind: "tile", entityId, imageId: `ds:${entityId}`, detailLevels: [0], coarseLevel: 1,
  }));
  return {
    requests: [...requests].sort((a, b) => a.priority - b.priority),
    activeSet,
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    stats: emptyPlanStats(),
    nextState: createSyntheticState({ previousActiveSet: activeSet }),
  };
}

function key(delivery: ReadyChunkDelivery): string {
  return `${deliveryTarget(delivery.mode, delivery.cut)}|${delivery.residencyTier}|${delivery.imageId}|${delivery.chunkKey}` +
    `|${delivery.priority}|${delivery.lane}|${delivery.traceRow}|${delivery.planes?.join(":") ?? "whole"}`;
}

/** What judging every resident chunk afresh delivers, read without disturbing what the cache keeps. */
function judgedAfresh(cache: CpuCache): string[] {
  const pending = (cache as unknown as { pending: { invalidate(): void } }).pending;
  pending.invalidate();
  return Array.from(cache.getDeliverable(), key);
}

describe("the deliveries the cache keeps between walks", () => {
  it("match a fresh judgment of every resident chunk through a long run of changes", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = seeded(seed);
      const source = manualSource();
      // Room for about a dozen whole chunks, so arrivals evict.
      const cache = new CpuCache(source, decode, { mainBudgetBytes: 8 * 4 * PLANE, overviewBudgetBytes: 4 * 4 * PLANE });
      const sentToWorker: ReadyChunkDelivery[] = [];
      const held: ReadyChunkDelivery[] = [];

      for (let step = 0; step < 250; step++) {
        const roll = random();
        if (roll < 0.14) {
          const requests: ChunkRequest[] = [];
          for (const entity of ENTITIES) {
            for (let x = 0; x < CHUNKS; x++) {
              if (random() >= 0.5) continue;
              const req = chunkRequest(random, entity, x);
              requests.push(req);
              // The whole chunk after its planes, as a step along Z prefetches it.
              if (req.planes && random() < 0.5) requests.push({ ...req, lane: "prefetch", plane: undefined, planes: undefined, priority: req.priority + 500 });
            }
          }
          // Now and then a second plan of the dataset in the same rebuild.
          if (random() < 0.8) cache.onPlanRebuildStart();
          cache.submit(planOf(requests), (req) => (req.planes ? (req.planes[1] - req.planes[0]) * PLANE : 4 * PLANE));
        } else if (roll < 0.18) {
          // The memory knobs move, and whatever no longer fits leaves.
          cache.updateConfig({
            mainBudgetBytes: (2 + Math.floor(random() * 10)) * 4 * PLANE,
            overviewBudgetBytes: (1 + Math.floor(random() * 5)) * 4 * PLANE,
          });
        } else if (roll < 0.4) {
          source.land((keys) => keys.filter(() => random() < 0.5));
          await landed();
        } else if (roll < 0.6) {
          const ready = Array.from(cache.getDeliverable());
          for (const delivery of ready.slice(0, Math.ceil(random() * 3))) {
            cache.markSent(delivery);
            sentToWorker.push(delivery);
          }
        } else if (roll < 0.75 && sentToWorker.length > 0) {
          const delivery = sentToWorker.splice(Math.floor(random() * sentToWorker.length), 1)[0];
          const target = deliveryTarget(delivery.mode, delivery.cut);
          const answer = random();
          if (answer < 0.6) {
            cache.markChunksHeld(delivery.imageId, delivery.c, target, delivery.residencyTier, [delivery.chunkKey]);
            held.push(delivery);
          } else {
            cache.markChunksRefused(
              delivery.imageId, delivery.c, target, delivery.residencyTier, [delivery.chunkKey], answer < 0.9 ? "evicted" : "atlas-policy",
            );
          }
        } else if (roll < 0.85 && held.length > 0) {
          const delivery = held.splice(Math.floor(random() * held.length), 1)[0];
          const target = deliveryTarget(delivery.mode, delivery.cut);
          if (random() < 0.5) {
            cache.markChunksLost(delivery.imageId, delivery.c, target, delivery.residencyTier, [delivery.chunkKey], "evicted");
          } else {
            cache.markChunkMissing(delivery.imageId, delivery.c, delivery.chunkKey, target, delivery.residencyTier);
          }
        } else if (roll < 0.92) {
          const entity = ENTITIES[Math.floor(random() * ENTITIES.length)];
          const level = random() < 0.5 ? 0 : 1;
          cache.markRejected(entity, `${level}/0/0/0/0/${Math.floor(random() * CHUNKS)}`);
        } else if (roll < 0.96) {
          cache.clearRejected();
        } else if (roll < 0.98) {
          cache.forgetDelivered();
          sentToWorker.length = 0;
          held.length = 0;
        }

        const kept = Array.from(cache.getDeliverable(), key);
        expect(kept, `seed ${seed}, step ${step}`).toEqual(judgedAfresh(cache));
      }
    }
  });

  it("judge again what a second plan of a dataset in one rebuild asks of chunks it does not refresh", async () => {
    const source = manualSource();
    const cache = new CpuCache(source, decode);
    const drawing = (plane: number, planes: [number, number]): ChunkRequest => ({
      datasetId: "ds", entityId: "e0", imageId: "ds:e0", level: 0, t: 0, c: 0, z: 0, y: 0, x: 0,
      lane: "detail", tier: "detail", mode: "slice", priority: plane, chunkKey: "0/0/0/0/0/0",
      plane, planes, cut: { axis: "z", plane },
    });
    cache.onPlanRebuildStart();
    cache.submit(planOf([drawing(0, [0, 2])]));
    source.land((keys) => keys);
    await landed();
    for (const delivery of Array.from(cache.getDeliverable())) cache.markSent(delivery);
    expect(Array.from(cache.getDeliverable())).toEqual([]);

    // The second plan wants a plane the held planes lack, so it misses them
    // and refreshes nothing, but its target is the chunk's too.
    cache.submit(planOf([drawing(3, [3, 4])]));
    const kept = Array.from(cache.getDeliverable(), key);
    expect(kept).toEqual(judgedAfresh(cache));
  });

  it("walks no store and asks the ledger nothing on a frame that changed nothing", async () => {
    const source = manualSource();
    const cache = new CpuCache(source, decode);
    const requests = Array.from({ length: 40 }, (_, x): ChunkRequest => ({
      datasetId: "ds", entityId: "e0", imageId: "ds:e0", level: 0, t: 0, c: 0, z: 0, y: 0, x,
      lane: "detail", tier: "detail", mode: "volume", priority: x, chunkKey: `0/0/0/0/0/${x}`,
    }));
    cache.onPlanRebuildStart();
    cache.submit(planOf(requests));
    source.land((keys) => keys);
    await landed();
    // All but the last go out, as a tick's upload budget lets them.
    const ready = Array.from(cache.getDeliverable());
    expect(ready).toHaveLength(40);
    for (const delivery of ready.slice(0, 39)) cache.markSent(delivery);

    const walks = vi.spyOn(ChunkStore.prototype, "iterateTier");
    const entries = vi.spyOn(ChunkStore.prototype, "allEntries");
    const asked = vi.spyOn(DeliveryState.prototype, "wasChunkSent");
    try {
      // The first read judges the 39 sent; the frames after it judge nothing.
      expect(Array.from(cache.getDeliverable(), (d) => d.x)).toEqual([39]);
      expect(asked).toHaveBeenCalledTimes(39);
      for (let frame = 0; frame < 10; frame++) {
        expect(Array.from(cache.getDeliverable(), (d) => d.x)).toEqual([39]);
      }
      expect(asked).toHaveBeenCalledTimes(39);
      expect(walks).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
    } finally {
      walks.mockRestore();
      entries.mockRestore();
      asked.mockRestore();
    }
  });
});
