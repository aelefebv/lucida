---
type: Decision
title: "Unconditional recording under a design budget"
description: "The pipeline performance monitor records always, with no opt-out; its cost is a CI-asserted design contract rather than a runtime governor, memory is bounded by a resident byte cap evicted a run at a time, and the only degradation is a loudly declared truncation."
tags: [lucida, decision]
source_path: wiki/decisions/0049-unconditional-recording-under-a-design-budget.md
created: 2026-08-10
modified: 2026-08-11
---

# Unconditional recording under a design budget

Status: Accepted

Context: issue [#894], under the [#885] map. Builds directly on
[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md), which fixes what is
recorded. Numbers come from [#888] (event rates, volumes, and the existing
telemetry floor), [#897] (clock resolution) and [#899] (remote rates).

[#885]: https://github.com/aelefebv/lucida/issues/885
[#888]: https://github.com/aelefebv/lucida/issues/888
[#894]: https://github.com/aelefebv/lucida/issues/894
[#897]: https://github.com/aelefebv/lucida/issues/897
[#898]: https://github.com/aelefebv/lucida/issues/898
[#899]: https://github.com/aelefebv/lucida/issues/899
[#962]: https://github.com/aelefebv/lucida/issues/962
[0047]: 0047-trace-model-phases-runs-and-lifecycle-rows.md

## The situation

A monitor you have to reproduce the problem under is the tool you do not have
when you need it. That is why [#885] settled that recording is on by default,
and it is the whole reason this decision exists: turning instrumentation on for
everyone is only safe if the cost is known, bounded, and cannot silently lie
about what it did or did not capture.

Everything instrumented in the viewer today is gated off unless a human opens
the debug panel — one mutable field, `debugStats.enabled`, set from `App.tsx`
and read at a handful of sites in `pipeline/tickCoordinator.ts`. So this is not
a policy applied to data that already flows; the data does not flow yet.

## There is no opt-out

**Recording is unconditional. There is no toggle, at any scope.**

This overrides [#885]'s standing preference that recording be "on by default
with an opt-out", and the second half of [#894]'s own title. It is recorded here
rather than quietly applied, because a future reader will otherwise read the
missing switch as an oversight.

The argument that removed it is that no honest motive for the switch survived
inspection. *Cost* does not motivate it: [#888] measured an idle viewer emitting
literally nothing — zero ticks, zero frames, zero events over five seconds,
because the render loop is dirty-driven ([0009](0009-pull-based-raf-with-typed-dirty.md))
— and a write path of 0.8–50 ns per event when it is busy. A switch that buys
back an unmeasurable quantity is a placebo, and shipping a placebo switch is
worse than shipping none: it invites every unexplained stall to be blamed on the
monitor. *Privacy* does not motivate it either, because the recording never
leaves the process on its own (below), so the question belongs to the export
surface. *Benchmark determinism* is the one real case — someone measuring lucida
itself wants to prove the instrument is not the measurement — and it is answered
by the observer-effect bound below rather than by a switch.

What we get in exchange is worth more than the switch was. The entire subtree of
questions [#894] asked about the toggle — what "off" means, where the toggle
lives, whether its scope is the tab, the profile or the deployment, and how to
avoid inheriting [0012](0012-logging-conventions.md)'s trap where
`localStorage.debug` is cached at module init so an out-of-band write changes
nothing until a reload — all of it disappears. There is no toggle, so there is
no toggle bug to inherit, and no configuration state that can disagree with
reality.

The consequence to accept: every user pays the recorder's cost, always, and
there is no field escape hatch if we are wrong about that cost. That is what
makes the budget below a hard contract rather than a guideline.

## The budget is a design contract, not a runtime governor

**The cost ceilings are asserted in CI. Nothing measures the recorder at
runtime.** The single runtime bound is buffer capacity — a byte count compared
against a cap, which is a size check, not a cost measurement.

A governor was the shape [#894] presumed when it asked "what gives way when the
budget is hit". It loses for two reasons. It requires the monitor to instrument
itself continuously, which *is* the perverse case the ticket warned about — the
monitor's own cost surfacing as a stall in its own trace. And it makes the cost
emergent and therefore unbudgetable, when [0047]'s model is deterministic by
construction: fixed-width rows, complete rather than sampled, so cost is a
computable function of chunk count. You can derive the ceiling instead of
watching for it. Reframed this way, "what gives way when the budget is hit"
becomes the far simpler "what happens when the buffer fills".

The numbers, each derived rather than chosen:

- **≤ 100 ns per event, amortised.** This is the primary assertion because it
  composes: any burst size multiplied by it gives the tick cost without a new
  measurement. It sits at the top of the 0.8–50 ns range [#888] measured for the
  existing write path, so it is a real ceiling rather than an aspiration.
- **≤ 250 µs worst-case tick.** The largest burst [#888] found is 2,943 chunk
  requests inside one `cpuCache.submit()`; at 100 ns that is 294 µs, so the cap
  forces the burst path below ~85 ns per event. Against the measured ~120
  ticks/s ceiling that is about 3% of a tick, and about 1.5% of a 60 fps frame.
- **Zero steady-state allocation after warmup.** Buffers are preallocated and
  grow only by doubling, up to the cap. This is not tidiness: an allocating
  recorder produces GC pauses that appear *as stalls in its own trace*, so
  making the recorder non-allocating deletes that failure mode rather than
  documenting it.
- **Cost must be flat in events-per-tick, not merely small at one event.**
  `UploadTelemetry.publish` in this repo goes 1.4 µs to 1.13 ms between 1 and
  128 events per tick because it prunes with `Array.shift()` in a loop ([#888],
  filed as [#898]). That is the failure that has already happened here, which
  makes it the assertion most worth having.

The budget is stated as **marginal** — the recorder alone — so that the number
does not move when the debug panel is dismantled. Separately, a **net
non-regression** obligation: once that dismantling lands, total observability
cost must be no higher than the floor [#888] measured today — ≈1.05 MB of live
state, and per tick no more than that same instrumentation costs *on the same
tick*. Stating only the marginal number would let the map ship "always-on is
free" while doubling the floor.

> **Amended 2026-08-11 ([#962]).** The per-tick term above read "≈1–3 µs per
> tick" until that issue found the figure to be [#888]'s cost for a single
> `UploadTelemetry.publish` *read* at 1–8 events/tick, not a tick's total, and
> not the write path — which [#888] costed separately at 0.8–50 ns/event, the
> range the 100 ns ceiling above was already derived from. Since `publish` is
> quadratic in events per tick and the recorder is flat, no single µs/tick
> figure can express the obligation; it is now stated as a comparison on a
> matched tick shape and asserted that way in CI. Both halves are met — 663 kB
> live, and 0.67–0.72× the floor per tick. The derivation is in
> `docs/perf/recorder-cost/README.md`.

## Retention is bounded in bytes and evicted a run at a time

**A resident cap of 8 MB, discarding whole completed runs oldest-first, never
the run in progress.**

Bytes are the unit because they bound the thing that actually matters under a
workload whose rate varies by three orders of magnitude between idle and peak. A
wall-clock window bounds nothing here: sixty seconds is zero bytes at idle and
megabytes mid-orbit. Runs are the *granularity* of discard because a
half-evicted run is not a diagnostic artifact — [0047] already establishes the
run as the comparable unit, with its own self-describing header.

Eight megabytes is roughly 65 warm re-opens at [0047]'s ~123 kB per run, about
eight times the existing telemetry floor, and about 1% of the 832 MB the CPU
cache is already configured to hold (`pipeline/fetch/cpuCache.ts`). It is small
enough that arguing about the figure costs more than paying it. The steady-state
buffer between runs is retained under the same cap, as an unlabelled interval.

## The only degradation is a truncation, and it is declared loudly

There are two rungs and deliberately no third.

The first is evicting the oldest **completed** runs. That is normal operation
rather than degradation: nothing about a retained run is diminished by an older
one being dropped.

The second is the in-progress run exceeding a **per-run cap of 2 MB**, at which
point it stops recording and is marked truncated — [0047]'s rule, with a number
attached. The per-run cap is separate from the resident cap on purpose, so a
runaway run truncates itself instead of first evicting all the history around
it.

There is no sampling rung, no granularity-reduction rung, and no
downsample-to-aggregates rung. [#888]'s arithmetic is why: the expensive case is
2,559 chunks at ~123 kB, so 2 MB is roughly sixteen times the headroom needed,
and reaching it means something pathological is happening. A loud truncation is
a *better* diagnostic of pathology than a silently coarsened trace that still
looks complete. Dropping the finest granularity to stay under budget is exactly
the confidently-wrong picture `intention.md` forbids.

**The declaration is a record, not a boolean.** A truncated run stops storing
rows, so it cannot report how many it dropped — but it can keep counting. One
integer increment per post-truncation chunk turns "truncated at 18,000 rows"
into "truncated at 18,000 of an eventual 63,412", which is the difference
between a trace nobody can trust and a trace that states it covered the first
28% of the run. The header therefore carries reason, truncation offset, rows
recorded and rows unrecorded. The same principle applies downward: the
drop-oldest rings [0047] keeps for point events and per-tick aggregates each
carry a dropped count, so a wrapped ring is visible rather than inferred.

This obligates the two reading surfaces. A truncated trace summarised as if it
were complete is precisely the failure this rung exists to prevent, so both the
visual timeline and the agent diagnostic must **lead** with the degradation
record rather than footnote it — which is a direct application of
[surface parity](../principles/surface-parity.md), since a caveat shown to one
audience and not the other reintroduces the problem for the other.

## The observer effect is bounded by the clock, not by a correction

The recorder's cost sits inside the phases it times: the duration recorded for
`plan` includes the write of `plan`'s own row. This is stated rather than
engineered around, because subtracting it would mean timing the timer.

The bound comes free from [#897], which measured a hard 100 µs resolution floor
in both the main thread and workers. At ~100 ns per event the recorder is three
orders of magnitude below what the platform can resolve. The effect is not
merely small — it is **unrepresentable at this clock**, which is a stronger and
more durable claim than any correction factor, and it is what answers the
benchmark-determinism case that the deleted opt-out would have served.

Proving it needs an A/B, and with no user-facing switch there is nothing to flip.
The recorder's **sink is injectable so that benches can substitute a no-op**;
this is a test seam, not a product surface. It leaves the branch and the
argument evaluation in place, which is honest — that is the cost a user actually
pays, since there is no way to opt out of it. The rejected alternative was a
build-time flag that dead-code-eliminates the recorder: it measures the true
zero, but a documented build flag that compiles the monitor out is the opt-out
wearing a lab coat, and it would be found, used, and become the toggle this ADR
removed.

Three CI gates, all over the harness [#888] already built
(`docs/research/trace-volumes-harness/`): **flatness** across 1, 8, 128 and
2,943 events per tick; the **absolute ceilings** above; and an **A/B frame
throughput** comparison of real sink against no-op sink over a warm re-open **at
device pixel ratio 2**. The last has precedent and a number to beat — [#888] ran
that exact shape against the debug panel and measured 1,148 rendered frames in
ten seconds either way. DPR 2 is not optional: DPR-1-only verification has
hidden whole defect classes in this project before.

## The recording never leaves the process unless asked

No automatic upload, no beacon, no server-side aggregation, no phoning home.
Export is strictly a pull — a human saves, or an agent requests.

With that invariant, unconditional recording is a purely local memory concern
and the privacy of the artifact is entirely a property of the export surfaces,
which is where it is decided. The invariant is stated here because it is what
makes scoping the question out safe rather than merely convenient, and because
it is a precondition for
[agent-first access](../principles/agent-first-access.md) being a pull model:
the agent asks for the trace, the trace is not pushed at anyone.

## Consequences

- Panel-gated instrumentation is deleted and the recorder runs unconditionally.
  `debugStats.enabled` and its read sites go with it. The decision belongs here;
  the removal is executed alongside the debug-surface dismantling it overlaps.
- There is no field escape hatch. If the budget is wrong, the fix is a release,
  which is the price of not shipping a switch nobody can honestly justify.
- Adding a phase or a counter to the recorder spends from a fixed budget rather
  than from an unexamined one. The CI gates are the enforcement.
- Both reading surfaces inherit an obligation to surface truncation prominently.
- The 8 MB and 2 MB caps are derived from measured volumes at a 384-member
  collection. A workload an order of magnitude larger would truncate more often
  and should be re-derived rather than assumed to fit.
