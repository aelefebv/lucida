# Trace model: phases, runs, and lifecycle rows

Status: Accepted. Amended by [#1048], which made interactions open runs too.

## Context

The monitor answers one question: where and when did the pipeline stall. Before
it, every instrument in the viewer was a gauge, a value right now with no memory
of when. This record fixes the shape of the one artifact that both the visual
timeline and the agent diagnostic read, so a model that is lossy for either is
out. Volumes come from [#888] and clock resolution from [#897].

## Decision

A stage is a phase a unit of work passes through, delimited by a handoff where
ownership or identity changes. The phases are a closed enum (`PHASES` in
`lucida-web/src/trace/types.ts`). Thread, lane and residency tier are separate
dimensions, carried as attributes on the record. Synchronous wasm planning is
part of the `plan` phase on the main thread, not a third timing source, because
nothing changes hands.

Recording is continuous, and a run is a labelled interval within it. A dataset
open and a pan, zoom, orbit, scrub or select are the same kind of run, differing
only in the cause, which carries the epoch kind and the input kind. A run opens
on the first such cause after quiescence. Inputs while it is open extend it, so
one drag is one run with one duration. It closes after a 500 ms quiescent hold,
or explicitly. The steady-state interval between runs is kept, unlabelled.

The record has three tiers. Each chunk gets one fixed-width row with a timestamp
slot per phase boundary, complete rather than sampled. Each tick gets per-stage
aggregates. Rare events such as eviction, retry and failure are point events
with one shape: time, kind, chunk identity if there is one, and a reason code.
The reason codes are borrowed from the typed fetch error kinds
([0033](0033-typed-fetch-error.md)) and the renderer's chunk feedback reasons,
so a trace and a log line name a failure the same way.

The in-memory model is a table. Chrome Trace Event JSON is a projection made at
export, and its serialiser is the only code that knows about spans. Slots hold
microsecond offsets from run start as uint32, about 71 minutes of range.

The browser clock floor is 100 µs on the main thread and in workers, because the
page is not cross-origin isolated and COOP/COEP stay unset. A phase gets a
timestamp slot only if its typical duration clears that floor. Phases below it,
such as cache admission and worker dispatch, are counted in the per-tick tier,
and no sub-floor reading is ever reported as a duration. Workers do not
timestamp themselves. The main thread brackets the round trip, so `decode` is
named for the round trip, queue wait included, not for worker CPU time.

On overflow the per-chunk table stops recording and marks the run truncated. It
never drops its oldest rows, because the start of a run is the diagnostic
payload. Point events and per-tick aggregates use drop-oldest rings that count
what they drop.

The server keeps its own rows and phase enum
([0050](0050-server-timings-reach-the-monitor.md)), joined to the browser's after
the fact on an id that travels outbound only
([0048](0048-correlating-work-across-the-browser-server-boundary.md)). The join
is many-to-one, because the client coalesces duplicate in-flight fetches.

A run exports as one self-describing file. Its header carries the dataset, the
build, the GPU, the device pixel ratio, the viewport, cache warmth, the run
cause, and one integer schema version for the whole file. Device pixel ratio is
there because DPR-1-only verification has hidden whole defect classes in this
project, and runs at different ratios are not comparable.

## Rejected alternatives

- A stage is a directory. The pipeline's directories have been reorganised
  several times. A vocabulary tied to paths would renumber on every tidy, and
  traces from before a tidy would stop comparing.
- A stage is a lane. The same phases run for every lane, so folding lane into
  the enum multiplies it without adding a distinction the timeline needs.
- Spans in memory, in the export format. A span costs about 189 B in Chrome
  JSON and a columnar record about 13 B, so a warm re-open of 2,559 chunks would
  take about 2.9 MB instead of about 120 kB.
- A rolling window with no run boundary. Without an end you cannot say "this
  open took 5.8 s", diff runs to prove a fix, or give the agent a bounded thing
  to summarise.
- A drop-oldest ring or sampling for chunk rows. A ring deletes the stall under
  investigation while the trace still looks complete. Sampling saves nothing at
  these row sizes and loses the name of the chunk that stalled.
- Worker-side timestamps. They would be the first code here to depend on
  aligning clocks across contexts, for a breakdown nobody needs yet.
- Cross-origin isolation. Setting COOP/COEP gives a 5 µs clock in both contexts
  and does not break the remote data path, but it rules out embedding Perfetto
  in an iframe and handing it a trace by postMessage. Summing quantised readings
  over a phase recovers what the monitor needs on the 100 µs clock, and the
  sub-floor stages are a small share of where the time goes. If a later
  question is the per-call cost of a sub-floor stage, isolation is the lever.
- Per-row schema versions. Per-row overhead for a fact that is constant across
  the file.

## Consequences

Adding a phase widens every row and spends from the recorder's budget
([0049](0049-unconditional-recording-under-a-design-budget.md)).

[#888]: https://github.com/aelefebv/lucida/issues/888
[#897]: https://github.com/aelefebv/lucida/issues/897
[#1048]: https://github.com/aelefebv/lucida/issues/1048
