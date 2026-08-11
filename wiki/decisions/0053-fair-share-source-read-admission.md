---
type: Decision
title: "Fair-share source-read admission"
description: "The cap on concurrent backend source reads stays process-global, but admission is per-reader and least-in-flight-first, so one client's collection-sized backlog cannot starve another client on the same server."
tags: [lucida, decision]
source_path: wiki/decisions/0053-fair-share-source-read-admission.md
created: 2026-08-10
modified: 2026-08-10
---

# Fair-share source-read admission

Status: Accepted

Context: issue [#901], measurements in `docs/research/source-read-concurrency.md`,
prior measurements from [#899] (`docs/research/remote-rates.md`) and the admission
window of [ADR 0044](0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md).

[#899]: https://github.com/aelefebv/lucida/issues/899
[#900]: https://github.com/aelefebv/lucida/issues/900
[#901]: https://github.com/aelefebv/lucida/issues/901

## Context

Every backend read of a chunk queues for a permit before it touches the object
store. The permits were a process-global FIFO semaphore of a hardcoded 12. Two
separate things were wrong with that, and they have separate answers.

**The scope was wrong.** One semaphore, FIFO, shared by every client and every
open dataset. A viewer's demand is not smooth: opening a large collection submits
tens of thousands of reads at once (#899 measured 21,431 cache requests on a warm
re-open, against a rate of ~82 reads/s). Under FIFO, whoever enqueues that burst
owns the store until it drains, and a second client arriving mid-open waits behind
all of it. On a single-user laptop this is invisible. On any shared deployment it
is a client starving other clients, and nothing in the system says so.

**The value was a default, not a measurement.** 12 was chosen as "the conservative
middle of the intended 8–16 range". #899 then found in-flight reads pinned at
12/12 for every interactive phase, with permit wait at 166–467 ms p50 against a
network first byte of 98–199 ms: roughly half of a chunk's remote latency was
queueing behind our own constant. #900 closed by naming this cap as the ~82/s
ceiling and #901 as "the lever that actually changes tile arrival times".

## Decision

**The bound stays global. The admission does not.**

One limiter for the process caps total concurrent source reads. Reads queue
per *reader* — the requesting client — and when a permit frees it goes to the
waiting reader with the fewest reads in flight, ties broken by whoever was served
longest ago. It is work-conserving: a reader alone on the limiter gets the whole
cap, and fairness only binds when someone else is waiting.

Reads not made for a connected client — imports, CLI work, and server-side proxy
generation — share one background class. Proxy generation is coalesced across
every client that asked for the same spec, so there is no one client whose share
it should come out of; it competes as one population against the interactive
readers rather than as none.

**The cap is 16, and it is measured.** Sweeping concurrency against the real
remote collection (`docs/research/source-read-concurrency.md`), completed reads
per second plateau at 16 and aggregate bandwidth flattens with them: past 16 the
link is the constraint, not the cap. Above the plateau the extra streams still
cost — body-transfer p50 roughly doubles by 24 and by 48 throughput is falling.
16 is the smallest cap that reaches the plateau.

## Rationale

**Why not per-client caps instead of a global one?** Because the resource being
protected is shared. A per-client cap of *n* lets *k* clients drive *k·n*
concurrent reads, and the sweep shows what happens past the knee: throughput
falls and every read gets slower. The cap exists to keep the server's demand at
the knee; only the *allocation* of it is a fairness question.

**Why not per-dataset?** A dataset is not a party with an interest. Two clients
on one dataset are two parties; one client across ten datasets is one. Scoping
the share to the dataset would let a client widen its share by opening more
datasets — the same defeat as a per-instance limiter.

**Why least-in-flight rather than round-robin over requests?** Round-robin is
fair per request; the reader with 20,000 queued still takes 20,000 turns. Least-
in-flight is fair per *capacity*, which is the thing being contended. It also
makes the common case free: with one reader there is nothing to compare.

**Why not simply raise the number?** #901 anticipated this, and the measurement
confirms it. Raising the cap past the plateau does not deliver chunks sooner; it
relocates the wait out of our queue and into the transfer, where it is harder to
see and no shorter. The honest headline is that the semaphore was *not* the
throughput ceiling #900 supposed — the link is. Moving 12 → 16 collects the last
part of the plateau and nothing more.

**Why keep an operator override?** The knee is a property of the link, not of
lucida. The measured 16 is the knee on the link it was measured on; a deployment
inside the same region as its bucket will have a higher one.
`docs/research/source-read-concurrency-harness/` re-runs the sweep to find it.

## Consequences

- The fairness guarantee is one bound, shared fairly — not isolation. A client
  on a busy server gets a *share*, and that share shrinks as clients arrive. What
  it cannot do is go to zero because somebody else got there first.
- A read coalesced onto another client's in-flight read (see **read coalescing**
  in `CONTEXT.md`) is admitted on the leader's share. The work happens once and
  someone has to own it; this can only make a follower faster than its own share.
- Fairness between readers says nothing about fairness *within* one reader — that
  is the scheduler's admission window, [ADR 0044](0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md).
- The limiter now knows how many reads are queued and for whom. That is exactly
  the queue-depth signal #899 asked the performance monitor to surface, and it is
  not yet published anywhere.
