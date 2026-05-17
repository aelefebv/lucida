/**
 * WorkerFeedback — owns the worker → main-thread feedback handlers
 * (`chunksEvicted`, `wantedSetDelta`).
 */

import type { CpuCache } from "../../fetch/index.ts";
import type {
  ChunkFeedbackReason,
  MissingChunk,
  MissingProxy,
} from "../../../renderer/workerProtocol.ts";
import { debugLog } from "../../../debug/logging.ts";
import { proxyKeyFromMissing } from "../proxyKeys.ts";
import {
  channelFromChunkKey,
  parseWorkerMemberId,
} from "./dispatch.ts";

export class WorkerFeedback {
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
    memberId: string,
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
      cpuCache.markChunkEvicted(parsed.imageId, c, group.evicted, group.skipped);
    }

    if (evicted.length > 0 || skipped.length > 0) {
      debugLog("orch", "upload.worker_chunk_feedback", {
        memberId,
        imageId: parsed.imageId,
        reason: reason ?? "evicted",
        requeued: evicted.length,
        rejected: skipped.length,
      });
    }
  }

  /**
   * Worker wanted-set is authoritative residency feedback. Chunks clear
   * optimistic sent state; proxies do the same through their composite
   * proxy key. Both paths schedule a residency tick in RenderLoop.
   */
  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
    cpuCache: CpuCache,
  ): void {
    let missingChunks = 0;
    let missingProxies = 0;
    for (const entry of missing) {
      if (entry.kind === "chunk") {
        const parsed = parseWorkerMemberId(entry.memberId);
        const c = entry.c ?? parsed.c ?? channelFromChunkKey(entry.chunkKey) ?? 0;
        cpuCache.markChunkMissing(parsed.imageId, c, entry.chunkKey);
        missingChunks++;
      } else if (entry.kind === "proxy") {
        cpuCache.markProxyMissing(proxyKeyFromMissing(entry));
        missingProxies++;
      }
    }
    if (missingChunks > 0 || missingProxies > 0) {
      debugLog("orch", "upload.worker_wanted_set_delta", {
        missingChunks,
        missingProxies,
      });
    }
  }
}
