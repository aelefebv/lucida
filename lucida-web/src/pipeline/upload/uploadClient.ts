/**
 * `UploadClient` — narrow facet of `RenderClient` consumed by the upload
 * phase. Render-side methods (`volumeRenderMultiPass`, `minimap*`, etc.)
 * are deliberately NOT part of this interface.
 */
import type {
  ColdStateMessage,
  ViewHotStateMessage,
  MissingChunk,
  MissingProxy,
} from "../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../epochs.ts";

/**
 * Worker `chunksEvicted` callback. `memberId` is the worker-side member
 * id: single-channel `imageId` or multi-channel `imageId:chN`.
 */
export type ChunksEvictedHandler = (
  memberId: string,
  evicted: string[],
  skipped: string[],
) => void;

export type WantedSetHandler = (
  epochs: SceneEpochs,
  missing: Array<MissingChunk | MissingProxy>,
) => void;

export interface UploadClient {
  coldState(msg: ColdStateMessage): void;

  /**
   * Must be sent before subsequent render messages so the worker's
   * `rayHitPerEntity` is current when chunk-data eviction fires.
   */
  viewHotState(msg: ViewHotStateMessage): void;

  sliceChunkData(
    memberId: string,
    chunks: {
      data: ArrayBuffer;
      dataType: string;
      x: number;
      y: number;
      z: number;
      key: string;
    }[],
    level: number,
    z: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    fullResDepth: number,
    levelDepth: number,
    fullResZ: number,
    epochs: SceneEpochs,
  ): void;

  volumeChunkData(
    memberId: string,
    chunks: {
      data: ArrayBuffer;
      dataType: string;
      x: number;
      y: number;
      z: number;
      key: string;
    }[],
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    epochs: SceneEpochs,
  ): void;

  proxyAssetData(
    datasetId: string,
    entityId: string,
    imageId: string,
    kind: "WellProxy3D" | "FieldProxy3D",
    t: number,
    c: number,
    dims: [number, number, number],
    data: ArrayBuffer,
    epochs: SceneEpochs,
  ): void;

  removeLayerResources(datasetId: string): void;

  onChunksEvicted: ChunksEvictedHandler | null;
  onWantedSetDelta: WantedSetHandler | null;
}
