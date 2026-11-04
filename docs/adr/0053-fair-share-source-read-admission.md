# Fair-share source-read admission

Status: Accepted.

## Context

Every backend chunk read queues for a permit before it touches the object store.
The permits were one process-global FIFO semaphore of a hardcoded 12, shared by
every client and every open dataset. Opening a large collection submits tens of
thousands of reads at once, so under FIFO whoever enqueues that burst owns the
store until it drains, and a second client arriving mid-open waits behind all of
it. The 12 was a guess, and it sat pinned full through every interactive phase.

## Decision

The bound stays global. The admission does not.

One limiter per process caps total concurrent source reads. Reads queue per
reader, meaning the requesting client. When a permit frees, it goes to the
waiting reader with the fewest reads in flight, ties broken by whoever was
served longest ago. The limiter is work-conserving: a reader alone gets the
whole cap, and fairness binds only when someone else is waiting. Reads not made
for a connected client (imports, CLI work, server-side proxy generation) share
one background class, since proxy generation is coalesced across clients and
belongs to none of them.

The default cap is 16 (`DEFAULT_SOURCE_READ_CONCURRENCY` in
`lucida-store/src/cache.rs`). A sweep against a remote bucket found completed
reads per second plateau at 16 (57/s, against 51 at 12 and 59 at 32) while
per-read body transfer kept slowing (p50 about 120 ms at 16, 270 ms at 32). 16
is the smallest cap that reaches the plateau. The knee belongs to the link, so
`LUCIDA_SOURCE_READ_CONCURRENCY` overrides the default, and
`docs/research/source-read-concurrency-harness/` re-runs the sweep on another
link.

## Rejected alternatives

- Per-client caps. The protected resource is shared. A per-client cap of n lets
  k clients drive k·n reads, and past the knee throughput falls and every read
  slows. Only the allocation of the cap is a fairness question.
- Per-dataset shares. A dataset is not a party with an interest. A client could
  widen its share by opening more datasets, the same defeat as a per-instance
  limiter.
- Round-robin over requests. It is fair per request, so a reader with 20,000
  queued still takes 20,000 turns. Least-in-flight is fair per unit of capacity,
  which is what is contended, and costs nothing with one reader.
- A higher cap. Past the plateau extra permits do not deliver chunks sooner.
  They move the wait out of the queue, where it is visible, into the transfer,
  where it is not.

## Consequences

Metadata reads are not covered. They have their own FIFO bound of 32 and no
reader identity on the open path, so one client's open can still queue another's
behind its metadata burst. The exposure is a slower open, not an unbounded
stall.

A read coalesced onto another client's in-flight read is admitted on the
leader's share. Fairness within one reader is the scheduler's admission window,
[ADR 0044](0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md).
