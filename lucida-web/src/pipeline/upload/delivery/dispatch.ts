/**
 * Free-function chunk dispatch helpers. Wrap the client's chunk senders with
 * structured args derived from a delivery + level meta.
 */

import type { ReadyChunkDelivery } from "../../fetch/index.ts";
import type { UploadClient } from "../uploadClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import { Axis } from "../../../axes.ts";
import { labelLevelZ } from "../../../renderer/labelLayout.ts";
import { sliceLevelZ } from "../../../renderer/slicePlane.ts";
import { decodedSampleBytes } from "../../../renderer/dataTypeUtil.ts";

/**
 * The worker's member id for an image's channel; the cold state's wanted
 * chunks use the same one. Every channel has its own id whatever a layer
 * shows, so a solo or a return to the composite keeps the resources of the
 * channels it still shows.
 */
export function workerMemberId(imageId: string, c: number): string {
  return `${imageId}:ch${c}`;
}

export function workerMemberIdForChunk(delivery: ReadyChunkDelivery): string {
  return workerMemberId(delivery.imageId, delivery.c);
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

/** What a dispatch posted: the worker member it went to and the bytes it carried. */
export interface Dispatched {
  memberId: string;
  bytes: number;
}

/**
 * One Z plane of a decoded chunk, copied out of the cache's buffer, which the
 * cache keeps for later deliveries. `null` when the chunk is too short to
 * hold it. Posting transfers the copy and empties it, so its size is read
 * before the post.
 */
function cutPlane(data: ArrayBuffer, dataType: string, localZ: number, planeLen: number): ArrayBuffer | null {
  const planeBytes = planeLen * decodedSampleBytes(dataType);
  const start = localZ * planeBytes;
  if (localZ < 0 || start + planeBytes > data.byteLength) return null;
  return data.slice(start, start + planeBytes);
}

/**
 * Post one chunk to the worker. The slice view draws one plane of a chunk,
 * so it is sent only the plane `sliceZ` maps to, a chunk-depth fraction of
 * the bytes, and a Z move to another plane of the same chunk sends that
 * plane. Returns `null`, posting nothing, when the chunk does not hold the
 * plane: the plan has moved on to the chunk that does.
 */
export function dispatchChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  viewMode: "slice" | "volume",
  sliceZ: number | null,
  epochs: SceneEpochs,
): Dispatched | null {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta) return null;
  const memberId = workerMemberIdForChunk(delivery);
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const chunk = {
    data: delivery.data,
    dataType: delivery.dataType,
    x: delivery.x,
    y: delivery.y,
    z: delivery.z,
    key: delivery.chunkKey,
  };

  if (viewMode === "volume") {
    client.volumeChunkData(
      memberId,
      [chunk],
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
    return { memberId, bytes: delivery.data.byteLength };
  }

  if (sliceZ === null) return null;
  const fullResDepth = meta.image.multiscale.levels[0].shape[Axis.Z];
  const levelZ = sliceLevelZ(sliceZ, fullResDepth, levelDepth);
  const cz = Math.max(chunkZ, 1);
  if (delivery.z !== Math.floor(levelZ / cz)) return null;
  const plane = cutPlane(delivery.data, delivery.dataType, levelZ - delivery.z * cz, chunkY * chunkX);
  if (!plane) return null;
  const bytes = plane.byteLength;
  client.sliceChunkData(
    memberId,
    [{ ...chunk, data: plane }],
    delivery.level,
    sliceZ,
    delivery.t,
    delivery.c,
    levelWidth,
    levelHeight,
    chunkX,
    chunkY,
    chunkZ,
    fullResDepth,
    levelDepth,
    sliceZ,
    epochs,
    delivery.residencyTier,
  );
  return { memberId, bytes };
}

/**
 * Deliver the one Z-plane of a uint32 label chunk that the slice view needs
 * to the r32uint label pool. A 3D label chunk is ~8 MB though the worker
 * draws one ~64 KB plane, and labels sort after intensity, so sending the
 * whole chunk would starve them of upload budget.
 *
 * Returns `null` when geometry is missing or the chunk covers a different
 * Z-chunk than the current view.
 */
export function dispatchLabelChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  sliceZ: number | null,
  epochs: SceneEpochs,
): Dispatched | null {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta || sliceZ === null || !meta.labelLevel0 || !meta.labelSourceLevel0) {
    return null;
  }
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const levelZ = labelLevelZ(sliceZ, meta.labelSourceLevel0, meta.labelLevel0, levelDepth);
  const cz = Math.max(chunkZ, 1);
  // This chunk covers a different Z-chunk than the current view — the right
  // one is requested separately; drop this stale plane.
  if (delivery.z !== Math.floor(levelZ / cz)) return null;
  const plane = cutPlane(delivery.data, delivery.dataType, levelZ - delivery.z * cz, chunkY * chunkX);
  if (!plane) return null;
  const memberId = delivery.imageId;
  const bytes = plane.byteLength;

  client.labelSliceChunkData(
    memberId,
    meta.datasetId,
    [{
      data: plane,
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
    levelZ,
    epochs,
  );
  return { memberId, bytes };
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
): Dispatched | null {
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
