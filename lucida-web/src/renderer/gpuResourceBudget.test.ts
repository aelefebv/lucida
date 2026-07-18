import { describe, expect, it, vi } from "vitest";
import {
  GpuBudgetExceededError,
  GpuResourceBudget,
  texturePayloadBytes,
} from "./gpuResourceBudget.ts";

function resource() {
  return { destroy: vi.fn() };
}

describe("GpuResourceBudget", () => {
  it("enforces one limit across kinds and datasets", () => {
    const budget = new GpuResourceBudget(100);
    budget.allocate({ key: "volume:a", kind: "volume-atlas", datasetId: "a" }, 60, resource);
    budget.allocate({ key: "slice:b", kind: "slice-atlas", datasetId: "b" }, 40, resource);

    expect(() => budget.allocate(
      { key: "offscreen", kind: "offscreen" },
      1,
      resource,
    )).toThrow(GpuBudgetExceededError);
    expect(budget.snapshot()).toMatchObject({ usedBytes: 100, allocationCount: 2 });
  });

  it("rolls back a reservation when device allocation fails", () => {
    const budget = new GpuResourceBudget(100);
    expect(() => budget.allocate(
      { key: "broken", kind: "buffer" },
      80,
      () => { throw new Error("device OOM"); },
    )).toThrow("device OOM");
    expect(budget.snapshot()).toMatchObject({ usedBytes: 0, allocationCount: 0 });
  });

  it("destroys an allocation exactly once", () => {
    const budget = new GpuResourceBudget(100);
    const gpu = resource();
    const allocation = budget.allocate(
      { key: "one", kind: "buffer" },
      20,
      () => gpu,
    );
    allocation.destroy();
    allocation.destroy();
    budget.destroyAll();

    expect(gpu.destroy).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 0,
      allocationCount: 0,
      createdCount: 1,
      destroyedCount: 1,
      createdBytes: 20,
      destroyedBytes: 20,
    });
  });

  it("reclaims all and only resources explicitly owned by a dataset", () => {
    const budget = new GpuResourceBudget(100);
    const a1 = resource();
    const a2 = resource();
    const b = resource();
    budget.allocate({ key: "a:atlas", kind: "volume-atlas", datasetId: "a" }, 25, () => a1);
    budget.allocate({ key: "a:descriptor", kind: "descriptor", datasetId: "a" }, 10, () => a2);
    budget.allocate({ key: "b:atlas", kind: "slice-atlas", datasetId: "b" }, 30, () => b);

    budget.destroyDataset("a");
    budget.destroyDataset("a");

    expect(a1.destroy).toHaveBeenCalledTimes(1);
    expect(a2.destroy).toHaveBeenCalledTimes(1);
    expect(b.destroy).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 30,
      allocationCount: 1,
      byDataset: { b: 30 },
    });
  });

  it("rejects duplicate live ownership keys", () => {
    const budget = new GpuResourceBudget(100);
    const allocation = budget.allocate({ key: "same", kind: "buffer" }, 10, resource);
    expect(() => budget.allocate({ key: "same", kind: "buffer" }, 10, resource))
      .toThrow("already has a live allocation");
    allocation.destroy();
    expect(() => budget.allocate({ key: "same", kind: "buffer" }, 10, resource))
      .not.toThrow();
  });

  it("derives buffer and texture charges at the creation boundary", () => {
    const buffer = resource() as unknown as GPUBuffer;
    const texture = resource() as unknown as GPUTexture;
    const device = {
      createBuffer: vi.fn(() => buffer),
      createTexture: vi.fn(() => texture),
    } as unknown as GPUDevice;
    const budget = new GpuResourceBudget(10_000);

    budget.createBuffer(
      device,
      { key: "buffer", kind: "buffer" },
      { size: 256, usage: 0 },
    );
    budget.createTexture(
      device,
      { key: "texture", kind: "offscreen" },
      { size: [20, 10], format: "rgba16float", usage: 0 },
    );

    expect(budget.snapshot()).toMatchObject({
      usedBytes: 256 + 20 * 10 * 8,
      allocationCount: 2,
      byKind: { buffer: 256, offscreen: 1600 },
    });
  });

  it("accounts mip levels, 3D depth, layers, and samples deterministically", () => {
    expect(texturePayloadBytes({
      size: [8, 4, 2],
      dimension: "3d",
      mipLevelCount: 3,
      sampleCount: 1,
      format: "r16uint",
      usage: 0,
    })).toBe((8 * 4 * 2 + 4 * 2 * 1 + 2 * 1 * 1) * 2);
    expect(texturePayloadBytes({
      size: { width: 4, height: 4, depthOrArrayLayers: 3 },
      mipLevelCount: 2,
      sampleCount: 4,
      format: "rgba8unorm",
      usage: 0,
    })).toBe((4 * 4 * 3 + 2 * 2 * 3) * 4 * 4);
  });

  it("rolls typed device allocation failure back to the exact baseline", () => {
    const device = {
      createTexture: vi.fn(() => { throw new Error("device OOM"); }),
    } as unknown as GPUDevice;
    const budget = new GpuResourceBudget(1_000);

    expect(() => budget.createTexture(
      device,
      { key: "broken", kind: "offscreen" },
      { size: [10, 10], format: "rgba8unorm", usage: 0 },
    )).toThrow("device OOM");
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 0,
      allocationCount: 0,
      createdCount: 0,
      destroyedCount: 0,
    });
  });

  it("returns to baseline through repeated datasets, channels, tiers, and layer counts", () => {
    const created: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const make = () => {
      const value = resource();
      created.push(value);
      return value;
    };
    const device = {
      createBuffer: vi.fn(() => make() as unknown as GPUBuffer),
      createTexture: vi.fn(() => make() as unknown as GPUTexture),
    } as unknown as GPUDevice;
    const budget = new GpuResourceBudget(64 * 1024 * 1024);

    // One reusable compositing target is session-owned for every layer count.
    budget.createTexture(
      device,
      { key: "session:offscreen:0", kind: "offscreen" },
      { size: [256, 256], format: "rgba16float", usage: 0 },
    );
    const baseline = budget.snapshot().usedBytes;

    for (const layers of [1, 10, 50, 256]) {
      for (let cycle = 0; cycle < 8; cycle++) {
        const datasetId = `dataset-${layers}-${cycle}`;
        for (let channel = 0; channel < 4; channel++) {
          for (const tier of ["detail", "coarse"] as const) {
            budget.createTexture(
              device,
              {
                key: `${datasetId}:${channel}:${tier}:atlas`,
                kind: tier === "detail" ? "volume-atlas" : "slice-atlas",
                datasetId,
              },
              { size: [32, 32, 4], dimension: "3d", format: "r16uint", usage: 0 },
            );
            budget.createBuffer(
              device,
              {
                key: `${datasetId}:${channel}:${tier}:indirection`,
                kind: "buffer",
                datasetId,
              },
              { size: 4096, usage: 0 },
            );
          }
        }
        budget.createBuffer(
          device,
          { key: `${datasetId}:descriptor`, kind: "descriptor", datasetId },
          { size: Math.max(1, layers) * 128, usage: 0 },
        );

        budget.destroyDataset(datasetId);
        expect(budget.snapshot()).toMatchObject({
          usedBytes: baseline,
          allocationCount: 1,
          byDataset: {},
        });
      }
    }

    budget.destroyAll();
    const final = budget.snapshot();
    expect(final.usedBytes).toBe(0);
    expect(final.allocationCount).toBe(0);
    expect(final.createdCount).toBe(final.destroyedCount);
    expect(final.createdBytes).toBe(final.destroyedBytes);
    expect(created.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
  });
});
