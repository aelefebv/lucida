/**
 * Drain-pass primitives: pure `classifyDelivery` filter + `runDrainPass`
 * loop.
 *
 * The drain pass iterates `cpuCache.drain(budget)` output: for each
 * delivery it asks `classifyDelivery` whether to send or skip, applies
 * the verdict (counter bump + dispatch), and stops when the byte
 * budget is exhausted.
 *
 * See Pass 2 Seam D / Pass 6 Item 1 of the dechaos upload scan for
 * the rationale.
 */

import type {
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
} from "../../fetch/index.ts";
import type { RenderClient } from "../../../renderer/renderClient.ts";
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
 * Pure filter applied per delivery in the drain pass. Returns a verdict;
 * the caller applies side effects (counter bumps, send) based on it.
 *
 * Proxies always pass (the worker proxy pool has its own admission
 * policy; there's no per-tick lane/LOD filter on proxies). Chunks are
 * filtered by lane (prefetch/overview belong to other pipelines),
 * target-LOD (level must match the most recent plan for the image),
 * and manifest membership (image must resolve to a `ManifestEntry`).
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
  client: RenderClient;
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

/**
 * Drain-pass loop: iterate decoded deliveries, classify each, dispatch
 * the ones that pass, and stop when the byte budget is exhausted.
 *
 * Counter accounting is uniform across chunk and proxy paths — both
 * write directly to `stats` here (the old `sendDeliveryToWorker` had
 * helper-internal `skippedAlreadySent` / `skippedNoMeta` writes for
 * chunks but no equivalent for proxies; the asymmetry goes away after
 * extraction because `classifyDelivery` produces every skip reason
 * and the caller bumps every counter uniformly).
 */
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
 * Dispatch a chunk delivery to the worker, accounting for already-sent
 * guards. Bumps `stats.skippedAlreadySent` and returns 0 when the
 * tracker already shows the chunk on the worker; otherwise calls
 * `dispatchChunk`, marks the tracker, and returns the bytes sent.
 *
 * Exported as a free helper (rather than inlined) so the chunk-resend
 * pass can reuse the same dispatch shape without duplicating the
 * tracker-mark / byteLength bookkeeping.
 */
export function sendChunk(
  client: RenderClient,
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

/**
 * Dispatch a proxy delivery to the worker and record it in the
 * tracker's proxy-delivered set. Returns the bytes sent.
 */
export function sendProxy(
  client: RenderClient,
  delivery: ReadyProxyDelivery,
  tracker: DeliveryTracker,
  epochs: SceneEpochs,
): number {
  dispatchProxy(client, delivery, epochs);
  tracker.markProxyDelivered(proxyKeyFromDelivery(delivery));
  return delivery.data.byteLength;
}
