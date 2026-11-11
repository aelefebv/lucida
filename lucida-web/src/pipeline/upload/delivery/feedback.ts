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
  PoolMode,
} from "../../../renderer/workerProtocol.ts";
import { debugLog } from "../../../debug/logging.ts";
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
    mode: PoolMode,
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
      for (const [c, group] of byChannel) cpuCache.markChunksHeld(parsed.imageId, c, mode, tier, group);
      return false;
    }

    const why = reason ?? (change === "lost" ? "evicted" : "atlas-policy");
    for (const [c, group] of byChannel) {
      if (change === "lost") cpuCache.markChunksLost(parsed.imageId, c, mode, tier, group, why);
      else cpuCache.markChunksRefused(parsed.imageId, c, mode, tier, group, why);
      if (this.guard) {
        for (const key of group) this.guard.noteReturned(parsed.imageId, c, mode, key, why);
      }
    }
    debugLog("orch", "upload.worker_chunk_feedback", {
      memberId,
      imageId: parsed.imageId,
      mode,
      tier,
      change,
      reason: why,
      chunks: keys.length,
    });
    // An `atlas-policy` refusal waits for the next plan; the rest may go again now.
    return change === "lost" || why !== "atlas-policy";
  }

  /**
   * A missing chunk normally changes nothing, since every loss is reported
   * on its own, but one the mirror holds is a disagreement: it is logged,
   * named to the guard, and made sendable again. Returns whether anything
   * may now be sent again.
   */
  handleWantedSetDelta(
    datasetId: string,
    mode: PoolMode,
    missing: MissingChunk[],
    cpuCache: CpuCache,
  ): boolean {
    const disagreements: string[] = [];
    for (const entry of missing) {
      const parsed = parseWorkerMemberId(entry.memberId);
      const c = entry.c ?? parsed.c ?? channelFromChunkKey(entry.chunkKey) ?? 0;
      if (cpuCache.markChunkMissing(parsed.imageId, c, entry.chunkKey, mode, entry.tier)) {
        this.guard?.noteMissing(parsed.imageId, c, mode, entry.chunkKey);
        disagreements.push(`${entry.memberId}/${entry.chunkKey} [${entry.tier}]`);
      }
    }
    if (disagreements.length > 0) {
      debugLog("orch", "upload.residency_disagreement", { datasetId, mode, chunks: disagreements });
    }
    return disagreements.length > 0;
  }
}
