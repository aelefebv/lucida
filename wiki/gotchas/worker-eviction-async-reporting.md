---
created: 2026-04-18
modified: 2026-05-17
---

# Worker Eviction Reporting Is Async

## The footgun

When the [[gpu-residency|GPU worker]] evicts a chunk to make room for a new upload, the main thread doesn't know **immediately**. The worker posts a `chunksEvicted` message; the main thread sees it on the next event-loop turn.

Code that assumes "I just sent it, so it's there" is wrong. The worker may have evicted it by the time you read back. The reconciliation path goes through `chunksEvicted` and the next `wantedSetDelta`.

## Concrete symptoms

- "I uploaded the chunk and the next frame doesn't show it." — the worker may have evicted it or skipped it (if the chunk's epoch was stale).
- "My chunk count tracking drifts from the worker's reality." — main-thread bookkeeping (e.g. `proxyDeliveredToWorker`, `sentSet`) needs to reconcile against `chunksEvicted` and `wantedSetDelta`, not just track sends.
- "Eviction storms cause visible flicker." — the worker evicts, reports, the planner re-requests, the cache re-uploads; under sustained pressure this loop stays warm.

## How the loop closes

1. Worker evicts slot `S` for chunk `K`.
2. Worker posts `chunksEvicted { evicted: [K], skipped: [] }` to main thread.
3. Worker includes `K` in next `wantedSetDelta { missing: [K, ...] }` (if still wanted).
4. Main thread `chunksEvicted` handler clears `proxyDeliveredToWorker.delete(K)` and `sentSet.delete(K)` so the next drain can re-send.
5. Next [[chunk-pipeline|tick]]: tick coordinator sees `K` in `workerWantedSet` and not in its delivered tracking, includes `K` in the next drain if it's in [[cpu-cache]].

## What to do

- **Don't trust send-tracking as residency truth.** The worker's wanted-set is the truth.
- **Don't assume same-tick visibility.** A chunk uploaded this tick may be visible this tick, or not — depends on what the worker did with it.
- **If you add a new path that uploads to the worker**, plumb in the eviction-reconciliation step. Otherwise the new path will deliver chunks that get silently evicted and never re-delivered.
- **In the debug panel**, watch the eviction rate alongside the upload rate. Mismatch hints at thrash.

## The `skipped` field

`chunksEvicted` carries both `evicted` (slots actually freed) and `skipped` (uploads the worker dropped because they were stale or already evicted). The `skipped` list often appears during fast viewport changes — multiple uploads for the same chunk arrived; all but one get marked skipped.

## Related

- [[gpu-residency]]
- [[worker-protocol]]
- [[chunk-pipeline]]
