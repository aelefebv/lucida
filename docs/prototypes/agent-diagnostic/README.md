# PROTOTYPE — the agent-facing diagnostic output

Throwaway prototype for [#893](https://github.com/aelefebv/lucida/issues/893), under the
[#885](https://github.com/aelefebv/lucida/issues/885) pipeline-performance-monitor map.
Prerequisite: [ADR 0047 — trace model](../../../wiki/decisions/0047-trace-model-phases-runs-and-lifecycle-rows.md).

**The question.** What exactly does an agent read, and what does it say? Write the actual
text an agent would get back from a real dataset open, and react to it.

**Everything here is throwaway.** The value is in [SAMPLES.md](SAMPLES.md), in the six
decisions below, and in what writing the samples changed. The code exists to make the
samples real rather than imagined; it is not a proposal for how to build the thing.

## Run it

```bash
node prototype/cli.mjs                                   # list the runs
node prototype/cli.mjs remote-cold-open                  # the default agent output
node prototype/cli.mjs remote-cold-open --depth stages   # the rollup layer
node prototype/cli.mjs remote-cold-open --json           # the same document as JSON
node prototype/cli.mjs --all                             # everything
node prototype/selfcheck.mjs                             # 29 assertions about the above
node prototype/build-samples.mjs                         # -> SAMPLES.md
node prototype/build-html.mjs                            # -> samples.html, double-clickable
```

No dependencies, Node 24; the commands are relative to this directory.
[SAMPLES.md](SAMPLES.md) and `samples.html` are generated — do not hand-edit them.
`samples.html` is the shareable single file the `/prototype` skill asks for, not a stab at
the visual timeline, which is [#892](https://github.com/aelefebv/lucida/issues/892).

## What is real and what is not

Five runs are synthesized. Per-request latency, queue waits, chunk counts, limiter caps
and probe rates come from the measured tables in
[#888](https://github.com/aelefebv/lucida/issues/888) (`docs/research/trace-volumes.md`,
branch `research/trace-volumes`) and
[#899](https://github.com/aelefebv/lucida/issues/899) (`docs/research/remote-rates.md`,
branch `research/remote-rates`).

| tag | meaning | examples |
| --- | --- | --- |
| **[M]** | percentile points quoted from a research table | permit wait p50 467 ms, TTFB p50 199 ms, queue wait p50 8.8 s, 36 chunks on a cold open, 21,370 probes/scan (measured in #899 §2, which confirmed #888 §4.1's extrapolation from a measured 384/scan) |
| **[I]** | interpolated between quoted points | p90/p99 of decode, upload, plan rebuild |
| **[S]** | invented, because the research marks it **[U]** | the dataset-open read count, local-disk per-request latency, main-thread µs per seed-scan probe, the inflated wire latency in `interaction-orbit` |

Every **[S]** value is declared in the run header and surfaces as a coverage gap in the
rendered output, so no sample quietly passes off an invention as a measurement.

The five runs:

| run | what it is for |
| --- | --- |
| `remote-cold-open` | the headline case: a 21,371-member remote collection where the bottleneck is **not in the chunk pipeline at all** |
| `remote-warm-reopen` | saturation: 20,620 queued behind 24 in flight, and the run never finishes |
| `local-cold-open` | a healthy run — what the default must look like when nothing is wrong |
| `interaction-orbit` | double degradation: no completion event **and** no server rows |
| `interaction-seedscan` | the cost is main-thread work in a stage that has no per-item rows by design |

---

## The six decisions

### 1. The default output

**Leads with a verdict sentence, then run identity, then coverage, then at most three
ranked findings, then the commands that go deeper.** Budget: **≤ 30 lines, ≤ 3 kB** — the
selfcheck fails the build if a sample exceeds it. Measured across the five runs: **1,565–2,224 bytes, 19–26 lines**.

The first line is a complete answer on its own:

```
lucida trace r-3f2a9c — VERDICT: open.read held 7.12 s (91% of the run)
```

An agent that reads only that line has learned the actionable thing. Everything after it
exists to justify, qualify, or drill in. Nothing per-row appears at any point.

Two lines are unconditional, present even when they are boring:

- **`coverage`** — how much of the run's wall clock is accounted for, and what is missing.
- **`NOT A HEALTH SIGNAL`** — the zero counters, explicitly labelled as not-evidence.
  [#899 §8](https://github.com/aelefebv/lucida/issues/899) recorded zero retries, zero
  failures and zero evictions *while the pipeline ran 20,000 requests behind*. A report
  that prints those zeros without that label is actively misleading.

The `next` block prints exact commands rather than describing what is available, because
the thing reading it is a process that runs commands.

### 2. What counts as a stall

**Three families, because one number provably cannot serve this pipeline.** [#899 §3]
measured p50 network first byte at 98 ms and p50 scheduler queue wait at 4,600 ms — a 47×
spread between two things a single "slow" threshold would have to cover.

| family | applies to | rule | why this number |
| --- | --- | --- | --- |
| **absolute ceiling** | I/O and compute phases, whose distributions are tight | phase p95 over a fixed ceiling | ceilings clear the *worst p95 observed across the measured runs*, with margin — TTFB 500 ms against a worst p95 of 258 ms, body 1,000 ms against 374 ms, wire 1,500 ms against 1,230 ms. Deliberately **not** set above the worst single observation (body max was 1,485 ms): a lone 1.5 s payload in 3,781 reads is exactly the tail this rule should catch once it stops being lone |
| **backlog ETA** | queue phases, which get **no** per-chunk ceiling | pending ÷ observed drain rate > 2 s | at a measured p50 wait of 4.6–13.6 s, any per-chunk queue ceiling fires on every row or on none. Depth alone is not the signal either — 20,000 pending drains fine at 10,000/s. The ratio is the wait a newly planned chunk will actually see |
| **relative share** | anything on the critical path | ≥ 30 % of the run **and** ≥ 250 ms | share alone flags every fast run — see below |
| *comparative* — **specified, not implemented** | run-over-run | only calls a regression above **2×** | [#899 §0] measured two runs of the same fixture minutes apart differing ~2× in per-request latency. A tighter comparative threshold reports weather |

The ruleset ships inside the document with each rule's rationale attached, so an agent can
see what fired, what the threshold was, and where it came from — and so changing a
threshold is visible in the output rather than buried in a constant.

### 3. How a bottleneck is attributed

**Not a `max()`.** Overlapping concurrent work makes summed stage time meaningless as a
blame signal: in `remote-cold-open`, `open.ttfb` has by far the largest total (41.6 s
across 200 concurrent reads) and is *not* the answer. The rollup therefore reports totals
next to an explicit **overlap factor** and never calls a total a share.

Five mechanisms, tried in order, each naming its own confidence:

| # | mechanism | confidence | when |
| --- | --- | --- | --- |
| 0 | chain leader is time before the first row | `partial` | nothing recorded it; no stage can be blamed |
| 1 | limiter pinned at cap with a backlog, no target event | `resource-limited` | the saturation case |
| 1b | no path available, but a percentile ceiling was crossed | `rollup-only` | interaction runs |
| 2 | an aggregate-tier stage rivals the chain leader, or leads an interaction run | `aggregate-only` | stages with no per-item rows by design — the minimap seed-scan is `O(members x coarse chunks)` at 213,710 probes/s, which #888 §4.1 shows cannot afford a row per item |
| 3 | critical path back from the target event | `attributed` | the normal case |
| 4 | top two segments within 1.25× | `contended` | reported as a set, never a winner |

Five of the seven confidence words are exercised by a sample: `attributed`,
`resource-limited`, `rollup-only`, `aggregate-only`, and `partial` on the healthy run.
`contended` and `unattributed` are specified but have no sample — nothing in the measured
data produces a genuine tie, and a fabricated one would prove nothing.

The critical path is a genuine back-walk: run start → dataset-open span → plan → the
phases of the row that finished last, with the server row spliced in where it joined. A
queue segment that leads is **never** reported as "queue wait" — it resolves to the
limiter behind it ("`client.scheduler` pinned at its cap of 24 for 80 % of the run"),
which is the difference between a symptom and a cause.

Degradation is stated, not implied. Every non-`attributed` verdict carries a `degraded:`
line saying what could not be determined, and the confidence word is on the first screen.

### 4. Layering

**One document, three depths, reached by separate requests.**

| depth | command | size | contents |
| --- | --- | --- | --- |
| default | `lucida trace <dataset>` | 1.57–2.22 kB | verdict, run, coverage, ≤3 findings, next |
| rollup | `lucida trace show <runId> --stages` | 3.4–4.6 kB | + critical path, per-stage percentiles, limiters, aggregate stages |
| raw | `lucida trace export <runId> --format chrome` | file on disk | Chrome Trace Event JSON, per ADR 0047 |

`--stage <phase>` — a fourth, per-row layer — appears in the samples' `next` block but is
**not built here**; the CLI says so rather than pretending. Its shape is listed under what
this prototype does not settle.

Raw rows are **never** inlined into an agent's output at any depth — the export prints a
path, not the bytes. A warm re-open of the remote collection is 21,431 rows; there is no
depth at which printing those into a context window is the right move.

The depths are projections of one document, not three documents. The default JSON is
`summaryProjection(doc)`: the same object with the deep sections dropped.

### 5. JSON and text

**The text is a rendering of the JSON.** One renderer, one document — the map's stated
preference, confirmed. Two qualifications the sample forced:

- **Parity is one-directional.** Every number in the text exists in the JSON; not every
  JSON field appears in the text. Field-for-field identity would make the text unreadable
  or the JSON impoverished. The renderer records the JSON path behind every number it
  prints, and `selfcheck.mjs` asserts both halves: no invented numbers, no dangling paths.
- **Text is the default for agents, not JSON.** The default JSON is **2.6× larger** than
  the default text for identical content (4,137 B vs 1,569 B on `remote-cold-open`), and
  the text already carries the units and the caveats inline. JSON is for programs that
  will index into it, not for a model that will read it.

### 6. Honesty about gaps

A `coverage` block is emitted on **every** run, including clean ones. It carries:

- **accounted wall clock** — `7.86 s of 7.89 s accounted (100%)`. One number that catches
  most silent partial pictures.
- **gaps**, each flagged `couldHideBottleneck`. When any gap is so flagged, the verdict
  line itself carries `[coverage incomplete — see gaps]` — the caveat travels with the
  headline, not three sections below it.
- **structural limits**, which never go away and are stated anyway: client-side TTFB does
  not exist (the transport delivers one whole frame per chunk), and `decode.roundtrip` is
  a main-thread bracket that includes worker queue wait rather than worker CPU time.
- **counted-not-timed phases** — `cache.admit` is below the 100 µs clock floor
  ([#897](https://github.com/aelefebv/lucida/issues/897)) and is counted in the per-tick
  tier instead of being given a fake duration.
- **the not-health-signals**, as above.

Truncation, drop-oldest ring losses, a run that ended by cutoff rather than quiescence,
partial server joins, and synthesized inputs all appear here as named gaps.

---

## What writing the samples changed

The point of the exercise. Seven things were wrong, or missing, before a sample existed.

1. **A share threshold with no absolute floor fires on healthy runs.** The first version
   of `local-cold-open` — a 5.44 GB volume, 37 chunks, first render inside 350 ms, nothing
   wrong with it — reported
   `STALL fetch.wire, 70% of the run`. A fast run still spends most of itself *somewhere*.
   The floor (250 ms) is now part of the rule, and a selfcheck asserts the healthy run
   fires nothing. This is exactly the failure the ticket predicted for thresholds picked
   in the abstract, and it took a sample to see it.

2. **The critical path has to include the time before the first row.** 298 ms of the
   368 ms local cold open happens before any instrument exists — shell boot and wasm init.
   (#888 measured that run's first render at 378 ms from navigation; the sample lands at
   343 ms, and the 298 ms boot is [S].)
   The chain originally began at the first row and reported `100% accounted`, which was a
   lie about 87 % of the run. There is now an explicit `unrecorded prefix` segment that can
   never be blamed for a stall (nothing measured it) but always shows up as a coverage gap.
   The most useful output in the whole prototype is that run's verdict: *no stall found,
   and 87 % of this run is not covered by any instrument.*

3. **Interaction runs have no critical path at all, and that is not an edge case.** A pan
   does not finish. Half of what #885 wants to record has no target event to walk back
   from, so a second attribution mode (`rollup-only`, ranked by percentile) is load-bearing
   rather than a fallback.

4. **A stage with no rows can still be the answer, and it needs its own verdict word.** The
   minimap seed-scan is the highest-frequency thing in the system and is recorded as
   per-tick aggregates precisely because a per-item row there is a six-figure-per-second
   write. `aggregate-only` says the stage held the main thread without claiming it sat on
   anyone's critical path — a claim the data cannot support.

5. **The headline case's bottleneck is outside the chunk pipeline.** `remote-cold-open`
   blames dataset-open metadata reads for 91 % of the run. A monitor scoped to
   planning → fetch → decode → upload → render would have led with `fetch.wire` at 5 %.
   #885 lists dataset-open read coverage under "not yet specified"; on this evidence it is
   not optional, it is the thing the first sample is about.

6. **"Which side was slow" is a question the monitor can fail to answer, and it should say
   so in those words.** With server rows absent, `fetch.wire` is one opaque bracket around
   our own permit queue *and* the network. `interaction-orbit` reports the number and then
   states that the split is unavailable and why. Silently attributing an unsplit bracket to
   "network" would be the single most misleading thing this tool could do — [#899 §3] found
   over 90 % of a chunk's life is in our own queues.

7. **Reporting only the loudest chokepoint teaches the reader the others are fine.**
   [#899] found two pinned limiters. The report now carries a `NOTE` for a limiter that is
   pinned at cap but not the binding constraint, rather than omitting it.

## What this prototype does not settle

- **The per-row layer.** Only the default and the rollup were prototyped. What
  `--stage <phase>` prints — how many rows, sorted how, capped how — is unwritten.
- **Where a baseline lives.** The comparative threshold is specified (2×) but nothing here
  stores or resolves a previous run for a dataset.
- **The drain-rate window.** Backlog ETA divides by an observed completion rate; over what
  window that rate is measured changes the answer during a burst.
- **These thresholds are provisional by construction.** They are derived from
  *throwaway-instrumented* research runs on one machine and one link. The first real traces
  should re-derive every ceiling; the ruleset is versioned in the document so that is a
  visible change rather than a silent one.
- **Python parity.** `lucida-py` presumably renders the same document; not prototyped.
