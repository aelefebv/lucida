/**
 * The worker's side of the page's residency mirror. Every change to which
 * chunks a pool holds goes out through here, so the page never has to guess.
 * A slice pool holds each plane of a chunk on its own, so a report about one
 * names the plane.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { WorkerCtx } from "./workerContext.ts";
import type { ChunkFeedbackReason, ChunkResidencyChange, PoolMode } from "./workerProtocol.ts";
import type { PoolCut, SpatialAxis } from "./slicePlane.ts";
import { parseCompositeKey } from "./chunkKeys.ts";

/** The tier label chunks are delivered under (`pipeline/planning/labelRequests.ts`); label messages carry none. */
export const LABEL_TIER: ResidencyTier = "detail";

export function postChunkResidency(
  ctx: WorkerCtx,
  memberId: string,
  viewMode: PoolMode,
  tier: ResidencyTier,
  change: ChunkResidencyChange,
  keys: string[],
  reason?: ChunkFeedbackReason,
  cut?: PoolCut,
): void {
  if (keys.length === 0) return;
  ctx.post({ type: "chunkResidency", memberId, viewMode, tier, change, keys, reason, ...(cut ? { cut } : {}) });
}

/**
 * Report composite slot keys a pool of `viewMode` and `tier` no longer holds,
 * one message per member and plane. `axis` is the axis a slice pool cuts.
 */
export function postSlotsLost(
  ctx: WorkerCtx,
  viewMode: PoolMode,
  tier: ResidencyTier,
  compositeKeys: Iterable<string>,
  reason: ChunkFeedbackReason,
  axis: SpatialAxis = "z",
): void {
  const groups = new Map<string, { memberId: string; plane: number | null; keys: string[] }>();
  for (const compositeKey of compositeKeys) {
    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const id = `${parsed.memberId}|${parsed.plane ?? ""}`;
    const group = groups.get(id);
    if (group) group.keys.push(parsed.chunkKey);
    else groups.set(id, { memberId: parsed.memberId, plane: parsed.plane, keys: [parsed.chunkKey] });
  }
  for (const { memberId, plane, keys } of groups.values()) {
    postChunkResidency(ctx, memberId, viewMode, tier, "lost", keys, reason, plane === null ? undefined : { axis, plane });
  }
}

/**
 * What one chunk delivery did to a pool, collected while it runs and posted
 * once at the end. `cut` is the plane a slice delivery was cut at, which its
 * held and refused chunks are reported under.
 */
export class ResidencyBatch {
  readonly held: string[] = [];
  /** Composite slot keys the delivery evicted, of any member in the pool. */
  readonly evicted: string[] = [];
  private readonly refused = new Map<ChunkFeedbackReason, string[]>();
  private readonly cut: PoolCut | undefined;

  constructor(cut?: PoolCut) {
    this.cut = cut;
  }

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
  post(ctx: WorkerCtx, memberId: string, viewMode: PoolMode, tier: ResidencyTier): void {
    postChunkResidency(ctx, memberId, viewMode, tier, "held", this.held, undefined, this.cut);
    postSlotsLost(ctx, viewMode, tier, this.evicted, "evicted", this.cut?.axis);
    for (const [reason, keys] of this.refused) {
      postChunkResidency(ctx, memberId, viewMode, tier, "refused", keys, reason, this.cut);
    }
  }
}
