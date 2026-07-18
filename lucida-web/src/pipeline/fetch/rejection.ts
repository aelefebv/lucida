/**
 * Rejection tracker.
 *
 * The GPU worker reports `skipped` chunks back to the orchestrator
 * ("atlas full + incoming farther than farthest existing slot"). The
 * CPU cache records those (datasetId, imageId, tier, chunkKey) identities so subsequent
 * `submit()` ticks skip them: no fetch enqueue, no `lastSeenTick`
 * refresh on a cached copy. Skipping the refresh lets active-detail
 * eviction sweep the cached-but-rejected entry out instead of burning
 * budget on residency that won't reach the GPU.
 *
 * The orchestrator owns the lifecycle: it calls {@link clear} on every
 * cold-state rebuild (camera or active set may have shifted enough
 * that previously-too-far chunks now fit).
 *
 * Pure: no I/O, no clocks. Just a per-image Set of rejected
 * chunk keys.
 */
export class RejectionTracker {
  private rejectedKeys = new Map<string, Map<string, Map<string, Set<string>>>>();

  /**
   * Mark a (datasetId, imageId, tier, chunkKey) as rejected. Returns `true` if it was
   * newly added so the caller knows whether to abort an in-flight
   * fetch for the same key. Returns `false` if it was already in the
   * set (the caller already aborted on the first call).
   */
  mark(datasetId: string, imageId: string, tier: "detail" | "coarse", chunkKey: string): boolean {
    let byImage = this.rejectedKeys.get(datasetId);
    if (!byImage) {
      byImage = new Map();
      this.rejectedKeys.set(datasetId, byImage);
    }
    let byTier = byImage.get(imageId);
    if (!byTier) {
      byTier = new Map();
      byImage.set(imageId, byTier);
    }
    let set = byTier.get(tier);
    if (!set) {
      set = new Set();
      byTier.set(tier, set);
    }
    if (set.has(chunkKey)) return false;
    set.add(chunkKey);
    return true;
  }

  /**
   * True if the key is in the rejected set. Used by `submit()`'s
   * dedup ladder to skip the chunk without refreshing `lastSeenTick`.
   */
  has(datasetId: string, imageId: string, tier: "detail" | "coarse", chunkKey: string): boolean {
    return this.rejectedKeys.get(datasetId)?.get(imageId)?.get(tier)?.has(chunkKey) ?? false;
  }

  clearDataset(datasetId: string): void {
    this.rejectedKeys.delete(datasetId);
  }

  clearImage(datasetId: string, imageId: string): void {
    const byImage = this.rejectedKeys.get(datasetId);
    if (!byImage) return;
    byImage.delete(imageId);
    if (byImage.size === 0) this.rejectedKeys.delete(datasetId);
  }

  /**
   * Drop every rejection. Called by the orchestrator on every
   * cold-state rebuild and by `CpuCache.reset()`.
   */
  clear(): void {
    this.rejectedKeys.clear();
  }
}
