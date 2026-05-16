/**
 * Owns the four delivery-tracking maps the orchestrator used to manage as
 * scattered private fields. Consolidates `deliverySentToWorker`,
 * `deliveryRejectedByWorker`, `widToEntityId`, and `proxyDeliveredToWorker`
 * behind one intent-named API so the implicit lifetime invariants
 * ("clear sent on every cold-state rebuild", "drop rejected on worker
 * eviction") become explicit method contracts.
 *
 * See `wiki/outputs/dechaos-upload-2026-05-15/02-boundary-scan.md` Seam F
 * for the design rationale.
 */

import type { MissingProxy } from "../../../renderer/workerProtocol.ts";
import { proxyKeyFromMissing } from "../proxyKeys.ts";

export class DeliveryTracker {
  /** workerMemberId → set of delivered chunkKeys. */
  private chunkSent = new Map<string, Set<string>>();

  /**
   * workerMemberId → set of chunkKeys the worker reported as `skipped`
   * (atlas full + incoming farther than the farthest existing slot).
   * The resend pass consults this set so it doesn't re-attempt
   * too-far chunks every tick.
   */
  private chunkRejected = new Map<string, Set<string>>();

  /**
   * Reverse lookup from workerMemberId → entityId. Needed by the
   * `markChunkEvicted` rejection path so the caller can resolve
   * `cpuCache.markRejected(entityId, key)` from a worker report that
   * only carries workerMemberId. workerMemberId is composite for
   * multi-channel (`imageId:chN`) and may differ from entityId entirely
   * (plate fields).
   */
  private widToEntityId = new Map<string, string>();

  /**
   * Tracks proxies already uploaded to the GPU worker. Composite key:
   * `${datasetId}|${entityId}|${proxyKind}|${t}|${c}`. Survives cold
   * state because worker proxy pools persist across atlas rebuilds;
   * cleared per-entry by `clearProxyDelivered` when the worker reports
   * a `MissingProxy`.
   */
  private proxyDelivered = new Set<string>();

  // ─── Chunk side ──────────────────────────────────────────────────────

  /**
   * Record that the given chunk was sent to the worker. Also stamps the
   * wid → entityId reverse lookup so a later `markChunkEvicted` for the
   * same workerMemberId can resolve the entityId for `cpuCache.markRejected`.
   */
  markChunkSent(workerMemberId: string, entityId: string, chunkKey: string): void {
    let s = this.chunkSent.get(workerMemberId);
    if (!s) {
      s = new Set();
      this.chunkSent.set(workerMemberId, s);
    }
    s.add(chunkKey);
    this.widToEntityId.set(workerMemberId, entityId);
  }

  /** Returns true if `markChunkSent` was called for the given (member, key). */
  wasChunkSent(workerMemberId: string, chunkKey: string): boolean {
    return this.chunkSent.get(workerMemberId)?.has(chunkKey) ?? false;
  }

  /**
   * Pre-populate the wid → entityId reverse lookup at plan time so
   * an eviction report that arrives before any chunk has been sent
   * can still resolve `cpuCache.markRejected(entityId, ...)`. Called
   * from the planner's per-dataset request loop.
   */
  recordMember(workerMemberId: string, entityId: string): void {
    this.widToEntityId.set(workerMemberId, entityId);
  }

  /**
   * Process a worker eviction report.
   *
   * - `evicted` chunks were in the atlas and got displaced by closer
   *   arrivals. They're removed from the sent set (re-eligible for upload)
   *   AND removed from the rejected set (acceptance proves deliverable).
   * - `skipped` chunks never made it into the atlas (full + too far).
   *   They're removed from sent and added to rejected.
   *
   * Returns the chunks that were newly added to the rejected set; the
   * caller forwards them to `cpuCache.markRejected` so the cache stops
   * re-fetching under eviction churn. Returned only for skipped chunks
   * with a known entityId; the tracker itself never depends on CpuCache.
   */
  markChunkEvicted(
    workerMemberId: string,
    evicted: string[],
    skipped: string[],
  ): { rejectedNew: Array<{ entityId: string; chunkKey: string }> } {
    const sentSet = this.chunkSent.get(workerMemberId);
    if (sentSet) {
      for (const k of evicted) sentSet.delete(k);
      for (const k of skipped) sentSet.delete(k);
    }

    if (evicted.length > 0) {
      const rej = this.chunkRejected.get(workerMemberId);
      if (rej) {
        for (const k of evicted) rej.delete(k);
      }
    }

    const rejectedNew: Array<{ entityId: string; chunkKey: string }> = [];
    if (skipped.length > 0) {
      let rej = this.chunkRejected.get(workerMemberId);
      if (!rej) {
        rej = new Set();
        this.chunkRejected.set(workerMemberId, rej);
      }
      const entityId = this.widToEntityId.get(workerMemberId);
      for (const k of skipped) {
        rej.add(k);
        if (entityId) rejectedNew.push({ entityId, chunkKey: k });
      }
    }
    return { rejectedNew };
  }

  /** Returns true if the worker has reported this chunk as `skipped`. */
  wasChunkRejected(workerMemberId: string, chunkKey: string): boolean {
    return this.chunkRejected.get(workerMemberId)?.has(chunkKey) ?? false;
  }

  /** Returns the entityId for a known workerMemberId, or null. */
  entityIdFor(workerMemberId: string): string | null {
    return this.widToEntityId.get(workerMemberId) ?? null;
  }

  // ─── Proxy side ──────────────────────────────────────────────────────

  /** Record that a proxy with the given composite key was delivered. */
  markProxyDelivered(key: string): void {
    this.proxyDelivered.add(key);
  }

  /** Returns true if `markProxyDelivered` has been called for this key. */
  wasProxyDelivered(key: string): boolean {
    return this.proxyDelivered.has(key);
  }

  /**
   * Drop the proxy-delivered entry for a worker-reported missing proxy.
   * Called from `handleWantedSetDelta` so the next tick's resend pass
   * picks the proxy up via `getCachedProxy`.
   */
  clearProxyDelivered(missing: MissingProxy): void {
    this.proxyDelivered.delete(proxyKeyFromMissing(missing));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Called whenever the worker rebuilds atlases (every cold-state emit).
   * Clears sent / rejected / widToEntityId for ALL members — the atlas
   * state is global per dataset and the rebuild loop touches every
   * dataset's tracking.
   *
   * Does NOT clear proxy delivery: worker proxy pools persist across
   * cold-state rebuilds (they're created lazily and only destroyed on
   * dataset removal). Re-sending proxies on every full plan would
   * upload-spam them on every view-epoch bump. Proxies are cleared
   * per-entry via {@link clearProxyDelivered} on wantedSetDelta.
   */
  onColdStateRebuild(): void {
    this.chunkSent.clear();
    this.chunkRejected.clear();
    this.widToEntityId.clear();
  }

  /** Clear all chunk-side tracking for a single workerMemberId. */
  clearMember(workerMemberId: string): void {
    this.chunkSent.delete(workerMemberId);
    this.chunkRejected.delete(workerMemberId);
    this.widToEntityId.delete(workerMemberId);
  }

  /**
   * Best-effort clear of proxy-delivered entries scoped to a dataset id.
   * Proxy keys start with `${datasetId}|`, so a prefix match catches
   * every entry that belongs to the dataset. Benign when the supplied
   * id doesn't match the dataset shape (e.g. a workerMemberId): no
   * key starts with that prefix, the loop is a no-op.
   */
  clearDataset(datasetId: string): void {
    const prefix = `${datasetId}|`;
    for (const k of this.proxyDelivered) {
      if (k.startsWith(prefix)) this.proxyDelivered.delete(k);
    }
  }

  /**
   * Iterator over every tracked workerMemberId. Used by
   * `RenderLoop.collectMemberIds` and the multi-channel transition
   * cleanup path.
   */
  trackedKeys(): IterableIterator<string> {
    return this.chunkSent.keys();
  }

  /**
   * Test-only accessor for the proxy-delivered set. Returns the live
   * Set; callers must not mutate.
   * @internal
   */
  getProxyDeliveredKeys(): Set<string> {
    return this.proxyDelivered;
  }
}
