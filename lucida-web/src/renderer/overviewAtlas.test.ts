import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 };

import type { WorkerCtx } from "./workerContext.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";
import {
  createOverviewAtlases,
  dropDatasetOverviews,
  dropOverview,
  openOverview,
  writeOverviewChunks,
  type OverviewSpec,
} from "./overviewAtlas.ts";
import { createInitialState } from "./worker/state.ts";
import { measureGpuMemory } from "./worker/gpuBudget.ts";

const MIB = 1024 * 1024;

function makeCtx() {
  const textures: Array<{ size: number[]; destroy: ReturnType<typeof vi.fn> }> = [];
  const copies: Array<{ from: unknown; to: unknown; size: number[] }> = [];
  const device = {
    // Four slots of 64x64 a layer under the overviews' share of 256 MiB.
    limits: { maxTextureDimension3D: 128, maxTextureDimension2D: 8192, maxBufferSize: 4096 * MIB, maxStorageBufferBindingSize: 2048 * MIB },
    createTexture: vi.fn((desc: GPUTextureDescriptor) => {
      const texture = { size: desc.size as number[], createView: () => ({}), destroy: vi.fn() };
      textures.push(texture);
      return texture;
    }),
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: vi.fn() }),
    createCommandEncoder: () => ({
      copyTextureToTexture: (src: GPUTexelCopyTextureInfo, dst: GPUTexelCopyTextureInfo, size: number[]) =>
        copies.push({ from: src.texture, to: dst.texture, size }),
      finish: () => ({}),
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: () => Promise.resolve(null),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
  };
  const ctx = {
    device,
    state: createInitialState(256 * MIB),
    post: (_msg: WorkerToMainMessage) => {},
  } as unknown as WorkerCtx;
  return { ctx, device, textures, copies };
}

/** A member's overview: a 64x64 level in one chunk of 128x128, as a small collection tile's coarsest level is. */
function tile(imageId: string, over: Partial<OverviewSpec> = {}): OverviewSpec {
  return {
    datasetId: "ds", imageId, level: 2, t: 0, c: 0,
    levelDims: [64, 64, 1], chunkDims: [128, 128, 1], format: "u16",
    ...over,
  };
}

describe("an overview atlas", () => {
  it("holds a dataset's overviews in one texture and buffer, each in cells and slots of its own", () => {
    const { ctx, textures } = makeCtx();
    const atlases = createOverviewAtlases();

    const opened = ["a", "b", "c"].map((id) => openOverview(ctx, atlases, `${id}:ch0`, tile(id))!);

    expect(new Set(opened.map((overview) => overview.atlas)).size).toBe(1);
    expect(opened.map((overview) => overview.offset)).toEqual([0, 1, 2]);
    expect(new Set(opened.map((overview) => overview.slots[0])).size).toBe(3);
    // A slot is the level, not the chunk it lies in: 64x64, four of them a layer.
    expect(opened[0].atlas.slotDims).toEqual([64, 64, 1]);
    expect(textures.at(-1)!.size).toEqual([128, 128, 1]);
    expect(measureGpuMemory(ctx.state).minimapBytes).toBe(4 * 64 * 64 * 2 + 3 * 4);
  });

  it("writes a chunk into its overview's slot and points the overview's cell at it", () => {
    const { ctx, device } = makeCtx();
    const atlases = createOverviewAtlases();
    openOverview(ctx, atlases, "a:ch0", tile("a"));
    const b = openOverview(ctx, atlases, "b:ch0", tile("b"))!;

    writeOverviewChunks(ctx, b, [{ key: "2/0/0/0/0/0", x: 0, y: 0, z: 0, dataType: "uint16", data: new Uint16Array(128 * 128).buffer }]);

    const slot = b.slots[0];
    const [destination, , layout, size] = device.queue.writeTexture.mock.calls.at(-1)!;
    expect(destination.origin).toEqual([(slot % 2) * 64, (Math.floor(slot / 2) % 2) * 64, Math.floor(slot / 4)]);
    expect(layout.bytesPerRow).toBe(128 * 2);
    expect(size).toEqual([64, 64, 1]);
    expect(b.atlas.indirection[b.offset]).toBe(slot);
  });

  it("grows by copying into a deeper texture, so every overview keeps its slots", () => {
    const { ctx, textures, copies } = makeCtx();
    const atlases = createOverviewAtlases();
    const first = Array.from({ length: 4 }, (_, i) => openOverview(ctx, atlases, `m${i}:ch0`, tile(`m${i}`))!);
    const slots = first.map((overview) => overview.slots[0]);
    const before = textures.at(-1)!;

    const fifth = openOverview(ctx, atlases, "m4:ch0", tile("m4"))!;

    expect(before.destroy).toHaveBeenCalled();
    expect(copies).toEqual([{ from: before, to: fifth.atlas.texture, size: [128, 128, 1] }]);
    expect(fifth.atlas.slotsZ).toBe(2);
    expect(first.map((overview) => overview.slots[0])).toEqual(slots);
    expect(slots).not.toContain(fifth.slots[0]);
  });

  it("gives a dropped overview's slots and cells to the next one, and its texture back once it holds none", () => {
    const { ctx, textures } = makeCtx();
    const atlases = createOverviewAtlases();
    const a = openOverview(ctx, atlases, "a:ch0", tile("a"))!;
    openOverview(ctx, atlases, "b:ch0", tile("b"));
    const made = textures.length;

    dropOverview(atlases, "a:ch0");
    const again = openOverview(ctx, atlases, "a:ch0", tile("a", { t: 1 }))!;
    expect([again.offset, again.slots[0]]).toEqual([a.offset, a.slots[0]]);
    expect(textures.length).toBe(made);

    dropOverview(atlases, "a:ch0");
    dropOverview(atlases, "b:ch0");
    expect(textures.at(-1)!.destroy).toHaveBeenCalled();
    expect(atlases.byKey.size).toBe(0);
    expect(measureGpuMemory(ctx.state).minimapBytes).toBe(0);
  });

  it("frees a removed dataset's atlas whole and keeps another dataset's", () => {
    const { ctx } = makeCtx();
    const atlases = createOverviewAtlases();
    openOverview(ctx, atlases, "a:ch0", tile("a"));
    openOverview(ctx, atlases, "a:ch1", tile("a", { c: 1 }));
    const other = openOverview(ctx, atlases, "x:ch0", tile("x", { datasetId: "other" }))!;

    dropDatasetOverviews(atlases, "ds");

    expect([...atlases.overviews.keys()]).toEqual(["x:ch0"]);
    expect([...atlases.byKey.values()]).toEqual([other.atlas]);
    expect(measureGpuMemory(ctx.state).minimapBytes).toBe(4 * 64 * 64 * 2 + 4);
  });
});
