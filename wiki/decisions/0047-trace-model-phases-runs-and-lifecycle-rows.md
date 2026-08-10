---
type: Decision
title: "Trace model: phases, runs, and lifecycle rows"
description: "What the pipeline performance monitor records: a stage is a phase between ownership handoffs, a run is a labelled interval in a continuous buffer, and the unit of record is a fixed-width per-chunk lifecycle row plus per-tick aggregates."
tags: [lucida, decision]
source_path: wiki/decisions/0047-trace-model-phases-runs-and-lifecycle-rows.md
created: 2026-08-10
modified: 2026-08-10
---

# Trace model: phases, runs, and lifecycle rows

Status: Accepted

Context: issue [#886], under the [#885] map. Measurements from [#888] (event
rates and volumes), [#899] (remote rates and latency), [#897]
(`docs/research/timer-resolution.md`). Format choice from [#887].

[#885]: https://github.com/aelefebv/lucida/issues/885
[#886]: https://github.com/aelefebv/lucida/issues/886
[#887]: https://github.com/aelefebv/lucida/issues/887
[#888]: https://github.com/aelefebv/lucida/issues/888
[#897]: https://github.com/aelefebv/lucida/issues/897
[#899]: https://github.com/aelefebv/lucida/issues/899

## The situation

The monitor has to answer one question — *where and when did the pipeline stall*
— and nothing in the codebase can answer it today. Every existing instrument is
a gauge: a value right now, with no memory of when. `pipeline/fetch/telemetry.ts`
keeps counters and a rolling 100-sample decode window; `pipeline/upload/telemetry/*`
keeps 1-second aggregates; `debug/debugStats.ts` is a flat sink polled by a panel.
No span, no trace id, no start/end pair attached to any chunk exists anywhere in
`lucida-web/src`.

Three terms have to be fixed before anything else in the map can be specified,
and each of them is hard to reverse because it decides the shape of the artifact
every other surface reads. That artifact is singular by design: the visual
timeline and the agent diagnostic are two readings of the same bytes, per
[surface parity](../principles/surface-parity.md) and
[agent-first access](../principles/agent-first-access.md). A model that is
convenient for one surface and lossy for the other is disqualified before any of
the trade-offs below are weighed.

## A stage is a phase, not a place

**A stage is a phase a unit of work passes through, delimited by a handoff where
ownership or identity changes.** The inventory is a closed enum. Thread and
process are a *separate* dimension, and `lane` (main / minimap / label) and
`residencyTier` (detail / coarse) are attributes carried on the record.

The tempting alternative — a stage is a directory — was rejected because those
directories are the least stable thing in the repo. Four ADRs
([0029](0029-planning-index-split-into-per-concern-files.md),
[0032](0032-cpucache-split-into-pipeline-fetch.md),
[0034](0034-orchestrator-split-into-pipeline-upload.md),
[0035](0035-gpu-worker-split-into-renderer-subdirectories.md)) are reorganisations
of exactly the directories the ticket proposed as the stage list. A trace whose
vocabulary is a path list would need renumbering every time the code is tidied,
and traces recorded before the tidy would stop comparing.

The third candidate — a stage is a lane of concurrent work — was rejected because
lane is orthogonal: the same phase sequence runs for main, minimap and label
lanes, and folding lane into stage identity multiplies the enum without adding a
distinction the timeline needs.

Keeping thread as its own dimension is what makes wasm a non-question. Planning
partly runs in Rust-in-browser (`lucida-core`), which [#885] listed as possibly a
third timing source; under this model it is the `plan` phase on the main-thread
track, because it is synchronous FFI with no ownership handoff.

## A run is a labelled interval in a continuous recording

**Recording is continuous; a run is an interval within it, opened by a cause and
closed by quiescence or explicitly.** Both halves are needed and they are not in
tension once layered this way.

[#885] settled that recording is on by default and that the live view is "the
trace so far". [#888] measured that an idle viewer emits nothing at all — the
render loop is dirty-driven — so a continuous buffer costs nothing at rest. But a
run also has to have a start, a duration and a shape you can inspect afterward,
which a pure rolling window does not give you.

Layering them means an interaction run (pan / zoom / orbit / scrub) is the *same
object* as a dataset-open run, distinguished only by its cause, and steady-state
residency is simply the buffer between runs. It also means the vocabulary already
exists and should be reused rather than reinvented: the epoch-diff causes
(`content` / `layout` / `view` / `selection` / `asset`) and
`renderLoop.setDirty(kind, source)` are the closest thing the code has to a causal
root, and `SceneEpochs` is already stamped on in-flight metadata, cache entries,
deliveries and every worker message.

A rolling window with no run boundary was rejected: without an explicit end you
cannot say "this open took 5.8 s", cannot diff run-over-run to prove a fix, and
cannot give the agent surface a bounded thing to summarise.

## The unit of record is a lifecycle row, in two tiers

**Tier one is one fixed-width row per chunk, with a timestamp slot per phase
boundary. Tier two is per-tick aggregates per stage. Rare events (eviction,
rejection, retry, failure, dataset-open) are point events.**

The decisive point is that the per-chunk tier is a *row*, not a list of spans.
[#885] recorded this as an open tension: [#887] chose Chrome Trace Event JSON at
roughly 189 B per event, while [#888] measured columnar records at roughly 13 B —
43 MB against 3 MB for a minute at 3,800 events/s. A chunk that passes six phases
costs six span objects (~1.1 kB) or one row of six numbers (~48 B). On [#888]'s
expensive case — warm re-open, 2,559 chunks — that is ~2.9 MB against ~120 kB.

The tension dissolves rather than being traded off: **the in-memory model is a
lifecycle table and Chrome Trace Event JSON is a projection produced at export.**
A row fans out into its spans only when serialised, so [#887]'s format choice and
[#888]'s size measurement both survive intact. Letting the export format dictate
the in-memory representation was the failure mode [#885] explicitly warned against.

Two costs come with this and are accepted:

**Identity.** `chunkKey` (`"level/t/c/z/y/x"`) survives planning through render but
is not unique on its own — the same key legitimately exists twice under two
residency tiers, and every stage wraps it in a different composite namespace
(scheduler, wire, upload sent-state, worker atlas slot each build their own).
`entityId` and `imageId` are different namespaces that coincide only for
single-image datasets. A globally unique row key is approximately
`(datasetId, entityId, imageId, c, residencyTier, chunkKey)`.

**Decode correlation.** The decode worker is the one stage with no identity at
all: it exchanges a pool-local integer and raw bytes, and the chunk key survives
only in the caller's promise closure. Threading a correlation id through
`pipeline/fetch/decodePool.ts` is cheap — the caller already holds the key — but
it is a code change, not pure instrumentation.

## The server is a second table, joined at export

**Each side keeps its own lifecycle table with its own phase enum, and they are
joined after the fact on a correlation id — never on the wire.**

The wire gives us almost nothing to work with. A chunk request carries only
dataset, image and key; there is no request id anywhere in the protocol; and the
binary response frame is a fixed layout with no spare bytes. The correlation id
therefore travels *outbound only*, as an optional field on the request — the
control messages are `serde_json` and optional-field-with-`skip_serializing_if`
is already the house pattern, so this is free and leaves the binary frame
untouched.

The join is deliberately **many-to-one**: several browser rows can point at one
wire request, because the client coalesces duplicate in-flight fetches. That is
not an artifact to be cleaned up. The detail and coarse tiers are independent
residents with separate budgets and separate eviction
([0039](0039-chunk-only-coarse-detail-residency.md),
[0041](0041-clean-two-source-chunk-tier-renderer.md)), the scheduler key
distinguishes them but the wire key does not, and level clamping makes the two
tiers coincide routinely on shallow pyramids. The schema states the cardinality
rather than implying one fetch per chunk.

Two exclusions are on purpose. Socket write time is **not** a server phase: it
happens in a separate task behind an unbounded queue, so it is not observable
from the serve path. And the server's own phase enum stops at enqueue.

## What earns a timestamp

**A phase gets a slot only if its typical duration clears the platform clock
floor.** [#897] measured a hard 100 µs floor in both the main thread and workers,
and its standing guidance is never to emit a sub-floor reading as a duration.
Cache admission and worker dispatch are plainly below it; timing them records
quantisation noise wearing the costume of data. Those phases are counted, not
timed, in tier two.

Slots hold **microsecond offsets from run start as uint32**, not absolute
timestamps. Four bytes each, about 71 minutes of range, and the reading is
quantised to 100 µs regardless — which is what keeps a row near 32 bytes and the
expensive case under 100 kB.

**Workers do not timestamp themselves in v1.** No worker in the codebase calls
`performance.now()` today, there is no `timeOrigin` reconciliation anywhere, and
[#897] deliberately left COOP/COEP unset — so worker-side timing would be the
first code here to depend on cross-context clock alignment, for a breakdown we do
not yet need. Instead the main thread brackets the round trip: postMessage out,
onmessage in. The consequence is that the measurement includes worker queue wait,
which [#899] suggests is the larger and more interesting half — but the field is
named for the round trip, not for CPU time, so that no future reader
misattributes it.

## Overflow truncates the run; it does not drop the oldest rows

The reflex policy for a bounded buffer is a drop-oldest ring. **For the per-chunk
table that is the actively wrong choice**: the beginning of a run is the
diagnostic payload, and discarding it silently yields a trace that looks complete
while having deleted the stall being investigated. On overflow the run stops
recording and is marked truncated. Point events and per-tick aggregates keep
drop-oldest rings, because those are steady-state streams with no privileged
start.

The per-chunk tier is **complete, not sampled**. At row sizes this small the
expensive case fits many times over, so sampling saves nothing and costs the
ability to name the chunk that stalled.

## Dataset-open metadata reads are the third table

One row per metadata object read, server-side, with its own short enum. [#885]
listed this as unspecified on the grounds that the reads bypass the source cache
and are unmeasured; that is no longer true
([0046](0046-dataset-open-reads-through-the-source-cache.md)) and the funnel it
created is exactly the hook point. They remain the single slowest phase of a
remote open by a wide margin, so this is the cheapest coverage in the map
relative to the time it explains.

## Rare events are point records with borrowed reason codes

Retries and rejections are the least-understood part of the pipeline precisely
because they have never been caught happening — [#899] observed zero retries and
zero real failures across 3,781 remote reads, so `pipeline/fetch/retry.ts` and
`pipeline/fetch/rejection.ts` have never executed under measurement.

The temptation is to design a rich surface for behaviour nobody has seen. Instead
they are ordinary point events sharing one shape — time, kind, the chunk identity
if there is one, a short reason code — and their diagnostic value is simply that
they *appear*. The reason vocabulary is borrowed, not invented: the typed fetch
error taxonomy ([0033](0033-typed-fetch-error.md)) and the renderer's chunk
feedback reasons already enumerate the cases, and a second parallel vocabulary
would drift from them.

## A run is a saveable artifact, and its header is what makes it comparable

A run exports as one self-describing file. Saving is only worth anything if the
file records the conditions that produced it, so the header carries the dataset,
the build, the GPU, the **device pixel ratio**, viewport size, cache warmth and
the run cause.

Device pixel ratio earns its place by history: DPR-1-only verification has hidden
whole defect classes in this project more than once, and two runs at different
DPR are not comparable. A header that omits it will not stop anyone comparing
them — it will only stop them noticing. Building the diff itself belongs to a
later ticket; the header exists so that the diff is possible at all.

The header carries **one integer schema version**. Traces outlive the code that
wrote them, and a file from two releases ago should either load or fail clearly.
Versioning individual rows was rejected: it pays per-row overhead for a fact that
is constant across the file.

## Consequences

- The trace artifact is a table, not a log. Its size is set by chunk count, not
  by phase count, which is what makes always-on recording affordable.
- Adding a phase widens every row. The enum should be settled deliberately rather
  than grown ad hoc.
- The Chrome JSON serialiser is the only place that knows about spans, so
  swapping the export format later is a local change.
- Two small instrumentation gaps become prerequisites rather than nice-to-haves:
  a correlation id threaded through the decode pool, and a counter on wire-level
  coalescing, which nothing measures today.
