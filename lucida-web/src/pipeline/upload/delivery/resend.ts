/**
 * Resend passes — walk the planner's most-recent per-dataset request
 * lists and re-send anything the worker hasn't yet received (atlas /
 * proxy pool eviction recovery). Mirrors the cpuCache dedup ladder.
 */

import type {
  ChunkRequest,
  ProxyRequest,
} from "../../planning/index.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
} from "../../fetch/index.ts";
import type { UploadClient } from "../uploadClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { UploadTickStats } from "../../../debug/debugStats.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import type { DeliveryTracker } from "./tracker.ts";
import type { RunPassResult } from "./drain.ts";
import { sendChunk, sendProxy } from "./drain.ts";
import { proxyKeyFromRequest } from "../proxyKeys.ts";

export type ResendVerdict<T> =
  | {
      action: "skip";
      reason:
        | "prefetch"
        | "alreadySent"
        | "rejected"
        | "notCached"
        | "alreadyDelivered";
    }
  | { action: "send"; cached: T };

/**
 * Pure dedup filter. Order:
 *   1. prefetch — never resent (cache-only lane);
 *   2. already-sent — tracker says the worker has it;
 *   3. rejected — worker reported it as too-far;
 *   4. not-cached — cpuCache has no entry to resend.
 */
export function classifyChunkResend(
  req: ChunkRequest,
  workerMemberId: string,
  tracker: DeliveryTracker,
  cpuCache: CpuCache,
): ResendVerdict<ReadyChunkDelivery> {
  if (req.lane === "prefetch") return { action: "skip", reason: "prefetch" };
  if (tracker.wasChunkSent(workerMemberId, req.chunkKey)) {
    return { action: "skip", reason: "alreadySent" };
  }
  if (tracker.wasChunkRejected(workerMemberId, req.chunkKey)) {
    return { action: "skip", reason: "rejected" };
  }
  const cached = cpuCache.getCachedChunk(req.entityId, req.chunkKey);
  if (!cached) return { action: "skip", reason: "notCached" };
  return { action: "send", cached };
}

/**
 * Pure dedup filter. Proxies have no lane or rejection concept, so
 * the ladder is shorter than `classifyChunkResend`:
 *   1. already-delivered — tracker has the composite key;
 *   2. not-cached — cpuCache has no entry to resend.
 */
export function classifyProxyResend(
  req: ProxyRequest,
  tracker: DeliveryTracker,
  cpuCache: CpuCache,
): ResendVerdict<ReadyProxyDelivery> {
  if (tracker.wasProxyDelivered(proxyKeyFromRequest(req))) {
    return { action: "skip", reason: "alreadyDelivered" };
  }
  const cached = cpuCache.getCachedProxy(
    req.datasetId,
    req.entityId,
    req.kind,
    req.t,
    req.c,
  );
  if (!cached) return { action: "skip", reason: "notCached" };
  return { action: "send", cached };
}

export interface RunChunkResendPassArgs {
  /** Per-dataset map (avoids last-dataset-wins). */
  requestsByDataset: Map<string, ChunkRequest[]>;
  manifestByImage: Map<string, ManifestEntry>;
  tracker: DeliveryTracker;
  cpuCache: CpuCache;
  client: UploadClient;
  multiChannel: boolean;
  viewMode: "slice" | "volume";
  sliceZ: number | null;
  epochs: SceneEpochs;
  stats: UploadTickStats;
  recordUpload: (bytes: number, isResend: boolean) => void;
  remaining: number;
}

/** Re-send chunks the worker hasn't yet acked. Stops on the byte budget. */
export function runChunkResendPass(
  args: RunChunkResendPassArgs,
): RunPassResult {
  const {
    requestsByDataset,
    manifestByImage,
    tracker,
    cpuCache,
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

  outer: for (const requests of requestsByDataset.values()) {
    for (const req of requests) {
      if (budgetExhausted) break outer;

      const workerMemberId = multiChannel
        ? `${req.imageId}:ch${req.c}`
        : req.imageId;

      const verdict = classifyChunkResend(req, workerMemberId, tracker, cpuCache);

      // Resend "considered" excludes upfront prefetch skips.
      if (verdict.action === "skip" && verdict.reason === "prefetch") {
        continue;
      }
      stats.resendChunksConsidered++;

      if (verdict.action === "skip") {
        switch (verdict.reason) {
          case "alreadySent": stats.resendChunksAlreadySent++; break;
          case "rejected": stats.resendChunksRejected++; break;
          case "notCached": stats.resendChunksNotCached++; break;
        }
        continue;
      }

      const sent = sendChunk(
        client,
        verdict.cached,
        manifestByImage,
        tracker,
        multiChannel,
        viewMode,
        sliceZ,
        epochs,
        stats,
      );
      if (sent > 0) {
        stats.resendChunkUploads++;
        stats.bytesUploaded += sent;
        recordUpload(sent, true);
        remaining -= sent;
        if (remaining <= 0) budgetExhausted = true;
      }
    }
  }

  return { remaining, budgetExhausted };
}

export interface RunProxyResendPassArgs {
  requestsByDataset: Map<string, ProxyRequest[]>;
  tracker: DeliveryTracker;
  cpuCache: CpuCache;
  client: UploadClient;
  epochs: SceneEpochs;
  stats: UploadTickStats;
  recordUpload: (bytes: number, isResend: boolean) => void;
  remaining: number;
}

/** Re-send proxies not already in the tracker's delivered set. Stops on the byte budget. */
export function runProxyResendPass(
  args: RunProxyResendPassArgs,
): RunPassResult {
  const {
    requestsByDataset,
    tracker,
    cpuCache,
    client,
    epochs,
    stats,
    recordUpload,
  } = args;
  let { remaining } = args;
  let budgetExhausted = false;

  outer: for (const requests of requestsByDataset.values()) {
    for (const req of requests) {
      if (budgetExhausted) break outer;

      stats.resendProxiesConsidered++;

      const verdict = classifyProxyResend(req, tracker, cpuCache);
      if (verdict.action === "skip") {
        switch (verdict.reason) {
          case "alreadyDelivered": stats.resendProxiesAlreadyDelivered++; break;
          case "notCached": stats.resendProxiesNotCached++; break;
        }
        continue;
      }

      const sent = sendProxy(client, verdict.cached, tracker, epochs);
      if (sent > 0) {
        stats.resendProxyUploads++;
        stats.bytesUploaded += sent;
        recordUpload(sent, true);
        remaining -= sent;
        if (remaining <= 0) budgetExhausted = true;
      }
    }
  }

  return { remaining, budgetExhausted };
}
