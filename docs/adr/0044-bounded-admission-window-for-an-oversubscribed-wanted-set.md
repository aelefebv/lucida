# Bounded admission window for an oversubscribed wanted set

Status: Accepted.

## Context

On a 21,371-member remote collection every plan rebuild handed `CpuCache.submit` the whole
wanted set, about 21,400 requests, at about 5 rebuilds per second. At the measured remote rate
of 82 fetches per second, draining it once took about 250 s. Every request was real: a
visible member with no cached chunk. Since the queue is already sorted center-out and replaced
every rebuild, a chunk's time to issue is its rank divided by throughput, and no scheduling
change alters that. What did cost something was bookkeeping: one submit of 21,400 requests
took about 21 ms, roughly 105 ms of main thread per second, spent re-deriving a set the
network would not reach for minutes.

## Decision

The scheduler's pending queue splits into a bounded admission window at the front, which the
scheduler has committed to fetching soon, and an ordered backlog behind it. Only the window
carries per-request bookkeeping. The window is `max(64, 4 × maxConcurrentFetches)` entries.
Ordering, drain order, and cancellation are unchanged.

- The backlog is never dropped. Rebuilds stop when the camera stops, so a shed request would
  never be offered again and an at-rest fill would stall. The scheduler promotes from its own
  backlog as the window drains and finishes the fill with no further submits.
- An enqueue timestamp means "admitted to the window", not "first wanted". Queue age is
  therefore bounded by window over throughput, and backlog entries report no age rather than
  a misleadingly small one.

This applies the rule that every policy is bounded ([intention.md](../../intention.md)) to the
request queue, the one piece of carry-forward state whose cost grew with member count and had
no budget. The submit path also derives each
request's tier and key once per rebuild instead of up to four times. Plan rebuild p50 fell
from about 47 ms to 30 ms on the same collection. The harness and the full before/after run
live on branch `origin/research/remote-rates`.

## Rejected alternatives

- Prioritize more aggressively. The plan is already sorted with a center-out term and the
  queue is replaced every rebuild, so a newly urgent chunk already reaches the front.
- Shed the backlog past a cap. Retained requests keep their rank, so none arrives sooner, and
  the at-rest fill stalls for good.
- Cancel more eagerly. Re-plan aborts cost about 1% of the interaction budget, and existing
  rebuild-boundary cancellation covers the cases that matter.
- Raise read concurrency. A server-side lever, outside this decision.
  [ADR 0053](0053-fair-share-source-read-admission.md) later raised the cap to 16 and found the
  link is the ceiling past that.
- Reduce read amplification. The server reads a whole t/c-bundled chunk to serve one slice.
  That is a property of the stored layout that client scheduling cannot recover.

## Consequences

No chunk arrives sooner. Reported queue-wait percentiles drop sharply because the scheduler
promises less, not because it delivers more, and any before/after on queue wait must be read
that way. The useful "time until the back of the queue arrives" is pending count over fetch
rate.
