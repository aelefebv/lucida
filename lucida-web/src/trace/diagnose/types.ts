/**
 * The diagnostic document: what a trace *means*, as opposed to what it
 * recorded.
 *
 * One pure derivation feeds both surfaces — the agent text and the monitor's
 * cards render from this object, so they cannot disagree about which phase
 * stalled or how much of the run was measured. #892 found #893's threshold
 * rules transferred to the visual surface unchanged, which is why this is one
 * module rather than two.
 *
 * Every number a surface prints exists here at a stated path. The converse
 * does not hold: this document is a superset and each renderer selects from
 * it.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type {
  CoverageGap,
  CoverageLimit,
  EndReason,
  GpuIdentity,
  LaneName,
  Phase,
  PointEventKind,
  PointEventReason,
  RowOutcomeName,
  RunCause,
} from "../types.ts";
import type { Ruleset } from "./ruleset.ts";

/**
 * Bumped when the shape changes incompatibly. Independent of the trace
 * schema's version: a trace and its reading are two artifacts and either can
 * move without the other.
 */
export const DIAGNOSTIC_SCHEMA_VERSION = 1;

/**
 * Which family of work a phase belongs to, and therefore which threshold
 * family may judge it.
 *
 * The split is not cosmetic. A pipeline whose p50 network first byte is 98 ms
 * and whose p50 scheduler queue wait is 4,600 ms (#899) has no single number
 * that can serve both: any per-chunk ceiling on a queue either fires on every
 * row or on none. Queue phases therefore get a backlog ETA instead of a
 * ceiling, and `unrecorded` exists so the chain can carry time no instrument
 * claims without anything downstream being able to blame it.
 */
export type PhaseClass = "io" | "compute" | "queue" | "unrecorded";

/** Which side of the boundary a phase was measured on. */
export type PhaseSide = "browser" | "server" | "metadata";

/**
 * One phase's shape across the run.
 *
 * `totalMs` deliberately is not a share of the run. Thousands of rows are in
 * flight at once, so the totals overlap and their sum routinely exceeds the
 * wall clock — reading the largest total as the answer is precisely the
 * mistake the critical-path back-walk exists to avoid.
 */
export interface PhaseRollup {
  /** `browser.wire`, `server.permit-wait`, `metadata.backend-read`. */
  id: string;
  label: string;
  side: PhaseSide;
  class: PhaseClass;
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  /** `totalMs` over the run's wall clock: how many of this phase ran at once, on average. */
  concurrencyFactor: number;
  /**
   * The stretch of the run's clock this phase occupied, and how many of its
   * rows carried a position at all.
   *
   * Null when none did. A phase can be measured and unplaceable — a server row
   * the merge could not nest has a duration and no position (ADR 0050) — and a
   * timeline track drawn at the origin for one of those is the same class of
   * lie as drawing silence over a cold open's metadata reads.
   *
   * This is what a timeline track is drawn from. `p95` cannot place anything,
   * and the monitor is not allowed to reach past this document for a number.
   */
  extent: { firstStartMs: number; lastEndMs: number; positionedN: number } | null;
  /**
   * The row behind {@link maxMs}, named. A drill-down carries a phase scope and
   * the worst row rather than a time coordinate, so the identity has to exist
   * here: a chunk key on the browser side, the `(rid, connection generation)`
   * join key on the server side (ADR 0048), and the open plus label on a
   * metadata read.
   */
  worst: { label: string; ms: number } | null;
}

/**
 * A limiter and what it did to the run.
 *
 * `cap` is inferred from the trace rather than declared by it: a client sees
 * its own rows and no aggregate (ADR 0050), so the highest concurrency the
 * run ever reached is the only ceiling observable from inside. Stated as
 * `capSource` so nobody reads an inference as a configured value.
 */
export interface LimiterSummary {
  id: string;
  cap: number;
  capSource: "observed-max";
  unit: string;
  /** Share of readings at the cap. A limiter pinned while work waits is what names a queue's cause. */
  pinnedPct: number;
  /** Work waiting behind the limiter at the run's last reading. */
  pending: number;
  /** Admissions completed per second over the trailing window. */
  drainPerS: number;
  /** How long the standing backlog needs at that rate, or null when nothing drained. */
  backlogEtaS: number | null;
  /** The trailing window the drain rate was measured over. */
  windowMs: number;
  /** Completed admissions counted inside that window. */
  windowCompletions: number;
}

/**
 * A phase recorded only as per-tick aggregates, so it has no per-item rows and
 * can never appear on a row-built critical path. It still holds the main
 * thread, so it is offered as a candidate with a confidence ceiling that says
 * exactly that.
 */
export interface AggregateCandidate {
  phase: string;
  /** A lower bound: each reading is charged only for the interval it covers. */
  busyMs: number;
  sharePct: number;
  p95Ms: number;
  samples: number;
}

/** One link in the back-walk. */
export interface PathSegment {
  label: string;
  class: PhaseClass;
  ms: number;
  sharePct: number;
  /** Where the segment's number came from: which table, and how many rows of it. */
  source: string;
  rows: number;
  /** The chunk the terminal row named, when the segment is one row's phase. */
  chunkKey?: string;
  /** A sub-breakdown in milliseconds — server phases inside a wire bracket, read phases inside an open. */
  breakdown?: Record<string, number>;
}

export interface CriticalPath {
  kind: "chain" | "undefined";
  /** What the walk started from, or what it would have started from had the run reached it. */
  target: string;
  /** Run-relative milliseconds of the target, null when the run never reached one. */
  targetAtMs: number | null;
  /** Why no chain could be built. Null on a chain. */
  undefinedReason: string | null;
  segments: PathSegment[];
  /**
   * The chain's share of the target. A chain that starts at run start tiles
   * the whole interval, so this is 100 by construction — which is why it is
   * *not* the coverage number. Read {@link DiagnosticCoverage.accountedPct}
   * for how much of the run was instrumented.
   */
  chainAccountedPct: number;
}

/**
 * How much the derivation is willing to claim, in one word.
 *
 * Seven words, each with an explicit degradation. A confidence that carries no
 * statement of what it cannot see is a confidence a reader will over-trust, so
 * `degraded` is required on all seven — including the strongest, which still
 * cannot see queue time it never stamped.
 */
export type Confidence =
  /** A chain was walked, it accounts for most of the run, and one segment leads it. */
  | "attributed"
  /** A chain was walked but it is led by unrecorded time, or it explains too little of the run. */
  | "partial"
  /** No single winner: two segments are within a factor, or a queue leads with no limiter behind it. */
  | "contended"
  /** A limiter is pinned at its cap with a backlog that will not drain. */
  | "resource-limited"
  /** The leader has no per-item rows, so it can be shown to overlap the run but not to be on its path. */
  | "aggregate-only"
  /** No chain; ranked by percentile, which is evidence of slowness but not of position. */
  | "rollup-only"
  /** Nothing crossed a threshold and no chain could be walked. */
  | "unattributed";

export interface Attribution {
  confidence: Confidence;
  /** The named cause, a set when two tie, or null when nothing can be named. */
  cause: string | string[] | null;
  why: string;
  /** What this confidence still cannot see. Never empty, on any of the seven. */
  degraded: string;
  /** The chain leader, when something else outranked it. */
  runnerUp: { label: string; ms: number } | null;
}

export type FindingSeverity = "stall" | "saturated" | "note";

/** What a rule observed. Every field is optional because the three families measure different things. */
export interface FindingObservation {
  stat?: "p50" | "p95" | "max";
  ms?: number;
  sharePct?: number;
  /**
   * What `sharePct` is a share *of*. A path segment's share is of the chain,
   * which ends at the run's completion; an aggregate's is of the wall clock.
   * On a run whose chain ends before the run does these are different
   * denominators, and printing both as "% of the run" would be wrong for one
   * of them.
   */
  shareOf?: "chain" | "run";
  n?: number;
  rows?: number;
  pending?: number;
  drainPerS?: number;
  backlogEtaS?: number;
  inFlightCap?: number;
  pinnedPct?: number;
  ratio?: number;
  baselineMs?: number;
  tier?: string;
  breakdown?: Record<string, number>;
}

export interface Finding {
  id: number;
  severity: FindingSeverity;
  /** The rule that fired, by id, so a reader can look up the rationale in the shipped ruleset. */
  rule: string;
  /** What the rule fired on: a phase id, a limiter id, or a path segment's label. */
  subject: string;
  observed: FindingObservation;
  threshold: { kind: string; value: number; why: string };
  /** The lead finding carries the run's attribution; the rest are `observed`. */
  confidence: Confidence | "observed";
  attribution: Attribution | null;
}

/**
 * A coverage gap in the diagnostic's own units.
 *
 * The trace states gaps in microseconds; everything here is milliseconds, so a
 * renderer never has to convert. That is a parity rule, not a style
 * preference: a number a surface computes for itself is a number that exists
 * in no document and cannot be looked up.
 */
export interface DiagnosticGap {
  kind: CoverageGap["kind"];
  startMs: number | null;
  endMs: number | null;
  durationMs: number;
  records: number;
  couldHideBottleneck: boolean;
  statement: string;
}

export interface DiagnosticCoverage {
  wallMs: number;
  accountedMs: number;
  /**
   * Floored, never rounded. 99.6% printing as 100% in the honesty block is the
   * exact failure #893 hit: it reported `100% accounted` for a run that was
   * 87% pre-instrument boot.
   */
  accountedPct: number;
  /** The holes, carried through from the trace rather than re-derived. */
  gaps: DiagnosticGap[];
  /**
   * How many there are. A field rather than a length a surface takes for
   * itself: every number a surface prints has to exist here, and a rendering
   * that lists three of nine gaps still has to be able to say nine.
   */
  gapCount: number;
  /** True when any gap could hide the bottleneck; the verdict wears this as a caveat. */
  incomplete: boolean;
  /** What the run stopped recording, and how much it went on to miss. Leads the render when set. */
  truncated: {
    reason: string;
    atMs: number;
    rowsRecorded: number;
    rowsUnrecorded: number;
    /** What the run would have recorded, so "18,000 rows" reads as "18,000 of 63,412". */
    rowsTotal: number;
    recordedPct: number;
  } | null;
  /** Limits of the instrument, not of this run. Identical on every run, including clean ones. */
  limits: readonly CoverageLimit[];
  /** Counted-not-timed phase totals, so nobody looks for a duration that was never measurable. */
  countedPhases: Record<string, number>;
  /**
   * Counters that read as health and are not. #899 recorded zero retries, zero
   * failures and zero evictions while the pipeline ran 20,000 requests behind.
   */
  notHealthSignals: { metric: string; value: number }[];
}

export interface RunIdentity {
  datasetIds: string[];
  cause: RunCause | null;
  endReason: EndReason;
  wallMs: number;
  devicePixelRatio: number;
  viewport: string;
  build: string;
  /**
   * The adapter in one phrase: its vendor, architecture, and device, with the
   * description when the browser gave one. "unknown" when the run closed
   * before the page had identified an adapter.
   */
  gpu: string;
  /**
   * The adapter as the header recorded it, including whether it is a software
   * fallback and whether it offers timestamp queries. Null when the run closed
   * before the page had identified one. Carried whole so a surface can name
   * the description or warn about a fallback without reaching past the
   * document.
   */
  adapter: GpuIdentity | null;
  /**
   * Which kind of adapter the run rendered on, with the phrase every surface
   * prints for it. Both states are named, so a hardware adapter reads as
   * hardware rather than as the absence of a warning, and a header that
   * never recorded the kind reads as not recorded rather than as either.
   */
  adapterKind: { kind: AdapterKind; label: string };
  /** What the browser already held when the run opened, in one phrase. */
  warmth: string;
  /** What was still outstanding when the run closed. */
  outstanding: { pending: number; inFlight: number; speculative: number };
  startedAtEpochMs: number;
}

export interface Verdict {
  kind: "clear" | "stall" | "saturated" | "unsettled";
  text: string;
  confidence: Confidence;
}

/**
 * Which kind of adapter a run rendered on. Four words rather than a boolean
 * because two of the states are about the header rather than the adapter: a
 * run can close before an adapter is identified, and a run recorded before
 * the fallback flag existed never recorded it.
 */
export type AdapterKind = "hardware" | "software-fallback" | "not-identified" | "not-recorded";

/** The shape of one per-tick timing across the run, in milliseconds. */
export interface TimingSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Why a run carries no GPU pass time. A closed set, because a surface that
 * draws the GPU track has to draw its absence too and needs to know which
 * absence it is drawing.
 */
export type GpuPassAbsenceReason =
  /** The adapter offers no timestamp queries, so nothing could be measured on the device. */
  | "no-timestamp-queries"
  /** The adapter offers them, but no frame's read-back landed before the run closed. */
  | "no-frame-read-back"
  /** The run closed before the page had identified an adapter at all. */
  | "adapter-unknown"
  /** The header predates the field that says whether the adapter offers timestamp queries. */
  | "not-recorded";

/**
 * The GPU pass time across the run, or the stated reason there is none.
 * One value with two shapes rather than a summary beside a nullable reason,
 * so no document can carry a missing figure with no reason or a figure with
 * one.
 */
export type GpuPassTiming =
  | ({ recorded: true } & TimingSummary)
  | { recorded: false; reason: GpuPassAbsenceReason; statement: string };

/**
 * Where the run's render time went, on two clocks that must never be
 * confused. `mainThread` is the tick's own main-thread time, from the
 * readings. `gpuPass` is the GPU's pass time for a frame, read back through
 * timestamp queries and present only on the readings that received one.
 *
 * An unrecorded `gpuPass` states its reason rather than implying one. It
 * means unmeasured, never fast, and every surface that prints `mainThread`
 * has to call it main-thread time so that one number is not mistaken for the
 * other.
 */
export interface RenderTiming {
  /** Null when no reading carried a frame time above the clock floor. */
  mainThread: TimingSummary | null;
  gpuPass: GpuPassTiming;
}

export interface NextStep {
  why: string;
  command: string;
}

/**
 * Where a lifecycle row stood when the run closed: the phase it was sitting
 * in, or how it ended. `unstamped` is a row that reached no boundary at all,
 * which the recorder never makes but the table can hold.
 */
export type RowState = Phase | "complete" | "retired" | "unstamped";

/** One phase of one row, in the diagnostic's units. */
export interface RowPhaseReading {
  phase: Phase;
  startMs: number;
  endMs: number;
  durationMs: number;
}

/**
 * Where a row stood in the queue, derived from the other rows rather than
 * recorded: the scheduler keeps no per-key rank behind its admission window,
 * so the trace carries none. Both counts are over recorded rows only. A row is
 * born at dispatch, so a chunk that never dispatched has no row and is not
 * counted, which makes every rank here a floor.
 */
export interface QueueRank {
  /** Rows admitted before this one and still waiting when it was admitted. */
  aheadAtAdmission: number;
  /** Rows admitted at the same instant or later, and dispatched before it. */
  overtaken: number;
  /** Admission to dispatch, or to run close when the row never dispatched. */
  waitedMs: number;
  dispatched: boolean;
}

/**
 * One lifecycle row as the chunk lookup reads it: its identity, its phase
 * history, where it stood in the queue, and how long it has been alive.
 */
export interface ChunkRowReading {
  /** Position in the lookup's list, 1-based, so a line can name a row. */
  id: number;
  datasetId: string;
  entityId: string;
  imageId: string;
  lane: LaneName;
  residencyTier: ResidencyTier;
  rid: number;
  connectionGeneration: number;
  outcome: RowOutcomeName;
  state: RowState;
  /** Run-relative milliseconds of the row's first boundary; null when it reached none. */
  firstSeenMs: number | null;
  /**
   * First boundary to last boundary for a row that ended, or to run close for
   * one still in flight. Null when the row reached no boundary.
   */
  ageMs: number | null;
  /** In phase order. A phase absent here was never entered on this row. */
  phases: RowPhaseReading[];
  /** Null when the row never entered the queue. */
  queue: QueueRank | null;
}

/** One point event about the looked-up chunk. */
export interface ChunkEventReading {
  atMs: number;
  kind: PointEventKind;
  reason: PointEventReason;
  entityId: string;
  residencyTier: ResidencyTier;
}

/**
 * One chunk, looked up by row identity: the answer to "why is this chunk not
 * resident" in text. The one place the document is per-row, and by
 * construction about a handful of rows: {@link rows} and {@link events} are
 * capped, so the document never grows with the run.
 */
export interface ChunkLookup {
  /** As given or chosen: `[entity/]level/t/c/z/y/x`. Null when nothing could be chosen. */
  selector: string | null;
  /** How the chunk was chosen, in one phrase: named by the caller, or the worst row. */
  chosen: string;
  /** Null when the selector did not parse as a chunk. */
  chunkKey: string | null;
  /** The entity the selector named, or null for a bare key. */
  entityId: string | null;
  /** Oldest first, capped. {@link rowCount} says how many matched in all. */
  rows: ChunkRowReading[];
  rowCount: number;
  /** Distinct entities among the matched rows: a bare key matches one row per tile in a collection. */
  entityCount: number;
  events: ChunkEventReading[];
  eventCount: number;
  /** What the lookup found, in one sentence. */
  statement: string;
  /** What the lookup cannot see. Never empty. */
  limits: string;
}

/** An inclusive bounding box over chunk indices, `[t, c, z, y, x]`. */
export interface SpatialBox {
  min: [number, number, number, number, number];
  max: [number, number, number, number, number];
}

/** The rows of one dataset at one level in one tier that stood in one state. */
export interface SpatialGroup {
  /** Position in the summary's list, 1-based. */
  id: number;
  datasetId: string;
  residencyTier: ResidencyTier;
  level: number;
  state: RowState;
  n: number;
  /** Distinct entities in the group. */
  entityCount: number;
  box: SpatialBox;
  /** The longest any row in the group has been alive. */
  oldestMs: number;
}

/**
 * What is where: the run's rows grouped by state and level, each group with
 * its bounding box. The text twin of the overlay, so an agent can read it
 * without a screenshot. Bounded by the number of states times levels rather
 * than by the row count.
 */
export interface SpatialSummary {
  /** Rows the summary counted. */
  rowCount: number;
  /** Rows still in flight first, then complete, then retired; by level within a state. */
  groups: SpatialGroup[];
  groupCount: number;
  levelCount: number;
  /** The coordinate system every box is in. */
  coordinates: string;
  /** What the summary cannot show, one statement each. Never empty. */
  cannotShow: string[];
}

export interface DiagnosticDocument {
  schemaVersion: number;
  runId: string;
  /** The trace this was derived from, so a diagnostic never floats free of its input. */
  traceSchemaVersion: number;
  verdict: Verdict;
  run: RunIdentity;
  coverage: DiagnosticCoverage;
  /**
   * The run's one attribution, hoisted out of the lead finding. A run has a
   * single answer to "what was this waiting on"; a surface should not have to
   * find it by indexing into a list that may be empty.
   */
  attribution: Attribution;
  findings: Finding[];
  criticalPath: CriticalPath;
  phases: PhaseRollup[];
  limiters: LimiterSummary[];
  aggregates: AggregateCandidate[];
  /** Main-thread time and GPU pass time, or the stated reason the second is missing. */
  renderTiming: RenderTiming;
  counts: {
    rows: number;
    serverRows: number;
    metadataRows: number;
    ticks: number;
    pointEvents: number;
  };
  /**
   * One chunk's phase history, queue rank and age. The caller's chunk when
   * one was named, otherwise the worst row's, so the default text can point
   * at it.
   */
  chunk: ChunkLookup;
  /** Rows by state and level, each with a bounding box. */
  spatial: SpatialSummary;
  /** Raw spans are never inlined at any depth: a warm re-open is 21,431 rows. */
  raw: { inlined: false; why: string; command: string };
  next: NextStep[];
  /** The ruleset that produced this document, versioned and with every rationale. */
  ruleset: Ruleset;
}
