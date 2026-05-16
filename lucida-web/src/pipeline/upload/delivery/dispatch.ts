/**
 * Free-function chunk and proxy dispatch helpers.
 *
 * Wraps `client.sliceChunkData` / `client.volumeChunkData` /
 * `client.proxyAssetData` with structured args derived from a
 * `ReadyChunkDelivery` / `ReadyProxyDelivery` + level meta.
 *
 * Lifted out of `Orchestrator.sendDeliveryToWorker` and
 * `sendProxyDeliveryToWorker` so the dispatch loop has no orchestrator
 * state and the per-tick manifest index lookup happens once at the
 * caller (see `manifestIndex.ts`).
 *
 * See Pass 3 `sendDeliveryToWorker` decomposition and Pass 6 Items 7-8
 * of the dechaos upload scan for the rationale.
 */

import type { ReadyChunkDelivery, ReadyProxyDelivery } from "../../fetch/index.ts";
import type { RenderClient } from "../../../renderer/renderClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import { Axis } from "../../../axes.ts";

/**
 * Send a single chunk delivery to the GPU worker. Resolves all
 * level-meta-derived arguments from the pre-built manifest entry and
 * picks the slice vs volume variant based on `viewMode`.
 *
 * Returns nothing — the caller owns counter accounting (tracker mark,
 * stats bumps) so the dispatch step stays a thin postMessage wrapper.
 */
export function dispatchChunk(
  client: RenderClient,
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
    );
  }
}

/**
 * Send a proxy asset delivery to the GPU worker. Thin wrapper around
 * `client.proxyAssetData` that destructures the delivery into the
 * positional-arg layout the client method expects.
 */
export function dispatchProxy(
  client: RenderClient,
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
