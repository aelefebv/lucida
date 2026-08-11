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
   * Which phases carry timings in this document. The row model reserves a
   * slot for every phase in {@link PHASES}; this states which of them were
   * actually measured, so an absent phase reads as "not instrumented"
   * rather than "took no time".
   */
  instrumentedPhases: Phase[];
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
