---
type: Decision
title: "The trace driver and the page export seam"
description: "How lucida trace drives a headless run and gets the trace out: a production page-level export seam that both entry points call, a published quiescence predicate that closes the run, and a file on disk as the artifact."
tags: [lucida, decision]
source_path: wiki/decisions/0050-the-trace-driver-and-the-page-export-seam.md
created: 2026-08-10
modified: 2026-08-10
---

# The trace driver and the page export seam

Status: Accepted

Context: issue [#895], under the [#885] map. Builds on
[ADR 0047](0047-trace-model-phases-runs-and-lifecycle-rows.md) (what is recorded),
[ADR 0048](0048-correlating-work-across-the-browser-server-boundary.md) (`rid`),
[ADR 0049](0049-unconditional-recording-under-a-design-budget.md) (recording
policy) and the [#893] prototype (what the output says). Prior art in
`lucida-cli/src/main.rs` (the montage headless path) and
`lucida-web/src/renderLoop.ts`.

[#885]: https://github.com/aelefebv/lucida/issues/885
[#893]: https://github.com/aelefebv/lucida/issues/893
[#895]: https://github.com/aelefebv/lucida/issues/895
[#899]: https://github.com/aelefebv/lucida/issues/899
[#902]: https://github.com/aelefebv/lucida/issues/902

## The situation

ADR 0047 says what a trace is and ADR 0049 says it is always being recorded.
Neither says how anything outside the page ever sees it. `lucida trace` is the
command that drives a run headlessly and prints the [#893] diagnostic, and the
map assumed most of its cost was already paid: `lucida dataset montage` launches
headless Chrome over raw CDP and drives the chrome-free `?render=1` viewer URL.
That much is true. Everything else the map assumed about this command was not.

## `lucida debug state` is not the pipe, because it never reaches the browser

[#885] carried a standing preference to **extend** `lucida debug state` rather
than invent a second pipe, on the grounds that its transport already works.
Inspection says otherwise, and the preference is overridden here.

`debug state` opens a WebSocket to the *server*, consumes the handshake snapshot,
and computes its answer inside the CLI. It sends no request and reaches no
renderer. It says so itself: its caveats declare that it excludes browser
renderer residency, CPU-cache state and worker wanted-set state, and it reports
`planner_parity: false`. Its `--from-peer` mode reads presence — state a browser
volunteered for collaboration — not a query into a page.

So there is no existing transport to extend. Of the three mechanisms the CLI
has, exactly one executes anything inside a renderer: CLI-spawned headless Chrome
over CDP, and the closest precedent to what a trace needs is the auto-contrast
probe, which asks a live page a question and reads a structured answer off a
`window` global.

**The trace leaves the browser by CDP evaluation against a page global.** Routing
it through the server instead was rejected: it adds a protocol variant, a size
question on the session socket and a server-side retention policy, all to move
bytes the CLI already has a channel to. That option's one real advantage — it
could reach a human's already-open tab — buys little, because a human with an
open tab has the monitor and a save-to-file button.

## The seam is a function on the page, not a transport

[#885] requires that an agent already driving its own browser get the same bytes
without going through this command. Once the answer above is CDP evaluation,
those two entry points converge on something that is not a transport at all:
**a documented export function on the page**, returning the ADR 0047 document.
`lucida trace`, an agent's own browser session, and the monitor's save button
are three callers of one function.

Two consequences are accepted rather than discovered later:

**The seam is a public interface, in production builds.** The existing dev
globals are `import.meta.env.DEV`-gated and therefore invisible to any driver
running against a real bundle; a diagnostic that only exists in development
cannot explain a field report. Since ADR 0049 already records unconditionally in
every build, the export function ships unconditionally too, and its payload
carries ADR 0047's schema version.

**The CLI holds no diagnostic logic.** Thresholds, attribution and the verdict
from [#893] are computed behind the seam, and the CLI renders what it is handed.
Putting them in the CLI would quietly make the second entry point a second-class
citizen — the failure [surface parity](../principles/surface-parity.md) exists to
prevent.

## The server half is fetched and joined by the CLI

ADR 0048 keeps the server's rows in their own table, joined on `rid`. The page
cannot see that table, so someone must fetch it. **The CLI requests the server
rows for the run's `rid` range and performs the join.** The server keeps a
byte-bounded ring — no run concept server-side, since `rid` is monotonic per
connection and a range selects — and its reply declares what it no longer holds,
which lands in the document's `coverage` block rather than silently shortening
the table. That mirrors ADR 0049's shape deliberately: one idea about bounded
retention that declares its own truncation, not two.

The cost is real and is stated rather than hidden: **an agent driving its own
browser gets a browser-only document** unless it makes the same server request.
That dents "the same bytes" at exactly one seam. The alternative — pushing server
rows into the page continuously so the export is complete — spends ADR 0049's
budget on data the page never renders, on every session, to serve the export
path. The mitigation already exists: [#893]'s coverage block must declare missing
server rows anyway, and one of its five samples is that degradation.

## Settling is a published predicate, not an inference

"Opened" is not a moment. The driver needs a definition of done, and the two
halves of one already exist unpublished. The render loop schedules a frame only
when a dirty flag is set, so *both flags clear with no frame in flight* is
genuine idle. And the CPU cache already computes resident detail against desired
detail, next to pending and in-flight counts — "everything asked for is here,
nothing left to sharpen" is a question the code can answer today. It is rendered
into one line of the debug panel and nowhere else.

**The page publishes a `quiescent` boolean and the driver waits for it to hold
for 500 ms.** Inferring quiescence from outside — watching the frame counter stop
advancing — is the only thing possible today and is wrong in the one case that
matters: a stalled pipeline and a finished one both stop drawing. The hold window
clears the residency render interval and the minimap scan cadence with margin
while staying small against [#893]'s 368 ms healthy local open, and it goes in
the run header because it is baked into every duration the run reports.

**Prefetch is excluded from the predicate.** The prefetch lane keeps requesting
future timepoints, and on a timeseries a naive "queues empty" test may never go
true. Prefetch chunks are already tiered separately, so the exclusion is cheap,
and ADR 0047 already calls speculative steady-state work "the buffer between
runs". What is still outstanding at settle is reported in `coverage`, so the run
does not look quieter than it was.

**A run that never settles is still emitted.** Three paths can keep a page live
indefinitely — the bridge's resync retry re-arms forever behind a sequence hole,
two components self-schedule their own frames outside the main loop, and the
minimap seed scan re-dirties while seeding. On timeout the run closes, the trace
prints, and the reason is recorded. A driver that prints nothing on the
interesting case is the wrong tool: [#893]'s most diagnostic sample is a run that
never finishes.

This makes **a run's end reason a required field** — `quiescent`, `timeout` or
`explicit`. It is the second ticket to reach that conclusion independently
([#892] found that a stamp array cannot distinguish "never entered" from "stuck"),
which is why it belongs in the model rather than in this command.

[#892]: https://github.com/aelefebv/lucida/issues/892

## The run is a file, because the browser it lived in is dead

The driver kills its browser at teardown, taking ADR 0049's resident buffer with
it. [#893]'s output prints follow-up commands naming a run id, so unless the run
is persisted those commands are unreachable from the path that produced the id.
**The driver writes the full document to disk and the follow-up depths read that
file**; stdout still gets only the small default rendering. ADR 0047 gave a run a
self-describing header so it could be archived, compared and attached to a job —
this is where that pays.

## Defaults are workload decisions, and the run header records them

**Device pixel ratio defaults to 2.** The existing CDP path hardcodes a scale
factor of 1, and it is the only place in the repo that sets one. DPR-1-only
verification has hidden whole defect classes in this project more than once, and
DPR 2 quadruples the pixels the pipeline must fill — it is the condition under
which the defects this monitor exists to find actually appear. The screenshot and
montage paths keep 1: their DPR is an output-image-size decision, not a workload.
The viewport defaults to a representative window rather than montage's small
square cell for the same reason.

**Persistence is suppressed on the capture surface.** A saved-view camera
debounce means a headless run writes a camera into workspace state — perturbing
the next run and the user's own view — and imposes a floor on every run's wall
clock. [#899] flagged the debounce as a trap for this driver on the assumption
that it would quit too early; the worse reading is that the driver is *writing*.
A chrome-free capture surface has no business writing user state, so `render=1`
stops doing it. Teaching the driver to outwait the debounce was rejected as
solving the smaller half of the problem.

**The command requires a running server**, as montage does; spawning one is a
different ticket. This means a browser-cold open can run against an
arbitrarily warm server — [#902] measured a repeat open at 5.8 s against 0.02 s
through the source cache — so **server warmth is recorded in the header**. ADR
0047 already reserved a slot for cache warmth; this is where it gets its value.
Without it two runs are incomparable *and look comparable*, which is worse than
being obviously incomparable.

The positional argument is a dataset URL in canonical form
([ADR 0042](0042-canonical-dataset-url-form.md)), and the driver composes the
view it opens. That composed view goes in the header too: "cold open of dataset
X" is not a reproducible workload without it.

## The command is top level, and a stall does not fail by default

`lucida trace` is a top-level command with its own subcommands rather than a verb
under `dataset`. It is not a property of a dataset the way `info` and `health`
are — it drives a run, and its follow-up depths take a run id, not a dataset.

**A stall exits zero unless a gate flag asks otherwise.** Every non-zero exit
code in the CLI today means the command failed; `status` prints a failed health
check and exits zero, and `dataset health` prints `degraded` and exits zero.
Making a measurement flip the exit status would overload that vocabulary and
break any pipe that reads non-zero as "the tool broke". An opt-in flag puts the
CI intent at the call site.

**The gate fails on a stall verdict or an unsettled run, and never on coverage
alone.** [#893] measured 87% of a healthy local cold open as pre-instrument boot;
a gate that fires on coverage fires on every green run. "It stalled" and "it never
finished" are one result in CI, so they share one flag rather than splitting into
two.

## Scope: v1 drives an open, not an interaction

The driver opens a dataset and records that run. It does not script pan, zoom or
scrub — that needs an input DSL, synthetic input over CDP and a per-step settle
rule, and it is a subtree this ticket does not need to enter, because interaction
traces are already reachable through the other entry point: an agent drives its
own browser, does whatever it likes, and calls the seam. The two entry points end
up complementary rather than one being a subset of the other, which is a better
answer than a scripting language nobody has asked for yet.

## Consequences

- The headless launch, CDP call and readiness helpers currently exist as three
  copy-pasted blocks inline in the CLI's `main.rs`. A fourth caller forces the
  extraction of a browser-driver module; that extraction is part of this work.
- `render=1` gains a behavioural meaning (no state writes) on top of its visual
  one. Anything added to the capture surface later inherits that rule.
- The page's export function and `quiescent` flag are public interface. They need
  the same care as a wire type — versioned, and not reshaped casually.
- `lucida debug state` is left alone. It remains the server-state diagnostic it
  already is, and the monitor does not overload it.
