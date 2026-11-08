import { describe, expect, it } from "vitest";

import type { DatasetManifest } from "../../manifestTypes.ts";
import { admitRequests, chunkBytesFor, sliceSlotsFor } from "./admission.ts";
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
    priority: x,
    chunkKey: `0/0/0/0/0/${x}`,
    ...overrides,
  };
}

const TEN_BYTES = () => 10;

describe("admitRequests", () => {
  it("admits in priority order up to each tier's room and declares the rest", () => {
    const requests = [0, 1, 2, 3, 4].map((x) => request(x));
    const admission = admitRequests(requests, { detail: 30, coarse: 0 }, TEN_BYTES);
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1, 2]);
    expect(admission.shortfall).toEqual({ detail: 2, coarse: 0 });
    expect(admission.remaining).toEqual({ detail: 0, coarse: 0 });
  });

  it("drops prefetch that does not fit without counting it against coverage", () => {
    const requests = [request(0), request(1, { lane: "prefetch" }), request(2, { lane: "prefetch" })];
    const admission = admitRequests(requests, { detail: 20, coarse: 0 }, TEN_BYTES);
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1]);
    expect(admission.shortfall.detail).toBe(0);
  });

  it("lets the coarse tier take the room detail leaves, and says how much it borrowed", () => {
    const requests = [request(0), ...[1, 2, 3, 4].map((x) => request(x, { lane: "coarse" }))];
    const admission = admitRequests(requests, { detail: 30, coarse: 20 }, TEN_BYTES);
    expect(admission.admitted).toHaveLength(5);
    expect(admission.shortfall).toEqual({ detail: 0, coarse: 0 });
    expect(admission.borrowed).toBe(20);
    expect(admission.remaining).toEqual({ detail: 0, coarse: 0 });
  });

  it("admits or refuses two lanes' demand for one chunk together, charged once", () => {
    const requests = [
      request(0, { lane: "coarse" }),
      request(1, { lane: "coarse" }),
      request(0, { lane: "minimap", priority: 9 }),
    ];
    const admission = admitRequests(requests, { detail: 0, coarse: 10 }, TEN_BYTES);
    expect(admission.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["coarse:0", "minimap:0"]);
    expect(admission.shortfall.coarse).toBe(1);
  });
});

describe("admitting against GPU slot pools", () => {
  it("admits no more chunks into a pool than it has slots, and counts the rest short", () => {
    const requests = [0, 1, 2, 3].map((x) => request(x));
    const slotOf = () => ({ pool: "p", slots: 2 });
    const admission = admitRequests(requests, { detail: 1_000, coarse: 0 }, TEN_BYTES, slotOf);
    expect(admission.admitted.map((r) => r.x)).toEqual([0, 1]);
    expect(admission.shortfall.detail).toBe(2);
  });

  it("keeps a chunk for a lane that never uploads when the pool refuses its upload", () => {
    const requests = [
      request(0, { lane: "coarse" }),
      request(1, { lane: "coarse" }),
      request(1, { lane: "minimap", priority: 9 }),
    ];
    const slotOf = (req: ChunkRequest) => (req.lane === "coarse" ? { pool: "p", slots: 1 } : null);
    const admission = admitRequests(requests, { detail: 0, coarse: 100 }, TEN_BYTES, slotOf);
    expect(admission.admitted.map((r) => `${r.lane}:${r.x}`)).toEqual(["coarse:0", "minimap:1"]);
    expect(admission.shortfall.coarse).toBe(1);
  });

  it("sizes a slice pool from the atlas budget and the level's chunk plane", () => {
    const manifest = {
      images: [
        {
          image_id: "image",
          multiscale: { data_type: "Uint16", levels: [{ level_index: 0, chunk_shape: [1, 1, 1, 256, 256] }] },
        },
      ],
    } as unknown as DatasetManifest;
    // 64 MiB of 128 KiB slots is 512, laid out 22 by 22.
    const slot = sliceSlotsFor(manifest, 64 * 1024 * 1024)(request(0));
    expect(slot?.slots).toBe(22 * 22);
    expect(sliceSlotsFor(manifest, 64 * 1024 * 1024)(request(0, { lane: "prefetch" }))).toBeNull();
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
  });
});
