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

**Inner chunk**:
The chunk inside a shard: what a chunk key addresses, and the chunk shape a
level reports. A shard's own shape is never a chunk shape. In an unsharded
store there is no shard, so chunk and inner chunk name the same thing.
_Avoid_: sub-chunk, block, shard chunk, tile (a tile is a layout cell in a
collection)

**Shard**:
One stored object holding a fixed grid of inner chunks and an index of where
each lies. The unit an object store counts and lists, never the unit the viewer
fetches, decodes, or makes resident.
_Avoid_: chunk (a shard holds chunks and is not one), object (unqualified — a
shard is one kind of object), file, container

**Chunk key**:
A chunk's address within one image, as `level/t/c/z/y/x`. Under sharding a key
addresses an inner chunk; the shard it lies in never appears in a key. Not
unique on its own — the same key legitimately exists under two residency tiers.
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

**Target level**:
The level the screen calls for in one image-bearing entity: the coarsest level
that still places at least one sample under every device pixel, or the level a
level pin names. A function of the camera and the level geometry alone, never
of memory pressure or of what happens to be resident. Distinct from the
displayed level, which is what the renderer sampled. See
[ADR 0061](wiki/decisions/0061-screen-chosen-target-level-with-resident-coarser-levels.md).
_Avoid_: ideal level, selected level, detail level (the detail tier holds
several levels), LOD, zoom level

**Displayed level**:
The level the renderer sampled for an entity's pixels: the target level once its
chunks are resident, and until then a coarser resident level or the coarse tier.
The counterpart of the target level, and never a synonym for it.
_Avoid_: rendered level, effective level, actual level, current level

**Level pin**:
A per-dataset choice that holds the target level at one level whatever the
screen shows. Absent means the target follows the screen. Unrelated to pinning
a workspace, which is per-member state. See
[ADR 0061](wiki/decisions/0061-screen-chosen-target-level-with-resident-coarser-levels.md).
_Avoid_: override (the field's old name), lock, fixed level, manual level

**Resident levels**:
The levels at which one image-bearing entity holds detail-tier chunks on the
GPU: the target level, the coarser levels kept for sampling where the target is
missing, and any finer level not yet evicted. Bounded per entity, with the
coarse tier outside the count. See
[ADR 0061](wiki/decisions/0061-screen-chosen-target-level-with-resident-coarser-levels.md).
_Avoid_: level stack, mip chain, fallback levels, cached levels (the CPU cache is
a different population)

**Lane**:
Which concurrent stream of work a unit belongs to. The planner emits `detail`,
`coarse`, `prefetch`, and `minimap`. `overview` is historical: the coarsest-pass
fallback lane from before the coarse tier, no longer emitted. The label path is
its own stream again. Orthogonal to every other dimension — the same work
happens in each lane.
_Avoid_: track (a track is a timeline row), queue, channel

**Wanted set**:
The chunks the current view calls for. A statement of demand, not of possession.
_Avoid_: visible set, request list

**Coalescing**:
Collapsing several callers' demand for the same work onto one operation.
Coalescing is normal and expected, not a defect to be removed. It happens at two
independent layers and the two must never be conflated: **request coalescing**
folds several callers' demand for one composite key onto one wire request, and
**read coalescing** folds several wire requests for one object, or for one byte
range of it, onto one backend read, via a leader that performs it and followers
that wait on the result.
_Avoid_: deduplication, batching (batching combines *different* work)

**Reader**:
The party a backend source read is charged to when the concurrent-read cap is
shared out — the requesting client, or one background class for reads no client
asked for (imports, CLI work, proxy generation). A fairness identity, not a
component and not a caller: two reads by one client are one reader, and the
reasoning is in `wiki/decisions/0053-fair-share-source-read-admission.md`.
_Avoid_: tenant, consumer, requester (a requester is any caller; a reader is the
unit fairness is measured over)

**Range read**:
A read of one byte range of a stored object rather than the whole object. The
read that fetches a shard index, or one inner chunk out of a shard.
_Avoid_: partial read, byte-range request (the transport's name for it)

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
retained under the same resident cap. It rotates rather than truncates when it
reaches the per-run cap: a run's beginning is its diagnostic payload, but steady
state has no privileged start, and truncating it would delete the most recent
work — the very thing it is kept for.
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
Why a run closed — `quiescent`, `timeout`, or `explicit`, plus two that belong to
a steady-state interval alone: `run-opened` when a labelled run began, and
`rotated` when the interval reached the per-run cap and handed over to a fresh
one. A required field: a run that never settled is still a run, and the reason is
the difference between a result and a missing one.
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
truncation, a socket outage, or records a ring, the server, or this side let go of.
Each carries whether the bottleneck could be inside it, so the judgement is made
once rather than by each reading surface.
_Avoid_: missing data, hole, blind spot

**Connection record**:
One socket a run was recorded over, with the outage that preceded it and the
correlation labels minted on it. A run can outlive a socket and labels restart at
zero on each one, so this is what tells two `rid: 0` rows in one run apart. The
browser writes it because the server cannot tell a returning client from a new one.
_Avoid_: session, reconnect event

**Socket outage**:
The stretch between a socket dropping and the next one opening, declared by the
browser. Requests in flight are lost and the rows the server had buffered for the
dead connection are discarded rather than replayed.
_Avoid_: downtime, disconnect window, reconnect gap

**Discarded server row**:
A server row this side refused because nothing in the interval could place it — a
label the interval never minted, or an open it never bracketed. Counted, never
stored: an orphan row is not a diagnostic and would spend the budget truncation
exists to protect. Distinct from a row the *server* dropped before sending, which is
its own coverage gap.
_Avoid_: unmatched row, orphan (in prose, say what could not place it)

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

**Display track**:
A row in the exported Chrome Trace Event file: one per phase, plus the run, point
event and counter rows. The format calls it a thread and the export lies to it
about that, because complete events on one named thread id per phase are what
renders as a readable timeline. It is never an OS thread and never a request
lane.
_Avoid_: thread, lane (a lane is the request lane — minimap, detail, coarse,
prefetch, overview)

**Reading**:
One timestamped sample of the four process-wide quantities a timeline needs as
counter tracks — queue depth, in-flight, frame time, resident bytes. Taken once
per tick, not once per planning pass, because the planner's epoch cache lets a
run fetch for seconds without re-planning and a series sampled on that cadence is
a cluster of points at run start and silence after. Kept on its own drop-oldest
ring.
_Avoid_: gauge (see the per-tick aggregate above — the point of the trace is that
a gauge has no memory of when, and a reading does), metric

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
unattributed remainder is named as a gap rather than absorbed. A dataset open has
a bracket of its own, keyed by request id, and the metadata reads nest in that.
_Avoid_: window, span, round trip

**Metadata read**:
One object read the server performs while opening a dataset — resolving the
dataset's shape, before any chunk exists. Its own server-row family, keyed on the
open's request id rather than on a correlation label, and its own short phase
vocabulary: `cache-hit`, `coalesced-wait`, `backend-read`. Only a `backend-read`
is a round trip, and an open's `backend-read` count is the trips that open
performed — a `coalesced-wait` may have been served by a leader outside it.
Why it keys on the open and why the family is its own:
`wiki/decisions/0048-correlating-work-across-the-browser-server-boundary.md` and
`wiki/decisions/0050-server-timings-reach-the-monitor.md`.
_Avoid_: metadata fetch, import read, open read

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

**Diagnostic**:
What a trace *means*, derived from it by one pure function. Both surfaces read
the same diagnostic, so the agent text and the monitor's cards cannot disagree
about which phase stalled. Distinct from the trace, which is what was recorded.
_Avoid_: analysis, report, summary, insight

**Ruleset**:
The versioned set of thresholds that produced a diagnostic, shipped inside the
document with each rule's rationale. Three families, because one number cannot
serve a pipeline whose network first byte and whose queue wait differ by two
orders of magnitude: absolute p95 ceilings, a backlog ETA, and a relative share.
Every ceiling is provisional and re-derivable; shipping it in the document makes
a change to one visible rather than silent.
_Avoid_: config, budget, SLO, threshold (a *threshold* is one rule's number)

**Verdict**:
The diagnostic's one-sentence answer, withheld until the run closes — a verdict
that changes while you read it is not a verdict.
_Avoid_: result, status, score, grade

**Finding**:
One rule firing on one subject, ranked against the others. A `note` is a finding
that is not a stall: worth a line, not worth blame.
_Avoid_: issue, warning, alert, violation

**Attribution**:
What the run was waiting on, and how much the derivation is willing to claim.
Carries one of seven confidence words, each with an explicit statement of what
it still cannot see.
_Avoid_: root cause, blame, diagnosis (the *diagnostic* is the whole document)

**Critical path**:
The serial chain the run finished on, walked backwards from its completion —
never a maximum over per-phase totals, which measure concurrency rather than
what anything waited for. Starts at run start rather than at the first recorded
row.
_Avoid_: hot path, longest path, bottleneck chain

**Unrecorded prefix**:
The chain's first link: wall clock before the first recorded boundary. Part of
the chain so it cannot be quietly dropped, never blamable because nothing
measured it, and always a coverage gap.
_Avoid_: startup, boot time, warmup

**Limiter**:
A cap that work queues behind, named so a queue wait resolves to something
rather than staying anonymous. Its cap is inferred from the highest concurrency
a run observed, because a client sees its own rows and no aggregate.
_Avoid_: throttle, semaphore, bottleneck

**Backlog ETA**:
Pending divided by the rate admissions are completing at, measured over the
trailing second — the wait a newly planned chunk will actually see. Queue phases
are judged by this and never by a per-chunk ceiling, which at the observed
spread would fire on every row or on none.
_Avoid_: queue depth (depth alone is not the signal), wait time, latency

## Server state

**Storage backend**:
The one database the server keeps its own records in, together with the code
that opens it and migrates it. Which backend runs is settled by configuration at
startup, not at build time. Distinct from an object store, which holds the array
data the server reads and never the server's own records. See
[ADR 0055](wiki/decisions/0055-storage-backend-selected-by-connection-string.md)
for why the choice is configuration rather than compilation.
_Avoid_: database driver, persistence layer, store (narrower — see below),
backend (ambiguous — say which one)

**Store**:
The reader and writer for one kind of record: login sessions, pending
authentications, bearer tokens, CLI token authorizations, bookmarks, workspaces.
A store opens no connection of its own and runs no migration; it works through
the storage backend that handed it out. Six of them exist, one per kind. See
[ADR 0055](wiki/decisions/0055-storage-backend-selected-by-connection-string.md)
for why the connection moved out of the stores.
_Avoid_: repository, table, model, DAO, object store (a different thing — see
above)

**Object store**:
Where the array data lives — local files, or a bucket reached over the network.
Read-only to the server, addressed by URL, and never the place server records
go.
_Avoid_: store (unqualified), bucket, blob store, storage backend

**Baseline**:
The one migration that creates the whole schema a storage backend serves —
every table, index, and constraint, with no earlier version to arrive from. A
later change is a migration beside it, not an edit to it. Each storage backend
has a baseline of its own, stating the same schema in the types its engine
offers. See
[ADR 0057](wiki/decisions/0057-one-baseline-schema-with-honest-column-types.md)
for what the baseline replaced and the column conventions it settles, and
[ADR 0058](wiki/decisions/0058-postgresql-shares-the-sql-and-duplicates-the-rust.md)
for why there is one per backend.
_Avoid_: initial migration, schema dump, bootstrap migration, snapshot

**Conformance suite**:
The cases that say what any implementation of one store trait must answer,
written against the trait and run against every implementation of it. A case
asserts only what a caller sees through the trait; a test that reaches past it
to a table, a column, or a query plan is an implementation test instead. See
[ADR 0056](wiki/decisions/0056-store-behavior-is-a-conformance-suite.md).
_Avoid_: contract test, shared test, compliance suite, integration test

## Identity and membership

**Principal**:
Who a request is from: an email address, how to display them, and whether the
caller administers this server. Every mode resolves whatever credential
arrived into one, and the code that records ownership or checks a permission
reads the principal and never the credential behind it. See
[ADR 0015](wiki/decisions/0015-server-stored-bookmarks-and-auth-seam.md).
_Avoid_: user, account, caller, identity (a provider asserts an identity; a
principal is what lucida resolved it to)

**Auth mode**:
Which of three ways this server learns who a caller is: `disabled` gives every
caller the same local principal, `google` runs a sign-in of its own, and `iap`
reads the identity a perimeter established. One mode is in force for the whole
server, set by configuration or inferred from the bind address. See
[ADR 0018](wiki/decisions/0018-auth-mode-auto-detect-by-bind-address.md) for how
a mode is chosen and
[ADR 0016](wiki/decisions/0016-backend-mediated-oauth-with-session-cookies.md)
for the sign-in `google` runs.
_Avoid_: auth backend, strategy, provider (a provider is one implementation a
mode selects; the mode is the selection)

**Perimeter**:
An authenticating layer in front of lucida that decides who reaches the server
at all. Not lucida's own authentication and no substitute for it. A caller the
perimeter admits still holds whatever rights their principal carries, and no
more. See
[ADR 0060](wiki/decisions/0060-iap-mode-reads-the-identity-the-perimeter-established.md).
_Avoid_: proxy (a proxy asset is a placeholder volume — see above — so say
perimeter even where the thing in front is called a proxy), gateway, edge,
front door, single sign-on

**Assertion**:
The signed statement a perimeter attaches to each request it forwards, naming
the caller it authenticated. Something to verify, never something to trust. See
[ADR 0060](wiki/decisions/0060-iap-mode-reads-the-identity-the-perimeter-established.md).
_Avoid_: token (a caller holds and presents a token; an assertion is minted
about them), header, ticket

**Audience**:
The part of an assertion that names which deployment it was minted for, matched
exactly and with nothing that turns the check off. A perimeter signs every
assertion it issues with the same keys, so a signature alone proves only that
some perimeter minted this one. The audience is what narrows that to this
deployment. See
[ADR 0060](wiki/decisions/0060-iap-mode-reads-the-identity-the-perimeter-established.md).
_Avoid_: recipient, scope, tenant, client id

**Key set**:
The published keys lucida checks an assertion's signature against. A
perimeter's key set is its own, so checking against a different one either
rejects everything or, worse, passes without meaning. See
[ADR 0060](wiki/decisions/0060-iap-mode-reads-the-identity-the-perimeter-established.md).
_Avoid_: JWKS (the format's name; in prose say key set), certificate, public
key (a set holds several, and an assertion names which one signed it)

**Sign-out URL**:
Where a mode sends a caller who signs out, or the mode's statement that it has
none. Every mode has to answer. A mode with no session to end answers that it
has none, so the control disappears rather than clearing nothing. Where a
perimeter established the identity, signing out is the perimeter's to perform
and not this server's. See
[ADR 0019](wiki/decisions/0019-post-logout-marker-cookie-and-prompt-select-account.md)
and
[ADR 0060](wiki/decisions/0060-iap-mode-reads-the-identity-the-perimeter-established.md).
_Avoid_: logout endpoint (one mode's answer, not the concept), logout route,
sign-out flow

**Administrator**:
A principal who administers this server. Server-wide, and unrelated to any
authority inside a workspace: an owner runs one workspace, an administrator
runs the server. A perimeter decides who reaches the server and holds no
opinion about who administers it.
_Avoid_: owner (an owner is a workspace role — see below), superuser, root,
privileged user

**Dev principal**:
The principal disabled mode gives a caller who presents nothing, and any
principal a developer puts in its place from the same browser. A
local-development convenience and never a security boundary. The default holds
no administrator rights, and replacing it is available only where nothing but
the local machine can reach the server. See
[ADR 0018](wiki/decisions/0018-auth-mode-auto-detect-by-bind-address.md).
_Avoid_: test user, fake user, impersonation

**Membership**:
Who belongs to a workspace and with what authority: a list of email addresses,
each carrying one role. A member is added, never inferred. Separate from a
shareable link, which can reach people who are not members.
_Avoid_: access list, permissions, collaborators, sharing (sharing is the act;
membership is the record)

**Role**:
What one member may do in one workspace: `viewer`, `editor`, or `owner`. Three,
exhaustively. Every member carries exactly one, and it is held per workspace
rather than being a property of the person.
_Avoid_: permission, access level, group, admin (an administrator is
server-wide — see above)

**Creator**:
The principal who made a workspace or a saved view, recorded on it at creation.
Distinct from an owner, which is a role a member holds now. Who created
something does not change when roles do.
_Avoid_: owner (see above), author, originator

**Saved-view visibility**:
Whether a workspace's saved view is `shared`, `personal`, or `proposed`. A
personal view belongs to one member, and nobody else sees it, owners included.
A proposed view is a viewer's bid to share: still theirs, and also offered to
editors for review.
_Avoid_: private (say personal), draft, pending, published

**Per-member state**:
What a workspace records for one member rather than for everyone: which
workspaces they pinned, which they opened recently, and the view they last had
open. Keyed per member, so nobody else sees it, and never a stand-in for the
workspace-wide default view.
_Avoid_: preferences, user settings, session state, personal view (a personal
saved view is a different thing — see above)

## Surfaces

**Monitor**:
The pipeline performance surface — where and when the pipeline slowed down.
Observation only.
_Avoid_: profiler, debug panel, dashboard

**Live view**:
What the monitor shows while a run is still open: progress counters and the
phase bar, cumulative from run start, and no verdict. A verdict needs a closed
interval, so the monitor withholds one until the run ends — by going quiescent,
by timing out, or through *Stop & analyse*, which closes it with `explicit` as
the end reason.
_Avoid_: real-time view, following window (there is no window), live verdict

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
