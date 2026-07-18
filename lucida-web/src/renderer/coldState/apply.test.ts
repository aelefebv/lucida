import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
  UNIFORM: 0x40,
};

import type { WorkerCtx } from "../workerContext.ts";
import { createInitialState } from "../worker/state.ts";
import { makeColdEntry, makeColdMessage } from "../testFixtures.ts";
import { applyColdState } from "./apply.ts";
import { GpuResourceBudget } from "../gpuResourceBudget.ts";

interface MockBuffer {
  destroyed: boolean;
  destroy(): void;
  size: number;
  usage: number;
}

function makeDevice(): GPUDevice {
  return {
    createTexture: vi.fn((desc: GPUTextureDescriptor) => ({
      destroyed: false,
      destroy() { this.destroyed = true; },
      size: desc.size,
      format: desc.format,
    })),
    createBuffer: vi.fn((desc: GPUBufferDescriptor): MockBuffer => ({
      destroyed: false,
      destroy() { this.destroyed = true; },
      size: desc.size,
      usage: desc.usage,
    })),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
  } as unknown as GPUDevice;
}

function makeCtx(): WorkerCtx {
  const device = makeDevice();
  return {
    device,
    gpuResources: new GpuResourceBudget(512 * 1024 * 1024),
    context: {} as GPUCanvasContext,
    format: "bgra8unorm",
    state: createInitialState(),
    getSliceRenderer: () => ({} as never),
    getVolumeRenderer: () => ({} as never),
    getCompositor: () => ({} as never),
    getCursorRenderer: () => ({} as never),
    destroyRenderers: () => {},
    ensureOffscreenPool: () => [],
    getDummyTexture: () => ({} as GPUTexture),
    getDummy3DTexture: () => ({} as GPUTexture),
    getOrCreateLUT: () => ({} as GPUTexture),
    post: () => {},
    postWantedSet: () => {},
    lookupEntityDescriptor: () => null,
  };
}

describe("applyColdState", () => {
  it("creates volume routing, metadata, indirection, and a descriptor buffer", () => {
    const ctx = makeCtx();
    const cold = makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      }),
    ]);

    applyColdState(ctx, cold);

    expect(ctx.state.memberToDataset.get("image-a")).toBe("ds-1");
    expect(ctx.state.memberToPool.get("image-a")).toBe("ds-1:64x64x32:detail");
    expect(ctx.state.memberTierToPool.get("image-a|detail")).toBe("ds-1:64x64x32:detail");
    const atlas = ctx.state.volumeAtlases.get("ds-1:64x64x32:detail")!;
    expect(atlas.entityMetas.get("image-a")?.[0]).toMatchObject({
      level: 0,
      offset: 0,
      gridDims: [2, 4, 4],
    });
    expect(atlas.indirectionData).toHaveLength(32);
    expect(ctx.state.descriptorBuffersByDataset.get("ds-1")?.memberByIndex)
      .toEqual(["image-a"]);
  });

  it("creates independent routing and pools for every visible channel", () => {
    const ctx = makeCtx();
    const cold = makeColdMessage(
      [makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        levels: [{ level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] }],
      })],
      { multiChannel: true, visibleChannels: [0, 2] },
    );

    applyColdState(ctx, cold);

    expect(ctx.state.memberToDataset.get("image-a:ch0")).toBe("ds-1");
    expect(ctx.state.memberToDataset.get("image-a:ch2")).toBe("ds-1");
    expect(ctx.state.volumeAtlases.size).toBe(2);
    expect(ctx.state.memberToPool.get("image-a:ch2"))
      .toBe("ds-1:ch2:64x64x32:detail");
  });

  it("packs entries sharing a pool at sequential offsets", () => {
    const ctx = makeCtx();
    const level = {
      level: 0,
      chunkShape: [32, 64, 64] as [number, number, number],
      gridShape: [2, 4, 4] as [number, number, number],
      levelDims: [64, 256, 256] as [number, number, number],
    };
    applyColdState(ctx, makeColdMessage([
      makeColdEntry({ entityId: "a", imageId: "image-a", levels: [level] }),
      makeColdEntry({ entityId: "b", imageId: "image-b", levels: [level] }),
    ]));

    const atlas = ctx.state.volumeAtlases.get("ds-1:64x64x32:detail")!;
    expect(atlas.entityMetas.get("image-a")?.[0].offset).toBe(0);
    expect(atlas.entityMetas.get("image-b")?.[0].offset).toBe(32);
    expect(atlas.indirectionData).toHaveLength(64);
  });

  it("keeps detail and coarse sources in independent tier pools", () => {
    const ctx = makeCtx();
    applyColdState(ctx, makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        detailLevel: 0,
        coarseLevel: 2,
        wantedLodLevels: [0, 2],
        levels: [
          { level: 0, chunkShape: [32, 64, 64], gridShape: [2, 4, 4], levelDims: [64, 256, 256] },
          { level: 2, chunkShape: [8, 128, 128], gridShape: [8, 2, 2], levelDims: [64, 256, 256] },
        ],
      }),
    ]));

    expect(ctx.state.memberTierToPool.get("image-a|detail"))
      .toBe("ds-1:64x64x32:detail");
    expect(ctx.state.memberTierToPool.get("image-a|coarse"))
      .toBe("ds-1:128x128x8:coarse");
    expect(ctx.state.currentEntityMetasByDataset.get("ds-1")?.get("image-a")?.map((meta) => meta.level))
      .toEqual([0, 2]);
  });

  it("uses two-dimensional pool geometry in slice mode", () => {
    const ctx = makeCtx();
    applyColdState(ctx, makeColdMessage([
      makeColdEntry({
        entityId: "a",
        imageId: "image-a",
        levels: [{ level: 0, chunkShape: [8, 128, 128], gridShape: [4, 2, 2], levelDims: [32, 256, 256] }],
      }),
    ], { viewMode: "slice" }));

    const atlas = ctx.state.sliceAtlases.get("ds-1:128x128:detail")!;
    expect(atlas.entityMetas.get("image-a")?.[0].offset).toBe(0);
    expect(atlas.indirectionData).toHaveLength(4);
  });

  it("replaces stale routing and destroys the previous descriptor buffer", () => {
    const ctx = makeCtx();
    applyColdState(ctx, makeColdMessage([
      makeColdEntry({ entityId: "a", imageId: "image-a" }),
    ]));
    const previous = ctx.state.descriptorBuffersByDataset.get("ds-1")!;
    const previousBuffer = previous.buffer as unknown as MockBuffer;

    applyColdState(ctx, makeColdMessage([
      makeColdEntry({ entityId: "b", imageId: "image-b" }),
    ]));

    expect(previousBuffer.destroyed).toBe(true);
    expect(ctx.state.memberToPool.has("image-a")).toBe(false);
    expect(ctx.state.memberTierToPool.has("image-a|detail")).toBe(false);
    expect(ctx.state.memberToPool.has("image-b")).toBe(true);
    expect(ctx.state.descriptorBuffersByDataset.get("ds-1")).not.toBe(previous);
  });

  it("accepts an empty active set and still records an empty descriptor snapshot", () => {
    const ctx = makeCtx();
    expect(() => applyColdState(ctx, makeColdMessage([]))).not.toThrow();
    expect(ctx.state.volumeAtlases.size).toBe(0);
    expect(ctx.state.memberToDataset.size).toBe(0);
    expect(ctx.state.currentEntityMetasByDataset.get("ds-1")?.size).toBe(0);
    expect(ctx.state.descriptorBuffersByDataset.has("ds-1")).toBe(true);
  });
});
