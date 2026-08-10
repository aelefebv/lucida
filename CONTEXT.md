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

## Residency and delivery

**Residency tier**:
Which of the two independent residency populations a resident chunk belongs to:
`detail` or `coarse`. The tiers have separate budgets and separate eviction, so a
chunk in one is not the same resident as the same chunk in the other.
_Avoid_: quality, priority, LOD tier

**Lane**:
Which concurrent stream of work a unit belongs to: `main`, `minimap`, or `label`.
Orthogonal to every other dimension — the same work happens in each lane.
_Avoid_: track (a track is a timeline row), queue, channel

**Wanted set**:
The chunks the current view calls for. A statement of demand, not of possession.
_Avoid_: visible set, request list

**Coalescing**:
Collapsing several callers' demand for the same composite key onto one wire
request. Coalescing is normal and expected, not a defect to be removed.
_Avoid_: deduplication, batching (batching combines *different* work)

## Performance monitor

Defined by `wiki/decisions/0047-trace-model-phases-runs-and-lifecycle-rows.md`,
which is the authority if this summary and it ever disagree.

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

**Lifecycle row**:
The per-chunk unit of record: one fixed-width row with a timestamp slot per phase
boundary. A row, not a list of spans — spans exist only at export.
_Avoid_: event, record, entry

**Point event**:
A rare occurrence recorded as a single timestamped record rather than a phase
boundary: eviction, rejection, retry, failure.
_Avoid_: incident, error (a point event is not necessarily a failure)

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

## Surfaces

**Monitor**:
The pipeline performance surface — where and when the pipeline slowed down.
Observation only.
_Avoid_: profiler, debug panel, dashboard

**Debug panel**:
The configuration-mutating surface. Deliberately separate from the monitor:
observation and mutation are two different tools.
_Avoid_: dev tools, inspector

**Agent surface**:
Any diagnostic path an LLM agent reads — the CLI, the Python client, the trace
export. Reads the same bytes as the human surface, never a parallel format.
_Avoid_: API, headless mode
