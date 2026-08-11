/**
 * Trace model types — the vocabulary of ADR 0047 and ADR 0051, and the
 * shape of the document the trace seam returns.
 *
 * `CONTEXT.md` is the glossary: a *trace* is the artifact, a *phase* is a
 * stage delimited by a handoff, a *run* is a labelled interval within the
 * continuous recording, a *lifecycle row* is the per-chunk unit of record,
 * and *end reason* is why a run closed.
 */

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

/** A phase that carries real timings on a row. Absent when the boundary pair was never stamped. */
export interface PhaseTiming {
  startUs: number;
  endUs: number;
  durationUs: number;
}

/**
 * Stages that happen too fast to time and are counted instead.
 *
 * The platform's clock floor is 100 µs. Cache admission, worker dispatch and
 * coalesce attach all land below it, so timing them would show quantisation
 * noise wearing the costume of data. A count is the honest measurement: it
 * says how often the stage happened without claiming to know how long it
 * took.
 *
 * Zero here is not a health signal, and a reader must not take it as one.
 */
export interface CountedEvents {
  /** Fetched bytes admitted into a CPU-cache store. */
  cacheAdmission: number;
  /** Decodes handed to a pool worker. */
  workerDispatch: number;
  /** Second and later demands that attached to an in-flight or already-queued fetch. */
  coalesceAttach: number;
}

export function emptyCountedEvents(): CountedEvents {
  return { cacheAdmission: 0, workerDispatch: 0, coalesceAttach: 0 };
}

/** A lifecycle row, fanned out at serialisation. Spans exist only at export. */
export interface TraceRow {
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

export interface TraceRun {
  header: RunHeader;
  rows: TraceRow[];
  /** The stages below the clock floor. Counted, never timed. */
  counted: CountedEvents;
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
  runs: TraceRun[];
  /**
   * Rows the recorder saw while no run was open. Counted, not kept: the
   * unlabelled steady-state interval and its retention are #927.
   */
  rowsOutsideRun: number;
}
