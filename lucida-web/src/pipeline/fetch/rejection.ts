/**
 * Rejection tracker.
 *
 * The GPU worker reports `skipped` chunks back to the orchestrator
 * ("atlas full + incoming farther than farthest existing slot"). The
 * CPU cache records those (entityId, chunkKey) pairs so subsequent
 * `submit()` ticks skip them: no fetch enqueue, no `lastSeenTick`
 * refresh on a cached copy. Skipping the refresh lets active-detail
 * eviction sweep the cached-but-rejected entry out instead of burning
 * budget on residency that won't reach the GPU.
 *
 * The orchestrator owns the lifecycle: it calls {@link clear} on every
 * cold-state rebuild (camera or active set may have shifted enough
 * that previously-too-far chunks now fit).
 *
 * Pure: no I/O, no clocks. Just a per-entity Set of rejected
 * chunk keys.
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
