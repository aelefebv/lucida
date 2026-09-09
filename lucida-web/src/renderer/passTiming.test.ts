/**
 * The frame pass timer, driven through a fake device: which passes get which
 * stamps, what is submitted after a frame, what the read-back reports, and
 * that a frame with nowhere to read back into goes unmeasured rather than
 * waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFrameTiming, FramePassTimer, UNTIMED } from "./passTiming.ts";

class FakeBuffer {
  readonly usage: number;
  destroyed = false;
  private readonly stamps = new BigUint64Array(2);
  private pending: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(usage: number) {
    this.usage = usage;
  }

  mapAsync(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  getMappedRange(): ArrayBuffer {
    return this.stamps.buffer as ArrayBuffer;
  }

  unmap(): void {}

  destroy(): void {
    this.destroyed = true;
  }

  land(beginNs: bigint, endNs: bigint): void {
    this.stamps[0] = beginNs;
    this.stamps[1] = endNs;
    this.pending!.resolve();
    this.pending = null;
  }

  fail(): void {
    this.pending!.reject(new Error("device lost"));
    this.pending = null;
  }

  get mapping(): boolean {
    return this.pending !== null;
  }
}

interface FakeDevice {
  device: GPUDevice;
  features: Set<string>;
  buffers: FakeBuffer[];
  querySets: Array<{ count: number; destroyed: boolean }>;
  submits: Array<Array<{ ops: unknown[][] }>>;
}

function fakeDevice(features: string[]): FakeDevice {
  const buffers: FakeBuffer[] = [];
  const querySets: FakeDevice["querySets"] = [];
  const submits: FakeDevice["submits"] = [];
  const device = {
    features: new Set(features),
    createQuerySet: (desc: { count: number }) => {
      const set = { count: desc.count, destroyed: false, destroy: () => void (set.destroyed = true) };
      querySets.push(set);
      return set;
    },
    createBuffer: (desc: { usage: number }) => {
      const buffer = new FakeBuffer(desc.usage);
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: () => {
      const encoder = {
        ops: [] as unknown[][],
        resolveQuerySet: (...args: unknown[]) => void encoder.ops.push(["resolve", ...args]),
        copyBufferToBuffer: (...args: unknown[]) => void encoder.ops.push(["copy", ...args]),
        finish: () => encoder,
      };
      return encoder;
    },
    queue: { submit: (buffers: Array<{ ops: unknown[][] }>) => void submits.push(buffers) },
  };
  return { device: device as unknown as GPUDevice, features: device.features, buffers, querySets, submits };
}

function readBacks(fake: FakeDevice): FakeBuffer[] {
  return fake.buffers.filter((buffer) => (buffer.usage & GPUBufferUsage.MAP_READ) !== 0);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("FramePassTimer", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_DST: 8, COPY_SRC: 4, QUERY_RESOLVE: 512 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("times nothing on a device without timestamp queries", () => {
    const fake = fakeDevice([]);
    const timing = createFrameTiming(fake.device, () => {});

    expect(timing).toBe(UNTIMED);
    expect(fake.buffers).toHaveLength(0);
    timing.beginFrame();
    expect(timing.nextPass()).toBeUndefined();
    timing.endFrame();
    expect(fake.submits).toHaveLength(0);
  });

  it("is the real timer on a device with timestamp queries", () => {
    const fake = fakeDevice(["timestamp-query"]);
    expect(createFrameTiming(fake.device, () => {})).toBeInstanceOf(FramePassTimer);
  });

  it("stamps the first pass at both ends and every later pass at its end only", () => {
    const fake = fakeDevice(["timestamp-query"]);
    const timer = FramePassTimer.create(fake.device, () => {})!;

    timer.beginFrame();
    const first = timer.nextPass()!;
    const second = timer.nextPass()!;
    const third = timer.nextPass()!;

    expect(first.beginningOfPassWriteIndex).toBe(0);
    expect(first.endOfPassWriteIndex).toBe(1);
    expect(second.beginningOfPassWriteIndex).toBeUndefined();
    expect(second.endOfPassWriteIndex).toBe(1);
    expect(third.endOfPassWriteIndex).toBe(1);
    expect(first.querySet).toBe(second.querySet);
  });

  it("resolves and copies the two stamps after the frame's passes, then reports the difference in microseconds", async () => {
    const fake = fakeDevice(["timestamp-query"]);
    const reported: number[] = [];
    const timer = FramePassTimer.create(fake.device, (us) => reported.push(us))!;

    timer.beginFrame();
    timer.nextPass();
    timer.nextPass();
    timer.endFrame();

    expect(fake.submits).toHaveLength(1);
    const ops = fake.submits[0][0].ops;
    expect(ops[0][0]).toBe("resolve");
    expect(ops[0].slice(2, 4)).toEqual([0, 2]);
    expect(ops[1][0]).toBe("copy");

    const readBack = readBacks(fake).find((buffer) => buffer.mapping)!;
    expect(reported).toEqual([]);
    readBack.land(1_000n, 2_250_000n);
    await settle();
    expect(reported).toEqual([2_249]);
  });

  it("reads and submits nothing for a frame that encoded no pass", () => {
    const fake = fakeDevice(["timestamp-query"]);
    const timer = FramePassTimer.create(fake.device, () => {})!;

    timer.beginFrame();
    timer.endFrame();

    expect(fake.submits).toHaveLength(0);
    expect(readBacks(fake).some((buffer) => buffer.mapping)).toBe(false);
  });

  it("leaves a frame unmeasured when every read-back buffer is still mapped, and resumes when one lands", async () => {
    const fake = fakeDevice(["timestamp-query"]);
    const reported: number[] = [];
    const timer = FramePassTimer.create(fake.device, (us) => reported.push(us))!;

    const pool = readBacks(fake).length;
    for (let i = 0; i < pool; i++) {
      timer.beginFrame();
      expect(timer.nextPass()).toBeDefined();
      timer.endFrame();
    }
    timer.beginFrame();
    expect(timer.nextPass()).toBeUndefined();
    timer.endFrame();
    expect(fake.submits).toHaveLength(pool);

    readBacks(fake)[pool - 1].land(0n, 500_000n);
    await settle();
    expect(reported).toEqual([500]);

    timer.beginFrame();
    expect(timer.nextPass()).toBeDefined();
    timer.endFrame();
    expect(fake.submits).toHaveLength(pool + 1);
  });

  it("reports nothing for a lost read-back and returns the buffer to the pool", async () => {
    const fake = fakeDevice(["timestamp-query"]);
    const reported: number[] = [];
    const timer = FramePassTimer.create(fake.device, (us) => reported.push(us))!;

    timer.beginFrame();
    timer.nextPass();
    timer.endFrame();
    readBacks(fake).find((buffer) => buffer.mapping)!.fail();
    await settle();

    expect(reported).toEqual([]);
    timer.beginFrame();
    expect(timer.nextPass()).toBeDefined();
  });

  it("reports a reversed stamp pair as nothing rather than as a negative or a zero", async () => {
    const fake = fakeDevice(["timestamp-query"]);
    const reported: number[] = [];
    const timer = FramePassTimer.create(fake.device, (us) => reported.push(us))!;

    timer.beginFrame();
    timer.nextPass();
    timer.endFrame();
    readBacks(fake).find((buffer) => buffer.mapping)!.land(9_000n, 1_000n);
    await settle();

    expect(reported).toEqual([]);
  });

  it("destroys its resources, including a read-back that lands afterwards", async () => {
    const fake = fakeDevice(["timestamp-query"]);
    const timer = FramePassTimer.create(fake.device, () => {})!;

    timer.beginFrame();
    timer.nextPass();
    timer.endFrame();
    const late = readBacks(fake).find((buffer) => buffer.mapping)!;
    timer.destroy();

    expect(fake.querySets[0].destroyed).toBe(true);
    expect(fake.buffers.filter((buffer) => buffer !== late).every((buffer) => buffer.destroyed)).toBe(true);
    expect(late.destroyed).toBe(false);

    late.land(0n, 1n);
    await settle();
    expect(late.destroyed).toBe(true);

    timer.beginFrame();
    expect(timer.nextPass()).toBeUndefined();
  });
});
