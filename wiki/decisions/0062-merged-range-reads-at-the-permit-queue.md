---
type: Decision
title: "Merged range reads at the permit queue"
description: "Range reads of one object that are waiting for a source-read permit together reach the backend as one request when their byte ranges are contiguous; the queue is the window, nothing merges across a gap, and the carried reads are accounted as followers."
tags: [lucida, decision]
source_path: wiki/decisions/0062-merged-range-reads-at-the-permit-queue.md
created: 2026-09-04
modified: 2026-09-04
---

# Merged range reads at the permit queue

Status: Accepted (spec #990, ticket #1012). Measured in
`docs/research/merged-range-reads.md`.

Context: the sharded-array spec (#990) keeps the viewer addressing inner
chunks, so a pan across a sharded dataset asks for neighbouring inner chunks of
one shard as separate range reads. The link to a remote object store is bound
by requests per second, not bytes ([ADR 0053](0053-fair-share-source-read-admission.md),
`docs/research/source-read-concurrency.md`), so fewer, larger reads are the
lever that remains. The spec allowed those reads to be merged as an optional
second phase; this note records how, and how far.

Justified by [Runs Anywhere, Open by Default](../principles/runs-anywhere-and-open.md):
data where it lives, at full scale, without the object layout dictating how
many round trips a view costs, and without a fast link's trade being forced
on a slow one.

## Decision

**The permit queue is the merge window.** Every chunk read queues for a
source-read permit before it touches the backend. Range reads of one object
that are waiting there together arrived together, one scheduling window's
worth of inner chunks. When one of them is admitted it takes, on its one
permit, every queued range read of the same object whose bytes touch its own,
and issues the group as one request. Nothing else defines the window: no
timer, no batch size, no knowledge of shards in the cache.

**Nothing merges across a gap.** Two ranges join only when one starts at or
before the other ends. Bytes nobody asked for are never fetched.

**Carried reads are followers.** A read carried in a neighbour's request takes
no permit and makes no round trip. Its timing row reports a coalesced wait
attributed to the label of the read that made the trip, so a sum over the
backend column still counts each round trip once ([ADR 0050](0050-server-timings-reach-the-monitor.md)).
Each range still lands in its own cache entry, copied out of the fetch so an
entry owns exactly the bytes it is charged for, and a later read of any one of
them is a hit.

## Rationale

**Why the permit queue and not a timer.** A timed window trades latency for
grouping on every read, including the ones with no neighbour, and its length
is a constant nobody can defend. The queue costs nothing when the link is
idle, because an unqueued read goes straight out alone, and it groups exactly
when the link is the constraint, which is when a request saved is time saved. It also
needs no new state: the reads are already waiting there.

**Why the cache and not the shard index cache.** The shard index cache sees
one inner chunk at a time and knows nothing about permits; it would have to
invent a window. The cache sees every range read of every object and already owns the
single flight, the permit, and the entry, the three things a merge has to
keep correct. Putting the merge beside them keeps the invariants in one place.

**Why no gap, when the transport allows one.** object_store's multi-range
read merges ranges up to 1 MiB apart into one fetch, and the ticket asked
whether to route reads through that. Measured on a sharded dataset behind a
request-bound stand-in, that gap removed 30 % of requests and moved 3.2× the
bytes: with inner chunks of a few kilobytes and shards of a few hundred, any
two wanted chunks of a shard were within the gap, so a merged request became
the span of the shard between them. That is most of the download sharding
exists to avoid, fetched and then dropped, because the cache has no key to
file the bytes between under. Contiguous-only merging removed 16 % of requests
and moved the same bytes as no merging at all. The extra 14 points are a bet
that bandwidth is free, and on the links lucida is meant to run over it is
not. A contiguous group is also one fetch under any gap the transport merges
on, so one permit is always one request without the two thresholds having to
agree.

**Why the reads are followers and not a new row family.** The monitor's
arithmetic rests on one rule: a row that made a round trip reports it, and a
row that waited on someone else's reports the wait. A carried read is the
second kind. Giving it a third vocabulary would add a phase for the same
truth.

## Alternatives rejected

- **Merge in the browser**, by sending one wire request for a run of inner
  chunks. That changes the wire protocol and the planner, which the spec
  keeps out of scope, and the browser cannot see which inner chunks are
  byte-adjacent. Only the shard index knows.
- **Compute the merged span in the cache and issue one bounded read.** It
  duplicates what object_store's multi-range read already does, and a span
  with gaps reads bytes into the cache with no key to file them under.
- **Merge the whole shard on first touch.** Simple and wrong: a shard of 64
  inner chunks is a whole-object download for a view that wanted four of
  them, which is the cost sharding exists to avoid. The 1 MiB gap was this
  by another route.

## Consequences

- Merging happens only under contention. A single client whose in-flight
  window fits inside the server's permit cap queues nothing and merges
  nothing; two clients, or one client past the cap, do. The measured client
  ran past the cap and merged about one read in six.
- A pan fills a shard from the inside out, so the contiguous groups it forms
  are runs within one row of inner chunks. A shard wholly inside the view
  is contiguous end to end and can become one request when its reads queue
  together.
- The window, not the rule, bounds the gain. The measurement found that
  letting a read yield once between registering and claiming its group,
  so that a socket burst's worth of requests register before the first of
  them claims, doubled the requests removed at the same bytes. It is not adopted
  here because it is a scheduler-timing hint rather than a defined window;
  the principled form is the handler dispatching a socket burst as a group,
  which is the next lever and a decision of its own.
- Suffix reads (a shard index at the end of its object) and whole-object
  reads are never merged: a suffix has no known offset, and objects are
  distinct requests by definition.
