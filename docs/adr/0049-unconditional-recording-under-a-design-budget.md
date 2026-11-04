# Unconditional recording under a design budget

Status: Accepted. Amended by [#962] (the per-tick floor as a matched-shape
comparison) and [#1048] (reading surfaces under the contract, opt-in exports).

## Context

A monitor you have to reproduce a problem under is the tool you do not have when
you need it, so recording is on for everyone. That is safe only if the cost is
known and bounded, and if the trace cannot misreport what it captured. Before
this, instrumentation ran only while a person had the debug panel open. An idle
viewer emits nothing, because the render loop is dirty-driven
([0009](0009-pull-based-raf-with-typed-dirty.md)), and the existing write path
cost 0.8 to 50 ns per event when busy ([#888]).

## Decision

Recording is unconditional. There is no toggle at any scope, and the missing
switch is deliberate.

The cost ceilings are a design contract asserted in CI, not a runtime governor.
Nothing measures the recorder while it runs, and the only runtime bound is
buffer capacity, which is a size check. The contract has four rules: an
amortised per-event ceiling, which composes into the cost of any burst; a
worst-case tick ceiling derived from the largest measured burst; zero
steady-state allocation after warmup, because GC pauses would show up as stalls
in the recorder's own trace; and cost that is flat in events per tick, not
merely small at one event. The numbers and their derivations live in
`lucida-web/src/trace/recorderCost.perf.test.ts`.

The budget is marginal, for the recorder alone. A second obligation is net:
total observability cost, in memory and per tick, stays at or below the floor
measured before the debug panel was removed. The per-tick half is a comparison
on a matched tick shape, because the old telemetry's cost grew quadratically in
events per tick and the recorder's is flat, so no single figure can express it.
The frame-throughput A/B needs a GPU and lives in `docs/perf/recorder-cost/`.

The surfaces that draw while a run is open are under the same contract: the HUD,
the overlays, and the dock's live charts. The HUD and the charts draw from the
per-tick aggregate at tick cadence, never from the frame loop. The overlays'
phase and churn modes read the row index the recorder already keeps and derive
nothing of their own. None of the three walks rows while a run is open; the
verdict is computed when the run closes or when someone asks. Each surface's
ceilings are in its own tripwire test. The recorder's numbers do not transfer,
because a canvas draw per tick is a different cost from a row write per event.

Retention is bounded in bytes. The resident cap is 8 MB, evicting whole completed
runs oldest first and never the open run. A per-run cap of 2 MB truncates a
runaway run before it can evict the history around it. The unlabelled
steady-state interval has no privileged start, so at the per-run cap it rotates
to a fresh interval instead of truncating. Both caps were derived from measured
volumes at a 384-member collection, and a much larger workload should re-derive
them.

Truncation is the only degradation. A truncated run keeps counting the rows it
no longer stores, so the header can say "18,000 of an eventual 63,412" instead
of carrying a boolean. The rings carry dropped counts. The visual timeline and
the agent diagnostic both lead with the degradation record.

The observer effect is stated, not subtracted, since subtracting it would mean
timing the timer: a phase's duration includes the write of its own row. At the
per-event ceiling the recorder sits three orders of magnitude below the 100 µs
clock floor, so the effect cannot be represented. The sink is injectable so that
benches can substitute a no-op. That is a test seam, not a product surface.

The recording never leaves the page on its own. Export is a pull: a person saves
or an agent asks. Two paths are opt-in by a visible action and off by default.
Send report posts a bundle to a workspace inbox, and the watch toggle streams
the per-tick aggregate and run boundaries over the session socket
([0050](0050-server-timings-reach-the-monitor.md),
[0051](0051-the-trace-driver-and-the-page-export-seam.md)). Each switches a
departure on. Neither switches recording off.

## Rejected alternatives

- An opt-out toggle. Cost does not justify one, since there is nothing
  measurable to buy back, and a placebo switch invites every unexplained stall
  to be blamed on the monitor. Privacy does not justify one, since nothing
  leaves the page unasked. Benchmark determinism is answered by the clock bound
  and the no-op sink. With no toggle, no cached toggle state can go stale the
  way the log categories' can ([0012](0012-logging-conventions.md)).
- A runtime governor that sheds work over budget. The monitor would have to
  instrument itself continuously, its own cost would appear as stalls in its
  own trace, and the cost would become emergent when fixed-width, complete rows
  make it computable.
- A wall-clock retention window. Sixty seconds is zero bytes at idle and
  megabytes mid-orbit.
- Sampling, coarsening or downsampling to stay in budget. A silently coarsened
  trace that still looks complete is worse than a loud truncation, and reaching
  the cap already signals something pathological.
- A build flag that compiles the recorder out, for a true-zero A/B. It would be
  found, used, and become the toggle this decision removed.

## Consequences

There is no field escape hatch. If the budget is wrong, the fix is a release.

[#888]: https://github.com/aelefebv/lucida/issues/888
[#962]: https://github.com/aelefebv/lucida/issues/962
[#1048]: https://github.com/aelefebv/lucida/issues/1048
