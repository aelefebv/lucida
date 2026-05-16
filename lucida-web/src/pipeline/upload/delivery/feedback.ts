/**
 * WorkerFeedback — owns the worker → main-thread feedback handlers.
 *
 * The GPU worker reports two things back to the orchestrator:
 *
 * - `chunksEvicted` — chunks the atlas displaced (or refused: the
 *   incoming chunk was farther than the farthest existing slot when
 *   the atlas was full).
 * - `wantedSetDelta` — items the worker is missing. After Slice 3 the
 *   chunk branch is dead state (there is no per-chunk wanted-set on
 *   the orchestrator); only the proxy branch is meaningful.
 *
 * Both handlers were previously methods on `Orchestrator`. They are
 * extracted here so the orchestrator's worker-feedback surface is a
 * pair of one-line delegations, and so the handlers can be tested
 * directly against `DeliveryTracker` without spinning up the full
 * orchestrator.
 *
 * See `wiki/outputs/dechaos-upload-2026-05-15/02-boundary-scan.md`
 * Seam G for the design rationale.
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
   * Process a worker eviction report.
   *
   * - `evicted` chunks were in the atlas and got displaced by closer
   *   arrivals. They're re-eligible for upload under the same plan.
   * - `skipped` chunks never made it into the atlas (full + incoming
   *   farther than the farthest existing slot). They're recorded as
   *   rejected on the tracker and — for skipped chunks whose
   *   `memberId` resolves to a known entityId — forwarded to
   *   `cpuCache.markRejected` so the cache stops re-fetching them
   *   under eviction churn.
   *
   * The cpuCache parameter is kept here because the orchestrator owns
   * no cpuCache reference today (it gets one through `ctx.cpuCache` in
   * tick methods). After the Slice 10 Uploader extraction the
   * Uploader could hold its own and the parameter can drop.
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
   * Process a wanted-set delta. After Slice 3, only the proxy branch
   * is meaningful: when the worker reports a missing proxy, clear the
   * proxy-delivered tracking so the next tick's resend pass picks it
   * up via `getCachedProxy`. Chunk entries in the delta are
   * intentionally ignored — Slice 3 deleted the dead
   * `workerWantedSet` field; see `CHUNK_PIPELINE.md` and the dechaos
   * outputs for rationale.
   *
   * Proxy resends must be tracked (not just chunk resends): the
   * cache-hit short-circuit means we can't rely on `submit()`
   * re-emission to recover from a worker-side eviction.
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
