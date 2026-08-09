---
type: Decision
title: "Dataset-open reads go through the source cache"
description: "Metadata reads performed while opening a dataset run through the same CachedStore as chunk reads — so they are cached, coalesced and counted — but under their own concurrency cap, and with absence remembered only for optional metadata."
tags: [lucida, decision]
source_path: wiki/decisions/0044-dataset-open-reads-through-the-source-cache.md
created: 2026-08-09
modified: 2026-08-09
---

# Dataset-open reads go through the source cache

Status: Accepted (issue #902).

## Decision

The metadata objects an open reads are fetched through the dataset's `CachedStore`, the
same cache the chunk path uses, instead of straight off the `ObjectStore`. Four things
follow from that, and each was a choice:

1. **The cache is resolved before the import, not after it.** Both open paths
   (`lucida-server::dataset_open` and `lucida-server::binding_restore`) build the cache,
   import through it, and hand the same `Arc` to the binding.
2. **One cache per source, shared while it is in use, released when it is not.**
   `CachedStore::shared_for_source` keys live caches by source identity and holds them
   weakly, so two bindings on one URL share a warm cache and a closed source frees its
   budget.
3. **Metadata reads and chunk reads have separate concurrency caps.** They share the
   cache, the single-flight registry and the counters, but not the semaphore.
4. **Absence is remembered for optional metadata, never for chunks.**
   `get_optional_metadata_bytes` memoizes not-found; `get_bytes` keeps asking.

The per-open cost is reported by shipped instrumentation: `CacheStats` gained a backend
round-trip count and cumulative read time, `DatasetSourceCacheStats` carries both to the
health payload the CLI and the debug panel already render, and each open logs its own
slice of those counters (`MetadataReadCost`).

## Why

Open was the largest single term in a remote open — measured at 2.8–7.7 s against a
21,371-member GCS collection, several times the time to first render — and it was the
one term no instrument in the codebase could see, because it ran outside the path the
cache's telemetry observes. Anyone tuning open performance was working blind against the
biggest number. Routing the reads through the cache fixes both halves at once: the same
change that makes them cacheable makes them counted.

**Separate caps** because the two read classes are unlike. A metadata object is a few
kilobytes of JSON and an open reads hundreds back to back, so its cost is round trips; a
chunk is megabytes, so its cost is bandwidth and sockets. Sharing the chunk cap (12) was
measured, not theorized: it roughly doubled cold-open wall time on the 21k-member fixture
(7.1 s → 14.2 s) because the import pipeline's own 32-wide fan-out queued behind it. The
metadata cap matches that fan-out.

**Absence only for metadata** because the two absences mean different things. A missing
`labels/zarr.json` is a fact about the dataset's shape and re-probing it every open is
pure cost — on a wide collection those 404s were 432 of the fixture's 652 reads. A
missing chunk is legitimate sparse data, and remembering it would make a chunk that
appears later render as empty.

**Weak registry** because the alternative is a memory decision disguised as a cache
decision: holding sources strongly would pin a half-gigabyte budget per URL ever opened,
for the life of the process.

## Considered options

**Instrument the reads where they are, leaving the bypass.** The issue offered this as an
acceptable outcome. Rejected because the reads are re-paid on every open, and the
instrumentation would then need its own counters, its own aggregation, and its own
reason to exist next to the cache's.

**A reader trait with a cached and an uncached implementation.** Would have kept
`import_dataset` callable with a bare `ObjectStore` and spared the test-call churn.
Rejected: two implementations of one seam means the uncached one gets used by accident,
which is exactly the state this ADR is fixing. The import now takes a `CachedStore` and
there is no uncached path to fall back into.

**Negative caching inside `get_bytes` for everything.** Simpler — one method, one rule —
and it would have made repeated sparse-chunk 404s cheap too. Rejected because it trades a
correctness property (a chunk that appears is seen) for a performance one, on the path
that decides what the viewer draws.

**Raising the shared source-read cap instead of splitting it.** The remote measurement in
`docs/research/remote-rates.md` §3 shows the cap pinned at its ceiling with permit wait
rivalling network first byte, so raising it is a live question — but it is a question
about chunk-read pressure on a live viewer, with its own answer and its own risks. It
should not be settled as a side effect of fixing open.

## Consequences

- **Repeat opens of a live source cost nothing.** Measured on the 21,371-member GCS
  fixture, alternating before/after runs on one machine (remote latency swings by ~3x
  between sessions, so only interleaved runs compare): cold open 1.89–2.01 s before vs
  1.85–2.01 s after — parity — and repeat open **1.42–1.43 s before vs 0.021–0.023 s
  after**, 652 backend reads before and 0 after. A slower-network sample the same day put
  the repeat open at 5.74 s before vs 0.019 s after. End to end through the DPR2 harness
  (`docs/research/remote-rates-harness/`, on branch `research/remote-rates`) the cold open
  measured 2.43 s before vs 2.52 s after.
- **Two datasets on one source report one cache's numbers.** Health for each of them
  reflects the shared source cache, because that is what they are both reading.
- **Import is no longer callable without a cache.** Every caller — server, Python
  binding, tests — wraps its store first.
- **The reported read time is a sum, not a duration.** Reads overlap; `source_read_millis`
  adds per-read latencies (including permit wait) and will exceed wall time whenever
  concurrency is above one.
- **A closed-and-reopened source pays again.** The weak registry releases the cache when
  the last binding drops it; that is the memory trade, taken deliberately.
