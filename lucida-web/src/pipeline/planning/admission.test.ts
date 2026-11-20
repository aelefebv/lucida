import { describe, expect, it } from "vitest";

import type { DatasetManifest } from "../../manifestTypes.ts";
import { AdmissionLedger, admitPlans, chunkBytesFor, type GpuSlot, type PerTier } from "./admission.ts";
import { compareChunkRequests } from "./emit.ts";
import type { ChunkRequest, RequestDelta } from "./types.ts";

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

describe("AdmissionLedger", () => {
  const slotOf = (req: ChunkRequest): GpuSlot | null =>
    req.lane === "detail" || req.lane === "coarse" ? { pool: `${req.tier}-${req.x % 3}`, slots: 40, slotBytes: 10 } : null;
  const SOURCES = ["manifest", "report"];

  /** `next` as a plan carried from `base`: what it added and removed. */
  function deltaOf(base: readonly ChunkRequest[], next: readonly ChunkRequest[]): RequestDelta {
    const before = new Set(base);
    const after = new Set(next);
    return { base, added: next.filter((req) => !before.has(req)), removed: base.filter((req) => !after.has(req)) };
  }

  it("admits a plan's delta whole while everything fits, and passes the delta on", () => {
    const ledger = new AdmissionLedger();
    const first = [0, 1, 2].map((x) => request(x));
    const [a] = ledger.admit([{ requests: first, bytesOf: TEN_BYTES, slotOf }], { detail: 100, coarse: 0 }, 1_000, SOURCES);
    expect(a.admitted).toBe(first);
    expect(a.delta).toBeUndefined();

    const second = [first[1], first[2], request(3)];
    const delta = deltaOf(first, second);
    const [b] = ledger.admit([{ requests: second, bytesOf: TEN_BYTES, slotOf, delta }], { detail: 100, coarse: 0 }, 1_000, SOURCES);
    expect(b.admitted).toBe(second);
    expect(b.delta).toBe(delta);
    expect(b.shortfall).toEqual({ detail: 0, coarse: 0 });
  });

  it("admits again in priority order once a delta no longer fits", () => {
    const ledger = new AdmissionLedger();
    const first = [0, 1, 2].map((x) => request(x));
    ledger.admit([{ requests: first, bytesOf: TEN_BYTES }], { detail: 30, coarse: 0 }, Infinity, SOURCES);
    const second = [...first, request(3)];
    const [b] = ledger.admit(
      [{ requests: second, bytesOf: TEN_BYTES, delta: deltaOf(first, second) }], { detail: 30, coarse: 0 }, Infinity, SOURCES,
    );
    expect(b.admitted.map((r) => r.x)).toEqual([0, 1, 2]);
    expect(b.shortfall.detail).toBe(1);
    expect(b.delta).toBeUndefined();
  });

  it("carries through a change of room that everything still fits", () => {
    const ledger = new AdmissionLedger();
    const first = [0, 1].map((x) => request(x));
    ledger.admit([{ requests: first, bytesOf: TEN_BYTES, slotOf }], { detail: 100, coarse: 0 }, 1_000, SOURCES);
    const second = [...first, request(2)];
    const delta = deltaOf(first, second);
    const [b] = ledger.admit([{ requests: second, bytesOf: TEN_BYTES, slotOf, delta }], { detail: 30, coarse: 0 }, 30, SOURCES);
    expect(b.admitted).toBe(second);
    expect(b.delta).toBe(delta);
  });

  it("admits again when what the bytes and slots are read from changed", () => {
    const ledger = new AdmissionLedger();
    const first = [0, 1].map((x) => request(x));
    ledger.admit([{ requests: first, bytesOf: TEN_BYTES }], { detail: 100, coarse: 0 }, Infinity, SOURCES);
    const second = [first[0]];
    const [b] = ledger.admit(
      [{ requests: second, bytesOf: TEN_BYTES, delta: deltaOf(first, second) }], { detail: 100, coarse: 0 }, Infinity, ["manifest", "new report"],
    );
    expect(b.admitted).toBe(second);
    // Both admissions took the whole plan, so the delta still says how the admitted set changed.
    expect(b.delta?.removed).toEqual([first[1]]);
  });

  it("admits what admitting every plan from nothing admits, over a run of replans", () => {
    // A deterministic stream of replans, each adding and removing a few
    // requests across lanes, tiers and pools, some of which no longer fit.
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const lanes = ["detail", "detail", "detail", "coarse", "prefetch", "minimap"] as const;
    const pool = Array.from({ length: 80 }, (_, x) => request(x % 50, {
      lane: lanes[x % lanes.length],
      priority: x,
      entityId: `tile-${x % 50}`,
    })).sort(compareChunkRequests);
    const bytesOf = (req: ChunkRequest) => 8 + (req.x % 5);
    let capacity = { detail: 260, coarse: 40 };
    let room = 400;
    const ledger = new AdmissionLedger();
    let current: ChunkRequest[] = pool.filter(() => random() < 0.4);
    ledger.admit([{ requests: current, bytesOf, slotOf }], capacity, room, SOURCES);
    for (let step = 0; step < 300; step++) {
      // Now and then the budgets and the GPU room move, as a report moves them.
      if (random() < 0.1) {
        capacity = { detail: 220 + Math.floor(random() * 80), coarse: 30 + Math.floor(random() * 20) };
        room = 350 + Math.floor(random() * 100);
      }
      const next = pool.filter((req) => (current.includes(req) ? random() > 0.08 : random() < 0.06));
      const carried = ledger.admit([{ requests: next, bytesOf, slotOf, delta: deltaOf(current, next) }], capacity, room, SOURCES)[0];
      const fresh = admitPlans([{ requests: next, bytesOf, slotOf }], capacity, room)[0];
      expect(carried.admitted).toEqual(fresh.admitted);
      expect(carried.shortfall).toEqual(fresh.shortfall);
      expect(carried.borrowed).toBe(fresh.borrowed);
      current = next;
    }
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
