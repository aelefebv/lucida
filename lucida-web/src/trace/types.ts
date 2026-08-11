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
 * Row identity carries the residency tier because `chunkKey` alone is not
 * unique: the same key legitimately exists twice under the two tiers, which
 * have separate budgets and separate eviction (ADR 0039, ADR 0041).
 */
export type ResidencyTierName = "detail" | "coarse";
export const RESIDENCY_TIER_NAMES: readonly ResidencyTierName[] = ["detail", "coarse"];

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

/** Why a run closed. Required on every run — a run that never settled is still a run. */
export type EndReason = "quiescent" | "timeout" | "explicit";

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

export interface RunHeader extends RunConditions {
  cacheWarmth: CacheWarmth;
  schemaVersion: number;
  runId: string;
  cause: RunCause;
  endReason: EndReason;
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
 * These are the shapes the debug panel carries today — lane counts, the
 * culling funnel, active-set tallies — recorded with a timestamp instead of
 * being polled off a flat sink, and recorded whether or not anybody is
 * looking. Per-level planned / cached / in-flight is variable-length and rides
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

/** Which labelled request family a server row describes. */
export type ServerRowFamily = "chunk" | "asset";
export const SERVER_ROW_FAMILIES: readonly ServerRowFamily[] = ["chunk", "asset"];

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
  | "bracket-open";

/**
 * The server's half of a request's life, as the browser received it.
 * Durations are the server's; the position is the browser's.
 */
export interface TraceServerRow extends WireLabel {
  family: ServerRowFamily;
  outcome: ServerRowOutcome;
  /** Server-side arrival → start of serve. */
  dispatchOffsetUs: number;
  /** Start of serve → handoff to the outbound queue. */
  durationUs: number;
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
  residencyTier: ResidencyTierName;
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
    residencyTier: ResidencyTierName;
    level: number;
    t: number;
    c: number;
    z: number;
    y: number;
    x: number;
    chunkKey: string;
  } | null;
}

export interface TraceRun {
  header: RunHeader;
  rows: TraceRow[];
  /**
   * Per-tick aggregates, oldest-first. Unlike the per-chunk tier this is a
   * drop-oldest ring: a steady-state stream has no privileged start, and the
   * ticks worth reading during a stall are the recent ones.
   */
  ticks: TraceTick[];
  /** Tick samples the ring dropped, so a wrapped ring is visible rather than inferred. */
  ticksDropped: number;
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
   * Server rows the server itself declared it dropped before sending. The
   * coverage story has two sources of loss once the server can be one of
   * them, and reporting only ours would overstate coverage.
   */
  serverRowsDropped: number;
}

export interface TraceDocument {
  schemaVersion: number;
  exportedAtEpochMs: number;
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
  runs: TraceRun[];
  /**
   * Rows the recorder saw while no run was open. Counted, not kept: the
   * unlabelled steady-state interval and its retention are #927.
   */
  rowsOutsideRun: number;
  /**
   * Server rows that arrived while no run was open. Counted, not kept: an
   * unjoinable server row is not a diagnostic, but a silently uncounted one
   * would make the document claim coverage it does not have.
   */
  serverRowsOutsideRun: number;
}
