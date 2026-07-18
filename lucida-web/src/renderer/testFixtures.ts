/** Shared test builders for the renderer's sole chunk-backed cold-state path. */

import { vi } from "vitest";

import type { SceneEpochs } from "../pipeline/epochs.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDisplayState,
  ColdStateMessage,
} from "./workerProtocol.ts";

/** Minimal mock device shared by renderer suites that exercise allocation. */
export function makeMockGpuDevice(): GPUDevice {
  const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
    const buffer = {
      size: descriptor.size,
      usage: descriptor.usage,
      destroyed: false,
      destroy: vi.fn(() => {
        buffer.destroyed = true;
      }),
    };
    return buffer;
  });
  const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => {
    const texture = {
      size: descriptor.size,
      format: descriptor.format,
      destroyed: false,
      destroy: vi.fn(() => {
        texture.destroyed = true;
      }),
      createView: vi.fn(() => ({})),
    };
    return texture;
  });

  return {
    createBuffer,
    createTexture,
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
    } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

export function identityMatrix(): Float32Array {
  const matrix = new Float32Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  return matrix;
}

export function defaultColdDisplay(): ColdStateDisplayState {
  return {
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    colormapName: "gray",
    channelMask: 1,
  };
}

export function makeColdEntry(
  overrides: Partial<ColdStateActiveEntry> & Pick<ColdStateActiveEntry, "entityId" | "imageId">,
): ColdStateActiveEntry {
  const targetLod = overrides.targetLod ?? 0;
  const detailLevel = overrides.detailLevel ?? targetLod;
  const coarseLevel = overrides.coarseLevel ?? null;
  return {
    targetLod,
    detailOwnedLodRange: overrides.detailOwnedLodRange ?? [detailLevel, coarseLevel ?? detailLevel],
    detailLevel,
    coarseLevel,
    wantedLodLevels: overrides.wantedLodLevels ?? (
      coarseLevel !== null && coarseLevel !== detailLevel
        ? [detailLevel, coarseLevel]
        : [detailLevel]
    ),
    levels: overrides.levels ?? [
      {
        level: 0,
        chunkShape: [1, 64, 64],
        gridShape: [1, 4, 4],
        levelDims: [1, 256, 256],
      },
    ],
    modelMatrix: overrides.modelMatrix ?? identityMatrix(),
    invModelMatrix: overrides.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: overrides.displayStateByChannel ?? { 0: defaultColdDisplay() },
    ...overrides,
    kind: "tile",
  };
}

const DEFAULT_EPOCHS: SceneEpochs = {
  content: 1,
  layout: 1,
  view: 1,
  selection: 1,
  request: 0,
};

export function makeColdMessage(
  activeSet: ColdStateActiveEntry[],
  overrides: Partial<Omit<ColdStateMessage, "type" | "activeSet">> = {},
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: DEFAULT_EPOCHS,
    datasetId: "ds-1",
    currentT: 0,
    currentZ: 0,
    multiChannel: false,
    visibleChannels: [0],
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    viewMode: "volume",
    ...overrides,
    activeSet,
  };
}
