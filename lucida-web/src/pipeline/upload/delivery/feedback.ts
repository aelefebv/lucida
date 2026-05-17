/**
 * WorkerFeedback — owns the worker → main-thread feedback handlers
 * (`chunksEvicted`, `wantedSetDelta`).
 */

import type { CpuCache } from "../../fetch/index.ts";
import type {
  MissingChunk,
  MissingProxy,
} from "../../../renderer/workerProtocol.ts";
import type { DeliveryTracker } from "./tracker.ts";

export class WorkerFeedback {
  private readonly tracker: DeliveryTracker;

  constructor(tracker: DeliveryTracker) {
    this.tracker = tracker;
  }

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
  ): void {
    const { rejectedNew } = this.tracker.markChunkEvicted(
      memberId, evicted, skipped,
    );
    for (const { entityId, chunkKey } of rejectedNew) {
      cpuCache.markRejected(entityId, chunkKey);
    }
  }

  /**
   * Only the proxy branch is meaningful — the orchestrator has no
   * per-chunk wanted-set (see `CHUNK_PIPELINE.md`). Proxy resends MUST
   * be tracked: the cache-hit short-circuit means we can't rely on
   * `submit()` re-emission to recover from a worker-side eviction.
   */
  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
  ): void {
    for (const entry of missing) {
      if (entry.kind === "proxy") {
        this.tracker.clearProxyDelivered(entry);
      }
    }
  }
}
