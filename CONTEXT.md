# lucida

A domain-neutral viewer for large n-dimensional array and image data, built for
humans and LLM agents as coequal users.

This file is a glossary: what words mean, and which synonyms to avoid.
Behaviour lives in the code. Keep every term domain-neutral, here and
everywhere else in the repo.

## Content model

**Dataset**:
One opened body of array data with a stable server-assigned identity. The unit
a user opens, names, and removes.
_Avoid_: image (narrower, see below)

**Entity**:
An addressable thing placed in a layout, the unit that has a position. Some
entities carry image data and some carry none.
_Avoid_: object (what an object store holds)

**Image**:
The multiscale array data of an image-bearing entity. Entity and image share an
identity only in a single-image dataset, so neither is a synonym for the other.

**Collection**:
A dataset whose entities are laid out as a grid of tiles, a tile being one cell.
_Avoid_: montage (`dataset montage` renders a contact sheet of any dataset)

**Label**:
An integer-valued image laid over another image, whose values name its regions.
_Avoid_: annotation (a user-placed mark, not array data), overlay (see Surfaces)

**Chunk**:
The unit of array data that is fetched, decoded, and made resident. Never a
whole image.
_Avoid_: tile (a layout cell in a collection)

**Inner chunk**:
The chunk inside a shard: what a chunk key addresses, and the chunk shape a
level reports. In an unsharded array the two are the same.

**Shard**:
One stored object holding a fixed grid of inner chunks and an index of where
each lies. An object store counts shards; the viewer never makes one resident.
_Avoid_: chunk (a shard holds chunks)

**Chunk key**:
A chunk's address within one image, as `level/t/c/z/y/x`. It never names a
shard. Not unique alone, since one key can be resident in both residency tiers.

**Composite key**:
`{dataset_id}/{image_id}/{chunk_key}`, a chunk's address across a session.

**Axis position**:
Where a view stands on the Z, T, or C axis, or on the Y or X axis a side view
cuts. People see it counted from 1, as `Z 5` or `Z 5/40`, while the wire,
URLs, and CLI flags carry the 0-based index.
_Avoid_: position (unqualified; an entity's position is its place in a layout)

**Level**:
One resolution step of an image's multiscale pyramid. Level `0` is the finest.

**Unwritten level**:
A level the metadata declares but no chunks were written for. Every read returns
the fill value, so it draws all zero. An empty region is real data that is zero.
_Avoid_: empty level

## Residency and delivery

**Residency tier**:
Which of two independent resident populations a chunk belongs to, `detail` or
`coarse`, each with its own budget and eviction.

**Target level**:
The level the screen calls for in one entity, or the level a level pin names.
It depends on the camera and level geometry, never on what is resident.
_Avoid_: detail level (the detail tier holds several levels)

**Displayed level**:
The level the renderer sampled for an entity's pixels: the target level once its
chunks are resident, and a coarser resident level or the coarse tier until then.

**Level pin**:
A per-dataset choice that holds the target level at one level. The scene field
is still `detail_level_override`. Unrelated to pinning a workspace.

**Resident levels**:
The levels at which one entity holds detail-tier chunks on the GPU. Each is
bound to the shader as a level source, one slot of the entity's renderer
descriptor (`lucida-web/src/renderer/descriptor/layout.ts`).

**Lane**:
Which concurrent stream of planner work a request belongs to: `detail`,
`coarse`, `prefetch`, or `minimap`.
_Avoid_: track (a display track is a timeline row), channel (an image axis)

**Wanted set**:
The chunks the current view calls for. Demand, not possession.

**Settled**:
A view once quiescent has held: covering its whole wanted set, or covering
less when the memory budgets cannot hold it all, which the view says along
with its coverage, the share of the wanted set resident. Previews, captures
and runs all wait on it (`lucida-web/src/pipeline/settle.ts`).

**Stalled**:
A view that stopped making progress without settling, with a reason such as
`server_pending`.

**Coalescing**:
Folding several callers' demand for the same work onto one operation: one wire
request per composite key, or one backend read per byte range. A leader does the
work and followers wait on it.
_Avoid_: batching (combining different work, as a merged read does)

**Merged read**:
One backend request serving several contiguous range reads of one object. Each
range keeps its own cache entry.
_Avoid_: coalesced read (coalescing is the same work)

**Reader**:
The party a backend read is charged to when the server shares out its
concurrent-read cap: the requesting client, or one background class
(`ReaderId` in `lucida-store/src/source_limiter.rs`).

## Performance monitor

**Trace**:
The single artifact the monitor records. The timeline and the diagnostic are two
renderings of the same bytes. The page hands it out through one export, the
trace seam (`lucida-web/src/trace/seam.ts`).

**Run**:
A labelled interval in the continuous recording, opened by a cause and closed by
quiescence, a stall, a timeout, or explicitly, as its end reason records. An interaction
run is one gesture. The stretch between runs is the steady-state interval.
_Avoid_: session (login or socket), capture (see capture surface)

**Quiescent**:
The page's published boolean that closes a run on its own: nothing left to draw,
and every chunk the view asked for resident, failed for good, or left out
because the budgets cannot hold it. Prefetch does not count.
_Avoid_: ready (`ready` means a frame was drawn)

**Phase**:
A stage a chunk passes through: `plan`, `queue`, `wire`, `decode`, `upload`,
`present`. The handoff between two is a boundary. A counted phase is too short
to time, so it is counted per tick.
_Avoid_: step (a trace driver action), span (an export's drawing of a phase)

**Lifecycle row**:
The browser's per-chunk record: one fixed-width row with a timestamp slot per
boundary and an outcome of `in-flight`, `complete`, or `retired`.

**Server row**:
The server's record of its work on one wire request or one metadata read. A
discarded server row was refused on arrival and is only counted. An unplaced
server row is kept with an `UnplacedReason` and no position on the timeline.

**Correlation label** (`rid`):
The `u32` the browser mints per outbound chunk or asset request, joining its
lifecycle row to the server row. Unique in a run only with the connection
generation, since it restarts on each connection.
_Avoid_: request id (`request_id` is a control-message identifier)

**Reading**:
One per-tick sample of the timeline's counters: queue depth, in-flight,
main-thread frame time, resident bytes, and GPU pass time where the adapter has
timestamp queries. Not the per-tick aggregate, the planner's per-dataset sample.

**Input to frame**:
The time from an input event to the GPU finishing the first frame drawn after
it. A run that took input reports it per input, beside the main thread's long
tasks and the frames dropped while input waited: the run's lag.

**Bundle**, **run file**, **saved run**:
The three files that carry a trace document. A bundle adds the settled frame and
what a replay needs. The dock's **Save bundle** and `lucida trace --bundle`
write one, and the dock's **Send report** puts one in the workspace inbox. A run
file is the trace driver's record around the document. A saved run is the
document alone.
_Avoid_: report (**Send report** is the action; a bundle is what it sends)

**Diagnostic**:
What a trace means, derived by one pure function: the verdict, ranked findings,
and the phase rollup, judged by the ruleset shipped inside it. A `note` is a
finding that is not a stall.

**Verdict**:
The diagnostic's one-sentence answer. Only a closed run has one.

**Provisional reading**:
What a live surface says while a run is still open, over its recent stretch, and
labelled provisional wherever it appears.
_Avoid_: verdict (only a closed run has one), reading (one counter sample)

**Window**:
A stretch of a run's clock a diagnostic is scoped to. Brushing the dock's axis
and `lucida trace show --window` set the same thing.
_Avoid_: selection (selector state, such as the current z), contrast window

**Display track**:
A row in the exported Chrome Trace Event file: one per phase, plus runs, point
events, and counters. The format calls it a thread.
_Avoid_: lane (a stream of planner work)

## Server state

**Storage backend**:
The one database the server keeps its own records in, with the code that opens
and migrates it. Chosen by configuration at startup.
_Avoid_: store (one kind of record), backend (unqualified)

**Store**:
The code that reads and writes one kind of server record, such as sessions,
workspaces, or inbox entries, through its storage backend.
_Avoid_: object store

**Object store**:
Where the array data lives: local files or a network bucket, read-only to the
server and addressed by URL.
_Avoid_: store (unqualified), storage backend

## Identity and membership

**Principal**:
Who a request is from: an email address, a display name, and whether the caller
administers this server. Every auth mode resolves its credential into one.
_Avoid_: identity (what a provider asserts; a principal is what lucida resolved)

**Auth mode**:
How the server learns who a caller is: `disabled` (no sign-in: one local dev
principal, and on a non-loopback bind an anonymous principal for each browser),
`google` (its own sign-in), or `iap` (the identity a perimeter established). One
mode holds for the whole server.

**Perimeter**:
An authenticating layer in front of lucida that decides who reaches the server.
A caller it admits holds only the rights their principal carries.

**Administrator**:
A principal who administers this server. Server-wide, and unrelated to any
authority inside a workspace.
_Avoid_: owner (a workspace role)

**Profile directory**:
An optional source of display names and pictures by email address. It changes
how a principal is shown, never who they are or what they may do.
_Avoid_: identity provider (which decides who a caller is)

**Membership**:
Who belongs to a workspace, each member with one role: `viewer`, `editor`, or
`owner`.

**Saved-view visibility**:
Whether a saved view is `shared`, `personal` (seen only by its maker), or
`proposed` (a viewer's offer to share, shown to editors for review).

**Per-member state**:
What a workspace records for one member: which workspaces they pinned or opened
recently, and the view they last had open.
_Avoid_: personal view (a saved view with `personal` visibility)

## Views

**Framing**:
What chose a camera's pose. A *placed* camera is one someone chose, and on
another canvas it keeps the region it showed. A *framed* camera is the fit of
every visible dataset, which a new canvas or new content fits again. An
*unframed* camera is a stand-in nothing chose: the scene fits it as soon as
there is data, and a client never persists it.
_Avoid_: auto-fit (fitting follows the camera's state, not an event such as an open)

**Scene frame**:
The one frame every dataset in a scene is placed in, by its declared scale,
origin and length units, so datasets over one physical region overlay. The
first dataset in the document fixes its unit and origin. The slice camera
views it directly, and the volume cameras view it as world space. When either
changes, a placed camera moves into the new one and keeps its region, and a
saved view records the one its camera was saved in.
_Avoid_: world (unqualified; world space is the volume cameras' view of it)

**Slice plane**:
The plane of the scene frame a slice view cuts: `xy`, `xz` or `yz`. The two
axes it names are on screen, Z always drawn down, and the third is cut at an
axis position. An `xz` or `yz` view is a side view: it shows Z as the scene
frame places it, at its physical spacing, and cuts Y or X at a place in the
scene frame, so datasets over one region cut the same plane.
_Avoid_: orientation, section (unqualified)

**Comparison**:
Two datasets that line up shown against each other in one view: split by a
divider dragged across it (swipe), or shown in turn (blink). Two datasets line
up when each declares length units and their extents in the scene frame
overlap. Both stay in the wanted set however they are shown.

## Surfaces

**Monitor**:
The pipeline performance surface: where and when the pipeline slowed, read from
the trace. It lives in the dock and the HUD, and changes nothing.

**Dock**:
The monitor's resizable panel in the viewer: the timeline, the live charts, and
the closed-run diagnostic. Temporal, where the overlay is spatial.

**HUD**:
The heads-up display: a canvas strip in the viewport, toggled by one key, that
shows the pipeline at tick cadence. Its legend holds the overlay toggles.
_Avoid_: overlay (the HUD is drawn in screen coordinates)

**Live view**:
What the dock shows while a run is open: live charts and a provisional reading.
Elsewhere in the code it also means the on-screen view, as against a saved view.

**Dev controls**:
The dev-only surface that changes things: the planning and cache knobs. The
trace driver sets the same knobs by the same names.
_Avoid_: debug panel (retired; it split into the monitor and dev controls)

**Overlay**:
The in-viewport layer drawn over the canvas in dataset coordinates, showing
which chunk is where and in what state.
_Avoid_: overlay image (that is a label)

**Capture surface**:
The chrome-free viewer page (`?render=1`) that `dataset montage`, `dataset
explore`, and the trace driver load headless. It hides all UI and writes no user
state (`lucida-web/src/captureSurface.ts`).
_Avoid_: render mode (`RenderMode` is a volume display setting), run

**Workspace preview**:
The image on a workspace's dashboard card: a frame a viewer captured from its
own canvas once the view settled, uploaded by an owner or editor. The server
stores it and never renders one.
_Avoid_: thumbnail (an explore panel tile)

**Open link**:
A link to `/open?url=<dataset URL>` that creates a new workspace around the
datasets it names and opens them.
_Avoid_: deep link (annotation and saved-view links are deep links too), share link

**Trace driver**:
The `lucida trace` command: it launches a headless browser, opens a dataset,
waits for quiescence, runs an optional script of steps, and writes a run file.
_Avoid_: recorder (the page code in `lucida-web/src/trace/recorder.ts`)
