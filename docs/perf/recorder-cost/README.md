# The recorder's cost contract: gates, harness, and ledger

Issue [#928], under the [#921] spec, enforcing [ADR 0049][0049].

[#888]: https://github.com/aelefebv/lucida/issues/888
[#898]: https://github.com/aelefebv/lucida/issues/898
[#918]: https://github.com/aelefebv/lucida/issues/918
[#919]: https://github.com/aelefebv/lucida/issues/919
[#921]: https://github.com/aelefebv/lucida/issues/921
[#928]: https://github.com/aelefebv/lucida/issues/928
[#949]: https://github.com/aelefebv/lucida/issues/949
[0049]: ../../../wiki/decisions/0049-unconditional-recording-under-a-design-budget.md
[0052]: ../../../wiki/decisions/0052-debug-surface-dispositions.md

Recording is unconditional and there is no toggle at any scope, so the
recorder's cost is a contract rather than something a user can opt out of.
[ADR 0049][0049] makes that contract a set of CI-asserted ceilings rather than
a runtime governor: a governor would make the monitor instrument itself
continuously, and would make the cost emergent when the model is deterministic
by construction.

Three of the four gates run on every CI job. The fourth needs a GPU, a server
and a real fixture, so it lives here as a harness.

This lives under `docs/perf/` rather than beside the `docs/research/*-harness/`
directories it borrows its shape from. Those are snapshots: tooling that
produced one document's numbers, quarantined patch and all, and not expected to
run again. This one is a standing obligation — it is re-run whenever the
recorder's write path changes shape, and it carries a ledger that outlives the
issue that created it.

## The gates that run in CI

`lucida-web/src/trace/recorderCost.perf.test.ts`, part of `pnpm test`:

| Gate | Ceiling | Asserted as |
| --- | --- | --- |
| Amortised per-event cost | ≤ 100 ns | < 1,600 ns at every burst size |
| Flat in events-per-tick | 1, 8, 128, 2,943 events/tick | the same per-event ceiling at every size |
| Worst-case tick | ≤ 250 µs for a 2,943-chunk submit | < 9,600 µs, i.e. 16× the ~600 µs measured (see the finding below) |
| Zero steady-state allocation | no reallocation after warmup | sink buffers identical + gc-bracketed heap delta |
| Net non-regression | ≤ 1.05 MB live, ≤ 1–3 µs/tick | a 2,560-chunk run's live bytes and a typical tick |

**They are tripwires, not benchmarks.** Absolute timings vary widely across
machines and CI runners, and a ratio-based perf assertion in this repo already
flakes (the #906 upload-telemetry guard). Every gate therefore asserts an
absolute bound at 16× and logs the real figure; read the `[#928]` lines in the
test output for the numbers. The assertions fire on a change of complexity
class, not on a slow runner.

**On that 16×.** The width is a finding rather than a fudge: the 2,943-chunk
burst measures **75 µs on an idle workstation and 3.4 ms on a GitHub runner**,
a ~45× spread on identical code — a microbenchmark of a few-microsecond tick
is dominated by whatever else the host is doing. At the 4× this shipped with,
the worst-tick and net-non-regression gates failed on every CI run: a gate
reporting the runner rather than the code, which is the #906 flake this file
says it must not become. The worst-tick gate is also based on the ~600 µs the
tick actually costs rather than on the 250 µs ceiling it knowingly exceeds,
because a gate has to be able to pass on a green build. 16× still catches the
shape these gates exist for by two orders of magnitude — the `Array.shift()`
regression was ~800×.

Flatness is asserted by holding *every* burst size to the same per-event
ceiling rather than by comparing sizes to each other. That is deliberate: a
ratio gate flakes, and the failure this exists to catch — `UploadTelemetry.publish`
going 1.4 µs to 1.13 ms between 1 and 128 events per tick because it pruned
with `Array.shift()` in a loop ([#888], filed as [#898]) — blows an absolute
per-event ceiling at the large burst long before anyone notices it at the
small one.

Run them alone, with figures:

```bash
cd lucida-web && npx vitest run src/trace/recorderCost.perf.test.ts --reporter=verbose
```

### Finding: the tick ceiling assumed one write per chunk

Measured on an M-series laptop under Node 22, the 2,943-chunk submit burst
costs **~540 µs**, against [ADR 0049][0049]'s 250 µs ceiling. The per-event
number is *inside* budget at ~61 ns; what is over is the number of events.

The ADR derived the tick ceiling as `2,943 chunk requests × 100 ns`, i.e. one
recorded event per chunk. The dispatch path as built emits **three** write
calls per chunk — `beginChunkRow`, `stampAdmission`, `stamp(WireStart)`, all in
one breath in `cpuCache.fetchAndDecode` — because the row is born at dispatch
with the two phases behind it already over. Three times 2,943 times ~61 ns is
~540 µs.

Tracked as [#949]. Two ways out, neither of which belongs to [#928]:

1. **Collapse the dispatch calls.** `beginChunkRow` could take the admission
   stamp and the wire-start boundary directly, making row birth one call
   instead of three and removing two handle round-trips (`resolve`, the
   generation divide, the modulo) per chunk. That is an emit-site change in
   `cpuCache`, and it would land the tick near the derived ceiling.
2. **Re-derive the ceiling.** 250 µs was arithmetic on an event model that the
   implementation did not adopt. Three writes per chunk against the ~120
   ticks/s ceiling is ~6.5% of a tick rather than 3%.

Until one of those happens, the run prints its ratio against the 250 µs
ceiling on every CI job — `OVER the 250µs ceiling by N.Nx` wherever the host is
slow enough to show it — so the breach is loud rather than quietly encoded as
passing.

## The A/B that cannot run in CI

[ADR 0049][0049]'s observer-effect claim is that the recorder is
*unrepresentable* at the platform's 100 µs clock — a stronger claim than "small"
— and the only honest way to check it is a throughput comparison of the real
sink against a no-op sink. [#888] ran that exact shape against the debug panel
over a warm re-open at devicePixelRatio 2 and measured **1,148 rendered frames
in ten seconds either way**. That is the number to beat.

### Measured, 2026-08-11

| Arm | Frames in 10 s | fps | Warm first render |
| --- | --- | --- | --- |
| real sink | 1,133 | 112.9 | 148 ms |
| no-op sink | 1,144 | 114.2 | 207 ms |

**1.0% apart, inside the 5% band — the recorder is not visible in frame
throughput**, and both arms sit within 1.3% of [#888]'s 1,148. Driven at
devicePixelRatio 2 over a warm re-open of a 251 MB local OME-Zarr dataset,
release server, system Chrome with WebGPU, on an M-series laptop.

The two arms are the same tree twice, differing only by the patch below; the
no-op arm keeps the branch, the argument evaluation and the seam, which is the
cost a user actually pays. Re-run it when the recorder's write path changes
shape — collapsing the dispatch calls in [#949] would be such a change.

There is no runtime switch to flip, by design, so the two arms are two builds:
the tree as it is, and the tree with `noop-sink.patch` applied. The patch
substitutes `noopSinkFactory` into the module singleton and nothing else — the
branches, the argument evaluation and the seam all stay, which is the cost a
user actually pays.

```bash
# 0. one release server binary, shared by both arms
cargo build --release -p lucida-server

# 1. arm A — the real sink
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install && pnpm run build && mv dist ../dist-real)

# 2. arm B — the no-op sink
git apply docs/perf/recorder-cost/noop-sink.patch
(cd lucida-web && pnpm run build && mv dist ../dist-noop)
git checkout -- lucida-web/src/trace/recorder.ts

# 3. run both arms against the same fixture, at DPR 2
AB_WEB_DIST=$PWD/dist-real python3 docs/perf/recorder-cost/ab_run.py /tmp/ab <fixture>.zarr real
AB_WEB_DIST=$PWD/dist-noop python3 docs/perf/recorder-cost/ab_run.py /tmp/ab <fixture>.zarr noop

# 4. read the verdict
python3 docs/perf/recorder-cost/ab_compare.py /tmp/ab
```

Pick a real fixture — a multi-GB 3D timeseries or a wide collection. A small 2D
image exercises almost none of the write path, and an A/B over a page that
records nothing proves nothing.

Gotchas, all of which have cost time here before:

- **devicePixelRatio 2 is not optional.** DPR-1-only verification has hidden
  whole defect classes in this project, and at DPR 1 the renderer is a quarter
  of the pixels and a different bottleneck.
- The bundled Playwright Chromium has **no WebGPU**. `ab_run.py` resolves the
  system Chrome; without one it exits rather than measuring a canvas that never
  drew.
- The window is measured over a **warm re-open**, not a cold open: a cold open
  is dominated by the network and would drown the thing being measured.
- The drive is a slow orbit, not an idle page. The render loop is dirty-driven,
  so a still viewer draws nothing and both arms tie at zero.
- `ab_run.py` drops `GOOGLE_APPLICATION_CREDENTIALS` so an object-store fixture
  falls through to the user's ADC rather than a service account with no access.

## The net non-regression ledger

[ADR 0049][0049] states the budget as **marginal** — the recorder alone — so
the number does not move when the debug panel is dismantled. Separately it
takes on a **net** obligation: once that dismantling lands, total observability
cost must be no higher than the floor [#888] measured today. Stating only the
marginal number would let the monitor ship "always-on is free" while doubling
the floor.

This section is that obligation, recorded so the check is arithmetic on
existing numbers rather than a fresh measurement campaign.

| Term | Figure | Source |
| --- | --- | --- |
| Today's floor, live state | ≈ 1.05 MB | [#888] |
| Today's floor, per tick | ≈ 1–3 µs | [#888] |
| Recorder, live state, one 2,560-chunk run | 623 kB | the CI gate, logged each run |
| Recorder, typical tick (8 chunks) | ~2.9 µs | the CI gate, logged each run |
| Recorder, worst tick (2,943-chunk burst) | ~540 µs, over ceiling ([#949]) | the CI gate, logged each run |
| Recorder, frame throughput at DPR 2 | −1.0% vs a no-op sink, inside noise | the A/B above, 2026-08-11 |
| Retention, resident cap | 8 MB | [ADR 0049][0049], a separate granted budget |

Two notes on reading that table:

- **Live state excludes retained history.** [ADR 0049][0049] grants retention
  its own 8 MB resident cap — roughly 65 warm re-opens — explicitly as a spend,
  not as a regression against the 1.05 MB floor. The floor comparison is about
  the instrument's working set: the buffers a run writes into.
- The recorder's figures above are measured with a **whole chunk lifecycle
  forced into one tick**, which the real pipeline never does — wire, decode,
  upload and present land on later ticks as fetches settle. They are therefore
  a pessimistic bound on the marginal per-tick cost, not an estimate of it.

**What has to happen for the obligation to be discharged.** When [#918]
(`debugStats.enabled` and its read sites) and [#919] (`DebugPanel.tsx`) land,
re-run the two measurements below and record the result here:

1. `pnpm test` — read the `[#928] floor check` line for the recorder's live
   state and typical tick.
2. The A/B above, with the arms redefined as *before the teardown* against
   *after it*, comparing total live JS heap at the same point in a warm
   re-open. The floor's 1.05 MB is a heap figure, so heap is what settles it.

The obligation is met when recorder + whatever observability survives the
teardown is ≤ 1.05 MB live and ≤ 1–3 µs per typical tick. It is *not* met by
the marginal gates alone, which is why this ledger exists rather than a comment
in the test file.

**Step 1 recorded, [#918] landed (2026-08-11).** `[#928] floor check: typical
tick (8 chunks, 93 write calls) p50=3.38 µs | one 2,560-chunk run holds 663 kB
live`. What the gate's removal changed about the *shape* of this obligation: it
came out by *deleting* the gauges it guarded, not by making them unconditional.
`debugStats` no longer holds a sink, so the pipeline's own always-on
instrumentation is the recorder and nothing else.

**Step 2 measured on [#919]'s teardown branch (2026-08-11).** With the panel
deleted there is one instrument left to weigh, so the arms are the tree before
the teardown against the tree after it, compared on post-GC live JS heap at the
end of the same drive. Run with `AB_MODE=heap`, which adds a
`Runtime.getHeapUsage` reading over CDP after three forced collections. The two
*before* arms were driven against a bundle built from the pre-teardown tree,
the panel-open one with a click on the toolbar's Debug button — a step that
exists only as long as that button does, so it is not a flag on the harness.
Same fixture, machine and DPR 2 drive as the frame A/B above:

| Arm | Live heap, post-GC | Frames in 10 s |
| --- | --- | --- |
| before, panel never opened | 4.693 MB | 1,151 |
| before, panel open | 5.730 MB | 1,150 |
| after (no panel to open) | 4.713 MB | 1,153 |
| after, repeat — the noise floor | 4.701 MB | 1,154 |

**The panel cost 1.04 MB live while open, and the teardown returns it.** Two
readings make that a result rather than a coincidence: two runs of the same
arm land 12 kB apart, so the 1,037 kB the panel adds is ~85× the run-to-run
spread; and *after* sits 20 kB from *before-closed*, inside that spread, which
is what a lazily-mounted panel should cost a session that never clicks it.
Frame counts are flat across all four arms — this was never a throughput
question.

**Measurement 1, re-run on the same tree**, verbatim from `pnpm test`:

> `[#928] floor check: typical tick (8 chunks, 93 write calls) p50=3.50 µs vs
> #888's 1–3 µs/tick floor | one 2,560-chunk run holds 663 kB live vs the
> 1.05 MB floor (retention's 8 MB cap is a separate, granted budget)`

**Half met, and the half that fails is not the teardown's.** Live state is
**under** the floor: 663 kB against ≈1.05 MB, with the panel's 1.04 MB
returned on top. The typical tick is **over** it — 3.50 µs against a 1–3 µs
band — so by the criterion stated above ("≤ 1.05 MB live **and** ≤ 1–3 µs per
typical tick") the obligation is **not** fully discharged, and saying otherwise
here would be the same "preserved" label over lost ground that [ADR 0052][0052]
exists to refuse.

The tick overage is [#949], not this teardown: the ceiling was derived from one
write per chunk and dispatch emits three, so the figure is ~3× its own
premise. Deleting a reader cannot move it — nothing the panel did was on the
write path. Read the three recorded tick figures as one noisy quantity, not a
trend: ~2.9 µs at [#928], 3.38 µs at [#918], 3.50 µs here, all on a
few-microsecond microbenchmark whose spread across hosts is ~45× (see the 16×
note above), all on the pessimistic whole-lifecycle-in-one-tick shape the real
pipeline never produces. Closing [#949] closes this ledger.

Note what the panel's 1.04 MB was *not*: by [#918] it no longer held a
pipeline-fed sink, so this is a reader's own working set — polled snapshots,
React trees, ten tabs of derived rows at 200 ms — which is why deleting it
frees heap that no always-on consumer was paying for.

**An absorption [ADR 0052][0052] promised that the trace does not yet carry.**
Recorded here rather than left to be discovered, because it is exactly the
failure that ADR names as its reason to exist — *"marking those absorbed would
have deleted real capability under a label asserting it was preserved"*. The
Render row is dispositioned **Absorbed — frame/plan/upload ms, FPS are
temporal**, and the Orch row's **rolling 1s + cold state** likewise. Of those,
[#918] deleted:

- **plan ms and upload ms** per tick (`slicePath.ts`, `volumePath.ts`),
- the **FPS / sticky-max ring** (`renderLoop.frameSamples`), and
- the **cold-state windowed rates and rebuild p50/p95**
  (`ColdStateTelemetry`'s snapshot).

`READING_NAMES` is `["queueDepth", "inFlight", "frameTimeUs",
"residentBytes"]`, so only frame time survives; the per-tick counters are
planning aggregates, not timings. Absorbing the rest means widening the reading
ring, which [ADR 0049][0049] treats as a deliberate spend from a fixed budget
rather than something a teardown may help itself to — so it is named here for
the monitor work instead of taken now. Nothing regressed for an always-on
consumer: none of these ever flowed unless the panel was open. What the churn
detector needs it still counts itself, and it still emits through `orch`.
