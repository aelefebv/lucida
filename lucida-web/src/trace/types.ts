/**
 * Trace model types — the vocabulary of ADR 0047 and ADR 0051, and the
 * shape of the document the trace seam returns.
 *
 * `CONTEXT.md` is the glossary: a *trace* is the artifact, a *phase* is a
 * stage delimited by a handoff, a *run* is a labelled interval within the
 * continuous recording, a *lifecycle row* is the per-chunk unit of record,
 * and *end reason* is why a run closed.
 */

import type { FetchErrorKind } from "../pipeline/fetch/retry.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { ChunkFeedbackReason } from "../renderer/workerProtocol.ts";

/**
 * Bumped whenever the document shape changes incompatibly. One integer for
 * the whole file (ADR 0047): traces outlive the code that wrote them, and a
 * file from two releases ago should either load or fail clearly.
 */
export const TRACE_SCHEMA_VERSION = 1;

/**
 * The closed browser phase enum. Fixed by the #921 spec rather than grown
 * ad hoc, because adding a phase widens every lifecycle row and spends from
 * a fixed budget.
 *
 * Every phase carries timings (#925). {@link TraceDocument.instrumentedPhases}
 * still states which ones were measured, so a reader never mistakes a
 * reserved slot for a measured zero.
 *
 * The boundaries are all main-thread observations. No worker timestamps
 * itself and no clock is reconciled across contexts, so each phase is
 * bracketed where the main thread can see both ends:
 *
 * - `plan`   the tick's wanted-set computation, including its synchronous
 *            wasm calls, up to the moment the request was admitted to the
 *            scheduler. Not a separate timing source — the same recorder
 *            clock as every other phase.
 * - `queue`  admitted to the scheduler → fetch dispatched.
 * - `wire`   request sent → bytes in hand. The bracket server rows nest in.
 * - `decode` the worker ROUND TRIP: postMessage out → onmessage in. Named
 *            for the round trip, not for CPU time, because it includes the
 *            wait for a free worker and that is usually the larger half.
 * - `upload` bytes decoded → the chunk is on the GPU. Covers the wait in
 *            the CPU cache for a delivery tick, the per-frame upload budget,
 *            and the worker's own texture write; residency is established by
 *            message ordering (the worker is FIFO, so a chunk posted before
 *            a render has been written by the time that render runs).
 * - `present` resident → drawn in a frame, bounded by the following frame's
 *            dispatch.
 */
export const PHASES = ["plan", "queue", "wire", "decode", "upload", "present"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Boundaries, not intervals: a row carries one timestamp slot per phase
 * boundary (ADR 0047), so N phases need N+1 slots and phase `i` runs from
 * slot `i` to slot `i + 1`. Adjacent phases share the slot between them —
 * `wire` ends where `decode` begins.
 */
export const BOUNDARY_COUNT = PHASES.length + 1;

export const Boundary = {
  PlanStart: 0,
  QueueStart: 1,
  WireStart: 2,
  /** End of `wire`, start of `decode`. */
  DecodeStart: 3,
  UploadStart: 4,
  PresentStart: 5,
  PresentEnd: 6,
} as const;
export type BoundaryIndex = (typeof Boundary)[keyof typeof Boundary];

/**
 * Slot value meaning "this boundary was never reached". Offsets are
 * microseconds from run start held as uint32, and 0 is a legitimate offset,
 * so the sentinel is the top of the range. The usable range is ~71 minutes.
 */
export const UNSET_STAMP = 0xffffffff;
const MAX_STAMP = UNSET_STAMP - 1;

/**
 * Clamp a microsecond offset into the uint32 slot range.
 *
 * `Math.trunc`, not `| 0`: bitwise coercion is signed, so an offset past
 * 2^31 — a run over about 36 minutes — would come back negative. Harmless
 * inside a `Uint32Array`, but a run's duration is a plain number.
 */
export function clampStamp(offsetUs: number): number {
  if (!(offsetUs > 0)) return 0;
  return offsetUs >= MAX_STAMP ? MAX_STAMP : Math.trunc(offsetUs);
}

/**
 * How a row's life ended. A stamp array alone cannot tell "never entered the
 * next phase" from "entered and never left" (#892), and drawing those alike
 * turns a healthy phase into a false slab — so the distinction is a column,
 * not an inference.
 */
export const RowOutcome = {
  /** Still open when the run closed. */
  InFlight: 0,
  /** Reached its last instrumented boundary. */
  Complete: 1,
  /** Abandoned — aborted, superseded, or failed. */
  Retired: 2,
} as const;
export type RowOutcomeValue = (typeof RowOutcome)[keyof typeof RowOutcome];
export type RowOutcomeName = "in-flight" | "complete" | "retired";

export const ROW_OUTCOME_NAMES: readonly RowOutcomeName[] = ["in-flight", "complete", "retired"];

/**
 * Which lane a request travelled on. An attribute of the row, not a phase of
 * its own: a prefetch chunk and a detail chunk go through the same six
 * phases, and splitting the enum by lane would widen every row to say
 * something a column already says.
 *
 * Index order is the wire order of the column and must not be reordered.
 */
export type LaneName = "minimap" | "detail" | "coarse" | "prefetch" | "overview";
export const LANE_NAMES: readonly LaneName[] = [
  "minimap",
  "detail",
  "coarse",
  "prefetch",
  "overview",
];

/**
 * Declared here rather than imported from the planner, so a lane added there
 * and not here fails to compile at the emit site. The alternative — a runtime
 * sentinel for an unrecognised lane — turns the drift into a column of nulls
 * nobody reads until they wonder where a lane went.
 */
export function laneIndex(lane: LaneName): number {
  return LANE_NAMES.indexOf(lane);
}

/**
 * The identity fields a lifecycle row copies off a planned request. A
 * structural subset of `ChunkRequest`, so emit sites pass the object they
 * already hold and the recorder allocates nothing.
 */
export interface ChunkRowSource {
  datasetId: string;
  entityId: string;
  imageId: string;
  lane: LaneName;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
}

/**
 * Why a run opened. Drawn from the vocabulary the code already has (ADR
 * 0047) rather than a new one: `epoch` is a scene epoch-diff cause, and
 * `dirtyKind` / `source` are the render loop's typed dirty-set attribution.
 */
export interface RunCause {
  epoch: "content" | "layout" | "view" | "selection" | "asset" | null;
  dirtyKind: "interactive" | "residency";
  source: string;
}

/**
 * Why a run closed. Required on every run — a run that never settled is still
 * a run.
 *
 * The last two belong to the unlabelled steady-state interval alone.
 * `run-opened` means a labelled run began, which is not a settling event.
 * `rotated` means the interval reached the per-run cap: steady state has no
 * privileged start, so it hands over to a fresh interval rather than
 * truncating and losing the most recent work.
 */
export type EndReason = "quiescent" | "timeout" | "explicit" | "run-opened" | "rotated";

export interface Viewport {
  cssWidth: number;
  cssHeight: number;
  deviceWidth: number;
  deviceHeight: number;
}

/** What the browser already held when the run opened. Server warmth belongs to the driver. */
export interface CacheWarmth {
  detailChunks: number;
  detailBytes: number;
  coarseChunks: number;
  coarseBytes: number;
  proxyBytes: number;
}

export interface ComposedView {
  /** Path + query + hash of the page the run happened on; the dataset URL and view params live here. */
  url: string;
  mode: "slice" | "volume";
}

export interface BuildIdentity {
  version: string;
  mode: string;
  dev: boolean;
}

export interface GpuIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/**
 * What the pipeline has left to do, from the CPU cache's point of view.
 * One shape with two readings: live, it is the cache's half of the
 * quiescence predicate; captured at run close, it is what was still
 * outstanding at settle. Reported rather than hidden — prefetch is excluded
 * from the predicate, so a run can close with speculative work in flight and
 * the reader has to be able to see that.
 */
export interface Outstanding {
  /** Non-speculative work only; the speculative remainder is counted below. */
  pending: number;
  inFlight: number;
  speculativePending: number;
  speculativeInFlight: number;
  desiredDetailChunks: number;
  residentDetailChunks: number;
  desiredCoarseChunks: number;
  residentCoarseChunks: number;
}

/**
 * The conditions a run happened under. Recorded so two runs are comparable
 * — or visibly not. A header that omits device pixel ratio does not stop
 * anyone comparing two runs at different DPR; it only stops them noticing.
 *
 * Captured when the run closes, not when it opens: a run opens before the
 * canvas has been sized and before a collection's members have all arrived,
 * so an at-open reading describes a page that does not exist yet. Cache
 * warmth is the exception and is read at open — warmth means what was
 * already there.
 */
export interface RunConditions {
  datasetIds: string[];
  composedView: ComposedView;
  devicePixelRatio: number;
  viewport: Viewport;
}

/**
 * What a run stopped recording, and how much it went on to miss.
 *
 * A boolean would be the cheap version and the useless one. A truncated run
 * stops storing rows but keeps counting them, which turns "truncated at
 * 18,000 rows" into "truncated at 18,000 of an eventual 63,412" — the
 * difference between a trace nobody can trust and a trace that states it
 * covered the first 28% of the run (ADR 0049).
 */
export interface TruncationRecord {
  /** One rung, one reason. There is no sampling or coarsening rung to name. */
  reason: "per-run-cap";
  /** Microseconds from run start at which recording stopped. */
  atUs: number;
  /** The cap that was hit, so the number is readable without the build. */
  capBytes: number;
  /** Lifecycle rows stored before the cap. */
  rowsRecorded: number;
  /** Lifecycle rows the run saw afterwards and refused. */
  rowsUnrecorded: number;
  ticksUnrecorded: number;
  eventsUnrecorded: number;
  /** Server rows dropped after truncation — counted, so coverage is not overstated on one side only. */
  serverRowsUnrecorded: number;
}

/**
 * One socket the interval was recorded over.
 *
 * A run is a client-side interval that can outlive a socket, and the
 * correlation label restarts at zero on every new connection (ADR 0048) — so
 * one run can hold two `rid: 0` rows meaning different requests. The
 * generation is what disambiguates them, and this is where a reader learns
 * which generations a run spanned rather than inferring the set by scanning
 * the rows.
 *
 * The browser fills this in because the browser is the side holding the
 * facts: the server never learns that a returning client is the same client,
 * and the rows it had buffered for the dead socket are discarded rather than
 * replayed.
 */
export interface ConnectionRecord {
  /** The browser's per-connection counter. Zero never appears here. */
  generation: number;
  /**
   * Microseconds from interval start at which this connection opened, or
   * null when it was already open when the interval began.
   */
  openedAtUs: number | null;
  /** Where the socket dropped, or null when it was still up at interval close. */
  closedAtUs: number | null;
  /**
   * How long the browser had no socket at all before this connection opened,
   * or null when no outage preceded it. Measured from the actual disconnect,
   * which may predate the interval — the outage is a fact about the page, not
   * about the interval that happens to be reading it.
   */
  gapUs: number | null;
  /** The first and last correlation label minted on this connection inside this interval. */
  firstRid: number | null;
  lastRid: number | null;
}

export interface RunHeader extends RunConditions {
  cacheWarmth: CacheWarmth;
  schemaVersion: number;
  runId: string;
  /**
   * Why the run opened, or null for the unlabelled steady-state interval
   * between runs. Same object, differing only by label (ADR 0047).
   */
  cause: RunCause | null;
  endReason: EndReason;
  /** Null on a run that recorded everything it saw. */
  truncation: TruncationRecord | null;
  build: BuildIdentity;
  gpu: GpuIdentity | null;
  /** Wall-clock epoch milliseconds at run start, so an archived run has a date. */
  startedAtEpochMs: number;
  durationUs: number;
  /** How long `quiescent` had to hold before the run closed. Baked into every duration the run reports. */
  quiescenceHoldMs: number;
  /** How long the run was allowed to stay open before closing as `timeout`. */
  timeoutMs: number;
  outstandingAtSettle: Outstanding;
  /**
   * Every socket this interval spanned, oldest first. Empty before the page
   * has ever connected.
   */
  connections: ConnectionRecord[];
}

/**
 * Phases that sit below the platform's 100 µs clock floor — cache admission,
 * worker dispatch, coalesce attach. Timing them would show quantisation noise
 * wearing the costume of data, so they are counted per tick instead and never
 * appear on a lifecycle row.
 */
export const COUNTED_PHASES = ["cache-admission", "worker-dispatch", "coalesce-attach"] as const;
export type CountedPhase = (typeof COUNTED_PHASES)[number];

export const CountedPhaseIndex = {
  CacheAdmission: 0,
  WorkerDispatch: 1,
  CoalesceAttach: 2,
} as const;
export type CountedPhaseIndexValue = (typeof CountedPhaseIndex)[keyof typeof CountedPhaseIndex];

/**
 * The per-tick aggregate columns. A closed enum for the same reason the phase
 * inventory is closed: every name here widens a fixed-width tick sample.
 *
 * These are the shapes the debug panel used to carry — lane counts, the
 * culling funnel, active-set tallies — now recorded with a timestamp instead
 * of being polled off a flat sink, and recorded whether or not anybody is
 * looking. The panel they came from is gone (ADR 0052); this is where the
 * counts live. Per-level planned / cached / in-flight is variable-length and rides
 * in its own slots rather than here.
 */
export const TICK_COUNTER_NAMES = [
  "laneMinimap",
  "laneDetail",
  "laneCoarse",
  "lanePrefetch",
  "laneOverview",
  "proxyRequests",
  "plannedChunks",
  "cullingConsidered",
  "cullingAfterXyBounds",
  "cullingAfterZRange",
  "cullingAfterFrustum",
  "catalogDegradations",
  "activeSetTotal",
  "activeSetGroupAsProxy",
  "activeSetTilesProxyFallback",
  "activeSetTilesDetail",
] as const;
export type TickCounterName = (typeof TICK_COUNTER_NAMES)[number];

/**
 * Column indices, derived from the names rather than written out beside them.
 * Sixteen hand-numbered constants next to sixteen strings is two lists that
 * must stay in the same order with nothing checking that they do.
 */
function counterIndex(name: TickCounterName): number {
  return TICK_COUNTER_NAMES.indexOf(name);
}

export const TickCounter = {
  LaneMinimap: counterIndex("laneMinimap"),
  LaneDetail: counterIndex("laneDetail"),
  LaneCoarse: counterIndex("laneCoarse"),
  LanePrefetch: counterIndex("lanePrefetch"),
  LaneOverview: counterIndex("laneOverview"),
  ProxyRequests: counterIndex("proxyRequests"),
  PlannedChunks: counterIndex("plannedChunks"),
  CullingConsidered: counterIndex("cullingConsidered"),
  CullingAfterXyBounds: counterIndex("cullingAfterXyBounds"),
  CullingAfterZRange: counterIndex("cullingAfterZRange"),
  CullingAfterFrustum: counterIndex("cullingAfterFrustum"),
  CatalogDegradations: counterIndex("catalogDegradations"),
  ActiveSetTotal: counterIndex("activeSetTotal"),
  ActiveSetGroupAsProxy: counterIndex("activeSetGroupAsProxy"),
  ActiveSetTilesProxyFallback: counterIndex("activeSetTilesProxyFallback"),
  ActiveSetTilesDetail: counterIndex("activeSetTilesDetail"),
} as const;

/**
 * The process-wide readings, sampled once per tick.
 *
 * A counter is what happened over an interval; a reading is what was true at an
 * instant, which is why these are their own tier rather than more
 * {@link TICK_COUNTER_NAMES}. They are the four series a timeline reader asks
 * for first — how deep is the queue, how much is out, how long is a frame
 * taking, how much is resident.
 *
 * **Tick cadence, not planning cadence.** A tick sample is published per
 * planning pass, and planning passes cluster at the start of a run: the
 * planner's epoch cache means a run can fetch for seconds without re-planning
 * once. Readings carried on those samples came out as one cluster in
 * the first few milliseconds — technically a series, useless as one. These
 * ride the tick instead, which is also the only moment they can change.
 *
 * Held as doubles: resident bytes outgrow a uint32 and a frame time is
 * fractional.
 */
export const READING_NAMES = ["queueDepth", "inFlight", "frameTimeUs", "residentBytes"] as const;
export type ReadingName = (typeof READING_NAMES)[number];

/**
 * Column indices, derived from the names rather than written beside them —
 * two lists in the same order with nothing checking that they are.
 */
export const ReadingColumn = {
  QueueDepth: READING_NAMES.indexOf("queueDepth"),
  InFlight: READING_NAMES.indexOf("inFlight"),
  FrameTimeUs: READING_NAMES.indexOf("frameTimeUs"),
  ResidentBytes: READING_NAMES.indexOf("residentBytes"),
} as const;

/** One reading. */
export interface TraceReading extends Record<ReadingName, number> {
  /** Microseconds from run start. */
  atUs: number;
}

/**
 * How many pyramid levels a tick sample carries planned / cached / in-flight
 * counts for. A fixed span keeps the sample fixed-width; deeper levels are
 * counted in `levelsDropped` rather than folded into the last slot, because a
 * fold would silently overstate whichever level it landed on.
 */
export const TICK_LEVEL_SLOTS = 16;

/** Planned / cached / in-flight per level, the three columns of a level slot. */
export const LEVEL_COLUMNS = 3;

/** A phase that carries real timings on a row. Absent when the boundary pair was never stamped. */
export interface PhaseTiming {
  startUs: number;
  endUs: number;
  durationUs: number;
}

/**
 * The identity of one wire request, as both sides know it.
 *
 * `rid` is minted per connection and restarts at zero on the next one, so
 * the generation is not decoration: a run can outlive a socket, and without
 * it one run holds two `rid: 0` rows meaning different requests.
 */
export interface WireLabel {
  rid: number;
  /**
   * Connections count from 1, so **generation 0 means no wire request** —
   * the transport had no socket, the message was dropped before it was
   * sent, and there is nothing on the server to join to. That is what makes
   * {@link UNLABELLED} distinguishable from a genuine `rid: 0`, which every
   * connection's first request legitimately has.
   */
  connectionGeneration: number;
}

/** No wire request was sent for this row — see {@link WireLabel.connectionGeneration}. */
export const UNLABELLED: WireLabel = { rid: 0, connectionGeneration: 0 };

/**
 * Which family a server row describes.
 *
 * `metadata-read` is the one that is not a wire request: it is one object
 * read performed while a dataset was being opened, and it keys on the
 * open's `request_id` rather than on a correlation label. Index order is
 * the wire order of the column and must not be reordered.
 */
export type ServerRowFamily = "chunk" | "asset" | "metadata-read";
export const SERVER_ROW_FAMILIES: readonly ServerRowFamily[] = [
  "chunk",
  "asset",
  "metadata-read",
];

/**
 * What a metadata read's time was. Short, and its own vocabulary rather
 * than a slice of the chunk phases: a metadata read has no dispatch, no
 * decode and no upload.
 *
 * A `coalesced-wait` row waited on another reader's in-flight read and
 * performed no round trip of its own, so counting round trips means
 * counting `backend-read` rows — reading the whole family as trips would
 * report an open making thousands where it made hundreds.
 */
export type MetadataReadPhase = "cache-hit" | "coalesced-wait" | "backend-read";
export const METADATA_READ_PHASES: readonly MetadataReadPhase[] = [
  "cache-hit",
  "coalesced-wait",
  "backend-read",
];

/**
 * The server's phase enum, wider than the browser's because its clock is
 * finer: ADR 0047's 100 µs floor was a browser-platform measurement (#897)
 * and Rust's `Instant` has no such floor, so the rule is clock-relative.
 * Comparing a server phase against a browser phase by resolution is a
 * category error.
 *
 * - `arrival`         frame off the socket → the request is recognised.
 * - `binding-lookup`  resolving the dataset binding, behind the shared
 *                     session mutex every client in the workspace takes.
 * - `dispatch`        binding in hand → the serve task is doing work.
 * - `cache-lookup`    the source cache's LRU probe and single-flight
 *                     election, or the generated cache's lookup.
 * - `permit-wait`     queued behind the source-read cap. Leader rows only.
 * - `backend-read`    the round trip. Leader rows only, so a sum over this
 *                     phase counts each real read exactly once.
 * - `coalesced-wait`  parked on another request's in-flight read of the
 *                     same object. A follower's whole wait lives here, so
 *                     it is diagnosed as waiting on a read in flight rather
 *                     than as a slow backend.
 * - `decompress`      storage codec decode.
 * - `slice-encode`    the (t, c) slice and the wire frame.
 * - `handoff`         onto the outbound queue. Terminal: socket write time
 *                     is excluded, as it happens in a separate task behind
 *                     an unbounded queue.
 */
export const SERVER_PHASES = [
  "arrival",
  "binding-lookup",
  "dispatch",
  "cache-lookup",
  "permit-wait",
  "backend-read",
  "coalesced-wait",
  "decompress",
  "slice-encode",
  "handoff",
] as const;
export type ServerPhase = (typeof SERVER_PHASES)[number];

/**
 * The wire column each phase arrives in. Rust spells these snake_case; the
 * document spells multi-word names kebab-case, the same disagreement the
 * outcome vocabulary already has.
 *
 * A map rather than a second array in the same order: two parallel arrays
 * would let a reordering of either silently swap two columns, with nothing
 * to catch it.
 */
export const SERVER_PHASE_WIRE_KEY: Record<ServerPhase, string> = {
  arrival: "arrival_us",
  "binding-lookup": "binding_lookup_us",
  dispatch: "dispatch_us",
  "cache-lookup": "cache_lookup_us",
  "permit-wait": "permit_wait_us",
  "backend-read": "backend_read_us",
  "coalesced-wait": "coalesced_wait_us",
  decompress: "decompress_us",
  "slice-encode": "slice_encode_us",
  handoff: "handoff_us",
};

/**
 * A phase the request never entered. Durations are microseconds in a
 * uint32 and zero is a legitimate duration, so the sentinel is the top of
 * the range — the same choice {@link UNSET_STAMP} makes for boundaries.
 */
export const PHASE_UNSET = 0xffffffff;

/** How long a row spent in each phase it entered. Absent means unentered. */
export type ServerPhaseDurations = Partial<Record<ServerPhase, number>>;

/**
 * The label column's "this row led its own read" value, mirroring the
 * server's `LABEL_NONE`.
 */
export const LABEL_NONE = 0xffffffff;

/**
 * How the server's work for a label ended. `not-ready` is the one that
 * changes a reading: the server answered honestly and no bytes will follow,
 * so the browser's bracket for that label stays open through no fault of
 * the server.
 */
export type ServerRowOutcome = "delivered" | "not-ready" | "failed";
export const SERVER_ROW_OUTCOMES: readonly ServerRowOutcome[] = [
  "delivered",
  "not-ready",
  "failed",
];

/**
 * Where a server row sits on the browser's clock.
 *
 * The server's own clock is never trusted. The browser stamped the send and
 * the receipt of this label, the server's work is strictly nested inside
 * that bracket, and the placement is derived from those two facts alone — so
 * clock skew cannot produce a wrong picture.
 */
export interface ServerPlacement {
  /** Run-relative microseconds, inside the browser's bracket for this label. */
  startUs: number;
  endUs: number;
  /**
   * The unattributed remainder of the bracket: network plus socket queue.
   * Named rather than absorbed — a confidently-wrong merged timeline is a
   * failure, not a win.
   *
   * The gap is measured; where inside the bracket it falls is not. The span
   * is centred, which splits the gap evenly between the outbound and inbound
   * legs because nothing here measures them apart. Read `gapUs`, not the
   * position, for how much is unaccounted for.
   */
  gapUs: number;
  /**
   * How far the server's own numbers exceeded the browser's bracket, in
   * microseconds. Non-zero means the two clocks disagree; the span is
   * clamped to the bracket, because the bracket is the one measured on a
   * single clock. Reported as a size rather than a flag — a disagreement
   * of 3 µs and one of 3 s are not the same news.
   */
  overshootUs: number;
}

/** Why a server row could not be placed on the browser's timeline. */
export type UnplacedReason =
  /** No browser row carries this label — the request predates the run, or its row was dropped. */
  | "no-browser-row"
  /** The bracket never closed and never will: the server answered without bytes. */
  | "answered-without-delivery"
  /** The bracket is still open for another reason; the row is not evidence of a server stall. */
  | "bracket-open"
  /** A metadata read whose open this run never saw sent — the open predates the run. */
  | "no-open-bracket";

/**
 * The browser's bracket for one dataset open, on the browser's clock: the
 * request went out at `startUs` and the server's answer landed at `endUs`.
 *
 * This is the second bracket the exporter nests into. Without it a cold
 * remote open is several seconds of silence before the first chunk row,
 * because the reads that fill it happen before any chunk exists.
 */
export interface DatasetOpenBracket {
  requestId: string;
  /** Microseconds from run start. */
  startUs: number;
  /** Null while the open has not settled — a run can close over an open one. */
  endUs: number | null;
}

/**
 * The server's half of a request's life, as the browser received it.
 * Durations are the server's; the position is the browser's.
 */
export interface TraceServerRow extends WireLabel {
  family: ServerRowFamily;
  outcome: ServerRowOutcome;
  /**
   * How long the server spent in each phase it entered, from the frame
   * coming off the socket to the handoff. A phase it never entered is
   * absent, not zero. Empty on a `metadata-read` row, which has no slot in
   * this enum and states its span in the two columns below.
   */
  phases: ServerPhaseDurations;
  /**
   * For a single-flight follower, the label of the read it waited on; null
   * for every other row. It is what turns a coalesced wait from "it waited"
   * into "it waited on that read", and the server-side coalescing count is
   * a group-by over it.
   *
   * Labels are per connection, so a leader on another connection joins to
   * nothing here — which is also why this carries no peer identity.
   */
  coalescedOnto: number | null;
  /**
   * The bytes this row's own backend round trips returned, and null when it
   * performed none. It travels with `backend-read` and obeys its rule: a
   * follower carries neither, so a sum over the column is the bytes the
   * backend moved. An inner chunk read out of a shard reports the range it
   * asked for, or every range a merged read carried, plus the shard's index
   * when that read was this row's too, which is how a trace shows a shard
   * read by the inner chunk and never downloaded whole.
   */
  backendBytes: number | null;
  /**
   * On a `metadata-read` row, the open's arrival → the start of that read,
   * which is what lets the reads be laid out across the open instead of
   * stacked at its midpoint. Zero on every other family.
   */
  dispatchOffsetUs: number;
  /** On a `metadata-read` row, the read itself; zero on every other family. */
  durationUs: number;
  /** The open a `metadata-read` row belongs to, and null on every other family. */
  requestId: string | null;
  /** Set on `metadata-read` rows and null elsewhere. */
  metadataPhase: MetadataReadPhase | null;
  placement: ServerPlacement | null;
  unplacedReason: UnplacedReason | null;
}

/** A lifecycle row, fanned out at serialisation. Spans exist only at export. */
export interface TraceRow extends WireLabel {
  datasetId: string;
  entityId: string;
  imageId: string;
  /** An attribute, not a phase. */
  lane: LaneName;
  /**
   * Part of the row's identity. The same chunk key legitimately exists
   * under both tiers, which have separate budgets and separate eviction
   * (ADR 0039, ADR 0041), so the key alone is not unique.
   */
  residencyTier: ResidencyTier;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  /** Canonical `"level/t/c/z/y/x"`, rebuilt from the columns. */
  chunkKey: string;
  outcome: RowOutcomeName;
  phases: Partial<Record<Phase, PhaseTiming>>;
}

/**
 * The four rare things worth a point in time rather than a column: a chunk
 * left the cache, the renderer refused one, a fetch was retried, a fetch gave
 * up. Nobody has caught the last three happening — #899 observed zero retries
 * and zero real failures across 3,781 remote reads — so they share one shape
 * and their diagnostic value is simply that they appear at all.
 */
export const POINT_EVENT_KINDS = ["eviction", "rejection", "retry", "failure"] as const;
export type PointEventKind = (typeof POINT_EVENT_KINDS)[number];

export const PointEvent = {
  Eviction: 0,
  Rejection: 1,
  Retry: 2,
  Failure: 3,
} as const;
export type PointEventIndex = (typeof PointEvent)[keyof typeof PointEvent];

/**
 * Reason codes are borrowed whole from the two taxonomies the pipeline
 * already has — the typed fetch error kinds and the renderer's chunk feedback
 * reasons — so a trace and a log line name the same failure the same way. The
 * `satisfies` clauses below make this a checked borrowing rather than a copy
 * that drifts; the two assignments underneath fail to compile if either
 * taxonomy grows a member this list has not picked up.
 */
const FETCH_ERROR_REASONS = [
  "permanent",
  "transient",
  "pending",
  "abort",
] as const satisfies readonly FetchErrorKind[];

const CHUNK_FEEDBACK_REASONS = [
  "evicted",
  "stale",
  "wrong-slice",
  "missing-pool",
  "missing-entity-meta",
  "missing-lod-meta",
  "radius-filter",
  "atlas-policy",
] as const satisfies readonly ChunkFeedbackReason[];

export const POINT_EVENT_REASONS = [
  ...FETCH_ERROR_REASONS,
  ...CHUNK_FEEDBACK_REASONS,
] as const;
export type PointEventReason = (typeof POINT_EVENT_REASONS)[number];

const _coversFetchErrors: FetchErrorKind extends PointEventReason ? true : never = true;
const _coversChunkFeedback: ChunkFeedbackReason extends PointEventReason ? true : never = true;
void _coversFetchErrors;
void _coversChunkFeedback;

/**
 * The identity a point event copies off whatever it happened to — a planned
 * request or a resident cache entry. `datasetId` is optional because a cache
 * entry is keyed by entity and does not carry one; the remaining fields are a
 * structural subset of both, so an emit site passes the object it already
 * holds and the recorder allocates nothing.
 */
export interface ChunkEventSource {
  datasetId?: string;
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
}

/**
 * Per-level planning and residency counts, fanned out at serialisation.
 *
 * `planned` belongs to the sample's dataset. `cached` and `inFlight` are
 * cache-wide: the CPU cache is one shared budget across the workspace, not
 * one per dataset, so its residency is not a per-dataset quantity and
 * splitting it would invent an attribution the cache does not have.
 */
export interface TraceTickLevel {
  level: number;
  planned: number;
  cached: number;
  inFlight: number;
}

/** One per-tick aggregate sample, for one dataset planned on that tick. */
export interface TraceTick {
  /** Microseconds from run start. */
  atUs: number;
  datasetId: string;
  counters: Record<TickCounterName, number>;
  /**
   * The counted-not-timed phases over the interval since the previous sample.
   * Process-wide, not per dataset: a cache admission belongs to the pipeline,
   * not to whichever dataset's sample happens to publish the interval. Sum
   * across samples for a run total; do not read one sample as a dataset's own.
   */
  counted: Record<CountedPhase, number>;
  /** Only levels with a non-zero column; a level absent here had nothing on it. */
  levels: TraceTickLevel[];
  /** Levels past {@link TICK_LEVEL_SLOTS} that this sample could not carry. */
  levelsDropped: number;
}

/** One point event. Every kind shares this shape. */
export interface TracePointEvent {
  /** Microseconds from run start. */
  atUs: number;
  kind: PointEventKind;
  reason: PointEventReason;
  /** Null when the event is not about one chunk — a proxy asset eviction, say. */
  chunk: {
    datasetId: string;
    entityId: string;
    imageId: string;
    residencyTier: ResidencyTier;
    level: number;
    t: number;
    c: number;
    z: number;
    y: number;
    x: number;
    chunkKey: string;
  } | null;
}

/**
 * The kinds of hole a run can have. A closed enum, because a reader deciding
 * whether to trust a verdict needs to know the list is exhaustive.
 *
 * The first three are wall clock no recorded phase covers. The fourth is the
 * per-run cap. The fifth is an outage of the socket itself. The last four are
 * stream losses: records a ring, the server, or this side dropped, which cost
 * detail without hiding elapsed time.
 */
export const COVERAGE_GAP_KINDS = [
  "nothing-recorded",
  "unrecorded-prefix",
  "unaccounted-interior",
  "unrecorded-suffix",
  "truncated",
  "connection-gap",
  "ticks-dropped",
  "events-dropped",
  "server-rows-dropped",
  "server-rows-discarded",
] as const;
export type CoverageGapKind = (typeof COVERAGE_GAP_KINDS)[number];

export interface CoverageGap {
  kind: CoverageGapKind;
  /** Run-relative microseconds, or null when the gap is a stream loss rather than an interval. */
  startUs: number | null;
  endUs: number | null;
  /** Zero for a stream loss: it cost records, not elapsed time. */
  durationUs: number;
  /**
   * Records the gap swallowed, across every tier it swallowed them from.
   * Zero for an interval gap, which has no record count; the per-tier
   * breakdown for a truncation is on {@link TruncationRecord}.
   */
  records: number;
  /**
   * Whether the run's bottleneck could be inside this gap. A caveat that only
   * a careful reader would derive is a caveat most readers will miss, so the
   * gap carries the judgement rather than leaving it to each surface.
   */
  couldHideBottleneck: boolean;
  /** Why this gap exists, in one sentence. Constant per kind; the numbers live in the fields. */
  statement: string;
}

/**
 * A limit of the instrument itself rather than of this run. Emitted on every
 * run, identically, because they never go away: a reader who knows a run is
 * clean still has to know what a clean run cannot tell them.
 */
export interface CoverageLimit {
  id: string;
  statement: string;
}

/**
 * What the run measured and what it did not. On every run, including clean
 * ones — "no stall found" is only worth anything next to how much of the run
 * was actually instrumented.
 */
export interface TraceCoverage {
  /** The run's whole duration, the denominator for everything else here. */
  wallClockUs: number;
  /** Wall clock covered by at least one recorded phase span, counting overlap once. */
  accountedUs: number;
  /** The remainder. Exact, including gaps too short to be worth listing. */
  unaccountedUs: number;
  /**
   * The holes worth naming, ordered as they occurred and then by stream.
   * Interval gaps below the reporting floor are counted in
   * {@link unaccountedUs} but not listed, because a hundred sub-millisecond
   * entries would bury the one that matters.
   */
  gaps: CoverageGap[];
  /** Run totals for the phases that are counted rather than timed, summed off the tick samples. */
  countedPhases: Record<CountedPhase, number>;
  limits: readonly CoverageLimit[];
}

export interface TraceRun {
  header: RunHeader;
  /** What this run measured and what it did not. Present on clean runs too. */
  coverage: TraceCoverage;
  rows: TraceRow[];
  /**
   * Per-tick aggregates, oldest-first. Unlike the per-chunk tier this is a
   * drop-oldest ring: a steady-state stream has no privileged start, and the
   * ticks worth reading during a stall are the recent ones.
   */
  ticks: TraceTick[];
  /** Tick samples the ring dropped, so a wrapped ring is visible rather than inferred. */
  ticksDropped: number;
  /** Readings, oldest-first, one per tick. Also a drop-oldest ring. */
  readings: TraceReading[];
  /** Readings the ring dropped. */
  readingsDropped: number;
  events: TracePointEvent[];
  /** Point events the ring dropped. */
  eventsDropped: number;
  /**
   * The server's rows for this run's requests, placed against the browser's
   * brackets. The browser owns the merged trace: these arrived over the
   * existing socket and were never fetched from a server-side store, of
   * which there is none.
   */
  serverRows: TraceServerRow[];
  /**
   * The dataset opens this run issued, as the browser bracketed them. The
   * metadata-read rows nest inside these, and an open still in flight at
   * run close carries a null end rather than being dropped — an open that
   * never settled is the most diagnostic one there is.
   */
  datasetOpens: DatasetOpenBracket[];
  /**
   * Opens this run declined to bracket because it was already holding the
   * recorder's per-run limit. Their metadata rows arrive unplaceable, so a
   * silent cap would look like a server that stopped reporting.
   */
  datasetOpensDropped: number;
  /**
   * Server rows the server itself declared it dropped before sending. The
   * coverage story has two sources of loss once the server can be one of
   * them, and reporting only ours would overstate coverage.
   */
  serverRowsDropped: number;
  /**
   * Server rows this side refused: they named a label this interval never
   * minted, or an open it never bracketed, so nothing here could ever place
   * them. Counted rather than stored — an orphan row is not a diagnostic, and
   * keeping it would spend the budget truncation exists to protect.
   */
  serverRowsDiscarded: number;
}

/**
 * The retention policy the document was produced under, and what it cost.
 *
 * Recorded rather than assumed because the caps are derived, not universal:
 * they come from measured volumes at a 384-member collection, and a workload
 * an order of magnitude larger should have them re-derived rather than be
 * quietly truncated against numbers that never fit it (ADR 0049).
 */
export interface RetentionRecord {
  residentCapBytes: number;
  perRunCapBytes: number;
  /** Bytes the recorder holds right now, across every retained interval. */
  residentBytes: number;
  /** Completed intervals discarded oldest-first to stay under the resident cap. */
  intervalsEvicted: number;
  /** The workload the caps were derived from, and the unit they are measured in. */
  derivedFrom: string;
  capUnit: string;
}

export interface TraceDocument {
  schemaVersion: number;
  exportedAtEpochMs: number;
  retention: RetentionRecord;
  /**
   * Which phases this build instruments. A document-level statement, not a
   * per-row guarantee: a row still omits any phase whose boundaries it did
   * not reach, and an omitted phase reads as "not measured on this row"
   * rather than "took no time". A phase absent from this list was never
   * measured anywhere.
   */
  instrumentedPhases: Phase[];
  /**
   * Phases that are counted rather than timed, stated alongside the timed
   * ones so a reader never looks for a duration that was never measurable.
   * Their counts live on the per-tick samples.
   */
  countedPhases: CountedPhase[];
  /** Chronological. Interleave with {@link steadyState} on `startedAtEpochMs`. */
  runs: TraceRun[];
  /**
   * The unlabelled intervals between runs, chronological. Recording is
   * continuous, so steady state is retained under the same cap rather than
   * thrown away — the pan that preceded a stall is often the thing that
   * explains it. Same shape as a run; its header carries a null cause.
   *
   * Kept in its own array rather than mixed into {@link runs} so that a
   * reader looking for a run cannot accidentally analyse an interval that has
   * no cause, no settle and no verdict as though it were one.
   */
  steadyState: TraceRun[];
  /**
   * Rows the recorder saw with no interval to put them in — before the page
   * registered an environment, or after it withdrew one. A run whose
   * conditions cannot be recorded is not a comparable artifact, so these are
   * counted rather than kept.
   */
  rowsOutsideRun: number;
  /**
   * Server rows that arrived with no interval to put them in. Counted, not
   * kept: an unjoinable server row is not a diagnostic, but a silently
   * uncounted one would make the document claim coverage it does not have.
   */
  serverRowsOutsideRun: number;
}
