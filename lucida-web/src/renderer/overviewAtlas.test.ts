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
  overviewBinding,
  writeOverviewChunks,
  type OverviewSpec,
} from "./overviewAtlas.ts";
import { createInitialState } from "./worker/state.ts";
import { measureGpuMemory } from "./worker/gpuBudget.ts";

const MIB = 1024 * 1024;

/** `holdScopes`: every allocation's out-of-memory check waits for the test to settle it, in `scopes`. */
function makeCtx({ holdScopes = false } = {}) {
  const textures: Array<{ size: number[]; destroy: ReturnType<typeof vi.fn> }> = [];
  const scopes: Array<(error: GPUError | null) => void> = [];
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
    popErrorScope: () => holdScopes ? new Promise<GPUError | null>((settle) => scopes.push(settle)) : Promise.resolve(null),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
  };
  const posts: WorkerToMainMessage[] = [];
  const ctx = {
    device,
    state: createInitialState(256 * MIB),
    post: (msg: WorkerToMainMessage) => posts.push(msg),
  } as unknown as WorkerCtx;
  return { ctx, device, textures, copies, scopes, posts };
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

  it("grows by copying the slots it holds into a larger texture's front, so every overview keeps its slots", () => {
    const { ctx, textures, copies } = makeCtx();
    const atlases = createOverviewAtlases();
    const first = Array.from({ length: 4 }, (_, i) => openOverview(ctx, atlases, `m${i}:ch0`, tile(`m${i}`))!);
    const slots = first.map((overview) => overview.slots[0]);
    const before = textures.at(-1)!;

    const fifth = openOverview(ctx, atlases, "m4:ch0", tile("m4"))!;

    // Along a row, down the layer, then a layer more.
    expect(textures.map(({ size }) => size)).toEqual([[64, 64, 1], [128, 64, 1], [128, 128, 1], [128, 128, 2]]);
    expect(before.destroy).toHaveBeenCalled();
    expect(copies.at(-1)).toEqual({ from: before, to: fifth.atlas.texture, size: [128, 128, 1] });
    expect(overviewBinding(fifth.atlas).slotsZ).toBe(2);
    expect(first.map((overview) => overview.slots[0])).toEqual(slots);
    expect(slots).not.toContain(fifth.slots[0]);
  });

  it("starts at the slots its first overview needs, so a volume's one-cell overview takes its own size", () => {
    const { ctx, textures } = makeCtx();
    const atlases = createOverviewAtlases();

    openOverview(ctx, atlases, "v:ch0", tile("v", { levelDims: [64, 64, 64], chunkDims: [64, 64, 64] }));

    expect(textures.map(({ size }) => size)).toEqual([[64, 64, 64]]);
    expect(measureGpuMemory(ctx.state).minimapBytes).toBe(64 ** 3 * 2 + 4);
  });

  it("puts levels under a chunk in an atlas per power of two, so mixed sizes share a few", () => {
    const { ctx } = makeCtx();
    const atlases = createOverviewAtlases();
    const sized = (id: string, x: number, y: number) =>
      openOverview(ctx, atlases, `${id}:ch0`, tile(id, { levelDims: [x, y, 1] }))!.atlas;

    const atlasOf = [sized("a", 64, 64), sized("b", 40, 50), sized("c", 33, 60), sized("d", 64, 20), sized("e", 100, 300)];

    expect(atlasOf.map(({ slotDims }) => slotDims)).toEqual([[64, 64, 1], [64, 64, 1], [64, 64, 1], [64, 32, 1], [128, 128, 1]]);
    expect(new Set(atlasOf).size).toBe(3);
  });

  it("goes with its overviews when a texture its texels passed through runs out of memory, after a later growth", async () => {
    const { ctx, scopes, posts } = makeCtx({ holdScopes: true });
    const atlases = createOverviewAtlases();
    for (const id of ["a", "b", "c"]) openOverview(ctx, atlases, `${id}:ch0`, tile(id));
    expect(scopes).toHaveLength(3);

    // The second texture failed; the third was copied from it.
    scopes[1]({ message: "out of memory" } as GPUError);
    await Promise.resolve();
    await Promise.resolve();

    expect(atlases.byKey.size).toBe(0);
    expect(posts).toContainEqual({ type: "minimapOverviewsLost", memberIds: ["a:ch0", "b:ch0", "c:ch0"] });
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
    expect(measureGpuMemory(ctx.state).minimapBytes).toBe(64 * 64 * 2 + 4);
  });
});
