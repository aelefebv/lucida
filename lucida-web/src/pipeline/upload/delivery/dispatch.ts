/**
 * Free-function chunk and proxy dispatch helpers. Wrap
 * `client.sliceChunkData` / `client.volumeChunkData` / `client.proxyAssetData`
 * with structured args derived from a delivery + level meta.
 */

import type { ReadyChunkDelivery, ReadyProxyDelivery } from "../../fetch/index.ts";
import type { UploadClient } from "../uploadClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import { Axis } from "../../../axes.ts";
import { labelLevelZTarget } from "../../../renderer/labelLayout.ts";

export function workerMemberIdForChunk(
  delivery: ReadyChunkDelivery,
  multiChannel: boolean,
): string {
  return multiChannel ? `${delivery.imageId}:ch${delivery.c}` : delivery.imageId;
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
 * Deliver one uint32 label chunk to the r32uint label pool — but only the
 * SINGLE Z-plane the current view needs. A real label 3D chunk is ~8 MB
 * (e.g. 128³ u32) though the worker draws one ~64 KB plane; sending the
 * whole chunk would exhaust the per-frame upload budget on a single tile
 * (labels sort after intensity, so they'd starve). So the target plane is
 * extracted here from the label's own full-res Z (mapped from the current
 * source Z) and only that crosses to the worker.
 *
 * This is the 2D slice variant (the 3D volume view uses
 * {@link dispatchLabelVolumeChunkDelivery}, which forwards the whole chunk).
 * Returns the worker member id + the bytes actually sent (for budget
 * accounting), or `null` when geometry is unavailable or the chunk is for a
 * different Z-plane-chunk than the current view (a stale scrub).
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
  const [, , , levelHeight, levelWidth] = levelMeta.shape;
  const [, , , chunkY, chunkX] = levelMeta.chunk_shape;

  // Which Z-plane the current view wants, in this level's coords — via the
  // SAME helper the request emitter uses, so fetch and delivery always agree
  // on which z-chunk holds the view's plane.
  const { chunkZ: targetChunkZ, localZ } = labelLevelZTarget(
    sliceZ,
    meta.labelSourceLevel0,
    meta.labelLevel0,
    levelMeta,
  );
  // This chunk covers a different Z-chunk than the current view — the right
  // one is requested separately; drop this stale plane.
  if (delivery.z !== targetChunkZ) return null;

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
 * Deliver one uint32 label chunk to the r32uint label VOLUME pool — the
 * WHOLE 3D chunk, no plane extraction. The 3D first-hit surface needs the
 * full label volume (each ray stops at the first non-zero voxel anywhere
 * along its depth), so unlike {@link dispatchLabelChunkDelivery} (which
 * pre-slices to one ~64 KB Z-plane for the 2D view) the entire ~8 MB chunk
 * crosses to the worker. The uploader accounts the real byte size so the
 * per-frame budget throttles the volume across frames rather than fanning
 * every chunk out at once.
 *
 * Returns the worker member id + the bytes sent (for budget accounting), or
 * `null` when the level geometry is unavailable.
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

export function dispatchProxy(
  client: UploadClient,
  delivery: ReadyProxyDelivery,
  epochs: SceneEpochs,
): void {
  client.proxyAssetData(
    delivery.datasetId,
    delivery.entityId,
    delivery.imageId,
    delivery.proxyKind,
    delivery.t,
    delivery.c,
    delivery.header.dims,
    delivery.data,
    epochs,
  );
}
