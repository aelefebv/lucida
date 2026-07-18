/**
 * WorkerFeedback — owns the worker → main-thread feedback handlers
 * (`chunksEvicted`, `wantedSetDelta`).
 */

import type { CpuCache } from "../../fetch/index.ts";
import type {
  ChunkFeedbackReason,
  MissingChunk,
} from "../../../renderer/workerProtocol.ts";
import { debugLog } from "../../../debug/logging.ts";
import {
  channelFromChunkKey,
  parseWorkerMemberId,
} from "./dispatch.ts";

export class WorkerFeedback {
  private readonly datasetsWithWantedSnapshot = new Set<string>();
  private readonly missingChunksByDataset = new Map<
    string,
    Map<string, Map<number, Map<"detail" | "coarse", Set<string>>>>
  >();

  /**
   * - `evicted` chunks were displaced by closer arrivals — re-eligible
   *   under the same plan.
   * - `skipped` chunks never made it in (atlas full + too far) —
   *   recorded as rejected and forwarded to `cpuCache.markRejected`
   *   when the entityId is known, so the cache stops re-fetching them.
   *
   * `cpuCache` is a parameter because the orchestrator owns no
   * cpuCache reference today (it gets one through `ctx.cpuCache`).
   */
  handleChunksEvicted(
    datasetId: string,
    memberId: string,
    tier: "detail" | "coarse",
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
    reason?: ChunkFeedbackReason,
  ): void {
    const parsed = parseWorkerMemberId(memberId);
    const byChannel = new Map<number, { evicted: string[]; skipped: string[] }>();
    const collect = (chunkKey: string, bucket: "evicted" | "skipped"): void => {
      const c = parsed.c ?? channelFromChunkKey(chunkKey) ?? 0;
      let group = byChannel.get(c);
      if (!group) {
        group = { evicted: [], skipped: [] };
        byChannel.set(c, group);
      }
      group[bucket].push(chunkKey);
    };

    for (const chunkKey of evicted) collect(chunkKey, "evicted");
    for (const chunkKey of skipped) collect(chunkKey, "skipped");

    for (const [c, group] of byChannel) {
      cpuCache.markChunkEvicted(
        datasetId,
        parsed.imageId,
        c,
        tier,
        group.evicted,
        group.skipped,
      );
    }

    if (evicted.length > 0 || skipped.length > 0) {
      debugLog("orch", "upload.worker_chunk_feedback", {
        memberId,
        datasetId,
        imageId: parsed.imageId,
        tier,
        reason: reason ?? "evicted",
        requeued: evicted.length,
        rejected: skipped.length,
      });
    }
  }

  /**
   * Worker wanted-set is authoritative residency feedback. Missing chunks
   * clear optimistic sent state and schedule a residency tick in RenderLoop.
   */
  handleWantedSetDelta(
    datasetId: string,
    missing: MissingChunk[],
    cpuCache: CpuCache,
  ): void {
    this.datasetsWithWantedSnapshot.add(datasetId);
    const missingChunksForDataset = new Map<
      string,
      Map<number, Map<"detail" | "coarse", Set<string>>>
    >();
    let missingChunks = 0;
    for (const entry of missing) {
      const parsed = parseWorkerMemberId(entry.memberId);
      const c = entry.c ?? parsed.c ?? channelFromChunkKey(entry.chunkKey) ?? 0;
      const imageId = parsed.imageId;
      let byChannel = missingChunksForDataset.get(imageId);
      if (!byChannel) {
        byChannel = new Map();
        missingChunksForDataset.set(imageId, byChannel);
      }
      let byTier = byChannel.get(c);
      if (!byTier) {
        byTier = new Map();
        byChannel.set(c, byTier);
      }
      let keys = byTier.get(entry.tier);
      if (!keys) {
        keys = new Set();
        byTier.set(entry.tier, keys);
      }
      keys.add(entry.chunkKey);
      cpuCache.markChunkMissing(datasetId, parsed.imageId, c, entry.chunkKey, entry.tier);
      missingChunks++;
    }
    if (missingChunks > 0) {
      debugLog("orch", "upload.worker_wanted_set_delta", {
        missingChunks,
      });
    }
    this.missingChunksByDataset.set(datasetId, missingChunksForDataset);
  }

  chunkResidency(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
    tier: "detail" | "coarse",
  ): "resident" | "missing" | "unknown" {
    if (!this.datasetsWithWantedSnapshot.has(datasetId)) return "unknown";
    const missing = this.missingChunksByDataset.get(datasetId)
      ?.get(imageId)
      ?.get(c)
      ?.get(tier)
      ?.has(chunkKey) ?? false;
    return missing ? "missing" : "resident";
  }
}
