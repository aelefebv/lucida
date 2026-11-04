# Dataset-open reads go through the source cache

Status: Accepted.

## Context

Reading metadata was the largest term in a remote open, 2.8 to 7.7 s on a 21,371-member
object-store collection and several times the time to first render. It was also invisible:
those reads went straight to the object store, outside the cache whose counters observe
source reads. Every open paid the full cost again.

## Decision

An open reads its metadata through the dataset's `CachedStore`, the same cache the chunk path
uses. Making the reads cacheable also makes them counted: the cache reports backend round
trips and cumulative read time, the health payload carries both, and each open logs its own
share (`MetadataReadCost`). A repeat open of a live source fell from 1.4 to 5.9 s to about
0.02 s, with zero backend reads.

- Both open paths build the cache before the import and hand the same instance to the binding.
- Caches are keyed by source identity and held weakly, so two bindings on one URL share a warm
  cache and a closed source frees its budget.
- Metadata and chunk reads share the cache, the single-flight registry, and the counters, but
  not the concurrency cap. Metadata gets 32, matching the import's own fan-out. A metadata
  object is a few kilobytes and an open reads hundreds, so its cost is round trips. A chunk is
  megabytes, so its cost is bandwidth.
- Not-found is remembered for optional metadata and never for chunks. A missing
  `labels/zarr.json` is a fact about the dataset's shape, and those probes were 432 of 652
  reads on the wide fixture. A missing chunk is sparse data that may appear later.
- A not-found on the optional-metadata path is an answer, not a backend error, so label probes
  do not mark healthy datasets as degraded.

## Rejected alternatives

- Instrument the reads where they are. They would still be paid on every open, and would need
  their own counters next to the cache's.
- A reader trait with cached and uncached implementations. The uncached one gets used by
  accident, which is the state being fixed. Import now takes a `CachedStore`, with no uncached
  path.
- Remember not-found inside `get_bytes` for everything. Trades a correctness property, that a
  chunk which appears is seen, for speed, on the path that decides what the viewer draws.
- Share the chunk cap (12 at the time). It doubled cold open on the fixture, 7.1 s to 14.2 s,
  because the import's 32-wide fan-out queued behind it.
- Raise the shared chunk cap instead of splitting. A question about chunk-read pressure with
  its own risks, settled separately in [ADR 0053](0053-fair-share-source-read-admission.md).

## Consequences

- A dataset changed in place is not re-read until its source closes. Cached metadata and
  remembered absences live as long as the source cache, extending the immutable-source
  assumption from chunks to metadata.
- Metadata and chunks share one byte budget, so heavy chunk streaming can evict an open's
  metadata and the next open pays again.
- Two datasets on one source report one cache's numbers, and a per-open cost is exact only
  when nothing else reads that source at the same time.
- The reported read time is a sum of overlapping per-read latencies, including permit wait,
  and exceeds wall time whenever reads run concurrently.
- A source closed and reopened pays again. That is the weak registry's memory trade.
