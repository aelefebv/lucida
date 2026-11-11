import { describe, expect, it } from "vitest";

import type { DatasetManifest } from "../../manifestTypes.ts";
import { admitPlans, chunkBytesFor, fairShares, type GpuSlot, type PerTier } from "./admission.ts";
import type { ChunkRequest } from "./types.ts";

function request(x: number, overrides: Partial<ChunkRequest> = {}): ChunkRequest {
  const lane = overrides.lane ?? "detail";
  return {
    datasetId: "ds",
    entityId: `tile-${x}`,
    imageId: "image",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x,
    lane,
    tier: lane === "coarse" || lane === "minimap" || lane === "overview" ? "coarse" : "detail",
    mode: "slice",
    priority: x,
    chunkKey: `0/0/0/0/0/${x}`,
    ...overrides,
  };
}

const TEN_BYTES = () => 10;

/** One plan admitted alone. */
function admitOne(
  requests: ChunkRequest[],
  capacity: PerTier,
  slotOf?: (req: ChunkRequest) => GpuSlot | null,
  gpuRoom?: number,
) {
  return admitPlans([{ requests, bytesOf: TEN_BYTES, slotOf }], capacity, gpuRoom)[0];
}

describe("admitPlans", () => {
  it("admits in priority order up to each tier's room and declares the rest", () => {
    const requests = [0, 1, 2, 3, 4].map((x) => request(x));
    const admission = admitOne(requests, { detail: 30, coarse: 0 });
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1, 2]);
    expect(admission.shortfall).toEqual({ detail: 2, coarse: 0 });
  });

  it("drops prefetch that does not fit without counting it against coverage", () => {
    const requests = [request(0), request(1, { lane: "prefetch" }), request(2, { lane: "prefetch" })];
    const admission = admitOne(requests, { detail: 20, coarse: 0 });
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1]);
    expect(admission.shortfall.detail).toBe(0);
  });

  it("admits the view's detail before prefetch that ranks above it", () => {
    const requests = [
      request(0, { lane: "prefetch" }),
      request(1, { lane: "prefetch" }),
      request(2),
      request(3),
    ];
    const admission = admitOne(requests, { detail: 30, coarse: 0 });
    expect(admission.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["prefetch:0", "detail:2", "detail:3"]);
    expect(admission.shortfall.detail).toBe(0);
  });

  it("lets the coarse tier take the room detail leaves, and says how much it borrowed", () => {
    const requests = [request(0), ...[1, 2, 3, 4].map((x) => request(x, { lane: "coarse" }))];
    const admission = admitOne(requests, { detail: 30, coarse: 20 });
    expect(admission.admitted).toHaveLength(5);
    expect(admission.shortfall).toEqual({ detail: 0, coarse: 0 });
    expect(admission.borrowed).toBe(20);
  });

  it("lends the coarse tier detail's room before prefetch takes it", () => {
    const requests = [request(0, { lane: "prefetch" }), request(1), request(2, { lane: "coarse" })];
    const admission = admitOne(requests, { detail: 20, coarse: 0 });
    expect(admission.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["detail:1", "coarse:2"]);
    expect(admission.shortfall).toEqual({ detail: 0, coarse: 0 });
    expect(admission.borrowed).toBe(10);
  });

  it("admits or refuses two lanes' demand for one chunk together, charged once", () => {
    const requests = [
      request(0, { lane: "coarse" }),
      request(1, { lane: "coarse" }),
      request(0, { lane: "minimap", priority: 9 }),
    ];
    const admission = admitOne(requests, { detail: 0, coarse: 10 });
    expect(admission.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["coarse:0", "minimap:0"]);
    expect(admission.shortfall.coarse).toBe(1);
  });

  it("admits every plan's view before any plan's prefetch, from one shared room", () => {
    const first = [request(0), request(1, { lane: "prefetch" })];
    const second = [request(2, { datasetId: "other" }), request(3, { datasetId: "other" })];
    const [a, b] = admitPlans(
      [
        { requests: first, bytesOf: TEN_BYTES },
        { requests: second, bytesOf: TEN_BYTES },
      ],
      { detail: 30, coarse: 0 },
    );
    expect(a.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["detail:0"]);
    expect(b.admitted.map((r) => r.x)).toEqual([2, 3]);
    expect(a.shortfall.detail + b.shortfall.detail).toBe(0);
  });
});

describe("admitting against GPU slot pools", () => {
  it("admits no more chunks into a pool than it has slots, and counts the rest short", () => {
    const requests = [0, 1, 2, 3].map((x) => request(x));
    const slotOf = () => ({ pool: "p", slots: 2, slotBytes: 10 });
    const admission = admitOne(requests, { detail: 1_000, coarse: 0 }, slotOf);
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1]);
    expect(admission.shortfall.detail).toBe(2);
  });

  it("keeps a chunk for a lane that never uploads when the pool refuses its upload", () => {
    const requests = [
      request(0, { lane: "coarse" }),
      request(1, { lane: "coarse" }),
      request(1, { lane: "minimap", priority: 9 }),
    ];
    const slotOf = (req: ChunkRequest) => (req.lane === "coarse" ? { pool: "p", slots: 1, slotBytes: 10 } : null);
    const admission = admitOne(requests, { detail: 0, coarse: 100 }, slotOf);
    expect(admission.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["coarse:0", "minimap:1"]);
    expect(admission.shortfall.coarse).toBe(1);
  });

  it("admits no more slots across every pool than the GPU room holds", () => {
    // Two pools of ample slots, but room for three 10-byte slots between them.
    const requests = [0, 1, 2, 3].map((x) => request(x));
    const slotOf = (req: ChunkRequest) => ({ pool: req.x % 2 === 0 ? "even" : "odd", slots: 10, slotBytes: 10 });
    const admission = admitOne(requests, { detail: 1_000, coarse: 0 }, slotOf, 35);
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1, 2]);
    expect(admission.shortfall.detail).toBe(1);
  });
});

describe("fairShares", () => {
  it("gives a claim that wants less than its share what it wants, and the rest to the others by weight", () => {
    const shares = fairShares(new Map([[1, 100], [2, 10], [3, 100]]), new Map([[1, 1], [2, 1], [3, 2]]), 70);
    expect(shares.get(2)).toBe(10);
    expect(shares.get(1)).toBeCloseTo(20);
    expect(shares.get(3)).toBeCloseTo(40);
  });

  it("gives every claim what it wants when the room holds them all", () => {
    expect([...fairShares(new Map([[1, 5], [2, 7]]), new Map([[1, 1], [2, 1]]), 100)]).toEqual([[1, 5], [2, 7]]);
  });
});

describe("admitting several views into one room", () => {
  const VOLUME = 1;
  const SLICE = 2;
  const quarters = new Map([[VOLUME, 1], [SLICE, 1]]);

  /** A volume view's ten-byte chunks ranking first, and a slice view's one-byte planes behind them. */
  function twoViews() {
    const volume = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => request(x, { mode: "volume" }));
    const slice = [0, 1, 2, 3].map((x) => request(x, { plane: 0, planes: [0, 1], priority: 100 + x }));
    const of = new Map<ChunkRequest, number>([...volume.map((r) => [r, VOLUME] as const), ...slice.map((r) => [r, SLICE] as const)]);
    return {
      volume,
      slice,
      plan: {
        requests: [...volume, ...slice],
        bytesOf: (req: ChunkRequest) => (req.planes ? 1 : 10),
        viewsOf: (req: ChunkRequest) => [of.get(req)!],
      },
    };
  }

  it("keeps the view whose requests rank behind from going without when the room cannot hold both", () => {
    const { plan, slice } = twoViews();
    const [admission] = admitPlans([plan], { detail: 50, coarse: 0 }, Infinity, quarters);
    // The slice view wants four bytes, under its half; the volume view takes the rest.
    expect(admission.admitted.filter((r) => r.mode === "slice")).toEqual(slice);
    expect(admission.admitted.filter((r) => r.mode === "volume").map((r) => r.x)).toEqual([0, 1, 2, 3]);
    expect(admission.shortfall.detail).toBe(4);
  });

  it("admits one view in priority order as before", () => {
    const { plan, volume } = twoViews();
    const [admission] = admitPlans([plan], { detail: 50, coarse: 0 }, Infinity, new Map([[VOLUME, 1]]));
    expect(admission.admitted).toEqual(volume.slice(0, 5));
  });

  it("weighs each view's share by its area", () => {
    const left = [0, 1, 2, 3, 4, 5].map((x) => request(x));
    const right = [0, 1, 2, 3, 4, 5].map((x) => request(x, { entityId: `other-${x}`, priority: 100 + x }));
    const of = new Map<ChunkRequest, number>([...left.map((r) => [r, 1] as const), ...right.map((r) => [r, 2] as const)]);
    const plan = { requests: [...left, ...right], bytesOf: TEN_BYTES, viewsOf: (req: ChunkRequest) => [of.get(req)!] };
    const [admission] = admitPlans([plan], { detail: 80, coarse: 0 }, Infinity, new Map([[1, 3], [2, 1]]));
    expect(admission.admitted.filter((r) => left.includes(r))).toHaveLength(6);
    expect(admission.admitted.filter((r) => right.includes(r))).toHaveLength(2);
  });

  it("divides the GPU room among views as well, when it is what runs short", () => {
    const { plan } = twoViews();
    const slotOf = (req: ChunkRequest): GpuSlot =>
      req.mode === "volume" ? { pool: "volume", slots: 100, slotBytes: 10 } : { pool: "slice", slots: 100, slotBytes: 1 };
    const [admission] = admitPlans([{ ...plan, slotOf }], { detail: 1_000, coarse: 0 }, 44, quarters);
    expect(admission.admitted.filter((r) => r.mode === "slice")).toHaveLength(4);
    expect(admission.admitted.filter((r) => r.mode === "volume")).toHaveLength(4);
  });

  it("hands what the shares leave to the requests next in priority order", () => {
    // Each view's share is 15 bytes: one ten-byte chunk each, and the ten
    // bytes left over go to the next request in order.
    const left = [0, 1, 2].map((x) => request(x));
    const right = [0, 1, 2].map((x) => request(x, { entityId: `other-${x}`, priority: 100 + x }));
    const of = new Map<ChunkRequest, number>([...left.map((r) => [r, 1] as const), ...right.map((r) => [r, 2] as const)]);
    const plan = { requests: [...left, ...right], bytesOf: TEN_BYTES, viewsOf: (req: ChunkRequest) => [of.get(req)!] };
    const [admission] = admitPlans([plan], { detail: 30, coarse: 0 }, Infinity, quarters);
    expect(admission.admitted).toEqual([left[0], left[1], right[0]]);
    expect(admission.shortfall.detail).toBe(3);
  });

  it("charges a request two views asked for once", () => {
    const shared = request(0);
    const own = [1, 2, 3].map((x) => request(x, { priority: 100 + x }));
    const plan = {
      requests: [shared, ...own],
      bytesOf: TEN_BYTES,
      viewsOf: (req: ChunkRequest) => (req === shared ? [1, 2] : [2]),
    };
    const [admission] = admitPlans([plan], { detail: 30, coarse: 0 }, Infinity, quarters);
    expect(admission.admitted).toEqual([shared, own[0], own[1]]);
  });
});

describe("admitPlans with planes", () => {
  it("charges a request for some planes of a chunk apart from one for all of it", () => {
    const planes = request(0, { plane: 1, planes: [0, 3] });
    const whole = request(0, { lane: "prefetch", priority: 300 });
    const bytesOf = (req: ChunkRequest) => (req.planes ? 3 : 8);
    const admission = admitPlans([{ requests: [planes, whole], bytesOf }], { detail: 10, coarse: 0 })[0];
    // The whole chunk does not fit beside its planes, and goes without.
    expect(admission.admitted).toEqual([planes]);
    expect(admission.shortfall.detail).toBe(0);
  });
});

describe("admitPlans against what the cache holds", () => {
  it("charges a request for planes the whole chunk the cache holds for it, once with a request for the whole", () => {
    const planes = [0, 1, 2].map((x) => request(x, { plane: 1, planes: [0, 3] }));
    const whole = request(0, { mode: "volume", priority: 10 });
    const bytesOf = (req: ChunkRequest, all?: boolean) => (req.planes && !all ? 3 : 8);
    const heldWhole = (req: ChunkRequest) => req.x === 0;
    const [admission] = admitPlans([{ requests: [...planes, whole], bytesOf, heldWhole }], { detail: 13, coarse: 0 });
    // Chunk 0 costs its whole 8 bytes, which the volume view's request for it
    // shares; the other two cost their planes.
    expect(admission.admitted).toEqual([...planes.slice(0, 2), whole]);
    expect(admission.shortfall.detail).toBe(1);
  });
});

describe("chunkBytesFor", () => {
  it("charges a level's chunk at the image's sample size, one timepoint and one channel", () => {
    const manifest = {
      images: [
        {
          image_id: "image",
          multiscale: {
            data_type: "Uint16",
            levels: [
              { level_index: 0, chunk_shape: [1, 3, 8, 64, 64] },
              { level_index: 1, chunk_shape: [1, 3, 4, 32, 32] },
            ],
          },
        },
      ],
    } as unknown as DatasetManifest;
    const bytesOf = chunkBytesFor(manifest);
    expect(bytesOf(request(0))).toBe(8 * 64 * 64 * 2);
    expect(bytesOf(request(0, { level: 1 }))).toBe(4 * 32 * 32 * 2);
    // Three of the eight planes cost three eighths of the chunk, or all of it held whole.
    expect(bytesOf(request(0, { plane: 1, planes: [0, 3] }))).toBe(3 * 64 * 64 * 2);
    expect(bytesOf(request(0, { plane: 1, planes: [0, 3] }), true)).toBe(8 * 64 * 64 * 2);
  });

  it("charges every type that decodes to float32 four bytes a sample", () => {
    for (const dataType of ["Int8", "Int16", "Float64", "Int64", "Uint64", "Float16"]) {
      const manifest = {
        images: [{
          image_id: "image",
          multiscale: { data_type: dataType, levels: [{ level_index: 0, chunk_shape: [1, 1, 1, 8, 8] }] },
        }],
      } as unknown as DatasetManifest;
      expect(chunkBytesFor(manifest)(request(0)), dataType).toBe(8 * 8 * 4);
    }
  });
  it("charges a label's chunk and its planes, which the bytes a fetch holds in flight are charged at", () => {
    const manifest = {
      images: [],
      labels: [{
        image: {
          image_id: "label",
          multiscale: { data_type: "Uint32", levels: [{ level_index: 0, chunk_shape: [1, 1, 32, 64, 64] }] },
        },
      }],
    } as unknown as DatasetManifest;
    const bytesOf = chunkBytesFor(manifest);
    expect(bytesOf(request(0, { imageId: "label" }))).toBe(32 * 64 * 64 * 4);
    expect(bytesOf(request(0, { imageId: "label", plane: 3, planes: [1, 6] }))).toBe(5 * 64 * 64 * 4);
  });
});
