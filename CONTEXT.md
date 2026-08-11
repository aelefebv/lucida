# lucida

A domain-neutral viewer for large n-dimensional array and image data, built for
humans and LLM agents as coequal users. See `intention.md` for the north-star and
`wiki/` for the reasoning behind specific decisions.

This file is a **glossary and nothing else**. It fixes what words mean; it does not
describe how anything works, and it is not a spec. Behaviour lives in the code;
rationale lives in `wiki/decisions/`.

Keep every term domain-neutral. lucida is a general array/image viewer — no
discipline-specific jargon, here or anywhere else in the repo.

## Content model

**Dataset**:
One opened body of array data with a stable server-assigned identity. The unit a
user opens, names, and removes.
_Avoid_: file, image (an image is narrower — see below), volume

**Entity**:
An addressable thing placed in a layout — the unit that has a position. An entity
may carry image data, and some entities carry none.
_Avoid_: object, item, node

**Image**:
The multiscale array data belonging to an image-bearing entity. Distinct from
Entity: the two identities coincide only for single-image datasets, so never treat
one as a synonym for the other.
_Avoid_: array, source, layer

**Collection**:
A dataset whose entities are laid out together as a grid of tiles rather than as a
single image.
_Avoid_: grid, mosaic, plate, montage

**Channel**:
One component of the channel axis of an image. A neutral name for whatever the
axis distinguishes; carries no assumption about what produced it.
_Avoid_: any discipline-specific naming for the axis

**Label**:
An integer-valued overlay image whose values name regions of the image it
overlays.
_Avoid_: mask, annotation (an annotation is a user-authored mark, not array data)

**Chunk**:
The unit of array data that is fetched, decoded, and made resident. Never a whole
image.
_Avoid_: tile (a tile is a layout cell in a collection), block, brick

**Chunk key**:
A chunk's address within one image, as `level/t/c/z/y/x`. Not unique on its own —
the same key legitimately exists under two residency tiers.
_Avoid_: chunk id, coordinate

**Composite key**:
`{dataset_id}/{image_id}/{chunk_key}` — a chunk's address across a whole session.
The key the wire routes responses on.

**Level**:
One resolution step of an image's multiscale pyramid, `0` being finest.
_Avoid_: LOD, scale, zoom level, resolution

**Unwritten level**:
A level a store declares but never wrote chunks for. Legal — every read returns
`fill_value` — so it renders as an all-zero image rather than failing. Say
"unwritten", not "empty": an unwritten level is a partially-written export, while
an empty *region* is data that is legitimately zero, and the whole point is that
the two look identical on screen. See
[ADR 0054](wiki/decisions/0054-unwritten-levels-are-named-not-hidden.md) for how
one is told from the other.
_Avoid_: empty level, missing level, blank level

**Proxy asset**:
A small low-resolution placeholder volume standing in for a tile or a group of
tiles, so the renderer can show something before detail chunks arrive. Always
say "proxy asset", never bare "proxy": `lucida-proxy` generates these and is a
pure-compute crate inside the server, not an intermediary in the network path.
_Avoid_: proxy (unqualified — reads as a network hop), placeholder, stand-in

## Residency and delivery

**Residency tier**:
Which of the two independent residency populations a resident chunk belongs to:
`detail` or `coarse`. The tiers have separate budgets and separate eviction, so a
chunk in one is not the same resident as the same chunk in the other.
_Avoid_: quality, priority, LOD tier

**Lane**:
Which concurrent stream of work a unit belongs to. The planner emits `detail`,
`coarse`, `prefetch`, `minimap` and `overview`; the label path is its own stream
again. Orthogonal to every other dimension — the same work happens in each lane.
_Avoid_: track (a track is a timeline row), queue, channel

**Wanted set**:
The chunks the current view calls for. A statement of demand, not of possession.
_Avoid_: visible set, request list

**Coalescing**:
Collapsing several callers' demand for the same work onto one operation.
Coalescing is normal and expected, not a defect to be removed. It happens at two
independent layers and the two must never be conflated: **request coalescing**
folds several callers' demand for one composite key onto one wire request, and
**read coalescing** folds several wire requests for one object onto one backend
read, via a leader that performs it and followers that wait on the result.
_Avoid_: deduplication, batching (batching combines *different* work)

**Reader**:
The party a backend source read is charged to when the concurrent-read cap is
shared out — the requesting client, or one background class for reads no client
asked for (imports, CLI work, proxy generation). A fairness identity, not a
component and not a caller: two reads by one client are one reader, and the
reasoning is in `wiki/decisions/0053-fair-share-source-read-admission.md`.
_Avoid_: tenant, consumer, requester (a requester is any caller; a reader is the
unit fairness is measured over)

## Performance monitor

Defined by `wiki/decisions/0047-trace-model-phases-runs-and-lifecycle-rows.md`
and `wiki/decisions/0051-the-trace-driver-and-the-page-export-seam.md`, which are
the authority if this summary and they ever disagree.

**Trace**:
The single artifact the monitor records. The visual timeline and the agent
diagnostic are two readings of the same bytes, never two artifacts.
_Avoid_: log, profile, recording (a recording is continuous; a trace is the thing
it produces)

**Phase**:
A stage a unit of work passes through, delimited by a handoff where ownership or
identity changes. Drawn from a closed enum. Not a directory, not a lane, not a
thread.
_Avoid_: stage, step, span (a span is an export-time projection of a phase)

**Run**:
A labelled interval within the continuous recording, opened by a cause and closed
by quiescence or explicitly. A dataset-open run and an interaction run are the
same object, differing only in cause.
_Avoid_: session, capture, trial

**Steady-state interval**:
The unlabelled interval between runs. The same object as a run with no cause, so
the pan that preceded a stall is retained rather than discarded, and it is
retained under the same resident cap.
_Avoid_: idle interval, gap, background run (a *gap* is a hole in coverage)

**Lifecycle row**:
The per-chunk unit of record: one fixed-width row with a timestamp slot per phase
boundary. A row, not a list of spans — spans exist only at export.
_Avoid_: event, record, entry

**Quiescent**:
The condition that closes a run on its own: the render loop has no dirty flag set
and no frame in flight, and every chunk the view asked for is resident with
nothing pending or in flight. Speculative prefetch does not count against it.
Published by the page as a boolean, never inferred from the outside.
_Avoid_: idle, settled, done, ready (`ready` already means "a frame was drawn")

**End reason**:
Why a run closed — `quiescent`, `timeout`, or `explicit`, plus `run-opened` for a
steady-state interval that ended because a labelled run began. A required field: a
run that never settled is still a run, and the reason is the difference between a
result and a missing one.
_Avoid_: status, outcome

**Truncation record**:
What a run stopped recording, and how much it went on to miss — offset, cap, rows
recorded, rows unrecorded. A record, not a boolean: a truncated run stops storing
rows but keeps counting them, which turns "truncated at 18,000 rows" into
"truncated at 18,000 of an eventual 63,412".
_Avoid_: truncated flag, overflow, dropped (a *drop* is a ring overwriting its
oldest record, which is a different loss)

**Coverage block**:
What a run measured and what it did not — accounted wall clock, the gaps, the
counted phases, and the structural limits. On every run, including clean ones,
because "no stall found" is worth nothing without its denominator.
_Avoid_: completeness, confidence, quality score

**Coverage gap**:
A hole in what a run can account for: wall clock no phase covers, the tail after a
truncation, or records a ring or the server dropped. Each carries whether the
bottleneck could be inside it, so the judgement is made once rather than by each
reading surface.
_Avoid_: missing data, hole, blind spot

**Structural limit**:
Something this instrument can never measure, on any run — the 100 µs clock floor,
queue time before the admission window, the unattributed remainder inside a
request. Stated on every run because a reader who has just been told a run is
clean is the one who needs to know what a clean run still cannot tell them.
_Avoid_: caveat, known issue, limitation (a limitation sounds fixable)

**Trace seam**:
The page-level export function that returns the trace document. The one place
every reader goes — the CLI, an agent driving its own browser, the monitor's save
button — so that no surface gets a privately-shaped copy. Public interface in
every build, not a debug affordance.
_Avoid_: endpoint, hook, API

**Point event**:
A rare occurrence recorded as a single timestamped record rather than a phase
boundary: eviction, rejection, retry, failure.
_Avoid_: incident, error (a point event is not necessarily a failure)

**Per-tick aggregate**:
One sample per planning tick per dataset — lane counts, the culling funnel,
active-set tallies, per-level planned against cached and in-flight. Kept on a
drop-oldest ring, unlike the per-chunk tier, because a steady-state stream has no
privileged start.
_Avoid_: snapshot, stats, gauge (a gauge has no memory of when)

**Counted phase**:
A phase below the platform's 100 µs clock floor — cache admission, worker
dispatch, coalesce attach. Counted on the per-tick aggregate, never timed, so a
reader is not shown quantisation noise wearing the costume of data.
_Avoid_: untimed phase, fast phase

**Correlation label** (`rid`):
The `u32` that joins a browser-side lifecycle row to the server-side row for the
same wire request. Client-minted, outbound-only, and monotonic across one
connection; chunk and asset requests share the one counter.
_Avoid_: trace id, span id, request id (`request_id` is a different identifier —
see below)

**Request id** (`request_id`):
The per-interaction identifier on control messages such as `open_remote_dataset`
and `dataset_health`. A different thing from a correlation label: different shape,
different lifetime, different table. Never use one name for the other.
_Avoid_: correlation label, rid

**Connection generation**:
The counter, incremented on each successful connect, that distinguishes one
socket's lifetime from the next. The other half of the join key: a correlation
label restarts per connection, so only `(connection generation, rid)` is unique
across a run that outlived a reconnect.
_Avoid_: session id, epoch (a scene epoch is unrelated), attempt

**Timing batch**:
One message carrying a flush window of server-side rows as parallel column
arrays, pushed to the client whose requests produced them. Columns, not a list of
records — the shape the receiving table stores.
_Avoid_: telemetry, report, upload (nothing is uploaded; the flow is toward the
client)

**Bracket**:
The interval a browser row measures around one wire request, on one clock. Server
rows are placed by nesting inside it rather than by clock synchronisation, so the
unattributed remainder is named as a gap rather than absorbed.
_Avoid_: window, span, round trip

**Boundary**:
The handoff a lifecycle row stamps. A row holds one timestamp slot per boundary,
so N phases need N+1 slots and adjacent phases share the slot between them — a
phase is the interval between two boundaries, never a slot of its own.
_Avoid_: marker, checkpoint, timestamp (a boundary is the event; the stamp is what
records it)

**Row outcome**:
How one lifecycle row's life ended — `in-flight`, `complete`, or `retired`. A
column, not an inference: a stamp array alone cannot tell "never entered the next
phase" from "entered and never left", and drawing them alike turns a healthy phase
into a false slab. Distinct from end reason, which belongs to a run.
_Avoid_: end reason (that is the run's field), status, state

**Speculative**:
Work the pipeline started for a view nobody is looking at yet — today, the
prefetch lane's future timepoints. Excluded from the quiescence predicate and from
the view's demand, and reported at settle rather than hidden.
_Avoid_: background, idle, optional

## Surfaces

**Monitor**:
The pipeline performance surface — where and when the pipeline slowed down.
Observation only.
_Avoid_: profiler, debug panel, dashboard

**Dev controls**:
The dev-only mutating surface: planning knobs, overlay toggles, and the
session-scoped cache knobs. Deliberately separate from the monitor — observation
and mutation are two different tools. Named for mutation, not for configuration,
because configuration is only one of its contents.
_Avoid_: debug panel, config tab, dev tools, inspector

**Debug panel**:
The retired ten-tab observation-and-mutation surface (`DebugPanel.tsx`),
dismantled by `wiki/decisions/0052-debug-surface-dispositions.md`. Historical
only — never use it for the surviving surface.
_Avoid_: using this term for anything current; say monitor or dev controls

**Overlay** (debug):
The in-viewport layer drawn over the canvas in dataset coordinates — which chunk,
where on screen. Spatial, where the monitor is temporal; the two never merge.
_Avoid_: overlay image (an integer-valued image whose values name regions is a
label, see above), heads-up display

**Capture surface**:
The chrome-free viewer page (`?render=1`) that `dataset montage`, `viewer
render` and the trace driver point a headless browser at: all UI hidden, canvas
filling the viewport, and — equally binding — no user state written, so a
headless run neither overwrites anyone's view nor waits out a persistence
debounce (`lucida-web/src/captureSurface.ts`). Not a *run* (which is an interval
in the recording, see above) and not a saved-view *capture* (which is the act of
building a `SavedView`).
_Avoid_: render mode, screenshot page, headless mode

**Trace driver**:
The `lucida trace` command: it launches its own headless browser, opens a
dataset, waits for the run to become quiescent, and writes the trace. One of two
entry points to the trace seam — the other is an agent driving a browser itself.
_Avoid_: recorder, profiler run, headless mode

**Agent surface**:
Any diagnostic path an LLM agent reads — the CLI, the Python client, the trace
export. Reads the same bytes as the human surface, never a parallel format.
_Avoid_: API, headless mode
