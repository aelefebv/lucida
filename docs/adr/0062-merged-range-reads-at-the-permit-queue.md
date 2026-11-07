# Merged range reads at the permit queue

Status: Accepted.

## Context

The sharded-array design keeps the viewer addressing inner chunks, so a pan
across a sharded dataset asks for neighbouring inner chunks of one shard as
separate range reads. On a remote object store each request pays a round trip,
and the source-read cap already sits at the link's knee
([ADR 0053](0053-fair-share-source-read-admission.md)), so fewer requests for
the same bytes is the lever left.

## Decision

The permit queue is the merge window. Every chunk read queues for a source-read
permit. When a range read is admitted, it takes on its one permit every queued
range read of the same object whose bytes touch its own, and issues the group as
one request. There is no timer, no batch size, and no shard knowledge in the
cache. The merge lives in `lucida-store/src/cache.rs`, beside the single flight,
the permit, and the cache entry, the three things it has to keep correct.

Nothing merges across a gap. Two ranges join only when one starts at or before
the other ends, so no byte nobody asked for is fetched.

A carried read is a follower. It takes no permit, and its timing row reports a
coalesced wait attributed to the read that made the trip, so a sum over the
backend column still counts each round trip once
([ADR 0050](0050-server-timings-reach-the-monitor.md)). Each range lands in its
own cache entry, copied out so the entry owns exactly the bytes it is charged
for. Suffix reads and whole-object reads never merge.

Against a request-bound stand-in, contiguous merging cut a cold open plus pan
from 336 requests to 281 at identical bytes. object_store's 1 MiB gap cut 30 %
but moved 3.2× the bytes.

## Rejected alternatives

- A timed window. It adds latency to every read, including those with no
  neighbour, and its length is a constant nobody can defend. The queue costs
  nothing when the link is idle and groups exactly when the link is the
  constraint.
- Merge in the shard index cache. It sees one inner chunk at a time and knows
  nothing about permits, so it would have to invent a window.
- Route reads through object_store's multi-range gap. With inner chunks of a few
  kilobytes in shards of a few hundred, any two wanted chunks of a shard fall
  inside 1 MiB, so a merge downloads the span between them and drops it, since
  the cache has no key to file those bytes under. That trade assumes bandwidth
  is free. A contiguous group is one fetch under any gap, so one permit stays
  one request.
- Merge in the browser. It changes the wire protocol and the planner, and the
  browser cannot see which inner chunks are byte-adjacent.
- Compute a merged span and issue one bounded read. It duplicates object_store's
  multi-range read, and a span with gaps reads bytes the cache cannot file.
- Merge the whole shard on first touch. A whole-object download for a view that
  wanted a few inner chunks is the cost sharding exists to avoid.
- A new row family for carried reads. A carried read waited on someone else's
  round trip, which the follower vocabulary already says.

## Consequences

Merging happens only under contention. A client whose in-flight reads fit under
the cap queues nothing and merges nothing. The window, not the rule, bounds the
gain: letting a read yield once before claiming its group doubled the requests
removed, but that is a scheduler-timing hint rather than a defined window, so it
is not adopted. Dispatching a socket burst as a group in the handler would be
the principled form.
