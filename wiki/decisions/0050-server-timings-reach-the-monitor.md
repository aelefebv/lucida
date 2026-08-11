---
type: Decision
title: "How server-side timings reach the monitor"
description: "The browser owns the merged trace; the server pushes its own rows to the client that caused them in batched columns over the existing socket, placed by nesting inside a browser-measured bracket rather than by clock synchronisation."
tags: [lucida, decision]
source_path: wiki/decisions/0050-server-timings-reach-the-monitor.md
created: 2026-08-10
modified: 2026-08-10
---

# How server-side timings reach the monitor

Status: Accepted

Context: issue [#891], under the [#885] map. Constrained by
[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md) (what a record is),
[0048](0048-correlating-work-across-the-browser-server-boundary.md) (the join
key) and [0049](0049-unconditional-recording-under-a-design-budget.md)
(recording policy and budget). Rates from [#899], volumes from [#888],
thresholds from [#893].

[#885]: https://github.com/aelefebv/lucida/issues/885
[#888]: https://github.com/aelefebv/lucida/issues/888
[#891]: https://github.com/aelefebv/lucida/issues/891
[#893]: https://github.com/aelefebv/lucida/issues/893
[#899]: https://github.com/aelefebv/lucida/issues/899

## The situation

[0047] put the server's work in a second lifecycle table and [0048] minted the
`rid` that joins it to the browser's. Neither said how the table gets anywhere.
Today it gets nowhere: server-side timing exists only as `tracing` span-close
lines in a log stream ([0012](0012-logging-conventions.md)), and that convention
was trial-run on one flow and never propagated — `lucida-server`, `lucida-store`
and `lucida-content` hold exactly one `#[tracing::instrument]` between them.

So this is not a routing decision over data that already flows. It is the
decision that makes [0048]'s label mean something, which is why [0048] said the
label ships with the server table rather than before it.

## The browser owns the merged trace

**Server rows travel to the client that caused them, and the browser's trace is
the one artifact.** There is deliberately no server-side trace store and no
server-side trace endpoint.

[0049] put the run header, the 8 MB resident cap, the truncation record and the
export pull on the browser side. Inverting the ownership would move all four and
break its "the recording never leaves the process" invariant in the one direction
that actually matters. Merging two saved files offline was the more tempting
alternative, since it appears to serve a headless agent directly — but [#885]
settled that `lucida trace <dataset>` drives headless Chrome itself, so no agent
path ever wants server rows without a browser in the loop, and an offline merge
would give the live view nothing while [#885] requires the live view to be the
in-progress recording.

## Batched push, because the server cannot know when to stop

The reflex option — the server accumulates and the client pulls a batch at the
end — is not merely worse here, it is **structurally unavailable**. [0048]
established that the server has no idea runs exist; a run is a client-side
interval over a continuous buffer. The server therefore cannot detect "the end",
and a client-driven pull would force it to retain a whole session meanwhile.

Per-item push is the opposite failure. [#888] measured a peak of 2,943 chunk
requests inside one `cpuCache.submit()`, so one message per served chunk roughly
doubles server-to-client message count on the exact path the monitor exists to
explain.

**So: batched push over the existing socket, on a 250 ms ticker, with an early
flush at 512 buffered rows.** The numbers are derived, not chosen. [#899]
measured the server completing reads at ~82/s remote (the 12-permit cap) and
~894/s local, which makes a 250 ms batch ~20 rows remote and ~220 local — under
7 kB of columnar JSON, four messages a second, noise beside the chunk payload.
250 ms rather than something tighter because the thing being watched is
seconds-scale: [#899]'s median queue wait is 4.6 s, so the live view lags by ~5%
of the bar being read. The 512-row threshold only fires above ~2,000 rows/s,
which is above any rate measured here — it is a burst guard, not the governor.
The ticker subsumes any quiescence rule, so there isn't one.

Emission is **unconditional**, mirroring [0049]. A per-connection opt-in would be
the toggle that ADR deleted, and it self-scopes anyway: a CLI peer that never
requests chunks produces no rows.

The batch buys back the retention question the ticket asked. The server holds one
flush window, not a session.

## Nesting, not clock synchronisation

The ticket framed clock skew as anchor-on-one-clock-with-measured-offset versus
compare-durations-only. **Both lose to a third option the wire already affords:
server rows carry offsets from their own arrival instant plus durations, no
absolute wall-clock, and the exporter places them inside the browser-measured
request bracket.**

The browser stamps the send and the receipt of each `rid` on one clock, and the
server's work for that `rid` is strictly nested inside that bracket. So the
server's clock is never trusted for anything and skew cannot produce a wrong
picture. The un-attributed remainder inside the bracket — network plus socket
queue — is **named as a gap rather than silently absorbed**, which is the whole
point: `intention.md` holds that a confidently-wrong merged timeline is a failure,
not a win, and an estimated-offset anchor is confidently wrong whenever the
estimate drifts. The same nesting places the metadata-read table inside the open's
`request_id` bracket.

What nesting cannot place is server work with no browser bracket: the generated
queue and socket write time. [0047] and [0048] had already excluded both for
independent reasons, which reads as corroboration rather than coincidence.

## A client sees its own rows and no aggregate

A `Session` is shared by every client in a workspace, and the source-read limiter
is **process-global** across all datasets and all sessions. So the single most
interesting server number — the permit wait [#899] identified as the rate-setter
— is caused by other tenants by construction.

**A client receives rows keyed to its own `client_id`, including its own permit
wait, and no process-wide aggregate.** The wait is that client's own latency and
a monitor that hides why it waited three seconds is useless. But queue depth,
peer request rates and peer dataset identities are a cross-workspace signal, weak
but real, and there is no diagnostic question they answer that the client's own
wait duration does not. A client learns "you waited 3.1 s for a read permit",
never what it waited behind. Note this is *narrower* than the existing
`dataset_health` surface, which already reports cumulative source-read time
including cap queueing to any client in the session.

## There are two coalescing layers, not one

[0048] fixed the browser's many-rows-to-one-`rid` fan-in. It did not know about
the second one: `CachedStore` elects a single-flight leader per object path and
parks other readers as followers on a broadcast channel
(`lucida-store/src/cache.rs`). Many `rid`s therefore collapse onto one backend
read.

If a follower recorded the read it waited on as its own, a sum over the read
column would report thousands of backend round trips for an open that made
hundreds — the trace would confidently overstate load on the store. **So a
follower row records its own wait under a distinct coalesced-wait phase and
carries the leader's `rid`; only the leader's row owns the permit wait and the
backend read.** Each real round trip is then counted exactly once, and a
follower's 400 ms is attributed to waiting on an in-flight read rather than to a
slow backend — a different diagnosis with a different fix. This also yields the
server-side twin of the coalescing count [0048] got for free on the browser side.

## The server's enum is finer, because its clock is

[0047]'s rule that a phase earns a timestamp only above a 100 µs floor came from
[#897], which measured a *browser platform* coarsening. Rust's `Instant` has no
such floor. **The rule is therefore clock-relative rather than absolute, and the
server gets a finer enum than the browser**: arrival, binding lookup, dispatch,
cache lookup, permit wait, backend read, decompress, slice-and-encode, handoff.

Binding lookup earns its slot despite looking free: it takes the shared session
mutex, so every chunk request from every client in the workspace serialises
there, and under [#888]'s 2,943-request burst that is exactly the shape of cost
that stays invisible until it is measured. Nothing measures it today. Handoff is
terminal — socket write remains excluded per [0047].

The server inherits [0049]'s ≤100 ns/event marginal ceiling but not its 250 µs
tick cap, which is meaningless off a frame loop.

## Reconnect completes the join key

[0048] made `(connection, rid)` the global key and had the header record *the*
connection. But a run is a client-side interval that can outlive a socket, `rid`
restarts at zero on a new connection, and the browser reconnects after two
seconds — so one run can hold two `rid: 0` rows meaning different requests.

**The browser row carries a connection generation, and the run header records the
set of connections a run spanned.** This is a correction to [0048]'s assumption
that a run sits inside one connection, not to its choice of key.

Rows the server had buffered for a dead connection are **discarded, never
replayed**. Replay would need retention across connections — reintroducing what
batching just deleted — and re-identification of a returning client, which under
workspace auth opens a cross-session identity question no diagnostic should
force. The browser knows it reconnected, so the browser declares the gap, which
puts the honesty obligation on the side holding the facts.

## Degradation is declared on both sides

Two bounded points, both drop-and-count, because a monitor that blocks the
pipeline it measures is the perverse case [0049] refused.

Server side, the pre-flush buffer is capped at two flush windows; on overflow it
stops accumulating and reports the dropped count in the next batch header. This
is [0049]'s "the declaration is a record, not a boolean" one process over, and it
matches the dropped counters [0047] already keeps on its rings. The pre-existing
unbounded unicast send queue is *not* addressed here — it is a real defect, and
[#885] is explicit that fixing existing defects is not a step on this route.

Browser side, server rows live in a fourth table under the same 8 MB resident and
2 MB per-run caps. When a run truncates, arriving batches are **dropped but still
counted into the unrecorded total**. An unjoinable server row is not a diagnostic,
so orphan-storing it spends the very budget truncation exists to protect; but if
the server side silently stopped being counted, the coverage block would overstate
coverage for one of the two sides — the asymmetric honesty [0049]'s surface-parity
clause forbids.

## Shape, families, and where the types live

**One message carrying parallel column arrays**, not an array of objects. Size is
not the argument — both are trivial beside the chunk payload. The receive path is:
[0049] mandates zero steady-state allocation in the recorder, and an array of
objects hands the browser thousands of short-lived objects to parse and discard
*inside* that budget, where columns copy straight into the destination table. It
also mirrors [0047] one layer out — the in-memory model is a table, so the wire is
a table. A new binary frame was rejected on [0048]'s grounds: the binary path has
no framing room and would need its own routing.

One family column covers all of it. Chunk and asset rows key on `rid`;
**metadata-read rows key on `request_id`**, matching [0048]'s two join paths.
Metadata reads deliberately do *not* ride the existing `DatasetOpenProgress` push:
`DatasetOpenStage` is documented in-code as user-facing, and coupling a stable
public vocabulary to the trace schema is a worse trade than one extra family.
Attaching them to `OpenDatasetSucceeded` at the end was rejected outright — a
*failed* open would then carry no rows at all, and [#893] found metadata reads are
91% of the headline run, so end-attachment loses the data in precisely the case
that needs it.

Generated-chunk requests get an ordinary row with inapplicable slots left unset
plus an outcome column, rather than a table of their own; unset slots are what a
fixed-width per-phase row is for. One asymmetry to hold onto: when the answer is a
not-ready status the server's row ends honestly but no chunk ever arrives, so that
`rid`'s browser row terminates without a delivery — **the exporter must not read
that as a server stall**, which is a live mis-attribution risk in a tool whose job
is attributing stalls to a side.

Types follow the existing split: the `ServerMessage` variant in
`lucida-core/src/protocol.rs`, appended last so serde tag positions do not shift;
the payload struct in `lucida-protocol/src/diagnostics.rs`.

## The proxy-asset bullet was a name collision

[#891] asked whether `lucida-proxy` is a third timing source or transparent, and
listed it as sitting in the path. It does not sit in the path. It is an I/O-free,
async-free pure-compute crate called from inside the server process. The question
came from *proxy asset* — a low-resolution placeholder volume, our own domain term
— being read as *proxy* in the network sense. `CONTEXT.md` now pins the term.

Proxy-asset generation is an ordinary server-side phase, so the transport answer
is unaffected by it entirely. And the bullet is doubly retired:
[0043](0043-superseded-server-surfaces-sunset.md) already decided to delete the
proxy/asset fallback protocol including the crate.

## [0049]'s "no server-side aggregation", scoped

[0049] states that nothing is uploaded, beaconed, aggregated server-side, or
phoned home. Read literally, a server buffering its own rows violates it; read in
context, it was ring-fencing the *browser's* recording from being pushed outward,
while [0047] mandates a server table.

The distinguishing property is **direction**: data flows toward the client that
caused it and never away from the user, so [0049]'s privacy argument is untouched.
The boundary is that the server buffers only its own rows, only for the connection
that caused them, and only until the next flush — which the batching design makes
true rather than merely promises.

## Consequences

- `(connection_generation, rid)` is the join key. [0048]'s single-connection
  assumption is corrected; anything that reconnects without bumping the generation
  breaks the join silently.
- The server's phase enum is wider than the browser's and its floor is its own
  clock's. Comparing a server phase against a browser phase by resolution is a
  category error.
- Backend read counts are only correct if follower rows keep their hands off the
  leader's columns. A future change to `CachedStore`'s single-flight scheme is a
  change to the trace's arithmetic.
- The asset family may disappear entirely under [0043]'s sunset, at which point
  [0048]'s shared counter simply has no asset entries. Nothing else moves.
- The server can now be the reason a trace is incomplete, so the coverage block
  reports two drop sources, not one.
- Anything that makes the server's work *not* nested inside a browser-measured
  bracket — a server-initiated push of chunk data, say — is unplaceable on the
  timeline under this decision and would need its own clock answer.
