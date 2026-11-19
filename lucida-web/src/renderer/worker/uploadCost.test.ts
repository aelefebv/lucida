import { describe, expect, it } from "vitest";
import type { MainToWorkerMessage, UploadCostMessage } from "../workerProtocol.ts";
import { chunkDeliveryOf, UPLOAD_REPORT_MS, UploadCostMeter } from "./uploadCost.ts";

function chunks(...sizes: number[]) {
  return sizes.map((size, i) => ({ data: new ArrayBuffer(size), dataType: "uint16", x: i, y: 0, z: 0, key: `0/0/0/0/0/${i}` }));
}

describe("chunkDeliveryOf", () => {
  it("names the pools each chunk delivery goes to and the bytes it carries", () => {
    const cases: [Partial<MainToWorkerMessage>, string][] = [
      [{ type: "sliceChunkData" }, "slice"],
      [{ type: "labelSliceChunkData" }, "slice"],
      [{ type: "volumeChunkData" }, "volume"],
      [{ type: "labelVolumeChunkData" }, "volume"],
    ];
    for (const [msg, mode] of cases) {
      const delivery = chunkDeliveryOf({ ...msg, chunks: chunks(100, 28) } as MainToWorkerMessage);
      expect(delivery, msg.type).toEqual({ mode, bytes: 128 });
    }
  });

  it("is null for any other message", () => {
    expect(chunkDeliveryOf({ type: "resize", width: 1, height: 1 })).toBeNull();
  });
});

describe("UploadCostMeter", () => {
  function meter() {
    const posted: UploadCostMessage[] = [];
    const flushes: (() => void)[] = [];
    const gpu: (() => void)[] = [];
    const gpuDone = () => new Promise<void>((resolve) => gpu.push(resolve));
    const m = new UploadCostMeter((msg) => posted.push(msg), gpuDone, (flush) => flushes.push(flush));
    return { m, posted, flushes, gpu };
  }

  it("reports once the deliveries queued have run and the GPU is done with them, one report per mode", async () => {
    const { m, posted, flushes, gpu } = meter();
    m.note("volume", 512, 0.5);
    m.note("volume", 512, 0.25);
    m.note("slice", 64, 0.1);
    expect(flushes).toHaveLength(1);

    flushes[0]();
    await Promise.resolve();
    expect(posted).toEqual([]);
    gpu[0]();
    await Promise.resolve();
    expect(posted).toEqual([
      { type: "uploadCost", mode: "slice", bytes: 64, ms: 0.1 },
      { type: "uploadCost", mode: "volume", bytes: 1024, ms: 0.75 },
    ]);
  });

  it("reports without waiting for the rest of the queue once enough delivery time has built up", async () => {
    const { m, posted, gpu } = meter();
    m.note("volume", 1024, UPLOAD_REPORT_MS / 2);
    expect(gpu).toHaveLength(0);
    m.note("volume", 1024, UPLOAD_REPORT_MS / 2);
    expect(gpu).toHaveLength(1);
    gpu[0]();
    await Promise.resolve();
    expect(posted).toEqual([{ type: "uploadCost", mode: "volume", bytes: 2048, ms: UPLOAD_REPORT_MS }]);

    // The next delivery starts a report of its own.
    m.note("volume", 256, 0.2);
    expect(gpu).toHaveLength(1);
  });

  it("still reports when the GPU's answer fails, as a lost device's can", async () => {
    const posted: UploadCostMessage[] = [];
    const m = new UploadCostMeter((msg) => posted.push(msg), () => Promise.reject(new Error("lost")), (flush) => flush());
    m.note("slice", 64, 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toEqual([{ type: "uploadCost", mode: "slice", bytes: 64, ms: 0.1 }]);
  });
});
