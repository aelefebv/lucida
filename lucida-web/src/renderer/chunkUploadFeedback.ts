/**
 * The worker's side of the page's residency mirror. Every change to which
 * chunks a pool holds goes out through here, so the page never has to guess.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { WorkerCtx } from "./workerContext.ts";
import type { ChunkFeedbackReason, ChunkResidencyChange } from "./workerProtocol.ts";
import { parseCompositeKey } from "./chunkKeys.ts";
import { chunkPoolTier } from "./poolKeys.ts";

/** The tier label chunks are delivered under (`pipeline/planning/labelRequests.ts`); label messages carry none. */
export const LABEL_TIER: ResidencyTier = "detail";

export function postChunkResidency(
  ctx: WorkerCtx,
  memberId: string,
  tier: ResidencyTier,
  change: ChunkResidencyChange,
  keys: string[],
  reason?: ChunkFeedbackReason,
): void {
  if (keys.length === 0) return;
  ctx.post({ type: "chunkResidency", memberId, tier, change, keys, reason });
}

/** Report composite slot keys a pool of `tier` no longer holds, one message per member. */
export function postSlotsLost(
  ctx: WorkerCtx,
  tier: ResidencyTier,
  compositeKeys: Iterable<string>,
  reason: ChunkFeedbackReason,
): void {
  const byMember = new Map<string, string[]>();
  for (const compositeKey of compositeKeys) {
    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const keys = byMember.get(parsed.memberId);
    if (keys) keys.push(parsed.chunkKey);
    else byMember.set(parsed.memberId, [parsed.chunkKey]);
  }
  for (const [memberId, keys] of byMember) {
    postChunkResidency(ctx, memberId, tier, "lost", keys, reason);
  }
}

/** What one chunk delivery did to a pool, collected while it runs and posted once at the end. */
export class ResidencyBatch {
  readonly held: string[] = [];
  /** Composite slot keys the delivery evicted, of any member in the pool. */
  readonly evicted: string[] = [];
  private readonly refused = new Map<ChunkFeedbackReason, string[]>();

  refuse(chunkKey: string, reason: ChunkFeedbackReason): void {
    const keys = this.refused.get(reason);
    if (keys) keys.push(chunkKey);
    else this.refused.set(reason, [chunkKey]);
  }

  /** Whether any chunk was refused or evicted, which can change the wanted set's report. */
  get displacedAny(): boolean {
    return this.evicted.length > 0 || this.refused.size > 0;
  }

  /**
   * Held goes first: a chunk this delivery wrote and a later one in the same
   * batch evicted must end lost on the page, not held.
   */
  post(ctx: WorkerCtx, memberId: string, tier: ResidencyTier): void {
    postChunkResidency(ctx, memberId, tier, "held", this.held);
    postSlotsLost(ctx, tier, this.evicted, "evicted");
    for (const [reason, keys] of this.refused) {
      postChunkResidency(ctx, memberId, tier, "refused", keys, reason);
    }
  }
}

/** Report every chunk held by a dataset's pools outside `keep`, which the caller is about to free. */
export function postFreedPools(ctx: WorkerCtx, datasetId: string, keep: ReadonlySet<string>): void {
  for (const atlases of [ctx.state.volumeAtlases, ctx.state.sliceAtlases]) {
    for (const [poolKey, atlas] of atlases) {
      if (atlas.datasetId !== datasetId || keep.has(poolKey)) continue;
      postSlotsLost(ctx, chunkPoolTier(poolKey), atlas.slots.keys(), "freed");
    }
  }
}
