/**
 * The CPU cache holds a chunk whole or as some of its planes. A request for
 * a plane is resident when the chunk's entry holds that plane, a whole chunk
 * that lands takes the place of its planes, and the view never waits behind
 * a whole chunk the prefetch lane is bringing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { CpuCache } from "./cpuCache.ts";
import type { ContentSource, FetchRequest, FetchResult, PlaneRange } from "./contentSource.ts";
import type { DecodePool } from "./decodePool.ts";
import type { ChunkRequest, RequestPlan } from "../planning/index.ts";
import { createSyntheticState, emptyPlanStats } from "../planning/index.ts";
import { createSettleState } from "../settle.ts";

/** One chunk of four planes, 16 one-byte samples each. */
const PLANE = 16;
const CHUNK = "ds/img/0/0/0/0/0/0";

interface Pending {
  request: FetchRequest;
  resolve: (result: FetchResult) => void;
}

function planeSource() {
  const pending = new Map<string, Pending>();
  const asked: FetchRequest[] = [];
  const keyOf = (request: FetchRequest) => {
    const chunk = `${request.datasetId}/${request.imageId}/${request.chunkKey}`;
    return request.planes ? `${chunk}#${request.planes[0]}:${request.planes[1]}` : chunk;
  };
  const source: ContentSource & {
    asked: FetchRequest[];
    waiting(key: string): boolean;
    land(key: string): void;
  } = {
    asked,
    fetch(request, signal) {
      asked.push(request);
      const key = keyOf(request);
      return new Promise((resolve, reject) => {
        pending.set(key, { request, resolve });
        signal.addEventListener("abort", () => {
          pending.delete(key);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
    handleBinary() {},
    waiting: (key) => pending.has(key),
    land(key) {
      const fetch = pending.get(key);
      if (!fetch) throw new Error(`nothing waits under ${key}`);
      pending.delete(key);
      const planes: PlaneRange | undefined = fetch.request.planes;
      const result: FetchResult = {
        bytes: new ArrayBuffer(planes ? (planes[1] - planes[0]) * PLANE : 4 * PLANE),
        wireFormat: { Raw: { data_type: "uint8" } },
        dataType: "uint8",
      };
      if (planes) result.planes = planes;
      fetch.resolve(result);
    },
  };
  return source;
}

const decode = {
  decode: (bytes: ArrayBuffer) => Promise.resolve(bytes),
  activeCount: () => 0,
  get size() { return 3; },
  terminate: () => {},
} as unknown as DecodePool;

function request(overrides: Partial<ChunkRequest>): ChunkRequest {
  return {
    datasetId: "ds",
    entityId: "ds",
    imageId: "img",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    lane: "detail",
    tier: "detail",
    priority: 0,
    chunkKey: "0/0/0/0/0/0",
    ...overrides,
  };
}

/** The view drawing `plane`, fetching the band around it. */
const drawing = (plane: number, planes: [number, number]) => request({ plane, planes });
/** The whole chunk, prefetched after a step along Z. */
const rest = () => request({ lane: "prefetch", priority: 300 });

function setup() {
  const source = planeSource();
  const cache = new CpuCache(source, decode);
  const submit = (...requests: ChunkRequest[]) => {
    cache.onPlanRebuildStart();
    const activeSet = [{ kind: "tile" as const, entityId: "ds", imageId: "img", detailLevels: [0], coarseLevel: null }];
    const plan: RequestPlan = {
      requests,
      activeSet,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
      stats: emptyPlanStats(),
      nextState: createSyntheticState({ previousActiveSet: activeSet }),
    };
    cache.submit(plan, (req) => (req.planes ? (req.planes[1] - req.planes[0]) * PLANE : 4 * PLANE));
  };
  return { source, cache, submit };
}

const landed = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a chunk held as some of its planes", () => {
  it("is fetched as its band and serves a step to another plane of it", async () => {
    const { source, cache, submit } = setup();
    submit(drawing(1, [0, 3]));
    expect(source.asked.map((r) => r.planes)).toEqual([[0, 3]]);
    source.land(`${CHUNK}#0:3`);
    await landed();

    const [delivery] = [...cache.getDeliverable()];
    expect(delivery.planes).toEqual([0, 3]);
    expect(delivery.data.byteLength).toBe(3 * PLANE);
    expect(cache.residentBytes()).toBe(3 * PLANE);

    submit(drawing(2, [0, 4]));
    expect(source.asked).toHaveLength(1);
    expect(cache.holds(drawing(2, [0, 4]))).toBe(true);

    // Plane 3 is not among them, so it is fetched.
    submit(drawing(3, [1, 4]));
    expect(cache.holds(drawing(3, [1, 4]))).toBe(false);
    expect(source.asked.map((r) => r.planes)).toEqual([[0, 3], [1, 4]]);
  });

  it("is never what a reader of whole chunks sees", async () => {
    const { source, cache, submit } = setup();
    submit(drawing(1, [0, 3]));
    source.land(`${CHUNK}#0:3`);
    await landed();
    expect(cache.getCachedChunk("ds", "0/0/0/0/0/0")).toBeNull();
    expect(cache.cachedSamples("ds", "0/0/0/0/0/0")).toBeUndefined();
    expect(cache.holds(request({}))).toBe(false);
  });
});

describe("the whole chunk", () => {
  it("takes the place of its planes, in the view, without waking the page for a plane it already drew", async () => {
    const { source, cache, submit } = setup();
    const wakes = vi.fn();
    cache.subscribe(wakes);
    submit(drawing(1, [0, 3]));
    source.land(`${CHUNK}#0:3`);
    await landed();
    expect(wakes).toHaveBeenCalledTimes(1);
    for (const delivery of cache.getDeliverable()) cache.markSent(delivery);
    cache.markChunksHeld("img", 0, "detail", ["0/0/0/0/0/0"]);

    submit(drawing(2, [0, 4]), rest());
    expect(source.asked.map((r) => r.planes)).toEqual([[0, 3], undefined]);
    source.land(CHUNK);
    await landed();

    expect(wakes).toHaveBeenCalledTimes(1);
    expect(cache.residentBytes()).toBe(4 * PLANE);
    expect(cache.getCachedChunk("ds", "0/0/0/0/0/0")?.data.byteLength).toBe(4 * PLANE);
    expect(cache.holds(drawing(3, [1, 4]))).toBe(true);
    expect(cache.settleInputs(createSettleState())).toMatchObject({ residentDetailChunks: 1, desiredDetailChunks: 1 });
  });

  it("leaves no fetch of its planes running once it lands", async () => {
    const { source, submit } = setup();
    submit(drawing(1, [0, 3]), rest());
    source.land(CHUNK);
    await landed();
    expect(source.waiting(`${CHUNK}#0:3`)).toBe(false);
  });

  it("is not waited on by the view while the prefetch lane brings it, nor dropped", async () => {
    const { source, cache, submit } = setup();
    submit(drawing(1, [0, 3]));
    source.land(`${CHUNK}#0:3`);
    await landed();
    submit(drawing(2, [0, 4]), rest());

    // A step past the band asks for its own planes, and the whole chunk
    // keeps coming.
    submit(drawing(3, [1, 4]));
    expect(source.asked.map((r) => r.planes)).toEqual([[0, 3], undefined, [1, 4]]);
    expect(source.waiting(CHUNK)).toBe(true);
    const settle = cache.settleInputs(createSettleState());
    expect(settle.inFlight).toBe(1);
    expect(settle.speculativeInFlight).toBe(1);

    // It lands for the view, which no longer waits on its own planes.
    source.land(CHUNK);
    await landed();
    expect(cache.holds(drawing(3, [1, 4]))).toBe(true);
    expect([...cache.getDeliverable()].map((d) => [d.lane, d.planes])).toEqual([["detail", undefined]]);
    expect(source.waiting(`${CHUNK}#1:4`)).toBe(false);
    expect(cache.settleInputs(createSettleState()).inFlight).toBe(0);
  });

  it("keeps its place when planes of it land after it", async () => {
    const { source, cache, submit } = setup();
    submit(request({}));
    source.land(CHUNK);
    await landed();
    // A request for planes the whole chunk holds is resident at once.
    submit(drawing(1, [0, 3]));
    expect(source.asked).toHaveLength(1);
    expect(cache.getCachedChunk("ds", "0/0/0/0/0/0")?.data.byteLength).toBe(4 * PLANE);
  });
});

describe("an arrival only the prefetch lane wants", () => {
  it("does not wake the page", async () => {
    const { source, cache, submit } = setup();
    const wakes = vi.fn();
    cache.subscribe(wakes);
    submit(request({ lane: "prefetch", priority: 300 }));
    source.land(CHUNK);
    await landed();
    expect(cache.residentBytes()).toBe(4 * PLANE);
    expect(wakes).not.toHaveBeenCalled();
  });
});
