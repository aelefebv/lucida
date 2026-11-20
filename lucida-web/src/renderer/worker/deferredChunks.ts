/**
 * Chunks a full pool put off while a gesture ran, because placing them would
 * have grown it or taken the slot of a chunk a view wants. A growth copies
 * the pool into a larger texture, and the frames queued behind the copy wait
 * for it.
 *
 * The worker answers a put-off chunk only once the gesture ends, refusing it
 * as `deferred`. Until then the page counts it as sent, so the view waits on
 * it rather than settling without it, and sends it again on the refusal, to
 * a pool free to grow by then.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { WorkerCtx } from "../workerContext.ts";
import type { PoolMode } from "../workerProtocol.ts";
import type { PoolCut } from "../slicePlane.ts";
import { postChunkResidency } from "../chunkUploadFeedback.ts";
import { makeCompositeKey, makeSliceSlotKey } from "../chunkKeys.ts";

interface DeferredGroup {
  memberId: string;
  mode: PoolMode;
  tier: ResidencyTier;
  cut: PoolCut | undefined;
  /** The pool the chunks were put off from. */
  poolKey: string;
  keys: Set<string>;
}

export class DeferredChunks {
  private readonly groups = new Map<string, DeferredGroup>();

  add(
    poolKey: string,
    memberId: string,
    mode: PoolMode,
    tier: ResidencyTier,
    chunkKey: string,
    cut?: PoolCut,
  ): void {
    const id = `${poolKey}|${memberId}|${tier}|${cut ? `${cut.axis}${cut.plane}` : ""}`;
    let group = this.groups.get(id);
    if (!group) {
      group = { memberId, mode, tier, cut, poolKey, keys: new Set() };
      this.groups.set(id, group);
    }
    group.keys.add(chunkKey);
  }

  /**
   * Answer every chunk put off, as `deferred`, except one its pool holds by
   * now: a lost device has the page send everything again, and that copy
   * may have landed.
   */
  release(ctx: WorkerCtx): void {
    for (const group of this.groups.values()) {
      const keys = [...group.keys].filter((key) => !holds(ctx, group, key));
      postChunkResidency(ctx, group.memberId, group.mode, group.tier, "refused", keys, "deferred", group.cut);
    }
    this.groups.clear();
  }
}

function holds(ctx: WorkerCtx, group: DeferredGroup, chunkKey: string): boolean {
  if (group.mode === "volume") {
    return ctx.state.volumeAtlases.get(group.poolKey)?.slots.has(makeCompositeKey(group.memberId, chunkKey)) ?? false;
  }
  const plane = group.cut?.plane;
  return plane !== undefined &&
    (ctx.state.sliceAtlases.get(group.poolKey)?.slots.has(makeSliceSlotKey(group.memberId, chunkKey, plane)) ?? false);
}
