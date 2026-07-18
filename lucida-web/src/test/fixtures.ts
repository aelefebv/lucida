import type { SceneEpochs } from "../pipeline/epochs.ts";
import {
  createChunkContract,
  type ChunkContract,
} from "../chunkContract.ts";

/** Canonical epochs for tests that do not care which stage advanced them. */
export function makeSceneEpochs(
  overrides: Partial<SceneEpochs> = {},
): SceneEpochs {
  return {
    content: 1,
    layout: 1,
    view: 1,
    selection: 1,
    request: 0,
    ...overrides,
  };
}

/** Canonical typed chunk contract for fixtures that do not test admission. */
export function makeChunkContract(
  overrides: Partial<ChunkContract> = {},
): ChunkContract {
  const base = createChunkContract({
    datasetId: overrides.datasetId ?? "ds-1",
    imageId: overrides.imageId ?? "image-1",
    channel: overrides.channel ?? 0,
    role: overrides.role ?? "intensity",
    sourceDtype: overrides.sourceDtype ?? "uint16",
    shape: overrides.shape ?? [1, 2, 2],
  });
  return { ...base, ...overrides };
}
