---
type: Decision
title: "Bounded admission window for an oversubscribed wanted set"
description: "When the honest wanted set exceeds what the transport can deliver in interactive time, the scheduler commits to a bounded window and keeps the rest as cheap, untimestamped backlog."
tags: [lucida, decision]
source_path: wiki/decisions/0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md
created: 2026-08-09
modified: 2026-08-09
---

# Bounded admission window for an oversubscribed wanted set

Status: Accepted

Context: issue [#900], measurements from [#899] (`docs/research/remote-rates.md`
on branch `research/remote-rates`).

[#899]: https://github.com/aelefebv/lucida/issues/899
[#900]: https://github.com/aelefebv/lucida/issues/900

## The situation

On a 21,371-member remote collection every plan rebuild hands `CpuCache.submit`
the dataset's complete wanted set — `plan.requests_per_submit` p50 = **21,400**,
at roughly **5 rebuilds/s**. The scheduler then holds ~20,700 pending against 24
in flight, and the achievable remote fetch rate is **82/s**. Draining the set
once takes ~250 s.

This is not a leak. Every one of those requests is a member that is genuinely
visible and genuinely has no cached tile. The question is what a scheduler
should *do* with an honest wanted set it cannot serve in interactive time.

## What the measurements actually say

Two things had to be established before choosing, because they rule out most of
the candidate directions.

**1. The reported wait was throughput, not queueing.** #899 reports a median
queue wait of 4.6 s during a 10 s pan. That is not a scheduling pathology — it
is arithmetic. At 82 issues/s a 10 s phase issues ~820 requests; the median one
is rank ~410, i.e. ~5 s in. The measured 4.6 s is simply *half the phase
duration*. The 13.6 s zoom median and the 19.8 s worst case are the same
frontier carried across phase boundaries.

The consequence is blunt: **time-to-issue for a given tile is its rank divided
by throughput, and the pending queue is already ordered center-out and rebuilt
fresh every rebuild.** No reordering, no shedding, and no earlier cancellation
changes when a given tile arrives. Anything that claims to reduce that median
without changing throughput or rank is moving the measurement, not the wait.

**2. The 82/s ceiling is our own constant, not the network.** The server holds a
process-global source-read semaphore of **12** permits. At a p50 round trip of
~170 ms (97 ms TTFB + 52 ms body, run2) that is `12 / 0.17 ≈ 70` reads/s — which
matches the measured 82/s. Meanwhile TTFB stayed flat across 3,781 reads (p50
98–199 ms, worst 354 ms, under 4x spread) and per-stream body throughput at the
p50 implies far more aggregate capacity than the ~26 MB/s actually achieved. A
saturated object store inflates TTFB; this one did not.

So the wanted set is **not** 250x oversubscribed against the network. It is
oversubscribed against a hardcoded 12. This contradicts #900's premise that
raising concurrency would only "move the wait rather than remove it", and it
means [#901] — not this issue — holds the lever that changes tile arrival times.
That finding is recorded here rather than acted on here, because re-scoping and
re-sizing the limiter is #901's stated deliverable and needs its own measurement.

[#901]: https://github.com/aelefebv/lucida/issues/901

**3. The bookkeeping churn is a real cost.** #899's open question — whether
`cache.request` at 107,055/s matters — resolves to yes. Measured locally
(`lucida-web/src/pipeline/fetch/submitCost.perf.test.ts`), one `submit` of
21,400 requests took **20.5–22.2 ms p50**, about **105 ms of main thread per
second** at 5 rebuilds/s, for a path that issues no network work of its own.
That is main-thread time spent re-deriving a set the network will not reach for
minutes, on a viewer with a documented history of interaction stutter.

## Decision

The scheduler's pending queue becomes two things with different obligations: a
bounded **admission window** the scheduler has committed to fetching soon, and
an ordered **backlog** it merely intends to. Only the window carries per-request
bookkeeping. `Scheduler` (`lucida-web/src/pipeline/fetch/scheduler.ts`) owns the
split; ordering, drain order, and cancellation semantics are unchanged.

Two properties are load-bearing:

- **The backlog is never dropped.** Rebuilds stop when the camera stops, so a
  shed request would never be re-offered and an at-rest collection fill would
  stall forever. The scheduler promotes from its own backlog as the window
  drains, and completes the fill with no further submits.
- **An enqueue timestamp now means "admitted", not "first wanted".** The
  starvation signal is therefore bounded by window ÷ throughput. Surfaces that
  report it say so, and backlog entries report *no* age rather than a
  misleadingly small one.

This is [planning principle 2](../principles/planning.md) — "every policy must
be bounded… no unbounded enumeration, no carry-forward state that only grows"
— applied to the request queue rather than to memory. The queue was the one
piece of carry-forward state whose per-entry cost grew with member count and
which had no budget at all. The window is that budget; the backlog is the
defined behaviour for what exceeds it.

`CpuCache.submit` correspondingly derives each request's residency tier and
scheduler key once per rebuild rather than up to four times, and omitted-work
cancellation stops walking the outgoing pending queue — that queue is replaced
wholesale a few statements later, so filtering it had no observable effect.

## Measured, before and after

Re-run with `docs/research/remote-rates-harness/` (branch `research/remote-rates`)
against the same 21,371-member fixture, at DPR2, back to back on one machine so
the two share network weather — backend reads landed at 27.3/s in both pans,
and the same server binary served both, so only the client build differs. This
link was slower than #899's `run2` (27 vs 82 reads/s), which is why the absolute
figures differ from that note; the comparison between these two columns is the
meaningful one.

Scheduler wait at issue (`sched.queue_wait_ms`, ms):

| phase | before p50 | after p50 | before max | after max |
| --- | --- | --- | --- | --- |
| pan | 3,712 | **3,250** | 9,942 | **4,224** |
| zoom | 14,100 | **3,621** | 18,120 | **3,774** |
| warm re-open | 73 | **10** | 19,690 | **3,741** |

The medians land at roughly window ÷ throughput, as designed. The change in the
maxima is the substantive one: the multi-phase carryover, where a request first
wanted during the pan was still sitting in the queue two phases later, is gone.

Main-thread cost over the same runs:

| | before | after |
| --- | --- | --- |
| `plan.rebuild_ms` p50 (pan) | 47.4 | **29.5** |
| `plan.rebuild_ms` p50 (zoom) | 45.5 | **30.3** |
| `loop.tick_ms` p99 (pan) | 53.9 | **35.2** |
| `loop.tick_ms` p99 (zoom) | 49.6 | **32.5** |

And, confirming the analysis above rather than contradicting it: fetch
throughput did **not** move (331 → 333 requests issued during the pan;
`fetch.roundtrip_ms` and backend reads/s unchanged), and first render was flat
(486 → 495 ms cold, 333 → 327 ms warm). Correctness was checked on the DPR2
screenshots for every phase — same contrast window, colormap, and slider state,
populated minimap, no black, stale, or mis-levelled tiles, and an empty console
in both runs.

## What this does and does not buy

Stated plainly, because the distinction matters:

- It **does** halve a per-rebuild main-thread cost that scales with member count
  and is pure overhead on an oversubscribed collection.
- It **does** bound the scheduler's per-key bookkeeping, so queue depth no
  longer drives allocator and GC pressure.
- It **does** make `pendingOldestAgeMs` a usable drain-health signal. On a large
  remote collection it previously pinned near session age and told you nothing;
  it now reports window age. The honest "how long until the back of the queue
  arrives" is `pendingCount / fetch rate`, and both terms are already surfaced.
- It **does not** make any individual tile arrive sooner. Tile arrival is
  `rank / throughput`, and this decision changes neither. The reported queue-wait
  percentiles will drop sharply, and that drop is a change in what the scheduler
  *promises*, not in what it delivers. Anyone reading a before/after on
  `sched.queue_wait_ms` must read it that way.

## Considered options

**Prioritize more aggressively — rejected.** The plan is already sorted
ascending by priority with a center-out distance term, `submit` filters cached
and in-flight keys, and `enqueue` replaces the queue wholesale every rebuild. A
newly urgent tile already reaches the front on the next rebuild. There is no
ordering slack left to exploit.

**Shed the backlog outright — rejected.** Dropping requests beyond a cap does
not make retained ones arrive sooner (their rank is unchanged), and it breaks
the at-rest case: rebuilds stop when the camera stops, so a shed request would
never be re-offered and the collection fill would stall permanently. Retaining
an untimestamped backlog gets the bookkeeping saving without that failure mode.

**Cancel more eagerly — rejected as a lever, on scale.** The 92 observed re-plan
aborts had each burned 141–230 ms, roughly 1% of the interaction budget. Real,
but not the dominant term, and the existing `cancelOmittedChunkWork` and
rebuild-boundary cancellation already cover the cases that matter.

**Raise concurrency — correct, but belongs to [#901].** The evidence above says
this is the load-bearing fix and that #900's sequencing rationale does not hold.
Recorded here so #901 starts from it; not implemented here.

**Reduce read amplification — out of scope, worth recording.** The server reads
p50 326 KiB from object storage to deliver p50 6,144 B to the client (~54x),
because `slice_range` takes one (t, c) slice out of a t/c-bundled on-disk chunk.
Nothing in the client's scheduling can recover that; it is a property of the
stored chunk layout.
