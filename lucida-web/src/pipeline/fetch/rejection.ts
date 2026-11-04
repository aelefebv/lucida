/**
 * Chunks the GPU worker reported as `skipped` (atlas full and the incoming
 * chunk is farther than every resident slot). `submit()` skips them without
 * refreshing `lastSeenTick`, so active-detail eviction can sweep the cached
 * copy instead of spending budget on residency that won't reach the GPU.
 * The orchestrator calls {@link clear} on every cold-state rebuild, since
 * a shifted camera or active set may make them fit.
 */
export class RejectionTracker {
  private rejectedKeys = new Map<string, Set<string>>();

  /**
   * Mark a (entityId, chunkKey) as rejected. Returns `true` if it was
   * newly added so the caller knows whether to abort an in-flight
   * fetch for the same key. Returns `false` if it was already in the
   * set (the caller already aborted on the first call).
   */
  mark(entityId: string, chunkKey: string): boolean {
    let set = this.rejectedKeys.get(entityId);
    if (!set) {
      set = new Set();
      this.rejectedKeys.set(entityId, set);
    }
    if (set.has(chunkKey)) return false;
    set.add(chunkKey);
    return true;
  }

  /**
   * True if the key is in the rejected set. Used by `submit()`'s
   * dedup ladder to skip the chunk without refreshing `lastSeenTick`.
   */
  has(entityId: string, chunkKey: string): boolean {
    return this.rejectedKeys.get(entityId)?.has(chunkKey) ?? false;
  }

  /**
   * Drop every rejection. Called by the orchestrator on every
   * cold-state rebuild and by `CpuCache.reset()`.
   */
  clear(): void {
    this.rejectedKeys.clear();
  }
}
