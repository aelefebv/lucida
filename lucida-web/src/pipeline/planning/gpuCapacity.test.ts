import { describe, expect, it } from "vitest";

import type { DatasetManifest } from "../../manifestTypes.ts";
import type { GpuCapacityReport } from "../../renderer/workerProtocol.ts";
import type { ChunkRequest } from "./types.ts";
import { gpuChunkRoomBytes, gpuSlotsFor } from "./gpuCapacity.ts";

const MIB = 1024 * 1024;

const manifest = {
  images: [{
    image_id: "img",
    owner: "ent",
    multiscale: {
      axes: [],
      data_type: "uint16",
      levels: [
        { level_index: 0, shape: [1, 2, 64, 1024, 1024], chunk_shape: [1, 1, 32, 128, 128], grid_shape: [1, 2, 2, 8, 8], scale: [1, 1, 1, 1, 1] },
        { level_index: 1, shape: [1, 2, 32, 512, 512], chunk_shape: [1, 1, 32, 64, 64], grid_shape: [1, 2, 1, 8, 8], scale: [1, 1, 2, 2, 2] },
      ],
    },
  }],
} as unknown as DatasetManifest;

function request(overrides: Partial<ChunkRequest> = {}): ChunkRequest {
  return {
    datasetId: "ds", entityId: "ent", imageId: "img", level: 0, t: 0, c: 1, z: 0, y: 0, x: 0,
    lane: "detail", tier: "detail", priority: 0, chunkKey: "0/0/1/0/0/0",
    ...overrides,
  };
}

describe("gpuSlotsFor", () => {
  it("reads a pool's slots and slot bytes from the worker's report, under the worker's own pool key", () => {
    const report: GpuCapacityReport = {
      budgetBytes: 768 * MIB,
      reservedBytes: 40 * MIB,
      pools: [{ poolKey: "ds:ch1:128x128:detail", datasetId: "ds", tier: "detail", slotBytes: 32_768, slots: 64, maxSlots: 4096 }],
    };
    const slotOf = gpuSlotsFor(manifest, "slice", report, 1536 * MIB);
    expect(slotOf(request())).toEqual({ pool: "ds:ch1:128x128:detail", slots: 4096, slotBytes: 32_768 });
  });

  it("sizes a pool the worker has not made yet as the worker would, in either mode", () => {
    const slice = gpuSlotsFor(manifest, "slice", null, 256 * MIB)(request({ level: 1 }));
    // 256 MiB of 8 KiB slots would be 32,768, but 128 a side is all the texture limit allows.
    expect(slice).toEqual({ pool: "ds:ch1:64x64:detail", slots: 128 * 128, slotBytes: 64 * 64 * 2 });
    const volume = gpuSlotsFor(manifest, "volume", null, 256 * MIB)(request({ tier: "coarse", lane: "coarse" }));
    expect(volume?.pool).toBe("ds:ch1:128x128x32:coarse");
    expect(volume?.slotBytes).toBe(128 * 128 * 32 * 2);
    expect(volume?.slots).toBe(256);
  });

  it("puts no prefetch or minimap chunk in a pool", () => {
    const slotOf = gpuSlotsFor(manifest, "slice", null, 256 * MIB);
    expect(slotOf(request({ lane: "prefetch" }))).toBeNull();
    expect(slotOf(request({ lane: "minimap" }))).toBeNull();
  });
});

describe("gpuChunkRoomBytes", () => {
  it("leaves the chunk pools what the other holders don't take of the total", () => {
    expect(gpuChunkRoomBytes({ budgetBytes: 768 * MIB, reservedBytes: 68 * MIB, pools: [] }, 0)).toBe(700 * MIB);
    expect(gpuChunkRoomBytes(null, 1536 * MIB)).toBe(1536 * MIB);
  });
});
