# The visual timeline surface: prototype findings

Prototype for issue [#892](https://github.com/aelefebv/lucida/issues/892), under map
[#885](https://github.com/aelefebv/lucida/issues/885) (pipeline performance monitor).
Prerequisites [#886](https://github.com/aelefebv/lucida/issues/886)
(ADR [0047](../../wiki/decisions/0047-trace-model-phases-runs-and-lifecycle-rows.md), the
trace model) and [#887](https://github.com/aelefebv/lucida/issues/887) (Chrome Trace Event
JSON) are both settled, so this ticket answers *what the human looks at*, not what is
recorded.

The prototype is `lucida-web/src/debug/monitor-prototype/`, served at
`/monitor-prototype.html` on the dev server. It is throwaway and dev-only — no route in a
production build reaches it. Three structurally different variants of the top-level view,
switchable with `?variant=A|B|C`, over two synthetic runs (`?run=cold|warm`) calibrated to
the measured numbers in [#888](https://github.com/aelefebv/lucida/issues/888) and
[#899](https://github.com/aelefebv/lucida/issues/899).

Every figure below is **[M]** measured on the prototype at **devicePixelRatio 2** (backing
store 3156 × 1124 for a 1578 CSS-px canvas, verified per run) or **[C]** read from code.

---

## The answers, up front

1. **Borrow the raw span wall; build the verdict.** Perfetto renders the per-phase lane
   timeline better than we would, for near-zero build cost — but only if the export uses
   one thread per phase. It cannot append, so it cannot be the live view, and it cannot
   emit a callout.
2. **Callouts first (variant C), with the wall-clock budget table (variant B) below them.**
   Not the span wall. On the run that matters, the wall is a solid orange slab that says
   exactly one thing, and the callout says that same thing in a sentence.
3. **The live view should show progress counters and withhold the verdict**, not
   auto-follow a scrolling timeline.
4. **A separate page, not an overlay in the viewer tab.** Cost of the monitor's own
   rendering is p95 **0.7 ms/frame** [M] for the densest variant, so an overlay is
   affordable — the argument for separation is isolation, not cost.

---

## 1. Build or borrow

**The export loads, completely, and is fully queryable.** [M] `ui.perfetto.dev` (v57.2)
ingested the warm run's export — 3.9 MB, 13,842 slices, 20.976 s — and answered the
worst-stage question exactly, in one SQL statement:

```
select s.name, count(*) n, cast(sum(s.dur)/1e6 as int) total_ms from slice s group by 1 order by total_ms desc
```

| phase | n | total_ms |
| --- | --- | --- |
| queue | 1,500 | 13,471,017 |
| wire | 1,500 | 475,652 |
| permit | 1,413 | 236,718 |
| ttfb | 1,413 | 145,953 |
| body | 1,413 | 79,951 |
| decode | 1,500 | 20,716 |

That is the "worst stage" callout, derived by the borrowed viewer from our bytes. The
derived layer is not a reason to build.

**But the default rendering was unusable, and the fix is in our emitter, not theirs.** [M]
Emitting each chunk phase as an async event pair (`ph: "b"/"e"`, one id per chunk) — the
natural encoding for work that is not a call stack — put everything into a single *Global
Legacy Events* group per process, named after whichever slice happened to arrive first
(`permit`, `plan`), collapsed by default, and several hundred rows deep with every phase
interleaved. The phase was only a slice *name*, so there was no lane to read.
See `timeline-surface-shots/perfetto-6-groups.png`.

Re-emitting with **one thread id per phase plus `thread_name` metadata, as complete events
(`ph: "X"`)** produces named lanes — `wire`, `decode`, `upload`, `present` — with the
counter tracks (`queue depth`, `queue inFlight`, `frame ms`, `frame residentMiB`) rendered
underneath, and the server's phases as a second process.
See `timeline-surface-shots/perfetto-10-final.png`. It is also **smaller**: 2.7 MB against
3.9 MB, because a complete event is one object rather than two.

"Thread" here is a display lane, not a real thread. That is a lie the format requires, and
it is worth paying.

**What borrowing does not give you** [M/C]:

- **No append.** A trace file is opened whole. The live view cannot be Perfetto.
- **~25 s from file-picker to timeline** for 2.7 MB, plus a page load. This is a
  post-mortem tool, not something you glance at.
- **No callouts, ever.** It shows what happened; it will never say which of it mattered.
- **Collapsed by default**: two clicks before any span is visible.

**Conclusion.** Ship "Open in Perfetto" as the raw-span drill-in and do not build variant A.
The lane wall is the one part of this surface that is genuinely free, and the export shape
that makes it free is a small, decided change to the serialiser
(`monitor-prototype/chromeExport.ts` documents it).

---

## 2. What you see first

The three variants disagree about the top-level view, and the warm re-open settles it.

### A — "the wall": every span, lanes over time

`timeline-surface-shots/warm-A.png`. Six browser lanes, four server lanes, a metadata
lane, a queue-depth counter, brush-to-drill.

On the warm re-open the `queue` lane is a **solid orange rectangle** spanning the entire
run [M] — 2,559 chunks planned in one submit, admitted at 82/s, so every chunk is in the
queue for essentially the whole run. That is not a rendering failure; it is the honest
picture, and it is also the whole finding. A slab conveys one bit. The callout conveys the
same bit plus the numbers.

Two defects the wall surfaced that are worth keeping:

- **The wall renders silence over the bottleneck.** On the cold open, the first 3.7 s are
  dataset-open metadata reads, and *no chunk lane can draw them* — the first chunk does not
  exist yet. The initial build showed 3.7 s of empty canvas over the slowest part of the
  run [M]. Fixed by giving the metadata table its own lane
  (`timeline-surface-shots/cold-A.png`); any timeline that omits it repeats the bug.
- **A stamp array cannot distinguish "never entered the next phase" from "entered and
  never left".** They are opposites — one is a chunk that finished its useful life, the
  other is a chunk that is stuck — and drawing them the same way turned the healthy
  `upload` lane into a second false slab. This is a **finding for ADR 0047**: the row needs
  one byte of `endReason` (in-flight / complete / retired) beyond its timestamps.

### B — "the budget": stacked wall-clock first, spans on demand

`timeline-surface-shots/warm-B.png`. One stacked bar of summed chunk-time by phase, a
per-phase table (share, done, still open, p50, p95, worst), the server split joined on the
correlation id, and the timeline only when you open a phase.

This is the most *informative* view per pixel and the one that reads correctly on both
runs: warm says `queue 96%`, cold says `wire 59% / queue 38%`. The still-open column is
what makes it honest — 1,059 chunks never left the queue, and their true wait is unknown.

### C — "the verdict": callouts first, timeline as drill-in

`timeline-surface-shots/warm-C.png`, `cold-C.png`. Severity-ranked callout cards, each
expanding into a timeline scoped to that callout, then a "what this run does not tell you"
section and the #893 agent text rendered from the same derivation.

On the warm run it leads with *queue holds 96% of chunk-time — 1,500 chunks, p50 9.1 s,
p95 17.4 s, worst 18.3 s. This is admission throughput, not the network: rank divided by
rate.* On the cold run the same code leads with *wire holds 59% — 36 chunks, p50 319 ms* and
raises *dataset-open metadata reads took 3.7 s before the first chunk was planned* (148
object reads, all source-cache misses) — the finding that no
per-chunk instrument in the codebase can currently produce.

**Recommendation: C's cards over B's table.** They are not really rivals — C is B with a
sentence on top and the rows folded away. B's per-phase table should be the second section
of C, not a separate design.

**One thing C got wrong.** Its callout reported "worst single wait 18.3 s" while the
drill-in it opened showed a different chunk at 21.0 s, because the rollup excluded rows
that never completed and the drill-in included them clamped to the run end. Unfinished
spans are **lower bounds, not measurements**, and any surface that mixes them silently is
lying by a mechanism nobody will notice. Fixed by leading with the backlog
(*1,059 chunks never left the queue — 14.8 s more to drain at the observed rate*), naming
the worst *completed* wait separately, and drawing unfinished spans faded.

**Thresholds are borrowed, not invented.** The two rules settled by the sibling agent
prototype on `prototype/893-agent-diagnostic-output` are implemented here verbatim, so the
visual and the text cannot disagree about what a stall is: a relative share needs an
absolute floor (250 ms), and queue phases get **no** per-chunk ceiling — backlog is
reported as an ETA of pending ÷ observed drain rate. Only `ioStallUs = 500 ms` is local to
this surface, and it fires only on the metadata table.

---

## 3. How the live view behaves

Three policies, one per variant, and the disagreement is the point:

- **A auto-follows** a 6 s scrolling window and freezes when you brush. It looks alive and
  is nearly useless: the interesting structure of a dataset-open is its *beginning*, which
  has already scrolled away by the time you notice a stall.
- **B ignores the question.** The bar is an aggregate; a run in progress renders the same
  as a finished one, only less certain. Nothing to follow, nothing to freeze.
- **C refuses to answer while recording** — a counter (`2,559 planned / 67 visible /
  2,492 in flight`) and a *Stop & analyse* button, nothing more
  (`timeline-surface-shots/live-C.png`).

**Recommendation: C's shape, with B's bar visible while recording.** C-as-built is too
austere — an empty screen during the run is a worse experience than a live budget bar — but
its principle is right: *the verdict does not appear until the run closes*, because a
verdict that changes while you read it is not a verdict. The live view is progress plus
aggregates; the callouts are a property of a closed run.

This also matches ADR 0047's run model exactly: recording is continuous, a run is a
labelled interval, and closing the interval is what makes it analysable.

---

## 4. Drill-down

Measured in steps from the top-level view to a named chunk:

| variant | steps to the chunk | what carries across |
| --- | --- | --- |
| A | 1 (brush) | a time range; the row list is itself 1,181 rows — a second wall |
| B | 2 (open phase, read the strip) | a phase; spans sorted longest-first |
| C | 1 (open the callout) | the callout's *reason* — phase, and the worst row named in the text |

C wins because the thing that carries across is the *question*, not a coordinate. Its
drill-in is scoped to one phase and sorted longest-first, so the answer is at the top.

A's brush is the only affordance that supports "what happened at 8.8 s specifically", which
neither B nor C can express. That capability belongs to Perfetto, not to a fourth panel.

---

## 5. Where it lives, and what it costs

The prototype is a **separate page** (`/monitor-prototype.html`), which is itself the
recommendation: the monitor must not perturb what it measures, and the cheapest way not to
perturb the viewer's tab is not to be in it.

Cost is not the argument, though — the numbers say an overlay would be affordable [M]:

| | warm run (2,559 chunks) | cold run (36 chunks) |
| --- | --- | --- |
| in-memory columnar table | **184 kB** | 26 kB |
| Chrome JSON export | **2.7 MB** | — |
| variant A render, p95 | **0.7 ms/frame** | — |

184 kB against 2.7 MB is a **15× ratio**, measured on the artifact rather than estimated —
direct confirmation of ADR 0047's decision to keep the table columnar and treat Chrome JSON
as an export-time projection.

The 0.7 ms figure is for the densest variant redrawing every span every frame on a canvas
outside React. It holds only because of how it is built: the replay cursor lives in a ref
read inside `requestAnimationFrame`, React chrome updates at 4 Hz, and no variant re-renders
a component tree per frame. A React tree re-rendering at 60 fps inside the tab it profiles
is the failure mode this number does *not* cover.

---

## 6. Findings that belong to other tickets

- **ADR 0047 / [#886]:** the lifecycle row needs an `endReason` byte. Timestamps alone
  cannot distinguish a retired chunk from a stuck one, and the two render as opposites.
- **[#893]:** the agent text is a rendering of the same derivation (`analysis.ts`) that
  feeds the cards — the map's stated preference for one document with one renderer
  survived contact. Its two threshold rules (absolute floor under a relative share; no
  per-chunk queue ceiling, backlog as an ETA) transfer to the visual surface unchanged,
  which is the strongest evidence yet that both surfaces should share one derivation
  module rather than two.
- **[#887]:** the format decision holds, but the *emit shape* within it decides whether the
  free viewer is usable. Worth recording alongside the format choice.
- **Unfinished spans are lower bounds.** Every surface — visual and agent — has to say so,
  or it reports a partial picture as a whole one.

[#886]: https://github.com/aelefebv/lucida/issues/886
[#893]: https://github.com/aelefebv/lucida/issues/893
[#887]: https://github.com/aelefebv/lucida/issues/887

---

## Reproducing

```
pnpm --filter lucida-web dev
open 'http://localhost:5173/monitor-prototype.html?variant=C&run=warm'
```

`←` / `→` cycle variants. The run selector switches fixtures, *replay live* streams the
recording in real time, and *Chrome JSON* downloads the export that
[ui.perfetto.dev](https://ui.perfetto.dev) opens.

The trace is synthetic. It is calibrated to real measurements, but the only two things in
it that were never observed — the rejections and the retry — are labelled as injected in
the run header's `gaps`, and every surface repeats that label.
