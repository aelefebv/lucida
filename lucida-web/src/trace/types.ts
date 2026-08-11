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
 * Only `wire` is instrumented today (#924); the remaining phases keep their
 * slots reserved so filling them in (#925) does not re-shape the row.
 * {@link TraceDocument.instrumentedPhases} states which ones actually carry
 * timings, so a reader never mistakes a reserved slot for a measured zero.
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
 * The identity fields a lifecycle row copies off a planned request. A
 * structural subset of `ChunkRequest`, so emit sites pass the object they
 * already hold and the recorder allocates nothing.
 */
export interface ChunkRowSource {
  datasetId: string;
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

export const TickCounter = {
  LaneMinimap: 0,
  LaneDetail: 1,
  LaneCoarse: 2,
  LanePrefetch: 3,
  LaneOverview: 4,
  ProxyRequests: 5,
  PlannedChunks: 6,
  CullingConsidered: 7,
  CullingAfterXyBounds: 8,
  CullingAfterZRange: 9,
  CullingAfterFrustum: 10,
  CatalogDegradations: 11,
  ActiveSetTotal: 12,
  ActiveSetGroupAsProxy: 13,
  ActiveSetTilesProxyFallback: 14,
  ActiveSetTilesDetail: 15,
} as const;
export type TickCounterIndex = (typeof TickCounter)[keyof typeof TickCounter];

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

/** A lifecycle row, fanned out at serialisation. Spans exist only at export. */
export interface TraceRow {
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
  /** The counted-not-timed phases, over the interval since the previous tick. */
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
}

export interface TraceDocument {
  schemaVersion: number;
  exportedAtEpochMs: number;
  /**
   * Which phases carry timings in this document. The row model reserves a
   * slot for every phase in {@link PHASES}; this states which of them were
   * actually measured, so an absent phase reads as "not instrumented"
   * rather than "took no time".
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
}
