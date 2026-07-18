import { describe, expect, it, vi } from "vitest";
import { GpuResourceBudget } from "./gpuResourceBudget.ts";

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
};

import {
  __descriptorScratchCapacityForTest,
  __resetDescriptorScratchForTest,
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_LOD_INFO_SIZE,
  DESCRIPTOR_LODS_OFFSET,
  DESCRIPTOR_MAX_LODS,
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
  displayStateForChannel,
  serializeEntityDescriptor,
} from "./descriptorBuffer.ts";
import {
  LOD_OFFSET_CHUNK_DIMS,
  LOD_OFFSET_GRID_DIMS,
  LOD_OFFSET_INDIRECTION_OFFSET,
  LOD_OFFSET_LEVEL,
  LOD_OFFSET_LEVEL_DIMS,
  OFFSET_CHANNEL_MASK,
  OFFSET_COARSE_SOURCE,
  OFFSET_COLORMAP_LUT_INDEX,
  OFFSET_COLORMAP_MODE,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_DETAIL_SOURCE,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LOD_COUNT,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_VALID,
} from "./descriptor/layout.ts";
import { serializeTransientDescriptor } from "./descriptor/transient.ts";
import { defaultColdDisplay, identityMatrix, makeColdEntry, makeColdMessage } from "./testFixtures.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";

function scaledMatrix(scale: number): Float32Array {
  const matrix = identityMatrix();
  matrix[0] = scale;
  matrix[5] = scale + 1;
  matrix[10] = scale + 2;
  return matrix;
}

function metas(): LodIndirectionMeta[] {
  return [
    {
      level: 0,
      gridDims: [2, 3, 4],
      chunkDims: [8, 16, 32],
      levelDims: [16, 48, 128],
      offset: 7,
    },
    {
      level: 2,
      gridDims: [1, 2, 3],
      chunkDims: [4, 8, 16],
      levelDims: [4, 16, 48],
      offset: 31,
    },
  ];
}

function serialize(overrides: Parameters<typeof makeColdEntry>[0] = {
  entityId: "entity-a",
  imageId: "image-a",
}) {
  const buffer = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
  const entry = makeColdEntry({
    ...overrides,
    entityId: overrides.entityId ?? "entity-a",
    imageId: overrides.imageId ?? "image-a",
    detailLevel: overrides.detailLevel ?? 0,
    coarseLevel: "coarseLevel" in overrides ? overrides.coarseLevel ?? null : 2,
    wantedLodLevels: overrides.wantedLodLevels ?? [0, 2],
    modelMatrix: overrides.modelMatrix ?? scaledMatrix(2),
    invModelMatrix: overrides.invModelMatrix ?? scaledMatrix(0.25),
  });
  const display = {
    ...defaultColdDisplay(),
    contrastMin: 10,
    contrastMax: 100,
    gamma: 1.5,
    opacity: 0.75,
    colormapName: "viridis",
    channelMask: 4,
    colormapMode: 1,
    labelOpacity: 0.4,
  };
  serializeEntityDescriptor(buffer, 0, entry, metas(), display, new Map([["viridis", 3]]));
  return { buffer, entry, display };
}

describe("serializeEntityDescriptor", () => {
  it("writes matrices and display state at the canonical offsets", () => {
    const { buffer, entry, display } = serialize();
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);

    expect([...f32.slice(OFFSET_MODEL_MATRIX / 4, OFFSET_MODEL_MATRIX / 4 + 16)])
      .toEqual([...entry.modelMatrix]);
    expect([...f32.slice(OFFSET_INV_MODEL_MATRIX / 4, OFFSET_INV_MODEL_MATRIX / 4 + 16)])
      .toEqual([...entry.invModelMatrix]);
    expect(u32[OFFSET_CHANNEL_MASK / 4]).toBe(display.channelMask);
    expect(f32[OFFSET_CONTRAST_MIN / 4]).toBe(display.contrastMin);
    expect(f32[OFFSET_CONTRAST_MAX / 4]).toBe(display.contrastMax);
    expect(f32[OFFSET_GAMMA / 4]).toBe(display.gamma);
    expect(f32[OFFSET_OPACITY / 4]).toBe(display.opacity);
    expect(u32[OFFSET_COLORMAP_LUT_INDEX / 4]).toBe(3);
    expect(u32[OFFSET_COLORMAP_MODE / 4]).toBe(1);
    expect(f32[OFFSET_LABEL_OPACITY / 4]).toBeCloseTo(0.4);
  });

  it("writes every LOD using shader-facing XYZ order and absolute offsets", () => {
    const { buffer } = serialize();
    const u32 = new Uint32Array(buffer);
    expect(u32[OFFSET_LOD_COUNT / 4]).toBe(2);

    const first = DESCRIPTOR_LODS_OFFSET / 4;
    expect(u32[first + LOD_OFFSET_LEVEL / 4]).toBe(0);
    expect(u32[first + LOD_OFFSET_INDIRECTION_OFFSET / 4]).toBe(7);
    expect([...u32.slice(first + LOD_OFFSET_GRID_DIMS / 4, first + LOD_OFFSET_GRID_DIMS / 4 + 3)])
      .toEqual([4, 3, 2]);
    expect([...u32.slice(first + LOD_OFFSET_CHUNK_DIMS / 4, first + LOD_OFFSET_CHUNK_DIMS / 4 + 3)])
      .toEqual([32, 16, 8]);
    expect([...u32.slice(first + LOD_OFFSET_LEVEL_DIMS / 4, first + LOD_OFFSET_LEVEL_DIMS / 4 + 3)])
      .toEqual([128, 48, 16]);

    const second = first + DESCRIPTOR_LOD_INFO_SIZE / 4;
    expect(u32[second + LOD_OFFSET_LEVEL / 4]).toBe(2);
    expect(u32[second + LOD_OFFSET_INDIRECTION_OFFSET / 4]).toBe(31);
  });

  it("zeroes every unused LOD slot", () => {
    const { buffer } = serialize();
    const u32 = new Uint32Array(buffer);
    const stride = DESCRIPTOR_LOD_INFO_SIZE / 4;
    const start = DESCRIPTOR_LODS_OFFSET / 4 + 2 * stride;
    expect([...u32.slice(start, start + (DESCRIPTOR_MAX_LODS - 2) * stride)])
      .toEqual(new Array((DESCRIPTOR_MAX_LODS - 2) * stride).fill(0));
  });

  it("writes explicit detail and coarse tier sources", () => {
    const { buffer } = serialize();
    const u32 = new Uint32Array(buffer);
    const detail = OFFSET_DETAIL_SOURCE / 4;
    const coarse = OFFSET_COARSE_SOURCE / 4;

    expect(u32[detail + SOURCE_OFFSET_VALID / 4]).toBe(1);
    expect(u32[detail + SOURCE_OFFSET_LEVEL / 4]).toBe(0);
    expect(u32[detail + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(7);
    expect([...u32.slice(detail + SOURCE_OFFSET_GRID_DIMS / 4, detail + SOURCE_OFFSET_GRID_DIMS / 4 + 3)])
      .toEqual([4, 3, 2]);
    expect([...u32.slice(detail + SOURCE_OFFSET_CHUNK_DIMS / 4, detail + SOURCE_OFFSET_CHUNK_DIMS / 4 + 3)])
      .toEqual([32, 16, 8]);
    expect([...u32.slice(detail + SOURCE_OFFSET_LEVEL_DIMS / 4, detail + SOURCE_OFFSET_LEVEL_DIMS / 4 + 3)])
      .toEqual([128, 48, 16]);

    expect(u32[coarse + SOURCE_OFFSET_VALID / 4]).toBe(1);
    expect(u32[coarse + SOURCE_OFFSET_LEVEL / 4]).toBe(2);
    expect(u32[coarse + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(31);
  });

  it("uses the last same-level meta for the coarse source", () => {
    const buffer = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const entry = makeColdEntry({
      entityId: "entity-a",
      imageId: "image-a",
      detailLevel: 1,
      coarseLevel: 1,
      wantedLodLevels: [1],
    });
    const duplicate: LodIndirectionMeta[] = [
      { level: 1, gridDims: [1, 1, 1], chunkDims: [1, 1, 1], levelDims: [1, 1, 1], offset: 10 },
      { level: 1, gridDims: [2, 2, 2], chunkDims: [2, 2, 2], levelDims: [4, 4, 4], offset: 20 },
    ];
    serializeEntityDescriptor(buffer, 0, entry, duplicate, defaultColdDisplay(), new Map());
    const u32 = new Uint32Array(buffer);
    expect(u32[OFFSET_DETAIL_SOURCE / 4 + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(10);
    expect(u32[OFFSET_COARSE_SOURCE / 4 + SOURCE_OFFSET_INDIRECTION_OFFSET / 4]).toBe(20);
  });

  it("leaves an unavailable coarse source invalid", () => {
    const { buffer } = serialize({
      entityId: "entity-a",
      imageId: "image-a",
      coarseLevel: null,
      wantedLodLevels: [0],
    });
    expect(new Uint32Array(buffer)[OFFSET_COARSE_SOURCE / 4 + SOURCE_OFFSET_VALID / 4]).toBe(0);
  });
});

describe("displayStateForChannel", () => {
  it("returns the exact channel state when present", () => {
    const display = { ...defaultColdDisplay(), contrastMin: 20 };
    const entry = makeColdEntry({
      entityId: "entity-a",
      imageId: "image-a",
      displayStateByChannel: { 2: display },
    });
    expect(displayStateForChannel(entry, 2)).toBe(display);
  });

  it("returns a safe neutral fallback for a missing channel", () => {
    const entry = makeColdEntry({ entityId: "entity-a", imageId: "image-a", displayStateByChannel: {} });
    expect(displayStateForChannel(entry, 9)).toMatchObject({
      contrastMin: 0,
      contrastMax: 65535,
      gamma: 1,
      opacity: 1,
      colormapName: "gray",
      channelMask: 0,
    });
  });
});

describe("buildDescriptorBuffer", () => {
  it("builds dense canonical indices, channel display, and a correctly sized GPU buffer", () => {
    const buffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const writeBuffer = vi.fn();
    const createBuffer = vi.fn(() => buffer);
    const device = { createBuffer, queue: { writeBuffer } } as unknown as GPUDevice;
    const first = makeColdEntry({
      entityId: "a",
      imageId: "image-a",
      displayStateByChannel: {
        0: { ...defaultColdDisplay(), colormapName: "gray", channelMask: 1 },
        2: { ...defaultColdDisplay(), colormapName: "viridis", channelMask: 4 },
      },
    });
    const second = makeColdEntry({
      entityId: "b",
      imageId: "image-b",
      displayStateByChannel: {
        0: { ...defaultColdDisplay(), colormapName: "magma", channelMask: 1 },
        2: { ...defaultColdDisplay(), colormapName: "magma", channelMask: 4 },
      },
    });
    const cold = makeColdMessage([first, second], {
      multiChannel: true,
      visibleChannels: [0, 2],
    });
    const result = buildDescriptorBuffer(device, cold, new Map(), new GpuResourceBudget(1_000_000));

    expect([...result.indexByMember]).toEqual([
      ["image-a:ch0", 0],
      ["image-a:ch2", 1],
      ["image-b:ch0", 2],
      ["image-b:ch2", 3],
    ]);
    expect(result.memberByIndex).toEqual([
      "image-a:ch0",
      "image-a:ch2",
      "image-b:ch0",
      "image-b:ch2",
    ]);
    expect([...result.colormapLutIndices]).toEqual([
      ["gray", 0],
      ["viridis", 1],
      ["magma", 2],
    ]);
    expect(result.colormapNameByMember.get("image-a:ch2")).toBe("viridis");
    expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({
      size: 4 * DESCRIPTOR_ENTRY_SIZE,
    }));
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect((writeBuffer.mock.calls[0][2] as ArrayBuffer).byteLength)
      .toBeGreaterThanOrEqual(4 * DESCRIPTOR_ENTRY_SIZE);
    expect(writeBuffer.mock.calls[0].slice(3)).toEqual([0, 4 * DESCRIPTOR_ENTRY_SIZE]);

    destroyDescriptorBuffer(result);
    expect(buffer.destroy).toHaveBeenCalledTimes(1);
    expect(result.indexByMember.size).toBe(0);
    expect(result.memberByIndex).toEqual([]);
  });

  it("allocates one descriptor-sized buffer for an empty active set", () => {
    const createBuffer = vi.fn(() => ({ destroy: vi.fn() }));
    const device = {
      createBuffer,
      queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const result = buildDescriptorBuffer(
      device,
      makeColdMessage([]),
      new Map(),
      new GpuResourceBudget(1_000_000),
    );
    expect(result.entityCount).toBe(0);
    expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: DESCRIPTOR_ENTRY_SIZE }));
  });

  it("reuses a grow-only scratch allocation and uploads only the live prefix", () => {
    __resetDescriptorScratchForTest();
    const writes: unknown[][] = [];
    const device = {
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      queue: { writeBuffer: vi.fn((...args: unknown[]) => writes.push(args)) },
    } as unknown as GPUDevice;
    const entries = Array.from({ length: 4 }, (_, i) => makeColdEntry({
      entityId: `entity-${i}`,
      imageId: `image-${i}`,
    }));

    buildDescriptorBuffer(
      device,
      makeColdMessage(entries),
      new Map(),
      new GpuResourceBudget(1_000_000),
    );
    const wideScratch = writes[0][2] as ArrayBuffer;
    expect(__descriptorScratchCapacityForTest()).toBe(4 * DESCRIPTOR_ENTRY_SIZE);

    buildDescriptorBuffer(
      device,
      makeColdMessage(entries.slice(0, 1)),
      new Map(),
      new GpuResourceBudget(1_000_000),
    );
    expect(writes[1][2]).toBe(wideScratch);
    expect(writes[1].slice(3)).toEqual([0, DESCRIPTOR_ENTRY_SIZE]);
    expect(__descriptorScratchCapacityForTest()).toBe(4 * DESCRIPTOR_ENTRY_SIZE);
  });
});

describe("transient descriptor parity", () => {
  it("matches canonical matrix, display, and first-LOD bytes for equivalent inputs", () => {
    const canonical = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const transient = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    const model = scaledMatrix(2);
    const inverse = scaledMatrix(0.25);
    const entry = makeColdEntry({
      entityId: "entity-a",
      imageId: "image-a",
      modelMatrix: model,
      invModelMatrix: inverse,
      detailLevel: 0,
      coarseLevel: null,
    });
    const meta: LodIndirectionMeta = {
      level: 0,
      gridDims: [1, 1, 1],
      chunkDims: [8, 16, 32],
      levelDims: [8, 16, 32],
      offset: 0,
    };
    const display = { ...defaultColdDisplay(), contrastMin: 1, contrastMax: 9, gamma: 1.2, opacity: 0.6 };
    serializeEntityDescriptor(canonical, 0, entry, [meta], display, new Map());
    serializeTransientDescriptor(transient, {
      modelMatrix: model,
      invModelMatrix: inverse,
      volumeDims: [32, 16, 8],
      contrastMin: 1,
      contrastMax: 9,
      gamma: 1.2,
      opacity: 0.6,
    });

    const canonicalBytes = new Uint8Array(canonical);
    const transientBytes = new Uint8Array(transient);
    const ranges = [
      [OFFSET_MODEL_MATRIX, OFFSET_INV_MODEL_MATRIX + 64],
      [OFFSET_CONTRAST_MIN, OFFSET_LOD_COUNT + 4],
      [DESCRIPTOR_LODS_OFFSET, DESCRIPTOR_LODS_OFFSET + DESCRIPTOR_LOD_INFO_SIZE],
    ] as const;
    for (const [start, end] of ranges) {
      expect([...canonicalBytes.slice(start, end)]).toEqual([...transientBytes.slice(start, end)]);
    }
  });
});
