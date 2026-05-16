/**
 * Resend-pass primitives: pure `classifyChunkResend` /
 * `classifyProxyResend` dedup filters + the `runChunkResendPass` /
 * `runProxyResendPass` loops.
 *
 * The resend passes walk the planner's most-recent per-dataset
 * request lists (`_lastFilteredRequests`, `_lastProxyRequests`) and
 * re-send anything the worker hasn't yet received (atlas / proxy pool
 * eviction recovery). Mirrors the cpuCache dedup ladder pattern.
 *
 * See Pass 2 Seam E / Pass 6 Item 2 of the dechaos upload scan.
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
import type { RenderClient } from "../../../renderer/renderClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { UploadTickStats } from "../../../debug/debugStats.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import type { DeliveryTracker } from "./tracker.ts";
import type { RunPassResult } from "./drain.ts";
import { sendChunk, sendProxy } from "./drain.ts";
import { proxyKeyFromRequest } from "../proxyKeys.ts";

// ---------------------------------------------------------------------------
// Pure dedup filters
// ---------------------------------------------------------------------------

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
 * Pure dedup filter for the chunk resend pass.
 *
 * Order matches the historical inline ladder in `deliverToWorker`:
 *   1. prefetch — never resent (cache-only lane);
 *   2. already-sent — tracker says the worker has it;
 *   3. rejected — worker reported it as too-far (atlas full + farther
 *      than farthest existing slot);
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
 * Pure dedup filter for the proxy resend pass.
 *
 *   1. already-delivered — tracker has the composite key;
 *   2. not-cached — cpuCache has no entry to resend.
 *
 * Proxies have no lane or rejection concept (different from chunks),
 * so the ladder is shorter.
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

// ---------------------------------------------------------------------------
// Chunk resend loop
// ---------------------------------------------------------------------------

export interface RunChunkResendPassArgs {
  /** Per-dataset request map (kept this shape after #613). */
  requestsByDataset: Map<string, ChunkRequest[]>;
  manifestByImage: Map<string, ManifestEntry>;
  tracker: DeliveryTracker;
  cpuCache: CpuCache;
  client: RenderClient;
  multiChannel: boolean;
  viewMode: "slice" | "volume";
  sliceZ: number | null;
  epochs: SceneEpochs;
  stats: UploadTickStats;
  recordUpload: (bytes: number, isResend: boolean) => void;
  remaining: number;
}

/**
 * Iterate every dataset's most-recent filtered chunk requests, dedup
 * via `classifyChunkResend`, and re-send anything the worker hasn't
 * yet acked. Stops on the byte budget like the drain pass.
 */
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

      // Resend "considered" counts everything that wasn't an upfront
      // prefetch skip — matches the prior inline counter that bumped
      // right after the lane filter.
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

// ---------------------------------------------------------------------------
// Proxy resend loop
// ---------------------------------------------------------------------------

export interface RunProxyResendPassArgs {
  requestsByDataset: Map<string, ProxyRequest[]>;
  tracker: DeliveryTracker;
  cpuCache: CpuCache;
  client: RenderClient;
  epochs: SceneEpochs;
  stats: UploadTickStats;
  recordUpload: (bytes: number, isResend: boolean) => void;
  remaining: number;
}

/**
 * Iterate every dataset's most-recent proxy requests, dedup via
 * `classifyProxyResend`, and re-send anything not already in the
 * tracker's delivered set. Stops on the byte budget.
 */
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
