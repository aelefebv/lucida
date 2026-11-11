/**
 * Narrow facet of `RenderClient` consumed by the upload phase. Render-side
 * methods (`volumeRenderMultiPass`, `minimap*`, etc.) are left out on purpose.
 */
import type {
  ColdStateMessage,
  ColdStateDisplayMessage,
  ColdStateSelectionMessage,
  ColdStateDeltaMessage,
  DatasetUnplannedMessage,
  FailedChunksMessage,
  ChunkResidencyMessage,
  ViewHotStateMessage,
  MissingChunk,
  PoolMode,
} from "../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { SpatialAxis } from "../../renderer/slicePlane.ts";

/** Worker `chunkResidency` callback. */
export type ChunkResidencyHandler = (msg: ChunkResidencyMessage) => void;

export type WantedSetHandler = (
  datasetId: string,
  mode: PoolMode,
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

  /** Replace one dataset's list of chunks the source failed for good. See {@link FailedChunksMessage}. */
  failedChunks(msg: FailedChunksMessage): void;

  /** Say no view plans a dataset any more. See {@link DatasetUnplannedMessage}. */
  datasetUnplanned(msg: DatasetUnplannedMessage): void;

  /**
   * Must be sent before subsequent render messages so the view's ray hits
   * are current when chunk-data eviction fires.
   */
  viewHotState(msg: ViewHotStateMessage): void;

  /**
   * Deliver one plane of each chunk, plane `plane` of `level` along
   * `sliceAxis`, in the frame of the plane cutting that axis. Each
   * `chunk.data` is transferred, so it must be a buffer cut for the worker,
   * never the cache's own.
   */
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
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    fullResDepth: number,
    levelDepth: number,
    plane: number,
    epochs: SceneEpochs,
    tier: ResidencyTier,
    sliceAxis?: SpatialAxis,
  ): void;

  /**
   * Deliver pre-sliced uint32 label planes to the r32uint label pool
   * (categorical overlay path). Distinct from {@link sliceChunkData}: routed
   * by the label image id; each `chunk.data` is a single 2D Z-plane already
   * extracted for the current view (so only ~64 KB crosses, not the ~8 MB
   * 3D chunk), and is transferred like {@link sliceChunkData}'s. `plane` is
   * the label level's Z plane they were cut at. `datasetId` is stamped on
   * the pool so dataset removal can free it — the pool is keyed by the label
   * image id, which removal never sees.
   */
  labelSliceChunkData(
    memberId: string,
    datasetId: string,
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
    chunkX: number,
    chunkY: number,
    plane: number,
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
    tier: ResidencyTier,
  ): void;

  /**
   * Deliver whole uint32 label chunks to the r32uint label volume pool
   * (categorical first-hit overlay path). Distinct from {@link volumeChunkData}:
   * routed by the label image id and drawn as a colored surface, not
   * accumulated as intensity. Unlike {@link labelSliceChunkData}, the full 3D
   * chunk crosses (no plane extraction) — the 3D surface needs the whole
   * volume.
   */
  labelVolumeChunkData(
    memberId: string,
    datasetId: string,
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

  removeLayerResources(datasetId: string): void;

  onChunkResidency: ChunkResidencyHandler | null;
  onWantedSetDelta: WantedSetHandler | null;
}
