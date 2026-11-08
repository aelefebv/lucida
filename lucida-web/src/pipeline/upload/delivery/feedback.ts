/**
 * WorkerFeedback — owns the worker → main-thread residency handlers
 * (`chunkResidency`, `wantedSetDelta`). The worker owns its slots; these
 * keep the CPU cache's delivery state a mirror of them.
 */

import type { CpuCache } from "../../fetch/index.ts";
import type { ResidencyTier } from "../../residencyTier.ts";
import type {
  ChunkFeedbackReason,
  ChunkResidencyChange,
  MissingChunk,
  MissingProxy,
} from "../../../renderer/workerProtocol.ts";
import { debugLog } from "../../../debug/logging.ts";
import { proxyKeyFromMissing } from "../proxyKeys.ts";
import type { ResendGuard } from "./resendGuard.ts";
import {
  channelFromChunkKey,
  parseWorkerMemberId,
} from "./dispatch.ts";

export class WorkerFeedback {
  private readonly guard: ResendGuard | null;

  /** `guard` hears every chunk the worker hands back, so a held chunk names its reason. */
  constructor(guard: ResendGuard | null = null) {
    this.guard = guard;
  }

  /**
   * Apply one residency report. `cpuCache` is a parameter because the
   * uploader owns no cpuCache reference (it gets one through `ctx.cpuCache`).
   * Returns whether a chunk may now be sent again.
   */
  handleChunkResidency(
    memberId: string,
    tier: ResidencyTier,
    change: ChunkResidencyChange,
    keys: string[],
    cpuCache: CpuCache,
    reason?: ChunkFeedbackReason,
  ): boolean {
    if (keys.length === 0) return false;
    const parsed = parseWorkerMemberId(memberId);
    const byChannel = new Map<number, string[]>();
    for (const chunkKey of keys) {
      const c = parsed.c ?? channelFromChunkKey(chunkKey) ?? 0;
      const group = byChannel.get(c);
      if (group) group.push(chunkKey);
      else byChannel.set(c, [chunkKey]);
    }

    if (change === "held") {
      for (const [c, group] of byChannel) cpuCache.markChunksHeld(parsed.imageId, c, tier, group);
      return false;
    }

    const why = reason ?? (change === "lost" ? "evicted" : "atlas-policy");
    for (const [c, group] of byChannel) {
      if (change === "lost") cpuCache.markChunksLost(parsed.imageId, c, tier, group, why);
      else cpuCache.markChunksRefused(parsed.imageId, c, tier, group, why);
      if (this.guard) {
        for (const key of group) this.guard.noteReturned(parsed.imageId, c, key, why);
      }
    }
    debugLog("orch", "upload.worker_chunk_feedback", {
      memberId,
      imageId: parsed.imageId,
      tier,
      change,
      reason: why,
      chunks: keys.length,
    });
    // An `atlas-policy` refusal waits for the next plan; the rest may go again now.
    return change === "lost" || why !== "atlas-policy";
  }

  /**
   * Proxies the worker lacks are re-delivered. A missing chunk normally
   * changes nothing, since every loss is reported on its own, but one the
   * mirror holds is a disagreement: it is logged, named to the guard, and
   * made sendable again. Returns whether anything may now be sent again.
   */
  handleWantedSetDelta(
    datasetId: string,
    missing: Array<MissingChunk | MissingProxy>,
    cpuCache: CpuCache,
  ): boolean {
    const disagreements: string[] = [];
    let missingProxies = 0;
    for (const entry of missing) {
      if (entry.kind === "chunk") {
        const parsed = parseWorkerMemberId(entry.memberId);
        const c = entry.c ?? parsed.c ?? channelFromChunkKey(entry.chunkKey) ?? 0;
        if (cpuCache.markChunkMissing(parsed.imageId, c, entry.chunkKey, entry.tier)) {
          this.guard?.noteMissing(parsed.imageId, c, entry.chunkKey);
          disagreements.push(`${entry.memberId}/${entry.chunkKey} [${entry.tier}]`);
        }
      } else if (entry.kind === "proxy") {
        cpuCache.markProxyMissing(proxyKeyFromMissing(entry));
        missingProxies++;
      }
    }
    if (disagreements.length > 0) {
      debugLog("orch", "upload.residency_disagreement", { datasetId, chunks: disagreements });
    }
    if (missingProxies > 0) {
      debugLog("orch", "upload.worker_wanted_set_delta", { missingProxies });
    }
    return disagreements.length > 0 || missingProxies > 0;
  }
}
