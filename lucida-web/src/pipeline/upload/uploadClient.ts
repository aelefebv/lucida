/**
 * `UploadClient` — narrow facet of {@link RenderClient} consumed by the
 * upload phase (CPU → GPU hand-off).
 *
 * The upload path only needs cold/hot state emission, chunk + proxy
 * dispatch, layer-resource removal, and the two worker → main feedback
 * callback fields. The render-side methods on `RenderClient`
 * (`volumeRenderMultiPass`, `sliceRenderMultiPass`, `minimap*`,
 * `updateCursorData`, `destroy`, etc.) are deliberately NOT part of
 * this interface — those stay on `RenderClient` and on the
 * `TickContext.client` typing the render-side code consumes.
 *
 * Today `RenderClient` exposes the feedback handlers
 * (`onChunksEvicted`, `onWantedSetDelta`) as assignable fields, set
 * externally from `RenderLoop.start`. This interface keeps the same
 * shape for backward compatibility — converting to a typed
 * `subscribe(handler): () => void` pattern is captured as a follow-up
 * (out of scope for this slice). See PRD #607 Slice 11 issue #620 for
 * the rationale.
 *
 * See `wiki/outputs/dechaos-upload-2026-05-15/02-boundary-scan.md`
 * Seam O (`RenderClient` knows too many message shapes).
 */
import type {
  ColdStateMessage,
  ViewHotStateMessage,
  MissingChunk,
  MissingProxy,
} from "../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../epochs.ts";

/**
 * Callback type for the worker's `chunksEvicted` report. The first
 * argument is the worker-side member id (single-channel `imageId` or
 * multi-channel `imageId:chN`) — the same identifier the orchestrator
 * uses to key per-member delivery tracking. Previously named
 * `datasetId` on both the wire protocol and this typedef; renamed per
 * dechaos Pass 5 Contract Issue 3.
 */
export type ChunksEvictedHandler = (
  memberId: string,
  evicted: string[],
  skipped: string[],
) => void;

/**
 * Callback type for the worker's `wantedSetDelta` report. The `missing`
 * array is a discriminated union over chunks and proxies; consumers
 * match on `kind === "chunk" | "proxy"`.
 */
export type WantedSetHandler = (
  epochs: SceneEpochs,
  missing: Array<MissingChunk | MissingProxy>,
) => void;

/**
 * Narrow facet of `RenderClient` that the upload phase consumes.
 *
 * Surface: cold/hot state emission, chunk + proxy dispatch, layer
 * resource removal, and worker → main feedback callbacks. Render-side
 * methods stay on the full `RenderClient` and are not part of this
 * interface.
 */
export interface UploadClient {
  coldState(msg: ColdStateMessage): void;

  /**
   * Posts a viewEpoch hot-state message. Must be sent before subsequent
   * render messages so the worker's `rayHitPerEntity` is current when
   * chunk-data eviction fires.
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

  /**
   * Assignable feedback handler — backward-compatible with the existing
   * `RenderClient.onChunksEvicted` field. See type docstring on
   * {@link ChunksEvictedHandler} for argument shape notes.
   */
  onChunksEvicted: ChunksEvictedHandler | null;

  /**
   * Assignable feedback handler — backward-compatible with the existing
   * `RenderClient.onWantedSetDelta` field.
   */
  onWantedSetDelta: WantedSetHandler | null;
}
