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
