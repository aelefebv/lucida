# The HUD's cost contract: gates, ceilings, and the A/B

Issue [#1061], under the [#1048] spec, enforcing [ADR 0049][0049] as amended
by that spec.

[#1048]: https://github.com/aelefebv/lucida/issues/1048
[#1061]: https://github.com/aelefebv/lucida/issues/1061
[0049]: ../../../wiki/decisions/0049-unconditional-recording-under-a-design-budget.md
[recorder]: ../recorder-cost/README.md

The HUD is a canvas strip in the viewport that draws what the pipeline is
doing. ADR 0049's amendment puts it under the recorder's cost contract, and
the ADR carries the reasoning. This page carries the HUD's rules, the gates
that assert them, and the ledger.

## The rules

- **Bounded per tick, nothing per frame.** The HUD ticks on its own timer,
  every 250 ms, and never from the render loop. It requests no animation
  frame. Its whole cost is one sample, one model read, and one draw per tick.
- **Never walks rows.** The sample is gathered from recorder getters (the
  latest reading, the page-scoped byte totals, the published quiescence, the
  adapter), from a tick observer that copies seven fields per dataset when
  the per-tick aggregate is committed, and from two bounded reads on the CPU
  cache: resident bytes per pool, and outstanding work by lane under the same
  scan cap as the quiescence predicate.
- **Fixed history.** The model keeps 60 ticks in fixed buffers. A session
  that runs for hours draws the same picture at the same cost as one that
  ran for a minute.

## The gates that run in CI

`lucida-web/src/hud/hudCost.perf.test.ts`, part of `pnpm test`:

| Gate | Ceiling | Asserted as |
| --- | --- | --- |
| Model tick: take a sample, read the view | ≤ 200 µs | < 3,200 µs at p50 |
| Draw tick: issue the draw for a 1,000 px strip at ratio 2 | ≤ 500 µs | < 8,000 µs at p50, and the same call count after 120 and 2,400 ticks |
| Sample: gather from the recorder and the cache | ≤ 100 µs | < 1,600 µs at p50 over 30,000 rows, and no more than 4× the cost over no rows |
| Lane scan: classify a pending queue at the 4,096 cap | ≤ 100 µs | < 1,600 µs at p50 on a real scheduler |
| Fixed history | 60 ticks | the same buffer and series length after 10,000 ticks |

**How the ceilings were derived.** From the frame, not the tick. A HUD tick
that lands on a frame must not take it, so gathering, model, and issuing the
draw together stay under about a twentieth of a 60 Hz frame, 800 µs, once
every fifteen frames at most. The recorder's numbers do not transfer: a
canvas draw per tick is a different shape of cost from a row write per event.

**Tripwires, not benchmarks.** As in the [recorder's gates][recorder], every
timing assertion is an absolute bound at 16× the ceiling, and the real figure
is logged on a `[#1061]` line. The 16× is the recorder's finding, not a
choice made here: the same code measured a ~45× spread between an idle
workstation and a CI runner. A slow runner moves the figure; only a change of
complexity class trips a gate.

Run them alone, with figures:

```bash
cd lucida-web && npx vitest run src/hud/hudCost.perf.test.ts --silent=false --reporter=verbose
```

## What CI cannot measure

The draw gate issues calls to a recording context, so it times the layout and
the calls, not the rasterizer. The pixels' cost belongs to the A/B below,
which needs a hardware adapter.

### The A/B at device pixel ratio 2

The same shape as the recorder's: a warm re-open of a large three-dimensional
fixture, ten seconds of orbit, rendered frames counted, once with the HUD
hidden and once with it shown, at device pixel ratio 2. The HUD's
contribution is the difference. Because the HUD draws four times a second
and the render loop draws up to sixty, the expected difference is inside the
run-to-run noise, and a measured difference outside it is a finding.

Steps, on a host with a hardware adapter:

1. Open the fixture in a browser at device pixel ratio 2 and wait for
   quiescence.
2. Record ten seconds of orbit with the HUD hidden, and note the rendered
   frame count the frame counter reports.
3. Show the HUD with the `h` key, or the **HUD** toolbar control, and repeat
   the same orbit.
4. Record the two frame counts in the ledger below with the adapter, the
   build, and the date.

## Ledger

| Term | Figure | Source |
| --- | --- | --- |
| Model tick, 60 ticks in the history | 6.0 µs p50, 13.9 µs p95 | the CI gate, one host, 2026-09-09 |
| Draw tick, 1,000 px strip at ratio 2, about 570 context calls | 12.4 µs p50, 23.2 µs p95 | the CI gate, one host, 2026-09-09 |
| Sample over 30,000 rows against over none | 1.3 µs against 2.8 µs p50 | the CI gate, one host, 2026-09-09 |
| Lane scan at the 4,096 cap | 78 µs p50, 136 µs p95, under a parallel test load | the CI gate, one host, 2026-09-09 |
| Frame throughput at device pixel ratio 2, HUD shown against hidden | not yet measured | the A/B above needs a hardware adapter |

The timed rows are the logged figures from the gates on the host the change
was built on, without a GPU, and are here to give the ceilings a scale. Read
the `[#1061]` lines in the test output for the current numbers.
