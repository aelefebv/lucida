import { describe, expect, it } from "vitest";

import type { DatasetManifest } from "../../manifestTypes.ts";
import type { GpuCapacityReport } from "../../renderer/workerProtocol.ts";
import type { ChunkRequest } from "./types.ts";
import { gpuChunkRoomBytes, gpuSlotsFor } from "./gpuCapacity.ts";

const MIB = 1024 * 1024;

/** The WebGPU minimums. */
const MIN_LIMITS = {
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxStorageBufferBindingSize: 128 * MIB,
  maxBufferSize: 256 * MIB,
};

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
    lane: "detail", tier: "detail", mode: "slice", priority: 0, chunkKey: "0/0/1/0/0/0",
    ...overrides,
  };
}

describe("gpuSlotsFor", () => {
  it("reads a pool's slots and slot bytes from the worker's report, under the worker's own pool key", () => {
    const report: GpuCapacityReport = {
      budgetBytes: 768 * MIB,
      reservedBytes: 40 * MIB,
      pools: [{ poolKey: "ds:ch1:128x128:detail", datasetId: "ds", tier: "detail", slotBytes: 32_768, slots: 64, maxSlots: 4096 }],
      limits: MIN_LIMITS,
    };
    const slotOf = gpuSlotsFor(manifest, report, 1536 * MIB);
    expect(slotOf(request())).toEqual({ pool: "ds:ch1:128x128:detail", slots: 4096, slotBytes: 32_768 });
  });

  it("sizes a pool the worker has not made yet as the worker would, in either mode", () => {
    const slice = gpuSlotsFor(manifest, null, 256 * MIB)(request({ level: 1 }));
    // 256 MiB of 8 KiB slots would be 32,768, but 128 a side is all the texture limit allows.
    expect(slice).toEqual({ pool: "ds:ch1:64x64:detail", slots: 128 * 128, slotBytes: 64 * 64 * 2 });
    const volume = gpuSlotsFor(manifest, null, 256 * MIB)(request({ tier: "coarse", lane: "coarse", mode: "volume" }));
    expect(volume?.pool).toBe("ds:ch1:128x128x32:coarse");
    expect(volume?.slotBytes).toBe(128 * 128 * 32 * 2);
    expect(volume?.slots).toBe(256);
  });

  it("sizes a pool the worker has not made yet from the device limits it reports", () => {
    const level1 = request({ level: 1, mode: "volume" });
    // 256 KiB slots: the minimums' largest buffer holds 1,024 of them, and
    // this device's lets the pool grow to the 1.5 GiB total.
    expect(gpuSlotsFor(manifest, null, 1536 * MIB)(level1)?.slots).toBe(1024);
    const report: GpuCapacityReport = {
      budgetBytes: 1536 * MIB,
      reservedBytes: 0,
      pools: [],
      limits: { ...MIN_LIMITS, maxBufferSize: 2048 * MIB },
    };
    expect(gpuSlotsFor(manifest, report, 1536 * MIB)(level1)?.slots).toBe(6144);
    // A total smaller than the largest buffer caps the pool at the total.
    expect(gpuSlotsFor(manifest, { ...report, budgetBytes: 512 * MIB }, 1536 * MIB)(level1)?.slots).toBe(2048);
  });

  it("puts each chunk in the pools of the mode that asked, so one dataset's slice and volume pools both admit", () => {
    const slotOf = gpuSlotsFor(manifest, null, 256 * MIB, "y");
    expect(slotOf(request())?.pool).toBe("ds:ch1:128x32@y:detail");
    expect(slotOf(request({ mode: "volume" }))?.pool).toBe("ds:ch1:128x128x32:detail");
  });

  it("puts no prefetch or minimap chunk in a pool", () => {
    const slotOf = gpuSlotsFor(manifest, null, 256 * MIB);
    expect(slotOf(request({ lane: "prefetch" }))).toBeNull();
    expect(slotOf(request({ lane: "minimap" }))).toBeNull();
  });
});

describe("gpuChunkRoomBytes", () => {
  it("leaves the chunk pools what the other holders don't take of the total", () => {
    expect(gpuChunkRoomBytes({ budgetBytes: 768 * MIB, reservedBytes: 68 * MIB, pools: [], limits: MIN_LIMITS }, 0)).toBe(700 * MIB);
    expect(gpuChunkRoomBytes(null, 1536 * MIB)).toBe(1536 * MIB);
  });
});
