/**
 * Drain pass — iterates `cpuCache.drain(budget)` output: classify each
 * delivery, apply the verdict (counter bump + dispatch), stop when the
 * byte budget is exhausted.
 */

import type {
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
} from "../../fetch/index.ts";
import type { UploadClient } from "../uploadClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { UploadTickStats } from "../../../debug/debugStats.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import type { DeliveryTracker } from "./tracker.ts";
import { dispatchChunk, dispatchProxy } from "./dispatch.ts";
import { proxyKeyFromDelivery } from "../proxyKeys.ts";

// ---------------------------------------------------------------------------
// Pure filter — classifyDelivery
// ---------------------------------------------------------------------------

export type FilterVerdict =
  | { action: "send-proxy" }
  | { action: "send-chunk" }
  | { action: "skip"; reason: "prefetch" | "overview" | "wrongLod" | "noMeta" };

/**
 * Pure filter. Proxies always pass (the worker proxy pool has its own
 * admission policy). Chunks are filtered by lane, target-LOD, and
 * manifest membership.
 */
export function classifyDelivery(
  delivery: ReadyDelivery,
  targetByImage: Map<string, number>,
  manifestByImage: Map<string, ManifestEntry>,
): FilterVerdict {
  if (delivery.kind === "proxy") return { action: "send-proxy" };
  if (delivery.lane === "prefetch") return { action: "skip", reason: "prefetch" };
  if (delivery.lane === "overview") return { action: "skip", reason: "overview" };

  const target = targetByImage.get(delivery.imageId);
  if (target === undefined || delivery.level !== target) {
    return { action: "skip", reason: "wrongLod" };
  }

  if (!manifestByImage.has(delivery.imageId)) {
    return { action: "skip", reason: "noMeta" };
  }
  return { action: "send-chunk" };
}

// ---------------------------------------------------------------------------
// Loop — runDrainPass
// ---------------------------------------------------------------------------

export interface RunDrainPassArgs {
  deliveries: ReadyDelivery[];
  targetByImage: Map<string, number>;
  manifestByImage: Map<string, ManifestEntry>;
  tracker: DeliveryTracker;
  client: UploadClient;
  multiChannel: boolean;
  viewMode: "slice" | "volume";
  sliceZ: number | null;
  epochs: SceneEpochs;
  stats: UploadTickStats;
  recordUpload: (bytes: number, isResend: boolean) => void;
  remaining: number;
}

export interface RunPassResult {
  remaining: number;
  budgetExhausted: boolean;
}

/** Iterate decoded deliveries, classify, dispatch, stop on byte budget. */
export function runDrainPass(args: RunDrainPassArgs): RunPassResult {
  const {
    deliveries,
    targetByImage,
    manifestByImage,
    tracker,
    client,
    multiChannel,
    viewMode,
    sliceZ,
    epochs,
    stats,
    recordUpload,
  } = args;
  let { remaining } = args;
  let budgetExhausted = false;

  for (const delivery of deliveries) {
    const verdict = classifyDelivery(delivery, targetByImage, manifestByImage);

    if (verdict.action === "skip") {
      switch (verdict.reason) {
        case "prefetch": stats.skippedPrefetch++; break;
        case "overview": stats.skippedOverview++; break;
        case "wrongLod": stats.skippedWrongLod++; break;
        case "noMeta": stats.skippedNoMeta++; break;
      }
      continue;
    }

    if (verdict.action === "send-proxy") {
      const sent = sendProxy(
        client, delivery as ReadyProxyDelivery, tracker, epochs,
      );
      if (sent > 0) {
        stats.uploadedProxies++;
        stats.bytesUploaded += sent;
        recordUpload(sent, false);
        remaining -= sent;
        if (remaining <= 0) {
          budgetExhausted = true;
          break;
        }
      }
      continue;
    }

    // send-chunk
    const sent = sendChunk(
      client,
      delivery as ReadyChunkDelivery,
      manifestByImage,
      tracker,
      multiChannel,
      viewMode,
      sliceZ,
      epochs,
      stats,
    );
    if (sent > 0) {
      stats.uploadedChunks++;
      stats.bytesUploaded += sent;
      recordUpload(sent, false);
      remaining -= sent;
      if (remaining <= 0) {
        budgetExhausted = true;
        break;
      }
    }
  }

  return { remaining, budgetExhausted };
}

// ---------------------------------------------------------------------------
// Internal: per-delivery dispatch with tracker / already-sent guard
// ---------------------------------------------------------------------------

/**
 * Dispatch a chunk + mark the tracker, with an already-sent guard.
 * Returns bytes sent (0 on skip). Exported so `runChunkResendPass`
 * reuses the same dispatch shape.
 */
export function sendChunk(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  manifestByImage: Map<string, ManifestEntry>,
  tracker: DeliveryTracker,
  multiChannel: boolean,
  viewMode: "slice" | "volume",
  sliceZ: number | null,
  epochs: SceneEpochs,
  stats: UploadTickStats,
): number {
  const workerMemberId = multiChannel
    ? `${delivery.imageId}:ch${delivery.c}`
    : delivery.imageId;

  const meta = manifestByImage.get(delivery.imageId);
  if (!meta) {
    stats.skippedNoMeta++;
    return 0;
  }
  if (!meta.levels[delivery.level]) {
    stats.skippedNoMeta++;
    return 0;
  }

  if (tracker.wasChunkSent(workerMemberId, delivery.chunkKey)) {
    stats.skippedAlreadySent++;
    return 0;
  }

  dispatchChunk(client, delivery, meta, viewMode, workerMemberId, sliceZ, epochs);
  tracker.markChunkSent(workerMemberId, delivery.entityId, delivery.chunkKey);
  return delivery.data.byteLength;
}

/** Dispatch a proxy + mark the tracker. Returns bytes sent. */
export function sendProxy(
  client: UploadClient,
  delivery: ReadyProxyDelivery,
  tracker: DeliveryTracker,
  epochs: SceneEpochs,
): number {
  dispatchProxy(client, delivery, epochs);
  tracker.markProxyDelivered(proxyKeyFromDelivery(delivery));
  return delivery.data.byteLength;
}
