/**
 * Owns four delivery-tracking maps (chunk-sent, chunk-rejected, wid →
 * entityId, proxy-delivered) behind one intent-named API. The implicit
 * lifetime invariants — clear sent on cold-state rebuild, drop rejected
 * on worker eviction — are encoded as method contracts here.
 */

import type { MissingProxy } from "../../../renderer/workerProtocol.ts";
import { proxyKeyFromMissing } from "../proxyKeys.ts";

export class DeliveryTracker {
  private chunkSent = new Map<string, Set<string>>();

  /**
   * Worker-reported "skipped" (atlas full + incoming farther than the
   * farthest existing slot). The resend pass consults this so it doesn't
   * re-attempt too-far chunks every tick.
   */
  private chunkRejected = new Map<string, Set<string>>();

  /**
   * Reverse lookup so `markChunkEvicted` can resolve `cpuCache.markRejected`
   * from worker reports that only carry workerMemberId. The id is composite
   * (`imageId:chN`) in multi-channel mode and may differ from entityId
   * entirely (plate fields).
   */
  private widToEntityId = new Map<string, string>();

  /**
   * Composite key `${datasetId}|${entityId}|${proxyKind}|${t}|${c}`.
   * Survives cold state because worker proxy pools persist across atlas
   * rebuilds; cleared per-entry by `clearProxyDelivered` on `MissingProxy`.
   */
  private proxyDelivered = new Set<string>();

  // ─── Chunk side ──────────────────────────────────────────────────────

  /**
   * Also stamps the wid → entityId reverse lookup so a later
   * `markChunkEvicted` can resolve the entityId for `cpuCache.markRejected`.
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

  wasChunkSent(workerMemberId: string, chunkKey: string): boolean {
    return this.chunkSent.get(workerMemberId)?.has(chunkKey) ?? false;
  }

  /**
   * Pre-populate the wid → entityId reverse lookup at plan time so an
   * eviction report that arrives before any chunk has been sent can
   * still resolve `cpuCache.markRejected(entityId, ...)`.
   */
  recordMember(workerMemberId: string, entityId: string): void {
    this.widToEntityId.set(workerMemberId, entityId);
  }

  /**
   * Process a worker eviction report.
   *
   * - `evicted` chunks were displaced by closer arrivals. Removed from
   *   sent AND from rejected — acceptance proves deliverable.
   * - `skipped` chunks never made it in (atlas full + too far). Removed
   *   from sent and added to rejected.
   *
   * Returned `rejectedNew` is forwarded to `cpuCache.markRejected` so
   * the cache stops re-fetching under eviction churn.
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

  wasChunkRejected(workerMemberId: string, chunkKey: string): boolean {
    return this.chunkRejected.get(workerMemberId)?.has(chunkKey) ?? false;
  }

  entityIdFor(workerMemberId: string): string | null {
    return this.widToEntityId.get(workerMemberId) ?? null;
  }

  // ─── Proxy side ──────────────────────────────────────────────────────

  markProxyDelivered(key: string): void {
    this.proxyDelivered.add(key);
  }

  wasProxyDelivered(key: string): boolean {
    return this.proxyDelivered.has(key);
  }

  /** Caller `handleWantedSetDelta` so the next tick's resend pass picks it up via `getCachedProxy`. */
  clearProxyDelivered(missing: MissingProxy): void {
    this.proxyDelivered.delete(proxyKeyFromMissing(missing));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Called on every cold-state emit. Does NOT clear proxy delivery:
   * proxy pools persist across atlas rebuilds (created lazily, destroyed
   * only on dataset removal). Proxies are cleared per-entry via
   * `clearProxyDelivered` on wantedSetDelta.
   */
  onColdStateRebuild(): void {
    this.chunkSent.clear();
    this.chunkRejected.clear();
    this.widToEntityId.clear();
  }

  clearMember(workerMemberId: string): void {
    this.chunkSent.delete(workerMemberId);
    this.chunkRejected.delete(workerMemberId);
    this.widToEntityId.delete(workerMemberId);
  }

  /**
   * Best-effort prefix-delete of proxy-delivered entries for a dataset.
   * Benign when `datasetId` doesn't match (e.g. a workerMemberId): no
   * key starts with that prefix, the loop is a no-op.
   */
  clearDataset(datasetId: string): void {
    const prefix = `${datasetId}|`;
    for (const k of this.proxyDelivered) {
      if (k.startsWith(prefix)) this.proxyDelivered.delete(k);
    }
  }

  trackedKeys(): IterableIterator<string> {
    return this.chunkSent.keys();
  }

  /** @internal Returns the live Set; callers must not mutate. */
  getProxyDeliveredKeys(): Set<string> {
    return this.proxyDelivered;
  }
}
