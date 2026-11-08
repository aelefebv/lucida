/**
 * Free-function chunk dispatch helpers. Wrap `client.sliceChunkData` /
 * `client.volumeChunkData` with structured args derived from a delivery +
 * level meta.
 */

import type { ReadyChunkDelivery } from "../../fetch/index.ts";
import type { UploadClient } from "../uploadClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import { Axis } from "../../../axes.ts";
import { labelDepthZ } from "../../../renderer/labelLayout.ts";
import { sliceLevelZ } from "../../../renderer/slicePlane.ts";

/** The worker's member id for an image's channel; the cold state's wanted chunks use the same one. */
export function workerMemberId(imageId: string, c: number, multiChannel: boolean): string {
  return multiChannel ? `${imageId}:ch${c}` : imageId;
}

export function workerMemberIdForChunk(
  delivery: ReadyChunkDelivery,
  multiChannel: boolean,
): string {
  return workerMemberId(delivery.imageId, delivery.c, multiChannel);
}

export function parseWorkerMemberId(memberId: string): {
  imageId: string;
  c: number | null;
} {
  const match = /^(.*):ch(\d+)$/.exec(memberId);
  if (!match) return { imageId: memberId, c: null };
  return { imageId: match[1], c: Number(match[2]) };
}

export function channelFromChunkKey(chunkKey: string): number | null {
  const parts = chunkKey.split("/");
  if (parts.length < 3) return null;
  const c = Number(parts[2]);
  return Number.isFinite(c) ? c : null;
}

/**
 * Picks the slice vs volume client variant based on `viewMode`.
 * Caller owns counter accounting (tracker mark, stats bumps).
 */
export function dispatchChunk(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  viewMode: "slice" | "volume",
  workerMemberId: string,
  sliceZ: number | null,
  epochs: SceneEpochs,
): void {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta) return;
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const chunkData = {
    data: delivery.data,
    dataType: delivery.dataType,
    x: delivery.x,
    y: delivery.y,
    z: delivery.z,
    key: delivery.chunkKey,
  };

  if (viewMode === "slice") {
    const fullResDepth = meta.image.multiscale.levels[0].shape[Axis.Z];
    client.sliceChunkData(
      workerMemberId,
      [chunkData],
      delivery.level,
      sliceZ!,
      delivery.t,
      delivery.c,
      levelWidth,
      levelHeight,
      chunkX,
      chunkY,
      chunkZ,
      fullResDepth,
      levelDepth,
      sliceZ!,
      epochs,
      delivery.residencyTier,
    );
  } else {
    client.volumeChunkData(
      workerMemberId,
      [chunkData],
      delivery.level,
      delivery.t,
      delivery.c,
      levelWidth,
      levelHeight,
      levelDepth,
      chunkX,
      chunkY,
      chunkZ,
      epochs,
      delivery.residencyTier,
    );
  }
}

export function dispatchChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  viewMode: "slice" | "volume",
  multiChannel: boolean,
  sliceZ: number | null,
  epochs: SceneEpochs,
): string {
  const workerMemberId = workerMemberIdForChunk(delivery, multiChannel);
  dispatchChunk(client, delivery, meta, viewMode, workerMemberId, sliceZ, epochs);
  return workerMemberId;
}

/**
 * Deliver the one Z-plane of a uint32 label chunk that the slice view needs
 * to the r32uint label pool. A 3D label chunk is ~8 MB though the worker
 * draws one ~64 KB plane, and labels sort after intensity, so sending the
 * whole chunk would starve them of upload budget.
 *
 * Returns the member id and bytes sent, or `null` when geometry is missing
 * or the chunk covers a different Z-chunk than the current view.
 */
export function dispatchLabelChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  sliceZ: number | null,
  epochs: SceneEpochs,
): { memberId: string; bytes: number } | null {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta || sliceZ === null || !meta.labelLevel0 || !meta.labelSourceLevel0) {
    return null;
  }
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const label0Depth = meta.labelLevel0.shape[Axis.Z];

  // Which Z-plane the current view wants, in this level's coords.
  const labelFullResZ = labelDepthZ(sliceZ, meta.labelSourceLevel0, meta.labelLevel0);
  const levelZ = sliceLevelZ(labelFullResZ, label0Depth, levelDepth);
  const cz = Math.max(chunkZ, 1);
  const targetChunkZ = Math.floor(levelZ / cz);
  // This chunk covers a different Z-chunk than the current view — the right
  // one is requested separately; drop this stale plane.
  if (delivery.z !== targetChunkZ) return null;
  const localZ = levelZ - targetChunkZ * cz;

  const planeLen = chunkY * chunkX;
  const full = new Uint32Array(delivery.data);
  const sliceOffset = localZ * planeLen;
  if (sliceOffset + planeLen > full.length) return null; // malformed / short chunk
  // Copy the plane out of the cache-owned buffer (never detach the cache's copy).
  const plane = full.slice(sliceOffset, sliceOffset + planeLen);
  const memberId = delivery.imageId;

  client.labelSliceChunkData(
    memberId,
    meta.datasetId,
    [{
      data: plane.buffer,
      dataType: delivery.dataType,
      x: delivery.x,
      y: delivery.y,
      z: 0,
      key: delivery.chunkKey,
    }],
    delivery.level,
    delivery.t,
    delivery.c,
    levelWidth,
    levelHeight,
    chunkX,
    chunkY,
    epochs,
  );
  return { memberId, bytes: plane.byteLength };
}

/**
 * Deliver a whole uint32 label chunk to the r32uint label volume pool. The
 * first-hit surface needs the full depth, since each ray stops at the first
 * non-zero voxel anywhere along it. Returns the member id and bytes sent,
 * or `null` when the level geometry is unavailable.
 */
export function dispatchLabelVolumeChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  epochs: SceneEpochs,
): { memberId: string; bytes: number } | null {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta) return null;
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const memberId = delivery.imageId;

  client.labelVolumeChunkData(
    memberId,
    meta.datasetId,
    [{
      data: delivery.data,
      dataType: delivery.dataType,
      x: delivery.x,
      y: delivery.y,
      z: delivery.z,
      key: delivery.chunkKey,
    }],
    delivery.level,
    delivery.t,
    delivery.c,
    levelWidth,
    levelHeight,
    levelDepth,
    chunkX,
    chunkY,
    chunkZ,
    epochs,
  );
  return { memberId, bytes: delivery.data.byteLength };
}
