/**
 * `UploadClient` — narrow facet of `RenderClient` consumed by the upload
 * phase. Render-side methods (`volumeRenderMultiPass`, `minimap*`, etc.)
 * are deliberately NOT part of this interface.
 */
import type {
  ChunkFeedbackReason,
  ColdStateMessage,
  ColdStateDisplayMessage,
  ColdStateSelectionMessage,
  ColdStateDeltaMessage,
  ViewHotStateMessage,
  MissingChunk,
  Chunk,
} from "../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { ResidencyTier } from "../fetch/types.ts";

/**
 * Worker `chunksEvicted` callback. `memberId` is the worker-side member
 * id: single-channel `imageId` or multi-channel `imageId:chN`.
 */
export type ChunksEvictedHandler = (
  memberId: string,
  evicted: string[],
  skipped: string[],
  reason?: ChunkFeedbackReason,
) => void;

export type WantedSetHandler = (
  datasetId: string,
  epochs: SceneEpochs,
  missing: MissingChunk[],
) => void;

export interface UploadClient {
  coldState(msg: ColdStateMessage): void;

  /**
   * Push a display-only update (contrast / gamma / colormap / opacity) for
   * a dataset whose geometry and residency are unchanged. The worker
   * re-applies it to the resident descriptor buffer without re-ingesting
   * cold state. See {@link ColdStateDisplayMessage}.
   */
  coldStateDisplay(msg: ColdStateDisplayMessage): void;

  /**
   * Push a selection-scrub update (T / Z move with an unchanged visible set,
   * geometry, LOD, matrices, and display state). The worker re-points the
   * dataset's most recent cold state at the new selection and re-ingests it,
   * without the sender rebuilding or re-transmitting the O(active-set)
   * descriptor array. See {@link ColdStateSelectionMessage}.
   */
  coldStateSelection(msg: ColdStateSelectionMessage): void;

  /**
   * Push a view-move update (pan / zoom / orbit) for a dataset whose active set
   * genuinely changed but whose selection, display, and layout did not. Carries
   * only the changed/added descriptors + removed ids + the new active-set order,
   * so the worker patches its retained cold state and re-ingests it without the
   * sender re-transmitting the O(active-set) descriptor array. See
   * {@link ColdStateDeltaMessage}.
   */
  coldStateDelta(msg: ColdStateDeltaMessage): void;

  /**
   * Must be sent before subsequent render messages so the worker's
   * `rayHitPerEntity` is current when chunk-data eviction fires.
   */
  viewHotState(msg: ViewHotStateMessage): void;

  sliceChunkData(
    memberId: string,
    chunks: Chunk[],
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
    tier?: ResidencyTier,
  ): void;

  /**
   * Deliver PRE-SLICED uint32 label planes to the r32uint label pool
   * (categorical overlay path). Distinct from {@link sliceChunkData}: routed
   * by the label image id; each `chunk.data` is a single 2D Z-plane already
   * extracted for the current view (so only ~64 KB crosses, not the ~8 MB
   * 3D chunk). `datasetId` is stamped on the pool so dataset removal can free
   * it — the pool is keyed by the label image id, which removal never sees.
   */
  labelSliceChunkData(
    memberId: string,
    datasetId: string,
    chunks: Chunk[],
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    chunkX: number,
    chunkY: number,
    epochs: SceneEpochs,
  ): void;

  volumeChunkData(
    memberId: string,
    chunks: Chunk[],
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
    tier?: ResidencyTier,
  ): void;

  /**
   * Deliver WHOLE uint32 label chunks to the r32uint label VOLUME pool
   * (categorical first-hit overlay path). Distinct from {@link volumeChunkData}:
   * routed by the label image id and drawn as a colored surface, not
   * accumulated as intensity. Unlike {@link labelSliceChunkData}, the full 3D
   * chunk crosses (no plane extraction) — the 3D surface needs the whole
   * volume.
   */
  labelVolumeChunkData(
    memberId: string,
    datasetId: string,
    chunks: Chunk[],
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

  removeLayerResources(datasetId: string): void;

  onChunksEvicted: ChunksEvictedHandler | null;
  onWantedSetDelta: WantedSetHandler | null;
}
