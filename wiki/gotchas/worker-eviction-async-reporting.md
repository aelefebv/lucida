---
created: 2026-04-18
modified: 2026-05-17
---

# Worker Eviction Reporting Is Async

## The footgun

When the [[gpu-residency|GPU worker]] evicts a chunk to make room for a new upload, the main thread doesn't know **immediately**. The worker posts a `chunksEvicted` message; the main thread sees it on the next event-loop turn.

Code that assumes "I just sent it, so it's there" is wrong. The worker may have evicted it by the time you read back. The reconciliation path goes through `chunksEvicted` and the next `wantedSetDelta`.

## Concrete symptoms

- "I uploaded the chunk and the next frame doesn't show it." — the worker may have evicted it, rejected it under atlas policy, or requeued it because the delivery was stale / wrong-slice / missing expected worker state.
- "My chunk count tracking drifts from the worker's reality." — main-thread sent bookkeeping needs to reconcile against `chunksEvicted` and `wantedSetDelta`, not just track sends.
- "Eviction storms cause visible flicker." — the worker evicts, reports, the planner re-requests, the cache re-uploads; under sustained pressure this loop stays warm.

## How the loop closes

1. Worker evicts slot `S` for chunk `K`.
2. Worker posts `chunksEvicted { keys: [K], skipped: [] }` to main thread.
3. Worker includes `K` in next `wantedSetDelta { missing: [K, ...] }` (if still wanted).
4. Main thread parses `memberId` at the upload wire boundary and clears `DeliveryState` chunk sent state. `skipped` chunks are the special case: they are true atlas-policy rejections and also flow into `RejectionTracker`.
5. Next [[chunk-pipeline|tick]]: `cpuCache.getDeliverable()` includes `K` again if it is cached, wanted in the current rebuild generation, not rejected, and not currently marked sent.

## What to do

- **Don't trust send-tracking as residency truth.** The worker's wanted-set is the truth.
- **Don't assume same-tick visibility.** A chunk uploaded this tick may be visible this tick, or not — depends on what the worker did with it.
- **If you add a new path that uploads to the worker**, plumb in the eviction-reconciliation step. Otherwise the new path will deliver chunks that get silently evicted and never re-delivered.
- **In the debug panel**, watch the eviction rate alongside the upload rate. Mismatch hints at thrash.

## The `skipped` field

`chunksEvicted.keys` means "clear optimistic sent state; this chunk can be delivered again if still cached and wanted." That bucket covers real evictions plus stale, wrong-slice, and missing-worker-state upload drops.

`chunksEvicted.skipped` means "atlas-policy rejection" only: the atlas was full and the incoming chunk was farther than the farthest resident slot. This is what suppresses resend churn.

`wantedSetDelta` is authoritative for both chunks and proxies. Missing chunk entries clear chunk sent state; missing proxy entries call `cpuCache.markProxyMissing(...)`, which clears `DeliveryState` proxy sent state so the next `getDeliverable()` pass can re-send the cached proxy.

## Related

- [[gpu-residency]]
- [[worker-protocol]]
- [[chunk-pipeline]]
